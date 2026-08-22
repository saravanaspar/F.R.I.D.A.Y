import type { Static, TSchema } from "typebox";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  terminate?: boolean;
}

export type ToolUpdateCallback<TDetails = unknown> = (partialResult: ToolResult<TDetails>) => void;

export type ToolExecutionMode = "sequential" | "parallel";

export interface Tool<TParameters extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback<TDetails>,
  ) => Promise<ToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;
}
