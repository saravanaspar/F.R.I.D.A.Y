import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, readFile, realpath, statfs } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { VaultStore, VAULT_MASTER_KEY_FILE_NAME, getVaultStateDir } from "@friday/vault";
import { readSavedChannels } from "../plugins/channels/config.js";
import { readRuntimeSettings, getFridayHome, getFridayWorkspace, type RuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { DEFAULT_SANDBOX_IMAGE, probePodman } from "../plugins/sandbox/podman.js";
import { getStateBackupRoot, listStateBackups } from "./state-backup.js";
import { runSetupCli } from "./setup-cli.js";
import { FRIDAY_VERSION } from "./version.js";
import { modelCredentialVaultRef, modelProviderTypicallyNeedsApiKey } from "../plugins/auth/model-credential-ref.js";
import { readVoiceSettings } from "../plugins/voice/settings.js";
import { voiceCredentialVaultRef } from "../plugins/voice/credential-ref.js";

export type DoctorLevel = "ok" | "info" | "warn" | "error";
export type DoctorSection = "Installation" | "Configuration" | "Security" | "Tooling" | "Recovery";
type DoctorRepairId = "setup" | "home-permissions" | "execution-python" | "sandbox";

export interface DoctorCheck {
  readonly id: string;
  readonly section: DoctorSection;
  readonly level: DoctorLevel;
  readonly label: string;
  readonly message: string;
  readonly detail?: string | undefined;
  /** One-line human repair instruction. Safe to expose in JSON and logs. */
  readonly fix?: string | undefined;
  /** Internal repair action used only by explicit `friday doctor --fix`. */
  readonly repair?: DoctorRepairId | undefined;
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

async function workspaceCheck(environment: NodeJS.ProcessEnv, home: string, settings: RuntimeSettings | undefined): Promise<DoctorCheck> {
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

function permissionCheck(settings: RuntimeSettings | undefined): DoctorCheck {
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

async function channelChecks(home: string): Promise<readonly DoctorCheck[]> {
  try {
    const saved = await readSavedChannels(home);
    const enabledEntries = Object.entries(saved.channels).filter(([, value]) => value?.enabled);
    const enabled = enabledEntries.map(([id]) => id);
    const checks: DoctorCheck[] = [];
    checks.push(enabled.length > 0
      ? check("channels", "Configuration", "ok", "Ingress channels", `${enabled.length} enabled`, { detail: enabled.join(", ") })
      : check("channels", "Configuration", "error", "Ingress channels", "none enabled", {
          fix: "friday setup",
          repair: "setup",
        }));

    const open = enabledEntries.filter(([, value]) => value?.allowAll === true).map(([id]) => id);
    checks.push(open.length === 0
      ? check("channel-access", "Security", "ok", "Channel access", enabled.length === 0 ? "not applicable yet" : "restricted", {
          detail: enabled.length === 0 ? "Configure ingress first." : "No enabled channel accepts every sender.",
        })
      : check("channel-access", "Security", "warn", "Channel access", `${open.length} channel(s) allow all senders`, {
          detail: open.join(", "),
          fix: "friday setup  # restrict allowed senders/conversations for public-facing channels",
        }));
    return Object.freeze(checks);
  } catch (error) {
    return Object.freeze([
      check("channels", "Configuration", "error", "Ingress channels", "configuration is invalid", {
        detail: error instanceof Error ? error.message : String(error),
        fix: "Back up the channel config, correct its permissions/content, then rerun: friday setup",
      }),
    ]);
  }
}

async function vaultCheck(environment: NodeJS.ProcessEnv, home: string, settings: RuntimeSettings | undefined): Promise<DoctorCheck> {
  const stateDir = getVaultStateDir({ ...environment, FRIDAY_HOME: home });
  try {
    const workspaceRoot = getFridayWorkspace({
      ...environment,
      FRIDAY_HOME: home,
      ...(settings?.workspaceRoot ? { FRIDAY_WORKSPACE: settings.workspaceRoot } : {}),
    });
    const vault = new VaultStore({ stateDir, workspaceRoot });
    const records = vault.list();
    if (records.length === 0) {
      return check("vault", "Security", "info", "Vault", "healthy and empty", {
        detail: "Secret values are never read by doctor.",
      });
    }
    const masterKey = join(stateDir, VAULT_MASTER_KEY_FILE_NAME);
    const keyInfo = await lstat(masterKey);
    if (keyInfo.isSymbolicLink() || !keyInfo.isFile() || (process.platform !== "win32" && (keyInfo.mode & 0o077) !== 0)) {
      return check("vault", "Security", "error", "Vault", "master key boundary is unsafe", {
        detail: masterKey,
        fix: "Restore the Vault key from a trusted recovery kit before using stored credentials.",
      });
    }
    return check("vault", "Security", "ok", "Vault", `${records.length} secret record(s) healthy`, {
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
  home: string,
  settings: RuntimeSettings | undefined,
): Promise<DoctorCheck> {
  if (!settings) return check("model-credential", "Configuration", "info", "Model credential", "not applicable yet");
  try {
    const vault = new VaultStore({
      stateDir: getVaultStateDir({ ...environment, FRIDAY_HOME: home }),
      workspaceRoot: getFridayWorkspace({ ...environment, FRIDAY_HOME: home, FRIDAY_WORKSPACE: settings.workspaceRoot }),
    });
    const ref = modelCredentialVaultRef(settings.modelProvider);
    if (vault.exists(ref)) {
      return check("model-credential", "Configuration", "ok", "Model credential", "stored in Vault", { detail: ref });
    }
    const model = await import("@friday/model");
    const envKeys = model.findEnvKeys(settings.modelProvider);
    if (envKeys?.length) {
      return check("model-credential", "Configuration", "warn", "Model credential", "environment-managed only", {
        detail: envKeys.join(", "),
        fix: "Run `friday setup` and save the provider credential into Vault for unattended/systemd restarts.",
      });
    }
    if (modelProviderTypicallyNeedsApiKey(settings.modelProvider)) {
      return check("model-credential", "Configuration", "error", "Model credential", "missing", {
        detail: ref,
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

async function voiceCheck(environment: NodeJS.ProcessEnv, home: string, settings: RuntimeSettings | undefined): Promise<DoctorCheck> {
  try {
    const voice = await readVoiceSettings(home);
    if (!voice?.stt && !voice?.tts) return check("voice", "Configuration", "info", "Voice", "not configured", { detail: "Optional capability." });
    const vault = new VaultStore({
      stateDir: getVaultStateDir({ ...environment, FRIDAY_HOME: home }),
      workspaceRoot: getFridayWorkspace({ ...environment, FRIDAY_HOME: home, FRIDAY_WORKSPACE: settings?.workspaceRoot }),
    });
    const providers = [...new Set([voice.stt?.provider, voice.tts?.provider].filter((value): value is "openai" | "deepgram" | "elevenlabs" => Boolean(value)))];
    const missing = providers.filter((provider) => {
      const ref = provider === "openai" ? modelCredentialVaultRef("openai") : voiceCredentialVaultRef(provider);
      return !vault.exists(ref);
    });
    if (missing.length > 0) {
      return check("voice", "Configuration", "error", "Voice", "credential is missing", {
        detail: missing.join(", "),
        fix: "friday setup voice",
      });
    }
    return check("voice", "Configuration", "ok", "Voice", "configured", {
      detail: [voice.stt ? `STT=${voice.stt.provider}/${voice.stt.model}` : undefined, voice.tts ? `TTS=${voice.tts.provider}/${voice.tts.model}` : undefined].filter(Boolean).join(" · "),
    });
  } catch (error) {
    return check("voice", "Configuration", "error", "Voice", "configuration is invalid", {
      detail: error instanceof Error ? error.message : String(error),
      fix: "friday setup voice",
    });
  }
}

async function whatsappToolingCheck(environment: NodeJS.ProcessEnv, home: string): Promise<DoctorCheck> {
  try {
    const saved = await readSavedChannels(home);
    if (!saved.channels.whatsapp?.enabled) return check("whatsapp-tooling", "Tooling", "info", "WhatsApp bridge", "not enabled");
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

async function backupCheck(environment: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const root = getStateBackupRoot(environment);
  try {
    const backups = await listStateBackups({ environment, backupRoot: root });
    if (backups.length === 0) {
      return check("backups", "Recovery", "warn", "State backups", "none found", {
        detail: root,
        fix: "friday backup create --encrypt",
      });
    }
    const latest = backups[0]!;
    if (!latest.encryption) {
      return check("backups", "Recovery", "warn", "State backups", `${backups.length} found; latest is not encrypted`, {
        detail: `${latest.createdAt} · ${root}`,
        fix: "friday backup create --encrypt",
      });
    }
    return check("backups", "Recovery", "ok", "State backups", `${backups.length} found; latest is encrypted`, {
      detail: `${latest.createdAt} · ${root}`,
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

function sandboxCheck(): DoctorCheck {
  const image = process.env.FRIDAY_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
  const podman = probePodman(image);
  if (podman.available) return check("sandbox", "Tooling", "ok", "Coding sandbox", "rootless Podman ready", { detail: image });
  const detail = podman.reason ?? podman.status;
  return check("sandbox", "Tooling", "info", "Coding sandbox", "not ready", {
    ...(detail ? { detail } : {}),
    fix: podman.status === "podman-unavailable" ? "Install rootless Podman, then run: friday setup sandbox" : "friday setup sandbox",
    ...(podman.status === "image-missing" ? { repair: "sandbox" as const } : {}),
  });
}

export async function collectDoctorChecks(environment: NodeJS.ProcessEnv = process.env): Promise<readonly DoctorCheck[]> {
  const home = getFridayHome(environment);
  const checks: DoctorCheck[] = [platformCheck(environment), await homeCheck(home)];

  let settings: RuntimeSettings | undefined;
  try {
    settings = await readRuntimeSettings(home);
    checks.push(settings
      ? check("runtime-settings", "Configuration", "ok", "Runtime settings", `${settings.modelProvider}/${settings.modelId}`, {
          detail: `${settings.timezone} · permission=${settings.permissionMode}${settings.routingModelId ? ` · router=${settings.routingProvider}/${settings.routingModelId}` : ""}`,
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

  checks.push(await workspaceCheck(environment, home, settings));
  checks.push(...await channelChecks(home));
  checks.push(await modelCredentialCheck(environment, home, settings));
  checks.push(await voiceCheck(environment, home, settings));
  checks.push(await sourceRepositoryCheck(settings?.selfRepository ?? environment.FRIDAY_SELF_REPOSITORY));
  checks.push(permissionCheck(settings));
  checks.push(await vaultCheck(environment, home, settings));
  checks.push(sandboxNetworkCheck(environment));
  checks.push(...toolChecks());
  checks.push(await nodeToolchainCheck(settings?.selfRepository ?? environment.FRIDAY_SELF_REPOSITORY));
  checks.push(executionPythonCheck(environment));
  checks.push(await whatsappToolingCheck(environment, home));
  checks.push(sandboxCheck());
  checks.push(await backupCheck(environment));
  checks.push(await latestCrash(home));
  checks.push(await diskCheck(home));
  return Object.freeze(checks);
}

const SECTION_ORDER: readonly DoctorSection[] = Object.freeze(["Installation", "Configuration", "Security", "Tooling", "Recovery"]);

function levelSymbol(level: DoctorLevel): string {
  if (level === "ok") return "✓";
  if (level === "info") return "·";
  if (level === "warn") return "!";
  return "✗";
}

function resultLabel(checks: readonly DoctorCheck[]): string {
  if (checks.some((item) => item.level === "error")) return "NEEDS ATTENTION";
  if (checks.some((item) => item.level === "warn")) return "READY WITH WARNINGS";
  return "READY";
}

export function formatDoctorReport(checks: readonly DoctorCheck[], environment: NodeJS.ProcessEnv = process.env): string {
  const counts = {
    ok: checks.filter((item) => item.level === "ok").length,
    info: checks.filter((item) => item.level === "info").length,
    warn: checks.filter((item) => item.level === "warn").length,
    error: checks.filter((item) => item.level === "error").length,
  };
  const home = getFridayHome(environment);
  const lines = [
    `F.R.I.D.A.Y Doctor  v${FRIDAY_VERSION}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Status   ${resultLabel(checks)}`,
    `System   ${process.platform}/${process.arch} · Node ${process.version}`,
    `Home     ${home}`,
    `Summary  ${counts.ok} healthy · ${counts.info} optional/info · ${counts.warn} warning · ${counts.error} blocked`,
  ];

  for (const section of SECTION_ORDER) {
    const sectionChecks = checks.filter((item) => item.section === section);
    if (sectionChecks.length === 0) continue;
    lines.push("", section.toUpperCase());
    for (const item of sectionChecks) {
      lines.push(`  ${levelSymbol(item.level)} ${item.label.padEnd(22)} ${item.message}`);
      if (item.detail) lines.push(`      ${item.detail}`);
      if (item.level !== "ok" && item.fix) lines.push(`      → ${item.fix}`);
    }
  }

  const actionable = checks.filter((item) => item.level !== "ok" && item.fix);
  if (actionable.length > 0) {
    lines.push("", `Next  ${actionable.length} item(s) have a one-line repair guide above.`);
    if (checks.some((item) => item.repair && item.level !== "ok")) {
      lines.push("      Run `friday doctor --fix` for guided repairs that F.R.I.D.A.Y can perform safely.");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function confirmRepair(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function runRepairs(checks: readonly DoctorCheck[], environment: NodeJS.ProcessEnv): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`friday doctor --fix` requires an interactive terminal; use plain `friday doctor` or `--json` in automation");
  }
  const repairs = [...new Set(checks.filter((item) => item.level !== "ok").map((item) => item.repair).filter((item): item is DoctorRepairId => Boolean(item)))];
  if (repairs.length === 0) {
    process.stdout.write("\nNo safe automatic repairs are currently available. Follow the one-line guides above.\n");
    return;
  }

  for (const repair of repairs) {
    if (repair === "home-permissions") {
      const home = getFridayHome(environment);
      if (await confirmRepair(`Set ${home} permissions to 0700?`)) await chmod(home, 0o700);
      continue;
    }
    if (repair === "setup") {
      if (await confirmRepair("Run interactive `friday setup` now?")) await runSetupCli([]);
      continue;
    }
    if (repair === "execution-python") {
      if (await confirmRepair("Provision the private Python execution environment now?")) await runSetupCli(["execution-python"]);
      continue;
    }
    if (repair === "sandbox") {
      if (await confirmRepair("Build/repair the rootless Podman sandbox image now?")) await runSetupCli(["sandbox"]);
    }
  }
}

function doctorHelp(): string {
  return [
    "F.R.I.D.A.Y doctor",
    "",
    "Usage:",
    "  friday doctor          Run local health/security/recovery diagnostics",
    "  friday doctor --fix    Offer guided repairs only for deterministic supported fixes",
    "  friday doctor --json   Emit machine-readable diagnostics without prompts",
    "  friday doctor --help",
    "",
    "Doctor does not make outbound network requests or read plaintext Vault secrets.",
    "Potentially consequential repairs are never performed unless `--fix` is explicitly requested and confirmed.",
    "",
  ].join("\n");
}

export async function runDoctor(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    if (args.length !== 1) throw new Error("`friday doctor --help` does not accept additional options");
    process.stdout.write(doctorHelp());
    return 0;
  }
  const json = args.includes("--json");
  const fix = args.includes("--fix");
  const unknown = args.filter((arg) => arg !== "--json" && arg !== "--fix");
  if (unknown.length > 0) throw new Error(`Unknown doctor option(s): ${unknown.join(" ")}`);
  if (json && fix) throw new Error("`friday doctor --json` cannot be combined with `--fix`");

  let checks = await collectDoctorChecks(process.env);
  if (json) {
    const publicChecks = checks.map(({ repair: _repair, ...item }) => item);
    process.stdout.write(`${JSON.stringify({ version: FRIDAY_VERSION, status: resultLabel(checks), checks: publicChecks }, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorReport(checks, process.env));
    if (fix) {
      await runRepairs(checks, process.env);
      checks = await collectDoctorChecks(process.env);
      process.stdout.write(`\nAfter guided repairs\n${formatDoctorReport(checks, process.env)}`);
    }
  }
  return checks.some((item) => item.level === "error") ? 1 : 0;
}
