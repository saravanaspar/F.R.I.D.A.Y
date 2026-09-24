import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RUNTIME_ENV_FILE = "runtime.env";
const RUNTIME_ENV_KEYS = Object.freeze([
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

export function getFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}


function defaultWorkspaceForHome(home: string): string {
  return join(dirname(resolve(home)), "FRIDAY-workspace");
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

export function getFridayWorkspace(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_WORKSPACE?.trim();
  const workspace = resolve(configured || defaultWorkspaceForHome(getFridayHome(environment)));
  if (workspace.length > 4_096 || /[\r\n\0]/.test(workspace)) throw new Error("FRIDAY_WORKSPACE is invalid");
  return workspace;
}

export async function prepareRuntimeWorkspace(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const home = getFridayHome(environment);
  const workspace = getFridayWorkspace(environment);
  if (inside(home, workspace) || inside(workspace, home)) {
    throw new Error(`FRIDAY workspace must not overlap FRIDAY_HOME: workspace=${workspace}; home=${home}`);
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
  if (inside(canonicalHome, canonicalWorkspace) || inside(canonicalWorkspace, canonicalHome)) {
    throw new Error(`FRIDAY workspace must not overlap FRIDAY_HOME after resolving filesystem links: workspace=${canonicalWorkspace}; home=${canonicalHome}`);
  }
  environment.FRIDAY_WORKSPACE = canonicalWorkspace;
  process.chdir(canonicalWorkspace);
  return canonicalWorkspace;
}

function runtimeEnvironmentPath(home: string): string {
  return join(resolve(home), RUNTIME_ENV_FILE);
}

function decodeValue(raw: string, lineNumber: number): string {
  const value = raw.trim();
  if (!value) return "";
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed;
  } catch {
    throw new Error(`Invalid FRIDAY runtime environment value on line ${lineNumber}`);
  }
}

function parseRuntimeEnvironment(text: string): Partial<Record<SupportedKey, string>> {
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

function validateRuntimeEnvironment(parsed: Partial<Record<SupportedKey, string>>): void {
  const provider = parsed.FRIDAY_MODEL_PROVIDER?.trim();
  const modelId = parsed.FRIDAY_MODEL_ID?.trim();
  if (Boolean(provider) !== Boolean(modelId)) {
    throw new Error("FRIDAY runtime environment must define both main model provider and model id, or neither");
  }
  if (provider && modelId) {
    nonEmpty(provider, "model provider");
    nonEmpty(modelId, "model id");
  }

  const routingProvider = parsed.FRIDAY_ROUTING_PROVIDER?.trim();
  const routingModelId = parsed.FRIDAY_ROUTING_MODEL_ID?.trim();
  if (Boolean(routingProvider) !== Boolean(routingModelId)) {
    throw new Error("FRIDAY runtime environment must define both routing provider and routing model id, or neither");
  }
  if (routingProvider && routingModelId) {
    nonEmpty(routingProvider, "routing model provider");
    nonEmpty(routingModelId, "routing model id");
  }
  if (!routingProvider && !provider) return;

  const permissionMode = parsed.FRIDAY_PERMISSION_MODE?.trim().toLowerCase() || "ask";
  if (permissionMode !== "ask" && permissionMode !== "auto" && permissionMode !== "full") {
    throw new Error("permission mode must be ask, auto, or full");
  }
  const hostPrivilegeMode = parsed.FRIDAY_HOST_PRIVILEGE_MODE?.trim().toLowerCase() || "none";
  if (hostPrivilegeMode !== "broker" && hostPrivilegeMode !== "none") {
    throw new Error("host privilege mode must be broker or none");
  }

  const timezone = parsed.FRIDAY_TIMEZONE?.trim();
  if (timezone) {
    if (timezone.length > 128 || /[\r\n\0]/.test(timezone)) {
      throw new Error("timezone must be a valid IANA timezone");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    } catch {
      throw new Error(`Invalid IANA timezone: ${JSON.stringify(timezone)}`);
    }
  }

  const workspace = parsed.FRIDAY_WORKSPACE?.trim();
  if (workspace && (workspace.length > 4_096 || /[\r\n\0]/.test(workspace))) {
    throw new Error("FRIDAY workspace path is invalid");
  }

  const selfRepository = parsed.FRIDAY_SELF_REPOSITORY?.trim();
  if (selfRepository && (selfRepository.length > 4_096 || /[\r\n\0]/.test(selfRepository))) {
    throw new Error("self-improvement repository path is invalid");
  }

  const computerProvider = parsed.FRIDAY_COMPUTER_PROVIDER?.trim();
  const computerRelated = [
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
  if (computerProvider || computerRelated.some((value) => value?.trim())) {
    if (computerProvider !== "linux-x11") throw new Error("FRIDAY_COMPUTER_PROVIDER must be linux-x11");
    if (parsed.FRIDAY_COMPUTER_SESSION_MODE?.trim() !== "native-x11") throw new Error("FRIDAY_COMPUTER_SESSION_MODE must be native-x11");
    const browserMode = parsed.FRIDAY_COMPUTER_BROWSER_MODE?.trim() || "shared";
    if (browserMode !== "shared" && browserMode !== "managed-cdp") throw new Error("FRIDAY_COMPUTER_BROWSER_MODE must be shared or managed-cdp");
    nonEmpty(parsed.FRIDAY_COMPUTER_BROWSER_BIN, "FRIDAY_COMPUTER_BROWSER_BIN", 1024);
    const browserArgs = parsed.FRIDAY_COMPUTER_BROWSER_ARGS?.trim();
    if (browserArgs) {
      let decoded: unknown;
      try { decoded = JSON.parse(browserArgs); } catch { throw new Error("FRIDAY_COMPUTER_BROWSER_ARGS must be a JSON string array"); }
      if (!Array.isArray(decoded) || decoded.length > 16 || decoded.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 512 || /[\r\n\0]/.test(entry))) {
        throw new Error("FRIDAY_COMPUTER_BROWSER_ARGS must be a bounded JSON string array");
      }
    }
    const screenCount = Number(parsed.FRIDAY_COMPUTER_AGENT_SCREENS);
    if (!Number.isSafeInteger(screenCount) || screenCount < 1 || screenCount > 8) throw new Error("FRIDAY_COMPUTER_AGENT_SCREENS must be between 1 and 8");
    const desktopIndexes = (parsed.FRIDAY_COMPUTER_X11_AGENT_DESKTOPS ?? "").split(",").filter(Boolean).map(Number);
    if (desktopIndexes.length !== screenCount || new Set(desktopIndexes).size !== desktopIndexes.length
      || desktopIndexes.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 255)) {
      throw new Error("FRIDAY_COMPUTER_X11_AGENT_DESKTOPS must contain one unique zero-based index per Agent screen");
    }
    if (browserMode === "managed-cdp") {
      const cdpUrl = nonEmpty(parsed.FRIDAY_COMPUTER_CDP_URL, "FRIDAY_COMPUTER_CDP_URL", 2048);
      let url: URL;
      try { url = new URL(cdpUrl); } catch { throw new Error("FRIDAY_COMPUTER_CDP_URL is invalid"); }
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("FRIDAY_COMPUTER_CDP_URL must use loopback HTTP");
      const cdpPort = Number(parsed.FRIDAY_COMPUTER_CDP_PORT);
      if (!Number.isSafeInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) throw new Error("FRIDAY_COMPUTER_CDP_PORT is invalid");
      nonEmpty(parsed.FRIDAY_COMPUTER_BROWSER_PROFILE_DIR, "FRIDAY_COMPUTER_BROWSER_PROFILE_DIR", 4096);
    }
  }
}

async function readRuntimeEnvironment(home: string): Promise<Partial<Record<SupportedKey, string>>> {
  const root = resolve(home);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`FRIDAY home must be a private directory: ${root}`);
    if (process.platform !== "win32" && (rootInfo.mode & 0o077) !== 0) throw new Error(`FRIDAY home permissions are too broad: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  const path = runtimeEnvironmentPath(root);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`FRIDAY runtime environment must not be a symlink: ${path}`);
  if (!metadata.isFile()) throw new Error(`FRIDAY runtime environment must be a regular file: ${path}`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error(`FRIDAY runtime environment permissions are too broad: ${path}`);
  const parsed = parseRuntimeEnvironment(await readFile(path, "utf8"));
  validateRuntimeEnvironment(parsed);
  return parsed;
}

export async function loadRuntimeEnvironment(
  options: { readonly home?: string | undefined; readonly environment?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? getFridayHome(environment);
  const parsed = await readRuntimeEnvironment(home);
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
