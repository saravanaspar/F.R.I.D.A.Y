import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TOOL_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import memoryPlugin from "../plugins/memory/index.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;
const originalState = process.env.FRIDAY_STATE_DIR;

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  if (originalState === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalState;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assemble() {
  const root = await mkdtemp(join(tmpdir(), "friday-memory-tools-"));
  roots.push(root);
  process.env.FRIDAY_HOME = root;
  delete process.env.FRIDAY_STATE_DIR;
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(memoryPlugin);
  const tools = collectContributions(AGENT_TOOL_CONTRIBUTION);
  return { root, tools };
}

describe("agent memory tools", () => {
  it("persists rich notes separately from compact graph relations and can recall/forget them", async () => {
    const { tools } = await assemble();
    const remember = tools.find((tool) => tool.name === "memory_remember")!;
    const relation = tools.find((tool) => tool.name === "memory_remember_relation")!;
    const recall = tools.find((tool) => tool.name === "memory_recall")!;
    const forget = tools.find((tool) => tool.name === "memory_forget")!;

    const note = await remember.execute({
      title: "T project next direction",
      content: "Current code is good. Research the project further, then build feature X.",
      path: "projects/t-project",
      scope: "global",
    });
    const edge = await relation.execute({
      subject: "T Project",
      predicate: "next_goal",
      object: "feature X",
      context: { evidence: "explicit user note" },
      scope: "global",
    });
    const found = await recall.execute({ query: "T project feature X" });
    expect(JSON.stringify(found.output)).toContain("T project next direction");
    expect(JSON.stringify(found.output)).toContain("next_goal");

    const noteId = (note.output as { id: string }).id;
    const relationId = (edge.output as { id: string }).id;
    await expect(forget.execute({ id: noteId, kind: "note", scope: "global" })).resolves.toMatchObject({ output: { deleted: true } });
    await expect(forget.execute({ id: relationId, kind: "relation", scope: "global" })).resolves.toMatchObject({ output: { deleted: true } });
  });

  it("partitions global memory by opaque principal ownership", async () => {
    const { root, tools } = await assemble();
    const remember = tools.find((tool) => tool.name === "memory_remember")!;
    const recall = tools.find((tool) => tool.name === "memory_recall")!;
    const context = (ownerScope: string) => ({
      cwd: root,
      sessionId: `session-${ownerScope.slice(-4)}`,
      ownerScope,
      deferAfterReply() {},
      deferOnFailure() {},
    });
    const alice = context(`channel:${"a".repeat(32)}`);
    const bob = context(`channel:${"b".repeat(32)}`);

    await remember.execute({
      title: "Alice private preference",
      content: "Alice prefers the blue deployment window.",
      scope: "global",
    }, undefined, alice);

    expect(JSON.stringify((await recall.execute({ query: "blue deployment window" }, undefined, alice)).output))
      .toContain("Alice private preference");
    expect(JSON.stringify((await recall.execute({ query: "blue deployment window" }, undefined, bob)).output))
      .not.toContain("Alice private preference");
  });

  it("indexes only bounded project Markdown knowledge rather than the codebase", async () => {
    const { root, tools } = await assemble();
    const project = join(root, "demo-project");
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "README.md"), "# Demo\n\nThe service uses event sourcing.\n## Decisions\nUse SQLite.\n");
    await writeFile(join(project, "docs", "architecture.md"), "# Architecture\n\nWorkers communicate through a queue.\n");
    await writeFile(join(project, "src.ts"), "export const secretImplementation = 1;\n");
    const index = tools.find((tool) => tool.name === "memory_index_project_docs")!;
    const recall = tools.find((tool) => tool.name === "memory_recall")!;
    const result = await index.execute({}, undefined, {
      cwd: project,
      sessionId: "session-project",
      deferAfterReply() {},
      deferOnFailure() {},
    });
    expect(result.output).toMatchObject({ documents: 2, updated: 2, unchanged: 0, removed: 0 });
    expect(JSON.stringify(result.output)).not.toContain("src.ts");

    const unchanged = await index.execute({}, undefined, {
      cwd: project,
      sessionId: "session-project",
      deferAfterReply() {},
      deferOnFailure() {},
    });
    expect(unchanged.output).toMatchObject({ documents: 2, updated: 0, unchanged: 2, removed: 0, relationChanges: 0 });

    await writeFile(join(project, "README.md"), "# Demo\n\nThe service uses event sourcing.\n## Decisions\nUse PostgreSQL.\n");
    await rm(join(project, "docs", "architecture.md"));
    const refreshed = await index.execute({}, undefined, {
      cwd: project,
      sessionId: "session-project",
      deferAfterReply() {},
      deferOnFailure() {},
    });
    expect(refreshed.output).toMatchObject({ documents: 1, updated: 1, unchanged: 0, removed: 1 });

    const found = await recall.execute({ query: "event sourcing PostgreSQL Demo Decisions" });
    const serialized = JSON.stringify(found.output);
    expect(serialized).toContain("README.md");
    expect(serialized).not.toContain("Workers communicate through a queue");
    expect(serialized).not.toContain(project);
  });

  it("rejects credentials in note bodies and relation context", async () => {
    const { tools } = await assemble();
    const remember = tools.find((tool) => tool.name === "memory_remember")!;
    const relation = tools.find((tool) => tool.name === "memory_remember_relation")!;
    await expect(remember.execute({
      title: "token",
      content: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
    })).rejects.toThrow(/secrets belong in Vault/);
    await expect(relation.execute({
      subject: "service",
      predicate: "uses",
      object: "credential",
      context: { access_token: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
    })).rejects.toThrow(/secrets belong in Vault/);
  });

  it("reviews sources/conflicts and applies atomic patch corrections by exact id", async () => {
    const { tools } = await assemble();
    const remember = tools.find((tool) => tool.name === "memory_remember")!;
    const relation = tools.find((tool) => tool.name === "memory_remember_relation")!;
    const note = await remember.execute({
      title: "Deployment preference",
      content: "Use the blue window.",
      path: "preferences/deploy",
    });
    const old = await relation.execute({ subject: "user", predicate: "prefers_editor", object: "vim" });
    await relation.execute({ subject: "user", predicate: "prefers_editor", object: "zed" });
    const actions = collectContributions(SYSTEM_ACTION_CONTRIBUTION);
    const review = actions.find((action) => action.id === "memory.review")!;
    const correct = actions.find((action) => action.id === "memory.correct")!;
    const context = {
      turn: { id: "turn-memory", principal: { authority: "local" as const, channel: "local", accountId: "local", conversationId: "terminal", senderId: "operator" }, text: "review memory", timestamp: Date.now(), reply: async () => undefined },
      deferAfterReply() {},
    };

    const noteId = (note.output as { id: string }).id;
    const correctedNote = await correct.execute({
      id: noteId,
      kind: "note",
      content: "Use the green window.",
    }, context) as { memory: { title: string; content: string; path: string; source: string } };
    expect(correctedNote.memory).toMatchObject({
      title: "Deployment preference",
      content: "Use the green window.",
      path: "preferences/deploy",
      source: "operator-correction",
    });
    expect(() => correct.execute({ id: noteId, kind: "note" }, context)).toThrow(/requires at least one/);

    const before = await review.execute({ query: "prefers_editor" }, context) as { conflicts: unknown[] };
    expect(before.conflicts).toHaveLength(1);
    const oldId = (old.output as { id: string }).id;
    const replaced = await correct.execute({ id: oldId, kind: "relation", object: "helix" }, context) as { memory: { source: string; subject: string; predicate: string; object: string } };
    expect(replaced.memory).toMatchObject({
      source: "operator-correction",
      subject: "user",
      predicate: "prefers_editor",
      object: "helix",
    });
    const after = await review.execute({ query: "prefers_editor" }, context) as { relations: Array<{ id: string; source: string }> };
    expect(after.relations.some((entry) => entry.id === oldId)).toBe(false);
    expect(after.relations.some((entry) => entry.source === "operator-correction")).toBe(true);
  });
});
