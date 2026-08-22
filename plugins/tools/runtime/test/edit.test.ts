import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool, prepareEditArguments } from "../src/edit.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "friday-edit-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool", () => {
  it("replaces multiple disjoint regions against the original file", async () => {
    const dir = await tempDir();
    const path = join(dir, "sample.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
    const tool = createEditTool(dir);
    const result = await tool.execute("edit-1", {
      path: "sample.txt",
      edits: [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "gamma\n", newText: "GAMMA\n" },
      ],
    });
    expect(await readFile(path, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
    expect(result.details?.diff).toContain("ALPHA");
    expect(result.details?.diff).toContain("GAMMA");
  });

  it("adapts legacy oldText/newText input without exposing it in the schema", () => {
    expect(
      prepareEditArguments({ path: "a.txt", oldText: "before", newText: "after" }),
    ).toEqual({ path: "a.txt", edits: [{ oldText: "before", newText: "after" }] });
    const tool = createEditTool(process.cwd());
    expect((tool.parameters as any).properties).not.toHaveProperty("oldText");
    expect((tool.parameters as any).properties).not.toHaveProperty("newText");
  });

  it("does not partially apply a batch when one replacement is invalid", async () => {
    const dir = await tempDir();
    const path = join(dir, "atomic.txt");
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(path, original, "utf8");
    const tool = createEditTool(dir);
    await expect(
      tool.execute("edit-2", {
        path: "atomic.txt",
        edits: [
          { oldText: "alpha\n", newText: "ALPHA\n" },
          { oldText: "missing\n", newText: "MISSING\n" },
        ],
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
