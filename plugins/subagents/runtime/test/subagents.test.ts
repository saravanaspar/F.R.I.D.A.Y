import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSubagentName,
  createSessionSubagentRegistryStore,
  findSubagentModelMatches,
  normalizeRequestedSubagentName,
  SubagentManager,
  type CreateSubagentRuntimeOptions,
  type SubagentRuntime,
  type SubagentRuntimeHost,
} from "../src/index.js";

const parentModel = { provider: "test", id: "parent", name: "Parent" };
const otherModel = { provider: "test", id: "worker", name: "Worker Model" };
const thirdModel = { provider: "other", id: "worker-large", name: "Worker Large" };

interface HostControl {
  host: SubagentRuntimeHost;
  created: CreateSubagentRuntimeOptions[];
  runtimes: Map<string, ControlledRuntime>;
  deleted: Array<{ id: string; hasRuntime: boolean }>;
  released: Array<{ id: string; status: string }>;
}

class ControlledRuntime implements SubagentRuntime {
  readonly sessionId: string;
  readonly sessionName: string;
  aborted = false;
  disposed = false;
  private resolveRun!: () => void;
  private rejectRun!: (error: Error) => void;
  private readonly completion = new Promise<void>((resolve, reject) => {
    this.resolveRun = resolve;
    this.rejectRun = reject;
  });

  constructor(readonly options: CreateSubagentRuntimeOptions, private autoComplete = false) {
    this.sessionId = `session-${options.id}`;
    this.sessionName = options.name;
  }

  async run(_prompt: string, signal: AbortSignal): Promise<void> {
    if (this.autoComplete) return;
    if (signal.aborted) throw new Error("aborted");
    await Promise.race([
      this.completion,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
  }

  abort(): void {
    this.aborted = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  complete(): void {
    this.resolveRun();
  }

  fail(message: string): void {
    this.rejectRun(new Error(message));
  }
}

function createHost(autoComplete = false): HostControl {
  const created: CreateSubagentRuntimeOptions[] = [];
  const runtimes = new Map<string, ControlledRuntime>();
  const deleted: Array<{ id: string; hasRuntime: boolean }> = [];
  const released: Array<{ id: string; status: string }> = [];
  return {
    created,
    runtimes,
    deleted,
    released,
    host: {
      async create(options) {
        created.push(options);
        const runtime = new ControlledRuntime(options, autoComplete);
        runtimes.set(options.id, runtime);
        return runtime;
      },
      async delete(id, runtime) {
        deleted.push({ id, hasRuntime: runtime !== undefined });
        await runtime?.dispose?.();
      },
      async release(_runtime, options, status) {
        released.push({ id: options.id, status });
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("subagent naming", () => {
  it("normalizes requested names", () => {
    expect(normalizeRequestedSubagentName(undefined)).toBeUndefined();
    expect(normalizeRequestedSubagentName("  api-reviewer  ")).toBe("api-reviewer");
    expect(() => normalizeRequestedSubagentName("   ")).toThrow("must not be empty");
    expect(() => normalizeRequestedSubagentName(123)).toThrow("must be a string");
    expect(() => normalizeRequestedSubagentName("x".repeat(65))).toThrow("at most 64");
  });

  it("creates readable collision-resistant bounded defaults", () => {
    expect(createDefaultSubagentName("Summarize the HTTP API!", "sub-a1b2c3d4")).toBe(
      "subagent-summarize-the-http-api-a1b2c3d4",
    );
    expect(createDefaultSubagentName("same task", "sub-a1b2c3d4")).not.toBe(
      createDefaultSubagentName("same task", "sub-eeeeffff"),
    );
    expect(createDefaultSubagentName("x".repeat(200), "sub-a1b2c3d4")).toHaveLength(64);
  });
});

describe("subagent model selection", () => {
  it("ranks exact, prefix, and partial matches with a bounded result", () => {
    const models = [parentModel, otherModel, thirdModel];
    expect(findSubagentModelMatches("test/worker", models, 2)[0]?.selector).toBe("test/worker");
    expect(findSubagentModelMatches("worker", models, 3).map((model) => model.selector)).toEqual([
      "test/worker",
      "other/worker-large",
    ]);
    expect(findSubagentModelMatches("large", models, 3)[0]?.selector).toBe("other/worker-large");
    expect(() => findSubagentModelMatches("", models, 21)).toThrow("integer from 1 to 20");
  });
});

describe("SubagentManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function createManager(host = createHost(), options: Partial<Parameters<typeof SubagentManager.create>[0]> = {}) {
    const artifactDir = mkdtempSync(join(tmpdir(), "friday-subagents-test-"));
    dirs.push(artifactDir);
    const manager = await SubagentManager.create({
      parentId: "parent",
      parentArtifactDir: artifactDir,
      parentModel,
      models: [parentModel, otherModel, thirdModel],
      runtimeHost: host.host,
      ...options,
    });
    return { manager, host };
  }

  it("rejects recursion at the configured depth limit", async () => {
    const { manager } = await createManager(createHost(), { depth: 1, maxDepth: 1 });
    await expect(manager.spawn("too deep")).rejects.toThrow("recursion depth limit reached");
  });

  it("inherits the parent model by default", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("inspect the API");
    expect(handle.model).toBe("test/parent");
    await waitFor(() => host.created.length === 1);
    expect(host.created[0]?.model).toMatchObject(parentModel);
  });

  it("uses an exact requested model and rejects unavailable selectors", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("inspect", { model: "test/worker" });
    expect(handle.model).toBe("test/worker");
    await waitFor(() => host.created.length === 1);
    expect(host.created[0]?.model.id).toBe("worker");
    await expect(manager.spawn("bad", { model: "test/missing" })).rejects.toThrow("is not available");
  });

  it("lets the caller choose a unique child name", async () => {
    const { manager } = await createManager();
    const first = await manager.spawn("one", { name: " api-reviewer " });
    expect(first.name).toBe("api-reviewer");
    await expect(manager.spawn("two", { name: "api-reviewer" })).rejects.toThrow("is unavailable");
  });

  it("returns an admission handle before the child task completes", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("long task");
    expect(handle.childId).toMatch(/^sub-/);
    expect(["queued", "running"]).toContain(manager.get(handle.childId)?.status);
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    expect(host.runtimes.get(handle.childId)).toBeDefined();
  });

  it("transitions a detached child to completed and releases it", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("finish");
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    host.runtimes.get(handle.childId)?.complete();
    await waitFor(() => manager.get(handle.childId)?.status === "completed");
    expect(manager.get(handle.childId)?.sessionId).toBe(`session-${handle.childId}`);
    expect(host.released).toEqual([{ id: handle.childId, status: "completed" }]);
  });

  it("records child failures without rejecting the admission call", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("fail later");
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    host.runtimes.get(handle.childId)?.fail("child failed");
    await waitFor(() => manager.get(handle.childId)?.status === "error");
    expect(manager.get(handle.childId)?.error).toBe("child failed");
    expect(host.released).toEqual([{ id: handle.childId, status: "error" }]);
  });

  it("cancels a running child and aborts its runtime", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("cancel me");
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    expect(manager.cancel(handle.childId, "stop now")).toBe(true);
    await waitFor(() => manager.get(handle.childId)?.status === "cancelled");
    expect(host.runtimes.get(handle.childId)?.aborted).toBe(true);
    expect(manager.get(handle.childId)?.error).toBe("stop now");
  });

