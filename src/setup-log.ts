import { appendFile, chmod, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { redactSensitiveText, reportOperationalError } from "@friday/operational-errors";

const MAX_SETUP_LOG_BYTES = 2 * 1024 * 1024;

function fridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

function setupLogPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(fridayHome(environment), "logs", "setup.ndjson");
}

async function ensurePrivateLog(path: string): Promise<void> {
  const root = join(fridayHome(), "logs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`FRIDAY logs directory is unsafe: ${root}`);
  if (process.platform !== "win32" && (rootInfo.mode & 0o077) !== 0) await chmod(root, 0o700);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`FRIDAY setup log is unsafe: ${path}`);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(path, 0o600);
    if (info.size > MAX_SETUP_LOG_BYTES) await writeFile(path, "", { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface SetupLogEvent {
  readonly component: string;
  readonly operation: string;
  readonly outcome: "started" | "success" | "failure";
  readonly message?: string | undefined;
  readonly durationMs?: number | undefined;
}

export async function appendSetupLog(event: SetupLogEvent): Promise<void> {
  const path = setupLogPath();
  await ensurePrivateLog(path);
  const record = {
    at: new Date().toISOString(),
    component: redactSensitiveText(event.component, 128),
    operation: redactSensitiveText(event.operation, 256),
    outcome: event.outcome,
    ...(event.message === undefined ? {} : { message: redactSensitiveText(event.message, 4_096) }),
    ...(event.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(event.durationMs)) }),
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  // Force metadata resolution so permission/path failures surface here rather
  // than being discovered only by diagnostics later.
  await stat(path);
}

export async function recordSetupLog(event: SetupLogEvent): Promise<void> {
  try {
    await appendSetupLog(event);
  } catch (error) {
    reportOperationalError({ component: "setup", operation: "append private setup diagnostic", error, severity: "warn", outcome: "degraded" });
  }
}
