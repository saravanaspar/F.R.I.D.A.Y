export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface ImageContent {
  type: "image";
  [key: string]: unknown;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
}

export interface ToolCallContent {
  type: "toolCall";
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
  [key: string]: unknown;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface ToolResultMessage {
  role: "toolResult";
  content: (TextContent | ImageContent)[];
  timestamp: number;
  [key: string]: unknown;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  retainedMessageCount?: number;
  customInstructions?: string;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
  [key: string]: unknown;
}

export interface GenericMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export type CompactionMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage
  | BashExecutionMessage
  | GenericMessage;

export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ModelLike {
  contextWindow: number;
  reasoning?: boolean;
}

export interface CompletionContext {
  systemPrompt: string;
  messages: UserMessage[];
}

export interface CompletionOptions {
  maxTokens: number;
  signal?: AbortSignal;
  apiKey: string;
  headers?: Record<string, string>;
  reasoning?: ThinkingLevel;
}

export interface CompletionResponse {
  content: Array<TextContent | ThinkingContent | ToolCallContent | ImageContent>;
  stopReason: string;
  errorMessage?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: CompactionMessage;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
  customInstructions?: string;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
  type: "service_tier_change";
  serviceTier: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export interface SessionStateEntry extends SessionEntryBase {
  type: "session_state";
  state: unknown;
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomMessageEntry
  | ThinkingLevelChangeEntry
  | ServiceTierChangeEntry
  | ModelChangeEntry
  | CustomEntry
  | LabelEntry
  | SessionInfoEntry
  | SessionStateEntry;

export interface SessionContextLike {
  messages: CompactionMessage[];
}

export interface CompactionSessionPort {
  getBranch(fromId?: string): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  buildSessionContext(): SessionContextLike;
  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    customInstructions?: string,
  ): string;
  branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string;
}
