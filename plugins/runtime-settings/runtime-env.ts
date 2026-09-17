import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { reportOperationalError } from "@friday/operational-errors";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RuntimePermissionMode = "ask" | "auto" | "full";
export type HostPrivilegeMode = "broker" | "none";
export type RuntimeComputerBrowserMode = "shared" | "managed-cdp";

export interface RuntimeComputerSettings {
  readonly provider: "linux-x11";
  readonly sessionMode: "native-x11";
  readonly browserMode: RuntimeComputerBrowserMode;
  readonly browserBin: string;
  readonly browserArgs?: readonly string[] | undefined;
  readonly agentScreens: number;
  readonly x11AgentDesktops: readonly number[];
  readonly cdpUrl?: string | undefined;
  readonly cdpPort?: number | undefined;
  readonly browserProfileDir?: string | undefined;
}

export interface RuntimeSettings {
  /** Main reasoning model. Optional during router-only bootstrap mode. */
  readonly modelProvider?: string | undefined;
  readonly modelId?: string | undefined;
  /** Routing/system classifier model. Always resolved in normalized settings. */
  readonly routingProvider?: string | undefined;
  readonly routingModelId?: string | undefined;
  readonly permissionMode: RuntimePermissionMode;
  /** Host privilege boundary is independent from agent permission mode. */
  readonly hostPrivilegeMode?: HostPrivilegeMode | undefined;
  /** IANA timezone used for all user-facing wall-clock scheduling. */
  readonly timezone: string;
  /** Dedicated writable workspace used by model/tool execution; must not overlap FRIDAY_HOME. */
  readonly workspaceRoot?: string | undefined;
  /** Optional canonical checkout FRIDAY may modify for self-improvement. */
  readonly selfRepository?: string | undefined;
  /** Optional local Computer setup owned by the installed FRIDAY binary. */
  readonly computer?: RuntimeComputerSettings | undefined;
}

export interface RuntimeSettingsPatch {
  readonly modelProvider?: string | null | undefined;
  readonly modelId?: string | null | undefined;
  readonly routingProvider?: string | null | undefined;
  readonly routingModelId?: string | null | undefined;
  readonly permissionMode?: RuntimePermissionMode | string | undefined;
  readonly hostPrivilegeMode?: HostPrivilegeMode | string | undefined;
  readonly timezone?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly selfRepository?: string | null | undefined;
  readonly computer?: RuntimeComputerSettings | null | undefined;
}

const RUNTIME_ENV_FILE = "runtime.env";
export const RUNTIME_ENV_KEYS = Object.freeze([
  "FRIDAY_MODEL_PROVIDER",
  "FRIDAY_MODEL_ID",
  "FRIDAY_ROUTING_PROVIDER",
  "FRIDAY_ROUTING_MODEL_ID",
  "FRIDAY_PERMISSION_MODE",
  "FRIDAY_HOST_PRIVILEGE_MODE",
  "FRIDAY_TIMEZONE",
  "FRIDAY_WORKSPACE",
  "FRIDAY_SELF_REPOSITORY",
  "FRIDAY_COMPUTER_PROVIDER",
  "FRIDAY_COMPUTER_SESSION_MODE",
  "FRIDAY_COMPUTER_BROWSER_MODE",
  "FRIDAY_COMPUTER_BROWSER_BIN",
  "FRIDAY_COMPUTER_BROWSER_ARGS",
  "FRIDAY_COMPUTER_AGENT_SCREENS",
  "FRIDAY_COMPUTER_X11_AGENT_DESKTOPS",
  "FRIDAY_COMPUTER_CDP_URL",
  "FRIDAY_COMPUTER_CDP_PORT",
  "FRIDAY_COMPUTER_BROWSER_PROFILE_DIR",
] as const);

type SupportedKey = (typeof RUNTIME_ENV_KEYS)[number];
const COMPUTER_RUNTIME_ENV_KEYS = new Set<SupportedKey>(RUNTIME_ENV_KEYS.filter((key) => key.startsWith("FRIDAY_COMPUTER_")));

