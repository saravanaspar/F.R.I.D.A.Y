import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { acquireStoppedRuntimeGuard } from "./runtime-coordination.js";

const BACKUP_SCHEMA_LEGACY = 1 as const;
const BACKUP_SCHEMA = 2 as const;
const DEFAULT_RETENTION = 7;
const MAX_RETENTION = 100;
const MANIFEST_NAME = "manifest.json";
const LOCK_STALE_MS = 15 * 60_000;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type StateRootKind = "home" | "state";

export interface StateBackupEntryEncryption {
  readonly iv: string;
  readonly authTag: string;
  readonly storedBytes: number;
}

export interface StateBackupEntry {
  readonly root: StateRootKind;
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
  readonly encryption?: StateBackupEntryEncryption | undefined;
}

export interface StateBackupRoot {
  readonly kind: StateRootKind;
  readonly source: string;
}

export interface StateBackupEncryption {
  readonly algorithm: "aes-256-gcm";
  readonly kdf: "scrypt";
  readonly salt: string;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly manifestMac: string;
}

export interface StateBackupManifest {
  readonly schema: typeof BACKUP_SCHEMA_LEGACY | typeof BACKUP_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly complete: true;
  readonly roots: readonly StateBackupRoot[];
  readonly entries: readonly StateBackupEntry[];
  readonly totalBytes: number;
  readonly encryption?: StateBackupEncryption | undefined;
}

export interface StateBackupOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly backupRoot?: string | undefined;
  readonly retain?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly idFactory?: (() => string) | undefined;
  /** Presence encrypts new backups and unlocks encrypted backups for verify/restore. Never persist this value. */
  readonly passphrase?: string | undefined;
}

export interface StateRestoreOptions extends StateBackupOptions {
  /** Restore changes live state, so callers must make the confirmation explicit. */
  readonly confirm: boolean;
}

export interface StateRestoreResult {
  readonly manifest: StateBackupManifest;
  readonly previousRoots: readonly { kind: StateRootKind; path: string }[];
}

interface BackupEncryptionKeys {
  readonly encryptionKey: Buffer;
  readonly manifestKey: Buffer;
}

interface EncryptionContext extends BackupEncryptionKeys {
  readonly manifest: Omit<StateBackupEncryption, "manifestMac">;
}

async function withRelease<T>(
  release: () => Promise<void>,
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  let primary: unknown;
  try {
    return await operation();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      if (primary !== undefined) {
        throw new AggregateError([
          primary instanceof Error ? primary : new Error(String(primary)),
          releaseError instanceof Error ? releaseError : new Error(String(releaseError)),
        ], `${label} failed and lock release also failed`);
      }
      throw releaseError;
    }
  }
}

function absolute(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return resolve(normalized);
}

export function getFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  return absolute(environment.FRIDAY_HOME?.trim() || join(homedir(), ".friday"), "FRIDAY_HOME");
}

export function getFridayStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return absolute(environment.FRIDAY_STATE_DIR?.trim() || getFridayHome(environment), "FRIDAY_STATE_DIR");
}

export function getStateBackupRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_BACKUP_DIR?.trim();
  if (configured) return absolute(configured, "FRIDAY_BACKUP_DIR");
  const home = getFridayHome(environment);
  const name = basename(home).replace(/^\.+/, "") || "friday";
  return join(dirname(home), `.${name}-backups`);
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function rootsFor(environment: NodeJS.ProcessEnv): StateBackupRoot[] {
  const home = getFridayHome(environment);
  const state = getFridayStateRoot(environment);
  if (inside(home, state)) return [{ kind: "home", source: home }];
  if (inside(state, home)) return [{ kind: "state", source: state }];
  return [{ kind: "home", source: home }, { kind: "state", source: state }];
}

function retention(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION) {
    throw new Error(`Backup retention must be an integer from 1 to ${MAX_RETENTION}`);
  }
  return value;
}

function safeBackupId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error("Backup id is invalid");
  return normalized;
}

function generatedBackupId(now: Date, suffix: string): string {
  return safeBackupId(`${now.toISOString().replace(/[-:.]/g, "")}-${suffix}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function portableRelative(value: string): string {
  const normalized = value.split(sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Backup entry path is unsafe: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function nativeRelative(value: string): string {
  return portableRelative(value).split("/").join(sep);
}

function decodeBase64(value: string, label: string, bytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is invalid`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) throw new Error(`${label} is invalid`);
  return decoded;
}

