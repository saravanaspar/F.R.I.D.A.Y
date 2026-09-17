import { registerDiscoveredModelIds } from "./models.js";

const DISCOVERY_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 8;
const MAX_MODEL_IDS = 4_096;
const MAX_ERROR_CHARS = 600;

export interface ProviderModelDiscoveryOptions {
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class ProviderModelDiscoveryError extends Error {
  readonly provider: string;
  readonly status?: number | undefined;

  constructor(provider: string, message: string, options: { readonly status?: number | undefined; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderModelDiscoveryError";
    this.provider = provider;
    if (options.status !== undefined) this.status = options.status;
  }
}

type JsonRecord = Record<string, unknown>;

export type DiscoveredModelPricingTier = "free" | "paid" | "unknown";

const DISCOVERED_MODEL_PRICING = new Map<string, Map<string, DiscoveredModelPricingTier>>();
const PRICING_TIER_RANK: Readonly<Record<DiscoveredModelPricingTier, number>> = Object.freeze({
  free: 0,
  paid: 1,
  unknown: 2,
});

function objectRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function boundedString(value: unknown, maximum = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\r\n\0]+/g, " ");
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function validateApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey || apiKey.length > 16_384) throw new Error("Provider API key is empty or too long");
  if (/\s/.test(apiKey)) throw new Error("Provider API key contains whitespace");
  return apiKey;
}

function createTimedSignal(signal?: AbortSignal): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("model discovery timed out")), DISCOVERY_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error("provider model-list response exceeds FRIDAY's discovery limit");
  }
  if (!response.body) throw new Error("provider model-list response was empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch (cancelError) {
          throw new AggregateError([
            new Error("provider model-list response exceeds FRIDAY's discovery limit"),
            cancelError,
          ], "provider model-list response exceeded FRIDAY's discovery limit and cancellation failed");
        }
        throw new Error("provider model-list response exceeds FRIDAY's discovery limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("provider model-list response was malformed JSON", { cause: error });
  }
}

function errorDetail(payload: unknown): string | undefined {
  const root = objectRecord(payload);
  const error = objectRecord(root?.error);
  return boundedString(error?.message ?? root?.message, MAX_ERROR_CHARS);
}

function redactHeaderSecrets(value: string, headers: Readonly<Record<string, string>>): string {
  let redacted = value;
  for (const [name, raw] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized !== "authorization" && normalized !== "x-goog-api-key" && normalized !== "x-api-key") continue;
    const candidates = [raw, raw.replace(/^Bearer\s+/i, "")].filter((entry) => entry.length >= 6);
    for (const secret of candidates) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

async function requestJson(
  provider: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  options: ProviderModelDiscoveryOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timed = createTimedSignal(options.signal);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        redirect: "error",
        signal: timed.signal,
      });
    } catch (error) {
      throw new ProviderModelDiscoveryError(provider, `${provider} model discovery request failed`, { cause: error });
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      throw new ProviderModelDiscoveryError(provider, `${provider} model discovery returned an invalid response`, {
        status: response.status,
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = errorDetail(payload);
      const safeDetail = detail ? redactHeaderSecrets(detail, headers) : undefined;
      throw new ProviderModelDiscoveryError(
        provider,
        `${provider} model discovery failed with HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`,
        { status: response.status },
      );
    }
    return payload;
  } finally {
    timed.dispose();
  }
}

function normalizeModelId(raw: unknown, stripGooglePrefix = false): string | undefined {
  const value = boundedString(raw, 256);
  if (!value) return undefined;
  const id = stripGooglePrefix && value.startsWith("models/") ? value.slice("models/".length) : value;
  return id || undefined;
}

