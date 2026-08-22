import { createHash, randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { requireExecutionAccess } from "./execution-access.js";
import { readRestartRecord, restartStatusPath, updateRestartRecord } from "./state.js";
import type {
  AcknowledgeRestartOptions,
  CurrentProcessLaunchSpec,
  LaunchReplacementOptions,
  LifecycleManagerOptions,
  LifecycleProcessSnapshot,
  RestartRecord,
  RejectRestartOptions,
  WaitForReleaseOptions,
  WaitForTakeoverOptions,
} from "./types.js";

export const RESTART_STATUS_PATH_ENV = "FRIDAY_LIFECYCLE_RESTART_STATUS";
export const RESTART_REQUEST_ID_ENV = "FRIDAY_LIFECYCLE_RESTART_REQUEST";
export const RESTART_TOKEN_ENV = "FRIDAY_LIFECYCLE_RESTART_TOKEN";

const DEFAULT_RESTART_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_KILL_WAIT_MS = 2_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function normalizedText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function processSnapshot(): LifecycleProcessSnapshot {
  return {
    pid: process.pid,
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    argv: [...process.argv],
    env: { ...process.env },
    cwd: process.cwd(),
  };
}

function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2048);
}

function markFailed(path: string, message: string, now: () => string): void {
  updateRestartRecord(path, (current) => {
    if (!current) throw new Error(`Lifecycle restart state disappeared: ${path}`);
    if (current.phase === "ready" || current.phase === "quiesced" || current.phase === "accepted") return current;
    return {
      ...current,
      phase: "failed",
      updatedAt: now(),
      message: message.slice(0, 2048),
    };
  });
}

function markTakeoverFailed(path: string, message: string, now: () => string): RestartRecord | undefined {
  return updateRestartRecord(path, (current) => {
    if (!current) throw new Error(`Lifecycle restart state disappeared: ${path}`);
    if (current.phase === "accepted" || current.phase === "failed") return current;
    return {
      ...current,
      phase: "failed",
      updatedAt: now(),
      message: message.slice(0, 2048),
    };
  });
}

export function createCurrentProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  entrypoint = process.argv[1],
  execArgs: readonly string[] = process.execArgv,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (environment.TSX_TSCONFIG_PATH !== undefined || !entrypoint || !execArgs.some((arg) => arg.includes("tsx"))) {
    return environment;
  }
  let directory = dirname(resolve(entrypoint));
  while (true) {
    const tsconfigPath = join(directory, "tsconfig.json");
    if (existsSync(tsconfigPath) && existsSync(join(directory, "node_modules", "tsx", "package.json"))) {
      environment.TSX_TSCONFIG_PATH = tsconfigPath;
      return environment;
    }
    const parent = dirname(directory);
    if (parent === directory) return environment;
    directory = parent;
  }
}

export function createCurrentProcessLaunchSpec(
  args: readonly string[],
  executable = process.execPath,
  execArgs: readonly string[] = process.execArgv,
  entrypoint = process.argv[1],
): CurrentProcessLaunchSpec {
  if (process.env.FRIDAY_SINGLE_BINARY === "1") {
    return { command: executable, args: [...args] };
  }
  if (!entrypoint) {
    throw new Error("Cannot determine current FRIDAY entrypoint for restart");
  }
  const resolvedEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
  return {
    command: executable,
    args: [...execArgs, resolvedEntrypoint, ...args],
  };
}

export class LifecycleManager {
  readonly #stateDir: string;
  readonly #now: () => string;
  readonly #requestIdFactory: () => string;
  readonly #tokenFactory: () => string;
  readonly #process: LifecycleProcessSnapshot;
  readonly #pollIntervalMs: number;
  #launching = false;

