import { describe, expect, it, vi } from "vitest";
import { ManagedProcessSupervisor } from "../src/process/supervisor.js";

describe.skipIf(process.platform === "win32")("ManagedProcessSupervisor", () => {
  it("owns background processes by agent run and cleans them before the run settles", async () => {
    const cleanup = vi.fn(async () => undefined);
    const supervisor = new ManagedProcessSupervisor({ janitorIntervalMs: 60_000 });
    try {
      await supervisor.withRun(
        { sessionId: "session-1", runId: "run-1", ownerKind: "main-agent" },
        async () => {
          const started = await supervisor.start({
            id: "proc-1",
            command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
            cwd: process.cwd(),
            cleanup,
          });
          expect(started.state).toBe("running");
          expect(supervisor.list()).toHaveLength(1);
        },
      );
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(() => supervisor.list()).toThrow("active agent run");
    } finally {
      await supervisor.close();
    }
  });

  it("rejects persistent background processes from subagent runs", async () => {
    const supervisor = new ManagedProcessSupervisor();
    try {
      await expect(
        supervisor.withRun(
          { sessionId: "session-1", runId: "child-1", ownerKind: "subagent" },
          () => supervisor.start({ id: "proc-child", command: "sleep 10", cwd: process.cwd() }),
        ),
      ).rejects.toThrow("top-level FRIDAY agent");
    } finally {
      await supervisor.close();
    }
  });

  it("retains a bounded log tail instead of unbounded output", async () => {
    const supervisor = new ManagedProcessSupervisor({ maxLogBytes: 32 });
    try {
      await supervisor.withRun(
        { sessionId: "session-1", runId: "run-logs", ownerKind: "main-agent" },
        async () => {
          await supervisor.start({
            id: "proc-logs",
            command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(256)); setInterval(() => {}, 1000)"`,
            cwd: process.cwd(),
          });
          const deadline = Date.now() + 5_000;
          while (supervisor.logs("proc-logs").totalBytes < 256) {
            if (Date.now() >= deadline) throw new Error("background process did not produce output");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const logs = supervisor.logs("proc-logs");
          expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(32);
          expect(logs.truncated).toBe(true);
          expect(logs.totalBytes).toBeGreaterThanOrEqual(256);
        },
      );
    } finally {
      await supervisor.close();
    }
  });

  it("supports direct argv launch specs for sandbox wrappers without shell re-parsing", async () => {
    const supervisor = new ManagedProcessSupervisor();
    try {
      await supervisor.withRun(
        { sessionId: "session-1", runId: "run-direct", ownerKind: "main-agent" },
        async () => {
          await supervisor.start({
            id: "proc-direct",
            command: "user-visible command",
            launch: {
              command: process.execPath,
              args: ["-e", "process.stdout.write(process.argv[1]); setInterval(() => {}, 1000)", "argv-safe"],
            },
            cwd: process.cwd(),
          });
          const deadline = Date.now() + 5_000;
          while (!supervisor.logs("proc-direct").text.includes("argv-safe")) {
            if (Date.now() >= deadline) throw new Error("direct launch did not produce expected output");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(supervisor.get("proc-direct")?.command).toBe("user-visible command");
        },
      );
    } finally {
      await supervisor.close();
    }
  });
});