function nonNegativePrice(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function pricingTierFromModel(model: JsonRecord | undefined, id: string): DiscoveredModelPricingTier {
  const pricing = objectRecord(model?.pricing);
  if (pricing) {
    const prices = Object.values(pricing)
      .map(nonNegativePrice)
      .filter((value): value is number => value !== undefined);
    if (prices.some((value) => value > 0)) return "paid";
    if (prices.length > 0) return "free";
  }
  // Some providers encode an explicitly free variant in the live model id.
  // This is provider-returned metadata, not a bundled FRIDAY model list.
  return id.endsWith(":free") ? "free" : "unknown";
}

function mergePricingTier(
  current: DiscoveredModelPricingTier | undefined,
  next: DiscoveredModelPricingTier,
): DiscoveredModelPricingTier {
  if (current === undefined || current === "unknown") return next;
  if (next === "unknown") return current;
  // If duplicate provider records disagree, avoid incorrectly advertising a paid
  // route as free.
  return current === "paid" || next === "paid" ? "paid" : "free";
}

function addDiscoveredModel(
  models: Map<string, DiscoveredModelPricingTier>,
  rawId: unknown,
  rawModel?: JsonRecord,
  stripGooglePrefix = false,
): void {
  const id = normalizeModelId(rawId, stripGooglePrefix);
  if (!id || (!models.has(id) && models.size >= MAX_MODEL_IDS)) return;
  const tier = pricingTierFromModel(rawModel, id);
  models.set(id, mergePricingTier(models.get(id), tier));
}

function finalizeDiscoveredModels(
  providerInput: string,
  models: Map<string, DiscoveredModelPricingTier>,
): readonly string[] {
  const provider = providerInput.trim().toLowerCase();
  const ordered = [...models.keys()].sort((left, right) => {
    const leftTier = models.get(left) ?? "unknown";
    const rightTier = models.get(right) ?? "unknown";
    return PRICING_TIER_RANK[leftTier] - PRICING_TIER_RANK[rightTier] || left.localeCompare(right);
  });
  DISCOVERED_MODEL_PRICING.set(provider, new Map(ordered.map((id) => [id, models.get(id) ?? "unknown"])));
  return Object.freeze(ordered);
}

export function getDiscoveredModelPricingTier(
  providerInput: string,
  modelIdInput: string,
): DiscoveredModelPricingTier {
  const provider = providerInput.trim().toLowerCase();
  const modelId = modelIdInput.trim();
  if (!modelId) return "unknown";
  return DISCOVERED_MODEL_PRICING.get(provider)?.get(modelId)
    ?? (modelId.endsWith(":free") ? "free" : "unknown");
}

export function compareDiscoveredModelIds(
  providerInput: string,
  leftId: string,
  rightId: string,
): number {
  const leftTier = getDiscoveredModelPricingTier(providerInput, leftId);
  const rightTier = getDiscoveredModelPricingTier(providerInput, rightId);
  return PRICING_TIER_RANK[leftTier] - PRICING_TIER_RANK[rightTier] || leftId.localeCompare(rightId);
}

async function discoverGoogle(apiKey: string, options: ProviderModelDiscoveryOptions): Promise<readonly string[]> {
  const modelsById = new Map<string, DiscoveredModelPricingTier>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = objectRecord(await requestJson("google", url, { "x-goog-api-key": apiKey }, options));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    for (const raw of models) {
      const model = objectRecord(raw);
      if (!model) continue;
      const methods = Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (methods.length > 0 && !methods.includes("generateContent")) continue;
      addDiscoveredModel(modelsById, model.name, model, true);
    }
    const next = boundedString(payload?.nextPageToken, 2_048);
    if (!next) return finalizeDiscoveredModels("google", modelsById);
    pageToken = next;
  }
  throw new ProviderModelDiscoveryError("google", `google model discovery exceeded ${MAX_PAGES} pages`);
}

