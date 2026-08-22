export type ServiceTier = "default" | "priority" | (string & {});

export interface TextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface ImageContent {
  type: "image";
  [key: string]: unknown;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
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
  content: unknown;
  provider: string;
  model: string;
  usage?: Usage;
  timestamp: number;
  [key: string]: unknown;
}

export interface GenericMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export type Message = UserMessage | AssistantMessage | GenericMessage;

export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
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

export type SessionMessage =
  | Message
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
