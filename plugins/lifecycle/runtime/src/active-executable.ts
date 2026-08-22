import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ACTIVE_SCHEMA = 1 as const;
const ACTIVE_FILE = "active.json";

export interface FridayExecutableDescriptor {
  readonly path: string;
  readonly sha256: string;
}

export interface FridayActiveExecutable extends FridayExecutableDescriptor {
  readonly schema: typeof ACTIVE_SCHEMA;
  readonly generationId: string;
  readonly commit: string;
  readonly activatedAt: string;
}

function fridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
}

export function getFridayUpdateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return join(fridayHome(environment), ".updates");
}

function binariesRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return join(getFridayUpdateRoot(environment), "binaries");
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function safeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function assertPrivateDirectory(path: string, create = false): void {
  if (!existsSync(path)) {
    if (!create) throw new Error(`FRIDAY update directory does not exist: ${path}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`FRIDAY update path must be a directory: ${path}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    chmodSync(path, 0o700);
  }
}

function assertPrivateFile(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`FRIDAY update file must be a regular file: ${path}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`FRIDAY update file permissions are too broad: ${path}`);
  }
}

export function sha256FileSync(path: string): string {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function describeFridayExecutable(path: string): FridayExecutableDescriptor {
  const resolved = realpathSync(resolve(path));
  const info = lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`FRIDAY executable must be a regular file: ${resolved}`);
  return Object.freeze({ path: resolved, sha256: sha256FileSync(resolved) });
}

export function stageFridayExecutable(
  sourcePath: string,
  input: { readonly generationId: string; readonly commit: string },
  environment: NodeJS.ProcessEnv = process.env,
): FridayExecutableDescriptor {
  const generationId = safeId(input.generationId, "Generation id");
  safeId(input.commit, "Generation commit");
  const source = describeFridayExecutable(sourcePath);
  const root = getFridayUpdateRoot(environment);
  const binaries = binariesRoot(environment);
  assertPrivateDirectory(root, true);
  assertPrivateDirectory(binaries, true);
  const generationRoot = join(binaries, generationId);
  assertPrivateDirectory(generationRoot, true);
  const filename = process.platform === "win32" ? "friday.exe" : "friday";
  const target = join(generationRoot, filename);
  const temp = join(generationRoot, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  copyFileSync(source.path, temp);
  if (process.platform !== "win32") chmodSync(temp, 0o700);
  const stagedHash = sha256FileSync(temp);
  if (stagedHash !== source.sha256) {
    rmSync(temp, { force: true });
    throw new Error("Staged FRIDAY executable hash does not match the verified build");
  }
  renameSync(temp, target);
  if (process.platform !== "win32") chmodSync(target, 0o700);
  return describeFridayExecutable(target);
}

function parseRecord(value: unknown): FridayActiveExecutable {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FRIDAY active executable record must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== ACTIVE_SCHEMA) throw new Error("FRIDAY active executable schema is unsupported");
  if (typeof raw.path !== "string" || !isAbsolute(raw.path)) throw new Error("FRIDAY active executable path is invalid");
  if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw new Error("FRIDAY active executable hash is invalid");
  const generationId = safeId(String(raw.generationId ?? ""), "Active generation id");
  const commit = safeId(String(raw.commit ?? ""), "Active generation commit");
  if (typeof raw.activatedAt !== "string" || !Number.isFinite(Date.parse(raw.activatedAt))) {
    throw new Error("FRIDAY active executable activation time is invalid");
  }
  return Object.freeze({
    schema: ACTIVE_SCHEMA,
    path: resolve(raw.path),
    sha256: raw.sha256,
    generationId,
    commit,
    activatedAt: new Date(raw.activatedAt).toISOString(),
  });
}

function verifyStagedDescriptor(
  descriptor: FridayExecutableDescriptor,
  environment: NodeJS.ProcessEnv,
): FridayExecutableDescriptor {
  const binaries = binariesRoot(environment);
  assertPrivateDirectory(getFridayUpdateRoot(environment), true);
  assertPrivateDirectory(binaries, true);
  const requested = resolve(descriptor.path);
  if (!contained(binaries, requested) || requested === binaries) throw new Error("FRIDAY active executable must stay inside the private update cache");
  assertPrivateFile(requested);
  const real = realpathSync(requested);
  const realBinaries = realpathSync(binaries);
  if (!contained(realBinaries, real) || real === realBinaries) throw new Error("FRIDAY active executable escapes the private update cache");
  const hash = sha256FileSync(real);
  if (hash !== descriptor.sha256) throw new Error("FRIDAY active executable failed SHA-256 verification");
  return Object.freeze({ path: real, sha256: hash });
}

export function activateFridayExecutable(
  descriptor: FridayExecutableDescriptor,
  input: { readonly generationId: string; readonly commit: string; readonly now?: string },
  environment: NodeJS.ProcessEnv = process.env,
): FridayActiveExecutable {
  const verified = verifyStagedDescriptor(descriptor, environment);
  const record: FridayActiveExecutable = Object.freeze({
    schema: ACTIVE_SCHEMA,
    ...verified,
    generationId: safeId(input.generationId, "Generation id"),
    commit: safeId(input.commit, "Generation commit"),
    activatedAt: input.now ?? new Date().toISOString(),
  });
  const root = getFridayUpdateRoot(environment);
  assertPrivateDirectory(root, true);
  const target = join(root, ACTIVE_FILE);
  const temp = join(root, `.${ACTIVE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, target);
  if (process.platform !== "win32") chmodSync(target, 0o600);
  return record;
}

export function resolveFridayActiveExecutable(environment: NodeJS.ProcessEnv = process.env): FridayActiveExecutable | undefined {
  const root = getFridayUpdateRoot(environment);
  const path = join(root, ACTIVE_FILE);
  if (!existsSync(path)) return undefined;
  assertPrivateDirectory(root, false);
  assertPrivateFile(path);
  const parsed = parseRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const verified = verifyStagedDescriptor(parsed, environment);
  return Object.freeze({ ...parsed, path: verified.path, sha256: verified.sha256 });
}

export function clearFridayActiveExecutableIfMatches(
  descriptor: FridayExecutableDescriptor,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const root = getFridayUpdateRoot(environment);
  const path = join(root, ACTIVE_FILE);
  if (!existsSync(path)) return false;
  const active = resolveFridayActiveExecutable(environment);
  if (!active || active.path !== realpathSync(resolve(descriptor.path)) || active.sha256 !== descriptor.sha256) return false;
  rmSync(path, { force: true });
  return true;
}

export function removeFridayStagedExecutable(
  descriptor: FridayExecutableDescriptor,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const verified = verifyStagedDescriptor(descriptor, environment);
  clearFridayActiveExecutableIfMatches(verified, environment);
  const generationRoot = dirname(verified.path);
  rmSync(generationRoot, { recursive: true, force: true });
}
