import { createHash } from "node:crypto";
import { join } from "node:path";

/** Structural origin shared by ingress, routing, sessions, memory, and jobs. */
export interface PrincipalOrigin {
  readonly authority: "local" | "channel";
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
  /** Host-owned internal Conversation id used for shared continuity, never authorization identity. */
  readonly sharedConversationId?: string | undefined;
}

function normalized(value: string): string {
  return value.normalize("NFKC").replaceAll("\u0000", "\ufffd").trim();
}

/** Opaque stable ownership key; remote transport identifiers never become path text. */
export function principalScope(origin: PrincipalOrigin): string {
  if (origin.authority === "local") return "local:operator";
  const digest = createHash("sha256").update(JSON.stringify([
    normalized(origin.channel),
    normalized(origin.accountId),
    normalized(origin.conversationId),
    normalized(origin.senderId),
    normalized(origin.threadId ?? ""),
  ])).digest("hex").slice(0, 32);
  return `channel:${digest}`;
}

/** Opaque shared Conversation ownership key. User identity remains principalScope(origin). */
export function conversationScope(conversationId: string): string {
  const value = normalized(conversationId);
  if (!value) throw new Error("Conversation id must not be empty");
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `conversation:${digest}`;
}

/** Continuity key for routing/session context; never use this as the caller authorization identity. */
export function continuityScope(origin: PrincipalOrigin): string {
  return origin.sharedConversationId?.trim()
    ? conversationScope(origin.sharedConversationId)
    : principalScope(origin);
}

export function samePrincipalOrigin(left: PrincipalOrigin, right: PrincipalOrigin): boolean {
  return principalScope(left) === principalScope(right);
}

export function sameContinuityOrigin(left: PrincipalOrigin, right: PrincipalOrigin): boolean {
  return continuityScope(left) === continuityScope(right);
}

/** Legacy unowned state belongs only to the local operator. */
export function ownerScopeAllows(ownerScope: string | undefined, origin: PrincipalOrigin): boolean {
  if (ownerScope === undefined) return origin.authority === "local";
  if (ownerScope === principalScope(origin)) return true;
  const sharedConversationId = origin.sharedConversationId?.trim();
  return Boolean(sharedConversationId)
    && ownerScope === conversationScope(sharedConversationId!);
}

export function principalStateSegment(origin: PrincipalOrigin): string {
  return principalScope(origin).replace(":", "-");
}

export function principalStateRoot(base: string, origin: PrincipalOrigin): string {
  return ownerStateRoot(base, principalScope(origin));
}

export function ownerStateRoot(base: string, ownerScope: string | undefined): string {
  if (ownerScope === undefined || ownerScope === "local:operator") return base;
  if (!/^(?:channel|conversation):[a-f0-9]{32}$/.test(ownerScope)) throw new Error("Invalid principal owner scope");
  return join(base, "principals", ownerScope.replace(":", "-"));
}
