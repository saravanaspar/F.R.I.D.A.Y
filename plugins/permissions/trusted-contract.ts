import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { TrustedIdentityRole } from "./contract.js";

export interface ChannelIdentitySelector {
  readonly channel: string;
  readonly accountId: string;
  readonly senderId: string;
}

export interface ChannelPrincipalSelector extends ChannelIdentitySelector {
  readonly conversationId?: string | undefined;
  readonly threadId?: string | undefined;
}

export interface TrustedChannelIdentity extends ChannelIdentitySelector {
  readonly id: string;
  readonly role: TrustedIdentityRole;
  readonly label: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TrustChannelIdentityInput extends ChannelIdentitySelector {
  readonly role?: TrustedIdentityRole | undefined;
  readonly label?: string | undefined;
}

export interface PermissionsTrustedService {
  identities(): readonly TrustedChannelIdentity[];
  trustChannelIdentity(input: TrustChannelIdentityInput): TrustedChannelIdentity;
  revokeChannelIdentity(selector: ChannelIdentitySelector): boolean;
  runAsLocal<T>(operation: () => T): T;
  runAsSystem<T>(service: string, operation: () => T): T;
  runAsChannel<T>(selector: ChannelPrincipalSelector, operation: () => T): T;
  runAsJob?<T>(jobId: string, operation: () => T): T;
}

export const PERMISSIONS_TRUSTED_CAPABILITY: Capability<PermissionsTrustedService> =
  defineCapability<PermissionsTrustedService>("permissions.trusted");
