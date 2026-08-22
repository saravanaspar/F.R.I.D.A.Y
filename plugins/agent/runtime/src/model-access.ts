import type {
  AssistantMessageDiagnostic,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
} from "./model-types.js";

export interface ModelAccess {
  streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  validateToolArguments(tool: Tool, toolCall: ToolCall): unknown;
  createAssistantMessageDiagnostic(
    type: string,
    error: unknown,
    details?: Record<string, unknown>,
  ): AssistantMessageDiagnostic;
}

let activeModelAccess: ModelAccess | undefined;

export function installModelAccess(access: ModelAccess): void {
  activeModelAccess = access;
}

export function uninstallModelAccess(): void {
  activeModelAccess = undefined;
}

function requireModelAccess(): ModelAccess {
  if (!activeModelAccess) throw new Error("Agent runtime model access is not configured");
  return activeModelAccess;
}

export function streamSimple(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return requireModelAccess().streamSimple(model, context, options);
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  return requireModelAccess().validateToolArguments(tool, toolCall);
}

export function createAssistantMessageDiagnostic(
  type: string,
  error: unknown,
  details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
  return requireModelAccess().createAssistantMessageDiagnostic(type, error, details);
}
