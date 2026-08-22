import type { PromptSkill } from "./types.js";

/**
 * Format discovered skills for the model using the Agent Skills XML shape.
 * Discovery and validation remain owned by the skills subsystem.
 */
export function formatSkillsForPrompt(skills: readonly PromptSkill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use ipython to inspect a skill's file when the task matches its description.",
    "Skills with a python_import are prepared in the persistent IPython kernel when available and can be called directly by that import name.",
    "When a skill file references a relative path, resolve it against the skill directory and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <type>${skill.kind}</type>`);
    if (skill.kind === "python" && skill.python?.importName) {
      lines.push(`    <python_import>${escapeXml(skill.python.importName)}</python_import>`);
    }
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function visiblePythonSkillImports(skills: readonly PromptSkill[]): string[] {
  return skills
    .filter((skill) => !skill.disableModelInvocation && skill.kind === "python" && Boolean(skill.python?.importName))
    .map((skill) => skill.python!.importName);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