function deriveBackupKeys(passphrase: string, salt: Buffer, params = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }): BackupEncryptionKeys {
  if (!passphrase) throw new Error("Encrypted backup passphrase is required");
  const material = scryptSync(passphrase, salt, 64, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  try {
    return {
      encryptionKey: Buffer.from(material.subarray(0, 32)),
      manifestKey: Buffer.from(material.subarray(32, 64)),
    };
  } finally {
    material.fill(0);
  }
}

function createEncryptionContext(passphrase: string): EncryptionContext {
  if (passphrase.length < 12) throw new Error("Backup encryption passphrase must contain at least 12 characters");
  const salt = randomBytes(16);
  const keys = deriveBackupKeys(passphrase, salt);
  return {
    ...keys,
    manifest: {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    },
  };
}

function manifestMacPayload(manifest: StateBackupManifest): Buffer {
  const encryption = manifest.encryption
    ? {
      algorithm: manifest.encryption.algorithm,
      kdf: manifest.encryption.kdf,
      salt: manifest.encryption.salt,
      N: manifest.encryption.N,
      r: manifest.encryption.r,
      p: manifest.encryption.p,
    }
    : undefined;
  const payload = {
    schema: manifest.schema,
    id: manifest.id,
    createdAt: manifest.createdAt,
    complete: true,
    roots: manifest.roots,
    entries: manifest.entries,
    totalBytes: manifest.totalBytes,
    ...(encryption ? { encryption } : {}),
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function computeManifestMac(manifest: StateBackupManifest, key: Buffer): string {
  return createHmac("sha256", key).update(manifestMacPayload(manifest)).digest("hex");
}

function unlockManifest(manifest: StateBackupManifest, passphrase: string | undefined): BackupEncryptionKeys | undefined {
  if (!manifest.encryption) return undefined;
  if (!passphrase) throw new Error("Backup is encrypted; provide the backup passphrase");
  const salt = decodeBase64(manifest.encryption.salt, "Backup encryption salt", 16);
  const keys = deriveBackupKeys(passphrase, salt, {
    N: manifest.encryption.N,
    r: manifest.encryption.r,
    p: manifest.encryption.p,
  });
  const expected = Buffer.from(computeManifestMac(manifest, keys.manifestKey), "hex");
  const actual = Buffer.from(manifest.encryption.manifestMac, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    keys.encryptionKey.fill(0);
    keys.manifestKey.fill(0);
    throw new Error("Backup passphrase is incorrect or the encrypted manifest was modified");
  }
  return keys;
}

async function encryptFile(source: string, destination: string, key: Buffer): Promise<{ sha256: string; bytes: number; encryption: StateBackupEntryEncryption }> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const hash = createHash("sha256");
  let bytes = 0;
  const observe = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source),
    observe,
    cipher,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const stored = await stat(destination);
  return {
    sha256: hash.digest("hex"),
    bytes,
    encryption: {
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      storedBytes: stored.size,
    },
  };
}

async function removeFailedDecryptTarget(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await rm(path, { force: true });
  } catch (cleanupError) {
    process.stderr.write(`friday-backup: unable to remove failed decrypt target ${path}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
  }
}

async function decryptAndVerifyFile(
  source: string,
  entry: StateBackupEntry,
  key: Buffer,
  destination?: string,
): Promise<void> {
  if (!entry.encryption) throw new Error(`Encrypted backup entry lacks encryption metadata: ${entry.root}/${entry.path}`);
  const iv = decodeBase64(entry.encryption.iv, "Backup entry IV", 12);
  const authTag = decodeBase64(entry.encryption.authTag, "Backup entry authentication tag", 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const hash = createHash("sha256");
  let bytes = 0;
  const observe = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const sink = destination
    ? createWriteStream(destination, { flags: "wx", mode: 0o600 })
    : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    await pipeline(createReadStream(source), decipher, observe, sink);
  } catch (error) {
    await removeFailedDecryptTarget(destination);
    throw new Error(`Encrypted backup authentication failed: ${entry.root}/${entry.path}`, { cause: error });
  }
  if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) {
    await removeFailedDecryptTarget(destination);
    throw new Error(`Backup plaintext hash mismatch: ${entry.root}/${entry.path}`);
  }
}

async function copyTree(
  root: StateBackupRoot,
  destination: string,
  entries: StateBackupEntry[],
  encryption?: EncryptionContext,
): Promise<void> {
  if (!(await exists(root.source))) return;
  const sourceRootStat = await lstat(root.source);
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
    throw new Error(`State root must be a real directory: ${root.source}`);
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    const children = await readdir(sourceDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const sourcePath = join(sourceDirectory, child.name);
      const relativePath = portableRelative(relative(root.source, sourcePath));
      const destinationPath = join(destinationDirectory, child.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`State backup refuses symbolic links: ${sourcePath}`);
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: encryption ? 0o700 : info.mode & 0o777 });
        await visit(sourcePath, destinationPath);
        await chmod(destinationPath, encryption ? 0o700 : info.mode & 0o777);
        continue;
      }
      if (!info.isFile()) throw new Error(`State backup refuses non-regular files: ${sourcePath}`);
      if (encryption) {
        const encrypted = await encryptFile(sourcePath, destinationPath, encryption.encryptionKey);
        entries.push({
          root: root.kind,
          path: relativePath,
          bytes: encrypted.bytes,
          mode: info.mode & 0o777,
          sha256: encrypted.sha256,
          encryption: encrypted.encryption,
        });
      } else {
        await copyFile(sourcePath, destinationPath);
        await chmod(destinationPath, info.mode & 0o777);
        entries.push({
          root: root.kind,
          path: relativePath,
          bytes: info.size,
          mode: info.mode & 0o777,
          sha256: await sha256(destinationPath),
        });
      }
    }
  };
  await visit(root.source, destination);
}

async function acquireLock(backupRoot: string): Promise<() => Promise<void>> {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  const lock = join(backupRoot, ".backup.lock");
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner"), `${token}\n`, { mode: 0o600 });
      return async () => {
        const owner = await readFile(join(lock, "owner"), "utf8").catch((error: unknown) => {
          process.stderr.write(`friday-backup: unable to read lock owner during release: ${String(error)}\n`);
          return "";
        });
        if (owner.trim() === token) await rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lock)).mtimeMs;
      if (age > LOCK_STALE_MS) {
        process.stderr.write(`friday-backup: removing stale backup lock (${Math.round(age)}ms old)\n`);
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the state-backup lock");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

function validateBackupBoundary(backupRoot: string, roots: readonly StateBackupRoot[]): void {
  for (const root of roots) {
    if (inside(root.source, backupRoot) || inside(backupRoot, root.source)) {
      throw new Error(`Backup directory must not overlap FRIDAY state: backup=${backupRoot}; state=${root.source}`);
    }
  }
}

function backupPath(backupRoot: string, id: string): string {
  return join(backupRoot, safeBackupId(id));
}

function validScryptNumber(value: unknown, expected: number, label: string): number {
  if (value !== expected) throw new Error(`Backup ${label} is unsupported`);
  return expected;
}

async function parseManifest(path: string): Promise<StateBackupManifest> {
  const manifestPath = join(path, MANIFEST_NAME);
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) {
    throw new Error(`Backup manifest is invalid JSON: ${manifestPath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Backup manifest must be an object");
  const candidate = parsed as Record<string, unknown>;
  if ((candidate.schema !== BACKUP_SCHEMA_LEGACY && candidate.schema !== BACKUP_SCHEMA) || candidate.complete !== true) {
    throw new Error("Backup is incomplete or unsupported");
  }
  const schema = candidate.schema as typeof BACKUP_SCHEMA_LEGACY | typeof BACKUP_SCHEMA;
  const id = safeBackupId(String(candidate.id ?? ""));
  if (basename(path) !== id) throw new Error("Backup directory and manifest ids differ");
  if (typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))) {
    throw new Error("Backup createdAt is invalid");
  }
  if (!Array.isArray(candidate.roots) || !Array.isArray(candidate.entries)) throw new Error("Backup manifest lists are invalid");
  const roots = candidate.roots.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup root is invalid");
    const root = value as Record<string, unknown>;
    if (root.kind !== "home" && root.kind !== "state") throw new Error("Backup root kind is invalid");
    if (typeof root.source !== "string" || !isAbsolute(root.source)) throw new Error("Backup root source is invalid");
    return { kind: root.kind, source: resolve(root.source) } as StateBackupRoot;
  });
  const encryption = candidate.encryption === undefined ? undefined : (() => {
    if (schema !== BACKUP_SCHEMA || !candidate.encryption || typeof candidate.encryption !== "object" || Array.isArray(candidate.encryption)) {
      throw new Error("Backup encryption metadata is invalid");
    }
    const value = candidate.encryption as Record<string, unknown>;
    if (value.algorithm !== "aes-256-gcm" || value.kdf !== "scrypt") throw new Error("Backup encryption algorithm is unsupported");
    if (typeof value.salt !== "string") throw new Error("Backup encryption salt is invalid");
    decodeBase64(value.salt, "Backup encryption salt", 16);
    const N = validScryptNumber(value.N, SCRYPT_N, "scrypt N");
    const r = validScryptNumber(value.r, SCRYPT_R, "scrypt r");
    const p = validScryptNumber(value.p, SCRYPT_P, "scrypt p");
    if (typeof value.manifestMac !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestMac)) {
      throw new Error("Backup manifest authentication code is invalid");
    }
    return {
      algorithm: "aes-256-gcm" as const,
      kdf: "scrypt" as const,
      salt: value.salt,
      N,
      r,
      p,
      manifestMac: value.manifestMac,
    };
  })();
  const seen = new Set<string>();
  const entries = candidate.entries.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup entry is invalid");
    const entry = value as Record<string, unknown>;
    if (entry.root !== "home" && entry.root !== "state") throw new Error("Backup entry root is invalid");
    const safePath = portableRelative(String(entry.path ?? ""));
    const key = `${entry.root}:${safePath}`;
    if (seen.has(key)) throw new Error(`Duplicate backup entry: ${key}`);
    seen.add(key);
    if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0) throw new Error("Backup entry size is invalid");
    if (!Number.isSafeInteger(entry.mode) || (entry.mode as number) < 0 || (entry.mode as number) > 0o777) {
      throw new Error("Backup entry mode is invalid");
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Backup entry hash is invalid");
    let entryEncryption: StateBackupEntryEncryption | undefined;
    if (encryption) {
      if (!entry.encryption || typeof entry.encryption !== "object" || Array.isArray(entry.encryption)) {
        throw new Error("Encrypted backup entry metadata is missing");
      }
      const encrypted = entry.encryption as Record<string, unknown>;
      if (typeof encrypted.iv !== "string" || typeof encrypted.authTag !== "string") throw new Error("Encrypted backup entry metadata is invalid");
      decodeBase64(encrypted.iv, "Backup entry IV", 12);
      decodeBase64(encrypted.authTag, "Backup entry authentication tag", 16);
      if (!Number.isSafeInteger(encrypted.storedBytes) || (encrypted.storedBytes as number) < 0) {
        throw new Error("Encrypted backup stored size is invalid");
      }
      entryEncryption = {
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        storedBytes: encrypted.storedBytes as number,
      };
    } else if (entry.encryption !== undefined) {
      throw new Error("Unencrypted backup unexpectedly contains encryption metadata");
    }
    return {
      root: entry.root,
      path: safePath,
      bytes: entry.bytes as number,
      mode: entry.mode as number,
      sha256: entry.sha256,
      ...(entryEncryption ? { encryption: entryEncryption } : {}),
    } as StateBackupEntry;
  });
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (candidate.totalBytes !== totalBytes) throw new Error("Backup total size does not match its entries");
  return Object.freeze({
    schema,
    id,
    createdAt: new Date(candidate.createdAt).toISOString(),
    complete: true,
    roots: Object.freeze(roots),
    entries: Object.freeze(entries),
    totalBytes,
    ...(encryption ? { encryption: Object.freeze(encryption) } : {}),
  });
}

