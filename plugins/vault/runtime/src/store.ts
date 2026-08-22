import {
  createCipheriv,
  createDecipheriv,
  randomBytes as cryptoRandomBytes,
  scryptSync,
} from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeVaultKind, normalizeVaultRef, vaultRefMatchesPrefix } from "./ref.js";
import {
  MAX_SECRET_BYTES,
  VAULT_IV_BYTES,
  assertVaultOutsideWorkspace,
  installMasterKey,
  loadMasterKey,
  loadOrCreateMasterKey,
  loadVaultState,
  recordKey,
  saveVaultState,
  type StoredVaultRecord,
} from "./storage.js";
import type {
  VaultCreateInput,
  VaultSecretConsumer,
  VaultSecretMetadata,
  VaultRecoveryOptions,
  VaultStoreOptions,
} from "./types.js";

const RECOVERY_SCHEMA = 1 as const;
const RECOVERY_SALT_BYTES = 16;
const RECOVERY_MAX_BYTES = 64 * 1024;
const RECOVERY_SCRYPT_N = 32_768;
const RECOVERY_SCRYPT_R = 8;
const RECOVERY_SCRYPT_P = 1;

interface VaultRecoveryKit {
  readonly schema: typeof RECOVERY_SCHEMA;
  readonly createdAt: string;
  readonly kdf: "scrypt";
  readonly n: typeof RECOVERY_SCRYPT_N;
  readonly r: typeof RECOVERY_SCRYPT_R;
  readonly p: typeof RECOVERY_SCRYPT_P;
  readonly salt: string;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function recoveryPassphrase(value: string): Buffer {
  if (typeof value !== "string" || value.length < 12 || value.length > 1_024) {
    throw new Error("Vault recovery passphrase must contain 12 to 1024 characters");
  }
  return Buffer.from(value, "utf8");
}

function recoveryAad(kit: Omit<VaultRecoveryKit, "tag" | "ciphertext">): Buffer {
  return Buffer.from(JSON.stringify(kit), "utf8");
}

function canonicalBase64(value: unknown, label: string, exactBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`Vault recovery kit ${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (exactBytes !== undefined && decoded.byteLength !== exactBytes)) {
    decoded.fill(0);
    throw new Error(`Vault recovery kit ${label} is invalid`);
  }
  return decoded;
}

function parseRecoveryKit(value: Uint8Array): VaultRecoveryKit {
  if (value.byteLength === 0 || value.byteLength > RECOVERY_MAX_BYTES) {
    throw new Error("Vault recovery kit has an invalid size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("Vault recovery kit is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Vault recovery kit must contain an object");
  }
  const kit = parsed as Record<string, unknown>;
  if (
    kit.schema !== RECOVERY_SCHEMA || kit.kdf !== "scrypt" || kit.n !== RECOVERY_SCRYPT_N ||
    kit.r !== RECOVERY_SCRYPT_R || kit.p !== RECOVERY_SCRYPT_P || kit.algorithm !== "aes-256-gcm" ||
    typeof kit.createdAt !== "string" || !Number.isFinite(Date.parse(kit.createdAt))
  ) {
    throw new Error("Vault recovery kit metadata is unsupported or malformed");
  }
  const salt = canonicalBase64(kit.salt, "salt", RECOVERY_SALT_BYTES);
  const iv = canonicalBase64(kit.iv, "iv", VAULT_IV_BYTES);
  const tag = canonicalBase64(kit.tag, "tag", 16);
  const ciphertext = canonicalBase64(kit.ciphertext, "ciphertext", 32);
  salt.fill(0);
  iv.fill(0);
  tag.fill(0);
  ciphertext.fill(0);
  return kit as unknown as VaultRecoveryKit;
}

function metadata(record: StoredVaultRecord): VaultSecretMetadata {
  return Object.freeze({
    ref: record.ref,
    kind: record.kind,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function secretBytes(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.byteLength === 0) {
    bytes.fill(0);
    throw new Error("Vault secrets must not be empty");
  }
  if (bytes.byteLength > MAX_SECRET_BYTES) {
    bytes.fill(0);
    throw new Error(`Vault secret exceeds the ${MAX_SECRET_BYTES}-byte limit`);
  }
  return bytes;
}

function associatedData(record: Pick<StoredVaultRecord, "ref" | "kind" | "version" | "createdAt" | "updatedAt">): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      ref: record.ref,
      kind: record.kind,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }),
    "utf8",
  );
}

function encryptSecret(
  record: Omit<StoredVaultRecord, "cipher">,
  secret: Buffer,
  masterKey: Buffer,
  randomBytes: (size: number) => Buffer,
): StoredVaultRecord {
  const iv = randomBytes(VAULT_IV_BYTES);
  if (!Buffer.isBuffer(iv) || iv.byteLength !== VAULT_IV_BYTES) {
    iv.fill?.(0);
    throw new Error("Vault random source returned an invalid IV");
  }
  const aad = associatedData(record);
  try {
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    try {
      return {
        ...record,
        cipher: {
          algorithm: "aes-256-gcm",
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: encrypted.toString("base64"),
        },
      };
    } finally {
      encrypted.fill(0);
    }
  } finally {
    iv.fill(0);
    aad.fill(0);
  }
}

function decryptSecret(record: StoredVaultRecord, masterKey: Buffer): Buffer {
  const iv = Buffer.from(record.cipher.iv, "base64");
  const tag = Buffer.from(record.cipher.tag, "base64");
  const ciphertext = Buffer.from(record.cipher.ciphertext, "base64");
  const aad = associatedData(record);
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(`Vault secret authentication failed for ${record.ref}`);
  } finally {
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
  }
}

export function getVaultStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = environment.FRIDAY_HOME?.trim();
  const root = configuredHome
    ? isAbsolute(configuredHome)
      ? configuredHome
      : resolve(configuredHome)
    : join(homedir(), ".friday");
  return join(root, "vault");
}

export class VaultStore {
  readonly stateDir: string;
  readonly #workspaceRoot: string;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(options: VaultStoreOptions) {
    if (!options.stateDir.trim()) throw new Error("Vault store requires a state directory");
    this.stateDir = resolve(options.stateDir);
    this.#workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    assertVaultOutsideWorkspace(this.stateDir, this.#workspaceRoot);
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  #assertBoundary(): void {
    assertVaultOutsideWorkspace(this.stateDir, this.#workspaceRoot);
  }

  normalizeRef(ref: string): string {
    return normalizeVaultRef(ref);
  }

  exists(ref: string): boolean {
    this.#assertBoundary();
    const normalized = normalizeVaultRef(ref);
    return loadVaultState(this.stateDir).records[recordKey(normalized)] !== undefined;
  }

  inspect(ref: string): VaultSecretMetadata | undefined {
    this.#assertBoundary();
    const normalized = normalizeVaultRef(ref);
    const record = loadVaultState(this.stateDir).records[recordKey(normalized)];
    return record ? metadata(record) : undefined;
  }

  list(prefix?: string): readonly VaultSecretMetadata[] {
    this.#assertBoundary();
    const normalizedPrefix = prefix === undefined ? undefined : normalizeVaultRef(prefix);
    return Object.values(loadVaultState(this.stateDir).records)
      .filter((record) => normalizedPrefix === undefined || vaultRefMatchesPrefix(record.ref, normalizedPrefix))
      .sort((left, right) => left.ref.localeCompare(right.ref))
      .map((record) => metadata(record));
  }

  create(input: VaultCreateInput): VaultSecretMetadata {
    this.#assertBoundary();
    const ref = normalizeVaultRef(input.ref);
    const kind = normalizeVaultKind(input.kind);
    const secret = secretBytes(input.secret);
    let masterKey: Buffer | undefined;
    try {
      const state = loadVaultState(this.stateDir);
      const key = recordKey(ref);
      if (state.records[key]) throw new Error(`Vault secret already exists: ${ref}`);
      const timestamp = this.#now().toISOString();
      masterKey = Object.keys(state.records).length === 0
        ? loadOrCreateMasterKey(this.stateDir, this.#randomBytes)
        : loadMasterKey(this.stateDir);
      const record = encryptSecret(
        { ref, kind, version: 1, createdAt: timestamp, updatedAt: timestamp },
        secret,
        masterKey,
        this.#randomBytes,
      );
      const nextState = { ...state, records: { ...state.records, [key]: record } };
      saveVaultState(this.stateDir, nextState);
      return metadata(record);
    } finally {
      secret.fill(0);
      masterKey?.fill(0);
    }
  }

  rotate(ref: string, secretValue: string | Uint8Array): VaultSecretMetadata {
    this.#assertBoundary();
    const normalized = normalizeVaultRef(ref);
    const secret = secretBytes(secretValue);
    let masterKey: Buffer | undefined;
    try {
      const state = loadVaultState(this.stateDir);
      const key = recordKey(normalized);
      const current = state.records[key];
      if (!current) throw new Error(`Unknown vault secret: ${normalized}`);
      if (current.version >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`Vault secret version cannot be incremented: ${normalized}`);
      }
      const timestamp = this.#now().toISOString();
      masterKey = loadMasterKey(this.stateDir);
      const record = encryptSecret(
        {
          ref: current.ref,
          kind: current.kind,
          version: current.version + 1,
          createdAt: current.createdAt,
          updatedAt: timestamp,
        },
        secret,
        masterKey,
        this.#randomBytes,
      );
      const nextState = { ...state, records: { ...state.records, [key]: record } };
      saveVaultState(this.stateDir, nextState);
      return metadata(record);
    } finally {
      secret.fill(0);
      masterKey?.fill(0);
    }
  }

  remove(ref: string): boolean {
    this.#assertBoundary();
    const normalized = normalizeVaultRef(ref);
    const state = loadVaultState(this.stateDir);
    const key = recordKey(normalized);
    if (!state.records[key]) return false;
    const records = { ...state.records };
    delete records[key];
    saveVaultState(this.stateDir, { ...state, records });
    return true;
  }

  async consume(ref: string, consumer: VaultSecretConsumer): Promise<void> {
    this.#assertBoundary();
    const normalized = normalizeVaultRef(ref);
    const state = loadVaultState(this.stateDir);
    const record = state.records[recordKey(normalized)];
    if (!record) throw new Error(`Unknown vault secret: ${normalized}`);
    const masterKey = loadMasterKey(this.stateDir);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptSecret(record, masterKey);
      await consumer(plaintext);
    } finally {
      plaintext?.fill(0);
      masterKey.fill(0);
    }
  }

  /**
   * Produce a portable, passphrase-encrypted copy of the Vault master key.
   * Secret values and ciphertext records are not copied into the kit.
   */
  createRecoveryKit(passphraseValue: string): Uint8Array {
    this.#assertBoundary();
    const passphrase = recoveryPassphrase(passphraseValue);
    const masterKey = loadMasterKey(this.stateDir);
    const salt = this.#randomBytes(RECOVERY_SALT_BYTES);
    const iv = this.#randomBytes(VAULT_IV_BYTES);
    let wrappingKey: Buffer | undefined;
    let aad: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    try {
      if (salt.byteLength !== RECOVERY_SALT_BYTES || iv.byteLength !== VAULT_IV_BYTES) {
        throw new Error("Vault random source returned invalid recovery material");
      }
      wrappingKey = scryptSync(passphrase, salt, 32, {
        N: RECOVERY_SCRYPT_N,
        r: RECOVERY_SCRYPT_R,
        p: RECOVERY_SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      });
      const base: Omit<VaultRecoveryKit, "tag" | "ciphertext"> = {
        schema: RECOVERY_SCHEMA,
        createdAt: this.#now().toISOString(),
        kdf: "scrypt" as const,
        n: RECOVERY_SCRYPT_N,
        r: RECOVERY_SCRYPT_R,
        p: RECOVERY_SCRYPT_P,
        salt: salt.toString("base64"),
        algorithm: "aes-256-gcm" as const,
        iv: iv.toString("base64"),
      };
      aad = recoveryAad(base);
      const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
      cipher.setAAD(aad);
      ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
      const kit: VaultRecoveryKit = {
        ...base,
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      return Buffer.from(`${JSON.stringify(kit)}\n`, "utf8");
    } finally {
      passphrase.fill(0);
      masterKey.fill(0);
      salt.fill(0);
      iv.fill(0);
      wrappingKey?.fill(0);
      aad?.fill(0);
      ciphertext?.fill(0);
    }
  }

  /** Recover a missing/corrupt key only after authenticating every current record. */
  recoverFromKit(
    kitBytes: Uint8Array,
    passphraseValue: string,
    options: VaultRecoveryOptions = {},
  ): void {
    this.#assertBoundary();
    const kit = parseRecoveryKit(kitBytes);
    const passphrase = recoveryPassphrase(passphraseValue);
    const salt = canonicalBase64(kit.salt, "salt", RECOVERY_SALT_BYTES);
    const iv = canonicalBase64(kit.iv, "iv", VAULT_IV_BYTES);
    const tag = canonicalBase64(kit.tag, "tag", 16);
    const ciphertext = canonicalBase64(kit.ciphertext, "ciphertext", 32);
    let wrappingKey: Buffer | undefined;
    let aad: Buffer | undefined;
    let candidate: Buffer | undefined;
    try {
      wrappingKey = scryptSync(passphrase, salt, 32, {
        N: RECOVERY_SCRYPT_N,
        r: RECOVERY_SCRYPT_R,
        p: RECOVERY_SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      });
      aad = recoveryAad({
        schema: kit.schema,
        createdAt: kit.createdAt,
        kdf: kit.kdf,
        n: kit.n,
        r: kit.r,
        p: kit.p,
        salt: kit.salt,
        algorithm: kit.algorithm,
        iv: kit.iv,
      });
      try {
        const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        candidate = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new Error("Vault recovery passphrase or kit is invalid");
      }
      if (candidate.byteLength !== 32) throw new Error("Vault recovery key has an invalid length");

      // A correctly decrypted kit may still belong to a different Vault. Test
      // every authenticated record before touching the local master-key file.
      const state = loadVaultState(this.stateDir);
      for (const record of Object.values(state.records)) {
        const plaintext = decryptSecret(record, candidate);
        plaintext.fill(0);
      }
      installMasterKey(this.stateDir, candidate, options.replaceExisting === true);
    } finally {
      passphrase.fill(0);
      salt.fill(0);
      iv.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
      wrappingKey?.fill(0);
      aad?.fill(0);
      candidate?.fill(0);
    }
  }
}
