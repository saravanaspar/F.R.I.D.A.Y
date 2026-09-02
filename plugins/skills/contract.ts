import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type SkillsRuntime = typeof import("@friday/skills");

/** Skill loading, invocation parsing, and runtime metadata exposed to consumers. */
export interface SkillsService {
  readonly loadSkills: SkillsRuntime["loadSkills"];
  readonly loadSkillsFromDir: SkillsRuntime["loadSkillsFromDir"];
  readonly getPythonSkillRuntimeInfo: SkillsRuntime["getPythonSkillRuntimeInfo"];
  readonly expandSkillCommand: SkillsRuntime["expandSkillCommand"];
  readonly parseFrontmatter: SkillsRuntime["parseFrontmatter"];
  /** In-process revision increments after trusted installs so cached Agent runtimes can refresh. */
  revision(): number;
}

export const SKILLS_CAPABILITY: Capability<SkillsService> =
  defineCapability<SkillsService>("skills");
