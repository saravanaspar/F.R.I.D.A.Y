import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DoctorCheck, DoctorLevel, DoctorRepairId, DoctorSection } from "./contract.js";

export interface DoctorRuntimeSettings {
  readonly modelProvider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly routingProvider?: string | undefined;
  readonly routingModelId?: string | undefined;
  readonly permissionMode: "ask" | "auto" | "full";
  readonly hostPrivilegeMode?: "broker" | "none" | undefined;
  readonly timezone: string;
  readonly workspaceRoot?: string | undefined;
  readonly selfRepository?: string | undefined;
}

export interface DoctorChannelSnapshot {
  readonly enabled: readonly string[];
  readonly allowAll: readonly string[];
  readonly whatsappEnabled: boolean;
}

export interface DoctorModelCredentialSnapshot {
  readonly apiKeyRef: string;
  readonly oauthRef: string;
  readonly hasApiKey: boolean;
  readonly hasOAuth: boolean;
  readonly typicallyNeedsApiKey: boolean;
}

export interface DoctorVoiceSnapshot {
  readonly configured: boolean;
  readonly detail?: string | undefined;
  readonly missingCredentials: readonly string[];
}

export interface DoctorSandboxSnapshot {
  readonly available: boolean;
  readonly displayName: string;
  readonly detail?: string | undefined;
  readonly status?: string | undefined;
  readonly imageMissing?: boolean | undefined;
  readonly repairHint?: string | undefined;
}

export interface DoctorHostPrivilegeSnapshot {
  readonly privilegeMode: "broker" | "none";
  readonly privilegedHelperInstalled: boolean;
  readonly ready: boolean;
}

export interface DoctorSources {
  runtimeSettings(home: string): Promise<DoctorRuntimeSettings | undefined>;
  channels(home: string): Promise<DoctorChannelSnapshot>;
  modelCredential(provider: string, vaultRefs: ReadonlySet<string>): Promise<DoctorModelCredentialSnapshot>;
  voice(home: string, vaultRefs: ReadonlySet<string>): Promise<DoctorVoiceSnapshot>;
  hostPrivileges(home: string): Promise<DoctorHostPrivilegeSnapshot>;
  sandbox(): Promise<DoctorSandboxSnapshot>;
}

function getFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

function getFridayWorkspace(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_WORKSPACE?.trim();
  return resolve(configured || join(dirname(getFridayHome(environment)), "FRIDAY-workspace"));
}
function check(
  id: string,
  section: DoctorSection,
  level: DoctorLevel,
  label: string,
  message: string,
  options: { detail?: string; fix?: string; repair?: DoctorRepairId } = {},
): DoctorCheck {
  return Object.freeze({ id, section, level, label, message, ...options });
}

function command(commandName: string, args: readonly string[] = ["--version"]): { ok: boolean; output?: string } {
  const result = spawnSync(commandName, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  const firstLine = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/u)[0]?.trim();
  return { ok: result.error === undefined && result.status === 0, ...(firstLine ? { output: firstLine } : {}) };
}

function executionPythonPath(environment: NodeJS.ProcessEnv = process.env): string {
  const root = join(getFridayHome(environment), "tooling", "execution-python", "venv");
  return process.platform === "win32"
    ? join(root, "Scripts", "python.exe")
    : join(root, "bin", "python");
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function workspaceCheck(environment: NodeJS.ProcessEnv, home: string, settings: DoctorRuntimeSettings | undefined): Promise<DoctorCheck> {
  const workspace = resolve(settings?.workspaceRoot ?? getFridayWorkspace({ ...environment, FRIDAY_HOME: home }));
  if (inside(home, workspace) || inside(workspace, home)) {
    return check("workspace", "Security", "error", "Workspace", "overlaps FRIDAY state", {
      detail: `${workspace} · state=${home}`,
      fix: `Set FRIDAY_WORKSPACE to a dedicated directory outside ${JSON.stringify(home)}, then rerun: friday setup`,
    });
  }
  try {
    const info = await lstat(workspace);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return check("workspace", "Security", "error", "Workspace", "not a real directory", { detail: workspace, fix: "friday setup" });
    }
    const [canonicalWorkspace, canonicalHome] = await Promise.all([realpath(workspace), realpath(home)]);
    if (inside(canonicalHome, canonicalWorkspace) || inside(canonicalWorkspace, canonicalHome)) {
      return check("workspace", "Security", "error", "Workspace", "resolves into FRIDAY state", {
        detail: `${canonicalWorkspace} · state=${canonicalHome}`,
        fix: "Choose a dedicated workspace outside FRIDAY_HOME, then rerun: friday setup",
      });
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      return check("workspace", "Security", "error", "Workspace", "permissions are too broad", {
        detail: `${canonicalWorkspace} · mode=${(info.mode & 0o777).toString(8)}`,
        fix: `chmod 700 ${JSON.stringify(canonicalWorkspace)}`,
      });
    }
    return check("workspace", "Security", "ok", "Workspace", "isolated from state", { detail: canonicalWorkspace });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return check("workspace", "Security", "error", "Workspace", "directory is missing", { detail: workspace, fix: "friday setup" });
    }
    return check("workspace", "Security", "error", "Workspace", "could not be inspected", { detail: String(error), fix: "friday setup" });
  }
}

