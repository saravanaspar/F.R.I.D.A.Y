import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import conditionalHooksPlugin from "../plugins/conditional-hooks/index.js";
import {
  CONDITIONAL_HOOKS_DATABASE_FILE,
  ConditionalHookStore,
} from "../plugins/conditional-hooks/store.js";
import { collectContributions, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CONDITIONAL_HOOKS_CAPABILITY } from "../plugins/conditional-hooks/contract.js";
import { principalScope } from "../plugins/principal-scope.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import { AGENT_PROMPT_SECTION_CONTRIBUTION, AGENT_TOOL_CONTRIBUTION, type InboundTurn } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;

function turn(senderId: string): InboundTurn {
  return {
    id: `turn-${senderId}`,
    principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId },
    text: "configure a conditional rule",
    timestamp: Date.now(),
    async reply() {},
  };
}

async function assemble(root?: string): Promise<{ friday: PluginTestHost; root: string }> {
  const home = root ?? await mkdtemp(join(tmpdir(), "friday-conditional-hooks-"));
  if (!root) roots.push(home);
  process.env.FRIDAY_HOME = home;
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(conditionalHooksPlugin, { defer: true });
  await friday.completePluginBootstrap();
  return { friday, root: home };
}

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conditional hooks", () => {
  it("persists generic principal-owned rules and enforces their invocation count atomically", async () => {
    const { friday, root } = await assemble();
    const actions = collectContributions(SYSTEM_ACTION_CONTRIBUTION);
    const create = actions.find((action) => action.id === "conditional-hooks.create")!;
    const list = actions.find((action) => action.id === "conditional-hooks.list")!;
    const alice = turn("alice");
    const aliceActionContext = { turn: alice, deferAfterReply() {} };

    await expect(create.execute({ condition: "a declared condition matches", instruction: "perform the saved instruction" }, aliceActionContext))
      .resolves.toMatchObject({ created: false, needsInvocationCount: true });
    const created = await create.execute({
      condition: "a declared condition matches",
      instruction: "perform the saved instruction",
      phase: "after-action",
      invocations: 2,
    }, aliceActionContext) as { rule: { id: string } };
    const id = created.rule.id;
    expect(create.permission({}).effect).toBe("system-write");
    expect(await list.execute({}, aliceActionContext)).toEqual([expect.objectContaining({ id, maxInvocations: 2, invocationCount: 0 })]);
    expect(await list.execute({}, { turn: turn("bob"), deferAfterReply() {} })).toEqual([]);

    const ownerScope = principalScope(alice.principal);
    const section = collectContributions(AGENT_PROMPT_SECTION_CONTRIBUTION).find((entry) => entry.id === "conditional-hooks")!;
    expect(section.render({ ownerScope } as never)).toContain(id);
    const tool = collectContributions(AGENT_TOOL_CONTRIBUTION).find((entry) => entry.name === "conditional_hook_invoke")!;
    await expect(tool.execute({ id }, undefined, { ownerScope } as never)).resolves.toMatchObject({ output: { active: true, invocationCount: 1, remaining: 1 } });
    await expect(tool.execute({ id }, undefined, { ownerScope } as never)).resolves.toMatchObject({ output: { active: true, invocationCount: 2, remaining: 0 } });
    await expect(tool.execute({ id }, undefined, { ownerScope } as never)).resolves.toMatchObject({ output: { active: false } });
    expect(section.render({ ownerScope } as never)).toBeUndefined();

    await friday.dispose();
    uninstallCapabilityRegistry();
    await assemble(root);
    expect(requireCapability(CONDITIONAL_HOOKS_CAPABILITY).list(ownerScope)).toEqual([
      expect.objectContaining({ id, invocationCount: 2, enabled: false }),
    ]);
  });

  it("fails closed when the durable hook database is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-conditional-hooks-corrupt-"));
    roots.push(root);
    const stateDir = join(root, "conditional-hooks");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, CONDITIONAL_HOOKS_DATABASE_FILE), "not a sqlite database", { mode: 0o600 });

    expect(() => new ConditionalHookStore(stateDir)).toThrow();
  });
});
