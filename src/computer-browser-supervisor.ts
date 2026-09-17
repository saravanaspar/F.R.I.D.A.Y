import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { getFridayHome, readRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";

function forward(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.killed) return;
  try { child.kill(signal); } catch { /* friday-expected-control-flow: child may exit between the state check and signal */ }
}

export async function runComputerBrowserSupervisor(): Promise<void> {
  if (process.platform !== "linux") throw new Error("FRIDAY Computer browser supervisor is Linux-only");
  const home = getFridayHome(process.env);
  const settings = await readRuntimeSettings(home);
  const computer = settings?.computer;
  if (!computer) throw new Error("Computer is not configured; run `friday setup computer`");
  if (computer.browserMode !== "managed-cdp") {
    throw new Error("Computer browser supervisor is only used by managed-cdp mode");
  }
  if (!computer.browserProfileDir || !computer.cdpPort) throw new Error("managed-cdp browser settings are incomplete");
  await mkdir(computer.browserProfileDir, { recursive: true, mode: 0o700 });
  const args = [
    ...(computer.browserArgs ?? []),
    "--ozone-platform=x11",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${computer.cdpPort}`,
    `--user-data-dir=${computer.browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
  ];
  const child = spawn(computer.browserBin, args, { stdio: "inherit", env: process.env });
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => forward(child, signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    await new Promise<void>((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("exit", (code, signal) => {
        if (code === 0) { resolveRun(); return; }
        rejectRun(new Error(`Computer browser exited${signal ? ` with ${signal}` : ` with code ${code ?? "unknown"}`}`));
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
