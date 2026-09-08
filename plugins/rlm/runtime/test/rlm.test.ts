import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRlmDeleteSubagentHostHandler,
  createRlmFindModelsHostHandler,
  createRlmHostHandlers,
  createRlmRunHostHandler,
  getRlmPythonPath,
  installSubagentAccess,
  RLM_KERNEL_BOOTSTRAP,
  uninstallSubagentAccess,
  withRlmPythonPath,
  type RlmSubagentPort,
} from "../src/index.js";

const models = [
  { provider: "test", id: "parent", name: "Parent" },
  { provider: "test", id: "child-fast", name: "Child Fast" },
  { provider: "other", id: "child-deep", name: "Child Deep" },
] as const;

function hostContext(signal = new AbortController().signal) {
  return { requestId: "request-1", generation: 1, signal, isCurrent: () => !signal.aborted };
}

function modelSelector(model: (typeof models)[number]): string {
  return `${model.provider}/${model.id}`;
}

function findMatches(query: string, limit: number) {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return models
    .filter((model) => {
      if (!normalized) return true;
      return [modelSelector(model), model.id, model.name]
        .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ""))
        .some((value) => value.includes(normalized));
    })
    .slice(0, limit)
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      selector: modelSelector(model),
    }));
}

interface TestPort extends RlmSubagentPort {
  spawnCalls: Array<{ prompt: string; options: Parameters<RlmSubagentPort["spawn"]>[1] }>;
  deleteCalls: string[];
}

function createPort(): TestPort {
  const entries = [
    {
      childId: "sub-a",
      sessionId: "session-a",
      name: "api-reviewer",
      sessionDir: "/tmp/sub-a",
      status: "running" as const,
    },
    {
      childId: "sub-b",
      sessionId: "session-b",
      name: "finished",
      sessionDir: "/tmp/sub-b",
      status: "completed" as const,
    },
    {
      childId: "sub-c",
      sessionId: null,
      name: "cancelled",
      sessionDir: "/tmp/sub-c",
      status: "cancelled" as const,
    },
  ];
  const spawnCalls: TestPort["spawnCalls"] = [];
  const deleteCalls: string[] = [];
  return {
    spawnCalls,
    deleteCalls,
    async spawn(prompt, options) {
      spawnCalls.push({ prompt, options });
      return {
        childId: "sub-new",
        name: options?.name ?? "generated",
        sessionDir: "/tmp/sub-new",
        model: options?.model ?? "test/parent",
      };
    },
    list: () => entries.map((entry) => ({ ...entry })),
    async delete(target) {
      deleteCalls.push(target);
      const entry = entries.find((candidate) => candidate.childId === target || candidate.name === target);
      if (!entry) throw new Error(`no direct subagent matches "${target}"`);
      return { ...entry };
    },
  };
}

beforeEach(() => {
  installSubagentAccess({
    findModelMatches(query, availableModels, limit) {
      expect(availableModels).toEqual(models);
      return findMatches(query, limit);
    },
  });
});

afterEach(() => {
  uninstallSubagentAccess();
});

