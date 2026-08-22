import type {
  BashExecutionMessage,
  CompactionMessage,
  LlmMessage,
  TextContent,
  UserMessage,
} from "./types.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
export const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n`;
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

const NON_CONTEXT_CUSTOM_TYPES = new Set([
  "session_slash_command",
  "session_slash_command_result",
  "compaction_outcome",
]);

export function bashOutputToText(
  msg: Pick<BashExecutionMessage, "output" | "exitCode" | "cancelled" | "truncated" | "fullOutputPath">,
): string {
  let text = "";
  if (msg.output) {
    let longestBacktickRun = 0;
    for (const match of msg.output.matchAll(/`+/g)) {
      longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
    }
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    text += `${fence}\n${msg.output}\n${fence}`;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated) {
    text += msg.fullOutputPath
      ? `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`
      : "\n\n[Output truncated.]";
  }
  return text;
}

export function bashExecutionToText(msg: BashExecutionMessage): string {
  return `Ran \`${msg.command}\`\n${bashOutputToText(msg)}`;
}

function contextBlocks(content: string | unknown): Array<TextContent | { type: "image"; [key: string]: unknown }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is TextContent | { type: "image"; [key: string]: unknown } =>
      typeof block === "object" &&
      block !== null &&
      ((block as { type?: unknown }).type === "text" || (block as { type?: unknown }).type === "image"),
  );
}

export function convertToLlm(messages: CompactionMessage[]): LlmMessage[] {
  const converted: LlmMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "bashExecution": {
        const bash = message as BashExecutionMessage;
        if (bash.excludeFromContext) break;
        converted.push({
          role: "user",
          content: [{ type: "text", text: bashExecutionToText(bash) }],
          timestamp: bash.timestamp,
        });
        break;
      }
      case "custom": {
        const custom = message as {
          customType?: unknown;
          content?: unknown;
          timestamp?: unknown;
        };
        if (typeof custom.customType !== "string" || NON_CONTEXT_CUSTOM_TYPES.has(custom.customType)) break;
        converted.push({
          role: "user",
          content: contextBlocks(custom.content),
          timestamp: typeof custom.timestamp === "number" ? custom.timestamp : Date.now(),
        });
        break;
      }
      case "branchSummary": {
        const branch = message as { summary?: unknown; timestamp?: unknown };
        if (typeof branch.summary !== "string") break;
        converted.push({
          role: "user",
          content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + branch.summary + BRANCH_SUMMARY_SUFFIX }],
          timestamp: typeof branch.timestamp === "number" ? branch.timestamp : Date.now(),
        });
        break;
      }
      case "compactionSummary": {
        const compacted = message as { summary?: unknown; timestamp?: unknown };
        if (typeof compacted.summary !== "string") break;
        converted.push({
          role: "user",
          content: [
            { type: "text", text: COMPACTION_SUMMARY_PREFIX + compacted.summary + COMPACTION_SUMMARY_SUFFIX },
          ],
          timestamp: typeof compacted.timestamp === "number" ? compacted.timestamp : Date.now(),
        });
        break;
      }
      case "user":
      case "assistant":
      case "toolResult":
        converted.push(message as LlmMessage);
        break;
      default:
        break;
    }
  }
  return converted;
}

export function asUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}