function sandboxNetworkCheck(environment: NodeJS.ProcessEnv): DoctorCheck {
  const mode = environment.FRIDAY_SANDBOX_NETWORK_MODE?.trim() || "requested";
  if (mode === "requested") {
    return check(
      "sandbox-network",
      "Security",
      "ok",
      "Sandbox network",
      "approval-gated",
      { detail: "Network is off unless a tool explicitly requests it and permission is approved." },
    );
  }
  if (mode === "unrestricted") {
    return check(
      "sandbox-network",
      "Security",
      "warn",
      "Sandbox network",
      "unrestricted by host override",
      { fix: "Remove FRIDAY_SANDBOX_NETWORK_MODE=unrestricted; the secure default is requested." },
    );
  }
  return check(
    "sandbox-network",
    "Security",
    "error",
    "Sandbox network",
    `invalid mode: ${mode}`,
    { fix: "Set FRIDAY_SANDBOX_NETWORK_MODE=requested or remove the variable." },
  );
}

async function homeCheck(home: string): Promise<DoctorCheck> {
  try {
    const info = await lstat(home);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return check("home", "Installation", "error", "State home", "not a real directory", {
        detail: home,
        fix: `Move FRIDAY_HOME to a private real directory, then run: friday setup`,
      });
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      return check("home", "Installation", "error", "State home", "permissions are too broad", {
        detail: `${home} · mode ${(info.mode & 0o777).toString(8)}`,
        fix: `chmod 700 ${JSON.stringify(home)}`,
        repair: "home-permissions",
      });
    }
    return check("home", "Installation", "ok", "State home", "private", { detail: home });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return check("home", "Installation", "error", "State home", "not initialized", {
        detail: home,
        fix: "friday setup",
        repair: "setup",
      });
    }
    return check("home", "Installation", "error", "State home", "could not be inspected", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "Check FRIDAY_HOME ownership/path, then rerun: friday doctor",
    });
  }
}

function platformCheck(environment: NodeJS.ProcessEnv): DoctorCheck {
  const binary = environment.FRIDAY_SINGLE_BINARY === "1";
  if (process.platform === "win32") {
    return check("platform", "Installation", "error", "Platform", "native Windows is not a hardened target", {
      detail: `${process.platform}/${process.arch} · Node ${process.version}`,
      fix: "Run F.R.I.D.A.Y inside WSL2 using scripts/install-release.ps1.",
    });
  }
  return check("platform", "Installation", "ok", "Platform", `${process.platform}/${process.arch}`, {
    detail: `Node ${process.version} · ${binary ? "single binary" : "source/dev runtime"}`,
  });
}

function permissionCheck(settings: DoctorRuntimeSettings | undefined): DoctorCheck {
  if (!settings) {
    return check("permission-mode", "Security", "info", "Permission mode", "not configured yet", {
      fix: "friday setup",
    });
  }
  if (settings.permissionMode === "full") {
    return check("permission-mode", "Security", "warn", "Permission mode", "full", {
      detail: "Workspace mutations may proceed without per-action approval; network still requires explicit authorization.",
      fix: "friday setup --permission ask",
    });
  }
  return check("permission-mode", "Security", "ok", "Permission mode", settings.permissionMode, {
    detail: settings.permissionMode === "ask" ? "Sensitive workspace actions require approval." : "Approved automatic policy is active.",
  });
}

