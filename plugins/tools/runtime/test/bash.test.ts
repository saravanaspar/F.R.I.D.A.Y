import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../src/bash.js";
import type { ShellOperations } from "../src/execution-access.js";

describe("bash tool", () => {
  it("streams output and returns the final output", async () => {
    const operations: ShellOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("hello "));
        onData(Buffer.from("world\n"));
        return { exitCode: 0 };
      },
    };
    const tool = createBashTool(process.cwd(), { operations });
    const onUpdate = vi.fn();
    const result = await tool.execute("call-1", { command: "echo hello" }, undefined, onUpdate);
    expect(result.content).toEqual([{ type: "text", text: "hello world\n" }]);
    expect(onUpdate).toHaveBeenCalled();
  });

  it("surfaces non-zero exit status", async () => {
    const operations: ShellOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("bad\n"));
        return { exitCode: 7 };
      },
    };
    const tool = createBashTool(process.cwd(), { operations });
    await expect(tool.execute("call-2", { command: "false" })).rejects.toThrow(/bad[\s\S]*code 7/);
  });

  it("surfaces execution timeouts", async () => {
    const operations: ShellOperations = {
      exec: async () => {
        throw new Error("timeout:3");
      },
    };
    const tool = createBashTool(process.cwd(), { operations });
    await expect(tool.execute("call-3", { command: "sleep 30", timeout: 3 })).rejects.toThrow(
      "Command timed out after 3 seconds",
    );
  });

  it("enforces a foreground timeout even when the caller omits one", async () => {
    let observedTimeout: number | undefined;
    const operations: ShellOperations = {
      exec: async (_command, _cwd, options) => {
        observedTimeout = options.timeout;
        return { exitCode: 0 };
      },
    };
    const tool = createBashTool(process.cwd(), { operations });
    await tool.execute("call-default-timeout", { command: "echo bounded" });
    expect(observedTimeout).toBe(600);
  });
});
