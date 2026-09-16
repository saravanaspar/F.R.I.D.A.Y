import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type RoutingDestinationKind = "session" | "transient" | "scheduler" | "system";
export type RoutingExecutionProfile = "agent" | "utility" | "scheduler" | "system";
export type RoutingCapabilityProfile = "none" | "computer" | "general";

/**
 * Exact host-control intent for stopping FRIDAY-owned Computer work.
 * Kept in the Routing contract so both the router and Turn Loop use the same
 * bounded detector without depending on each other's runtime implementation.
 */
export function isComputerCleanupCommand(text: string): boolean {
  let normalized = text.trim().toLowerCase().replaceAll("/", " ").replaceAll("-", " ");
  for (const prefix of ["please ", "can you ", "can u ", "could you ", "could u ", "would you ", "would u "] as const) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trimStart();
      break;
    }
  }
  const actions = ["clean up", "cleanup", "terminate", "cancel", "close", "kill", "stop"] as const;
  const targets = ["computer", "headless", "screen", "browser"] as const;
  const startsWithTerm = (value: string, term: string): boolean => value === term || value.startsWith(`${term} `);
  const containsTerm = (value: string, term: string): boolean => value === term
    || value.startsWith(`${term} `)
    || value.endsWith(` ${term}`)
    || value.includes(` ${term} `);
  const bounded = normalized.slice(0, 160);
  const actionFirst = actions.find((action) => startsWithTerm(bounded, action));
  if (actionFirst) {
    const rest = bounded.slice(actionFirst.length).trimStart();
    return targets.some((target) => containsTerm(rest, target));
  }
  const targetFirst = targets.find((target) => startsWithTerm(bounded, target));
  if (!targetFirst) return false;
  const rest = bounded.slice(targetFirst.length).trimStart();
  return actions.some((action) => containsTerm(rest, action));
}
/**
 * Read-only live Computer/browser/media status intent. Kept beside the cleanup
 * detector so Routing and Turn Loop cannot drift on what counts as a Computer
 * status question. This deliberately excludes control verbs.
 */
export function isComputerStatusQuery(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 320) return false;
  const subject = /\b(?:computer|screen|browser|page|tab|youtube|video|song|music|media|playback|it)\b/.test(normalized);
  const status = /\b(?:play|playing|paused|running|stuck|working|doing|loaded|open|started|finish|finished|status)\b/.test(normalized);
  const interrogative = /^(?:is|are|was|were|did|does|has|have|what|where|how|status\b)/.test(normalized) || normalized.endsWith("?");
  const controlCommand = /^(?:open|play|pause|resume|stop|close|kill|click|type|search|navigate|go\s+to|switch)\b/.test(normalized);
  return subject && status && interrogative && !controlCommand;
}

export interface RoutingPrincipal {
  readonly authority: "local" | "channel";
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
  /** Host-owned internal Conversation id for shared routing/session continuity. */
  readonly sharedConversationId?: string | undefined;
}
export interface RoutingAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "sticker" | "other";
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface RoutingMessage {
  readonly id: string;
  readonly principal: RoutingPrincipal;
  readonly text: string;
  readonly attachments?: readonly RoutingAttachment[] | undefined;
  readonly timestamp: number;
}
export interface RoutingDestination {
  readonly kind: RoutingDestinationKind;
  readonly id: string;
}

export interface RoutingExecution {
  readonly profile: RoutingExecutionProfile;
  /**
   * Host-bounded capability surface for the selected execution path.
   * Optional for durable/backward compatibility; missing values are treated as
   * `general` by Agent execution so older admitted work never loses tools.
   */
  readonly capabilityProfile?: RoutingCapabilityProfile | undefined;
}

export interface RoutingDecision {
  readonly messageId: string;
  readonly destination: RoutingDestination;
  readonly execution: RoutingExecution;
  readonly confidence: number;
}

export interface RoutedMessage {
  readonly message: RoutingMessage;
  readonly decision: RoutingDecision;
}
export interface RoutingOptions {
  readonly signal?: AbortSignal | undefined;
}

export type RoutingListener = (routed: RoutedMessage) => void | Promise<void>;

export interface RoutingService {
  route(message: RoutingMessage, options?: RoutingOptions): Promise<RoutingDecision>;
  /**
   * Route a bounded burst from one continuity scope with a single classifier request.
   * Each returned decision is independently host-validated and ordered like input.
   */
  routeBatch?(messages: readonly RoutingMessage[], options?: RoutingOptions): Promise<readonly RoutingDecision[]>;
  subscribe(listener: RoutingListener): () => void;
  recentContext(principal: RoutingPrincipal): readonly RoutingMessage[];
}
export const ROUTING_CAPABILITY: Capability<RoutingService> =
  defineCapability<RoutingService>("routing");
