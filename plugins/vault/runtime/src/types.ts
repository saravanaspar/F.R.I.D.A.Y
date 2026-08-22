export interface VaultSecretMetadata {
  readonly ref: string;
  readonly kind: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VaultCreateInput {
  readonly ref: string;
  readonly kind: string;
  readonly secret: string | Uint8Array;
}

export type VaultSecretConsumer = (secret: Uint8Array) => void | Promise<void>;

export interface VaultStoreOptions {
  readonly stateDir: string;
  readonly workspaceRoot?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly randomBytes?: ((size: number) => Buffer) | undefined;
}

export interface VaultRecoveryOptions {
  /** Replace a present (for example corrupt) key after kit verification. */
  readonly replaceExisting?: boolean | undefined;
}
