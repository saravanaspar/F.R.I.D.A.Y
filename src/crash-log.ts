import { createHash } from "node:crypto";
import { constants, closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { redactSensitiveText } from "@friday/operational-errors";
import { join, resolve } from "node:path";

const MAX_MESSAGE = 4_096;
const MAX_CRASH_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CRASH_LOG_FILES = 4;
let installed = false;
let handlingFatal = false;

function fridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
}

function clean(value: unknown): string {
  const raw = String(value ?? "unknown failure")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
  return redactSensitiveText(raw || "unknown failure", MAX_MESSAGE);
}

function safeCrashPath(): string {
  const home = fridayHome();
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  const dir = lstatSync(logDir);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) {
    throw new Error(`Crash log directory is unsafe: ${logDir}`);
  }
  const path = join(logDir, "crashes.ndjson");
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error(`Crash log path is unsafe: ${path}`);
    }
  }
  return path;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function rotateCrashLog(path: string, incomingBytes: number): void {
  if (!existsSync(path) || statSync(path).size + incomingBytes <= MAX_CRASH_LOG_BYTES) return;
  rmSync(`${path}.${MAX_CRASH_LOG_FILES - 1}`, { force: true });
  for (let index = MAX_CRASH_LOG_FILES - 2; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
  syncDirectory(resolve(path, ".."));
}

function priorConsecutiveCount(path: string, fingerprint: string): number {
  if (!existsSync(path)) return 0;
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(-128).reverse();
    const latest = lines[0] ? JSON.parse(lines[0]) as { fingerprint?: unknown; consecutiveCount?: unknown } : undefined;
    if (latest?.fingerprint !== fingerprint) return 0;
    if (typeof latest.consecutiveCount === "number" && Number.isSafeInteger(latest.consecutiveCount) && latest.consecutiveCount >= 1) {
      return latest.consecutiveCount;
    }
    let contiguous = 0;
    for (const line of lines) {
      const record = JSON.parse(line) as { fingerprint?: unknown };
      if (record.fingerprint !== fingerprint) break;
      contiguous += 1;
    }
    return contiguous;
  } catch {
    return 0;
  }
}

export function recordFatalCrash(operation: string, error: unknown): void {
  try {
    const path = safeCrashPath();
    const candidate = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
    const operationName = clean(operation).slice(0, 256);
    const errorName = clean(error instanceof Error ? error.name : typeof error).slice(0, 128);
    const errorMessage = clean(error instanceof Error ? error.message : error);
    const errorCode = typeof candidate?.code === "string" || typeof candidate?.code === "number"
      ? clean(candidate.code).slice(0, 64)
      : undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([operationName, errorName, errorCode ?? "", errorMessage]))
      .digest("hex")
      .slice(0, 24);
    const consecutiveCount = priorConsecutiveCount(path, fingerprint) + 1;
    const record = {
      type: "friday.fatal-crash",
      at: new Date().toISOString(),
      pid: process.pid,
      operation: operationName,
      errorName,
      errorMessage,
      ...(errorCode === undefined ? {} : { errorCode }),
      fingerprint,
      consecutiveCount,
      restartStorm: consecutiveCount >= 5,
    };
    const encoded = `${JSON.stringify(record)}\n`;
    rotateCrashLog(path, Buffer.byteLength(encoded));
    const fd = openSync(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeSync(fd, encoded);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
  } catch (logError) {
    // This path is already fatal; if stderr itself fails there is no further process-local recovery.
    process.stderr.write(`friday: failed to persist crash record: ${clean(logError instanceof Error ? logError.message : logError)}\n`);
  }
}

export function installFatalCrashHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    recordFatalCrash(`uncaughtException:${origin}`, error);
  });
  process.on("unhandledRejection", (reason) => {
    if (handlingFatal) return;
    handlingFatal = true;
    recordFatalCrash("unhandledRejection", reason);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
}
