const VAULT_REF_PATTERN = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,7}$/;
const VAULT_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_VAULT_REF_LENGTH = 320;

export function normalizeVaultRef(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_VAULT_REF_LENGTH ||
    !VAULT_REF_PATTERN.test(normalized)
  ) {
    throw new Error(`Invalid vault reference: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function normalizeVaultKind(value: string): string {
  const normalized = value.trim();
  if (!VAULT_KIND_PATTERN.test(normalized)) {
    throw new Error(`Invalid vault secret kind: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function vaultRefMatchesPrefix(ref: string, prefix: string): boolean {
  const normalizedRef = normalizeVaultRef(ref);
  const normalizedPrefix = normalizeVaultRef(prefix);
  return normalizedRef === normalizedPrefix || normalizedRef.startsWith(`${normalizedPrefix}/`);
}
