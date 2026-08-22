import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { modelSelector, resolveSubagentModel } from "./model-selection.js";
import type {
	CreateSubagentRuntimeOptions,
	SpawnSubagentOptions,
	SubagentManagerEvent,
	SubagentManagerOptions,
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
	runtime?: SubagentRuntime;
	settled: boolean;
	detachExternalAbort?: () => void;
}

export class SubagentManager {
	private readonly options: Required<Pick<SubagentManagerOptions, "depth" | "maxDepth">> &
		Omit<SubagentManagerOptions, "depth" | "maxDepth">;
	private readonly entries = new Map<string, SubagentRegistryEntry>();
	private readonly active = new Map<string, ActiveRun>();
	private readonly deleted = new Set<string>();
	private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
	private ephemeralParentDir?: string;
	private disposed = false;

	private constructor(options: SubagentManagerOptions) {
		const depth = options.depth ?? 0;
		const maxDepth = options.maxDepth ?? 1;
		if (!Number.isInteger(depth) || depth < 0) throw new Error("subagent depth must be a non-negative integer");
		if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("subagent maxDepth must be a non-negative integer");
		this.options = { ...options, depth, maxDepth };
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

		const run: ActiveRun = { entry, controller: new AbortController(), settled: false };
		if (options.signal) {
			const onAbort = () => {
				if (run.settled || run.controller.signal.aborted) return;
				run.entry.status = "cancelled";
				run.entry.error = "Host request was cancelled";
				run.controller.abort(run.entry.error);
			};
			options.signal.addEventListener("abort", onAbort, { once: true });
			run.detachExternalAbort = () => options.signal?.removeEventListener("abort", onAbort);
		}
		this.active.set(childId, run);
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
		void this.runDetached(run, runtimeOptions).catch((error: unknown) => {
			reportOperationalError({ component: "subagents", operation: `execute child ${childId}`, error });
		});

		return { childId, name, sessionDir, model: entry.model };
	}

	cancel(target: string, reason = "Cancelled by parent"): boolean {
		const entry = this.resolveTarget(target, false);
		if (!entry) return false;
		const run = this.active.get(entry.childId);
		if (!run || run.settled) return false;
		run.entry.status = "cancelled";
		run.entry.error = reason;
		run.controller.abort(reason);
		void Promise.resolve(run.runtime?.abort?.(reason)).catch((error: unknown) => {
			reportOperationalError({ component: "subagents", operation: `abort child ${run.entry.childId}`, error });
		});
		if (!this.deleted.has(run.entry.childId)) {
			void this.persist(run.entry).catch((error: unknown) => {
				reportOperationalError({ component: "subagents", operation: `persist cancellation for ${run.entry.childId}`, error });
			});
			this.emit(run.entry);
		}
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
		for (const run of this.active.values()) {
			if (!run.settled) {
				run.entry.status = "cancelled";
				run.entry.error = "Parent manager disposed";
				run.controller.abort(run.entry.error);
				void run.runtime?.abort?.(run.entry.error);
			}
		}
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
