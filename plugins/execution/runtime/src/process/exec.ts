/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { reportOperationalError } from "@friday/operational-errors";
import { waitForChildProcess } from "./child-process.js";

/**
 * Options for executing shell commands.
 */
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Extra env vars merged over the parent process env for this command.
	 * A key with an undefined value is unset in the child.
	 */
	env?: Record<string, string | undefined>;
	/** Hard combined stdout/stderr capture quota. */
	maxOutputBytes?: number;
	/** Optional stdin payload. */
	stdin?: string | Buffer;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	outputLimitExceeded: boolean;
	totalOutputBytes: number;
}

function mergeExecEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
	if (!env) {
		return undefined;
	}
	const merged: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 256 * 1024 * 1024) {
		throw new Error("maxOutputBytes must be an integer between 1 and 268435456");
	}

	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			// Merge per-call env over the parent env so callers can scope vars
			// without mutating the shared process.env.
			env: mergeExecEnv(options?.env),
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let outputLimitExceeded = false;
		let totalOutputBytes = 0;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillTimeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				forceKillTimeoutId = setTimeout(() => {
					forceKillTimeoutId = undefined;
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		const capture = (target: "stdout" | "stderr", data: Buffer) => {
			const remaining = Math.max(0, maxOutputBytes - Math.min(totalOutputBytes, maxOutputBytes));
			totalOutputBytes += data.length;
			if (remaining > 0) {
				const accepted = data.length <= remaining ? data : data.subarray(0, remaining);
				if (target === "stdout") stdout += accepted.toString();
				else stderr += accepted.toString();
			}
			if (totalOutputBytes > maxOutputBytes && !outputLimitExceeded) {
				outputLimitExceeded = true;
				killProcess();
			}
		};

		proc.stdout?.on("data", (data: Buffer) => capture("stdout", data));
		proc.stderr?.on("data", (data: Buffer) => capture("stderr", data));

		if (options?.stdin !== undefined && proc.stdin) {
			proc.stdin.end(options.stdin);
		}

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (forceKillTimeoutId) clearTimeout(forceKillTimeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				cleanup();
				resolve({ stdout, stderr, code: code ?? 0, killed, outputLimitExceeded, totalOutputBytes });
			})
				.catch((error) => {
					cleanup();
					reportOperationalError({ component: "execution.process", operation: `wait for child process ${proc.pid ?? "unknown"}`, error });
					resolve({ stdout, stderr, code: 1, killed, outputLimitExceeded, totalOutputBytes });
			});
	});
}
