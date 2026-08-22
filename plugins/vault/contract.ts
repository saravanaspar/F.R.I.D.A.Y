import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface VaultMetadata {
  readonly ref: string;
  readonly kind: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Safe, metadata-only Vault surface. This capability is suitable for routing,
 * prompts, tools, and other model-adjacent code because it can never return a
 * secret value or mutate secret material.
 */
export interface VaultMetadataService {
  normalizeRef(ref: string): string;
  exists(ref: string): boolean;
  inspect(ref: string): VaultMetadata | undefined;
  list(prefix?: string): readonly VaultMetadata[];
}

export const VAULT_CAPABILITY: Capability<VaultMetadataService> =
  defineCapability<VaultMetadataService>("vault");
