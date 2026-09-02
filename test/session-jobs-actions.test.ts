import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../plugins/channels/trusted-contract.js";
import { EVENTS_CAPABILITY } from "../plugins/events/contract.js";
import { createSessionJobsPlugin } from "../plugins/session-jobs/index.js";
import { SESSION_JOBS_CAPABILITY, type SessionJobOrigin } from "../plugins/session-jobs/contract.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, type SystemActionExecutionContext } from "../plugins/system/contract.js";
import type { InboundTurn } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];

afterEach(async () => {
  uninstallCapabilityRegistry();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function origin(senderId: string): SessionJobOrigin {
  return { authority: "channel", channel: "telegram", accountId: "main", conversationId: `chat-${senderId}`, senderId };
}

function context(jobOrigin: SessionJobOrigin): SystemActionExecutionContext {
  const turn: InboundTurn = {
    id: `turn-${jobOrigin.senderId}`,
    principal: jobOrigin,
    text: "cancel my background work",
    timestamp: Date.now(),
    reply: async () => undefined,
  };
  return { turn, deferAfterReply: () => undefined };
}

async function assemble(home: string, requestApproval: () => Promise<boolean>) {
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-job-events", provides: [EVENTS_CAPABILITY] }, (ctx) => {
    ctx.services.provide(EVENTS_CAPABILITY, { publish: () => ({}) } as never);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-job-sessions", provides: [SESSIONS_CAPABILITY] }, (ctx) => {
    ctx.services.provide(SESSIONS_CAPABILITY, { SessionManager: { listAll: async () => [] } } as never);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-job-channels", provides: [CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => {
    ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, { requestApproval } as never);
  }), { defer: true });
  await friday.activatePlugin(createSessionJobsPlugin({ home, progressNotifyIntervalMs: 0 }), { defer: true });
  await friday.completePluginBootstrap();
  return friday;
}

describe("session job actions", () => {
  it("declares a system-write permission and restricts cancellation to the originating principal", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-job-actions-")); roots.push(home);
    await assemble(home, async () => true);
    const manager = requireCapability(SESSION_JOBS_CAPABILITY);
    const gates = [deferred(), deferred()];
    const origins = [origin("alice"), origin("bob")];
    const jobs = await Promise.all(origins.map((jobOrigin, index) => manager.start({
      destinationId: "session:new",
      text: `background work ${jobOrigin.senderId}`,
      timestamp: Date.now(),
      origin: jobOrigin,
      notify: async () => undefined,
      async run() {
        await gates[index]!.promise;
        return { text: "done" };
      },
    })));
    await waitUntil(() => manager.list({ activeOnly: true }).length === 2, "two active jobs");
    const cancel = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "session.jobs.cancel")!;

    expect(cancel.permission?.({ query: "background" })).toMatchObject({ effect: "system-write", network: false });
    const result = await cancel.execute({ query: "background" }, context(origins[1]!));

    expect(String(result)).toContain(`Cancelled background work bob (${jobs[1]!.id})`);
    expect(manager.get(jobs[1]!.id)?.status).toBe("cancelled");
    expect(manager.get(jobs[0]!.id)?.status).not.toBe("cancelled");
    gates[0]!.resolve();
    gates[1]!.resolve();
  });

  it("reports that nothing was cancelled if the job finishes during approval", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-job-actions-")); roots.push(home);
    const approvalStarted = deferred();
    const approvalRelease = deferred();
    await assemble(home, async () => {
      approvalStarted.resolve();
      await approvalRelease.promise;
      return true;
    });
    const manager = requireCapability(SESSION_JOBS_CAPABILITY);
    const runGate = deferred();
    const jobOrigin = origin("alice");
    const job = await manager.start({
      destinationId: "session:new",
      text: "short background work",
      timestamp: Date.now(),
      origin: jobOrigin,
      notify: async () => undefined,
      async run() {
        await runGate.promise;
        return { text: "done" };
      },
    });
    const cancel = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "session.jobs.cancel")!;
    const pending = cancel.execute({ query: job.id }, context(jobOrigin));
    await approvalStarted.promise;
    runGate.resolve();
    await waitUntil(() => manager.get(job.id)?.status === "completed", "job completion during approval");
    approvalRelease.resolve();

    await expect(pending).resolves.toContain("finished before cancellation was applied; nothing was cancelled");
    expect(manager.get(job.id)?.status).toBe("completed");
  });
});
