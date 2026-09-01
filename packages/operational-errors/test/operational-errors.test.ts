import { afterEach, describe, expect, it, vi } from "vitest";
import { installOperationalErrorSink, isSensitiveFieldName, redactSensitiveText, reportOperationalError, reportUnlessExpectedAbort, sanitizeOperationalError } from "../src/index.js";

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; vi.restoreAllMocks(); });

describe("operational failure reporting", () => {
  it("redacts secrets before sending structured records to the installed sink", () => {
    const events: unknown[] = [];
    uninstall = installOperationalErrorSink((event) => events.push(event));
    reportOperationalError({ component: "test", operation: "send", error: new Error("token=abc123 secret=hidden") });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("abc123");
    expect(JSON.stringify(events)).not.toContain("hidden");
  });


  it("redacts OAuth tokens, cookies, private keys, and query-string credentials consistently", () => {
    const input = [
      "access_token=oauth-access-value",
      "refresh_token:refresh-value",
      "client_secret=client-value",
      "session_token=session-value",
      "Cookie: friday_session=cookie-value",
      "Authorization: Bearer abcdefghijklmnop",
      "https://example.invalid/callback?api_key=query-key&safe=yes",
      "private_key=-----BEGIN-PRIVATE-KEY-----",
    ].join(" ");
    const redacted = redactSensitiveText(input, 10_000);
    for (const secret of [
      "oauth-access-value",
      "refresh-value",
      "client-value",
      "session-value",
      "cookie-value",
      "abcdefghijklmnop",
      "query-key",
      "-----BEGIN-PRIVATE-KEY-----",
    ]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("access_token=[REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("Cookie: [REDACTED]");
    expect(redacted).toContain("https://example.invalid/callback?api_key=[REDACTED]&safe=yes");
    expect(redactSensitiveText(redacted, 10_000)).toBe(redacted);
  });

  it("identifies structured credential field names without hiding unrelated fields", () => {
    for (const key of ["access_token", "refreshToken", "client_secret", "authorization", "set-cookie", "private_key", "credential"]) {
      expect(isSensitiveFieldName(key)).toBe(true);
    }
    for (const key of ["model", "provider", "operation", "durationMs"]) {
      expect(isSensitiveFieldName(key)).toBe(false);
    }
  });

  it("does not classify an intentional abort as an operational failure", () => {
    const events: unknown[] = [];
    uninstall = installOperationalErrorSink((event) => events.push(event));
    const controller = new AbortController();
    controller.abort();
    reportUnlessExpectedAbort({ component: "test", operation: "poll", error: new Error("stopped") }, controller.signal);
    expect(events).toEqual([]);
  });

  it("returns a stable redacted durable error classification", () => {
    const first = sanitizeOperationalError(Object.assign(new Error("GET https://x.test?a=1&api_key=secret-value"), { code: "ETIMEDOUT" }));
    const second = sanitizeOperationalError(Object.assign(new Error("GET https://x.test?a=1&api_key=secret-value"), { code: "ETIMEDOUT" }));
    expect(first).toMatchObject({ code: "etimedout", errorClass: "network", retryable: true, outcome: "failure" });
    expect(first.safeMessage).not.toContain("secret-value");
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("keeps thousands of dynamic paths and ids out of metric identifiers", () => {
    const events: Array<{ operation?: string; operationCode?: string }> = [];
    uninstall = installOperationalErrorSink((event) => events.push(event));
    for (let index = 0; index < 2_500; index += 1) {
      reportOperationalError({
        component: "sessions",
        operation: `scan /private/session-${index}/job-${index}`,
        operationCode: "sessions.scan-entry",
        error: new Error("failed"),
      });
    }
    expect(new Set(events.map((event) => event.operation)).size).toBe(2_500);
    expect(new Set(events.map((event) => event.operationCode))).toEqual(new Set(["sessions.scan-entry"]));
  });
});
