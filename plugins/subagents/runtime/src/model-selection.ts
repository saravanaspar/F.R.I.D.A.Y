import type { SubagentModel } from "./types.js";

export interface SubagentModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export const DEFAULT_SUBAGENT_MODEL_SEARCH_LIMIT = 8;
export const MAX_SUBAGENT_MODEL_SEARCH_LIMIT = 20;

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function modelSelector(model: SubagentModel): string {
	return `${model.provider}/${model.id}`;
}

export function findSubagentModelMatches(
	query: string,
	models: readonly SubagentModel[],
	limit = DEFAULT_SUBAGENT_MODEL_SEARCH_LIMIT,
): SubagentModelMatch[] {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SUBAGENT_MODEL_SEARCH_LIMIT) {
		throw new Error(`subagent model search limit must be an integer from 1 to ${MAX_SUBAGENT_MODEL_SEARCH_LIMIT}`);
	}
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = modelSelector(model);
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

export function resolveSubagentModel(
	reference: string | undefined,
	parentModel: SubagentModel,
	models: readonly SubagentModel[],
): SubagentModel {
	if (reference === undefined) return parentModel;
	const requested = reference.trim();
	if (!requested) throw new Error("subagent model must not be empty");
	const exact = models.find((model) => modelSelector(model) === requested);
	if (!exact) throw new Error(`subagent model \"${requested}\" is not available`);
	return exact;
}
