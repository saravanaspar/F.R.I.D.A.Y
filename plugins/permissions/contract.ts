import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type PermissionMode = "ask" | "auto" | "full";
export type WorkspaceAccess = "read" | "write";
export type PermissionEffect =
  | "public-read"
  | "private-read"
  | "global-operational-read"
  | "workspace-read"
  | "workspace-write"
  | "external-read"
  | "external-write"
  | "credential-write"
  | "system-write";
export type PermissionPrincipalKind = "local" | "system" | "channel";
export type TrustedIdentityRole = "read-only" | "operator";

export interface PermissionAction {
  /** Stable host-owned action identifier. Never derive authorization from model prose. */
  readonly id: string;
  readonly effect: PermissionEffect;
  readonly resource: string;
  readonly network: boolean;
}

export interface PermissionPrincipalView {
  readonly id: string;
  readonly kind: PermissionPrincipalKind;
  readonly role: TrustedIdentityRole;
  readonly label: string;
  readonly channel?: string | undefined;
  readonly accountId?: string | undefined;
  readonly senderId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly threadId?: string | undefined;
}

export interface PermissionRequest {
  readonly mode: PermissionMode;
  readonly workspace: string;
  readonly access: WorkspaceAccess;
  readonly path?: string | undefined;
  readonly action: PermissionAction;
  /** Human-readable context only. Policy must never classify authority from this field. */
  readonly reason: string;
}

export interface PermissionApprovalRequest extends PermissionRequest {
  readonly principal: PermissionPrincipalView;
}

export interface PermissionDecision {
  allowed: true;
  approvedBy: "policy" | "user";
}

export interface PermissionsService {
  normalizeMode(value?: string | undefined): PermissionMode;
  authorize(request: PermissionRequest): Promise<PermissionDecision>;
  assertWorkspacePath(workspace: string, path: string): string;
}

export function permissionEffectAccess(effect: PermissionEffect): WorkspaceAccess {
  return effect === "public-read"
    || effect === "private-read"
    || effect === "global-operational-read"
    || effect === "workspace-read"
    || effect === "external-read"
    ? "read"
    : "write";
}

export const PERMISSIONS_CAPABILITY: Capability<PermissionsService> =
  defineCapability<PermissionsService>("permissions");
