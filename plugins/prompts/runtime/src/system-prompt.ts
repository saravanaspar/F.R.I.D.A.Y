import { buildChildAgentDoctrine, buildRlmPromptPlan, buildSubagentGuidance } from "./rlm.js";
import { FRIDAY_OPERATING_DOCTRINE } from "./orchestrator.js";
import { formatSkillsForPrompt, visiblePythonSkillImports } from "./skill-formatting.js";
import type { BuildSystemPromptOptions, SystemPromptPlan } from "./types.js";

/**
 * Build the system prompt together with the stable leading prefix providers may
 * cache separately from per-session metadata.
 *
 * The plan never changes the persisted representation: callers still store and
 * replay one ordinary prompt string. The prefix is request metadata only.
 */
export function buildSystemPromptPlan(options: BuildSystemPromptOptions): SystemPromptPlan {
  const {
    customPrompt,
    selectedTools,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    messagesPath,
    contextFiles: providedContextFiles,
    skills: providedSkills,
    allowRecursion,
    supplementalSections,
  } = options;

  const promptCwd = cwd.replace(/\\/g, "/");
  const promptMessagesPath = (messagesPath ?? "not persisted").replace(/\\/g, "/");
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  const contextFiles = providedContextFiles ?? [];
  const skills = providedSkills ?? [];
  const tools = selectedTools ?? ["ipython"];
  const hasIpython = tools.includes("ipython");
  const visibleImports = visiblePythonSkillImports(skills);

  if (customPrompt) {
    // A configured prompt is customization, not a replacement for FRIDAY's
    // operating doctrine. Keeping the doctrine first prevents a persona/base
    // prompt from accidentally disabling memory, scheduling, security, or
    // capability-continuation rules.
    const customBase = `${FRIDAY_OPERATING_DOCTRINE}\n\n# User-configured Guidance\n\n${customPrompt}`;
    let prompt = customBase;
    prompt += formatContextFiles(contextFiles);

    const hasFileAccess = !selectedTools || hasIpython || tools.includes("bash");
    if (hasFileAccess && skills.length > 0) prompt += formatSkillsForPrompt(skills);

    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;

    const childDoctrine = buildChildAgentDoctrine({
      depth: options.rlmDepth,
      parentAgent: options.rlmParentAgent,
      installedSkills: visibleImports,
      activeTools: tools,
    });
    if (childDoctrine) prompt += `\n\n${childDoctrine}`;

    prompt += formatSupplementalSections(supplementalSections);
    if (appendSection) prompt += appendSection;
    return Object.freeze({ prompt, stablePrefix: customBase });
  }

  const rlm = buildRlmPromptPlan({
    cwd: promptCwd,
    messagesPath: promptMessagesPath,
    installedSkills: visibleImports,
    activeTools: tools.filter((name) => name === "ipython" || name === "bash" || name === "edit" || name === "process"),
    allowRecursion,
    depth: options.rlmDepth,
    parentAgent: options.rlmParentAgent,
    kernelPackages: options.kernelPackages,
  });

  // Everything added here is host/configuration-owned and changes much less
  // frequently than the per-session path/depth/parent metadata. Keeping it
  // before the volatile suffix maximizes provider prefix reuse across sessions.
  let stablePrefix = rlm.stablePrefix;

  if ((allowRecursion ?? true) && hasIpython) {
    const visibleSet = new Set(visibleImports);
    stablePrefix += `\n\n${buildSubagentGuidance({
      hasAgentMessage: visibleSet.has("agent_message"),
      hasAgentObserve: visibleSet.has("agent_observe"),
    })}`;
  }

  stablePrefix += formatSupplementalSections(supplementalSections);

  const guidelines = formatPromptGuidelines(promptGuidelines);
  if (guidelines) stablePrefix += `\n\n# Additional Guidance\n\n${guidelines}`;

  stablePrefix += formatContextFiles(contextFiles);

  const hasFileAccess = tools.includes("ipython") || tools.includes("bash");
  if (hasFileAccess && skills.length > 0) stablePrefix += formatSkillsForPrompt(skills);

  if (appendSection) stablePrefix += appendSection;

  const prompt = rlm.volatileSuffix ? `${stablePrefix}\n\n${rlm.volatileSuffix}` : stablePrefix;
  return Object.freeze({ prompt, stablePrefix });
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  return buildSystemPromptPlan(options).prompt;
}

function formatContextFiles(contextFiles: readonly { path: string; content: string }[]): string {
  if (contextFiles.length === 0) return "";
  const lines = ["", "", "# Project Context", "", "Project-specific instructions and guidelines:", ""];
  for (const { path, content } of contextFiles) {
    lines.push(`## ${path}`, "", content, "");
  }
  return lines.join("\n");
}

function formatSupplementalSections(sections: readonly string[] | undefined): string {
  const normalized = (sections ?? []).map((section) => section.trim()).filter(Boolean);
  return normalized.length > 0 ? `\n\n${normalized.join("\n\n")}` : "";
}

function formatPromptGuidelines(promptGuidelines: readonly string[] | undefined): string {
  const guidelines: string[] = [];
  const seen = new Set<string>();
  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      guidelines.push(normalized);
    }
  }
  return guidelines.map((guideline) => `- ${guideline}`).join("\n");
}
