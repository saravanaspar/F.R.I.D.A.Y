import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionJobManager } from "../plugins/session-jobs/manager.js";

const dirs: string[] = [];
const managers: SessionJobManager[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "friday-session-jobs-test-"));
  dirs.push(dir);
  return dir;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SessionJobManager", () => {
  it("runs different sessions concurrently while serializing work inside one session", async () => {
    const root = await tempDir();
    let sequence = 0;
    const manager = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      progressNotifyIntervalMs: 0,
      idFactory: () => `job-${++sequence}`,
      resolveLabel: (destination) => destination === "session:pscls" ? "PSCLS — brain" : "Project T",
    });
    managers.push(manager);
    const psclsFirst = deferred();
    const projectT = deferred();
    const started: string[] = [];
    const notices: string[] = [];
    const base = {
      timestamp: Date.now(),
      origin: { authority: "channel" as const, channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      notify: async (text: string) => { notices.push(text); },
    };

    await manager.start({
      ...base,
      destinationId: "session:pscls",
      text: "work on PSCLS brain",
      async run(_signal, report) {
        started.push("pscls-1");
        await report({ kind: "tool", message: "Running benchmark" });
        await psclsFirst.promise;
        return { text: "brain done", sessionId: "pscls" };
      },
    });
    const second = await manager.start({
      ...base,
      destinationId: "session:pscls",
      text: "also optimize training",
      async run() {
        started.push("pscls-2");
        return { text: "training done", sessionId: "pscls" };
      },
    });
    await manager.start({
      ...base,
      destinationId: "session:project-t",
      text: "work on Project T",
      async run() {
        started.push("project-t");
        await projectT.promise;
        return { text: "project done", sessionId: "project-t" };
      },
    });

    await waitUntil(() => started.includes("pscls-1") && started.includes("project-t"), "cross-session concurrency");
    expect(started).not.toContain("pscls-2");
    expect(manager.get(second.id)?.currentStatus).toMatch(/Queued behind/);

    psclsFirst.resolve();
    await waitUntil(() => started.includes("pscls-2"), "same-session queue release");
    projectT.resolve();
    await waitUntil(() => manager.list({ activeOnly: true }).length === 0, "all jobs settled");
    expect(notices.some((text) => text.includes("Running benchmark"))).toBe(true);
    expect(manager.list({ limit: 10 }).filter((job) => job.status === "completed")).toHaveLength(3);
    await manager.close();
    managers.splice(managers.indexOf(manager), 1);
    const reopened = await SessionJobManager.open({ stateDir: join(root, "jobs") });
    managers.push(reopened);
    expect(reopened.list({ limit: 10 }).filter((job) => job.status === "completed")).toHaveLength(3);
  });

  it("redacts failures and removes the full request from terminal durable records", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    const requestText = `${"perform bounded work ".repeat(30)}FULL-REQUEST-TAIL-MUST-NOT-PERSIST`;
    const manager = await SessionJobManager.open({ stateDir, idFactory: () => "job-terminal" });
    managers.push(manager);
    const job = await manager.start({
      destinationId: "session:terminal",
      text: requestText,
      timestamp: Date.now(),
      origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
      notify: async () => undefined,
      async run() { throw new Error("token=session-job-secret"); },
    });
    await waitUntil(() => manager.get(job.id)?.status === "error", "terminal job failure");
    expect(manager.get(job.id)?.error).toBe("token=[REDACTED]");
    await manager.close();
    managers.splice(managers.indexOf(manager), 1);

    const database = new DatabaseSync(join(stateDir, "jobs.sqlite"));
    const row = database.prepare("SELECT payload_json FROM jobs WHERE id = ?").get(job.id) as { payload_json: string } | undefined;
    database.close();
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("requestText");
    expect(row!.payload_json).not.toContain("FULL-REQUEST-TAIL-MUST-NOT-PERSIST");
    expect(row!.payload_json).not.toContain("session-job-secret");
  });

  it("tracks retry progress, resolves similar natural-language selectors, and cancels only the exact job", async () => {
    const root = await tempDir();
    let sequence = 0;
    const manager = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      progressNotifyIntervalMs: 0,
      idFactory: () => `job-${++sequence}`,
      resolveLabel: (destination) => destination.endsWith("brain") ? "PSCLS — brain" : "PSCLS — training optimisation",
    });
    managers.push(manager);
    const gates = [deferred(), deferred()];
    const notices: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await manager.start({
        destinationId: index === 0 ? "session:pscls-brain" : "session:pscls-training",
        text: index === 0 ? "brain architecture" : "training optimisation",
        timestamp: Date.now(),
        origin: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
        notify: async (text) => { notices.push(text); },
        async run(signal, report) {
          if (index === 0) await report({ kind: "retry", message: "Provider is overloaded", attempt: 3, maxRetries: 10, delayMs: 8_000 });
          await Promise.race([
            gates[index]!.promise,
            rejectOnAbort(signal),
          ]);
          return { text: "done", sessionId: index === 0 ? "pscls-brain" : "pscls-training" };
        },
      });
    }
    await waitUntil(() => manager.find("PSCLS", { activeOnly: true }).length === 2, "two PSCLS jobs");
    const matches = manager.find("cancel pscls session", { activeOnly: true });
    expect(matches.map((job) => job.label).sort()).toEqual(["PSCLS — brain", "PSCLS — training optimisation"]);
    const brain = matches.find((job) => job.label.includes("brain"))!;
    await waitUntil(() => manager.get(brain.id)?.status === "retrying", "retry status");
    expect(manager.get(brain.id)).toMatchObject({ retryAttempt: 3, retryMax: 10 });
    await waitUntil(() => notices.some((text) => text.includes("Retry 3/10")), "retry notification");

    const cancelled = await manager.cancel(brain.id);
    expect(cancelled.status).toBe("cancelled");
    expect(manager.find("PSCLS", { activeOnly: true })).toHaveLength(1);
    gates[1]!.resolve();
  });

  it("does not report quiesced until aborted executions actually settle", async () => {
    const root = await tempDir();
    const gate = deferred();
    let observedSignal: AbortSignal | undefined;
    const manager = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      progressNotifyIntervalMs: 0,
      quiesceTimeoutMs: 1_000,
    });
    managers.push(manager);
    const job = await manager.start({
      destinationId: "session:quiesce",
      text: "long-running job",
      timestamp: Date.now(),
      origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
      notify: async () => undefined,
      async run(signal) {
        observedSignal = signal;
        await gate.promise;
        return { text: "settled", sessionId: "quiesce" };
      },
    });
    await waitUntil(() => manager.get(job.id)?.status === "running", "quiesce job start");

    let settled = false;
    const quiescing = manager.quiesce().then(() => { settled = true; });
    await waitUntil(() => observedSignal?.aborted === true, "quiesce abort signal");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    gate.resolve();
    await quiescing;
    expect(settled).toBe(true);
    expect(manager.resumable()).toMatchObject([{
      id: job.id,
      destinationId: "session:quiesce",
      requestText: "long-running job",
    }]);
  });
  it("binds a newly created session into the same queue before follow-up work can race", async () => {
    const root = await tempDir();
    let sequence = 0;
    const manager = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      progressNotifyIntervalMs: 0,
      idFactory: () => `job-${++sequence}`,
      resolveLabel: () => "New project",
    });
    managers.push(manager);
    const firstGate = deferred();
    const started: string[] = [];
    const base = {
      timestamp: Date.now(),
      origin: { authority: "channel" as const, channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      notify: async () => undefined,
    };

    const first = await manager.start({
      ...base,
      destinationId: "session:new",
      text: "start a new project",
      async run(_signal, report) {
        started.push("first");
        await report({ kind: "status", message: "session ready", sessionId: "created-session", notify: false });
        await firstGate.promise;
        return { text: "first done", sessionId: "created-session" };
      },
    });
    await waitUntil(() => manager.get(first.id)?.sessionId === "created-session", "new session binding");
    expect(manager.get(first.id)?.destinationId).toBe("session:created-session");

    const second = await manager.start({
      ...base,
      destinationId: "session:created-session",
      text: "follow up on the same project",
      async run() {
        started.push("second");
        return { text: "second done", sessionId: "created-session" };
      },
    });
    expect(manager.get(second.id)?.currentStatus).toMatch(/Queued behind/);
    expect(started).toEqual(["first"]);
    firstGate.resolve();
    await waitUntil(() => started.includes("second"), "bound-session follow-up release");
  });


  it("fails closed when indexed identity and persisted payload disagree", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    const manager = await SessionJobManager.open({ stateDir });
    managers.push(manager);
    await manager.start({
      destinationId: "session:pscls",
      text: "short job",
      timestamp: Date.now(),
      origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
      notify: async () => undefined,
      async run() { return { text: "done", sessionId: "pscls" }; },
    });
    await waitUntil(() => manager.list({ activeOnly: true }).length === 0, "job completion");
    await manager.close();
    managers.splice(managers.indexOf(manager), 1);

    const statePath = join(stateDir, "jobs.sqlite");
    const database = new DatabaseSync(statePath);
    const row = database.prepare("SELECT id, payload_json FROM jobs LIMIT 1").get() as { id: string; payload_json: string } | undefined;
    if (!row) throw new Error("expected persisted session job");
    const payload = JSON.parse(row.payload_json) as { id: string };
    payload.id = "different-job-id";
    database.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    database.close();

    await expect(SessionJobManager.open({ stateDir })).rejects.toThrow(/metadata disagrees with payload/);
  });

  it("fails closed when the session-jobs database is corrupt", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, "jobs.sqlite"), "not-a-sqlite-database", { mode: 0o600 });
    await expect(SessionJobManager.open({ stateDir })).rejects.toThrow();
  });

  it("fails closed on broad persisted job-state permissions", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    const manager = await SessionJobManager.open({ stateDir });
    managers.push(manager);
    await manager.start({
      destinationId: "session:pscls",
      text: "short job",
      timestamp: Date.now(),
      origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
      notify: async () => undefined,
      async run() { return { text: "done", sessionId: "pscls" }; },
    });
    await waitUntil(() => manager.list({ activeOnly: true }).length === 0, "job completion");
    await manager.close();
    managers.splice(managers.indexOf(manager), 1);
    await chmod(join(stateDir, "jobs.sqlite"), 0o644);
    await expect(SessionJobManager.open({ stateDir })).rejects.toThrow(/permissions are too broad/);
  });

  it("migrates the bounded legacy JSON registry once", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    const manager = await SessionJobManager.open({ stateDir });
    managers.push(manager);
    const job = await manager.start({
      destinationId: "session:legacy",
      text: "legacy-compatible job",
      timestamp: Date.now(),
      origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
      notify: async () => undefined,
      async run() { return { text: "done", sessionId: "legacy" }; },
    });
    await waitUntil(() => manager.get(job.id)?.status === "completed", "legacy fixture completion");
    const record = manager.get(job.id)!;
    await manager.close();
    managers.splice(managers.indexOf(manager), 1);

    const databasePath = join(stateDir, "jobs.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("DELETE FROM jobs; DELETE FROM metadata;");
    database.close();
    await writeFile(join(stateDir, "jobs.json"), `${JSON.stringify({ schema: 1, jobs: [record] }, null, 2)}\n`, { mode: 0o600 });

    const migrated = await SessionJobManager.open({ stateDir });
    managers.push(migrated);
    expect(migrated.get(job.id)?.status).toBe("completed");
    await expect(chmod(join(stateDir, "jobs.v1.migrated.json"), 0o600)).resolves.toBeUndefined();
  });

  it("keeps a restart successor suspended until activation and then recovers stale active work", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    const legacy = {
      schema: 1,
      jobs: [{
        id: "job-stale",
        destinationId: "session:stale",
        sessionId: "stale",
        label: "stale job",
        requestPreview: "keep working",
        origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        currentStatus: "Running",
        timeline: [],
      }],
    };
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, "jobs.json"), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    const successor = await SessionJobManager.open({ stateDir, recoverInterrupted: false, startSuspended: true });
    managers.push(successor);
    await expect(successor.start({
      destinationId: "session:new",
      text: "must wait",
      timestamp: Date.now(),
      origin: { authority: "local", channel: "local-test", accountId: "local", conversationId: "local-test", senderId: "operator" },
      notify: async () => undefined,
      async run() { return { text: "unexpected" }; },
    })).rejects.toThrow(/closed/);
    expect(successor.get("job-stale")?.status).toBe("running");
    await successor.activate();
    expect(successor.get("job-stale")).toMatchObject({ status: "error", currentStatus: "Interrupted by FRIDAY restart; automatic resume unavailable" });
  });

  it("reconstructs restart-resumable jobs from the full persisted request and closes the predecessor record after resume", async () => {
    const root = await tempDir();
    const stateDir = join(root, "jobs");
    const predecessor = await SessionJobManager.open({ stateDir });
    managers.push(predecessor);
    const gate = deferred();
    const job = await predecessor.start({
      sourceKey: "turn-source-1",
      destinationId: "session:resume-me",
      text: "continue the complete original request after restart",
      timestamp: Date.now(),
      origin: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      notify: async () => undefined,
      async run() {
        await gate.promise;
        return { text: "done", sessionId: "resume-me" };
      },
    });
    await waitUntil(() => predecessor.get(job.id)?.status === "running", "resumable job start");
    const quiescing = predecessor.quiesce();
    gate.resolve();
    await quiescing;
    await predecessor.close();
    managers.splice(managers.indexOf(predecessor), 1);

    const successor = await SessionJobManager.open({ stateDir });
    managers.push(successor);
    expect(successor.resumable()).toEqual([expect.objectContaining({
      id: job.id,
      destinationId: "session:resume-me",
      requestText: "continue the complete original request after restart",
    })]);
    await expect(successor.markResumed(job.id, `session-job-resume:${job.id}`)).resolves.toMatchObject({ status: "resumed" });
    expect(successor.resumable()).toEqual([]);
  });

  it("returns the existing durable job when the same source turn is admitted twice", async () => {
    const root = await tempDir();
    let runs = 0;
    const gate = deferred();
    const manager = await SessionJobManager.open({ stateDir: join(root, "jobs") });
    managers.push(manager);
    const request = {
      sourceKey: "same-turn",
      destinationId: "session:idempotent",
      text: "run this once",
      timestamp: Date.now(),
      origin: { authority: "channel" as const, channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      notify: async () => undefined,
      async run() {
        runs += 1;
        await gate.promise;
        return { text: "done", sessionId: "idempotent" };
      },
    };
    const [first, second] = await Promise.all([manager.start(request), manager.start(request)]);
    expect(second.id).toBe(first.id);
    await waitUntil(() => runs === 1, "single idempotent run");
    gate.resolve();
  });

  it("runs post-notify continuation only after the final success notification and contains continuation failures", async () => {
    const root = await tempDir();
    const events: string[] = [];
    const manager = await SessionJobManager.open({ stateDir: join(root, "jobs"), progressNotifyIntervalMs: 0 });
    managers.push(manager);
    await manager.start({
      destinationId: "session:continuation",
      text: "finish then continue",
      timestamp: Date.now(),
      origin: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      notify: async (text) => { events.push(`notify:${text}`); },
      async run() {
        return {
          text: "done",
          sessionId: "continuation",
          async afterNotify() {
            events.push("afterNotify");
            throw new Error("handoff failed");
          },
        };
      },
    });
    await waitUntil(
      () => events.some((entry) => entry.includes("post-completion continuation failed: handoff failed")),
      "post-notify continuation settlement",
    );
    const finalNoticeIndex = events.findIndex((entry) => entry.includes("Completed") && entry.includes("done"));
    const continuationIndex = events.indexOf("afterNotify");
    expect(finalNoticeIndex).toBeGreaterThanOrEqual(0);
    expect(continuationIndex).toBeGreaterThan(finalNoticeIndex);
    expect(manager.list({ activeOnly: true })).toEqual([]);
    expect(manager.list({ limit: 5 })[0]?.status).toBe("completed");
  });

  it("releases active ownership before a post-notify continuation quiesces session jobs", async () => {
    const root = await tempDir();
    const events: string[] = [];
    const manager = await SessionJobManager.open({ stateDir: join(root, "jobs"), quiesceTimeoutMs: 250 });
    managers.push(manager);
    await manager.start({
      destinationId: "session:handoff",
      text: "complete then hand off",
      timestamp: Date.now(),
      origin: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      notify: async (text) => { events.push(`notify:${text}`); },
      async run() {
        return {
          text: "ready",
          sessionId: "handoff",
          async afterNotify() {
            events.push(`active-before:${manager.list({ activeOnly: true }).length}`);
            await manager.quiesce();
            events.push("quiesced");
          },
        };
      },
    });
    await waitUntil(() => events.includes("quiesced"), "self-quiescing post-notify continuation");
    expect(events).toContain("active-before:0");
    expect(manager.list({ activeOnly: true })).toEqual([]);
  });

});
