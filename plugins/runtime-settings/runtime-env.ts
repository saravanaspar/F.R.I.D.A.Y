import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { reportOperationalError } from "@friday/operational-errors";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RuntimePermissionMode = "ask" | "auto" | "full";

export interface RuntimeSettings {
  readonly modelProvider: string;
  readonly modelId: string;
  /** Optional cheap classifier model. Omit both fields to reuse the main model. */
  readonly routingProvider?: string | undefined;
  readonly routingModelId?: string | undefined;
  readonly permissionMode: RuntimePermissionMode;
  /** IANA timezone used for all user-facing wall-clock scheduling. */
  readonly timezone: string;
  /** Dedicated writable workspace used by model/tool execution; must not overlap FRIDAY_HOME. */
  readonly workspaceRoot?: string | undefined;
  /** Optional canonical checkout FRIDAY may modify for self-improvement. */
  readonly selfRepository?: string | undefined;
}

export interface RuntimeSettingsPatch {
  readonly modelProvider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly routingProvider?: string | null | undefined;
  readonly routingModelId?: string | null | undefined;
  readonly permissionMode?: RuntimePermissionMode | string | undefined;
  readonly timezone?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly selfRepository?: string | null | undefined;
}

const RUNTIME_ENV_FILE = "runtime.env";
export const RUNTIME_ENV_KEYS = Object.freeze([
  "FRIDAY_MODEL_PROVIDER",
  "FRIDAY_MODEL_ID",
  "FRIDAY_ROUTING_PROVIDER",
  "FRIDAY_ROUTING_MODEL_ID",
  "FRIDAY_PERMISSION_MODE",
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

export function normalizeRuntimePermissionMode(value: string | undefined): RuntimePermissionMode {
  const normalized = value?.trim().toLowerCase() || "ask";
  if (normalized === "ask" || normalized === "auto" || normalized === "full") return normalized;
  throw new Error("permission mode must be ask, auto, or full");
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
  const anyMain = Boolean(provider || modelId);
  if (!anyMain) return undefined;
  if (!provider || !modelId) throw new Error("FRIDAY runtime environment must define both main model provider and model id");

  const routingProvider = parsed.FRIDAY_ROUTING_PROVIDER?.trim();
  const routingModelId = parsed.FRIDAY_ROUTING_MODEL_ID?.trim();
  if (Boolean(routingProvider) !== Boolean(routingModelId)) {
    throw new Error("FRIDAY runtime environment must define both routing provider and routing model id, or neither");
  }
  return Object.freeze({
    modelProvider: nonEmpty(provider, "model provider"),
    modelId: nonEmpty(modelId, "model id"),
    ...(routingProvider && routingModelId
      ? {
          routingProvider: nonEmpty(routingProvider, "routing model provider"),
          routingModelId: nonEmpty(routingModelId, "routing model id"),
        }
      : {}),
    permissionMode: normalizeRuntimePermissionMode(parsed.FRIDAY_PERMISSION_MODE),
    timezone: normalizeRuntimeTimezone(parsed.FRIDAY_TIMEZONE),
    workspaceRoot: normalizeRuntimeWorkspace(parsed.FRIDAY_WORKSPACE, home),
    ...(normalizeSelfRepository(parsed.FRIDAY_SELF_REPOSITORY) === undefined
      ? {}
      : { selfRepository: normalizeSelfRepository(parsed.FRIDAY_SELF_REPOSITORY) }),
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
  for (const key of RUNTIME_ENV_KEYS) {
    if (environment[key]?.trim()) continue;
    const value = parsed[key];
    if (value) environment[key] = value;
  }
}

function normalizeSettings(settings: RuntimeSettings, home = getFridayHome()): RuntimeSettings {
  const routingProvider = settings.routingProvider?.trim();
  const routingModelId = settings.routingModelId?.trim();
  if (Boolean(routingProvider) !== Boolean(routingModelId)) {
    throw new Error("routing model requires both provider and model id, or neither");
  }
  return Object.freeze({
    modelProvider: nonEmpty(settings.modelProvider, "model provider"),
    modelId: nonEmpty(settings.modelId, "model id"),
    ...(routingProvider && routingModelId
      ? {
          routingProvider: nonEmpty(routingProvider, "routing model provider"),
          routingModelId: nonEmpty(routingModelId, "routing model id"),
        }
      : {}),
    permissionMode: normalizeRuntimePermissionMode(settings.permissionMode),
    timezone: normalizeRuntimeTimezone(settings.timezone),
    workspaceRoot: normalizeRuntimeWorkspace(settings.workspaceRoot, home),
    ...(normalizeSelfRepository(settings.selfRepository) === undefined
      ? {}
      : { selfRepository: normalizeSelfRepository(settings.selfRepository) }),
  });
}

export function serializeRuntimeSettings(settings: RuntimeSettings, home = getFridayHome()): string {
  const normalized = normalizeSettings(settings, home);
  return [
    "# FRIDAY non-secret runtime defaults. Secrets belong in Vault.",
    `FRIDAY_MODEL_PROVIDER=${encodeValue(normalized.modelProvider)}`,
    `FRIDAY_MODEL_ID=${encodeValue(normalized.modelId)}`,
    ...(normalized.routingProvider && normalized.routingModelId
      ? [
          `FRIDAY_ROUTING_PROVIDER=${encodeValue(normalized.routingProvider)}`,
          `FRIDAY_ROUTING_MODEL_ID=${encodeValue(normalized.routingModelId)}`,
        ]
      : []),
    `FRIDAY_PERMISSION_MODE=${encodeValue(normalized.permissionMode)}`,
    `FRIDAY_TIMEZONE=${encodeValue(normalized.timezone)}`,
    `FRIDAY_WORKSPACE=${encodeValue(normalized.workspaceRoot!)}`,
    ...(normalized.selfRepository ? [`FRIDAY_SELF_REPOSITORY=${encodeValue(normalized.selfRepository)}`] : []),
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
  const routingProvider = patch.routingProvider === null ? undefined : (patch.routingProvider ?? current.routingProvider);
  const routingModelId = patch.routingModelId === null ? undefined : (patch.routingModelId ?? current.routingModelId);
  const clearRouting = patch.routingProvider === null || patch.routingModelId === null;
  const selfRepository = patch.selfRepository === null ? undefined : (patch.selfRepository ?? current.selfRepository);
  const next = normalizeSettings({
    modelProvider: patch.modelProvider ?? current.modelProvider,
    modelId: patch.modelId ?? current.modelId,
    ...(clearRouting ? {} : routingProvider && routingModelId ? { routingProvider, routingModelId } : {}),
    permissionMode: normalizeRuntimePermissionMode(patch.permissionMode ?? current.permissionMode),
    timezone: normalizeRuntimeTimezone(patch.timezone ?? current.timezone),
    workspaceRoot: normalizeRuntimeWorkspace(patch.workspaceRoot ?? current.workspaceRoot, home),
    ...(selfRepository === undefined ? {} : { selfRepository }),
  }, home);
  await saveRuntimeSettings(next, home);
  return next;
}
