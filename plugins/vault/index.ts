import * as vault from "@friday/vault";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { VAULT_CAPABILITY, type VaultMetadataService } from "./contract.js";
import {
  VAULT_TRUSTED_CAPABILITY,
  type VaultSecretInput,
  type VaultTrustedService,
} from "./trusted-contract.js";

export interface VaultPluginOptions {
  readonly stateDir?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

export function createVaultPlugin(options: VaultPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "vault", provides: [VAULT_CAPABILITY, VAULT_TRUSTED_CAPABILITY] }, (ctx) => {
    const store = new vault.VaultStore({
      stateDir: options.stateDir ?? vault.getVaultStateDir(),
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
    });

    const metadata: VaultMetadataService = Object.freeze({
      normalizeRef: (ref: string) => store.normalizeRef(ref),
      exists: (ref: string) => store.exists(ref),
      inspect: (ref: string) => store.inspect(ref),
      list: (prefix?: string) => store.list(prefix),
    });

    const trusted: VaultTrustedService = Object.freeze({
      create: (input: VaultSecretInput) => store.create(input),
      rotate: (ref: string, secret: string | Uint8Array) => store.rotate(ref, secret),
      remove: (ref: string) => store.remove(ref),
      consume: (
        ref: string,
        consumer: (secret: Uint8Array) => void | Promise<void>,
      ) => store.consume(ref, consumer),
      createRecoveryKit: (passphrase: string) => store.createRecoveryKit(passphrase),
      recoverFromKit: (
        kit: Uint8Array,
        passphrase: string,
        recoveryOptions?: vault.VaultRecoveryOptions,
      ) => store.recoverFromKit(kit, passphrase, recoveryOptions),
    });

    ctx.services.provide(VAULT_CAPABILITY, metadata);
    ctx.services.provide(VAULT_TRUSTED_CAPABILITY, trusted);
  });
}

export default createVaultPlugin();
