export { normalizeVaultKind, normalizeVaultRef, vaultRefMatchesPrefix } from "./ref.js";
export {
  MAX_SECRET_BYTES,
  VAULT_MASTER_KEY_FILE_NAME,
  VAULT_STATE_FILE_NAME,
  VAULT_STATE_SCHEMA,
} from "./storage.js";
export { VaultStore, getVaultStateDir } from "./store.js";
export type {
  VaultCreateInput,
  VaultSecretConsumer,
  VaultSecretMetadata,
  VaultRecoveryOptions,
  VaultStoreOptions,
} from "./types.js";
