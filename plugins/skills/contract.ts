import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SkillsModule = typeof import("@friday/skills");

export interface SkillsService {
  readonly api: SkillsModule;
  /** In-process revision increments after trusted installs so cached Agent runtimes can refresh. */
  revision(): number;
}

export const SKILLS_CAPABILITY: Capability<SkillsService> =
  defineCapability<SkillsService>("skills");