function nonEmpty(value: string | undefined, label: string, maximum = 256): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  if (/[^\P{Cc}\t]/u.test(normalized) || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} contains unsupported control characters`);
  }
  return normalized;
}

export function normalizeRuntimePermissionMode(value: string | undefined): RuntimePermissionMode {
  const normalized = value?.trim().toLowerCase() || "ask";
  if (normalized === "ask" || normalized === "auto" || normalized === "full") return normalized;
  throw new Error("permission mode must be ask, auto, or full");
}

export function normalizeHostPrivilegeMode(value: string | undefined): HostPrivilegeMode {
  const normalized = value?.trim().toLowerCase() || "none";
  if (normalized === "broker" || normalized === "none") return normalized;
  throw new Error("host privilege mode must be broker or none");
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function normalizeRuntimeTimezone(value: string | undefined): string {
  const normalized = value?.trim() || systemTimezone();
  if (!normalized || normalized.length > 128 || /[\r\n\0]/.test(normalized)) {
    throw new Error("timezone must be a valid IANA timezone");
  }
  try {
    // Construction is the portable platform validation for IANA zone names.
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA timezone: ${JSON.stringify(normalized)}`);
  }
  return normalized;
}


export function normalizeSelfRepository(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 4_096 || /[\r\n\0]/.test(normalized)) {
    throw new Error("self-improvement repository path is invalid");
  }
  return resolve(normalized);
}

function normalizeComputerBrowserMode(value: string | undefined): RuntimeComputerBrowserMode {
  const normalized = value?.trim().toLowerCase() || "shared";
  if (normalized === "shared" || normalized === "managed-cdp") return normalized;
  throw new Error("computer browser mode must be shared or managed-cdp");
}

function normalizeBrowserArgs(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 16) throw new Error("computer browser arguments exceed 16 entries");
  return Object.freeze(value.map((entry, index) => nonEmpty(entry, `computer browser argument ${index + 1}`, 512)));
}

function parseBrowserArgs(value: string | undefined): readonly string[] | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); } catch { throw new Error("FRIDAY_COMPUTER_BROWSER_ARGS must be a JSON string array"); }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("FRIDAY_COMPUTER_BROWSER_ARGS must be a JSON string array");
  }
  return normalizeBrowserArgs(parsed as string[]);
}

function normalizePositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be between 1 and ${maximum}`);
  return value;
}

function normalizeDesktopIndexes(values: readonly number[]): readonly number[] {
  if (values.length < 1 || values.length > 8) throw new Error("computer X11 desktop indexes must contain between 1 and 8 entries");
  const normalized = values.map((value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error("computer X11 desktop indexes must be zero-based integers");
    return value;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("computer X11 desktop indexes must be unique");
  return Object.freeze(normalized);
}

function normalizeComputerSettings(settings: RuntimeComputerSettings | undefined): RuntimeComputerSettings | undefined {
  if (settings === undefined) return undefined;
  if (settings.provider !== "linux-x11") throw new Error("computer provider must be linux-x11");
  if (settings.sessionMode !== "native-x11") throw new Error("computer session mode must be native-x11");
  const browserMode = normalizeComputerBrowserMode(settings.browserMode);
  const browserBin = nonEmpty(settings.browserBin, "computer browser executable", 1024);
  const browserArgs = normalizeBrowserArgs(settings.browserArgs);
  const agentScreens = normalizePositiveInteger(settings.agentScreens, "computer agent screens", 8);
  const x11AgentDesktops = normalizeDesktopIndexes(settings.x11AgentDesktops);
  if (x11AgentDesktops.length !== agentScreens) throw new Error("computer X11 desktop count must match agentScreens");
  let cdpUrl: string | undefined;
  let cdpPort: number | undefined;
  let browserProfileDir: string | undefined;
  if (browserMode === "managed-cdp") {
    cdpUrl = nonEmpty(settings.cdpUrl, "computer CDP URL", 2048);
    let url: URL;
    try { url = new URL(cdpUrl); } catch { throw new Error("computer CDP URL is invalid"); }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      throw new Error("computer CDP URL must use loopback HTTP");
    }
    cdpPort = normalizePositiveInteger(settings.cdpPort ?? Number(url.port || 80), "computer CDP port", 65_535);
    browserProfileDir = resolve(nonEmpty(settings.browserProfileDir, "computer managed browser profile directory", 4096));
  }
  return Object.freeze({
    provider: "linux-x11" as const,
    sessionMode: "native-x11" as const,
    browserMode,
    browserBin,
    ...(browserArgs === undefined ? {} : { browserArgs }),
    agentScreens,
    x11AgentDesktops,
    ...(cdpUrl === undefined ? {} : { cdpUrl }),
    ...(cdpPort === undefined ? {} : { cdpPort }),
    ...(browserProfileDir === undefined ? {} : { browserProfileDir }),
  });
}

function computerSettingsFromParsed(parsed: Partial<Record<SupportedKey, string>>): RuntimeComputerSettings | undefined {
  const provider = parsed.FRIDAY_COMPUTER_PROVIDER?.trim();
  const related = [
    parsed.FRIDAY_COMPUTER_SESSION_MODE,
    parsed.FRIDAY_COMPUTER_BROWSER_MODE,
    parsed.FRIDAY_COMPUTER_BROWSER_BIN,
    parsed.FRIDAY_COMPUTER_BROWSER_ARGS,
    parsed.FRIDAY_COMPUTER_AGENT_SCREENS,
    parsed.FRIDAY_COMPUTER_X11_AGENT_DESKTOPS,
    parsed.FRIDAY_COMPUTER_CDP_URL,
    parsed.FRIDAY_COMPUTER_CDP_PORT,
    parsed.FRIDAY_COMPUTER_BROWSER_PROFILE_DIR,
  ];
  if (!provider && related.every((value) => !value?.trim())) return undefined;
  if (provider !== "linux-x11") throw new Error("FRIDAY_COMPUTER_PROVIDER must be linux-x11");
  if (parsed.FRIDAY_COMPUTER_SESSION_MODE?.trim() !== "native-x11") throw new Error("FRIDAY_COMPUTER_SESSION_MODE must be native-x11");
  const browserMode = normalizeComputerBrowserMode(parsed.FRIDAY_COMPUTER_BROWSER_MODE);
  const agentScreens = normalizePositiveInteger(Number(parsed.FRIDAY_COMPUTER_AGENT_SCREENS), "FRIDAY_COMPUTER_AGENT_SCREENS", 8);
  const x11AgentDesktops = normalizeDesktopIndexes((parsed.FRIDAY_COMPUTER_X11_AGENT_DESKTOPS ?? "")
    .split(",")
    .filter(Boolean)
    .map((value) => Number(value)));
  const browserArgs = parseBrowserArgs(parsed.FRIDAY_COMPUTER_BROWSER_ARGS);
  return normalizeComputerSettings({
    provider: "linux-x11",
    sessionMode: "native-x11",
    browserMode,
    browserBin: nonEmpty(parsed.FRIDAY_COMPUTER_BROWSER_BIN, "FRIDAY_COMPUTER_BROWSER_BIN", 1024),
    ...(browserArgs === undefined ? {} : { browserArgs }),
    agentScreens,
    x11AgentDesktops,
    ...(browserMode === "managed-cdp" ? {
      cdpUrl: parsed.FRIDAY_COMPUTER_CDP_URL,
      cdpPort: Number(parsed.FRIDAY_COMPUTER_CDP_PORT),
      browserProfileDir: parsed.FRIDAY_COMPUTER_BROWSER_PROFILE_DIR,
    } : {}),
  });
}

export function getFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}


function defaultWorkspaceForHome(home: string): string {
  return join(dirname(resolve(home)), "FRIDAY-workspace");
}

export function normalizeRuntimeWorkspace(value: string | undefined, home = getFridayHome()): string {
  const normalized = value?.trim();
  const workspace = resolve(normalized || defaultWorkspaceForHome(home));
  if (workspace.length > 4_096 || /[\r\n\0]/.test(workspace)) {
    throw new Error("workspace path is invalid");
  }
  return workspace;
}

export function getFridayWorkspace(environment: NodeJS.ProcessEnv = process.env): string {
  return normalizeRuntimeWorkspace(environment.FRIDAY_WORKSPACE, getFridayHome(environment));
}

function pathInside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

export async function ensureFridayWorkspace(
  environment: NodeJS.ProcessEnv = process.env,
  home = getFridayHome(environment),
): Promise<string> {
  const workspace = normalizeRuntimeWorkspace(environment.FRIDAY_WORKSPACE, home);
  if (pathInside(home, workspace) || pathInside(workspace, home)) {
    throw new Error(`FRIDAY workspace must not overlap FRIDAY_HOME: workspace=${workspace}; home=${resolve(home)}`);
  }
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const info = await lstat(workspace);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`FRIDAY workspace must be a real directory: ${workspace}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(workspace, info.mode & ~0o077);
  const canonicalWorkspace = await realpath(workspace);
  let canonicalHome = resolve(home);
  try { canonicalHome = await realpath(home); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pathInside(canonicalHome, canonicalWorkspace) || pathInside(canonicalWorkspace, canonicalHome)) {
    throw new Error(`FRIDAY workspace must not overlap FRIDAY_HOME after resolving filesystem links: workspace=${canonicalWorkspace}; home=${canonicalHome}`);
  }
  environment.FRIDAY_WORKSPACE = canonicalWorkspace;
  return canonicalWorkspace;
}

