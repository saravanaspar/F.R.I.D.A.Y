import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { RestartRecord } from "./types.js";

const RESTART_DIRECTORY = "restarts";
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_POLL_MS = 10;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isRestartRecord(value: unknown): value is RestartRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RestartRecord>;
  const successor = record.successor;
  return (
    record.version === 1 &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.tokenHash === "string" &&
    /^[a-f0-9]{64}$/.test(record.tokenHash) &&
    (record.phase === "launching" || record.phase === "ready" || record.phase === "quiesced" || record.phase === "accepted" || record.phase === "failed") &&
    !!record.predecessor &&
    isPositiveInteger(record.predecessor.pid) &&
    (successor === undefined || (!!successor && isPositiveInteger(successor.pid))) &&
    (record.handoffRequired === undefined || typeof record.handoffRequired === "boolean") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.message === undefined || typeof record.message === "string")
  );
}

function normalizedRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid lifecycle restart request id: ${JSON.stringify(requestId)}`);
  }
  return normalized;
}

export function restartDirectory(stateDir: string): string {
  return resolve(stateDir, RESTART_DIRECTORY);
}

export function restartStatusPath(stateDir: string, requestId: string): string {
  return join(restartDirectory(stateDir), `${normalizedRequestId(requestId)}.json`);
}

export function readRestartRecord(path: string): RestartRecord | undefined {
  return readRestartRecordUnlocked(path);
}

function readRestartRecordUnlocked(path: string): RestartRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid lifecycle restart state at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRestartRecord(value)) {
    throw new Error(`Invalid lifecycle restart state at ${path}: unsupported or malformed record`);
  }
  return {
    ...structuredClone(value),
    successor: value.successor ? { ...value.successor } : undefined,
    message: value.message ?? undefined,
  };
}

function writeRestartRecordUnlocked(path: string, record: RestartRecord): void {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

function parseLockOwner(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (
      Number.isInteger(value.pid)
      && (value.pid as number) > 0
      && typeof value.token === "string"
      && value.token.length > 0
      && typeof value.acquiredAt === "number"
      && Number.isFinite(value.acquiredAt)
    ) {
      return value as LockOwner;
    }
  } catch {
    // friday-expected-control-flow: a creator can briefly expose an empty lock file. It is stale only after
    // the bounded age check below, so another process cannot steal it early.
  }
  return undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withRestartLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      const owner: LockOwner = { pid: process.pid, token, acquiredAt: Date.now() };
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
      closeSync(descriptor);
      descriptor = undefined;
      break;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const owner = parseLockOwner(lockPath);
      const stale = owner
        ? Date.now() - owner.acquiredAt > LOCK_STALE_AFTER_MS && !processAlive(owner.pid)
        : Date.now() >= deadline;
      if (stale) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lifecycle restart state lock: ${lockPath}`);
      }
      Atomics.wait(lockWaitArray, 0, 0, LOCK_POLL_MS);
    }
  }

  try {
    return operation();
  } finally {
    const owner = parseLockOwner(lockPath);
    if (owner?.token === token) {
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function writeRestartRecord(path: string, record: RestartRecord): void {
  withRestartLock(path, () => writeRestartRecordUnlocked(path, record));
}

/** Atomically read, validate, and replace one restart record across processes. */
export function updateRestartRecord(
  path: string,
  update: (current: RestartRecord | undefined) => RestartRecord,
): RestartRecord {
  return withRestartLock(path, () => {
    const next = update(readRestartRecordUnlocked(path));
    if (!isRestartRecord(next)) throw new Error(`Refusing to write malformed lifecycle restart state at ${path}`);
    writeRestartRecordUnlocked(path, next);
    return structuredClone(next);
  });
}