  it("cancels child startup when its host-request signal is revoked", async () => {
    const { manager } = await createManager();
    const controller = new AbortController();
    const handle = await manager.spawn("cancel from kernel", { signal: controller.signal });
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    controller.abort("kernel disposed");
    await waitFor(() => manager.get(handle.childId)?.status === "cancelled");
    expect(manager.get(handle.childId)?.error).toBe("Host request was cancelled");
  });

  it("lists defensive registry snapshots", async () => {
    const host = createHost(true);
    const { manager } = await createManager(host);
    const one = await manager.spawn("one", { name: "one" });
    const two = await manager.spawn("two", { name: "two" });
    await waitFor(() => manager.get(one.childId)?.status === "completed" && manager.get(two.childId)?.status === "completed");
    const listed = manager.list();
    expect(listed.map((entry) => entry.name).sort()).toEqual(["one", "two"]);
    listed[0]!.name = "mutated";
    expect(manager.get(listed[0]!.childId)?.name).not.toBe("mutated");
  });

  it("does not resurrect a running child when deletion races detached startup", async () => {
    const customEntries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
    const session = {
      getBranch: () => customEntries,
      appendCustomEntry(customType: string, data?: unknown) {
        customEntries.push({ type: "custom", customType, data });
        return String(customEntries.length);
      },
    };
    const host = createHost();
    const artifactDir = mkdtempSync(join(tmpdir(), "friday-subagents-delete-race-"));
    dirs.push(artifactDir);
    const store = createSessionSubagentRegistryStore(session);
    const manager = await SubagentManager.create({
      parentId: "parent",
      parentArtifactDir: artifactDir,
      parentModel,
      runtimeHost: host.host,
      registryStore: store,
    });
    const handle = await manager.spawn("delete while running", { name: "race" });
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    await manager.delete(handle.childId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reopened = await SubagentManager.create({
      parentId: "parent",
      parentArtifactDir: artifactDir,
      parentModel,
      runtimeHost: createHost(true).host,
      registryStore: store,
    });
    expect(reopened.get(handle.childId)).toBeUndefined();
  });

  it("deletes completed children by id without erasing their directory itself", async () => {
    const host = createHost(true);
    const { manager } = await createManager(host);
    const handle = await manager.spawn("done", { name: "done" });
    await waitFor(() => manager.get(handle.childId)?.status === "completed");
    const deleted = await manager.delete(handle.childId);
    expect(deleted.childId).toBe(handle.childId);
    expect(manager.get(handle.childId)).toBeUndefined();
    expect(host.deleted).toEqual([{ id: handle.childId, hasRuntime: true }]);
  });

  it("deletes retained children by unique name", async () => {
    const host = createHost(true);
    const { manager } = await createManager(host);
    const handle = await manager.spawn("done", { name: "named-worker" });
    await waitFor(() => manager.get(handle.childId)?.status === "completed");
    await manager.delete("named-worker");
    expect(manager.list()).toEqual([]);
  });

  it("rejects ambiguous selectors", async () => {
    const host = createHost(true);
    const { manager } = await createManager(host);
    const first = await manager.spawn("first", { name: "first" });
    const second = await manager.spawn("second", { name: `session-${first.childId}` });
    await waitFor(() => manager.get(first.childId)?.status === "completed" && manager.get(second.childId)?.status === "completed");
    await expect(manager.delete(`session-${first.childId}`)).rejects.toThrow("ambiguous");
  });

  it("rejects spawn after disposal and disposes active runtimes", async () => {
    const { manager, host } = await createManager();
    const handle = await manager.spawn("still running");
    await waitFor(() => manager.get(handle.childId)?.status === "running");
    await manager.dispose();
    expect(host.runtimes.get(handle.childId)?.aborted).toBe(true);
    expect(host.runtimes.get(handle.childId)?.disposed).toBe(true);
    await expect(manager.spawn("late")).rejects.toThrow("after its manager was disposed");
  });

  it("emits lifecycle snapshots", async () => {
    const host = createHost(true);
    const { manager } = await createManager(host);
    const statuses: string[] = [];
    manager.subscribe((event) => statuses.push(event.child.status));
    const handle = await manager.spawn("quick");
    await waitFor(() => manager.get(handle.childId)?.status === "completed");
    expect(statuses).toEqual(["queued", "running", "completed"]);
  });

  it("persists and restores the parent-scoped registry through generic session custom entries", async () => {
    const customEntries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
    const session = {
      getBranch: () => customEntries,
      appendCustomEntry(customType: string, data?: unknown) {
        customEntries.push({ type: "custom", customType, data });
        return String(customEntries.length);
      },
    };
    const firstHost = createHost(true);
    const artifactDir = mkdtempSync(join(tmpdir(), "friday-subagents-persist-"));
    dirs.push(artifactDir);
    const first = await SubagentManager.create({
      parentId: "parent",
      parentArtifactDir: artifactDir,
      parentModel,
      runtimeHost: firstHost.host,
      registryStore: createSessionSubagentRegistryStore(session),
    });
    const handle = await first.spawn("persist me", { name: "persisted" });
    await waitFor(() => first.get(handle.childId)?.status === "completed");

    const secondHost = createHost(true);
    const reopened = await SubagentManager.create({
      parentId: "parent",
      parentArtifactDir: artifactDir,
      parentModel,
      runtimeHost: secondHost.host,
      registryStore: createSessionSubagentRegistryStore(session),
    });
    expect(reopened.get(handle.childId)).toMatchObject({ name: "persisted", status: "completed" });
    await reopened.delete(handle.childId);

    const third = await SubagentManager.create({
      parentId: "parent",
      parentArtifactDir: artifactDir,
      parentModel,
      runtimeHost: createHost(true).host,
      registryStore: createSessionSubagentRegistryStore(session),
    });
    expect(third.list()).toEqual([]);
  });

  it("ignores malformed session-backed registry events", async () => {
    const customEntries = [
      { type: "custom", customType: "subagents.registry", data: { version: 1, action: "upsert", entry: { childId: 123 } } },
      { type: "custom", customType: "other", data: { version: 1, action: "remove", childId: "missing" } },
    ];
    const session = {
      getBranch: () => customEntries,
      appendCustomEntry: vi.fn(() => "1"),
    };
    const store = createSessionSubagentRegistryStore(session);
    expect(await store.load()).toEqual([]);
  });
});
