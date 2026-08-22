import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface WorkspaceRecord {
  name: string;
  path: string;
}

interface EditorConfig {
  extends?: string;
  compilerOptions?: {
    noEmit?: boolean;
  };
  include?: string[];
}

function discoveredWorkspaces(): WorkspaceRecord[] {
  const result = spawnSync(process.execPath, ["scripts/workspace-packages.mjs", "list", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `workspace discovery exited ${result.status}`);
  return JSON.parse(result.stdout) as WorkspaceRecord[];
}

describe("runtime editor TypeScript projects", () => {
  it("gives every discovered workspace a no-emit editor tsconfig", async () => {
    const root = process.cwd();
    const workspaces = discoveredWorkspaces();

    expect(workspaces.length).toBeGreaterThan(0);

    for (const workspace of workspaces) {
      const configPath = resolve(root, workspace.path, "tsconfig.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as EditorConfig;

      expect(config.extends, workspace.path).toBe("./tsconfig.base.json");
      expect(config.compilerOptions?.noEmit, workspace.path).toBe(true);
      expect(config.include, workspace.path).toEqual([
        "src/**/*.ts",
        "test/**/*.ts",
        "vitest.config.ts",
      ]);
    }
  });
});
