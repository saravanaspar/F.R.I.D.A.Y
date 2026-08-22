import type { CompactionMessage, LlmMessage } from "./types.js";

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

export function extractFileOpsFromMessage(message: CompactionMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if ((block as { type?: unknown }).type !== "toolCall") continue;
    const name = (block as { name?: unknown }).name;
    const args = (block as { arguments?: unknown }).arguments;
    if (typeof name !== "string" || typeof args !== "object" || args === null) continue;
    const path = (args as Record<string, unknown>).path;
    if (typeof path !== "string") continue;
    if (name === "edit") fileOps.edited.add(path);
  }
}

export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

export function serializeConversation(messages: LlmMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block): block is { type: "text"; text: string } => block.type === "text")
              .map((block) => block.text)
              .join("");
      if (content) parts.push(`[User]: ${content}`);
      continue;
    }

    if (message.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "thinking") thinkingParts.push(block.thinking);
        else if (block.type === "toolCall") {
          const args = Object.entries(block.arguments)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${args})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      continue;
    }

    const content = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
  }
  return parts.join("\n\n");
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
