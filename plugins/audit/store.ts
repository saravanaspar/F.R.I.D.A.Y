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
import { createHmac, randomBytes as cryptoRandomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditActor,
  AuditActorKind,
  AuditActorRole,
  AuditCategory,
  AuditDetails,
  AuditOutcome,
  AuditQuery,
  AuditRecord,
  AuditRecordInput,
  AuditStatus,
  AuditVerification,
} from "./contract.js";

export const AUDIT_DATABASE_FILE_NAME = "audit.sqlite";
export const AUDIT_HMAC_KEY_FILE_NAME = "audit.hmac.key";
export const AUDIT_HEAD_FILE_NAME = "audit.head.json";
export const AUDIT_APPEND_LOCK_FILE_NAME = "audit.append.lock";
export const AUDIT_HMAC_KEY_BYTES = 32;
const DATABASE_SCHEMA_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const MAX_QUERY_LIMIT = 1_000;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_DETAILS = 24;
const MAX_DETAILS_JSON_LENGTH = 8_192;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DETAIL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key|client[-_]?secret)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi;
const ASSIGNMENT_VALUE = /\b(password|passwd|secret|token|api[-_]?key|client[-_]?secret)\s*[:=]\s*[^\s,;]+/gi;
const APPEND_LOCK_STALE_MS = 60_000;
const APPEND_LOCK_TIMEOUT_MS = 30_000;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export interface AuditDatabaseOptions {
  readonly stateDir: string;
  readonly workspaceRoot?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly randomBytes?: ((size: number) => Buffer) | undefined;
}

interface NormalizedAuditInput {
  readonly occurredAt: string;
  readonly category: AuditCategory;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly effect?: string | undefined;
  readonly resource?: string | undefined;
  readonly subject?: string | undefined;
  readonly network?: boolean | undefined;
  readonly mode?: string | undefined;
  readonly access?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly details: AuditDetails;
}

interface AuditHeadAnchor {
  readonly schema: 1;
  readonly sequence: number;
  readonly hash: string;
  readonly mac: string;
}

