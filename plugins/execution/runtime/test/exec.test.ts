import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/process/exec.js";

const SIGKILL_EXIT_CODE = 128 + constants.signals.SIGKILL;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("Child did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe.skipIf(process.platform === "win32")("execCommand", () => {
	it("bounds combined stdout/stderr capture and terminates output floods", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "for (;;) process.stdout.write('0123456789abcdef')"],
			process.cwd(),
			{ maxOutputBytes: 4096 },
		);

		expect(result.killed).toBe(true);
		expect(result.outputLimitExceeded).toBe(true);
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4096);
		expect(result.totalOutputBytes).toBeGreaterThan(4096);
	});

	it("supports bounded stdin-driven helpers", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "process.stdin.pipe(process.stdout)"],
			process.cwd(),
			{ stdin: "hello" },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("hello");
		expect(result.outputLimitExceeded).toBe(false);
	});

	it("can replace rather than inherit the host environment", async () => {
		const key = "FRIDAY_EXEC_PARENT_SECRET_TEST";
		const previous = process.env[key];
		process.env[key] = "host-secret";
		try {
			const result = await execCommand(
				process.execPath,
				["-e", `process.stdout.write(JSON.stringify({ inherited: process.env.${key}, explicit: process.env.FRIDAY_EXEC_EXPLICIT_TEST }))`],
				process.cwd(),
				{ env: { FRIDAY_EXEC_EXPLICIT_TEST: "present" }, replaceEnv: true },
			);

			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ explicit: "present" });
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
	});

	it("rejects an invalid output quota before spawning", async () => {
		await expect(execCommand(process.execPath, ["-e", "process.exit(0)"], process.cwd(), { maxOutputBytes: 0 }))
			.rejects.toThrow("maxOutputBytes");
	});

	it("force kills a process that ignores SIGTERM and cleans up the fallback timer", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "friday-exec-test-"));
		const readyFile = join(testDir, "ready");
		const controller = new AbortController();
		let resultPromise: Promise<Awaited<ReturnType<typeof execCommand>>> | undefined;
		try {
			resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], ""); setInterval(() => {}, 1000);`,
					readyFile,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			await waitForFile(readyFile);

			vi.useFakeTimers();
			controller.abort();

			await vi.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result.killed).toBe(true);
			expect(result.code).toBe(SIGKILL_EXIT_CODE);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			controller.abort();
			await resultPromise;
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
