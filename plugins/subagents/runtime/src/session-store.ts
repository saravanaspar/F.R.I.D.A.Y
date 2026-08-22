import type { SubagentRegistryEntry, SubagentRegistryStore } from "./types.js";

export const SUBAGENT_REGISTRY_CUSTOM_TYPE = "subagents.registry";

interface SessionCustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface SubagentSessionStorePort {
	getBranch(): SessionCustomEntryLike[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

type RegistryEvent =
	| { version: 1; action: "upsert"; entry: SubagentRegistryEntry }
	| { version: 1; action: "remove"; childId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is SubagentRegistryEntry["status"] {
	return value === "queued" || value === "running" || value === "completed" || value === "error" || value === "cancelled";
}

function parseEntry(value: unknown): SubagentRegistryEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.childId !== "string" ||
		typeof value.name !== "string" ||
		typeof value.sessionDir !== "string" ||
		typeof value.model !== "string" ||
		typeof value.depth !== "number" ||
		!Number.isInteger(value.depth) ||
		value.depth < 0 ||
		!isStatus(value.status) ||
		!(value.sessionId === null || typeof value.sessionId === "string")
	) {
		return undefined;
	}
	return {
		childId: value.childId,
		...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}),
		sessionId: value.sessionId,
		name: value.name,
		sessionDir: value.sessionDir,
		model: value.model,
		depth: value.depth,
		status: value.status,
		...(typeof value.error === "string" ? { error: value.error } : {}),
	};
}

function parseEvent(value: unknown): RegistryEvent | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (value.action === "remove" && typeof value.childId === "string") {
		return { version: 1, action: "remove", childId: value.childId };
	}
	if (value.action === "upsert") {
		const entry = parseEntry(value.entry);
		if (entry) return { version: 1, action: "upsert", entry };
	}
	return undefined;
}

export function createSessionSubagentRegistryStore(session: SubagentSessionStorePort): SubagentRegistryStore {
	return {
		load() {
			const entries = new Map<string, SubagentRegistryEntry>();
			for (const item of session.getBranch()) {
				if (item.type !== "custom" || item.customType !== SUBAGENT_REGISTRY_CUSTOM_TYPE) continue;
				const event = parseEvent(item.data);
				if (!event) continue;
				if (event.action === "remove") entries.delete(event.childId);
				else entries.set(event.entry.childId, event.entry);
			}
			return [...entries.values()];
		},
		upsert(entry) {
			session.appendCustomEntry(SUBAGENT_REGISTRY_CUSTOM_TYPE, { version: 1, action: "upsert", entry });
		},
		remove(childId) {
			session.appendCustomEntry(SUBAGENT_REGISTRY_CUSTOM_TYPE, { version: 1, action: "remove", childId });
		},
	};
}
