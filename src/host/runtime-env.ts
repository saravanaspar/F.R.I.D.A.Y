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
] as const);

type SupportedKey = (typeof RUNTIME_ENV_KEYS)[number];

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
}

async function readRuntimeEnvironment(home: string): Promise<Partial<Record<SupportedKey, string>>> {
  const root = resolve(home);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`FRIDAY home must be a private directory: ${root}`);
    if ((rootInfo.mode & 0o077) !== 0) throw new Error(`FRIDAY home permissions are too broad: ${root}`);
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
  if ((metadata.mode & 0o077) !== 0) throw new Error(`FRIDAY runtime environment permissions are too broad: ${path}`);
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
  for (const key of RUNTIME_ENV_KEYS) {
    if (environment[key]?.trim()) continue;
    const value = parsed[key];
    if (value) environment[key] = value;
  }
}
