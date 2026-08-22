import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import memoryPlugin from "../plugins/memory/index.js";
import { MEMORY_CAPABILITY } from "../plugins/memory/contract.js";
import { MODEL_CAPABILITY, type ModelService } from "../plugins/model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import refinementPlugin from "../plugins/refinement/index.js";
import { REFINEMENT_CAPABILITY } from "../plugins/refinement/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import type { InboundTurn } from "../plugins/turn-loop/contract.js";

const dirs: string[] = [];
const originalHome = process.env.FRIDAY_HOME;
const originalProvider = process.env.FRIDAY_MODEL_PROVIDER;
const originalModel = process.env.FRIDAY_MODEL_ID;

afterEach(() => {
  uninstallCapabilityRegistry();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FRIDAY_HOME; else process.env.FRIDAY_HOME = originalHome;
  if (originalProvider === undefined) delete process.env.FRIDAY_MODEL_PROVIDER; else process.env.FRIDAY_MODEL_PROVIDER = originalProvider;
  if (originalModel === undefined) delete process.env.FRIDAY_MODEL_ID; else process.env.FRIDAY_MODEL_ID = originalModel;
});

function testTurn(replies: string[]): InboundTurn {
  return Object.freeze({
    id: "refinement-turn",
    principal: Object.freeze({ authority: "local", channel: "cli", accountId: "local", conversationId: "terminal", senderId: "local-user" }),
    text: "refine how you remember repeated implementation lessons",
    timestamp: Date.now(),
    reply: async (text: string) => { replies.push(text); },
  });
}

async function activateRoot() {
  const home = mkdtempSync(join(tmpdir(), "friday-refinement-root-test-")); dirs.push(home); chmodSync(home, 0o700); process.env.FRIDAY_HOME = home;
  process.env.FRIDAY_MODEL_PROVIDER = "test";
  process.env.FRIDAY_MODEL_ID = "test-model";
  const authorizations: unknown[] = [];
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(memoryPlugin, { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-refinement-model", provides: [MODEL_CAPABILITY] }, (ctx) => {
    ctx.services.provide(MODEL_CAPABILITY, {
      api: {
        getModel: (provider: string, id: string) => provider === "test" && id === "test-model" ? { provider, id, maxTokens: 8_192 } : undefined,
        async completeSimple() {
          return {
            content: [{ type: "text", text: '{"summary":"Remember validation lesson","rationale":"Repeated across turns","expectedOutcome":"Reuse the lesson","edits":[{"action":"create","kind":"memory","id":"validation-lesson","title":"Validation lesson","content":"Validate before checkpointing."}]}' }],
            stopReason: "stop",
          };
        },
      },
    } as unknown as ModelService);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-refinement-permissions", provides: [PERMISSIONS_CAPABILITY] }, (ctx) => {
    ctx.services.provide(PERMISSIONS_CAPABILITY, {
      normalizeMode: () => "ask",
      async authorize(request: unknown) { authorizations.push(request); return { allowed: true, approvedBy: "user" }; },
      assertWorkspacePath: (_workspace: string, path: string) => path,
    } as never);
  }), { defer: true });
  await friday.activatePlugin(refinementPlugin, { defer: true });
  await friday.completePluginBootstrap();
  return { friday, home, authorizations };
}

