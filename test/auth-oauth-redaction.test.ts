import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "../plugins/auth/runtime/src/oauth/anthropic.js";
import { refreshOpenAICodexToken } from "../plugins/auth/runtime/src/oauth/openai-codex.js";

const ACCESS = "fake-access-token-must-not-leak";
const REFRESH = "fake-refresh-token-must-not-leak";

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectRedacted(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toContain(ACCESS);
  expect(message).not.toContain(REFRESH);
}

describe("OAuth token error redaction", () => {
  it("does not stringify malformed OpenAI token responses into errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: "not-a-number",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    try {
      await refreshOpenAICodexToken("input-refresh-token");
      throw new Error("expected refresh to fail");
    } catch (error) {
      expectRedacted(error);
      expect(String(error)).toContain("expires_in");
    }
  });

  it("does not include Anthropic token response bodies in validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: "not-a-number",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    try {
      await refreshAnthropicToken("input-refresh-token");
      throw new Error("expected refresh to fail");
    } catch (error) {
      expectRedacted(error);
      expect(String(error)).toContain("expires_in");
    }
  });

  it("does not include provider error bodies for non-success responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${ACCESS}:${REFRESH}`, { status: 400, statusText: "Bad Request" })));

    for (const refresh of [refreshOpenAICodexToken, refreshAnthropicToken]) {
      try {
        await refresh("input-refresh-token");
        throw new Error("expected refresh to fail");
      } catch (error) {
        expectRedacted(error);
      }
    }
  });

  it("does not echo malformed OpenAI JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{\"access_token\":\"${ACCESS}\",\"refresh_token\":\"${REFRESH}\"`, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    try {
      await refreshOpenAICodexToken("input-refresh-token");
      throw new Error("expected refresh to fail");
    } catch (error) {
      expectRedacted(error);
      expect(String(error)).toContain("invalid JSON");
    }
  });
});
