import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../plugins/execution/runtime/src/process/exec.js";
import type { ExecutionService } from "../plugins/execution/contract.js";
import type { SandboxService } from "../plugins/sandbox/contract.js";
import { createSecureEditOperations } from "../plugins/tools/secure-edit.js";

function directSandbox(): SandboxService {
  return {
    image: "test",
    assertAvailable() {},
    registerTrustedReadOnlyMount() {
      return () => undefined;
    },
    sandboxShell(request) {
      return { command: request.command, cwd: request.cwd, env: request.env };
    },
    sandboxProcess(request) {
      return { command: request.command, args: request.args, cwd: request.cwd, env: request.env };
    },
    sandboxKernel(request) {
      return { command: request.python, args: [], cwd: request.cwd, env: request.env };
    },
  };
}

const execution = { execCommand } as unknown as ExecutionService;

describe.skipIf(process.platform === "win32")("secure edit operations", () => {
  it("rejects a parent-directory symlink swap between read and write", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-secure-edit-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const originalDir = join(workspace, "dir");
    const heldDir = join(workspace, "dir-held");
    const target = join(originalDir, "target.txt");
    const outsideTarget = join(outside, "target.txt");
    mkdirSync(originalDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(target, "before", { mode: 0o600 });
    writeFileSync(outsideTarget, "before", { mode: 0o600 });

    try {
      const operations = createSecureEditOperations(workspace, execution, directSandbox());
      const original = await operations.readFile(target);
      expect(original.toString()).toBe("before");

      renameSync(originalDir, heldDir);
      symlinkSync(outside, originalDir, "dir");

      await expect(operations.writeFile(target, "after", original)).rejects.toThrow(/Secure edit failed/);
      expect(readFileSync(outsideTarget, "utf8")).toBe("before");
      expect(readFileSync(join(heldDir, "target.txt"), "utf8")).toBe("before");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces a regular in-workspace file and preserves its mode", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "friday-secure-edit-ok-"));
    const target = join(workspace, "target.txt");
    writeFileSync(target, "alpha", { mode: 0o640 });
    try {
      const operations = createSecureEditOperations(workspace, execution, directSandbox());
      const original = await operations.readFile(target);
      await operations.writeFile(target, "beta", original);
      expect(readFileSync(target, "utf8")).toBe("beta");
      expect(statSync(target).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
