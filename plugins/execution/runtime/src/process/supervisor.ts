import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { reportOperationalError } from "@friday/operational-errors";
import { getShellConfig, killProcessTree } from "./shell.js";
import { waitForChildProcess } from "./child-process.js";

const DEFAULT_MAX_PROCESSES_PER_RUN = 4;
const DEFAULT_MAX_PROCESSES_GLOBAL = 16;
const DEFAULT_MAX_LIFETIME_MS = 60 * 60_000;
const DEFAULT_LOG_BYTES = 1024 * 1024;
const DEFAULT_JANITOR_INTERVAL_MS = 60_000;
const STOP_GRACE_MS = 3_000;
const FORCE_STOP_WAIT_MS = 5_000;

export type ManagedProcessOwnerKind = "main-agent" | "subagent";

export interface ManagedProcessOwner {
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerKind: ManagedProcessOwnerKind;
}

export type ManagedProcessState = "running" | "exited" | "stopped" | "failed";

export interface ManagedProcessSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly command: string;
  readonly cwd: string;
  readonly state: ManagedProcessState;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: NodeJS.Signals | null | undefined;
  readonly totalOutputBytes: number;
  readonly logsTruncated: boolean;
}

export interface ManagedProcessStartRequest {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly launch?: {
    readonly command: string;
    readonly args: readonly string[];
  } | undefined;
  readonly maxLifetimeMs?: number | undefined;
  readonly cleanup?: (() => void | Promise<void>) | undefined;
}

export interface ManagedProcessSupervisorOptions {
  readonly maxProcessesPerRun?: number | undefined;
  readonly maxProcessesGlobal?: number | undefined;
  readonly maxLifetimeMs?: number | undefined;
  readonly maxLogBytes?: number | undefined;
  readonly janitorIntervalMs?: number | undefined;
  readonly shellPath?: string | undefined;
  readonly now?: (() => number) | undefined;
}

type ManagedRecord = {
  readonly owner: ManagedProcessOwner;
  readonly request: ManagedProcessStartRequest;
  readonly child: ChildProcess;
  state: ManagedProcessState;
  startedAtMs: number;
  completedAtMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logChunks: Buffer[];
  logBytes: number;
  totalOutputBytes: number;
  logsTruncated: boolean;
  lifetimeTimer?: NodeJS.Timeout;
  completion: Promise<void>;
  cleanupComplete: boolean;
  cleanupPromise?: Promise<void>;
  stopRequested: boolean;
  cleanupError?: unknown;
};

function boundedPositiveInteger(value: number | undefined, fallback: number, label: string, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function validateId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(id)) throw new Error("managed process id is invalid");
  return id;
}

export class ManagedProcessSupervisor {
  readonly #context = new AsyncLocalStorage<ManagedProcessOwner>();
  readonly #processes = new Map<string, ManagedRecord>();
  readonly #activeRuns = new Set<string>();
  readonly #options: Required<Omit<ManagedProcessSupervisorOptions, "shellPath">> & { shellPath?: string };
  readonly #janitor: NodeJS.Timeout;
  #closed = false;