async function channelChecks(snapshot: DoctorChannelSnapshot): Promise<readonly DoctorCheck[]> {
  const enabled = [...snapshot.enabled];
  const checks: DoctorCheck[] = [];
  checks.push(enabled.length > 0
    ? check("channels", "Configuration", "ok", "Ingress channels", `${enabled.length} enabled`, { detail: enabled.join(", ") })
    : check("channels", "Configuration", "error", "Ingress channels", "none enabled", {
        fix: "friday setup",
        repair: "setup",
      }));

  const open = [...snapshot.allowAll];
  checks.push(open.length === 0
    ? check("channel-access", "Security", "ok", "Channel access", enabled.length === 0 ? "not applicable yet" : "restricted", {
        detail: enabled.length === 0 ? "Configure ingress first." : "No enabled channel accepts every sender.",
      })
    : check("channel-access", "Security", "warn", "Channel access", `${open.length} channel(s) allow all senders`, {
        detail: open.join(", "),
        fix: "friday setup  # restrict allowed senders/conversations for public-facing channels",
      }));
  return Object.freeze(checks);
}

interface DoctorVaultMetadata {
  readonly stateDir: string;
  readonly refs: ReadonlySet<string>;
}

async function doctorVaultMetadata(home: string): Promise<DoctorVaultMetadata> {
  const stateDir = join(resolve(home), "vault");
  try {
    const directory = await lstat(stateDir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`Vault state directory is unsafe: ${stateDir}`);
    if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) throw new Error(`Vault state directory permissions are too broad: ${stateDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ stateDir, refs: new Set<string>() });
    throw error;
  }

  const statePath = join(stateDir, "vault.json");
  let raw: string;
  try {
    const info = await lstat(statePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Vault state file is unsafe: ${statePath}`);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`Vault state file permissions are too broad: ${statePath}`);
    if (info.size > 32 * 1024 * 1024) throw new Error("Vault state file exceeds the Doctor inspection limit");
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ stateDir, refs: new Set<string>() });
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Vault state root is invalid");
  const root = parsed as Record<string, unknown>;
  if (root.schema !== 1 || typeof root.records !== "object" || root.records === null || Array.isArray(root.records)) throw new Error("Vault state schema is invalid");
  const refs = new Set<string>();
  for (const value of Object.values(root.records as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Vault record metadata is invalid");
    const ref = (value as Record<string, unknown>).ref;
    if (typeof ref !== "string" || !/^vault:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(ref)) throw new Error("Vault record reference is invalid");
    refs.add(ref);
  }
  return Object.freeze({ stateDir, refs });
}

