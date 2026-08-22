export interface PromptPythonSkillMetadata {
  importName: string;
}

export interface PromptSkill {
  name: string;
  description: string;
  filePath: string;
  kind: "markdown" | "python";
  disableModelInvocation: boolean;
  python?: PromptPythonSkillMetadata;
}

export interface PromptContextFile {
  path: string;
  content: string;
}

export interface SystemPromptPlan {
  /** Complete prompt sent to the model. */
  prompt: string;
  /** Stable leading bytes that provider adapters may cache independently. */
  stablePrefix?: string;
}

export interface BuildSystemPromptOptions {
  /** Custom system prompt. When provided it replaces the default base prompt. */
  customPrompt?: string;
  /** Active tool names. */
  selectedTools?: string[];
  /** Additional guideline bullets. */
  promptGuidelines?: string[];
  /** Text appended after all built-in sections. */
  appendSystemPrompt?: string;
  /** Working directory shown to the model. */
  cwd: string;
  /** Conversation log path, or omitted for non-persistent sessions. */
  messagesPath?: string;
  /** Project context already discovered by the host. */
  contextFiles?: PromptContextFile[];
  /** Skills already discovered by the skills subsystem. */
  skills?: PromptSkill[];
  /** Whether recursive delegation guidance should be shown. */
  allowRecursion?: boolean | undefined;
  /** Current recursive-agent depth. */
  rlmDepth?: number;
  /** Human-readable parent name/id for child doctrine. */
  rlmParentAgent?: string;
  /** Packages the execution environment promises are already importable. */
  kernelPackages?: string[] | undefined;
  /** Host-owned supplemental prompt sections, rendered before extra guidelines. */
  supplementalSections?: string[];
}

export interface RlmPromptOptions {
  cwd: string;
  messagesPath: string;
  installedSkills?: string[] | undefined;
  allowRecursion?: boolean | undefined;
  depth?: number | undefined;
  parentAgent?: string | undefined;
  activeTools?: string[] | undefined;
  kernelPackages?: string[] | undefined;
}

export interface ChildAgentDoctrineOptions {
  depth?: number | undefined;
  parentAgent?: string | undefined;
  installedSkills?: string[] | undefined;
  activeTools?: string[] | undefined;
}
