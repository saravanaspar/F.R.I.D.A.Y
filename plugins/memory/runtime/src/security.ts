const SECRET_MATERIAL = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization)\b\s*[:=]\s*[^\s]{8,}|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}))+/i;
const SECRET_FIELD = /^(?:authorization|cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|credential|private[_-]?key|client[_-]?secret)$/i;

/** Shared Memory-owned detector used before any durable user-memory write. */
export function containsMemorySecretMaterial(value: string): boolean {
  return SECRET_MATERIAL.test(value);
}

export function assertMemoryTextHasNoSecrets(value: string, label: string): void {
  if (containsMemorySecretMaterial(value)) {
    throw new Error(`${label} appears to contain authentication material; secrets belong in Vault, not Memory`);
  }
}

export function memoryFieldMayContainSecret(key: string): boolean {
  return SECRET_FIELD.test(key.trim());
}