export function getRuntimeEnvironmentPath(home = getFridayHome()): string {
  return join(resolve(home), RUNTIME_ENV_FILE);
}

async function assertPrivateRuntimeRoot(root: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`FRIDAY home must be a private directory: ${root}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`FRIDAY home permissions are too broad: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error(`FRIDAY home could not be made private: ${root}`);
    }
  }
}

function encodeValue(value: string): string {
  return JSON.stringify(value);
}

function decodeValue(raw: string, lineNumber: number): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new Error(`Invalid FRIDAY runtime environment value on line ${lineNumber}`);
    }
  }
  return value;
}

export function parseRuntimeEnvironment(text: string): Partial<Record<SupportedKey, string>> {
  const parsed: Partial<Record<SupportedKey, string>> = {};
  const supported = new Set<string>(RUNTIME_ENV_KEYS);
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) throw new Error(`Invalid FRIDAY runtime environment line ${index + 1}`);
    const key = line.slice(0, equals).trim();
    if (!supported.has(key)) throw new Error(`Unsupported FRIDAY runtime environment key: ${key}`);
    parsed[key as SupportedKey] = decodeValue(line.slice(equals + 1), index + 1);
  }
  return parsed;
}

async function readParsedRuntimeEnvironment(home: string): Promise<Partial<Record<SupportedKey, string>>> {
  const root = resolve(home);
  await assertPrivateRuntimeRoot(root, false);
  const path = getRuntimeEnvironmentPath(root);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`FRIDAY runtime environment must not be a symlink: ${path}`);
  if (!metadata.isFile()) throw new Error(`FRIDAY runtime environment must be a regular file: ${path}`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`FRIDAY runtime environment permissions are too broad: ${path}`);
  }
  return parseRuntimeEnvironment(await readFile(path, "utf8"));
}

function settingsFromParsed(parsed: Partial<Record<SupportedKey, string>>, home: string): RuntimeSettings | undefined {
  const provider = parsed.FRIDAY_MODEL_PROVIDER?.trim();
  const modelId = parsed.FRIDAY_MODEL_ID?.trim();
  if (Boolean(provider) !== Boolean(modelId)) {
    throw new Error("FRIDAY runtime environment must define both main model provider and model id, or neither");
  }

  const explicitRoutingProvider = parsed.FRIDAY_ROUTING_PROVIDER?.trim();
  const explicitRoutingModelId = parsed.FRIDAY_ROUTING_MODEL_ID?.trim();
  if (Boolean(explicitRoutingProvider) !== Boolean(explicitRoutingModelId)) {
    throw new Error("FRIDAY runtime environment must define both routing provider and routing model id, or neither");
  }
  const routingProvider = explicitRoutingProvider || provider;
  const routingModelId = explicitRoutingModelId || modelId;
  if (!routingProvider || !routingModelId) return undefined;

  const computer = computerSettingsFromParsed(parsed);
  return Object.freeze({
    ...(provider && modelId
      ? { modelProvider: nonEmpty(provider, "model provider"), modelId: nonEmpty(modelId, "model id") }
      : {}),
    routingProvider: nonEmpty(routingProvider, "routing model provider"),
    routingModelId: nonEmpty(routingModelId, "routing model id"),
    permissionMode: normalizeRuntimePermissionMode(parsed.FRIDAY_PERMISSION_MODE),
    hostPrivilegeMode: normalizeHostPrivilegeMode(parsed.FRIDAY_HOST_PRIVILEGE_MODE),
    timezone: normalizeRuntimeTimezone(parsed.FRIDAY_TIMEZONE),
    workspaceRoot: normalizeRuntimeWorkspace(parsed.FRIDAY_WORKSPACE, home),
    ...(normalizeSelfRepository(parsed.FRIDAY_SELF_REPOSITORY) === undefined
      ? {}
      : { selfRepository: normalizeSelfRepository(parsed.FRIDAY_SELF_REPOSITORY) }),
    ...(computer === undefined ? {} : { computer }),
  });
}

