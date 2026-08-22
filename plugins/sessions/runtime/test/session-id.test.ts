import { describe, expect, it } from "vitest";
import {
  formatSessionDisplayId,
  matchesSavedSessionSelector,
  matchesSessionIdSuffix,
  normalizeSessionId,
  SessionManager,
} from "../src/index.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("session ids", () => {
  it("generates UUIDv7 session ids", () => {
    expect(SessionManager.inMemory().getSessionId()).toMatch(UUID_V7);
  });

  it("accepts an explicit session id", () => {
    const session = SessionManager.inMemory();
    session.newSession({ id: "my-session" });
    expect(session.getSessionId()).toBe("my-session");
    expect(session.getHeader()?.id).toBe("my-session");
  });

  it("normalizes UUID punctuation and case", () => {
    expect(normalizeSessionId("AA-BB-CC")).toBe("aabbcc");
  });

  it("matches hexadecimal suffix selectors", () => {
    expect(matchesSessionIdSuffix("12345678-90ab-cdef", "CDEF")).toBe(true);
    expect(matchesSessionIdSuffix("12345678-90ab-cdef", "ffff")).toBe(false);
  });

  it("matches saved-session selectors by hex prefix or suffix", () => {
    expect(matchesSavedSessionSelector("1234567890abcdef", "1234")).toBe(true);
    expect(matchesSavedSessionSelector("1234567890abcdef", "cdef")).toBe(true);
  });

  it("uses a compact display id", () => {
    expect(formatSessionDisplayId("1234567890abcdef")).toBe("567890abcdef");
  });
});
