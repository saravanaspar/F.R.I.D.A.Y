import type { Api, KnownProvider, Model } from "./types.js";

/**
 * Provider-level transport configuration only.
 *
 * FRIDAY intentionally does not ship a model-id catalog. Model ids come from an
 * authenticated provider discovery call (or from an explicit custom endpoint).
 * These profiles only describe how to talk to each provider once a live model
 * id has been selected.
 */
export interface ProviderRuntimeProfile {
  readonly provider: KnownProvider;
  readonly api: Api | ((modelId: string) => Api);
  readonly baseUrl: string | ((modelId: string) => string);
}

function openAiFamilyApi(modelId: string): Api {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("claude-")) return "anthropic-messages";
  if (/^(?:gpt-5|o\d)/.test(id)) return "openai-responses";
  return "openai-completions";
}

function opencodeApi(modelId: string): Api {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("claude-") || id.startsWith("qwen")) return "anthropic-messages";
  if (id.startsWith("gemini-")) return "google-generative-ai";
  if (/^(?:gpt-5|o\d|grok-)/.test(id) || id.startsWith("muse-")) return "openai-responses";
  return "openai-completions";
}

function opencodeBaseUrl(modelId: string, root: string): string {
  const api = opencodeApi(modelId);
  return api === "anthropic-messages" ? root : `${root}/v1`;
}

function cloudflareGatewayApi(modelId: string): Api {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("claude-")) return "anthropic-messages";
  if (/^(?:gpt-|o\d)/.test(id)) return "openai-responses";
  return "openai-completions";
}

function cloudflareGatewayBaseUrl(modelId: string): string {
  const root = "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}";
  const api = cloudflareGatewayApi(modelId);
  if (api === "anthropic-messages") return `${root}/anthropic`;
  if (api === "openai-responses") return `${root}/openai`;
  return `${root}/compat`;
}

const PROFILES: Readonly<Record<KnownProvider, ProviderRuntimeProfile>> = Object.freeze({
  "amazon-bedrock": { provider: "amazon-bedrock", api: "bedrock-converse-stream", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" },
  anthropic: { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  google: { provider: "google", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  "google-vertex": { provider: "google-vertex", api: "google-vertex", baseUrl: "https://{location}-aiplatform.googleapis.com" },
  openai: { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "azure-openai-responses": { provider: "azure-openai-responses", api: "azure-openai-responses", baseUrl: "" },
  "openai-codex": { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
  deepseek: { provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
  "github-copilot": { provider: "github-copilot", api: openAiFamilyApi, baseUrl: "https://api.individual.githubcopilot.com" },
  xai: { provider: "xai", api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  groq: { provider: "groq", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  cerebras: { provider: "cerebras", api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  openrouter: { provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  "vercel-ai-gateway": { provider: "vercel-ai-gateway", api: "anthropic-messages", baseUrl: "https://ai-gateway.vercel.sh" },
  zai: { provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  mistral: { provider: "mistral", api: "mistral-conversations", baseUrl: "https://api.mistral.ai" },
  nvidia: { provider: "nvidia", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1" },
  minimax: { provider: "minimax", api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
  "minimax-cn": { provider: "minimax-cn", api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic" },
  moonshotai: { provider: "moonshotai", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { provider: "moonshotai-cn", api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
  huggingface: { provider: "huggingface", api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
  fireworks: { provider: "fireworks", api: "anthropic-messages", baseUrl: "https://api.fireworks.ai/inference" },
  opencode: { provider: "opencode", api: opencodeApi, baseUrl: (modelId) => opencodeBaseUrl(modelId, "https://opencode.ai/zen") },
  "opencode-go": { provider: "opencode-go", api: opencodeApi, baseUrl: (modelId) => opencodeBaseUrl(modelId, "https://opencode.ai/zen/go") },
  "kimi-coding": { provider: "kimi-coding", api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding" },
  "cloudflare-workers-ai": { provider: "cloudflare-workers-ai", api: "openai-completions", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" },
  "cloudflare-ai-gateway": { provider: "cloudflare-ai-gateway", api: cloudflareGatewayApi, baseUrl: cloudflareGatewayBaseUrl },
  xiaomi: { provider: "xiaomi", api: "anthropic-messages", baseUrl: "https://api.xiaomimimo.com/anthropic" },
  "xiaomi-token-plan-cn": { provider: "xiaomi-token-plan-cn", api: "anthropic-messages", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic" },
  "xiaomi-token-plan-ams": { provider: "xiaomi-token-plan-ams", api: "anthropic-messages", baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic" },
  "xiaomi-token-plan-sgp": { provider: "xiaomi-token-plan-sgp", api: "anthropic-messages", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic" },
});

export function getProviderRuntimeProfile(providerInput: string): ProviderRuntimeProfile | undefined {
  const provider = providerInput.trim() as KnownProvider;
  return PROFILES[provider];
}

export function getProviderRuntimeProfiles(): readonly ProviderRuntimeProfile[] {
  return Object.freeze(Object.values(PROFILES));
}

function resolve<T>(value: T | ((modelId: string) => T), modelId: string): T {
  return typeof value === "function" ? (value as (modelId: string) => T)(modelId) : value;
}

/**
 * Build a conservative runtime descriptor for a provider-returned model id.
 * No model ids are embedded in FRIDAY. Provider APIs are the source of model
 * availability; this object supplies only transport defaults needed to execute.
 */
export function createDiscoveredModel(providerInput: string, modelIdInput: string): Model<Api> | undefined {
  const profile = getProviderRuntimeProfile(providerInput);
  const modelId = modelIdInput.trim();
  if (!profile || !modelId) return undefined;
  const discovered: Model<Api> = {
    id: modelId,
    name: modelId,
    provider: profile.provider,
    api: resolve(profile.api, modelId),
    baseUrl: resolve(profile.baseUrl, modelId),
    reasoning: false,
    input: ["text"],
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    // Provider discovery endpoints are authoritative for identity/availability,
    // but most do not expose reliable context/output limits. Conservative
    // runtime defaults avoid pretending stale catalog metadata is authoritative.
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
  return Object.freeze(discovered);
}