export async function listStateBackups(options: StateBackupOptions = {}): Promise<readonly StateBackupManifest[]> {
  const environment = options.environment ?? process.env;
  const root = resolve(options.backupRoot ?? getStateBackupRoot(environment));
  if (!(await exists(root))) return [];
  const manifests: StateBackupManifest[] = [];
  for (const child of await readdir(root, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name.startsWith(".")) continue;
    try {
      manifests.push(await parseManifest(join(root, child.name)));
    } catch (error) {
      process.stderr.write(`friday-backup: ignoring incomplete/corrupt backup ${child.name}: ${String(error)}\n`);
    }
  }
  return Object.freeze(manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
}

async function verifyStoredFiles(path: string, manifest: StateBackupManifest, key?: Buffer): Promise<void> {
  const expected = new Set(manifest.entries.map((entry) => `${entry.root}:${entry.path}`));
  for (const entry of manifest.entries) {
    const file = join(path, "data", entry.root, nativeRelative(entry.path));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup file metadata mismatch: ${entry.root}/${entry.path}`);
    if (manifest.encryption) {
      if (!key || !entry.encryption || info.size !== entry.encryption.storedBytes || (info.mode & 0o777) !== 0o600) {
        throw new Error(`Backup file metadata mismatch: ${entry.root}/${entry.path}`);
      }
      await decryptAndVerifyFile(file, entry, key);
    } else {
      if (info.size !== entry.bytes || (info.mode & 0o777) !== entry.mode) {
        throw new Error(`Backup file metadata mismatch: ${entry.root}/${entry.path}`);
      }
      if (await sha256(file) !== entry.sha256) throw new Error(`Backup hash mismatch: ${entry.root}/${entry.path}`);
    }
  }

  for (const root of manifest.roots) {
    const dataRoot = join(path, "data", root.kind);
    if (!(await exists(dataRoot))) continue;
    const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const childPath = join(directory, child.name);
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const info = await lstat(childPath);
        if (info.isSymbolicLink()) throw new Error(`Backup contains a symbolic link: ${childPath}`);
        if (info.isDirectory()) await visit(childPath, relativePath);
        else if (!info.isFile() || !expected.has(`${root.kind}:${portableRelative(relativePath)}`)) {
          throw new Error(`Backup contains an unmanifested file: ${root.kind}/${relativePath}`);
        }
      }
    };
    await visit(dataRoot);
  }
}

export async function verifyStateBackup(id: string, options: StateBackupOptions = {}): Promise<StateBackupManifest> {
  const environment = options.environment ?? process.env;
  const root = resolve(options.backupRoot ?? getStateBackupRoot(environment));
  const path = backupPath(root, id);
  const manifest = await parseManifest(path);
  const keys = unlockManifest(manifest, options.passphrase);
  try {
    await verifyStoredFiles(path, manifest, keys?.encryptionKey);
    return manifest;
  } finally {
    keys?.encryptionKey.fill(0);
    keys?.manifestKey.fill(0);
  }
}

export async function createStateBackup(options: StateBackupOptions = {}): Promise<StateBackupManifest> {
  const environment = options.environment ?? process.env;
  const releaseRuntime = await acquireStoppedRuntimeGuard({ environment });
  return await withRelease(releaseRuntime, () => createStateBackupWhileStopped(options, environment), "State backup");
}

async function createStateBackupWhileStopped(
  options: StateBackupOptions,
  environment: NodeJS.ProcessEnv,
): Promise<StateBackupManifest> {
  const roots = rootsFor(environment);
  const root = resolve(options.backupRoot ?? getStateBackupRoot(environment));
  validateBackupBoundary(root, roots);
  const release = await acquireLock(root);
  const encryption = options.passphrase === undefined ? undefined : createEncryptionContext(options.passphrase);
  try {
    const now = (options.now ?? (() => new Date()))();
    const id = generatedBackupId(now, (options.idFactory ?? randomUUID)());
    const finalPath = backupPath(root, id);
    const staging = join(root, `.${id}.staging`);
    if (await exists(finalPath) || await exists(staging)) throw new Error(`Backup already exists: ${id}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      const entries: StateBackupEntry[] = [];
      for (const stateRoot of roots) await copyTree(stateRoot, join(staging, "data", stateRoot.kind), entries, encryption);
      entries.sort((left, right) => left.root.localeCompare(right.root) || left.path.localeCompare(right.path));
      const base: StateBackupManifest = {
        schema: BACKUP_SCHEMA,
        id,
        createdAt: now.toISOString(),
        complete: true,
        roots,
        entries,
        totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        ...(encryption ? {
          encryption: {
            ...encryption.manifest,
            manifestMac: "0".repeat(64),
          },
        } : {}),
      };
      const manifest: StateBackupManifest = encryption
        ? {
          ...base,
          encryption: {
            ...base.encryption!,
            manifestMac: computeManifestMac(base, encryption.manifestKey),
          },
        }
        : base;
      await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await rename(staging, finalPath);

      const all = await listStateBackups({ ...options, passphrase: undefined, environment, backupRoot: root });
      const keep = retention(options.retain);
      for (const expired of all.slice(keep)) {
        const expiredPath = backupPath(root, expired.id);
        if (!inside(root, expiredPath) || expiredPath === root) throw new Error("Refusing unsafe backup retention target");
        await rm(expiredPath, { recursive: true, force: true });
      }
      return manifest;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch((cleanupError: unknown) => {
        process.stderr.write(`friday-backup: failed to remove incomplete staging directory: ${String(cleanupError)}\n`);
      });
      throw error;
    }
  } finally {
    encryption?.encryptionKey.fill(0);
    encryption?.manifestKey.fill(0);
    await release();
  }
}

