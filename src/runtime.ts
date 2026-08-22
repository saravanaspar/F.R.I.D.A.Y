#!/usr/bin/env node
import "./version.js";
import { activateConfiguredPlugins } from "./bootstrap.js";
import { loadRuntimeEnvironment } from "./host/runtime-env.js";
import { reportOperationalError } from "@friday/operational-errors";
import { acquireRuntimeLease, isVerifiedLifecycleSuccessor } from "./runtime-coordination.js";
import { pathToFileURL } from "node:url";
import { installFatalCrashHandlers, recordFatalCrash } from "./crash-log.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function shutdownTimeoutMs(): number {
  const parsed = Number(process.env.FRIDAY_SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 300_000
    ? Math.floor(parsed)
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

async function disposeWithinDeadline(dispose: () => void | Promise<void>): Promise<void> {
  const timeoutMs = shutdownTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(dispose),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`shutdown exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForShutdown(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!controller.signal.aborted) {
      await new Promise<void>((resolveStop) => {
        controller.signal.addEventListener("abort", () => resolveStop(), { once: true });
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runRuntime(): Promise<void> {
  installFatalCrashHandlers();
  let runtime: Awaited<ReturnType<typeof activateConfiguredPlugins>> | undefined;
  let releaseRuntimeLease: (() => Promise<void>) | undefined;
  let forceExit = false;
  try {
    await loadRuntimeEnvironment();
    const verifiedLifecycleSuccessor = await isVerifiedLifecycleSuccessor(process.env);
    releaseRuntimeLease = await acquireRuntimeLease({
      allowConcurrent: verifiedLifecycleSuccessor,
    });
    runtime = await activateConfiguredPlugins();
    process.stdout.write("FRIDAY ready.\n");
    await waitForShutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportOperationalError({ component: "runtime", operation: runtime ? "run" : "start", error });
    recordFatalCrash(runtime ? "runtime" : "startup", error);
    process.stderr.write(`friday: ${runtime ? "runtime" : "startup"} failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    if (runtime) {
      try {
        await disposeWithinDeadline(() => runtime!.dispose());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportOperationalError({ component: "runtime", operation: "shutdown", error });
        recordFatalCrash("shutdown", error);
        process.stderr.write(`friday: shutdown failed: ${message}\n`);
        process.exitCode = 1;
        forceExit = true;
      }
    }
    if (releaseRuntimeLease && !forceExit) {
      try {
        await releaseRuntimeLease();
      } catch (error) {
        reportOperationalError({ component: "runtime", operation: "release runtime lease", error });
        recordFatalCrash("release-runtime-lease", error);
        process.stderr.write(`friday: runtime lease release failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        forceExit = true;
      }
    }
    if (forceExit) {
      // A failed cleanup can leave transports or workers alive. Keep the lease until
      // process death, then guarantee termination after stderr has a chance to flush.
      setTimeout(() => process.exit(1), 100);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) void runRuntime();
