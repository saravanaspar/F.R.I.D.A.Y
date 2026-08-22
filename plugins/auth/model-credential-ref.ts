import { createHash } from "node:crypto";

const SAFE_VAULT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Produce the one canonical Vault ref used for a model provider's API key. */
export function modelCredentialVaultRef(providerInput: string): string {
  const provider = providerInput.trim();
  if (!provider || provider.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(provider)) {
    throw new Error("provider is invalid");
  }
  const segment = SAFE_VAULT_SEGMENT.test(provider)
    ? provider
    : `provider-${createHash("sha256").update(provider).digest("hex").slice(0, 48)}`;
  return `vault://models/${segment}/api-key`;
}