export async function readRuntimeSettings(home = getFridayHome()): Promise<RuntimeSettings | undefined> {
  const root = resolve(home);
  return settingsFromParsed(await readParsedRuntimeEnvironment(root), root);
}

export async function loadRuntimeEnvironment(
  options: { readonly home?: string | undefined; readonly environment?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? getFridayHome(environment);
  const parsed = await readParsedRuntimeEnvironment(home);
  // Validate pair invariants even when explicit process environment overrides the stored values.
  settingsFromParsed(parsed, resolve(home));
  const hasPersistedComputer = Boolean(parsed.FRIDAY_COMPUTER_PROVIDER?.trim());
  for (const key of RUNTIME_ENV_KEYS) {
    if (hasPersistedComputer && COMPUTER_RUNTIME_ENV_KEYS.has(key)) {
      delete environment[key];
      const value = parsed[key];
      if (value) environment[key] = value;
      continue;
    }
    if (environment[key]?.trim()) continue;
    const value = parsed[key];
    if (value) environment[key] = value;
  }
}

function normalizeSettings(settings: RuntimeSettings, home = getFridayHome()): RuntimeSettings {
  const mainProvider = settings.modelProvider?.trim();
  const mainModelId = settings.modelId?.trim();
  if (Boolean(mainProvider) !== Boolean(mainModelId)) {
    throw new Error("main model requires both provider and model id, or neither");
  }
  const explicitRoutingProvider = settings.routingProvider?.trim();
  const explicitRoutingModelId = settings.routingModelId?.trim();
  if (Boolean(explicitRoutingProvider) !== Boolean(explicitRoutingModelId)) {
    throw new Error("routing model requires both provider and model id, or neither");
  }
  const routingProvider = explicitRoutingProvider || mainProvider;
  const routingModelId = explicitRoutingModelId || mainModelId;
  if (!routingProvider || !routingModelId) {
    throw new Error("FRIDAY requires a routing model; configure routingProvider/routingModelId or a main model");
  }
  const computer = normalizeComputerSettings(settings.computer);
  return Object.freeze({
    ...(mainProvider && mainModelId
      ? { modelProvider: nonEmpty(mainProvider, "model provider"), modelId: nonEmpty(mainModelId, "model id") }
      : {}),
    routingProvider: nonEmpty(routingProvider, "routing model provider"),
    routingModelId: nonEmpty(routingModelId, "routing model id"),
    permissionMode: normalizeRuntimePermissionMode(settings.permissionMode),
    hostPrivilegeMode: normalizeHostPrivilegeMode(settings.hostPrivilegeMode),
    timezone: normalizeRuntimeTimezone(settings.timezone),
    workspaceRoot: normalizeRuntimeWorkspace(settings.workspaceRoot, home),
    ...(normalizeSelfRepository(settings.selfRepository) === undefined
      ? {}
      : { selfRepository: normalizeSelfRepository(settings.selfRepository) }),
    ...(computer === undefined ? {} : { computer }),
  });
}

export function serializeRuntimeSettings(settings: RuntimeSettings, home = getFridayHome()): string {
  const normalized = normalizeSettings(settings, home);
  const computer = normalized.computer;
  return [
    "# FRIDAY non-secret runtime defaults. Secrets belong in Vault.",
    ...(normalized.modelProvider && normalized.modelId
      ? [
          `FRIDAY_MODEL_PROVIDER=${encodeValue(normalized.modelProvider)}`,
          `FRIDAY_MODEL_ID=${encodeValue(normalized.modelId)}`,
        ]
      : []),
    `FRIDAY_ROUTING_PROVIDER=${encodeValue(normalized.routingProvider!)}`,
    `FRIDAY_ROUTING_MODEL_ID=${encodeValue(normalized.routingModelId!)}`,
    `FRIDAY_PERMISSION_MODE=${encodeValue(normalized.permissionMode)}`,
    `FRIDAY_HOST_PRIVILEGE_MODE=${encodeValue(normalized.hostPrivilegeMode!)}`,
    `FRIDAY_TIMEZONE=${encodeValue(normalized.timezone)}`,
    `FRIDAY_WORKSPACE=${encodeValue(normalized.workspaceRoot!)}`,
    ...(normalized.selfRepository ? [`FRIDAY_SELF_REPOSITORY=${encodeValue(normalized.selfRepository)}`] : []),
    ...(computer ? [
      `FRIDAY_COMPUTER_PROVIDER=${encodeValue(computer.provider)}`,
      `FRIDAY_COMPUTER_SESSION_MODE=${encodeValue(computer.sessionMode)}`,
      `FRIDAY_COMPUTER_BROWSER_MODE=${encodeValue(computer.browserMode)}`,
      `FRIDAY_COMPUTER_BROWSER_BIN=${encodeValue(computer.browserBin)}`,
      ...(computer.browserArgs && computer.browserArgs.length > 0
        ? [`FRIDAY_COMPUTER_BROWSER_ARGS=${encodeValue(JSON.stringify(computer.browserArgs))}`]
        : []),
      `FRIDAY_COMPUTER_AGENT_SCREENS=${encodeValue(String(computer.agentScreens))}`,
      `FRIDAY_COMPUTER_X11_AGENT_DESKTOPS=${encodeValue(computer.x11AgentDesktops.join(","))}`,
      ...(computer.browserMode === "managed-cdp" ? [
        `FRIDAY_COMPUTER_CDP_URL=${encodeValue(computer.cdpUrl!)}`,
        `FRIDAY_COMPUTER_CDP_PORT=${encodeValue(String(computer.cdpPort!))}`,
        `FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=${encodeValue(computer.browserProfileDir!)}`,
      ] : []),
    ] : []),
    "",
  ].join("\n");
}

export async function saveRuntimeSettings(
  settings: RuntimeSettings,
  home = getFridayHome(),
): Promise<string> {
  const root = resolve(home);
  const path = getRuntimeEnvironmentPath(root);
  await assertPrivateRuntimeRoot(root, true);
  const contents = serializeRuntimeSettings(settings, root);
  const temporary = join(dirname(path), `.${RUNTIME_ENV_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        reportOperationalError({ component: "runtime-env", operation: "remove failed settings write", error: cleanupError });
      }
    });
    throw error;
  }
  const current = await stat(path);
  if ((current.mode & 0o077) !== 0) {
    throw new Error(`FRIDAY runtime environment permissions are too broad: ${path}`);
  }
  return path;
}

export async function updateRuntimeSettings(
  patch: RuntimeSettingsPatch,
  home = getFridayHome(),
): Promise<RuntimeSettings> {
  const current = await readRuntimeSettings(home);
  if (!current) throw new Error("FRIDAY runtime settings do not exist; run `friday setup` first");

  const clearMain = patch.modelProvider === null || patch.modelId === null;
  const modelProvider = clearMain ? undefined : (patch.modelProvider ?? current.modelProvider);
  const modelId = clearMain ? undefined : (patch.modelId ?? current.modelId);
  if (Boolean(modelProvider) !== Boolean(modelId)) {
    throw new Error("main model update requires both modelProvider and modelId, or clearing both");
  }

  const clearRouting = patch.routingProvider === null || patch.routingModelId === null;
  const routingProvider = clearRouting ? undefined : (patch.routingProvider ?? current.routingProvider);
  const routingModelId = clearRouting ? undefined : (patch.routingModelId ?? current.routingModelId);
  const selfRepository = patch.selfRepository === null ? undefined : (patch.selfRepository ?? current.selfRepository);
  const computer = patch.computer === null ? undefined : (patch.computer ?? current.computer);
  const next = normalizeSettings({
    ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
    ...(routingProvider && routingModelId ? { routingProvider, routingModelId } : {}),
    permissionMode: normalizeRuntimePermissionMode(patch.permissionMode ?? current.permissionMode),
    hostPrivilegeMode: normalizeHostPrivilegeMode(patch.hostPrivilegeMode ?? current.hostPrivilegeMode),
    timezone: normalizeRuntimeTimezone(patch.timezone ?? current.timezone),
    workspaceRoot: normalizeRuntimeWorkspace(patch.workspaceRoot ?? current.workspaceRoot, home),
    ...(selfRepository === undefined ? {} : { selfRepository }),
    ...(computer === undefined ? {} : { computer }),
  }, home);
  await saveRuntimeSettings(next, home);
  return next;
}
