import type { Api, CacheRetention, Model, OpenAICompletionsCompat } from "./types.js";

/**
 * Provider/model prompt-cache behavior.
 *
 * This deliberately describes transport semantics rather than a concrete
 * cache implementation. Unknown routes default to strict prefix reuse, the
 * conservative behavior that is safe for both cached and uncached providers.
 */
export type CacheSemantics =
  | Readonly<{ kind: "explicit-breakpoints"; maxBreakpoints: number }>
  | Readonly<{ kind: "implicit-tolerant" }>
  | Readonly<{ kind: "implicit-strict" }>
  | Readonly<{ kind: "uncached" }>;

const EXPLICIT_FOUR: CacheSemantics = Object.freeze({ kind: "explicit-breakpoints", maxBreakpoints: 4 });
const IMPLICIT_TOLERANT: CacheSemantics = Object.freeze({ kind: "implicit-tolerant" });
const IMPLICIT_STRICT: CacheSemantics = Object.freeze({ kind: "implicit-strict" });
const UNCACHED: CacheSemantics = Object.freeze({ kind: "uncached" });

const TOLERANT_OPENAI_COMPAT_PROVIDERS = new Set([
  "deepseek",
  "groq",
  "mistral",
  "fireworks",
  "moonshotai",
  "moonshotai-cn",
  "zai",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "opencode",
  "opencode-go",
]);

function openAICompletionsCompat(model: Model<Api>): OpenAICompletionsCompat | undefined {
  if (model.api !== "openai-completions") return undefined;
  return model.compat as OpenAICompletionsCompat | undefined;
}

export function getCacheSemantics(model: Model<Api>): CacheSemantics {
  if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") return EXPLICIT_FOUR;

  if (openAICompletionsCompat(model)?.cacheControlFormat === "anthropic") return EXPLICIT_FOUR;

  if (
    model.api === "openai-responses" ||
    model.api === "azure-openai-responses" ||
    model.api === "openai-codex-responses"
  ) {
    return IMPLICIT_STRICT;
  }

  if (model.api === "openai-completions") {
    if (model.provider === "openai" || model.provider === "github-copilot") return IMPLICIT_TOLERANT;
    if (TOLERANT_OPENAI_COMPAT_PROVIDERS.has(model.provider)) return IMPLICIT_TOLERANT;
    return IMPLICIT_STRICT;
  }

  if (model.api === "google-generative-ai" || model.api === "google-vertex") return IMPLICIT_STRICT;

  // The runtime does not currently expose explicit cache primitives for these
  // routes. Mark only routes we know are uncached; unknown custom routes stay
  // strict so callers do not infer unsupported cache behavior.
  if (model.api === "mistral-conversations" && model.provider === "mistral") return UNCACHED;

  return IMPLICIT_STRICT;
}

export function effectiveCacheSemantics(model: Model<Api>, retention: CacheRetention | undefined): CacheSemantics {
  return retention === "none" ? UNCACHED : getCacheSemantics(model);
}

/**
 * Return a validated stable prefix only when it is a real byte prefix of the
 * full prompt. Provider adapters call this before creating request-local wire
 * blocks so malformed metadata can never alter prompt text.
 */
export function validatedStablePromptPrefix(
  systemPrompt: string | undefined,
  stablePrefix: string | undefined,
): string | undefined {
  if (!systemPrompt || !stablePrefix || !systemPrompt.startsWith(stablePrefix)) return undefined;
  return stablePrefix;
}

/** Return request-local stable/volatile system blocks without altering prompt bytes. */
export function splitStableSystemPrompt(
  systemPrompt: string | undefined,
  stablePrefix: string | undefined,
): readonly [stablePrefix: string, volatileSuffix: string] | undefined {
  const validated = validatedStablePromptPrefix(systemPrompt, stablePrefix);
  if (!validated || !systemPrompt || validated === systemPrompt) return undefined;
  return Object.freeze([validated, systemPrompt.slice(validated.length)] as const);
}