async function discoverAnthropic(apiKey: string, options: ProviderModelDiscoveryOptions): Promise<readonly string[]> {
  const modelsById = new Map<string, DiscoveredModelPricingTier>();
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const oauth = apiKey.includes("sk-ant-oat");
    const payload = objectRecord(await requestJson("anthropic", url, oauth ? {
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "x-app": "cli",
    } : {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }, options));
    const data = Array.isArray(payload?.data) ? payload.data : [];
    for (const raw of data) {
      const model = objectRecord(raw);
      if (model) addDiscoveredModel(modelsById, model.id, model);
    }
    if (payload?.has_more !== true) return finalizeDiscoveredModels("anthropic", modelsById);
    const next = boundedString(payload?.last_id, 256);
    if (!next || next === afterId) {
      throw new ProviderModelDiscoveryError("anthropic", "anthropic model discovery returned an invalid pagination cursor");
    }
    afterId = next;
  }
  throw new ProviderModelDiscoveryError("anthropic", `anthropic model discovery exceeded ${MAX_PAGES} pages`);
}

const OPENAI_STYLE_MODEL_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://api.openai.com/v1/models",
  deepseek: "https://api.deepseek.com/models",
  groq: "https://api.groq.com/openai/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  nvidia: "https://integrate.api.nvidia.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
});

async function discoverOpenAiStyle(
  provider: string,
  apiKey: string,
  options: ProviderModelDiscoveryOptions,
): Promise<readonly string[]> {
  const endpoint = OPENAI_STYLE_MODEL_ENDPOINTS[provider];
  if (!endpoint) throw new Error(`Live model discovery is not configured for provider ${provider}`);
  const payload = await requestJson(provider, new URL(endpoint), { authorization: `Bearer ${apiKey}` }, options);
  const record = objectRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : Array.isArray(payload) ? payload : [];
  const modelsById = new Map<string, DiscoveredModelPricingTier>();
  for (const raw of data) {
    const model = objectRecord(raw);
    if (model) addDiscoveredModel(modelsById, model.id, model);
  }
  return finalizeDiscoveredModels(provider, modelsById);
}


async function discoverXai(apiKey: string, options: ProviderModelDiscoveryOptions): Promise<readonly string[]> {
  const payload = objectRecord(await requestJson(
    "xai",
    new URL("https://api.x.ai/v1/language-models"),
    { authorization: `Bearer ${apiKey}` },
    options,
  ));
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const modelsById = new Map<string, DiscoveredModelPricingTier>();
  for (const raw of models) {
    const model = objectRecord(raw);
    if (!model) continue;
    addDiscoveredModel(modelsById, model.id, model);
    if (Array.isArray(model.aliases)) {
      for (const alias of model.aliases) addDiscoveredModel(modelsById, alias, model);
    }
  }
  return finalizeDiscoveredModels("xai", modelsById);
}

const LIVE_DISCOVERY_PROVIDERS = Object.freeze(new Set([
  "google",
  "openai",
  "anthropic",
  "deepseek",
  "xai",
  "groq",
  "mistral",
  "nvidia",
  "openrouter",
]));

export function supportsLiveModelDiscovery(providerInput: string): boolean {
  return LIVE_DISCOVERY_PROVIDERS.has(providerInput.trim().toLowerCase());
}

/**
 * Ask the provider for the models currently visible to one credential.
 * Provider responses are the source of truth for model ids; discovered ids are
 * registered immediately so runtime execution does not depend on a shipped list.
 */
export async function discoverAvailableModelIds(
  providerInput: string,
  apiKeyInput: string,
  options: ProviderModelDiscoveryOptions = {},
): Promise<readonly string[]> {
  const provider = providerInput.trim().toLowerCase();
  if (!supportsLiveModelDiscovery(provider)) {
    throw new Error(`Live model discovery is not supported for provider ${provider || "(empty)"}; FRIDAY does not fall back to a hardcoded model list`);
  }
  const apiKey = validateApiKey(apiKeyInput);
  DISCOVERED_MODEL_PRICING.delete(provider);
  const ids = provider === "google"
    ? await discoverGoogle(apiKey, options)
    : provider === "anthropic"
      ? await discoverAnthropic(apiKey, options)
      : provider === "xai"
        ? await discoverXai(apiKey, options)
        : await discoverOpenAiStyle(provider, apiKey, options);
  registerDiscoveredModelIds(provider, ids);
  return ids;
}
