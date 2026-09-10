import { describe, expect, it } from "vitest";
import {
  buildChildAgentDoctrine,
  buildRlmPrompt,
  buildSubagentGuidance,
  buildSystemPrompt,
  buildSystemPromptPlan,
  formatSkillsForPrompt,
  visiblePythonSkillImports,
  type PromptSkill,
} from "../src/index.js";

const pythonSkill: PromptSkill = {
  name: "review-code",
  description: "Review <code> & report risks",
  filePath: "/tmp/review-code/SKILL.md",
  kind: "python",
  disableModelInvocation: false,
  python: { importName: "review_code" },
};

const hiddenSkill: PromptSkill = {
  name: "hidden",
  description: "Hidden",
  filePath: "/tmp/hidden/SKILL.md",
  kind: "markdown",
  disableModelInvocation: true,
};

describe("skill prompt formatting", () => {
  it("uses the Agent Skills XML shape and excludes hidden skills", () => {
    const prompt = formatSkillsForPrompt([pythonSkill, hiddenSkill]);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>review-code</name>");
    expect(prompt).toContain("<python_import>review_code</python_import>");
    expect(prompt).not.toContain("<name>hidden</name>");
  });

  it("escapes XML-sensitive skill fields", () => {
    const prompt = formatSkillsForPrompt([pythonSkill]);
    expect(prompt).toContain("Review &lt;code&gt; &amp; report risks");
  });

  it("returns an empty section when all skills are hidden", () => {
    expect(formatSkillsForPrompt([hiddenSkill])).toBe("");
  });

  it("derives only visible Python import names", () => {
    expect(visiblePythonSkillImports([pythonSkill, hiddenSkill])).toEqual(["review_code"]);
  });
});

describe("RLM prompt composition", () => {
  it("includes the working directory, session log, and depth", () => {
    const prompt = buildRlmPrompt({ cwd: "/work", messagesPath: "/session.jsonl", depth: 2 });
    expect(prompt).toContain("Working directory: /work");
    expect(prompt).toContain("Conversation log: /session.jsonl");
    expect(prompt).toContain("Recursive agent depth: 2");
  });

  it("only advertises packages promised by the execution host", () => {
    const prompt = buildRlmPrompt({
      cwd: "/work",
      messagesPath: "not persisted",
      kernelPackages: ["numpy", "pandas"],
    });
    expect(prompt).toContain("Pre-installed Python packages: numpy, pandas.");
  });

  it("omits recursive spawn guidance when recursion is disabled", () => {
    const prompt = buildRlmPrompt({
      cwd: "/work",
      messagesPath: "not persisted",
      activeTools: ["ipython"],
      allowRecursion: false,
    });
    expect(prompt).not.toContain("await rlm('sub-task')");
  });

  it("includes recursive spawn guidance when recursion and IPython are available", () => {
    const prompt = buildRlmPrompt({
      cwd: "/work",
      messagesPath: "not persisted",
      activeTools: ["ipython"],
      allowRecursion: true,
    });
    expect(prompt).toContain("await rlm('sub-task')");
    expect(prompt).toContain("await rlm.list_subagents()");
    expect(prompt).toContain("await rlm.gather([...])");
    expect(prompt).toContain("not as permanent FRIDAY tools or capabilities");
    expect(prompt).toContain("set `fresh=true` on the next `ipython` call");
  });

  it("adds parent-reply doctrine only when the messaging skill is visible", () => {
    const doctrine = buildChildAgentDoctrine({
      depth: 1,
      parentAgent: "parent-1",
      installedSkills: ["agent_message"],
      activeTools: ["ipython"],
    });
    expect(doctrine).toContain("spawned by parent-1");
    expect(doctrine).toContain("receiver_role=\"parent\"");
  });

  it("returns no child doctrine at root depth", () => {
    expect(buildChildAgentDoctrine({ depth: 0 })).toBeUndefined();
  });

  it("adds optional messaging and observation guidance without implementing either", () => {
    const prompt = buildSubagentGuidance({ hasAgentMessage: true, hasAgentObserve: true });
    expect(prompt).toContain("agent_message.send");
    expect(prompt).toContain("agent_observe");
  });
});

