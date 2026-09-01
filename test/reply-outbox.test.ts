import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteTurnReplyOutbox,
  TURN_REPLY_OUTBOX_DATABASE_FILE,
} from "../plugins/turn-loop/reply-outbox.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "friday-reply-outbox-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable turn reply outbox", () => {
  it("persists a private reply and required finalizers across process ownership", async () => {
    const stateDir = await tempDir();
    const first = new SqliteTurnReplyOutbox(stateDir);
    const saved = first.put({
      turnKey: "telegram:main:provider-turn-1",
      ownerScope: "channel:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      text: "private reply text",
      finalizers: [{ type: "runtime-settings.apply", payload: { operationId: "operation-1" } }],
      requiresFinalization: true,
    });
    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
    first.close();

    const reopened = new SqliteTurnReplyOutbox(stateDir);
    expect(reopened.get(saved.turnKey, saved.ownerScope)).toMatchObject({
      text: "private reply text",
      sha256: saved.sha256,
      finalizers: [{ type: "runtime-settings.apply", payload: { operationId: "operation-1" } }],
      requiresFinalization: true,
    });
    expect(() => reopened.get(saved.turnKey, "channel:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
      .toThrow(/owner does not match/);
    expect(() => reopened.put({
      turnKey: saved.turnKey,
      ownerScope: saved.ownerScope,
      text: "different reply",
      finalizers: [],
      requiresFinalization: false,
    })).toThrow(/collides with a different durable result/);
    reopened.delete(saved.turnKey, saved.ownerScope);
    expect(reopened.get(saved.turnKey, saved.ownerScope)).toBeUndefined();
    reopened.close();
  });

  it("fails closed when the reply outbox database is corrupt", async () => {
    const stateDir = await tempDir();
    await writeFile(join(stateDir, TURN_REPLY_OUTBOX_DATABASE_FILE), "not a sqlite database", { mode: 0o600 });

    expect(() => new SqliteTurnReplyOutbox(stateDir)).toThrow();
  });
});