function privateMode(path: string, expectedType: "file" | "directory"): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Audit ${expectedType} must not be a symbolic link: ${path}`);
  if (expectedType === "file" && !stat.isFile()) throw new Error(`Audit path is not a file: ${path}`);
  if (expectedType === "directory" && !stat.isDirectory()) throw new Error(`Audit path is not a directory: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Audit ${expectedType} permissions are too broad: ${path}`);
}

function ensurePrivateDirectory(stateDir: string): string {
  const resolved = resolve(stateDir);
  if (existsSync(resolved)) privateMode(resolved, "directory");
  else mkdirSync(resolved, { recursive: true, mode: 0o700 });
  privateMode(resolved, "directory");
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

export function assertAuditOutsideWorkspace(stateDir: string, workspaceRoot: string): void {
  const audit = canonicalProspectivePath(stateDir);
  const workspace = canonicalProspectivePath(workspaceRoot);
  if (inside(workspace, audit) || inside(audit, workspace)) {
    throw new Error(`Audit state directory must not overlap the model workspace: audit=${audit}; workspace=${workspace}`);
  }
}

export function getAuditStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = environment.FRIDAY_HOME?.trim();
  const root = configuredHome
    ? isAbsolute(configuredHome)
      ? configuredHome
      : resolve(configuredHome)
    : join(homedir(), ".friday");
  return join(root, "audit");
}

export function getAuditDatabasePath(stateDir: string): string {
  return join(stateDir, AUDIT_DATABASE_FILE_NAME);
}

export function getAuditHmacKeyPath(stateDir: string): string {
  return join(stateDir, AUDIT_HMAC_KEY_FILE_NAME);
}

export function getAuditHeadPath(stateDir: string): string {
  return join(stateDir, AUDIT_HEAD_FILE_NAME);
}

function readFileNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readHmacKey(path: string): Buffer {
  privateMode(path, "file");
  if (lstatSync(path).size !== AUDIT_HMAC_KEY_BYTES) throw new Error("Audit HMAC key has an invalid length");
  const key = readFileNoFollow(path);
  if (key.byteLength !== AUDIT_HMAC_KEY_BYTES) {
    key.fill(0);
    throw new Error("Audit HMAC key has an invalid length");
  }
  return key;
}

function canonicalHead(sequence: number, hash: string): string {
  return JSON.stringify({ schema: 1, sequence, hash });
}

function headMac(key: Buffer, sequence: number, hash: string): string {
  return createHmac("sha256", key)
    .update("friday-audit-head-v1\n", "utf8")
    .update(canonicalHead(sequence, hash), "utf8")
    .digest("hex");
}

function parseHead(path: string, key: Buffer): AuditHeadAnchor {
  privateMode(path, "file");
  if (lstatSync(path).size > 4_096) throw new Error("Audit head anchor exceeds its size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("Audit head anchor is corrupt", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Audit head anchor must contain an object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schema !== 1) throw new Error("Audit head anchor has an unsupported schema");
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 0) {
    throw new Error("Audit head anchor sequence is invalid");
  }
  if (typeof candidate.hash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.hash)) {
    throw new Error("Audit head anchor hash is invalid");
  }
  if (typeof candidate.mac !== "string" || !/^[a-f0-9]{64}$/.test(candidate.mac)) {
    throw new Error("Audit head anchor MAC is invalid");
  }
  const expectedMac = headMac(key, candidate.sequence as number, candidate.hash);
  if (!hashMatches(expectedMac, candidate.mac)) throw new Error("Audit head anchor integrity verification failed");
  return {
    schema: 1,
    sequence: candidate.sequence as number,
    hash: candidate.hash,
    mac: candidate.mac,
  };
}

function writeHead(path: string, key: Buffer, sequence: number, hash: string): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Audit head sequence is invalid");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Audit head hash is invalid");
  const anchor: AuditHeadAnchor = {
    schema: 1,
    sequence,
    hash,
    mac: headMac(key, sequence, hash),
  };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(anchor)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    chmodSync(path, 0o600);
    privateMode(path, "file");
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function acquireAppendLock(path: string): () => void {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + APPEND_LOCK_TIMEOUT_MS;
  while (true) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, `${token}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      return () => {
        try {
          privateMode(path, "file");
          if (readFileNoFollow(path).toString("utf8").trim() === token) rmSync(path, { force: true });
        } catch (error) {
          process.stderr.write(`friday-audit: failed to release append lock: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = lstatSync(path);
      if (lock.isSymbolicLink() || !lock.isFile()) throw new Error(`Audit append lock is unsafe: ${path}`);
      if (Date.now() - lock.mtimeMs > APPEND_LOCK_STALE_MS) {
        process.stderr.write("friday-audit: removing a stale append lock\n");
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the audit append lock");
      Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
    }
  }
}

function loadOrCreateHmacKey(
  stateDir: string,
  allowCreate: boolean,
  randomBytes: (size: number) => Buffer,
): Buffer {
  const path = getAuditHmacKeyPath(stateDir);
  if (existsSync(path)) return readHmacKey(path);
  if (!allowCreate) throw new Error("Audit HMAC key is missing for an existing ledger");

  const key = randomBytes(AUDIT_HMAC_KEY_BYTES);
  if (!Buffer.isBuffer(key) || key.byteLength !== AUDIT_HMAC_KEY_BYTES) {
    key.fill?.(0);
    throw new Error("Audit random source returned an invalid HMAC key");
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
      return readHmacKey(path);
    }
  } finally {
    key.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

function normalizeControlText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function redactString(value: string, max = 1_024): string {
  return normalizeControlText(value, max)
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(ASSIGNMENT_VALUE, (_match, name: string) => `${name}=[REDACTED]`)
    .slice(0, max);
}

function stableId(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !STABLE_ID.test(normalized)) {
    throw new Error(`Invalid audit ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function optionalStableId(value: string | undefined, label: string, max = 256): string | undefined {
  return value === undefined ? undefined : stableId(value, label, max);
}

function parseCategory(value: unknown): AuditCategory {
  if (value === "authorization" || value === "identity") return value;
  throw new Error(`Unsupported audit category: ${JSON.stringify(value)}`);
}

function parseOutcome(value: unknown): AuditOutcome {
  if (value === "allowed" || value === "denied" || value === "error" || value === "changed") return value;
  throw new Error(`Unsupported audit outcome: ${JSON.stringify(value)}`);
}

function parseActorKind(value: unknown): AuditActorKind {
  if (value === "local" || value === "system" || value === "channel") return value;
  throw new Error(`Unsupported audit actor kind: ${JSON.stringify(value)}`);
}

function parseActorRole(value: unknown): AuditActorRole {
  if (value === "operator" || value === "read-only" || value === "untrusted") return value;
  throw new Error(`Unsupported audit actor role: ${JSON.stringify(value)}`);
}

function normalizeIso(value: string | undefined, now: Date): string {
  if (value === undefined) return now.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid audit timestamp: ${JSON.stringify(value)}`);
  return parsed.toISOString();
}

function normalizeDetails(details: Record<string, unknown> | undefined): AuditDetails {
  if (!details) return {};
  const entries = Object.entries(details);
  if (entries.length > MAX_DETAILS) throw new Error(`Audit details exceed the ${MAX_DETAILS}-field limit`);
  const output: AuditDetails = {};
  for (const [rawKey, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = rawKey.trim();
    if (!DETAIL_KEY.test(key)) throw new Error(`Invalid audit detail key: ${JSON.stringify(rawKey)}`);
    if (SECRET_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (rawValue === null || typeof rawValue === "boolean") output[key] = rawValue;
    else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) throw new Error(`Audit detail ${key} must be finite`);
      output[key] = rawValue;
    } else if (typeof rawValue === "string") output[key] = redactString(rawValue, 512);
    else throw new Error(`Audit detail ${key} must be a JSON primitive`);
  }
  if (JSON.stringify(output).length > MAX_DETAILS_JSON_LENGTH) throw new Error("Audit details exceed the size limit");
  return output;
}

function normalizeInput(input: AuditRecordInput, now: Date): NormalizedAuditInput {
  const actor: AuditActor = Object.freeze({
    id: stableId(input.actor.id, "actor id"),
    kind: parseActorKind(input.actor.kind),
    role: parseActorRole(input.actor.role),
  });
  const effect = optionalStableId(input.effect, "effect", 128);
  const mode = optionalStableId(input.mode, "mode", 64);
  const access = optionalStableId(input.access, "access", 64);
  const approvedBy = optionalStableId(input.approvedBy, "approvedBy", 64);
  const subject = input.subject === undefined ? undefined : redactString(input.subject, 512);
  const resource = input.resource === undefined ? undefined : redactString(input.resource, 1_024);
  return Object.freeze({
    occurredAt: normalizeIso(input.occurredAt, now),
    category: parseCategory(input.category),
    action: stableId(input.action, "action", 128),
    outcome: parseOutcome(input.outcome),
    actor,
    ...(effect === undefined ? {} : { effect }),
    ...(resource === undefined ? {} : { resource }),
    ...(subject === undefined ? {} : { subject }),
    ...(input.network === undefined ? {} : { network: input.network === true }),
    ...(mode === undefined ? {} : { mode }),
    ...(access === undefined ? {} : { access }),
    ...(approvedBy === undefined ? {} : { approvedBy }),
    details: normalizeDetails(input.details),
  });
}

function initializeSchema(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = typeof row?.user_version === "number" ? row.user_version : 0;
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Audit database schema ${version} is newer than supported ${DATABASE_SCHEMA_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_records (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      effect TEXT,
      resource TEXT,
      subject TEXT,
      network INTEGER,
      mode TEXT,
      access TEXT,
      approved_by TEXT,
      details_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS audit_records_action_idx ON audit_records(action, sequence DESC);
    CREATE INDEX IF NOT EXISTS audit_records_actor_idx ON audit_records(actor_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS audit_records_category_idx ON audit_records(category, sequence DESC);
    CREATE INDEX IF NOT EXISTS audit_records_outcome_idx ON audit_records(outcome, sequence DESC);
  `);
  db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function assertExistingSchema(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  if (row?.user_version !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`Audit database schema is invalid; expected ${DATABASE_SCHEMA_VERSION}`);
  }
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_records'").get() as
    | Record<string, unknown>
    | undefined;
  if (table?.name !== "audit_records") throw new Error("Audit database is missing its ledger table");
}

function configureDatabase(db: DatabaseSync, fresh: boolean): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  if (fresh) initializeSchema(db);
  else assertExistingSchema(db);
  const integrity = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (integrity?.quick_check !== "ok") throw new Error("Audit database integrity check failed");
  db.exec("PRAGMA journal_mode = WAL");
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`audit database column ${key} is invalid`);
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`audit database column ${key} is invalid`);
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`audit database column ${key} is invalid`);
  return value;
}

