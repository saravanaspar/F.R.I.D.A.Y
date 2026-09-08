const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function createOAuthState(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error("OAuth state byte length must be between 16 and 128");
  }
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("A cryptographically secure random source is required for OAuth");
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function oauthCallbackHost(environment: NodeJS.ProcessEnv = process.env): string {
  const host = environment.FRIDAY_OAUTH_CALLBACK_HOST?.trim() || DEFAULT_CALLBACK_HOST;
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!LOOPBACK_HOSTS.has(normalized.toLowerCase())) {
    throw new Error(
      `FRIDAY_OAUTH_CALLBACK_HOST must be loopback-only (127.0.0.1, ::1, or localhost); received ${JSON.stringify(host)}`,
    );
  }
  return normalized;
}
