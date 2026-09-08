import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAnthropicAuthorizationFlow } from "../plugins/auth/runtime/src/oauth/anthropic.js";
import { createAuthorizationFlow as createOpenAIAuthorizationFlow } from "../plugins/auth/runtime/src/oauth/openai-codex.js";
import { createOAuthState, oauthCallbackHost } from "../plugins/auth/runtime/src/oauth/security.js";

function challengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function expectIndependentState(flow: { verifier: string; state: string; url: string }): void {
  const url = new URL(flow.url);
  expect(flow.state).not.toBe(flow.verifier);
  expect(url.searchParams.get("state")).toBe(flow.state);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(challengeForVerifier(flow.verifier));
}

describe("OAuth PKCE/CSRF separation", () => {
  it("uses independent OpenAI PKCE verifier and OAuth state values", async () => {
    expectIndependentState(await createOpenAIAuthorizationFlow("friday-test"));
  });

  it("uses independent Anthropic PKCE verifier and OAuth state values", async () => {
    expectIndependentState(await createAnthropicAuthorizationFlow());
  });

  it("creates random URL-safe state values", () => {
    const first = createOAuthState();
    const second = createOAuthState();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("binds OAuth callback servers to loopback only", () => {
    expect(oauthCallbackHost({})).toBe("127.0.0.1");
    expect(oauthCallbackHost({ FRIDAY_OAUTH_CALLBACK_HOST: "localhost" })).toBe("localhost");
    expect(oauthCallbackHost({ FRIDAY_OAUTH_CALLBACK_HOST: "[::1]" })).toBe("::1");
    expect(() => oauthCallbackHost({ FRIDAY_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(/loopback-only/);
    expect(() => oauthCallbackHost({ FRIDAY_OAUTH_CALLBACK_HOST: "192.168.1.10" })).toThrow(/loopback-only/);
  });
});
