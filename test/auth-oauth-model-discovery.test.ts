import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGitHubCopilotModelIds } from "../plugins/auth/runtime/src/oauth/github-copilot.js";
import { discoverOpenAICodexModelIds } from "../plugins/auth/runtime/src/oauth/openai-codex.js";

const ACCESS = "oauth-access-token-must-not-leak";

function credentials(access: string, extra: Record<string, unknown> = {}) {
  return {
    access,
    refresh: "oauth-refresh-token",
    expires: Date.now() + 60_000,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth account model discovery", () => {
  it("fetches GitHub Copilot models from the authenticated account edge", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.individual.githubcopilot.com/models");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tid=1;proxy-ep=proxy.individual.githubcopilot.com;exp=999");
      expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-5.4", model_picker_enabled: true },
          { id: "claude-sonnet-5", model_picker_enabled: false },
          { id: "gpt-5.4" },
          { invalid: true },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(discoverGitHubCopilotModelIds(credentials(
      "tid=1;proxy-ep=proxy.individual.githubcopilot.com;exp=999",
    ))).resolves.toEqual(["gpt-5.4", "claude-sonnet-5"]);
  });

  it("fetches only visible API-supported OpenAI Codex models after OAuth", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe("https://chatgpt.com/backend-api/codex/models");
      expect(url.searchParams.get("client_version")).toBe("99.99.99");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
      expect(headers.get("chatgpt-account-id")).toBe("account-123");
      expect(headers.get("originator")).toBe("pi");
      return new Response(JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true },
          { slug: "gpt-hidden", visibility: "hide", supported_in_api: true },
          { slug: "gpt-not-api", visibility: "list", supported_in_api: false },
          { slug: "gpt-legacy-shape" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(discoverOpenAICodexModelIds(credentials(ACCESS, { accountId: "account-123" })))
      .resolves.toEqual(["gpt-5.6-sol", "gpt-legacy-shape"]);
  });

  it("does not echo OAuth tokens when account model discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`provider rejected ${ACCESS}`, {
      status: 401,
      statusText: "Unauthorized",
    })));

    for (const discover of [
      () => discoverGitHubCopilotModelIds(credentials(ACCESS)),
      () => discoverOpenAICodexModelIds(credentials(ACCESS, { accountId: "account-123" })),
    ]) {
      await expect(discover()).rejects.not.toThrow(ACCESS);
      await expect(discover()).rejects.toThrow(/model discovery failed/i);
    }
  });
});
