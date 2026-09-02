import { createHash } from "node:crypto";

const SAFE_VAULT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const API_KEY_PROVIDERS = new Set([
  "openai", "anthropic", "google", "deepseek", "xai", "groq", "cerebras", "openrouter",
  "mistral", "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "huggingface", "fireworks",
  "opencode", "opencode-go", "kimi-coding", "zai", "azure-openai-responses", "vercel-ai-gateway",
  "cloudflare-workers-ai", "cloudflare-ai-gateway", "xiaomi", "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

export function modelProviderTypicallyNeedsApiKey(providerInput: string): boolean {
  const provider = providerInput.trim();
  return provider.startsWith("custom:") || API_KEY_PROVIDERS.has(provider);
}

/** Produce the one canonical Vault ref used for a model provider's API key. */
export function modelCredentialVaultRef(providerInput: string): string {
  const provider = providerInput.trim();
  if (!provider || provider.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider)) {
    throw new Error("provider is invalid");
  }
  const segment = SAFE_VAULT_SEGMENT.test(provider)
    ? provider
    : `provider-${createHash("sha256").update(provider).digest("hex").slice(0, 48)}`;
  return `vault://models/${segment}/api-key`;
}