describe("refinement plugin", () => {
  it("composes model and memory access through capabilities", async () => {
    const { home } = await activateRoot();
    const refinement = requireCapability(REFINEMENT_CAPABILITY);
    const store = refinement.api.openMemory(home, "local");
    const result = refinement.api.applyRefinementProposal(
      store,
      {
        summary: "Remember a decision",
        rationale: "It matters later.",
        expectedOutcome: "Future turns reuse it.",
        edits: [{ action: "create", kind: "memory", id: "decision", title: "Decision", content: "Keep refinement separate from memory storage." }],
      },
      { id: "refine_root", scope: "local" },
    );
    expect(result.appliedEdits[0]?.applied).toBe(true);
    expect(store.get("memory", "decision")?.content).toContain("separate");
  });

  it("shows and authorizes a proposal before applying it, persists history, and can roll it back", async () => {
    const { home, authorizations } = await activateRoot();
    const actions = collectContributions(SYSTEM_ACTION_CONTRIBUTION);
    const apply = actions.find((action) => action.id === "refinement.apply")!;
    const history = actions.find((action) => action.id === "refinement.history")!;
    const rollback = actions.find((action) => action.id === "refinement.rollback")!;
    const replies: string[] = [];
    const context = { turn: testTurn(replies), deferAfterReply: () => undefined };

    const applied = await apply.execute({}, context) as { id: string };
    expect(replies[0]).toContain("Refinement proposal");
    expect(replies[0]).toContain("create memory:validation-lesson");
    expect(authorizations).toHaveLength(1);

    const memory = requireCapability(MEMORY_CAPABILITY).api;
    const store = new memory.MemoryStore({ stateDir: memory.getGlobalMemoryStateDir(home), scope: "global" });
    expect(store.get("memory", "validation-lesson")?.content).toBe("Validate before checkpointing.");
    store.close();

    const records = await history.execute({}, context) as readonly { id: string }[];
    expect(records[0]?.id).toBe(applied.id);
    replies.length = 0;
    await rollback.execute({ id: applied.id }, context);
    expect(replies[0]).toContain("Refinement proposal");
    expect(authorizations).toHaveLength(2);

    const reopened = new memory.MemoryStore({ stateDir: memory.getGlobalMemoryStateDir(home), scope: "global" });
    expect(reopened.get("memory", "validation-lesson")).toBeUndefined();
    reopened.close();
    const after = await history.execute({ limit: 10 }, context) as readonly { rollbackOf?: string }[];
    expect(after[0]?.rollbackOf).toBe(applied.id);
  });

  it("fails closed if the persistent refinement-history directory permissions become broad", async () => {
    const { home } = await activateRoot();
    const apply = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "refinement.apply")!;
    await apply.execute({}, { turn: testTurn([]), deferAfterReply: () => undefined });
    chmodSync(join(home, "refinement"), 0o755);
    const history = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "refinement.history")!;
    await expect(Promise.resolve().then(() => history.execute({}, { turn: testTurn([]), deferAfterReply: () => undefined }))).rejects.toThrow("Refinement history directory permissions are too broad");
  });

  it("rejects a rollback when an affected entry changes during confirmation", async () => {
    const { home } = await activateRoot();
    const actions = collectContributions(SYSTEM_ACTION_CONTRIBUTION);
    const apply = actions.find((action) => action.id === "refinement.apply")!;
    const rollback = actions.find((action) => action.id === "refinement.rollback")!;
    const context = { turn: testTurn([]), deferAfterReply: () => undefined };
    const applied = await apply.execute({}, context) as { id: string };
    const memory = requireCapability(MEMORY_CAPABILITY).api;

    const rollbackTurn: InboundTurn = {
      ...testTurn([]),
      reply: async () => {
        const concurrent = new memory.MemoryStore({ stateDir: memory.getGlobalMemoryStateDir(home), scope: "global" });
        concurrent.update("memory", "validation-lesson", {
          title: "Validation lesson",
          content: "A newer conversation changed this lesson.",
        });
        concurrent.close();
      },
    };

    await expect(rollback.execute({ id: applied.id }, { turn: rollbackTurn, deferAfterReply: () => undefined }))
      .rejects.toThrow("changed during confirmation");
    const reopened = new memory.MemoryStore({ stateDir: memory.getGlobalMemoryStateDir(home), scope: "global" });
    expect(reopened.get("memory", "validation-lesson")?.content).toBe("A newer conversation changed this lesson.");
    reopened.close();
  });

  it("restores memory state when refinement history cannot be committed", async () => {
    const { home } = await activateRoot();
    const apply = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "refinement.apply")!;
    const turnWithHistoryFailure: InboundTurn = {
      ...testTurn([]),
      reply: async () => {
        mkdirSync(join(home, "refinement"), { mode: 0o755 });
        chmodSync(join(home, "refinement"), 0o755);
      },
    };

    await expect(apply.execute({}, { turn: turnWithHistoryFailure, deferAfterReply: () => undefined }))
      .rejects.toThrow("Refinement history directory permissions are too broad");

    const memory = requireCapability(MEMORY_CAPABILITY).api;
    const store = new memory.MemoryStore({ stateDir: memory.getGlobalMemoryStateDir(home), scope: "global" });
    expect(store.get("memory", "validation-lesson")).toBeUndefined();
    expect(store.snapshot().refinements).toEqual([]);
    store.close();
  });
});
