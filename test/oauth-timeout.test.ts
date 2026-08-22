import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthFetch, oauthSignal } from "../plugins/auth/runtime/src/oauth/fetch.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("OAuth network bounds", () => {
  it("aborts a stalled OAuth fetch when its deadline expires", async () => {
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as typeof fetch;

    await expect(oauthFetch("https://oauth.example.test/token", {}, 20)).rejects.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("combines caller cancellation with the bounded OAuth deadline", () => {
    const controller = new AbortController();
    const signal = oauthSignal(controller.signal, 30_000);
    controller.abort(new Error("cancelled by caller"));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
  });
});
