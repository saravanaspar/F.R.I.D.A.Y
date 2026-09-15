export interface PromptPythonSkillMetadata {
  importName: string;
}

export type PromptSkillSource = "user" | "project" | "path" | "other";

export interface PromptSkill {
  name: string;
  description: string;
  filePath: string;
  kind: "markdown" | "python";
  disableModelInvocation: boolean;
  source: PromptSkillSource;
  python?: PromptPythonSkillMetadata;
}

export type PromptSectionAuthority =
  | "core-policy"
  | "host-policy"
  | "user-config"
  | "project-guidance"
  | "runtime-context"
  | "untrusted-data";

export type PromptCacheScope = "stable" | "volatile";

export interface PromptSection {
  /** Stable identifier used for duplicate detection and provenance. */
  id: string;
  /** Model-visible content. */
  content: string;
  /** Trust/precedence class; formatting never upgrades this authority. */
  authority: PromptSectionAuthority;
  /** Whether the section may participate in the provider-stable prompt prefix. */
  cache: PromptCacheScope;
}

export interface PromptContextFile {
  path: string;
  content: string;
  /** Explicit project instruction files are bounded project guidance; ordinary files are data. */
  authority?: Extract<PromptSectionAuthority, "project-guidance" | "untrusted-data">;
  cache?: PromptCacheScope;
}

export interface PromptRuntimeFacts {
  /** Current instant in canonical ISO-8601 UTC representation. */
  now: string;
  /** User-configured IANA timezone. */
  timezone: string;
  /** Current local wall-clock time in the configured timezone. */
  localDateTime: string;
}

export interface SystemPromptPlan {
  /** Complete prompt sent to the model. */
  prompt: string;
  /** Stable leading bytes that provider adapters may cache independently. */
  stablePrefix?: string;
}

export interface BuildSystemPromptOptions {
  /** User-configured base guidance layered below FRIDAY core/host policy. */
  customPrompt?: string;
  /** Active tool names. */
  selectedTools?: string[];
  /** Additional host-policy guideline bullets. */
  promptGuidelines?: string[];
  /** User-configured text appended after built-in stable sections. */
  appendSystemPrompt?: string;
  /** Working directory shown to the model. */
  cwd: string;
  /** Conversation log path, or omitted for non-persistent sessions. */
  messagesPath?: string;
  /** Project context already discovered and classified by the host. */
  contextFiles?: readonly PromptContextFile[];
  /** Skills already discovered and security-validated by the skills subsystem. */
  skills?: PromptSkill[];
  /** Whether recursive delegation guidance should be shown. */
  allowRecursion?: boolean | undefined;
  /** Current recursive-agent depth. */
  rlmDepth?: number;
  /** Human-readable parent name/id for child doctrine. */
  rlmParentAgent?: string;
  /** Packages the execution environment promises are already importable. */
  kernelPackages?: string[] | undefined;
  /** Typed host/plugin prompt contributions. */
  supplementalSections?: PromptSection[];
  /** Host-resolved volatile wall-clock facts. */
  runtimeFacts?: PromptRuntimeFacts;
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