  constructor(options: ManagedProcessSupervisorOptions = {}) {
    this.#options = {
      maxProcessesPerRun: boundedPositiveInteger(options.maxProcessesPerRun, DEFAULT_MAX_PROCESSES_PER_RUN, "maxProcessesPerRun", 64),
      maxProcessesGlobal: boundedPositiveInteger(options.maxProcessesGlobal, DEFAULT_MAX_PROCESSES_GLOBAL, "maxProcessesGlobal", 1024),
      maxLifetimeMs: boundedPositiveInteger(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS, "maxLifetimeMs", 24 * 60 * 60_000),
      maxLogBytes: boundedPositiveInteger(options.maxLogBytes, DEFAULT_LOG_BYTES, "maxLogBytes", 64 * 1024 * 1024),
      janitorIntervalMs: boundedPositiveInteger(options.janitorIntervalMs, DEFAULT_JANITOR_INTERVAL_MS, "janitorIntervalMs", 60 * 60_000),
      now: options.now ?? Date.now,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    };
    this.#janitor = setInterval(() => {
      void this.cleanupOrphans().catch((error: unknown) => {
        reportOperationalError({ component: "execution.process-supervisor", operation: "periodic orphan cleanup", error, severity: "warn" });
      });
    }, this.#options.janitorIntervalMs);
    this.#janitor.unref?.();
  }

  currentOwner(): ManagedProcessOwner | undefined {
    return this.#context.getStore();
  }

  async withRun<T>(owner: ManagedProcessOwner, operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("managed process supervisor is closed");
    if (!owner.sessionId.trim() || !owner.runId.trim()) throw new Error("managed process owner is incomplete");
    if (this.#activeRuns.has(owner.runId)) throw new Error(`agent run is already active: ${owner.runId}`);
    this.#activeRuns.add(owner.runId);
    let primary: unknown;
    try {
      return await this.#context.run(Object.freeze({ ...owner }), operation);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      this.#activeRuns.delete(owner.runId);
      try {
        await this.closeRun(owner.runId);
      } catch (cleanupError) {
        if (primary !== undefined) {
          throw new AggregateError([
            primary instanceof Error ? primary : new Error(String(primary)),
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          ], `Agent run ${owner.runId} failed and managed process cleanup also failed`);
        }
        throw cleanupError;
      }
    }
  }

  async start(request: ManagedProcessStartRequest): Promise<ManagedProcessSnapshot> {
    if (this.#closed) throw new Error("managed process supervisor is closed");
    const owner = this.#context.getStore();
    if (!owner) throw new Error("Background processes require an active agent run");
    if (owner.ownerKind !== "main-agent") {
      throw new Error("Persistent background processes are only available to the top-level FRIDAY agent");
    }
    const id = validateId(request.id);
    if (this.#processes.has(id)) throw new Error(`managed process id already exists: ${id}`);
    const runningGlobal = [...this.#processes.values()].filter((record) => record.state === "running").length;
    if (runningGlobal >= this.#options.maxProcessesGlobal) throw new Error("FRIDAY managed process global limit reached");
    const runningForRun = [...this.#processes.values()].filter((record) => record.state === "running" && record.owner.runId === owner.runId).length;
    if (runningForRun >= this.#options.maxProcessesPerRun) throw new Error("FRIDAY managed process per-run limit reached");
    const command = request.command.trim();
    if (!command) throw new Error("managed process command is required");

    const requestedLifetime = request.maxLifetimeMs ?? this.#options.maxLifetimeMs;
    if (!Number.isSafeInteger(requestedLifetime) || requestedLifetime < 1) {
      throw new Error("managed process maxLifetimeMs must be a positive integer");
    }
    const lifetime = Math.min(requestedLifetime, this.#options.maxLifetimeMs);

    const shellConfig = request.launch === undefined ? getShellConfig(this.#options.shellPath) : undefined;
    const launchCommand = request.launch?.command.trim() || shellConfig?.shell;
    if (!launchCommand) throw new Error("managed process launch command is required");
    const launchArgs = request.launch === undefined ? [...shellConfig!.args, command] : [...request.launch.args];
    const child = spawn(launchCommand, launchArgs, {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      env: request.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const startedAtMs = this.#options.now();
    const record: ManagedRecord = {
      owner: Object.freeze({ ...owner }),
      request: { ...request, id, command },
      child,
      state: "running",
      startedAtMs,
      logChunks: [],
      logBytes: 0,
      totalOutputBytes: 0,
      logsTruncated: false,
      completion: Promise.resolve(),
      cleanupComplete: false,
      stopRequested: false,
    };
    const appendLog = (data: Buffer): void => {
      record.totalOutputBytes += data.length;
      let chunk = Buffer.from(data);
      if (chunk.length >= this.#options.maxLogBytes) {
        chunk = chunk.subarray(chunk.length - this.#options.maxLogBytes);
        record.logChunks = [chunk];
        record.logBytes = chunk.length;
        record.logsTruncated = true;
        return;
      }
      record.logChunks.push(chunk);
      record.logBytes += chunk.length;
      while (record.logBytes > this.#options.maxLogBytes && record.logChunks.length > 0) {
        const first = record.logChunks[0]!;
        const overflow = record.logBytes - this.#options.maxLogBytes;
        if (first.length <= overflow) {
          record.logChunks.shift();
          record.logBytes -= first.length;
        } else {
          record.logChunks[0] = first.subarray(overflow);
          record.logBytes -= overflow;
        }
        record.logsTruncated = true;
      }
    };
    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);
    record.lifetimeTimer = setTimeout(() => {
      void this.#terminate(record).catch((error: unknown) => {
        reportOperationalError({ component: "execution.process-supervisor", operation: `stop expired process ${id}`, error, severity: "warn" });
      });
    }, lifetime);
    record.lifetimeTimer.unref?.();

    record.completion = waitForChildProcess(child)
      .then(async (code) => {
        if (record.state === "running") record.state = record.stopRequested ? "stopped" : (code === 0 ? "exited" : "failed");
        record.exitCode = code;
        record.signal = child.signalCode;
        record.completedAtMs = this.#options.now();
        if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);
        try {
          await this.#cleanup(record);
        } catch (cleanupError) {
          record.cleanupError = cleanupError;
          reportOperationalError({ component: "execution.process-supervisor", operation: `cleanup process ${id}`, error: cleanupError, severity: "warn" });
        }
      })
      .catch(async (error: unknown) => {
        record.state = "failed";
        record.completedAtMs = this.#options.now();
        if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);
        try {
          await this.#cleanup(record);
        } catch (cleanupError) {
          record.cleanupError = cleanupError;
          reportOperationalError({ component: "execution.process-supervisor", operation: `cleanup failed process ${id}`, error: cleanupError, severity: "warn" });
        }
        reportOperationalError({ component: "execution.process-supervisor", operation: `wait for process ${id}`, error, severity: "warn" });
      });
    this.#processes.set(id, record);
    return this.#snapshot(record);
  }

  list(): readonly ManagedProcessSnapshot[] {
    const owner = this.#requireOwner();
    return Object.freeze([...this.#processes.values()]
      .filter((record) => record.owner.runId === owner.runId)
      .map((record) => this.#snapshot(record)));
  }

  get(id: string): ManagedProcessSnapshot | undefined {
    const owner = this.#requireOwner();
    const record = this.#processes.get(validateId(id));
    return record?.owner.runId === owner.runId ? this.#snapshot(record) : undefined;
  }

  logs(id: string): { readonly text: string; readonly truncated: boolean; readonly totalBytes: number } {
    const owner = this.#requireOwner();
    const record = this.#processes.get(validateId(id));
    if (!record || record.owner.runId !== owner.runId) throw new Error(`Unknown managed process: ${id}`);
    return Object.freeze({
      text: Buffer.concat(record.logChunks, record.logBytes).toString("utf8"),
      truncated: record.logsTruncated,
      totalBytes: record.totalOutputBytes,
    });
  }

  async stop(id: string, _reason = "stopped"): Promise<ManagedProcessSnapshot> {
    const owner = this.#requireOwner();
    const record = this.#processes.get(validateId(id));
    if (!record || record.owner.runId !== owner.runId) throw new Error(`Unknown managed process: ${id}`);
    await this.#terminate(record);
    return this.#snapshot(record);
  }

  async closeRun(runId: string): Promise<void> {
    const runRecords = [...this.#processes.values()].filter((record) => record.owner.runId === runId);
    const running = runRecords.filter((record) => record.state === "running");
    const results = await Promise.allSettled(running.map((record) => this.#terminate(record)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    const cleanupResults = await Promise.allSettled(runRecords.map((record) => this.#cleanup(record)));
    errors.push(...cleanupResults.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason));
    for (const [id, record] of this.#processes) {
      if (record.owner.runId === runId && record.state !== "running" && record.cleanupComplete) this.#processes.delete(id);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Failed to clean up ${errors.length} managed processes for run ${runId}`);
  }

  async cleanupOrphans(): Promise<void> {
    const orphans = [...this.#processes.values()].filter((record) => !this.#activeRuns.has(record.owner.runId));
    const results = await Promise.allSettled(orphans.map((record) => record.state === "running" ? this.#terminate(record) : this.#cleanup(record)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    for (const [id, record] of this.#processes) {
      if (!this.#activeRuns.has(record.owner.runId) && record.state !== "running" && record.cleanupComplete) this.#processes.delete(id);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Failed to clean up ${errors.length} orphaned managed processes`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#janitor);
    const records = [...this.#processes.values()];
    const running = records.filter((record) => record.state === "running");
    const results = await Promise.allSettled(running.map((record) => this.#terminate(record)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    const cleanupResults = await Promise.allSettled(records.map((record) => this.#cleanup(record)));
    errors.push(...cleanupResults.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason));
    this.#processes.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Managed process supervisor shutdown was incomplete");
  }

  async #cleanup(record: ManagedRecord): Promise<void> {
    if (record.cleanupComplete) return;
    if (!record.cleanupPromise) {
      record.cleanupPromise = Promise.resolve().then(async () => {
        await record.request.cleanup?.();
        record.cleanupComplete = true;
        record.cleanupError = undefined;
      });
    }
    try {
      await record.cleanupPromise;
    } catch (error) {
      record.cleanupError = error;
      throw error;
    } finally {
      if (!record.cleanupComplete) record.cleanupPromise = undefined;
    }
  }

  #requireOwner(): ManagedProcessOwner {
    const owner = this.#context.getStore();
    if (!owner) throw new Error("Managed process operations require an active agent run");
    return owner;
  }

  #snapshot(record: ManagedRecord): ManagedProcessSnapshot {
    return Object.freeze({
      id: record.request.id,
      sessionId: record.owner.sessionId,
      runId: record.owner.runId,
      command: record.request.command,
      cwd: record.request.cwd,
      state: record.state,
      startedAt: new Date(record.startedAtMs).toISOString(),
      ...(record.completedAtMs === undefined ? {} : { completedAt: new Date(record.completedAtMs).toISOString() }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      totalOutputBytes: record.totalOutputBytes,
      logsTruncated: record.logsTruncated,
    });
  }

  async #terminate(record: ManagedRecord): Promise<void> {
    if (record.state !== "running") return;
    record.stopRequested = true;
    if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer);
    const child = record.child;
    if (child.pid) {
      if (process.platform === "win32") {
        killProcessTree(child.pid);
      } else {
        try { process.kill(-child.pid, "SIGTERM"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_GRACE_MS);
          timer.unref?.();
          if (child.exitCode !== null || child.signalCode !== null) {
            clearTimeout(timer);
            resolve();
          } else {
            child.once("exit", () => { clearTimeout(timer); resolve(); });
          }
        });
        if (child.exitCode === null && child.signalCode === null && child.pid) killProcessTree(child.pid);
      }
    }
    try {
      await this.#cleanup(record);
    } catch (cleanupError) {
      record.cleanupError = cleanupError;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        record.completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Managed process ${record.request.id} did not terminate after forced cleanup`)), FORCE_STOP_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (record.cleanupError !== undefined) throw record.cleanupError;
  }
}
