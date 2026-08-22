import { readFileSync } from "node:fs";
import { stripFrontmatter } from "./frontmatter.js";
import type { Skill } from "./skills.js";

export interface SkillExpansionError {
  skillName: string;
  path: string;
  error: string;
}

export interface ExpandSkillCommandOptions {
  skills: readonly Skill[];
  onError?: (error: SkillExpansionError) => void;
}

interface ParsedSlashCommand {
  name: string;
  args: string;
}

function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  if (!text.startsWith("/")) return undefined;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/**
 * Expand /skill:<name> arguments into the skill body plus optional user arguments.
 * Unknown skills and read failures preserve the original input.
 */
export function expandSkillCommand(text: string, options: ExpandSkillCommandOptions): string {
  if (!text.startsWith("/skill:")) return text;

  const parsed = parseSlashCommand(text);
  if (!parsed?.name.startsWith("skill:")) return text;
  const skillName = parsed.name.slice("skill:".length);
  const args = parsed.args;

  const skill = options.skills.find((candidate) => candidate.name === skillName);
  if (!skill) return text;

  try {
    const content = readFileSync(skill.filePath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  } catch (error) {
    options.onError?.({
      skillName: skill.name,
      path: skill.filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return text;
  }
}
