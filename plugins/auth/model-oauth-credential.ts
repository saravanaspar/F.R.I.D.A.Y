export interface StoredModelOAuthCredential extends Readonly<Record<string, unknown>> {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

export function encodeModelOAuthCredential(credentials: Readonly<Record<string, unknown>>): Uint8Array {
  const text = JSON.stringify(credentials);
  if (!text || text.length > 128_000) throw new Error("OAuth credential bundle is invalid or too large");
  return Buffer.from(text, "utf8");
}

export function decodeModelOAuthCredential(bytes: Uint8Array, provider: string): StoredModelOAuthCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`Stored OAuth credential for ${provider} is invalid`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored OAuth credential for ${provider} is invalid`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.access !== "string" || typeof record.refresh !== "string" || typeof record.expires !== "number") {
    throw new Error(`Stored OAuth credential for ${provider} is incomplete`);
  }
  return record as StoredModelOAuthCredential;
}
