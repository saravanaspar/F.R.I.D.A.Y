import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager, type KernelLaunchRequest } from "../src/kernel/index.js";
import { defaultKernelPythonPath } from "../src/python-path.js";

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "friday-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("reliably runs the first real IPC cell through a host-owned launcher", async () => {
		// Repeat fresh startups so the regression catches races between readiness
		// traffic and the first real shell/IOPub execution completion handshake.
		for (let attempt = 0; attempt < 5; attempt++) {
			let launchRequest: KernelLaunchRequest | undefined;
			const manager = new KernelManager({
				python: defaultKernelPythonPath(),
				cwd: tempDir,
				transport: "ipc",
				launcher(request) {
					launchRequest = request;
					return {
						command: request.python,
						args: ["-m", "ipykernel_launcher", "-f", request.connectionPath],
						cwd: request.cwd,
						env: request.env,
					};
				},
			});

			try {
				// Keep startup and first execution as separate assertions so an intermittent
				// failure reports the protocol phase instead of only hitting Vitest's outer timeout.
				await manager.start();
				expect(manager.isRunning, `attempt ${attempt + 1}: startup did not reach running`).toBe(true);

				const controller = new AbortController();
				const executionGuard = setTimeout(() => controller.abort(), 5_000);
				try {
					const result = await manager.execute("6 * 7", { signal: controller.signal });
					expect(result.status, `attempt ${attempt + 1}: first execution did not complete`).toBe("ok");
					expect(result.result).toBe("42");
				} finally {
					clearTimeout(executionGuard);
				}
				expect(launchRequest?.tempDir).toContain("friday-kernel-");
				expect(launchRequest?.connectionPath).toBe(join(launchRequest!.tempDir, "connection.json"));
			} finally {
				await manager.dispose();
			}
		}
	});

	it("fails cleanly when an IPC launcher executable disappears before startup", async () => {
		const missingPython = join(tempDir, "missing-python");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({
			python: missingPython,
			cwd: tempDir,
			transport: "ipc",
			launcher(request) {
				return {
					command: request.python,
					args: ["-m", "ipykernel_launcher", "-f", request.connectionPath],
					cwd: request.cwd,
					env: request.env,
				};
			},
		});

		try {
			await expect(manager.start()).rejects.toThrow(/Kernel exited during startup/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then exit 0; fi',
				'echo "fake kernel died before binding" >&2',
				"exit 42",
				"",
			].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});
});
