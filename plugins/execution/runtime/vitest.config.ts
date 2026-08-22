import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // These tests launch real Python/Jupyter child processes and ZeroMQ sockets.
    // Serialize files so parallel kernel startups cannot make the suite flaky
    // under a loaded full-repository gate.
    fileParallelism: false,
    // KernelManager intentionally owns a 15s production readiness timeout.
    // Keep the test runner above that ceiling so runtime diagnostics win instead
    // of Vitest masking them with its own timeout first.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
