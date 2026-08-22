import { describe, expect, it } from "vitest";
import { truncateHead, truncateTail } from "../src/truncate.js";

describe("tool output truncation", () => {
  it("keeps the tail for command output", () => {
    const result = truncateTail("one\ntwo\nthree\nfour", { maxLines: 2, maxBytes: 100 });
    expect(result.content).toBe("three\nfour");
    expect(result.truncatedBy).toBe("lines");
  });

  it("does not split UTF-8 when taking a byte-limited tail", () => {
    const result = truncateTail("abc🙂🙂🙂", { maxLines: 10, maxBytes: 8 });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(8);
    expect(result.content).not.toContain("�");
  });

  it("returns no partial first line for head truncation", () => {
    const result = truncateHead("🙂🙂🙂", { maxLines: 10, maxBytes: 4 });
    expect(result.content).toBe("");
    expect(result.firstLineExceedsLimit).toBe(true);
  });
});
