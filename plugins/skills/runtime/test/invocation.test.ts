import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandSkillCommand } from "../src/invocation.js";
import { loadSkillsFromDir } from "../src/skills.js";

describe("skill command expansion", () => {
  it("expands a known skill command and preserves user arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-skill-command-"));
    try {
      const skillDir = join(root, "review-code");
      mkdirSkill(skillDir, "review-code", "Review code carefully.");
      const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

      const expanded = expandSkillCommand("/skill:review-code focus on tests", { skills });

      expect(expanded).toContain('<skill name="review-code"');
      expect(expanded).toContain("References are relative to");
      expect(expanded).toContain("Review code carefully.");
      expect(expanded.endsWith("focus on tests")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes unknown skill commands through unchanged", () => {
    expect(expandSkillCommand("/skill:missing hello", { skills: [] })).toBe("/skill:missing hello");
  });

  it("reports file read errors and preserves the original command", () => {
    const errors: string[] = [];
    const text = "/skill:gone argument";
    const expanded = expandSkillCommand(text, {
      skills: [
        {
          name: "gone",
          description: "Missing skill",
          filePath: "/definitely/missing/SKILL.md",
          baseDir: "/definitely/missing",
          sourceInfo: {
            path: "/definitely/missing/SKILL.md",
            source: "test",
            scope: "temporary",
            origin: "top-level",
          },
          disableModelInvocation: false,
          kind: "markdown",
        },
      ],
      onError: (error) => errors.push(error.error),
    });

    expect(expanded).toBe(text);
    expect(errors).toHaveLength(1);
  });
});

function mkdirSkill(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n\n${body}\n`,
    "utf8",
  );
}
