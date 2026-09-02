import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability } from "../plugins/capabilities/protocol.js";
import { ARTIFACTS_CAPABILITY } from "../plugins/artifacts/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import skillsPlugin from "../plugins/skills/index.js";
import { SKILLS_CAPABILITY } from "../plugins/skills/contract.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills plugin", () => {
  it("discovers and explicitly expands skills without owning prompt composition", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(definePlugin({
      id: "test-skills-dependencies",
      provides: [ARTIFACTS_CAPABILITY, PERMISSIONS_CAPABILITY],
    }, (ctx) => {
      ctx.services.provide(ARTIFACTS_CAPABILITY, {} as never);
      ctx.services.provide(PERMISSIONS_CAPABILITY, {} as never);
    }));
    await friday.activatePlugin(skillsPlugin);

    const service = requireCapability(SKILLS_CAPABILITY);
    const root = await mkdtemp(join(tmpdir(), "friday-skills-integration-"));
    tempDirs.push(root);
    const skillDir = join(root, "review-code");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: review-code\ndescription: Review code changes carefully.\n---\n\nInspect the diff and tests.\n",
      "utf8",
    );

    const { skills, diagnostics } = service.loadSkillsFromDir({ dir: root, source: "test" });
    expect(diagnostics).toEqual([]);
    expect(skills.map((skill) => skill.name)).toEqual(["review-code"]);

    const expanded = service.expandSkillCommand("/skill:review-code focus on regressions", { skills });
    expect(expanded).toContain("Inspect the diff and tests.");
    expect(expanded).toContain("focus on regressions");
    expect("formatSkillsForPrompt" in service).toBe(false);
  });
});
