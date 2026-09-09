import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import {
  normalizeEmbedding,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderState,
} from "./embedding.js";

export const BGE_SMALL_EN_V15_INT8_PROVIDER_ID = "bge-small-en-v1.5-int8-cls-v1";
export const BGE_SMALL_EN_V15_DIMENSIONS = 384;
export const BGE_SMALL_EN_V15_MODEL_ID = "Xenova/bge-small-en-v1.5";
export const BGE_SMALL_EN_V15_MODEL_REVISION = "6e950025f83197b4bfed34e654cb236fc6634398";
export const BGE_SMALL_EN_V15_MODEL_SHA256 = "bf64d05457cb391fa88d045faf5927a15ea36d96228ddf23ea970087afdc1197";
export const BGE_SMALL_EN_V15_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
export const MEMORY_BGE_PROFILE_SCHEMA = 1;

const MAX_BATCH = 8;
const MAX_TEXT_LENGTH = 64_000;
const REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MEMORY_BGE_IDLE_TIMEOUT_MS = 90_000;
const MIN_MEMORY_BGE_IDLE_TIMEOUT_MS = 10;
const MAX_MEMORY_BGE_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;

interface BgeToolingProfile {
  readonly schema: number;
  readonly providerId: string;
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly modelSha256: string;
  readonly runtime: string;
}

interface BgeResponse {
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly vectors?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly count: number;
  readonly resolve: (vectors: readonly Float32Array[]) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export interface BgeInt8EmbeddingProviderOptions {
  readonly toolingRoot?: string | undefined;
  /** Stop the warm ONNX worker after this much inactivity. Defaults to 90 seconds. */
  readonly idleTimeoutMs?: number | undefined;
}

export function resolveMemoryBgeIdleTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = environment.FRIDAY_MEMORY_EMBEDDING_IDLE_MS?.trim();
  if (!configured || !/^\d+$/.test(configured)) return DEFAULT_MEMORY_BGE_IDLE_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_MEMORY_BGE_IDLE_TIMEOUT_MS;
  return Math.min(MAX_MEMORY_BGE_IDLE_TIMEOUT_MS, Math.max(1_000, parsed));
}

function normalizedIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) return resolveMemoryBgeIdleTimeoutMs();
  if (!Number.isSafeInteger(value) || value < MIN_MEMORY_BGE_IDLE_TIMEOUT_MS || value > MAX_MEMORY_BGE_IDLE_TIMEOUT_MS) {
    throw new Error(`BGE idle timeout must be an integer between ${MIN_MEMORY_BGE_IDLE_TIMEOUT_MS} and ${MAX_MEMORY_BGE_IDLE_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function defaultFridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

export function memoryEmbeddingToolingRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.FRIDAY_MEMORY_EMBEDDING_TOOLING_ROOT?.trim();
  return resolve(override || join(defaultFridayHome(environment), "tooling", "memory"));
}

function privatePython(root: string): string {
  return process.platform === "win32"
    ? join(root, "venv", "Scripts", "python.exe")
    : join(root, "venv", "bin", "python");
}

function modelRoot(root: string): string {
  return join(root, "models", "Xenova", "bge-small-en-v1.5");
}

function readProfile(root: string): BgeToolingProfile | undefined {
  const path = join(root, "profile.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BgeToolingProfile>;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as BgeToolingProfile;
  } catch {
    return undefined;
  }
}

function validateVector(raw: unknown): Float32Array {
  if (!Array.isArray(raw) || raw.length !== BGE_SMALL_EN_V15_DIMENSIONS) {
    throw new Error(`BGE embedding worker returned an invalid ${BGE_SMALL_EN_V15_DIMENSIONS}-dimension vector`);
  }
  const vector = new Float32Array(BGE_SMALL_EN_V15_DIMENSIONS);
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("BGE embedding worker returned a non-finite vector value");
    }
    vector[index] = value;
  }
  return normalizeEmbedding(vector);
}

function workerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"] as const;
  const output: NodeJS.ProcessEnv = {
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
  };
  for (const key of allowed) {
    const value = environment[key];
    if (value !== undefined) output[key] = value;
  }
  const threads = environment.FRIDAY_MEMORY_EMBEDDING_THREADS?.trim();
  if (threads && /^\d{1,2}$/.test(threads)) output.FRIDAY_MEMORY_EMBEDDING_THREADS = threads;
  return output;
}

/**
 * Local BGE-small-en-v1.5 INT8 ONNX provider.
 *
 * The neural runtime lives in a private Python environment provisioned by
 * `friday setup memory`. Normal recall is offline-only and keeps one warm
 * ONNX Runtime process for low-latency repeated queries. Missing tooling never
 * falls back to another embedding space; callers can degrade to lexical search.
 */
export class BgeSmallEnV15Int8EmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = BGE_SMALL_EN_V15_INT8_PROVIDER_ID;
  readonly dimensions = BGE_SMALL_EN_V15_DIMENSIONS;
  readonly #root: string;
  readonly #idleTimeoutMs: number;
  #child: ChildProcessWithoutNullStreams | undefined;
  #lines: ReadLineInterface | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #stderrTail = "";

  constructor(options: BgeInt8EmbeddingProviderOptions = {}) {
    this.#root = resolve(options.toolingRoot ?? memoryEmbeddingToolingRoot());
    this.#idleTimeoutMs = normalizedIdleTimeoutMs(options.idleTimeoutMs);
  }

  status(): MemoryEmbeddingProviderState {
    if (this.#child && this.#child.exitCode === null && !this.#child.killed) {
      return Object.freeze({ ready: true, active: true });
    }
    const python = privatePython(this.#root);
    const worker = join(this.#root, "bge_worker.py");
    const model = join(modelRoot(this.#root), "onnx", "model_int8.onnx");
    const tokenizer = join(modelRoot(this.#root), "tokenizer.json");
    if (!existsSync(python) || !existsSync(worker) || !existsSync(model) || !existsSync(tokenizer)) {
      return Object.freeze({
        ready: false,
        active: false,
        reason: "BGE INT8 Memory tooling is not provisioned; run `friday setup memory`",
      });
    }
    const profile = readProfile(this.#root);
    if (
      !profile
      || profile.schema !== MEMORY_BGE_PROFILE_SCHEMA
      || profile.providerId !== this.id
      || profile.dimensions !== this.dimensions
      || profile.modelId !== BGE_SMALL_EN_V15_MODEL_ID
      || profile.modelRevision !== BGE_SMALL_EN_V15_MODEL_REVISION
      || profile.modelSha256 !== BGE_SMALL_EN_V15_MODEL_SHA256
    ) {
      return Object.freeze({
        ready: false,
        active: false,
        reason: "BGE INT8 Memory tooling profile is missing or stale; rerun `friday setup memory`",
      });
    }
    return Object.freeze({ ready: true, active: false });
  }

  dispose(): void {
    this.#stopWorker(new Error("BGE embedding provider was disposed"));
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.#request("document", [text]);
    if (!vector) throw new Error("BGE embedding worker returned no document vector");
    return vector;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.#request("query", [text]);
    if (!vector) throw new Error("BGE embedding worker returned no query vector");
    return vector;
  }

  async embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) return Object.freeze([]);
    const output: Float32Array[] = [];
    for (let index = 0; index < texts.length; index += MAX_BATCH) {
      output.push(...await this.#request("document", texts.slice(index, index + MAX_BATCH)));
    }
    return Object.freeze(output);
  }

  async #request(kind: "query" | "document", texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length < 1 || texts.length > MAX_BATCH) {
      throw new Error(`BGE embedding batch must contain between 1 and ${MAX_BATCH} texts`);
    }
    for (const text of texts) {
      if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
        throw new Error(`BGE embedding text exceeds ${MAX_TEXT_LENGTH} characters`);
      }
    }
    this.#clearIdleTimer();
    const state = this.status();
    if (!state.ready) throw new Error(state.reason ?? "BGE INT8 Memory tooling is unavailable");
    const child = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise<readonly Float32Array[]>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error("BGE embedding worker timed out");
        rejectRequest(error);
        this.#stopWorker(error);
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.#pending.set(id, { count: texts.length, resolve: resolveRequest, reject: rejectRequest, timeout });
      this.#setWorkerRequestRef(true);
      child.stdin.write(`${JSON.stringify({ id, kind, texts })}\n`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Failed to write to BGE embedding worker: ${error.message}`, { cause: error }));
        if (this.#pending.size === 0) this.#setWorkerRequestRef(false);
        this.#scheduleIdleStop();
      });
    });
  }

  #ensureWorker(): ChildProcessWithoutNullStreams {
    this.#clearIdleTimer();
    if (this.#child && this.#child.exitCode === null && !this.#child.killed) return this.#child;
    const state = this.status();
    if (!state.ready) throw new Error(state.reason ?? "BGE INT8 Memory tooling is unavailable");
    const child = spawn(privatePython(this.#root), [join(this.#root, "bge_worker.py"), "--serve"], {
      cwd: this.#root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: workerEnvironment(),
    });
    this.#child = child;
    this.#stderrTail = "";
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines = lines;
    lines.on("line", (line) => this.#handleLine(line));
    // Pipe errors are independent of ChildProcess errors (for example EPIPE).
    // Retired workers must never reject requests belonging to their replacement.
    const fail = (error: Error): void => {
      if (this.#child === child) this.#stopWorker(error);
    };
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#child !== child) return;
      this.#stderrTail = `${this.#stderrTail}${String(chunk)}`.slice(-8_000);
    });
    child.once("error", (error) => fail(new Error(`BGE embedding worker failed to start: ${error.message}`, { cause: error })));
    child.once("close", (code, signal) => {
      if (this.#child !== child) return;
      const detail = this.#stderrTail.trim();
      fail(new Error([
        `BGE embedding worker exited${signal ? ` with ${signal}` : ` with code ${code ?? "unknown"}`}`,
        detail ? `Recent worker output: ${detail}` : "",
      ].filter(Boolean).join("\n")));
    });
    child.unref();
    (child.stdin as typeof child.stdin & { unref?: () => void }).unref?.();
    (child.stdout as typeof child.stdout & { unref?: () => void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.();
    return child;
  }

  #handleLine(line: string): void {
    let response: BgeResponse;
    try {
      response = JSON.parse(line) as BgeResponse;
    } catch {
      return;
    }
    if (!response || typeof response !== "object" || typeof response.id !== "number" || !Number.isInteger(response.id)) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.ok !== true) {
      const message = typeof response.error === "string" && response.error.trim()
        ? response.error.trim().slice(0, 4_000)
        : "BGE embedding worker failed";
      pending.reject(new Error(message));
      if (this.#pending.size === 0) this.#setWorkerRequestRef(false);
      this.#scheduleIdleStop();
      return;
    }
    try {
      if (!Array.isArray(response.vectors)) throw new Error("BGE embedding worker returned invalid vectors");
      if (response.vectors.length !== pending.count) throw new Error("BGE embedding worker returned the wrong batch size");
      pending.resolve(Object.freeze(response.vectors.map(validateVector)));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (this.#pending.size === 0) this.#setWorkerRequestRef(false);
      this.#scheduleIdleStop();
    }
  }

  #setWorkerRequestRef(active: boolean): void {
    const child = this.#child;
    if (!child) return;
    const method = active ? "ref" : "unref";
    (child.stdin as typeof child.stdin & { ref?: () => void; unref?: () => void })[method]?.();
    (child.stdout as typeof child.stdout & { ref?: () => void; unref?: () => void })[method]?.();
    (child.stderr as typeof child.stderr & { ref?: () => void; unref?: () => void })[method]?.();
  }

  #clearIdleTimer(): void {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #scheduleIdleStop(): void {
    this.#clearIdleTimer();
    const child = this.#child;
    if (!child || child.exitCode !== null || child.killed || this.#pending.size !== 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#pending.size === 0) this.#stopWorker();
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #stopWorker(error?: Error): void {
    this.#clearIdleTimer();
    if (error && this.#pending.size > 0) {
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      for (const request of pending) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
    }
    this.#setWorkerRequestRef(false);
    this.#lines?.close();
    this.#lines = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null && !child.killed) child.kill();
  }

}

const DEFAULT_BGE_PROVIDER = new BgeSmallEnV15Int8EmbeddingProvider();

export function createDefaultMemoryEmbeddingProvider(): MemoryEmbeddingProvider {
  return DEFAULT_BGE_PROVIDER;
}

export function defaultMemoryEmbeddingProviderState(): MemoryEmbeddingProviderState {
  return DEFAULT_BGE_PROVIDER.status();
}

export function disposeDefaultMemoryEmbeddingProvider(): void {
  DEFAULT_BGE_PROVIDER.dispose();
}
