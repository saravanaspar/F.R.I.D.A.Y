import { describe, expect, it, vi } from "vitest";
import { configureExecutionAccess, type ExecutionAccess } from "../src/execution-access.js";
import { createIpythonTool } from "../src/ipython.js";

describe("ipython tool", () => {
  it("preserves kernel state across tool calls", async () => {
    const tool = createIpythonTool(process.cwd());
    await tool.execute("py-1", { code: "counter = 40" });
    const result = await tool.execute("py-2", { code: "counter += 2\ncounter" });
    expect(result.content[0]).toEqual({ type: "text", text: "42" });
  });

  it("streams stdout updates", async () => {
    const tool = createIpythonTool(process.cwd());
    const onUpdate = vi.fn();
    const result = await tool.execute("py-3", { code: "print('hello')" }, undefined, onUpdate);
    expect(result.content[0]).toEqual({ type: "text", text: "hello\n" });
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "hello\n" }],
      details: { status: "ok" },
    });
  });

  it("converts standard image display payloads into model image blocks", async () => {
    const tool = createIpythonTool(process.cwd());
    const result = await tool.execute("py-4", { code: "display-image" });
    expect(result.content).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("throws kernel execution errors for the agent loop", async () => {
    const tool = createIpythonTool(process.cwd());
    await expect(tool.execute("py-5", { code: "raise-error" })).rejects.toThrow("RuntimeError: boom");
  });

  it("forwards host handlers, transport, launcher, and the pre-execution guard", async () => {
    let received: Parameters<ExecutionAccess["createKernel"]>[0] | undefined;
    const handler = async () => ({ accepted: true });
    const beforeExecute = vi.fn(async () => undefined);
    const launcher = vi.fn(() => ({ command: "sandbox-kernel", args: [], cwd: process.cwd(), env: {} }));
    configureExecutionAccess({
      createKernel(options) {
        received = options;
        return {
          async execute(code) {
            return { stdout: "", stderr: "", result: code, status: "ok", durationMs: 1 };
          },
          async dispose() {},
          async kill() {},
        };
      },
      createLocalShellOperations: () => ({
        async exec() {
          return { exitCode: 0 };
        },
      }),
      managedProcesses: {
        currentOwner: () => undefined,
        async start() {
          throw new Error("not configured");
        },
        list: () => [],
        get: () => undefined,
        logs: () => ({ text: "", truncated: false, totalBytes: 0 }),
        async stop() {
          throw new Error("not configured");
        },
      },
    });

    const tool = createIpythonTool(process.cwd(), {
      hostHandlers: { "runtime.call": handler },
      beforeExecute,
      transport: "ipc",
      launcher,
    });
    await tool.execute("py-host", { code: "1 + 1" });

    expect(beforeExecute).toHaveBeenCalledWith("1 + 1", undefined);
    expect(received?.hostHandlers?.["runtime.call"]).toBe(handler);
    expect(received?.transport).toBe("ipc");
    expect(received?.launcher).toBe(launcher);
  });
});
