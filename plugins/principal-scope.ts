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

export function samePrincipalOrigin(left: PrincipalOrigin, right: PrincipalOrigin): boolean {
  return principalScope(left) === principalScope(right);
}

/** Legacy unowned state belongs only to the local operator. */
export function ownerScopeAllows(ownerScope: string | undefined, origin: PrincipalOrigin): boolean {
  return ownerScope === undefined
    ? origin.authority === "local"
    : ownerScope === principalScope(origin);
}

export function principalStateSegment(origin: PrincipalOrigin): string {
  return principalScope(origin).replace(":", "-");
}

export function principalStateRoot(base: string, origin: PrincipalOrigin): string {
  return ownerStateRoot(base, principalScope(origin));
}

export function ownerStateRoot(base: string, ownerScope: string | undefined): string {
  if (ownerScope === undefined || ownerScope === "local:operator") return base;
  if (!/^channel:[a-f0-9]{32}$/.test(ownerScope)) throw new Error("Invalid principal owner scope");
  return join(base, "principals", ownerScope.replace(":", "-"));
}
