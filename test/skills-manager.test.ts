import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as skills from "@friday/skills";
import { afterEach, describe, expect, it } from "vitest";
import { manageSkill, userSkillsDir } from "../plugins/skills/manager.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;
const originalState = process.env.FRIDAY_STATE_DIR;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  if (originalState === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalState;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "friday-managed-skill-"));
  roots.push(root);
  process.env.FRIDAY_HOME = root;
  delete process.env.FRIDAY_STATE_DIR;
  return root;
}

async function createSkill(name = "source-review") {
  await manageSkill(skills, {
    action: "create",
    name,
    description: "Review structured source material.",
    body: "# Workflow\n\n1. Inspect the source structure.\n2. Extract only relevant evidence.\n",
  });
}

describe("managed Skill authoring", () => {
  it("accepts a complete Hermes-style SKILL.md on create and validates it before publication", async () => {
    await home();
    await manageSkill(skills, {
      action: "create",
      name: "hermes-ingested",
      content: [
        "---",
        "name: hermes-ingested",
        "description: Ingest reusable source procedures.",
        "version: 0.1.0",
        "author: FRIDAY",
        "---",
        "",
        "# When to Use",
        "",
        "Use when a user asks to turn source material into reusable procedural memory.",
        "",
      ].join("\n"),
    });
    await expect(readFile(join(userSkillsDir(), "hermes-ingested", "SKILL.md"), "utf8"))
      .resolves.toContain("# When to Use");
  });

  it("creates, patches, and removes only validated Skill files", async () => {
    await home();
    await createSkill();
    await manageSkill(skills, {
      action: "write_file",
      name: "source-review",
      path: "references/json.md",
      content: "# JSON\n\nInspect schema and sample rows before aggregation.\n",
    });
    await manageSkill(skills, {
      action: "patch",
      name: "source-review",
      path: "references/json.md",
      oldText: "sample rows",
      newText: "a bounded sample",
    });
    const reference = join(userSkillsDir(), "source-review", "references", "json.md");
    await expect(readFile(reference, "utf8")).resolves.toContain("a bounded sample");
    await expect(manageSkill(skills, {
      action: "remove_file",
      name: "source-review",
      path: "references/json.md",
    })).resolves.toMatchObject({ deleted: true });
    await expect(readFile(reference, "utf8")).rejects.toThrow();
  });

  it("rejects supporting files outside the Hermes-style Skill layout", async () => {
    await home();
    await createSkill();
    await expect(manageSkill(skills, {
      action: "write_file",
      name: "source-review",
      path: "misc/notes.md",
      content: "not allowed",
    })).rejects.toThrow(/references\/|supporting Skill files/);
    await expect(manageSkill(skills, {
      action: "remove_file",
      name: "source-review",
      path: "SKILL.md",
    })).rejects.toThrow(/cannot be removed/);
  });

  it("rejects ambiguous patches and rolls the whole Skill back after invalid edits", async () => {
    await home();
    await createSkill();
    const skillPath = join(userSkillsDir(), "source-review", "SKILL.md");
    const original = await readFile(skillPath, "utf8");
    await manageSkill(skills, {
      action: "edit",
      name: "source-review",
      path: "references/repeated.md",
      content: "alpha\nneedle\nbeta\nneedle\ngamma\n",
    });
    await expect(manageSkill(skills, {
      action: "patch",
      name: "source-review",
      path: "references/repeated.md",
      oldText: "needle",
      newText: "changed",
    })).rejects.toThrow(/multiple exact locations/);

    await expect(manageSkill(skills, {
      action: "edit",
      name: "source-review",
      path: "SKILL.md",
      content: original.replace("author: FRIDAY", "author: somebody-else"),
    })).rejects.toThrow(/author: FRIDAY/);
    await expect(readFile(skillPath, "utf8")).resolves.toBe(original);
  });

  it("fails closed on symlink ancestors and strips invisible source controls", async () => {
    const root = await home();
    await createSkill();
    const outside = join(root, "outside");
    await writeFile(outside, "outside", "utf8");
    await symlink(root, join(userSkillsDir(), "source-review", "references"));
    await expect(manageSkill(skills, {
      action: "write_file",
      name: "source-review",
      path: "references/escape.md",
      content: "escape",
    })).rejects.toThrow(/symlink/);

    await rm(join(userSkillsDir(), "source-review", "references"), { force: true });
    await manageSkill(skills, {
      action: "write_file",
      name: "source-review",
      path: "references/clean.md",
      content: "safe\u200b text\u202e here\u{e0001}\n",
    });
    await expect(readFile(join(userSkillsDir(), "source-review", "references", "clean.md"), "utf8"))
      .resolves.toBe("safe text here\n");
  });
});
