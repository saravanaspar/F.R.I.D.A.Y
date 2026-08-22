const DEFAULT_OAUTH_TIMEOUT_MS = 30_000;

export function oauthSignal(signal?: AbortSignal | null, timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function oauthFetch(input: string | URL | Request, init: RequestInit = {}, timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS): Promise<Response> {
  return fetch(input, { ...init, signal: oauthSignal(init.signal, timeoutMs) });
}