function rowOptionalBoolean(row: Record<string, unknown>, key: string): boolean | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (value !== 0 && value !== 1) throw new Error(`audit database column ${key} is invalid`);
  return value === 1;
}

function parseDetails(value: string): AuditDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("audit database details_json contains invalid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("audit database details_json must contain an object");
  }
  const details = parsed as Record<string, unknown>;
  for (const [key, entry] of Object.entries(details)) {
    if (!DETAIL_KEY.test(key)) throw new Error("audit database details_json contains an invalid key");
    if (!(entry === null || typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)))) {
      throw new Error("audit database details_json contains a non-primitive value");
    }
  }
  return details as AuditDetails;
}

function rowToRecord(row: Record<string, unknown>): AuditRecord {
  const sequence = rowInteger(row, "sequence");
  if (sequence < 1) throw new Error("audit database sequence is invalid");
  const occurredAt = normalizeIso(rowString(row, "occurred_at"), new Date(0));
  const actor: AuditActor = {
    id: stableId(rowString(row, "actor_id"), "actor id"),
    kind: parseActorKind(rowString(row, "actor_kind")),
    role: parseActorRole(rowString(row, "actor_role")),
  };
  const previousHash = rowString(row, "previous_hash");
  const recordHash = rowString(row, "record_hash");
  if (!/^[a-f0-9]{64}$/.test(previousHash) || !/^[a-f0-9]{64}$/.test(recordHash)) {
    throw new Error("audit database hash column is invalid");
  }
  return {
    sequence,
    id: stableId(rowString(row, "id"), "record id"),
    occurredAt,
    category: parseCategory(rowString(row, "category")),
    action: stableId(rowString(row, "action"), "action", 128),
    outcome: parseOutcome(rowString(row, "outcome")),
    actor,
    ...(rowOptionalString(row, "effect") === undefined ? {} : { effect: stableId(rowOptionalString(row, "effect")!, "effect", 128) }),
    ...(rowOptionalString(row, "resource") === undefined ? {} : { resource: rowOptionalString(row, "resource")! }),
    ...(rowOptionalString(row, "subject") === undefined ? {} : { subject: rowOptionalString(row, "subject")! }),
    ...(rowOptionalBoolean(row, "network") === undefined ? {} : { network: rowOptionalBoolean(row, "network")! }),
    ...(rowOptionalString(row, "mode") === undefined ? {} : { mode: stableId(rowOptionalString(row, "mode")!, "mode", 64) }),
    ...(rowOptionalString(row, "access") === undefined ? {} : { access: stableId(rowOptionalString(row, "access")!, "access", 64) }),
    ...(rowOptionalString(row, "approved_by") === undefined ? {} : { approvedBy: stableId(rowOptionalString(row, "approved_by")!, "approvedBy", 64) }),
    details: parseDetails(rowString(row, "details_json")),
    previousHash,
    recordHash,
  };
}

