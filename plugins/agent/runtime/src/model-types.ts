import type { TSchema } from "typebox";

export type Api = string;
export type Provider = string;
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type CacheRetention = "none" | "short" | "long";
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  serviceTier?: ServiceTier;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ModelThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  tokenSource?: "provider-reported" | "unavailable" | "simulated" | undefined;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    estimated?: number | undefined;
    source?: "catalog-estimate" | "provider-reported" | "provider-billing" | "unavailable" | undefined;
    actual?: number | undefined;
    currency?: string | undefined;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  stopReasonRaw?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

export interface Context {
  systemPrompt?: string;
  /** Stable leading bytes of systemPrompt that explicit-cache providers may mark separately. */
  stableSystemPromptPrefix?: string;
  messages: Message[];
  tools?: Tool[];
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  featured?: boolean;
  headers?: Record<string, string>;
  compat?: unknown;
}
