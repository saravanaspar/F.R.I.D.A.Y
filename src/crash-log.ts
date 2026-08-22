import { constants, closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { redactSensitiveText } from "@friday/operational-errors";
import { join, resolve } from "node:path";

const MAX_MESSAGE = 4_096;
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

export function recordFatalCrash(operation: string, error: unknown): void {
  try {
    const path = safeCrashPath();
    const candidate = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
    const record = {
      type: "friday.fatal-crash",
      at: new Date().toISOString(),
      pid: process.pid,
      operation: clean(operation).slice(0, 256),
      errorName: clean(error instanceof Error ? error.name : typeof error).slice(0, 128),
      errorMessage: clean(error instanceof Error ? error.message : error),
      ...(typeof candidate?.code === "string" || typeof candidate?.code === "number"
        ? { errorCode: clean(candidate.code).slice(0, 64) }
        : {}),
    };
    const fd = openSync(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
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
