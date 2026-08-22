import { configureExecutionAccess, type KernelExecuteResult, type KernelHandle } from "../src/execution-access.js";

class FakeKernel implements KernelHandle {
  private counter = 0;

  async execute(code: string, options?: { onStream?: (chunk: string, name: "stdout" | "stderr") => void }): Promise<KernelExecuteResult> {
    if (code.includes("counter = 40")) {
      this.counter = 40;
      return { stdout: "", stderr: "", status: "ok", durationMs: 1 };
    }
    if (code.includes("counter += 2")) {
      this.counter += 2;
      return { stdout: "", stderr: "", result: String(this.counter), status: "ok", durationMs: 1 };
    }
    if (code.includes("print('hello')")) {
      options?.onStream?.("hello\n", "stdout");
      return { stdout: "hello\n", stderr: "", status: "ok", durationMs: 1 };
    }
    if (code.includes("display-image")) {
      return {
        stdout: "",
        stderr: "",
        status: "ok",
        durationMs: 1,
        displayData: [{ messageType: "display_data", data: { "image/png": "aGVsbG8=" }, metadata: {} }],
      };
    }
    if (code.includes("raise-error")) {
      return {
        stdout: "",
        stderr: "",
        status: "error",
        durationMs: 1,
        error: { ename: "RuntimeError", evalue: "boom", traceback: ["RuntimeError: boom"] },
      };
    }
    return { stdout: "", stderr: "", result: code, status: "ok", durationMs: 1 };
  }

  async dispose(): Promise<void> {}
  async kill(): Promise<void> {}
}

configureExecutionAccess({
  createKernel: () => new FakeKernel(),
  createLocalShellOperations: () => ({
    exec: async (command, _cwd, { onData }) => {
      onData(Buffer.from(`${command}\n`));
      return { exitCode: 0 };
    },
  }),
  managedProcesses: {
    currentOwner: () => undefined,
    async start() {
      throw new Error("managed process start is not configured for this test");
    },
    list: () => [],
    get: () => undefined,
    logs: () => ({ text: "", truncated: false, totalBytes: 0 }),
    async stop() {
      throw new Error("managed process stop is not configured for this test");
    },
  },
});
