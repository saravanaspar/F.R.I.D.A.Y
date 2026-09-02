import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as skills from "@friday/skills";
import type { ArtifactService } from "../plugins/artifacts/contract.js";
import type { PermissionsService } from "../plugins/permissions/contract.js";
import type { SkillsService } from "../plugins/skills/contract.js";
import { installSkills } from "../plugins/skills/installer.js";
import type { SystemActionExecutionContext } from "../plugins/system/contract.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.FRIDAY_HOME; else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "friday-skill-install-home-")); roots.push(home); await chmod(home, 0o700); process.env.FRIDAY_HOME = home;
  const source = await mkdtemp(join(tmpdir(), "friday-skill-install-source-")); roots.push(source);
  const skill = join(source, "demo-skill"); await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: demo-skill\ndescription: Demo install skill\n---\n\nUse it safely.\n");
  const order: string[] = [];
  const artifacts = {
    async stagePackageSource() { order.push("inspect"); return { sourceDir: source, source: "https://example.com/demo.zip", files: 1, bytes: 100, async dispose() { order.push("dispose"); } }; },
  } as unknown as ArtifactService;
  const permissions = {
    normalizeMode: () => "ask",
    async authorize(request: { action: { id: string } }) { order.push(`authorize:${request.action.id}`); return { allowed: true, approvedBy: "user" }; },
    assertWorkspacePath: (_workspace: string, path: string) => path,
  } as unknown as PermissionsService;
  const context = {
    turn: {
      id: "turn", principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "user" }, text: "install this skill", timestamp: Date.now(),
      async reply(text: string) { expect(text).toContain("Skill installation plan"); order.push("plan"); },
    }, deferAfterReply() {},
  } as SystemActionExecutionContext;
  const service: SkillsService = {
    loadSkills: skills.loadSkills,
    loadSkillsFromDir: skills.loadSkillsFromDir,
    getPythonSkillRuntimeInfo: skills.getPythonSkillRuntimeInfo,
    expandSkillCommand: skills.expandSkillCommand,
    parseFrontmatter: skills.parseFrontmatter,
    revision: () => 0,
  };
  return { home, order, artifacts, permissions, context, service };
}

describe("skill package installation", () => {
  it("authorizes network inspection first, shows the concrete plan, then authorizes mutation and installs privately", async () => {
    const f = await fixture();
    const result = await installSkills({ url: "https://example.com/demo.zip" }, { skills: f.service, artifacts: f.artifacts, permissions: f.permissions, context: f.context });
    expect(result.installed).toEqual(["demo-skill"]);
    expect(f.order).toEqual(["authorize:skills.inspect-package", "inspect", "plan", "authorize:skills.install", "dispose"]);
    const installed = join(f.home, "skills", "demo-skill", "SKILL.md");
    await expect((await import("node:fs/promises")).readFile(installed, "utf8")).resolves.toContain("Demo install skill");
  });

  it("fails closed instead of installing through a broadened user skill root", async () => {
    const f = await fixture();
    await mkdir(join(f.home, "skills"), { mode: 0o755 });
    await chmod(join(f.home, "skills"), 0o755);
    await expect(installSkills({ url: "https://example.com/demo.zip" }, { skills: f.service, artifacts: f.artifacts, permissions: f.permissions, context: f.context }))
      .rejects.toThrow("user skill root permissions are too broad");
  });
});
