import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRoutingTrace, routingTracePath, traceJson } from "../plugins/routing/trace-jsonl.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("routing JSONL trace", () => {
  it("writes a private append-only daily JSONL record with batch transcript metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-routing-trace-"));
    roots.push(root);
    const timestamp = "2026-09-15T10:00:00.000Z";
    appendRoutingTrace(root, {
      timestamp,
      traceKind: "batch",
      provider: "google",
      model: "gemini-test",
      messageIds: ["m1", "m2"],
      systemPrompt: "route safely",
      userPrompt: "{\"messages\":[]}",
      rawResponseText: "{\"decisions\":[]}",
      providerContent: traceJson([{ type: "text", text: "provider-visible content" }]),
      parsedResponse: traceJson({ decisions: [] }),
      stopReason: "stop",
      usage: traceJson({ inputTokens: 12, outputTokens: 4 }),
    });

    const path = routingTracePath(root, new Date(timestamp));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      traceKind: "batch",
      provider: "google",
      model: "gemini-test",
      messageIds: ["m1", "m2"],
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("bounds circular provider metadata instead of breaking trace persistence", () => {
    const circular: Record<string, unknown> = { label: "x" };
    circular.self = circular;
    expect(traceJson(circular)).toEqual({ label: "x", self: "[circular]" });
  });
});