function canonicalRecord(record: Omit<AuditRecord, "recordHash">): string {
  return JSON.stringify({
    schema: 1,
    sequence: record.sequence,
    id: record.id,
    occurredAt: record.occurredAt,
    category: record.category,
    action: record.action,
    outcome: record.outcome,
    actor: {
      id: record.actor.id,
      kind: record.actor.kind,
      role: record.actor.role,
    },
    effect: record.effect ?? null,
    resource: record.resource ?? null,
    subject: record.subject ?? null,
    network: record.network ?? null,
    mode: record.mode ?? null,
    access: record.access ?? null,
    approvedBy: record.approvedBy ?? null,
    details: Object.fromEntries(Object.entries(record.details).sort(([left], [right]) => left.localeCompare(right))),
    previousHash: record.previousHash,
  });
}

function recordHmac(key: Buffer, record: Omit<AuditRecord, "recordHash">): string {
  return createHmac("sha256", key).update(canonicalRecord(record), "utf8").digest("hex");
}

function hashMatches(expectedHex: string, actualHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex) || !/^[a-f0-9]{64}$/.test(actualHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new Error("Audit query limit must be a positive integer");
  return Math.min(value, MAX_QUERY_LIMIT);
}

function sequenceBound(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Audit ${label} must be a non-negative safe integer`);
  return value;
}

export class AuditDatabase {
  readonly path: string;
  readonly #keyPath: string;
  readonly #headPath: string;
  readonly #appendLockPath: string;
  readonly #now: () => Date;
  readonly #workspaceRoot: string;
  #db: DatabaseSync;
  #key: Buffer;
  #closed = false;

  constructor(options: AuditDatabaseOptions) {
    const stateDir = resolve(options.stateDir);
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    assertAuditOutsideWorkspace(stateDir, workspaceRoot);
    this.#workspaceRoot = workspaceRoot;
    ensurePrivateDirectory(stateDir);
    this.path = getAuditDatabasePath(stateDir);
    this.#keyPath = getAuditHmacKeyPath(stateDir);
    this.#headPath = getAuditHeadPath(stateDir);
    this.#appendLockPath = join(stateDir, AUDIT_APPEND_LOCK_FILE_NAME);
    const databaseExisted = existsSync(this.path);
    const keyExisted = existsSync(this.#keyPath);
    const headExisted = existsSync(this.#headPath);
    if (databaseExisted && !keyExisted) throw new Error("Audit HMAC key is missing for an existing ledger");
    if (databaseExisted && !headExisted) throw new Error("Audit head anchor is missing for an existing ledger");
    if (!databaseExisted && (keyExisted || headExisted)) {
      throw new Error("Audit ledger is missing while integrity state still exists");
    }
    const existingPieces = Number(databaseExisted) + Number(keyExisted) + Number(headExisted);
    const fresh = existingPieces === 0;
    if (databaseExisted) privateMode(this.path, "file");
    if (headExisted) privateMode(this.#headPath, "file");
    this.#key = loadOrCreateHmacKey(stateDir, fresh, options.randomBytes ?? cryptoRandomBytes);
    this.#now = options.now ?? (() => new Date());
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      privateMode(this.path, "file");
      configureDatabase(this.#db, fresh);
      if (fresh) writeHead(this.#headPath, this.#key, 0, GENESIS_HASH);
      const records = this.#verifyRows(this.#allRows());
      this.#reconcileHead(records);
    } catch (error) {
      try {
        this.#db.close();
      } catch (closeError) {
        process.stderr.write(`friday-audit: database close failed during initialization: ${closeError instanceof Error ? closeError.name : typeof closeError}\n`);
      }
      this.#key.fill(0);
      if (fresh) {
        rmSync(this.path, { force: true });
        rmSync(`${this.path}-wal`, { force: true });
        rmSync(`${this.path}-shm`, { force: true });
        rmSync(this.#keyPath, { force: true });
        rmSync(this.#headPath, { force: true });
      }
      throw error;
    }
  }

  append(input: AuditRecordInput): AuditRecord {
    this.#assertOpen();
    const normalized = normalizeInput(input, this.#now());
    const release = acquireAppendLock(this.#appendLockPath);
    let transactionOpen = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const anchor = this.#verifiedTailAnchor(true);
      const tailRow = this.#db.prepare(`
        SELECT * FROM audit_records ORDER BY sequence DESC LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      const tail = tailRow ? rowToRecord(tailRow) : undefined;
      const sequence = (tail?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Audit sequence exhausted safe integer range");
      const previousHash = tail?.recordHash ?? GENESIS_HASH;
      const unsigned: Omit<AuditRecord, "recordHash"> = {
        sequence,
        id: randomUUID(),
        occurredAt: normalized.occurredAt,
        category: normalized.category,
        action: normalized.action,
        outcome: normalized.outcome,
        actor: normalized.actor,
        ...(normalized.effect === undefined ? {} : { effect: normalized.effect }),
        ...(normalized.resource === undefined ? {} : { resource: normalized.resource }),
        ...(normalized.subject === undefined ? {} : { subject: normalized.subject }),
        ...(normalized.network === undefined ? {} : { network: normalized.network }),
        ...(normalized.mode === undefined ? {} : { mode: normalized.mode }),
        ...(normalized.access === undefined ? {} : { access: normalized.access }),
        ...(normalized.approvedBy === undefined ? {} : { approvedBy: normalized.approvedBy }),
        details: normalized.details,
        previousHash,
      };
      const record: AuditRecord = { ...unsigned, recordHash: recordHmac(this.#key, unsigned) };
      this.#db.prepare(`
        INSERT INTO audit_records(
          sequence, id, occurred_at, category, action, outcome,
          actor_id, actor_kind, actor_role, effect, resource, subject, network,
          mode, access, approved_by, details_json, previous_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.sequence,
        record.id,
        record.occurredAt,
        record.category,
        record.action,
        record.outcome,
        record.actor.id,
        record.actor.kind,
        record.actor.role,
        record.effect ?? null,
        record.resource ?? null,
        record.subject ?? null,
        record.network === undefined ? null : record.network ? 1 : 0,
        record.mode ?? null,
        record.access ?? null,
        record.approvedBy ?? null,
        JSON.stringify(record.details),
        record.previousHash,
        record.recordHash,
      );
      this.#db.exec("COMMIT");
      transactionOpen = false;
      // The row is already HMAC-authenticated in memory. Updating the
      // authenticated anchor is O(1); startup and audit.verify retain the full
      // chain scan for historical-integrity checks.
      if (record.sequence !== anchor.sequence + 1 || !hashMatches(record.previousHash, anchor.hash)) {
        throw new Error("Audit append head changed unexpectedly during its transaction");
      }
      writeHead(this.#headPath, this.#key, record.sequence, record.recordHash);
      return record;
    } catch (error) {
      if (transactionOpen) {
        try {
          this.#db.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Audit append failed and its transaction rollback also failed");
        }
      }
      throw error;
    } finally {
      release();
    }
  }

  records(query: AuditQuery = {}): readonly AuditRecord[] {
    this.#assertOpen();
    const verified = this.#verifyRows(this.#allRows());
    this.#reconcileHead(verified);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    const after = sequenceBound(query.afterSequence, "afterSequence");
    const before = sequenceBound(query.beforeSequence, "beforeSequence");
    if (after !== undefined) {
      clauses.push("sequence > ?");
      params.push(after);
    }
    if (before !== undefined) {
      clauses.push("sequence < ?");
      params.push(before);
    }
    if (query.category !== undefined) {
      clauses.push("category = ?");
      params.push(parseCategory(query.category));
    }
    if (query.action !== undefined) {
      clauses.push("action = ?");
      params.push(stableId(query.action, "query action", 128));
    }
    if (query.outcome !== undefined) {
      clauses.push("outcome = ?");
      params.push(parseOutcome(query.outcome));
    }
    if (query.actorId !== undefined) {
      clauses.push("actor_id = ?");
      params.push(stableId(query.actorId, "query actor id"));
    }
    const order = query.order ?? "desc";
    if (order !== "asc" && order !== "desc") throw new Error("Audit query order must be asc or desc");
    params.push(boundedLimit(query.limit));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`
      SELECT * FROM audit_records
      ${where}
      ORDER BY sequence ${order === "asc" ? "ASC" : "DESC"}
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map((row) => rowToRecord(row));
  }

  verify(): AuditVerification {
    this.#assertOpen();
    const records = this.#verifyRows(this.#allRows());
    this.#reconcileHead(records);
    const head = records.at(-1);
    return {
      valid: true,
      recordCount: records.length,
      headSequence: head?.sequence ?? 0,
      headHash: head?.recordHash ?? GENESIS_HASH,
      verifiedAt: this.#now().toISOString(),
    };
  }

  status(): AuditStatus {
    this.#assertOpen();
    const release = acquireAppendLock(this.#appendLockPath);
    try {
      const head = this.#verifiedTailAnchor(true);
      return { recordCount: head.sequence, headSequence: head.sequence, headHash: head.hash };
    } finally {
      release();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } finally {
      this.#key.fill(0);
    }
  }

  #allRows(): Record<string, unknown>[] {
    return this.#db.prepare("SELECT * FROM audit_records ORDER BY sequence ASC").all() as Record<string, unknown>[];
  }

  #verifyRows(rows: readonly Record<string, unknown>[]): AuditRecord[] {
    const records: AuditRecord[] = [];
    let previousHash = GENESIS_HASH;
    let expectedSequence = 1;
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record.sequence !== expectedSequence) throw new Error(`Audit ledger sequence gap at ${expectedSequence}`);
      if (!hashMatches(previousHash, record.previousHash)) {
        throw new Error(`Audit ledger previous-hash mismatch at sequence ${record.sequence}`);
      }
      const { recordHash, ...unsigned } = record;
      const expectedHash = recordHmac(this.#key, unsigned);
      if (!hashMatches(expectedHash, recordHash)) {
        throw new Error(`Audit ledger integrity verification failed at sequence ${record.sequence}`);
      }
      records.push(record);
      previousHash = record.recordHash;
      expectedSequence += 1;
    }
    return records;
  }

  #verifiedTailAnchor(repairSingleCommittedRow: boolean): { sequence: number; hash: string } {
    let anchor = parseHead(this.#headPath, this.#key);
    const row = this.#db.prepare("SELECT * FROM audit_records ORDER BY sequence DESC LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      if (anchor.sequence !== 0 || !hashMatches(anchor.hash, GENESIS_HASH)) {
        throw new Error("Audit ledger was truncated behind its authenticated head anchor");
      }
      return { sequence: 0, hash: GENESIS_HASH };
    }
    const tail = rowToRecord(row);
    const { recordHash, ...unsigned } = tail;
    if (!hashMatches(recordHmac(this.#key, unsigned), recordHash)) {
      throw new Error(`Audit ledger integrity verification failed at sequence ${tail.sequence}`);
    }
    if (tail.sequence === anchor.sequence && hashMatches(tail.recordHash, anchor.hash)) {
      return { sequence: tail.sequence, hash: tail.recordHash };
    }
    if (
      repairSingleCommittedRow && tail.sequence === anchor.sequence + 1 &&
      hashMatches(tail.previousHash, anchor.hash)
    ) {
      // SQLite may commit immediately before a crash prevents the separate
      // anchor rename. Only that single authenticated row is fast-forwarded.
      writeHead(this.#headPath, this.#key, tail.sequence, tail.recordHash);
      anchor = parseHead(this.#headPath, this.#key);
      return { sequence: anchor.sequence, hash: anchor.hash };
    }
    if (tail.sequence < anchor.sequence) throw new Error("Audit ledger was truncated behind its authenticated head anchor");
    throw new Error("Audit ledger head does not match its authenticated anchor; run full verification");
  }

  #reconcileHead(records: readonly AuditRecord[]): void {
    const anchor = parseHead(this.#headPath, this.#key);
    const head = records.at(-1);
    const headSequence = head?.sequence ?? 0;
    const headHash = head?.recordHash ?? GENESIS_HASH;
    if (headSequence < anchor.sequence) {
      throw new Error("Audit ledger was truncated behind its authenticated head anchor");
    }
    if (anchor.sequence === 0) {
      if (!hashMatches(anchor.hash, GENESIS_HASH)) throw new Error("Audit genesis head anchor is invalid");
    } else {
      const anchored = records[anchor.sequence - 1];
      if (!anchored || !hashMatches(anchor.hash, anchored.recordHash)) {
        throw new Error("Audit ledger does not match its authenticated head anchor");
      }
    }
    if (headSequence === anchor.sequence) {
      if (!hashMatches(headHash, anchor.hash)) throw new Error("Audit ledger head hash does not match its anchor");
      return;
    }
    // The ledger can legitimately be ahead if the process crashed after SQLite
    // committed but before the separate anchor rename. A valid HMAC chain that
    // still contains the authenticated prior head is safe to fast-forward.
    writeHead(this.#headPath, this.#key, headSequence, headHash);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Audit database is closed");
    assertAuditOutsideWorkspace(dirname(this.path), this.#workspaceRoot);
    privateMode(dirname(this.path), "directory");
    privateMode(this.path, "file");
    privateMode(this.#keyPath, "file");
    privateMode(this.#headPath, "file");
  }
}