  constructor(options: LifecycleManagerOptions) {
    this.#stateDir = normalizedText(options.stateDir, "Lifecycle state directory");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    this.#process = options.process ?? processSnapshot();
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) {
      throw new Error("Lifecycle poll interval must be positive");
    }
  }

  readRestart(requestId: string): RestartRecord | undefined {
    return readRestartRecord(restartStatusPath(this.#stateDir, requestId));
  }

  async launchReplacement(options: LaunchReplacementOptions = {}): Promise<RestartRecord> {
    if (this.#launching) {
      throw new Error("A lifecycle replacement launch is already in progress");
    }
    this.#launching = true;
    let ownedStatusPath: string | undefined;
    try {
      options.signal?.throwIfAborted();
      const timeoutMs = options.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Lifecycle restart timeout must be positive");
      }

      const requestId = normalizedText(this.#requestIdFactory(), "Lifecycle restart request id");
      const token = normalizedText(this.#tokenFactory(), "Lifecycle restart token");
      const statusPath = restartStatusPath(this.#stateDir, requestId);

      const createdAt = this.#now();
      const launching: RestartRecord = {
        version: 1,
        requestId,
        tokenHash: hashToken(token),
        phase: "launching",
        predecessor: { pid: this.#process.pid },
        successor: undefined,
        handoffRequired: true,
        createdAt,
        updatedAt: createdAt,
        message: undefined,
      };
      updateRestartRecord(statusPath, (current) => {
        if (current) throw new Error(`Lifecycle restart request already exists: ${requestId}`);
        return launching;
      });
      ownedStatusPath = statusPath;

      const args = options.args ?? this.#process.argv.slice(2);
      let launch: CurrentProcessLaunchSpec;
      if (options.executable !== undefined) {
        const requested = resolve(normalizedText(options.executable, "Lifecycle replacement executable"));
        const info = lstatSync(requested);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Lifecycle replacement executable must be a regular file: ${requested}`);
        launch = { command: realpathSync(requested), args: [...args] };
      } else {
        launch = createCurrentProcessLaunchSpec(
          args,
          this.#process.execPath,
          this.#process.execArgv,
          this.#process.argv[1],
        );
      }
      const preparedEnvironment = createCurrentProcessEnvironment(
        this.#process.env,
        this.#process.argv[1],
        this.#process.execArgv,
      );
      const environment = mergeEnvironment(preparedEnvironment, options.env);
      environment[RESTART_STATUS_PATH_ENV] = statusPath;
      environment[RESTART_REQUEST_ID_ENV] = requestId;
      environment[RESTART_TOKEN_ENV] = token;
      if (options.executable !== undefined) environment.FRIDAY_LIFECYCLE_EXPLICIT_EXECUTABLE = "1";

      let successorPid: number;
      try {
        const child = await requireExecutionAccess().launchDetachedProcess(launch.command, launch.args, {
          cwd: options.cwd ?? this.#process.cwd,
          env: environment,
        });
        successorPid = child.pid;
      } catch (error) {
        markFailed(statusPath, `Replacement launch failed: ${safeFailureMessage(error)}`, this.#now);
        throw error;
      }

      const afterSpawn = updateRestartRecord(statusPath, (current) => {
        if (!current) throw new Error(`Lifecycle restart state disappeared: ${requestId}`);
        if (current.phase === "ready" || current.phase === "quiesced" || current.phase === "accepted") {
          if (current.successor?.pid !== successorPid) {
            throw new Error(`Lifecycle restart ${requestId} was acknowledged by an unexpected process`);
          }
          return current;
        }
        if (current.phase !== "launching") {
          throw new Error(`Lifecycle restart ${requestId} entered ${current.phase} during launch`);
        }
        if (current.successor && current.successor.pid !== successorPid) {
          throw new Error(`Lifecycle restart ${requestId} recorded an unexpected successor process`);
        }
        return {
          ...current,
          successor: { pid: successorPid },
          updatedAt: this.#now(),
        };
      });
      if (afterSpawn.phase === "ready" || afterSpawn.phase === "quiesced" || afterSpawn.phase === "accepted") {
        return afterSpawn;
      }

      const deadline = Date.now() + timeoutMs;
      while (true) {
        options.signal?.throwIfAborted();
        const current = readRestartRecord(statusPath);
        if (!current) throw new Error(`Lifecycle restart state disappeared: ${requestId}`);
        if (current.phase === "ready" || current.phase === "quiesced" || current.phase === "accepted") {
          if (current.successor?.pid !== successorPid) {
            throw new Error(`Lifecycle restart ${requestId} was acknowledged by an unexpected process`);
          }
          return current;
        }
        if (current.phase === "failed") {
          throw new Error(current.message ?? `Lifecycle restart ${requestId} failed`);
        }
        if (!requireExecutionAccess().isProcessAlive(successorPid)) {
          const message = `Replacement process ${successorPid} exited before readiness acknowledgement`;
          markFailed(statusPath, message, this.#now);
          throw new Error(message);
        }
        if (Date.now() >= deadline) {
          const message = `Timed out waiting for replacement process ${successorPid} readiness`;
          markFailed(statusPath, message, this.#now);
          throw new Error(message);
        }
        await delay(this.#pollIntervalMs);
      }
    } catch (error) {
      if (ownedStatusPath) {
        try {
          markFailed(ownedStatusPath, `Replacement launch interrupted: ${safeFailureMessage(error)}`, this.#now);
        } catch (statusError) {
          reportOperationalError({ component: "lifecycle", operation: "persist replacement launch failure", error: statusError });
        }
      }
      throw error;
    } finally {
      this.#launching = false;
    }
  }

  async waitForTakeover(requestId: string, options: WaitForTakeoverOptions = {}): Promise<RestartRecord> {
    options.signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Lifecycle takeover timeout must be positive");
    }
    const statusPath = restartStatusPath(this.#stateDir, requestId);
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        options.signal?.throwIfAborted();
        const current = readRestartRecord(statusPath);
        if (!current) throw new Error(`Lifecycle restart state disappeared: ${requestId}`);
        if (current.phase === "accepted") return current;
        if (current.phase === "failed") {
          throw new Error(current.message ?? `Lifecycle restart ${requestId} takeover failed`);
        }
        const successorPid = current.successor?.pid;
        if (successorPid && !requireExecutionAccess().isProcessAlive(successorPid)) {
          const message = `Replacement process ${successorPid} exited before takeover acknowledgement`;
          markTakeoverFailed(statusPath, message, this.#now);
          throw new Error(message);
        }
        if (Date.now() >= deadline) {
          const message = `Timed out waiting for replacement ${requestId} takeover acknowledgement`;
          markTakeoverFailed(statusPath, message, this.#now);
          throw new Error(message);
        }
        await delay(this.#pollIntervalMs);
      }
    } catch (error) {
      try {
        const current = readRestartRecord(statusPath);
        if (current && current.phase !== "accepted" && current.phase !== "failed") {
          markTakeoverFailed(statusPath, `Replacement takeover interrupted: ${safeFailureMessage(error)}`, this.#now);
        }
      } catch (statusError) {
        reportOperationalError({ component: "lifecycle", operation: "persist replacement takeover failure", error: statusError });
      }
      throw error;
    }
  }

  /**
   * Publish that predecessor-owned listeners and workers are stopped. A new
   * successor may activate those resources only after this durable transition.
   */
  releaseForTakeover(requestId: string): RestartRecord {
    const normalizedRequestId = normalizedText(requestId, "Lifecycle restart request id");
    const statusPath = restartStatusPath(this.#stateDir, normalizedRequestId);
    return updateRestartRecord(statusPath, (current) => {
      if (!current) throw new Error(`Lifecycle restart state disappeared: ${normalizedRequestId}`);
      if (current.predecessor.pid !== this.#process.pid) {
        throw new Error(`Lifecycle restart ${normalizedRequestId} is not owned by this predecessor`);
      }
      if (current.phase === "failed") {
        throw new Error(current.message ?? `Lifecycle restart ${normalizedRequestId} has failed`);
      }
      if (current.phase === "accepted" || current.phase === "quiesced") return current;
      if (current.phase !== "ready") {
        throw new Error(`Lifecycle restart ${normalizedRequestId} cannot be released from phase ${current.phase}`);
      }
      return {
        ...current,
        phase: "quiesced",
        updatedAt: this.#now(),
        message: undefined,
      };
    });
  }

  /** Retire a launched successor when the predecessor cannot complete handoff. */
  async retireReplacement(requestId: string, reason = "Replacement handoff was cancelled"): Promise<RestartRecord> {
    const statusPath = restartStatusPath(this.#stateDir, normalizedText(requestId, "Lifecycle restart request id"));
    const reasonText = normalizedText(reason, "Lifecycle retirement reason").slice(0, 2048);
    const failed = updateRestartRecord(statusPath, (current) => {
      if (!current) throw new Error(`Lifecycle restart state disappeared: ${requestId}`);
      if (current.predecessor.pid !== this.#process.pid) {
        throw new Error(`Lifecycle restart ${requestId} is not owned by this predecessor`);
      }
      if (current.phase === "failed") return current;
      return {
        ...current,
        phase: "failed",
        updatedAt: this.#now(),
        message: reasonText,
      };
    });
    const successorPid = failed.successor?.pid;
    if (successorPid === this.#process.pid) {
      throw new Error(`Lifecycle restart ${requestId} has an invalid successor identity`);
    }
    const execution = requireExecutionAccess();
    if (successorPid !== undefined && execution.isProcessAlive(successorPid)) {
      if (!execution.terminateProcess) throw new Error("Lifecycle execution access cannot terminate a replacement process");
      await execution.terminateProcess(successorPid);
      if (execution.signalProcess) {
        const gracefulDeadline = Date.now() + TERMINATION_GRACE_MS;
        while (execution.isProcessAlive(successorPid) && Date.now() < gracefulDeadline) {
          await delay(DEFAULT_POLL_INTERVAL_MS);
        }
        if (execution.isProcessAlive(successorPid)) {
          await execution.signalProcess(successorPid, "SIGKILL");
          const killDeadline = Date.now() + TERMINATION_KILL_WAIT_MS;
          while (execution.isProcessAlive(successorPid) && Date.now() < killDeadline) {
            await delay(DEFAULT_POLL_INTERVAL_MS);
          }
          if (execution.isProcessAlive(successorPid)) {
            throw new Error(`Replacement process ${successorPid} remained alive after SIGTERM and SIGKILL`);
          }
        }
      }
    }
    return failed;
  }
}

export function createLifecycleManager(options: LifecycleManagerOptions): LifecycleManager {
  return new LifecycleManager(options);
}

interface RestartEnvironmentContext {
  statusPath: string;
  record: RestartRecord;
  pid: number;
  now: () => string;
}

function assertEnvironmentRecord(context: RestartEnvironmentContext, current: RestartRecord | undefined): RestartRecord {
  if (!current) throw new Error(`Lifecycle restart state disappeared: ${context.record.requestId}`);
  if (current.requestId !== context.record.requestId || current.tokenHash !== context.record.tokenHash) {
    throw new Error(`Lifecycle restart identity changed during handoff: ${context.record.requestId}`);
  }
  if (current.successor && current.successor.pid !== context.pid) {
    throw new Error(`Lifecycle restart ${current.requestId} expected successor ${current.successor.pid}, got ${context.pid}`);
  }
  return current;
}

function restartEnvironmentContext(options: AcknowledgeRestartOptions = {}): RestartEnvironmentContext | undefined {
  const environment = options.env ?? process.env;
  const statusPath = environment[RESTART_STATUS_PATH_ENV];
  const requestId = environment[RESTART_REQUEST_ID_ENV];
  const token = environment[RESTART_TOKEN_ENV];
  const supplied = [statusPath, requestId, token].filter((value) => value !== undefined).length;
  if (supplied === 0) return undefined;
  if (supplied !== 3 || !statusPath || !requestId || !token) {
    throw new Error("Incomplete lifecycle restart environment");
  }

  const record = readRestartRecord(statusPath);
  if (!record) throw new Error(`Lifecycle restart state not found: ${statusPath}`);
  if (record.requestId !== requestId) {
    throw new Error(`Lifecycle restart request mismatch: expected ${record.requestId}, got ${requestId}`);
  }
  if (record.tokenHash !== hashToken(token)) {
    throw new Error(`Lifecycle restart token mismatch for ${requestId}`);
  }
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Lifecycle successor pid must be positive");
  if (record.successor && record.successor.pid !== pid) {
    throw new Error(`Lifecycle restart ${requestId} expected successor ${record.successor.pid}, got ${pid}`);
  }
  return { statusPath, record, pid, now: options.now ?? (() => new Date().toISOString()) };
}

export function acknowledgeRestartFromEnvironment(
  options: AcknowledgeRestartOptions = {},
): RestartRecord | undefined {
  const context = restartEnvironmentContext(options);
  if (!context) return undefined;
  const { statusPath, pid, now } = context;
  return updateRestartRecord(statusPath, (value) => {
    const record = assertEnvironmentRecord(context, value);
    if (record.phase === "failed") {
      throw new Error(record.message ?? `Lifecycle restart ${record.requestId} has already failed`);
    }
    if (record.phase === "ready" || record.phase === "quiesced" || record.phase === "accepted") return record;
    if (record.phase !== "launching") {
      throw new Error(`Lifecycle restart ${record.requestId} cannot acknowledge readiness from phase ${record.phase}`);
    }
    return {
      ...record,
      phase: "ready",
      successor: { pid },
      updatedAt: now(),
      message: undefined,
    };
  });
}

export async function waitForTakeoverReleaseFromEnvironment(
  options: AcknowledgeRestartOptions & WaitForReleaseOptions = {},
): Promise<RestartRecord | undefined> {
  const context = restartEnvironmentContext(options);
  if (!context) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Lifecycle release timeout must be positive");
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    options.signal?.throwIfAborted();
    const record = assertEnvironmentRecord(context, readRestartRecord(context.statusPath));
    if (record.phase === "quiesced" || record.phase === "accepted") return structuredClone(record);
    if (!record.handoffRequired && record.phase === "ready") return structuredClone(record);
    if (record.phase === "failed") {
      throw new Error(record.message ?? `Lifecycle restart ${record.requestId} handoff failed`);
    }
    if (!requireExecutionAccess().isProcessAlive(record.predecessor.pid)) {
      const message = `Predecessor process ${record.predecessor.pid} exited before releasing takeover`;
      markTakeoverFailed(context.statusPath, message, context.now);
      throw new Error(message);
    }
    if (Date.now() >= deadline) {
      const message = `Timed out waiting for predecessor ${record.predecessor.pid} to release takeover`;
      markTakeoverFailed(context.statusPath, message, context.now);
      throw new Error(message);
    }
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
}

export function acknowledgeTakeoverFromEnvironment(
  options: AcknowledgeRestartOptions = {},
): RestartRecord | undefined {
  const context = restartEnvironmentContext(options);
  if (!context) return undefined;
  const { statusPath, pid, now } = context;
  return updateRestartRecord(statusPath, (value) => {
    const record = assertEnvironmentRecord(context, value);
    if (record.phase === "failed") {
      throw new Error(record.message ?? `Lifecycle restart ${record.requestId} has already failed`);
    }
    if (record.phase === "accepted") return record;
    const expected = record.handoffRequired ? "quiesced" : "ready";
    if (record.phase !== expected) {
      throw new Error(`Lifecycle restart ${record.requestId} cannot accept takeover from phase ${record.phase}; expected ${expected}`);
    }
    return {
      ...record,
      phase: "accepted",
      successor: { pid },
      updatedAt: now(),
      message: undefined,
    };
  });
}

export function rejectTakeoverFromEnvironment(options: RejectRestartOptions): RestartRecord | undefined {
  const context = restartEnvironmentContext(options);
  if (!context) return undefined;
  const { statusPath, now } = context;
  const record = assertEnvironmentRecord(context, readRestartRecord(statusPath));
  if (record.phase === "accepted") {
    throw new Error(`Lifecycle restart ${record.requestId} takeover is already accepted`);
  }
  if (record.phase === "failed") return structuredClone(record);
  if (record.phase !== "ready" && record.phase !== "quiesced") {
    throw new Error(`Lifecycle restart ${record.requestId} cannot reject takeover from phase ${record.phase}`);
  }
  const failed = markTakeoverFailed(statusPath, `Replacement takeover rejected: ${safeFailureMessage(options.error)}`, now);
  return failed ? structuredClone(failed) : undefined;
}

export function isRestartPredecessorAliveFromEnvironment(
  options: AcknowledgeRestartOptions = {},
): boolean | undefined {
  const context = restartEnvironmentContext(options);
  if (!context) return undefined;
  return requireExecutionAccess().isProcessAlive(context.record.predecessor.pid);
}
