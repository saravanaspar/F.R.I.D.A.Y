import { createDiscoveredModel, getProviderRuntimeProfiles } from "./provider-profiles.js";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage } from "./types.js";

/**
 * Runtime-only model registry.
 *
 * FRIDAY deliberately starts with zero model ids. Provider APIs/OAuth discovery
 * populate ids at runtime; explicit configured ids are lazily materialized from
 * provider transport profiles so a restart never depends on a shipped catalog.
 */
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

function providerRegistry(provider: string, create = false): Map<string, Model<Api>> | undefined {
  let models = modelRegistry.get(provider);
  if (!models && create) {
    models = new Map<string, Model<Api>>();
    modelRegistry.set(provider, models);
  }
  return models;
}

export function getModel(providerInput: string, modelIdInput: string): Model<Api> | undefined {
  const provider = providerInput.trim();
  const modelId = modelIdInput.trim();
  if (!provider || !modelId) return undefined;
  const existing = providerRegistry(provider)?.get(modelId);
  if (existing) return existing;
  const discovered = createDiscoveredModel(provider, modelId);
  if (!discovered) return undefined;
  providerRegistry(provider, true)!.set(modelId, discovered);
  return discovered;
}

export interface RegisterModelOptions {
  replace?: boolean;
}

/** Register a runtime model descriptor, used for live discovery/custom endpoints. */
export function registerModel(model: Model<Api>, options: RegisterModelOptions = {}): void {
  const provider = String(model.provider).trim();
  const id = String(model.id).trim();
  if (!provider || !id) throw new Error("model provider and id are required");
  const providerModels = providerRegistry(provider, true)!;
  if (providerModels.has(id) && options.replace !== true) {
    throw new Error(`Model already registered: ${provider}/${id}`);
  }
  providerModels.set(id, Object.freeze({ ...model }));
}

/** Register provider-returned ids without any shipped model-id catalog. */
export function registerDiscoveredModelIds(providerInput: string, modelIds: readonly string[]): readonly Model<Api>[] {
  const provider = providerInput.trim();
  const models: Model<Api>[] = [];
  const seen = new Set<string>();
  for (const raw of modelIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = getModel(provider, id);
    if (model) models.push(model);
  }
  return Object.freeze(models);
}

export function unregisterModel(providerInput: string, modelIdInput: string): boolean {
  const provider = providerInput.trim();
  const modelId = modelIdInput.trim();
  const providerModels = modelRegistry.get(provider);
  if (!providerModels) return false;
  const removed = providerModels.delete(modelId);
  if (providerModels.size === 0) modelRegistry.delete(provider);
  return removed;
}

export function getProviders(): KnownProvider[] {
  const providers = new Set<string>(getProviderRuntimeProfiles().map((profile) => profile.provider));
  for (const provider of modelRegistry.keys()) providers.add(provider);
  return [...providers].sort() as KnownProvider[];
}

/** Return only models learned/registered during this process; never a preloaded catalog. */
export function getModels(providerInput: string): Model<Api>[] {
  const models = modelRegistry.get(providerInput.trim());
  return models ? Array.from(models.values()) : [];
}

export function supportsFastMode<TApi extends Api>(model: Model<TApi>): boolean {
  return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export interface CostOverrides {
  cacheWrite?: number;
}

export function calculateCost<TApi extends Api>(
  model: Model<TApi>,
  usage: Usage,
  overrides?: CostOverrides,
): Usage["cost"] {
  usage.tokenSource = "provider-reported";
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = ((overrides?.cacheWrite ?? model.cost.cacheWrite) / 1000000) * usage.cacheWrite;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  usage.cost.estimated = model.cost.input || model.cost.output || model.cost.cacheRead || model.cost.cacheWrite
    ? usage.cost.total
    : undefined;
  usage.cost.source = usage.cost.estimated === undefined ? "unavailable" : "catalog-estimate";
  return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) return level;

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";

  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

/** Check if two models are equal by provider and live model id. */
export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.provider === b.provider;
}
