import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { readSubagentMemorySnapshot } from "./memory-budget.js";
import { modelSelector, resolveSubagentModel } from "./model-selection.js";
import type {
	CreateSubagentRuntimeOptions,
	SpawnSubagentOptions,
	SpawnSubagentTask,
	SpawnManySubagentsOptions,
	WaitForSubagentsOptions,
	SubagentManagerEvent,
	SubagentManagerOptions,
	SubagentResourceNotice,
	SubagentRegistryEntry,
	SubagentRuntime,
	SubagentSpawnHandle,
} from "./types.js";

const SUBAGENT_NAME_MAX_LENGTH = 64;

export function normalizeRequestedSubagentName(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("subagent name must be a string");
	const name = value.trim();
	if (!name) throw new Error("subagent name must not be empty");
	if (name.length > SUBAGENT_NAME_MAX_LENGTH) {
		throw new Error(`subagent name must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function createDefaultSubagentName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix = childId.replace(/^sub-/, "").replace(/[^A-Za-z0-9]+/g, "").slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, SUBAGENT_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function copyEntry(entry: SubagentRegistryEntry): SubagentRegistryEntry {
	return { ...entry };
}

interface ActiveRun {
	entry: SubagentRegistryEntry;
	controller: AbortController;
	runtimeOptions: CreateSubagentRuntimeOptions;
	runtime?: SubagentRuntime;
	started: boolean;
	settled: boolean;
	detachExternalAbort?: () => void;
}

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;
const MAX_CONCURRENT_SUBAGENTS = 32;
const DEFAULT_MEMORY_RETRY_MS = 2_000;
const MIN_MEMORY_RETRY_MS = 250;
const MAX_MEMORY_RETRY_MS = 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60_000;

export class SubagentManager {
	private readonly options: SubagentManagerOptions & {
		readonly depth: number;
		readonly maxDepth: number;
		readonly maxConcurrent: number;
		readonly memoryRetryMs: number;
		readonly memorySnapshot: NonNullable<SubagentManagerOptions["memorySnapshot"]>;
	};
	private readonly entries = new Map<string, SubagentRegistryEntry>();
	private readonly active = new Map<string, ActiveRun>();
	private readonly deleted = new Set<string>();
	private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
	private ephemeralParentDir?: string;
	private memoryRetryTimer: NodeJS.Timeout | undefined;
	private memoryConstrained = false;
	private disposed = false;

	private constructor(options: SubagentManagerOptions) {
		const depth = options.depth ?? 0;
		const maxDepth = options.maxDepth ?? 1;
		const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
		const memoryRetryMs = options.memoryRetryMs ?? DEFAULT_MEMORY_RETRY_MS;
		if (!Number.isInteger(depth) || depth < 0) throw new Error("subagent depth must be a non-negative integer");
		if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("subagent maxDepth must be a non-negative integer");
		if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_SUBAGENTS) {
			throw new Error(`subagent maxConcurrent must be an integer from 1 to ${MAX_CONCURRENT_SUBAGENTS}`);
		}
		if (!Number.isInteger(memoryRetryMs) || memoryRetryMs < MIN_MEMORY_RETRY_MS || memoryRetryMs > MAX_MEMORY_RETRY_MS) {
			throw new Error(`subagent memoryRetryMs must be an integer from ${MIN_MEMORY_RETRY_MS} to ${MAX_MEMORY_RETRY_MS}`);
		}
		this.options = { ...options, depth, maxDepth, maxConcurrent, memoryRetryMs, memorySnapshot: options.memorySnapshot ?? readSubagentMemorySnapshot };
	}

	static async create(options: SubagentManagerOptions): Promise<SubagentManager> {
		const manager = new SubagentManager(options);
		const restored = (await options.registryStore?.load()) ?? [];
		for (const original of restored) {
			const entry = copyEntry(original);
			// Active runtimes are process-local and cannot survive a host restart. Never
			// restore a ghost queued/running state when there is no ActiveRun behind it.
			// The child transcript remains intact so its parent can explicitly continue.
			if (entry.status === "queued" || entry.status === "running") {
				entry.status = "error";
				entry.error = "FRIDAY restarted before this subagent completed; its persisted transcript is preserved for continuation";
			}
			manager.entries.set(entry.childId, entry);
			if (entry.status !== original.status || entry.error !== original.error) await manager.persist(entry);
		}
		return manager;
	}

	get depth(): number {
		return this.options.depth;
	}

	get maxDepth(): number {
		return this.options.maxDepth;
	}

	get maxConcurrent(): number {
		return this.options.maxConcurrent;
	}

	subscribe(listener: (event: SubagentManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): SubagentRegistryEntry[] {
		return [...this.entries.values()].map(copyEntry);
	}

	get(childId: string): SubagentRegistryEntry | undefined {
		const entry = this.entries.get(childId);
		return entry ? copyEntry(entry) : undefined;
	}

	async spawn(prompt: string, options: SpawnSubagentOptions = {}): Promise<SubagentSpawnHandle> {
		if (this.disposed) throw new Error("cannot spawn a subagent after its manager was disposed");
		options.signal?.throwIfAborted();
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("subagent prompt must be a non-empty string");
		if (this.options.depth >= this.options.maxDepth) {
			throw new Error(`subagent recursion depth limit reached (depth=${this.options.depth}, maxDepth=${this.options.maxDepth})`);
		}

		const requestedName = normalizeRequestedSubagentName(options.name);
		const model = resolveSubagentModel(options.model, this.options.parentModel, this.options.models ?? [this.options.parentModel]);
		const sessionDir = this.createChildSessionDir();
		const childId = basename(sessionDir);
		const name = requestedName ?? createDefaultSubagentName(prompt, childId);
		this.assertNameAvailable(name);

		const entry: SubagentRegistryEntry = {
			childId,
			...(this.options.parentId ? { parentId: this.options.parentId } : {}),
			sessionId: null,
			name,
			sessionDir,
			model: modelSelector(model),
			depth: this.options.depth + 1,
			status: "queued",
		};
		this.entries.set(childId, entry);
		await this.persist(entry);
		this.emit(entry);

		const runtimeOptions: CreateSubagentRuntimeOptions = {
			...(this.options.parentId ? { parentId: this.options.parentId } : {}),
			id: childId,
			prompt,
			name,
			sessionDir,
			model,
			depth: entry.depth,
			maxDepth: this.options.maxDepth,
			...(options.spawnCode === undefined ? {} : { spawnCode: options.spawnCode }),
		};
		const run: ActiveRun = { entry, controller: new AbortController(), runtimeOptions, started: false, settled: false };
		if (options.signal) {
			const onAbort = () => {
				if (run.settled || run.controller.signal.aborted) return;
				this.cancel(childId, "Host request was cancelled");
			};
			options.signal.addEventListener("abort", onAbort, { once: true });
			run.detachExternalAbort = () => options.signal?.removeEventListener("abort", onAbort);
		}
		this.active.set(childId, run);
		this.schedule();

		return { childId, name, sessionDir, model: entry.model };
	}

	async spawnMany(tasks: readonly SpawnSubagentTask[], options: SpawnManySubagentsOptions = {}): Promise<readonly SubagentSpawnHandle[]> {
		if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("subagent batch must contain at least one task");
		if (tasks.length > 32) throw new Error("subagent batch may contain at most 32 tasks");
		options.signal?.throwIfAborted();
		for (const task of tasks) {
			if (!task || typeof task !== "object" || typeof task.prompt !== "string" || !task.prompt.trim()) {
				throw new Error("every subagent batch task must have a non-empty prompt");
			}
			const requestedName = normalizeRequestedSubagentName(task.name);
			if (requestedName) this.assertNameAvailable(requestedName);
			resolveSubagentModel(task.model, this.options.parentModel, this.options.models ?? [this.options.parentModel]);
		}
		const explicitNames = tasks
			.map((task) => normalizeRequestedSubagentName(task.name))
			.filter((name): name is string => name !== undefined);
		if (new Set(explicitNames).size !== explicitNames.length) throw new Error("subagent batch contains duplicate names");
		const handles: SubagentSpawnHandle[] = [];
		try {
			for (const task of tasks) {
				handles.push(await this.spawn(task.prompt, {
					...(task.name === undefined ? {} : { name: task.name }),
					...(task.model === undefined ? {} : { model: task.model }),
					...(options.spawnCode === undefined ? {} : { spawnCode: options.spawnCode }),
					...(options.signal === undefined ? {} : { signal: options.signal }),
				}));
			}
		} catch (error) {
			for (const handle of handles) this.cancel(handle.childId, "Subagent batch admission failed");
			throw error;
		}
		return Object.freeze(handles);
	}

	async wait(targets: readonly string[], options: WaitForSubagentsOptions = {}): Promise<readonly SubagentRegistryEntry[]> {
		if (!Array.isArray(targets) || targets.length === 0 || targets.length > 32) {
			throw new Error("subagent wait requires between 1 and 32 targets");
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
			throw new Error(`subagent wait timeoutMs must be an integer from 1 to ${MAX_WAIT_TIMEOUT_MS}`);
		}
		const resolved = targets.map((target) => {
			if (typeof target !== "string" || !target.trim()) throw new Error("subagent wait targets must be non-empty strings");
			const entry = this.resolveTarget(target, true);
			if (!entry) throw new Error(`no direct subagent matches \"${target}\"`);
			return entry.childId;
		});
		const done = () => resolved.every((id) => {
			const status = this.entries.get(id)?.status;
			return status === "completed" || status === "error" || status === "cancelled";
		});
		if (!done()) {
			await new Promise<void>((resolveWait, rejectWait) => {
				let settled = false;
				const finish = (error?: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					unsubscribe();
					options.signal?.removeEventListener("abort", onAbort);
					error === undefined ? resolveWait() : rejectWait(error);
				};
				const unsubscribe = this.subscribe(() => { if (done()) finish(); });
				const timer = setTimeout(() => finish(new Error(`timed out waiting for subagents after ${timeoutMs}ms`)), timeoutMs);
				const onAbort = () => finish(options.signal?.reason ?? new Error("subagent wait aborted"));
				if (options.signal?.aborted) onAbort();
				else options.signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		return Object.freeze(resolved.map((id) => copyEntry(this.entries.get(id)!)));
	}

	cancel(target: string, reason = "Cancelled by parent"): boolean {
		const entry = this.resolveTarget(target, false);
		if (!entry) return false;
		const run = this.active.get(entry.childId);
		if (!run || run.settled) return false;
		run.entry.status = "cancelled";
		run.entry.error = reason;
		run.controller.abort(reason);
		if (!run.started) {
			run.settled = true;
			run.detachExternalAbort?.();
			delete run.detachExternalAbort;
		}
		void Promise.resolve(run.runtime?.abort?.(reason)).catch((error: unknown) => {
			reportOperationalError({ component: "subagents", operation: `abort child ${run.entry.childId}`, error });
		});
		if (!this.deleted.has(run.entry.childId)) {
			void this.persist(run.entry).catch((error: unknown) => {
				reportOperationalError({ component: "subagents", operation: `persist cancellation for ${run.entry.childId}`, error });
			});
			this.emit(run.entry);
		}
		this.schedule();
		return true;
	}

	async delete(target: string): Promise<SubagentRegistryEntry> {
		const entry = this.resolveTarget(target, true);
		if (!entry) throw new Error(`no direct subagent matches \"${target}\"`);
		const run = this.active.get(entry.childId);
		this.deleted.add(entry.childId);
		if (run && !run.settled) this.cancel(entry.childId, "Deleted by parent");
		await this.options.runtimeHost.delete(entry.childId, run?.runtime);
		this.active.delete(entry.childId);
		this.entries.delete(entry.childId);
		await this.options.registryStore?.remove(entry.childId);
		return copyEntry(entry);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.memoryRetryTimer) {
			clearTimeout(this.memoryRetryTimer);
			this.memoryRetryTimer = undefined;
		}
		const queuedPersistence: Promise<void>[] = [];
		for (const run of this.active.values()) {
			if (!run.settled) {
				run.entry.status = "cancelled";
				run.entry.error = "Parent manager disposed";
				run.controller.abort(run.entry.error);
				void Promise.resolve(run.runtime?.abort?.(run.entry.error)).catch((error: unknown) => {
					reportOperationalError({ component: "subagents", operation: `abort child ${run.entry.childId} during dispose`, error });
				});
				if (!run.started) {
					run.settled = true;
					run.detachExternalAbort?.();
					delete run.detachExternalAbort;
					queuedPersistence.push(this.persist(run.entry).then(() => this.emit(run.entry)));
				}
			}
		}
		await Promise.allSettled(queuedPersistence);
		await Promise.allSettled(
			[...this.active.values()].map(async (run) => {
				await run.runtime?.dispose?.();
			}),
		);
		this.active.clear();
		await this.options.runtimeHost.dispose?.();
	}

	private assertNameAvailable(name: string): void {
		if ([...this.entries.values()].some((entry) => entry.name === name)) {
			throw new Error(`subagent name \"${name}\" is unavailable under this parent`);
		}
	}

	private resolveTarget(target: string, throwOnAmbiguous: boolean): SubagentRegistryEntry | undefined {
		const selector = target.trim();
		const matches = [...this.entries.values()].filter(
			(entry) => entry.childId === selector || entry.sessionId === selector || entry.name === selector,
		);
		if (matches.length > 1 && throwOnAmbiguous) {
			throw new Error(`subagent selector \"${selector}\" is ambiguous under this parent`);
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	private createChildSessionDir(): string {
		const parentDir = this.options.parentArtifactDir ?? this.ensureEphemeralParentDir();
		mkdirSync(parentDir, { recursive: true });
		for (let i = 0; i < 100; i++) {
			const childDir = join(parentDir, `sub-${randomUUID().slice(0, 8)}`);
			try {
				mkdirSync(childDir);
				return childDir;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
				throw error;
			}
		}
		throw new Error("unable to create a unique subagent session directory");
	}

	private ensureEphemeralParentDir(): string {
		this.ephemeralParentDir ??= mkdtempSync(join(tmpdir(), "friday-subagents-"));
		return this.ephemeralParentDir;
	}

	private runningCount(): number {
		return [...this.active.values()].filter((run) => run.started && !run.settled).length;
	}

	private queuedCount(): number {
		return [...this.active.values()].filter((run) => !run.started && !run.settled && run.entry.status === "queued" && !run.controller.signal.aborted).length;
	}

	private emitResourceNotice(notice: SubagentResourceNotice): void {
		const listener = this.options.onResourceNotice;
		if (!listener) return;
		void Promise.resolve(listener(notice)).catch((error: unknown) => {
			reportOperationalError({ component: "subagents", operation: `deliver ${notice.state} RAM scheduling notice`, error });
		});
	}

	private armMemoryRetry(): void {
		if (this.disposed || this.memoryRetryTimer) return;
		this.memoryRetryTimer = setTimeout(() => {
			this.memoryRetryTimer = undefined;
			this.schedule();
		}, this.options.memoryRetryMs);
		this.memoryRetryTimer.unref?.();
	}

	private clearMemoryRetry(): void {
		if (!this.memoryRetryTimer) return;
		clearTimeout(this.memoryRetryTimer);
		this.memoryRetryTimer = undefined;
	}

	private schedule(): void {
		if (this.disposed) return;
		const running = this.runningCount();
		const queued = this.queuedCount();
		const configuredAvailable = this.options.maxConcurrent - running;
		if (queued <= 0 || configuredAvailable <= 0) {
			this.clearMemoryRetry();
			return;
		}

		let snapshot;
		try {
			snapshot = this.options.memorySnapshot();
		} catch (error) {
			reportOperationalError({ component: "subagents", operation: "read RAM budget before child admission", error });
			this.armMemoryRetry();
			return;
		}
		const desiredStarts = Math.min(configuredAvailable, queued);
		// Treat already-running children as committed reservations as well. This is
		// intentionally conservative: it avoids a burst of newly-started children
		// outrunning the OS memory accounting before their RSS becomes visible.
		const memoryAllowedAdditional = Math.max(0, snapshot.safeAdditionalAgents - running);
		let available = Math.min(desiredStarts, memoryAllowedAdditional);
		const constrained = available < desiredStarts;

		if (constrained && !this.memoryConstrained) {
			this.memoryConstrained = true;
			this.emitResourceNotice(Object.freeze({
				state: "constrained",
				running: running + available,
				queued: Math.max(0, queued - available),
				configuredMaxConcurrent: this.options.maxConcurrent,
				memoryAllowedAdditional: available,
				snapshot,
			}));
		} else if (!constrained && this.memoryConstrained) {
			this.memoryConstrained = false;
			this.emitResourceNotice(Object.freeze({
				state: "resumed",
				running: running + available,
				queued: Math.max(0, queued - available),
				configuredMaxConcurrent: this.options.maxConcurrent,
				memoryAllowedAdditional: available,
				snapshot,
			}));
		}

		for (const run of this.active.values()) {
			if (available <= 0) break;
			if (run.started || run.settled || run.entry.status !== "queued" || run.controller.signal.aborted) continue;
			run.started = true;
			available -= 1;
			void this.runDetached(run, run.runtimeOptions).catch((error: unknown) => {
				reportOperationalError({ component: "subagents", operation: `execute child ${run.entry.childId}`, error });
			});
		}

		if (constrained && this.queuedCount() > 0 && this.runningCount() < this.options.maxConcurrent) this.armMemoryRetry();
		else this.clearMemoryRetry();
	}

	private async runDetached(run: ActiveRun, options: CreateSubagentRuntimeOptions): Promise<void> {
		try {
			if (run.entry.status === "cancelled" || run.controller.signal.aborted) return;
			const runtime = await this.options.runtimeHost.create(options);
			run.runtime = runtime;
			if (run.controller.signal.aborted) {
				await runtime.abort?.(run.entry.error ?? "Cancelled by parent");
				await runtime.dispose?.();
				return;
			}
			run.entry.status = "running";
			run.entry.sessionId = runtime.sessionId ?? null;
			if (runtime.sessionName) run.entry.name = runtime.sessionName;
			await this.persist(run.entry);
			this.emit(run.entry);

			const result = await runtime.run(options.prompt, run.controller.signal);
			if (run.controller.signal.aborted) {
				run.entry.status = "cancelled";
			} else {
				run.entry.status = "completed";
				if (result?.sessionId !== undefined) run.entry.sessionId = result.sessionId;
				if (result?.name !== undefined) run.entry.name = result.name;
			}
			if (run.entry.status === "completed" && this.options.runtimeHost.complete?.(run.entry.childId, runtime) === false) {
				await runtime.dispose?.();
			}
		} catch (error) {
			if (run.entry.status !== "cancelled") {
				run.entry.status = "error";
				run.entry.error = errorMessage(error);
			}
		} finally {
			run.detachExternalAbort?.();
			delete run.detachExternalAbort;
			run.settled = true;
			if (!this.deleted.has(run.entry.childId)) {
				await this.persist(run.entry);
				this.emit(run.entry);
			}
			if (run.runtime) {
				await this.options.runtimeHost.release?.(
					run.runtime,
					options,
					run.entry.status === "completed" ? "completed" : run.entry.status === "cancelled" ? "cancelled" : "error",
				);
			}
			this.schedule();
		}
	}

	private async persist(entry: SubagentRegistryEntry): Promise<void> {
		await this.options.registryStore?.upsert(copyEntry(entry));
	}

	private emit(entry: SubagentRegistryEntry): void {
		const event: SubagentManagerEvent = { type: "child_update", child: copyEntry(entry) };
		for (const listener of this.listeners) listener(event);
	}
}