async function materializeRoot(
  backupPathValue: string,
  root: StateBackupRoot,
  destination: string,
  manifest: StateBackupManifest,
  key?: Buffer,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  const source = join(backupPathValue, "data", root.kind);
  if (!(await exists(source))) return;
  const entryByPath = new Map(
    manifest.entries
      .filter((entry) => entry.root === root.kind)
      .map((entry) => [entry.path, entry] as const),
  );
  const visit = async (sourceDirectory: string, destinationDirectory: string, relativeDirectory = ""): Promise<void> => {
    for (const child of await readdir(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = join(sourceDirectory, child.name);
      const destinationPath = join(destinationDirectory, child.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`Backup contains a symbolic link: ${sourcePath}`);
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await chmod(destinationPath, 0o700);
        await visit(sourcePath, destinationPath, relativePath);
      } else if (info.isFile()) {
        const entry = entryByPath.get(relativePath);
        if (!entry) throw new Error(`Backup contains an unmanifested file: ${root.kind}/${relativePath}`);
        if (manifest.encryption) {
          if (!key) throw new Error("Backup decryption key is unavailable");
          await decryptAndVerifyFile(sourcePath, entry, key, destinationPath);
        } else {
          await copyFile(sourcePath, destinationPath);
        }
        await chmod(destinationPath, entry.mode);
      } else {
        throw new Error(`Backup contains a non-regular file: ${sourcePath}`);
      }
    }
  };
  await visit(source, destination);
}

