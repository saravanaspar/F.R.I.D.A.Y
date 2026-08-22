import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { VaultMetadata } from "./contract.js";

export interface VaultSecretInput {
  readonly ref: string;
  readonly kind: string;
  readonly secret: string | Uint8Array;
}

/**
 * Trusted host-only Vault capability.
 *
 * There is deliberately no getSecret/readSecret method. Secret bytes only
 * exist inside consume() for the lifetime of a trusted callback and are wiped
 * immediately afterward.
 */
export interface VaultTrustedService {
  create(input: VaultSecretInput): VaultMetadata;
  rotate(ref: string, secret: string | Uint8Array): VaultMetadata;
  remove(ref: string): boolean;
  consume(ref: string, consumer: (secret: Uint8Array) => void | Promise<void>): Promise<void>;
  /** Optional for compatibility with trusted Vault providers predating recovery kits. */
  createRecoveryKit?(passphrase: string): Uint8Array;
  recoverFromKit?(kit: Uint8Array, passphrase: string, options?: { replaceExisting?: boolean | undefined }): void;
}

export const VAULT_TRUSTED_CAPABILITY: Capability<VaultTrustedService> =
  defineCapability<VaultTrustedService>("vault.trusted");
