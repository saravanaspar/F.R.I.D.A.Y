import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KernelManager } from "../src/kernel/index.js";
import { defaultKernelPythonPath } from "../src/python-path.js";

let cwd = "";
let previousForkSetting: string | undefined;

describe("persistent Python kernel", () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "friday-kernel-live-"));
    previousForkSetting = process.env.FRIDAY_KERNEL_FORKSERVER;
    process.env.FRIDAY_KERNEL_FORKSERVER = "0";
  });

  afterEach(() => {
    if (previousForkSetting === undefined) delete process.env.FRIDAY_KERNEL_FORKSERVER;
    else process.env.FRIDAY_KERNEL_FORKSERVER = previousForkSetting;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("preserves Python state across cells and streams stdout", async () => {
    const kernel = new KernelManager({ python: defaultKernelPythonPath(), cwd });
    const chunks: string[] = [];
    try {
      const first = await kernel.execute("counter = 40\nprint('ready')", {
        onStream: (chunk, name) => {
          if (name === "stdout") chunks.push(chunk);
        },
      });
      expect(first.status).toBe("ok");
      expect(first.stdout).toContain("ready");
      expect(chunks.join("")).toContain("ready");

      const second = await kernel.execute("counter += 2\ncounter");
      expect(second.status).toBe("ok");
      expect(second.result).toBe("42");
    } finally {
      await kernel.dispose();
    }
  });

  it("returns raw display_data without interpreting tool-specific MIME payloads", async () => {
    const kernel = new KernelManager({ python: defaultKernelPythonPath(), cwd });
    try {
      const result = await kernel.execute(
        "from IPython.display import display\ndisplay({'kind': 'demo'}, raw=True)",
      );
      expect(result.status).toBe("ok");
      expect(result.displayData?.some((entry) => entry.data.kind === "demo")).toBe(true);
    } finally {
      await kernel.dispose();
    }
  });
});
