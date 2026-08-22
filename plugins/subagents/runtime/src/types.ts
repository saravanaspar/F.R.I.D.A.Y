export interface SubagentModel {
	provider: string;
	id: string;
	name?: string;
}

export type SubagentStatus = "queued" | "running" | "completed" | "error" | "cancelled";

export interface SubagentSpawnHandle {
	childId: string;
	name: string;
	sessionDir: string;
	model: string;
}

export interface SubagentRegistryEntry {
	childId: string;
	parentId?: string;
	sessionId: string | null;
	name: string;
	sessionDir: string;
	model: string;
	depth: number;
	status: SubagentStatus;
	error?: string;
}

export interface SubagentRunResult {
	sessionId?: string;
	name?: string;
}

export interface SubagentRuntime {
	readonly sessionId?: string;
	readonly sessionName?: string;
	run(prompt: string, signal: AbortSignal): Promise<SubagentRunResult | void>;
	abort?(reason?: string): void | Promise<void>;
	dispose?(): void | Promise<void>;
}

export interface CreateSubagentRuntimeOptions {
	parentId?: string;
	id: string;
	prompt: string;
	name: string;
	sessionDir: string;
	model: SubagentModel;
	depth: number;
	maxDepth: number;
	spawnCode?: string;
}

export interface SubagentRuntimeHost {
	create(options: CreateSubagentRuntimeOptions): Promise<SubagentRuntime>;
	/** Persist host-owned completion before a child becomes passivation-eligible. */
	complete?(childId: string, runtime: SubagentRuntime): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	release?(
		runtime: SubagentRuntime,
		options: CreateSubagentRuntimeOptions,
		status: "completed" | "error" | "cancelled",
	): Promise<void>;
	/** Close or remove a host-owned child; runtime is absent for passive persisted children. */
	delete(childId: string, runtime?: SubagentRuntime): Promise<void>;
	dispose?(): Promise<void>;
}

export interface SubagentRegistryStore {
	load(): SubagentRegistryEntry[] | Promise<SubagentRegistryEntry[]>;
	upsert(entry: SubagentRegistryEntry): void | Promise<void>;
	remove(childId: string): void | Promise<void>;
}

export interface SubagentManagerEvent {
	type: "child_update";
	child: SubagentRegistryEntry;
}

export interface SubagentManagerOptions {
	parentId?: string;
	parentArtifactDir?: string;
	depth?: number;
	maxDepth?: number;
	parentModel: SubagentModel;
	models?: readonly SubagentModel[];
	runtimeHost: SubagentRuntimeHost;
	registryStore?: SubagentRegistryStore;
}

export interface SpawnSubagentOptions {
	name?: string;
	model?: string;
	spawnCode?: string;
	signal?: AbortSignal;
}