export async function restoreStateBackup(id: string, options: StateRestoreOptions): Promise<StateRestoreResult> {
  if (options.confirm !== true) throw new Error("State restore requires explicit confirmation");
  const environment = options.environment ?? process.env;
  const releaseRuntime = await acquireStoppedRuntimeGuard({ environment });
  return await withRelease(releaseRuntime, () => restoreStateBackupWhileStopped(id, options, environment), "State restore");
}

async function restoreStateBackupWhileStopped(
  id: string,
  options: StateRestoreOptions,
  environment: NodeJS.ProcessEnv,
): Promise<StateRestoreResult> {
  const currentRoots = rootsFor(environment);
  const backupRoot = resolve(options.backupRoot ?? getStateBackupRoot(environment));
  validateBackupBoundary(backupRoot, currentRoots);
  const release = await acquireLock(backupRoot);
  const swaps: Array<{ root: StateBackupRoot; previous: string; staging: string; hadPrevious: boolean }> = [];
  let keys: BackupEncryptionKeys | undefined;
  try {
    const manifest = await verifyStateBackup(id, { ...options, environment, backupRoot });
    if (JSON.stringify(manifest.roots) !== JSON.stringify(currentRoots)) {
      throw new Error("Backup roots do not match the current FRIDAY_HOME/FRIDAY_STATE_DIR");
    }
    keys = unlockManifest(manifest, options.passphrase);
    const sourceBackup = backupPath(backupRoot, manifest.id);
    for (const root of currentRoots) {
      const staging = join(dirname(root.source), `.${basename(root.source)}.restore-${manifest.id}`);
      const previous = join(dirname(root.source), `.${basename(root.source)}.pre-restore-${manifest.id}`);
      if (await exists(staging) || await exists(previous)) throw new Error(`Restore staging path already exists for ${root.source}`);
      await materializeRoot(sourceBackup, root, staging, manifest, keys?.encryptionKey);
      const hadPrevious = await exists(root.source);
      if (hadPrevious) await rename(root.source, previous);
      try {
        await rename(staging, root.source);
      } catch (error) {
        if (hadPrevious) await rename(previous, root.source);
        throw error;
      }
      swaps.push({ root, previous, staging, hadPrevious });
    }
    return Object.freeze({
      manifest,
      previousRoots: Object.freeze(swaps.filter((swap) => swap.hadPrevious).map((swap) => ({
        kind: swap.root.kind,
        path: swap.previous,
      }))),
    });
  } catch (error) {
    for (const swap of [...swaps].reverse()) {
      try {
        await rename(swap.root.source, swap.staging);
        if (swap.hadPrevious) await rename(swap.previous, swap.root.source);
        await rm(swap.staging, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `State restore failed and rollback failed for ${swap.root.source}`);
      }
    }
    throw error;
  } finally {
    keys?.encryptionKey.fill(0);
    keys?.manifestKey.fill(0);
    await release();
  }
}
