import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { waitForChildProcess } from "./child-process.js";
import { reportOperationalError } from "@friday/operational-errors";

export interface ShellConfig {
  shell: string;
  args: string[];
}

export interface ShellOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

function findBashOnPath(): string | null {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && existsSync(firstMatch)) return firstMatch;
      }
    } catch {
      // friday-expected-control-flow: PATH probing falls through to known locations.
    }
    return null;
  }

  try {
    const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {
    // friday-expected-control-flow: PATH probing falls through to sh.
  }
  return null;
}

export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (existsSync(customShellPath)) return { shell: customShellPath, args: ["-c"] };
    throw new Error(`Custom shell path not found: ${customShellPath}`);
  }

  if (process.platform === "win32") {
    const paths: string[] = [];
    if (process.env.ProgramFiles) paths.push(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`);
    if (process.env["ProgramFiles(x86)"]) {
      paths.push(`${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);
    }
    for (const path of paths) {
      if (existsSync(path)) return { shell: path, args: ["-c"] };
    }
    const bashOnPath = findBashOnPath();
    if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
    throw new Error("No bash-compatible shell found");
  }

  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  const bashOnPath = findBashOnPath();
  if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
  return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch (error) {
      reportOperationalError({ component: "execution.process", operation: `terminate Windows process tree ${pid}`, error, severity: "warn" });
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // friday-expected-control-flow: a child may not own a POSIX process group.
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        reportOperationalError({ component: "execution.process", operation: `terminate process ${pid}`, error, severity: "warn" });
      }
    }
  }
}

export function createLocalShellOperations(options?: { shellPath?: string }): ShellOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) =>
      new Promise((resolve, reject) => {
        const { shell, args } = getShellConfig(options?.shellPath);
        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute shell commands.`));
          return;
        }

        const child = spawn(shell, [...args, command], {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? getShellEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const onAbort = () => {
          if (child.pid) killProcessTree(child.pid);
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        waitForChildProcess(child)
          .then((code) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
              return;
            }
            resolve({ exitCode: code });
          })
          .catch((error: unknown) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener("abort", onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      }),
  };
}