describe("RLM host bridge", () => {
  it("forwards a validated spawn request and source cell", async () => {
    const subagents = createPort();
    const handlers = createRlmHostHandlers({ subagents, models });
    const context = hostContext();
    const result = await handlers["rlm.run"]!({
      type: "rlm.run",
      prompt: "review API",
      kwargs: { name: " api-reviewer ", model: " test/child-fast " },
      cellSourceCode: "await rlm('review API')",
    }, context);

    expect(result).toEqual({
      rlm_child_id: "sub-new",
      name: "api-reviewer",
      session_dir: "/tmp/sub-new",
      model: "test/child-fast",
    });
    expect(subagents.spawnCalls).toHaveLength(1);
    expect(subagents.spawnCalls[0]).toMatchObject({
      prompt: "review API",
      options: {
        name: "api-reviewer",
        model: "test/child-fast",
        spawnCode: "await rlm('review API')",
        signal: context.signal,
      },
    });
  });

  it("supports bounded fan-out and fan-in host operations", async () => {
    const subagents = createPort();
    const handlers = createRlmHostHandlers({ subagents, models });
    const context = hostContext();
    const spawned = await handlers["rlm.spawn_many"]!({
      type: "rlm.spawn_many",
      tasks: [{ prompt: "one", name: "one" }, { prompt: "two", model: "test/child-fast" }],
      cellSourceCode: "await rlm.gather([...])",
    }, context);
    expect((spawned.subagents as unknown[])).toHaveLength(2);
    expect(subagents.spawnCalls).toHaveLength(2);
    expect(subagents.spawnCalls.map((call) => call.prompt)).toEqual(["one", "two"]);

    const waited = await handlers["rlm.wait_subagents"]!({
      type: "rlm.wait_subagents",
      targets: ["sub-b"],
      timeoutMs: 1_000,
    }, context);
    expect(waited).toMatchObject({ subagents: [{ rlm_child_id: "sub-b", status: "completed" }] });
  });

  it("rejects unsupported spawn kwargs", async () => {
    const handlers = createRlmHostHandlers({ subagents: createPort(), models });
    await expect(
      handlers["rlm.run"]!({ type: "rlm.run", prompt: "x", kwargs: { temperature: 0.2 } }, hostContext()),
    ).rejects.toThrow("Unsupported rlm.run kwargs: temperature");
  });

  it("rejects invalid spawn name and model values", async () => {
    const handlers = createRlmHostHandlers({ subagents: createPort(), models });
    await expect(
      handlers["rlm.run"]!({ type: "rlm.run", prompt: "x", kwargs: { name: 123 } }, hostContext()),
    ).rejects.toThrow("rlm.run name must be a string");
    await expect(
      handlers["rlm.run"]!({ type: "rlm.run", prompt: "x", kwargs: { model: "   " } }, hostContext()),
    ).rejects.toThrow("rlm.run model must not be empty");
  });

  it("validates raw rlm.run payloads", async () => {
    const handler = createRlmRunHostHandler(async () => ({
      rlm_child_id: "sub-a",
      name: "a",
      session_dir: "/tmp/a",
      model: "test/parent",
    }));
    await expect(handler({ prompt: 7 }, hostContext())).rejects.toThrow("rlm.run prompt must be a string");
  });

  it("searches the injected model catalog with a bounded limit", async () => {
    const handlers = createRlmHostHandlers({ subagents: createPort(), models });
    const result = await handlers["rlm.find_models"]!({
      type: "rlm.find_models",
      query: "child",
      limit: 1,
    }, hostContext());
    expect(result).toEqual({
      models: [{ provider: "test", id: "child-fast", name: "Child Fast", selector: "test/child-fast" }],
    });
  });

  it("rejects invalid model-search payloads", async () => {
    const handler = createRlmFindModelsHostHandler(async () => []);
    await expect(handler({ query: 1 }, hostContext())).rejects.toThrow("rlm.find_models query must be a string");
    await expect(handler({ query: "x", limit: 0 }, hostContext())).rejects.toThrow("rlm.find_models limit must be an integer from 1 to 20");
    await expect(handler({ query: "x", limit: 21 }, hostContext())).rejects.toThrow("rlm.find_models limit must be an integer from 1 to 20");
  });

  it("maps child registry state to the stable RLM wire shape", async () => {
    const handlers = createRlmHostHandlers({ subagents: createPort(), models });
    const result = await handlers["rlm.list_subagents"]!({ type: "rlm.list_subagents" }, hostContext());
    expect(result).toEqual({
      subagents: [
        {
          rlm_child_id: "sub-a",
          active_session_id: null,
          session_id: "session-a",
          session_name: "api-reviewer",
          session_dir: "/tmp/sub-a",
          status: "running",
        },
        {
          rlm_child_id: "sub-b",
          active_session_id: null,
          session_id: "session-b",
          session_name: "finished",
          session_dir: "/tmp/sub-b",
          status: "completed",
        },
        {
          rlm_child_id: "sub-c",
          active_session_id: null,
          session_id: null,
          session_name: "cancelled",
          session_dir: "/tmp/sub-c",
          status: "error",
        },
      ],
    });
  });

  it("deletes by a trimmed direct-child selector", async () => {
    const subagents = createPort();
    const handlers = createRlmHostHandlers({ subagents, models });
    const result = await handlers["rlm.delete_subagent"]!({
      type: "rlm.delete_subagent",
      target: " api-reviewer ",
    }, hostContext());
    expect(subagents.deleteCalls).toEqual(["api-reviewer"]);
    expect(result).toMatchObject({ subagent: { rlm_child_id: "sub-a", status: "running" } });
  });

  it("rejects an empty delete selector", async () => {
    const handler = createRlmDeleteSubagentHostHandler(async () => {
      throw new Error("should not run");
    });
    await expect(handler({ target: "   " }, hostContext())).rejects.toThrow("rlm.delete_subagent target must be a non-empty string");
  });

  it("rejects host work immediately when kernel disposal has revoked the request", async () => {
    const controller = new AbortController();
    controller.abort("kernel disposed");
    const handlers = createRlmHostHandlers({ subagents: createPort(), models });
    await expect(handlers["rlm.list_subagents"]!({ type: "rlm.list_subagents" }, hostContext(controller.signal)))
      .rejects.toThrow();
  });
});

describe("RLM Python shim", () => {
  it("exposes a package path and bootstrap statement", () => {
    const path = getRlmPythonPath();
    expect(path).toMatch(/plugins[\\/]rlm[\\/]runtime[\\/]python$/);
    expect(RLM_KERNEL_BOOTSTRAP).toBe("from rlm import rlm");
  });

  it("prepends its package without discarding an existing PYTHONPATH", () => {
    const path = getRlmPythonPath();
    expect(withRlmPythonPath({ PYTHONPATH: "/existing" }).PYTHONPATH).toBe(`${path}${delimiter}/existing`);
  });

  it("passes the Python shim tests", () => {
    const pythonPath = getRlmPythonPath();
    execFileSync("python3", ["-m", "unittest", "discover", "-s", `${pythonPath}/tests`, "-p", "test_*.py"], {
      env: { ...process.env, PYTHONPATH: pythonPath },
      stdio: "pipe",
    });
  });
});
