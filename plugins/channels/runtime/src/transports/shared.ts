import type { ChannelChatType, ChannelPrincipal } from "../types.js";

export interface ChannelAccessPolicy {
  readonly allowAll?: boolean | undefined;
  readonly allowedSenderIds?: readonly string[] | undefined;
  readonly allowedConversationIds?: readonly string[] | undefined;
}

export interface SecretConsumer {
  consume(ref: string, consumer: (secret: Uint8Array) => void | Promise<void>): Promise<void>;
}

function normalizedSet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).map((value) => value.trim()).filter(Boolean));
}

export function channelPrincipalAllowed(
  principal: ChannelPrincipal,
  chatType: ChannelChatType,
  policy: ChannelAccessPolicy,
): boolean {
  if (policy.allowAll === true) return true;
  const senders = normalizedSet(policy.allowedSenderIds);
  const conversations = normalizedSet(policy.allowedConversationIds);
  if (senders.has(principal.senderId)) return true;
  if (chatType !== "dm" && conversations.has(principal.conversationId)) return true;
  return false;
}

export function splitChannelMessage(text: string, maxLength: number): readonly string[] {
  if (!Number.isInteger(maxLength) || maxLength < 128) throw new Error("maxLength must be at least 128");
  if (text.length <= maxLength) return Object.freeze([text]);
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf("\n", maxLength);
    if (split < maxLength / 2) split = remaining.lastIndexOf(" ", maxLength);
    if (split < 1) split = maxLength;
    chunks.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return Object.freeze(chunks);
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withSecretText<T>(
  secrets: SecretConsumer,
  ref: string,
  consumer: (secret: string) => T | Promise<T>,
): Promise<T> {
  let completed = false;
  let value: T | undefined;
  await secrets.consume(ref, async (secret) => {
    const text = Buffer.from(secret).toString("utf8");
    value = await consumer(text);
    completed = true;
  });
  if (!completed) throw new Error("Secret consumer did not run");
  return value as T;
}

export function requireHttpUrl(value: string, label: string, options: { allowHttpLoopback?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not embed credentials`);
  if (parsed.protocol === "https:") return parsed;
  if (options.allowHttpLoopback === true && parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return parsed;
  throw new Error(`${label} must use HTTPS${options.allowHttpLoopback === true ? " or loopback HTTP" : ""}`);
}


export const DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS = 15_000;

/** Bound discrete channel HTTP operations while preserving caller cancellation. */
export async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs = DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("channel request timeout must be between 1 and 120000ms");
  }
  const timeoutSignal = AbortSignal.timeout(Math.floor(timeoutMs));
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return await fetcher(input, { ...init, signal });
}
