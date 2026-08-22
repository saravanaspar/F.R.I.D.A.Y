import type {
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  ImageContent,
  TextContent,
} from "./message-types.js";

export function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string,
): BranchSummaryMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
    timestamp: new Date(timestamp).getTime(),
  };
}

export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string,
  customInstructions?: string,
  retainedMessageCount?: number,
): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    retainedMessageCount,
    customInstructions,
    timestamp: new Date(timestamp).getTime(),
  };
}

export function createCustomMessage(
  customType: string,
  content: string | (TextContent | ImageContent)[],
  display: boolean,
  details: unknown | undefined,
  timestamp: string,
): CustomMessage {
  return {
    role: "custom",
    customType,
    content,
    display,
    details,
    timestamp: new Date(timestamp).getTime(),
  };
}
