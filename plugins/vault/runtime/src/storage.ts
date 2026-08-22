import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeVaultKind, normalizeVaultRef } from "./ref.js";
import type { VaultSecretMetadata } from "./types.js";

export const VAULT_STATE_FILE_NAME = "vault.json";
export const VAULT_MASTER_KEY_FILE_NAME = "master.key";
export const VAULT_STATE_SCHEMA = 1 as const;
export const VAULT_MASTER_KEY_BYTES = 32;
export const VAULT_IV_BYTES = 12;
export const VAULT_TAG_BYTES = 16;
export const MAX_SECRET_BYTES = 256 * 1024;
const MAX_VAULT_STATE_BYTES = 32 * 1024 * 1024;

export interface StoredCiphertext {
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface StoredVaultRecord extends VaultSecretMetadata {
  readonly cipher: StoredCiphertext;
}

export interface VaultState {
  readonly schema: typeof VAULT_STATE_SCHEMA;
  readonly records: Record<string, StoredVaultRecord>;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function privateMode(path: string, expectedType: "file" | "directory"): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Vault ${expectedType} must not be a symbolic link: ${path}`);
  if (expectedType === "file" && !stat.isFile()) throw new Error(`Vault path is not a file: ${path}`);
  if (expectedType === "directory" && !stat.isDirectory()) throw new Error(`Vault path is not a directory: ${path}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Vault ${expectedType} permissions are too broad: ${path}`);
  }
}

export function ensurePrivateVaultDirectory(stateDir: string): string {
  const resolved = resolve(stateDir);
  if (existsSync(resolved)) {
    privateMode(resolved, "directory");
  } else {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    privateMode(resolved, "directory");
  }
  chmodSync(resolved, 0o700);
  return resolved;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalProspectivePath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const existing = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return resolve(existing, ...missing);
}

export function assertVaultOutsideWorkspace(stateDir: string, workspaceRoot: string): void {
  const vault = canonicalProspectivePath(stateDir);
  const workspace = canonicalProspectivePath(workspaceRoot);
  if (inside(workspace, vault) || inside(vault, workspace)) {
    throw new Error(
      `Vault state directory must not overlap the model workspace: vault=${vault}; workspace=${workspace}`,
    );
  }
}

export function createEmptyVaultState(): VaultState {
  return { schema: VAULT_STATE_SCHEMA, records: {} };
}

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Malformed vault state: ${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function decodeBase64(
  value: unknown,
  label: string,
  exactLength?: number,
  maxDecodedLength?: number,
): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`Malformed vault state: ${label} is not base64`);
  }
  if (exactLength !== undefined && value.length !== Math.ceil(exactLength / 3) * 4) {
    throw new Error(`Malformed vault state: ${label} has the wrong encoded length`);
  }
  if (maxDecodedLength !== undefined && value.length > Math.ceil(maxDecodedLength / 3) * 4) {
    throw new Error(`Malformed vault state: ${label} is too large`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error(`Malformed vault state: ${label} is not canonical base64`);
  }
  if (exactLength !== undefined && decoded.byteLength !== exactLength) {
    decoded.fill(0);
    throw new Error(`Malformed vault state: ${label} has the wrong length`);
  }
  return decoded;
}

function parseStoredRecord(key: string, value: unknown): StoredVaultRecord {
  const record = objectRecord(value);
  if (!record) throw new Error(`Malformed vault record: ${key}`);
  const ref = normalizeVaultRef(typeof record.ref === "string" ? record.ref : "");
  const kind = normalizeVaultKind(typeof record.kind === "string" ? record.kind : "");
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) {
    throw new Error(`Malformed vault record version: ${ref}`);
  }
  const createdAt = parseIsoTimestamp(record.createdAt, `${ref}.createdAt`);
  const updatedAt = parseIsoTimestamp(record.updatedAt, `${ref}.updatedAt`);
  const cipher = objectRecord(record.cipher);
  if (!cipher || cipher.algorithm !== "aes-256-gcm") {
    throw new Error(`Malformed vault cipher metadata: ${ref}`);
  }
  const iv = decodeBase64(cipher.iv, `${ref}.iv`, VAULT_IV_BYTES);
  const tag = decodeBase64(cipher.tag, `${ref}.tag`, VAULT_TAG_BYTES);
  const ciphertext = decodeBase64(cipher.ciphertext, `${ref}.ciphertext`, undefined, MAX_SECRET_BYTES);
  try {
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_SECRET_BYTES) {
      throw new Error(`Malformed vault ciphertext length: ${ref}`);
    }
  } finally {
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
  }
  const expectedKey = recordKey(ref);
  if (key !== expectedKey) throw new Error(`Malformed vault record key for ${ref}`);
  return {
    ref,
    kind,
    version: record.version as number,
    createdAt,
    updatedAt,
    cipher: {
      algorithm: "aes-256-gcm",
      iv: cipher.iv as string,
      tag: cipher.tag as string,
      ciphertext: cipher.ciphertext as string,
    },
  };
}

export function loadVaultState(stateDir: string): VaultState {
  const directory = resolve(stateDir);
  if (!existsSync(directory)) return createEmptyVaultState();
  privateMode(directory, "directory");
  const path = join(directory, VAULT_STATE_FILE_NAME);
  if (!existsSync(path)) return createEmptyVaultState();
  privateMode(path, "file");
  if (lstatSync(path).size > MAX_VAULT_STATE_BYTES) {
    throw new Error("Vault state file exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse vault state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectRecord(parsed);
  if (!root || root.schema !== VAULT_STATE_SCHEMA) throw new Error("Unsupported or malformed vault state schema");
  const rawRecords = objectRecord(root.records);
  if (!rawRecords) throw new Error("Malformed vault state: records must be an object");
  const records: Record<string, StoredVaultRecord> = {};
  for (const [key, raw] of Object.entries(rawRecords)) records[key] = parseStoredRecord(key, raw);
  return { schema: VAULT_STATE_SCHEMA, records };
}

export function saveVaultState(stateDir: string, state: VaultState): string {
  const directory = ensurePrivateVaultDirectory(stateDir);
  const path = join(directory, VAULT_STATE_FILE_NAME);
  if (existsSync(path)) privateMode(path, "file");
  const tempPath = join(directory, `.${VAULT_STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const payload = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (payload.byteLength > MAX_VAULT_STATE_BYTES) {
    payload.fill(0);
    throw new Error("Vault state exceeds the size limit");
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    privateMode(path, "file");
  } finally {
    payload.fill(0);
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
  return path;
}

export function loadMasterKey(stateDir: string): Buffer {
  const directory = resolve(stateDir);
  if (!existsSync(directory)) throw new Error("Vault master key is missing");
  privateMode(directory, "directory");
  const path = join(directory, VAULT_MASTER_KEY_FILE_NAME);
  if (!existsSync(path)) throw new Error("Vault master key is missing");
  return readMasterKey(path);
}

export function loadOrCreateMasterKey(
  stateDir: string,
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): Buffer {
  const directory = ensurePrivateVaultDirectory(stateDir);
  const path = join(directory, VAULT_MASTER_KEY_FILE_NAME);
  if (existsSync(path)) return readMasterKey(path);

  const key = randomBytes(VAULT_MASTER_KEY_BYTES);
  if (!Buffer.isBuffer(key) || key.byteLength !== VAULT_MASTER_KEY_BYTES) {
    key.fill?.(0);
    throw new Error("Vault random source returned an invalid master key");
  }
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, key);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      chmodSync(path, 0o600);
      privateMode(path, "file");
      return Buffer.from(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return readMasterKey(path);
    }
  } finally {
    key.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomically install a validated master key. This is intentionally kept out of
 * the package's public exports; VaultStore exposes only encrypted recovery kits.
 */
export function installMasterKey(stateDir: string, candidate: Uint8Array, replaceExisting = false): void {
  if (candidate.byteLength !== VAULT_MASTER_KEY_BYTES) {
    throw new Error("Vault recovery key has an invalid length");
  }
  const directory = ensurePrivateVaultDirectory(stateDir);
  const path = join(directory, VAULT_MASTER_KEY_FILE_NAME);
  if (existsSync(path)) {
    privateMode(path, "file");
    if (!replaceExisting) throw new Error("Vault master key already exists; explicit replacement is required");
  }
  const tempPath = join(directory, `.${VAULT_MASTER_KEY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const key = Buffer.from(candidate);
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, key);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
    privateMode(path, "file");
  } finally {
    key.fill(0);
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

function readMasterKey(path: string): Buffer {
  privateMode(path, "file");
  if (lstatSync(path).size !== VAULT_MASTER_KEY_BYTES) {
    throw new Error("Vault master key has an invalid length");
  }
  const key = readFileNoFollow(path);
  if (key.byteLength !== VAULT_MASTER_KEY_BYTES) {
    key.fill(0);
    throw new Error("Vault master key has an invalid length");
  }
  return key;
}

function readFileNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordKey(ref: string): string {
  const normalized = normalizeVaultRef(ref);
  return Buffer.from(normalized, "utf8").toString("base64url");
}