describe("system prompt composition", () => {
  it("builds the default prompt from host-provided environment facts", () => {
    const prompt = buildSystemPrompt({
      cwd: "C:\\repo",
      messagesPath: "C:\\sessions\\one.jsonl",
      selectedTools: ["ipython", "bash"],
      skills: [pythonSkill],
      rlmDepth: 1,
      rlmParentAgent: "root",
      kernelPackages: ["numpy"],
    });
    expect(prompt).toContain("Working directory: C:/repo");
    expect(prompt).toContain("Conversation log: C:/sessions/one.jsonl");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("spawned by root");
  });

  it("keeps skill formatting outside the skills subsystem and suppresses it without file access", () => {
    const prompt = buildSystemPrompt({
      cwd: "/work",
      selectedTools: ["edit"],
      skills: [pythonSkill],
      allowRecursion: false,
    });
    expect(prompt).not.toContain("<available_skills>");
  });

  it("appends project context in supplied order", () => {
    const prompt = buildSystemPrompt({
      cwd: "/work",
      allowRecursion: false,
      contextFiles: [
        { path: "/root/AGENTS.md", content: "root rules" },
        { path: "/work/AGENTS.md", content: "work rules" },
      ],
    });
    expect(prompt.indexOf("root rules")).toBeLessThan(prompt.indexOf("work rules"));
  });

  it("deduplicates additional guidance while preserving order", () => {
    const prompt = buildSystemPrompt({
      cwd: "/work",
      allowRecursion: false,
      promptGuidelines: ["first", " first ", "second"],
    });
    expect(prompt.match(/- first/g)).toHaveLength(1);
    expect(prompt.indexOf("- first")).toBeLessThan(prompt.indexOf("- second"));
  });

  it("renders supplemental host-owned sections before additional guidance", () => {
    const prompt = buildSystemPrompt({
      cwd: "/work",
      allowRecursion: false,
      supplementalSections: ["# Persistent State\nremember this"],
      promptGuidelines: ["be precise"],
    });
    expect(prompt.indexOf("# Persistent State")).toBeLessThan(prompt.indexOf("# Additional Guidance"));
  });

  it("uses a custom base prompt while retaining context, skills, child doctrine, and final append text", () => {
    const prompt = buildSystemPrompt({
      customPrompt: "CUSTOM",
      cwd: "/work",
      selectedTools: ["ipython"],
      skills: [pythonSkill],
      contextFiles: [{ path: "/work/AGENTS.md", content: "rules" }],
      rlmDepth: 1,
      rlmParentAgent: "root",
      appendSystemPrompt: "TAIL",
    });
    expect(prompt).toContain("# FRIDAY Operating Doctrine");
    expect(prompt).toContain("# User-configured Guidance\n\nCUSTOM");
    expect(prompt.indexOf("# FRIDAY Operating Doctrine")).toBeLessThan(prompt.indexOf("CUSTOM"));
    expect(prompt).toContain("rules");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("spawned by root");
    expect(prompt.endsWith("TAIL")).toBe(true);
  });

  it("keeps session-specific metadata outside a reusable stable prefix", () => {
    const first = buildSystemPromptPlan({
      cwd: "/work",
      messagesPath: "/sessions/one.jsonl",
      selectedTools: ["ipython", "bash"],
      skills: [pythonSkill],
      rlmDepth: 0,
      contextFiles: [{ path: "/work/AGENTS.md", content: "stable project rules" }],
    });
    const second = buildSystemPromptPlan({
      cwd: "/work",
      messagesPath: "/sessions/two.jsonl",
      selectedTools: ["ipython", "bash"],
      skills: [pythonSkill],
      rlmDepth: 1,
      rlmParentAgent: "root",
      contextFiles: [{ path: "/work/AGENTS.md", content: "stable project rules" }],
    });

    expect(first.stablePrefix).toBe(second.stablePrefix);
    expect(first.stablePrefix).toContain("stable project rules");
    expect(first.stablePrefix).toContain("<available_skills>");
    expect(first.stablePrefix).not.toContain("Conversation log:");
    expect(first.stablePrefix).not.toContain("Recursive agent depth:");
    expect(first.prompt.startsWith(first.stablePrefix!)).toBe(true);
    expect(first.prompt).toContain("Conversation log: /sessions/one.jsonl");
    expect(second.prompt).toContain("Conversation log: /sessions/two.jsonl");
    expect(second.prompt).toContain("spawned by root");
  });

  it("does not advertise hidden skills through the default prompt", () => {
    const prompt = buildSystemPrompt({ cwd: "/work", skills: [hiddenSkill] });
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).not.toContain("hidden");
  });
});