function configuredModelEnvKeys(provider: string, environment: NodeJS.ProcessEnv): readonly string[] {
  const candidates: Readonly<Record<string, readonly string[]>> = Object.freeze({
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    "github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    google: ["GEMINI_API_KEY"],
    "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
    groq: ["GROQ_API_KEY"],
    cerebras: ["CEREBRAS_API_KEY"],
    xai: ["XAI_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
    zai: ["ZAI_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    "minimax-cn": ["MINIMAX_CN_API_KEY"],
    moonshotai: ["MOONSHOT_API_KEY"],
    "moonshotai-cn": ["MOONSHOT_API_KEY"],
    huggingface: ["HF_TOKEN"],
    fireworks: ["FIREWORKS_API_KEY"],
    opencode: ["OPENCODE_API_KEY"],
    "opencode-go": ["OPENCODE_API_KEY"],
    "kimi-coding": ["KIMI_API_KEY"],
    "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
    "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
    xiaomi: ["XIAOMI_API_KEY"],
    "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
    "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  });
  return Object.freeze([...(candidates[provider] ?? [])].filter((name) => Boolean(environment[name])));
}

async function vaultCheck(
  environment: NodeJS.ProcessEnv,
  home: string,
  settings: DoctorRuntimeSettings | undefined,
  vault: DoctorVaultMetadata | undefined,
  vaultError: unknown,
): Promise<DoctorCheck> {
  try {
    if (!vault) throw vaultError instanceof Error ? vaultError : new Error("Vault metadata is unavailable");
    const workspaceRoot = getFridayWorkspace({
      ...environment,
      FRIDAY_HOME: home,
      ...(settings?.workspaceRoot ? { FRIDAY_WORKSPACE: settings.workspaceRoot } : {}),
    });
    if (inside(vault.stateDir, workspaceRoot) || inside(workspaceRoot, vault.stateDir)) {
      throw new Error(`Vault state overlaps the model workspace: vault=${vault.stateDir}; workspace=${workspaceRoot}`);
    }
    if (vault.refs.size === 0) {
      return check("vault", "Security", "info", "Vault", "healthy and empty", { detail: "Secret values are never read by doctor." });
    }
    const masterKey = join(vault.stateDir, "master.key");
    const keyInfo = await lstat(masterKey);
    if (keyInfo.isSymbolicLink() || !keyInfo.isFile() || (process.platform !== "win32" && (keyInfo.mode & 0o077) !== 0)) {
      return check("vault", "Security", "error", "Vault", "master key boundary is unsafe", {
        detail: masterKey,
        fix: "Restore the Vault key from a trusted recovery kit before using stored credentials.",
      });
    }
    return check("vault", "Security", "ok", "Vault", `${vault.refs.size} secret record(s) healthy`, {
      detail: "Metadata checked; plaintext secret values were not read.",
    });
  } catch (error) {
    return check("vault", "Security", "error", "Vault", "state could not be validated", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "Do not delete Vault files; use `friday vault recovery ...` or restore from a known-good backup.",
    });
  }
}

async function modelCredentialCheck(
  environment: NodeJS.ProcessEnv,
  settings: DoctorRuntimeSettings | undefined,
  vaultRefs: ReadonlySet<string> | undefined,
  sources: DoctorSources,
): Promise<DoctorCheck> {
  if (!settings) return check("model-credential", "Configuration", "info", "Model credential", "not applicable yet");
  if (!vaultRefs) {
    return check("model-credential", "Configuration", "error", "Model credential", "could not be validated", {
      detail: "Vault metadata is unavailable or invalid.",
      fix: "Repair or restore Vault state before validating stored model credentials.",
    });
  }
  const provider = settings.modelProvider ?? settings.routingProvider;
  if (!provider) return check("model-credential", "Configuration", "error", "Model credential", "model provider is missing", { fix: "friday setup" });
  const role = settings.modelProvider ? "main" : "routing";
  try {
    const credential = await sources.modelCredential(provider, vaultRefs);
    if (credential.hasApiKey) {
      return check("model-credential", "Configuration", "ok", "Model credential", `${role} API-key credential stored in Vault`, { detail: credential.apiKeyRef });
    }
    if (credential.hasOAuth) {
      return check("model-credential", "Configuration", "ok", "Model credential", `${role} OAuth credential stored in Vault`, { detail: credential.oauthRef });
    }
    const envKeys = configuredModelEnvKeys(provider, environment);
    if (envKeys.length) {
      return check("model-credential", "Configuration", "warn", "Model credential", "environment-managed only", {
        detail: envKeys.join(", "),
        fix: "Run `friday setup` and save the provider credential into Vault for unattended/systemd restarts.",
      });
    }
    if (credential.typicallyNeedsApiKey) {
      return check("model-credential", "Configuration", "error", "Model credential", "missing", {
        detail: credential.apiKeyRef,
        fix: "friday setup",
        repair: "setup",
      });
    }
    return check("model-credential", "Configuration", "info", "Model credential", "no Vault API key", {
      detail: "The selected provider may use OAuth, local, or platform-native authentication.",
    });
  } catch (error) {
    return check("model-credential", "Configuration", "error", "Model credential", "could not be validated", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "friday setup",
    });
  }
}

async function voiceCheck(home: string, vaultRefs: ReadonlySet<string> | undefined, sources: DoctorSources): Promise<DoctorCheck> {
  if (!vaultRefs) {
    return check("voice", "Configuration", "error", "Voice", "could not be validated", {
      detail: "Vault metadata is unavailable or invalid.",
      fix: "Repair or restore Vault state before validating Voice credentials.",
    });
  }
  try {
    const voice = await sources.voice(home, vaultRefs);
    if (!voice.configured) return check("voice", "Configuration", "info", "Voice", "not configured", { detail: "Optional capability." });
    if (voice.missingCredentials.length > 0) {
      return check("voice", "Configuration", "error", "Voice", "credential is missing", {
        detail: voice.missingCredentials.join(", "),
        fix: "friday setup voice",
      });
    }
    return check("voice", "Configuration", "ok", "Voice", "configured", {
      ...(voice.detail ? { detail: voice.detail } : {}),
    });
  } catch (error) {
    return check("voice", "Configuration", "error", "Voice", "configuration is invalid", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "friday setup voice",
    });
  }
}

async function whatsappToolingCheck(environment: NodeJS.ProcessEnv, home: string, channels: DoctorChannelSnapshot): Promise<DoctorCheck> {
  try {
    if (!channels.whatsappEnabled) return check("whatsapp-tooling", "Tooling", "info", "WhatsApp bridge", "not enabled");
    const root = join(home, "tooling", "whatsapp");
    const manifestFiles = ["bridge.mjs", "package.json", "package-lock.json"] as const;
    const required = [...manifestFiles.map((name) => join(root, name)), join(root, "node_modules", "@whiskeysockets", "baileys", "package.json")];
    if (!required.every((path) => existsSync(path))) {
      return check("whatsapp-tooling", "Tooling", "error", "WhatsApp bridge", "not provisioned", { detail: root, fix: "friday setup whatsapp" });
    }
    const bundled = environment.FRIDAY_BUNDLED_ROOT?.trim();
    const source = bundled ? join(bundled, "channels", "whatsapp") : resolve("plugins", "channels", "runtime", "bridge", "whatsapp");
    if (manifestFiles.every((name) => existsSync(join(source, name)))) {
      const stale = await Promise.all(manifestFiles.map(async (name) => {
        const [installed, current] = await Promise.all([readFile(join(root, name)), readFile(join(source, name))]);
        return !installed.equals(current);
      }));
      if (stale.some(Boolean)) {
        return check("whatsapp-tooling", "Tooling", "error", "WhatsApp bridge", "tooling is stale for this FRIDAY build", { detail: root, fix: "friday setup whatsapp" });
      }
    }
    const node = command("node", ["--version"]);
    if (!node.ok) return check("whatsapp-tooling", "Tooling", "error", "WhatsApp bridge", "host Node.js is unavailable", { fix: "Install Node.js, then run: friday setup whatsapp" });
    return check("whatsapp-tooling", "Tooling", "ok", "WhatsApp bridge", "ready", { detail: `${root} · ${node.output ?? "node"}` });
  } catch (error) {
    return check("whatsapp-tooling", "Tooling", "error", "WhatsApp bridge", "could not be validated", { detail: String(error), fix: "friday setup whatsapp" });
  }
}

async function sourceRepositoryCheck(path: string | undefined): Promise<DoctorCheck> {
  if (!path) {
    return check("self-repository", "Configuration", "info", "Self-improvement source", "not configured", {
      detail: "Optional unless you want F.R.I.D.A.Y to modify/upgrade itself.",
      fix: "friday setup self-repository /path/to/F.R.I.D.A.Y",
    });
  }
  const repository = resolve(path);
  if (!existsSync(join(repository, "package.json")) || !existsSync(join(repository, ".git")) || !existsSync(join(repository, "plugins", "self-improvement"))) {
    return check("self-repository", "Configuration", "error", "Self-improvement source", "not a F.R.I.D.A.Y checkout", {
      detail: repository,
      fix: "friday setup self-repository /path/to/a/clean/F.R.I.D.A.Y-checkout",
    });
  }
  const status = command("git", ["-C", repository, "status", "--porcelain"]);
  if (!status.ok) {
    return check("self-repository", "Configuration", "warn", "Self-improvement source", "Git status failed", {
      detail: repository,
      fix: `Check Git access to ${JSON.stringify(repository)}, then rerun: friday doctor`,
    });
  }
  if (status.output) {
    return check("self-repository", "Configuration", "warn", "Self-improvement source", "working tree is dirty", {
      detail: repository,
      fix: `Commit or stash changes in ${JSON.stringify(repository)} before autonomous self-improvement.`,
    });
  }
  const branch = command("git", ["-C", repository, "branch", "--show-current"]);
  return check("self-repository", "Configuration", "ok", "Self-improvement source", "clean", {
    detail: `${repository}${branch.output ? ` · ${branch.output}` : ""}`,
  });
}

async function nodeToolchainCheck(path: string | undefined): Promise<DoctorCheck> {
  if (!path) return check("node-toolchain", "Tooling", "info", "Source Node", "not required until self-improvement/source work is enabled");
  const pinPath = join(resolve(path), ".node-version");
  let expected: string | undefined;
  try {
    expected = (await readFile(pinPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return check("node-toolchain", "Tooling", "warn", "Source Node", "version pin could not be read", {
        detail: error instanceof Error ? error.message : String(error),
        fix: `Check ${JSON.stringify(pinPath)}, then rerun: friday doctor`,
      });
    }
  }
  const hostNode = command("node", ["--version"]);
  if (!hostNode.ok) {
    return check("node-toolchain", "Tooling", "error", "Source Node", "host Node.js is unavailable", {
      fix: expected ? `Install/switch host Node.js to ${expected}.` : "Install Node.js 22 and npm.",
    });
  }
  const actual = hostNode.output?.replace(/^v/u, "");
  if (expected && actual !== expected) {
    return check("node-toolchain", "Tooling", "warn", "Source Node", `${actual ?? "unknown"} does not match pin ${expected}`, {
      detail: "The bundled runtime is unaffected; source/self-improvement builds use the host toolchain.",
      fix: `Switch the host Node.js used by npm to ${expected}, then rerun: friday doctor`,
    });
  }
  return check("node-toolchain", "Tooling", "ok", "Source Node", actual ?? "available", {
    ...(expected ? { detail: `Matches ${basename(pinPath)}.` } : {}),
  });
}

interface DoctorBackupSummary {
  readonly createdAt: string;
  readonly encrypted: boolean;
}

function stateBackupRoot(environment: NodeJS.ProcessEnv): string {
  const configured = environment.FRIDAY_BACKUP_DIR?.trim();
  if (configured) return resolve(configured);
  const home = getFridayHome(environment);
  const name = basename(home).replace(/^\.+/u, "") || "friday";
  return join(dirname(home), `.${name}-backups`);
}

async function doctorBackups(root: string): Promise<{ readonly backups: readonly DoctorBackupSummary[]; readonly invalid: number }> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { backups: Object.freeze([]), invalid: 0 };
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Backup root is not a real directory: ${root}`);
  if (process.platform !== "win32" && (rootInfo.mode & 0o077) !== 0) {
    throw new Error(`Backup root permissions are too broad: ${root}`);
  }

  const backups: DoctorBackupSummary[] = [];
  let invalid = 0;
  for (const child of (await readdir(root, { withFileTypes: true })).slice(0, 1_000)) {
    if (!child.isDirectory() || child.name.startsWith(".")) continue;
    const directory = join(root, child.name);
    const manifestPath = join(directory, "manifest.json");
    try {
      const directoryInfo = await lstat(directory);
      const manifestInfo = await lstat(manifestPath);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
        throw new Error("unsafe backup path");
      }
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid backup manifest");
      const record = parsed as Record<string, unknown>;
      if (record.complete !== true || record.id !== child.name || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
        throw new Error("incomplete backup manifest");
      }
      if (record.encryption !== undefined && (!record.encryption || typeof record.encryption !== "object" || Array.isArray(record.encryption))) {
        throw new Error("invalid backup encryption metadata");
      }
      backups.push(Object.freeze({ createdAt: new Date(record.createdAt).toISOString(), encrypted: record.encryption !== undefined }));
    } catch {
      invalid += 1;
    }
  }
  backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { backups: Object.freeze(backups), invalid };
}

async function backupCheck(environment: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const root = stateBackupRoot(environment);
  try {
    const { backups, invalid } = await doctorBackups(root);
    if (backups.length === 0) {
      return invalid > 0
        ? check("backups", "Recovery", "warn", "State backups", `no valid backups; ${invalid} incomplete/corrupt entr${invalid === 1 ? "y" : "ies"}`, {
            detail: root,
            fix: "friday backup create --encrypt",
          })
        : check("backups", "Recovery", "warn", "State backups", "none found", {
            detail: root,
            fix: "friday backup create --encrypt",
          });
    }
    const latest = backups[0]!;
    if (!latest.encrypted) {
      return check("backups", "Recovery", "warn", "State backups", `${backups.length} found; latest is not encrypted`, {
        detail: `${latest.createdAt} · ${root}${invalid > 0 ? ` · ${invalid} invalid ignored` : ""}`,
        fix: "friday backup create --encrypt",
      });
    }
    return check("backups", "Recovery", invalid > 0 ? "warn" : "ok", "State backups", `${backups.length} found; latest is encrypted`, {
      detail: `${latest.createdAt} · ${root}${invalid > 0 ? ` · ${invalid} invalid ignored` : ""}`,
      ...(invalid > 0 ? { fix: `Inspect/remove incomplete backup directories under ${JSON.stringify(root)} after preserving any needed files.` } : {}),
    });
  } catch (error) {
    return check("backups", "Recovery", "warn", "State backups", "could not be inspected", {
      detail: error instanceof Error ? error.message : String(error),
      fix: `Check ${JSON.stringify(root)}, then run: friday backup create --encrypt`,
    });
  }
}

async function latestCrash(home: string): Promise<DoctorCheck> {
  const path = join(home, "logs", "crashes.ndjson");
  try {
    const text = await readFile(path, "utf8");
    const line = text.trim().split(/\r?\n/u).at(-1);
    if (!line) return check("crashes", "Recovery", "ok", "Fatal crashes", "none recorded");
    const record = JSON.parse(line) as Record<string, unknown>;
    const at = typeof record.at === "string" ? record.at : "unknown time";
    const operation = typeof record.operation === "string" ? record.operation : "unknown operation";
    return check("crashes", "Recovery", "warn", "Fatal crashes", `latest: ${operation}`, {
      detail: at,
      fix: `Inspect the recent crash records in ${JSON.stringify(path)} before deleting or rotating them.`,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return check("crashes", "Recovery", "ok", "Fatal crashes", "none recorded");
    return check("crashes", "Recovery", "warn", "Fatal crashes", "log could not be read", {
      detail: error instanceof Error ? error.message : String(error),
      fix: `Check permissions/integrity of ${JSON.stringify(path)}.`,
    });
  }
}

async function diskCheck(home: string): Promise<DoctorCheck> {
  try {
    const stats = await statfs(home);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const gib = free / (1024 ** 3);
    if (gib < 1) {
      return check("disk", "Recovery", "error", "Free disk", `${gib.toFixed(1)} GiB`, {
        detail: home,
        fix: `Free at least 1 GiB on the filesystem containing ${JSON.stringify(home)}.`,
      });
    }
    if (gib < 5) {
      return check("disk", "Recovery", "warn", "Free disk", `${gib.toFixed(1)} GiB`, {
        detail: home,
        fix: `Free additional disk space on the filesystem containing ${JSON.stringify(home)}.`,
      });
    }
    return check("disk", "Recovery", "ok", "Free disk", `${gib.toFixed(1)} GiB`, { detail: home });
  } catch (error) {
    return check("disk", "Recovery", "warn", "Free disk", "could not be measured", {
      detail: error instanceof Error ? error.message : String(error),
      fix: `Check that ${JSON.stringify(home)} exists and is accessible.`,
    });
  }
}

function toolChecks(): readonly DoctorCheck[] {
  const git = command("git");
  const npm = command(process.platform === "win32" ? "npm.cmd" : "npm");
  const uv = command("uv");
  const py311 = process.platform === "win32"
    ? command("py", ["-3.11", "-c", "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"])
    : command("python3.11", ["-c", "import sys; print(sys.version.split()[0]); raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"]);

  return Object.freeze([
    git.ok
      ? check("git", "Tooling", "ok", "Git", git.output ?? "available")
      : check("git", "Tooling", "warn", "Git", "unavailable", { fix: "Install Git; self-improvement and source workflows require it." }),
    npm.ok
      ? check("npm", "Tooling", "ok", "npm", npm.output ?? "available")
      : check("npm", "Tooling", "warn", "npm", "unavailable", { fix: "Install Node.js/npm before source, self-improvement, or WhatsApp bridge setup." }),
    uv.ok || py311.ok
      ? check("python-bootstrap", "Tooling", "ok", "Python bootstrap", uv.ok ? (uv.output ?? "uv available") : `Python ${py311.output ?? "3.11"}`)
      : check("python-bootstrap", "Tooling", "info", "Python bootstrap", "uv/Python 3.11 not found", {
          detail: "Optional unless you use the execution Python kernel.",
          fix: "Install uv or Python 3.11, then run: friday setup execution-python",
        }),
  ]);
}

function executionPythonCheck(environment: NodeJS.ProcessEnv): DoctorCheck {
  const python = executionPythonPath(environment);
  if (!existsSync(python)) {
    return check("execution-python", "Tooling", "info", "Execution Python", "not provisioned", {
      detail: "Optional capability.",
      fix: "friday setup execution-python",
      repair: "execution-python",
    });
  }
  const health = command(python, [
    "-c",
    "import importlib.metadata as m, sys, zmq; assert sys.version_info[:2] == (3, 11); assert m.version('ipykernel') == '6.30.1'; assert m.version('dill') == '0.4.0'; print(sys.version.split()[0])",
  ]);
  if (!health.ok) {
    return check("execution-python", "Tooling", "warn", "Execution Python", "environment is incomplete or unhealthy", {
      detail: python,
      fix: "friday setup execution-python",
      repair: "execution-python",
    });
  }
  return check("execution-python", "Tooling", "ok", "Execution Python", `Python ${health.output ?? "3.11"}`, { detail: python });
}

async function hostPrivilegeCheck(home: string, sources: DoctorSources): Promise<DoctorCheck> {
  try {
    const status = await sources.hostPrivileges(home);
    if (status.privilegeMode === "none") {
      return check("host-privileges", "Security", "ok", "Host privileges", "disabled by local policy", {
        detail: "FRIDAY will not invoke sudo; root-required maintenance must be performed manually on the host.",
      });
    }
    if (status.ready && status.privilegedHelperInstalled) {
      return check("host-privileges", "Security", "ok", "Host privileges", "restricted broker ready", {
        detail: "Root-owned helper and sudoers metadata passed integrity checks; no arbitrary root shell is exposed.",
      });
    }
    return check("host-privileges", "Security", "error", "Host privileges", "restricted broker is missing or unsafe", {
      detail: "Broker mode is configured, but the root-owned helper/sudoers integrity checks did not pass.",
      fix: "Run `friday setup privileges broker` locally on the FRIDAY host and complete the OS sudo prompt.",
    });
  } catch (error) {
    return check("host-privileges", "Security", "error", "Host privileges", "could not be validated", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "Run `friday setup privileges` locally on the FRIDAY host.",
    });
  }
}

async function sandboxCheck(sources: DoctorSources): Promise<DoctorCheck> {
  try {
    const status = await sources.sandbox();
    if (status.available) {
      return check("sandbox", "Tooling", "ok", "Coding sandbox", `${status.displayName} ready`, {
        ...(status.detail ? { detail: status.detail } : {}),
      });
    }
    return check("sandbox", "Tooling", status.status === "unsupported-platform" ? "warn" : "info", "Coding sandbox", "not ready", {
      ...(status.detail ? { detail: status.detail } : {}),
      fix: status.repairHint ?? "friday setup sandbox",
      ...(status.imageMissing ? { repair: "sandbox" as const } : {}),
    });
  } catch (error) {
    return check("sandbox", "Tooling", "warn", "Coding sandbox", "provider configuration is invalid", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "Set FRIDAY_SANDBOX_PROVIDER to a registered provider, then rerun: friday doctor",
    });
  }
}

export async function collectDoctorChecks(
  environment: NodeJS.ProcessEnv = process.env,
  sources: DoctorSources,
): Promise<readonly DoctorCheck[]> {
  const home = getFridayHome(environment);
  const checks: DoctorCheck[] = [platformCheck(environment), await homeCheck(home)];

  let settings: DoctorRuntimeSettings | undefined;
  try {
    settings = await sources.runtimeSettings(home);
    checks.push(settings
      ? check("runtime-settings", "Configuration", "ok", "Runtime settings", settings.modelProvider && settings.modelId ? `${settings.modelProvider}/${settings.modelId}` : "router-only", {
          detail: `${settings.timezone} · permission=${settings.permissionMode} · host-privilege=${settings.hostPrivilegeMode ?? "none"}${settings.routingModelId ? ` · router=${settings.routingProvider}/${settings.routingModelId}` : ""}`,
        })
      : check("runtime-settings", "Configuration", "error", "Runtime settings", "not configured", {
          fix: "friday setup",
          repair: "setup",
        }));
  } catch (error) {
    checks.push(check("runtime-settings", "Configuration", "error", "Runtime settings", "invalid", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "Back up runtime.env, correct its permissions/content, then rerun: friday setup",
    }));
  }

  let channels: DoctorChannelSnapshot = Object.freeze({ enabled: Object.freeze([]), allowAll: Object.freeze([]), whatsappEnabled: false });
  try {
    channels = await sources.channels(home);
    checks.push(...await channelChecks(channels));
  } catch (error) {
    checks.push(check("channels", "Configuration", "error", "Ingress channels", "configuration is invalid", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "Back up the channel config, correct its permissions/content, then rerun: friday setup",
    }));
    checks.push(check("channel-access", "Security", "info", "Channel access", "could not be assessed", { fix: "friday setup" }));
  }

  let vault: DoctorVaultMetadata | undefined;
  let vaultError: unknown;
  try {
    vault = await doctorVaultMetadata(home);
  } catch (error) {
    vaultError = error;
  }
  const vaultRefs = vault?.refs;

  checks.push(await workspaceCheck(environment, home, settings));
  checks.push(await modelCredentialCheck(environment, settings, vaultRefs, sources));
  checks.push(await voiceCheck(home, vaultRefs, sources));
  checks.push(await sourceRepositoryCheck(settings?.selfRepository ?? environment.FRIDAY_SELF_REPOSITORY));
  checks.push(permissionCheck(settings));
  checks.push(await hostPrivilegeCheck(home, sources));
  checks.push(await vaultCheck(environment, home, settings, vault, vaultError));
  checks.push(sandboxNetworkCheck(environment));
  checks.push(...toolChecks());
  checks.push(await nodeToolchainCheck(settings?.selfRepository ?? environment.FRIDAY_SELF_REPOSITORY));
  checks.push(executionPythonCheck(environment));
  checks.push(await whatsappToolingCheck(environment, home, channels));
  checks.push(await sandboxCheck(sources));
  checks.push(await backupCheck(environment));
  checks.push(await latestCrash(home));
  checks.push(await diskCheck(home));
  return Object.freeze(checks);
}
