import { completeSimple } from "./model-access.js";
import { asUserMessage, convertToLlm } from "./message-conversion.js";
import type {
  AssistantMessage,
  CompactionEntry,
  CompactionMessage,
  ModelLike,
  SessionEntry,
  ThinkingLevel,
  Usage,
} from "./types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  serializeConversation,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./utils.js";

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

function getMessageFromEntry(entry: SessionEntry): CompactionMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      customInstructions: entry.customInstructions,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): CompactionMessage | undefined {
  return entry.type === "compaction" ? undefined : getMessageFromEntry(entry);
}

export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
}

export const COMPACT_SKILL_NAME = "compact";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(message: CompactionMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  const assistant = message as AssistantMessage;
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return undefined;
  return assistant.usage;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    const usage = getAssistantUsage(entry.message);
    if (usage) return usage;
  }
  return undefined;
}

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: CompactionMessage[]): { usage: Usage; index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getAssistantUsage(messages[index]);
    if (usage) return { usage, index };
  }
  return undefined;
}

export function estimateContextTokens(messages: CompactionMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    const estimated = messages.reduce((total, message) => total + estimateTokens(message), 0);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let index = usageInfo.index + 1; index < messages.length; index++) {
    trailingTokens += estimateTokens(messages[index]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled || contextWindow <= 0) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

export function estimateTokens(message: CompactionMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user": {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") chars = content.length;
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
            const text = (block as { text?: unknown }).text;
            if (typeof text === "string") chars += text.length;
          }
        }
      }
      break;
    }
    case "assistant": {
      const content = (message as AssistantMessage).content;
      for (const block of content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      break;
    }
    case "custom":
    case "toolResult": {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") chars = content.length;
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const type = (block as { type?: unknown }).type;
          if (type === "text") {
            const text = (block as { text?: unknown }).text;
            if (typeof text === "string") chars += text.length;
          } else if (type === "image") {
            chars += 4800;
          }
        }
      }
      break;
    }
    case "bashExecution": {
      const bash = message as { command?: unknown; output?: unknown };
      chars = (typeof bash.command === "string" ? bash.command.length : 0) +
        (typeof bash.output === "string" ? bash.output.length : 0);
      break;
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = (message as { summary?: unknown }).summary;
      chars = typeof summary === "string" ? summary.length : 0;
      break;
    }
    default:
      return 0;
  }
  return Math.ceil(chars / 4);
}

function validCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
  const points: number[] = [];
  for (let index = startIndex; index < endIndex; index++) {
    const entry = entries[index];
    if (entry.type === "message") {
      const role = entry.message.role;
      if (["bashExecution", "custom", "branchSummary", "compactionSummary", "user", "assistant"].includes(role)) {
        points.push(index);
      }
    } else if (entry.type === "branch_summary" || entry.type === "custom_message") {
      points.push(index);
    }
  }
  return points;
}

export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
  for (let index = entryIndex; index >= startIndex; index--) {
    const entry = entries[index];
    if (entry.type === "branch_summary" || entry.type === "custom_message") return index;
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "bashExecution")) {
      return index;
    }
  }
  return -1;
}

export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const points = validCutPoints(entries, startIndex, endIndex);
  if (points.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = points[0];
  for (let index = endIndex - 1; index >= startIndex; index--) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    accumulatedTokens += estimateTokens(entry.message);
    if (accumulatedTokens >= keepRecentTokens) {
      const point = points.find((candidate) => candidate >= index);
      if (point !== undefined) cutIndex = point;
      break;
    }
  }

  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1];
    if (previous.type === "compaction" || previous.type === "message") break;
    cutIndex--;
  }

  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

const SUMMARIZATION_PROMPT = `Summarize this conversation so work can continue later.\n\nUse this EXACT format:\n\n## Goal\n[What the user is trying to accomplish]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned by user]\n- [Or "(none)" if not applicable]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [Ordered list of what should happen next]\n\n## Critical Context\n- [Any data, examples, or references needed to continue]\n- [Or "(none)" if not applicable]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.`;

const KERNEL_PERSIST_SUMMARY_NOTE =
  "Note: the IPython kernel keeps running after this summary — every Python variable, import, and helper you defined stays available. The cells that defined them won't appear above, so record in the summary any names worth remembering so you reuse them instead of redefining them.";

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\nUpdate the existing structured summary with new information. RULES:\n- PRESERVE all existing information from the previous summary\n- ADD new progress, decisions, and context from the new messages\n- UPDATE the Progress section: move items from "In Progress" to "Done" when completed\n- UPDATE "Next Steps" based on what was accomplished\n- PRESERVE exact file paths, function names, and error messages\n- If something is no longer relevant, you may remove it\n\nUse this EXACT format:\n\n## Goal\n[Preserve existing goals, add new ones if the task expanded]\n\n## Constraints & Preferences\n- [Preserve existing, add new ones discovered]\n\n## Progress\n### Done\n- [x] [Include previously done items AND newly completed items]\n\n### In Progress\n- [ ] [Current work - update based on progress]\n\n### Blocked\n- [Current blockers - remove if resolved]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n## Next Steps\n1. [Update based on current state]\n\n## Critical Context\n- [Preserve important context, add new if needed]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.`;

export function buildSummarizationPrompt(customInstructions?: string, previousSummary?: string): string {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt += `\n\n<user-instructions>\nThe user provided these instructions for this summary. Follow them with high priority while keeping the section format above: emphasize what they ask to focus on, and preserve verbatim anything they ask to remember.\n${customInstructions}\n</user-instructions>`;
  }
  return `${basePrompt}\n\n${KERNEL_PERSIST_SUMMARY_NOTE}`;
}

export async function generateSummary(
  currentMessages: CompactionMessage[],
  model: ModelLike,
  reserveTokens: number,
  apiKey: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
): Promise<string> {
  const maxTokens = Math.floor(0.8 * reserveTokens);
  let promptText = `<conversation>\n${serializeConversation(convertToLlm(currentMessages))}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += buildSummarizationPrompt(customInstructions, previousSummary);

  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [asUserMessage(promptText)] },
    model.reasoning && thinkingLevel && thinkingLevel !== "off"
      ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
      : { maxTokens, signal, apiKey, headers },
  );

  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function extractFileOperations(
  messages: CompactionMessage[],
  entries: SessionEntry[],
  previousCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOps();
  if (previousCompactionIndex >= 0) {
    const previous = entries[previousCompactionIndex] as CompactionEntry;
    if (!previous.fromHook && previous.details) {
      const details = previous.details as Partial<CompactionDetails>;
      if (Array.isArray(details.readFiles)) for (const file of details.readFiles) fileOps.read.add(file);
      if (Array.isArray(details.modifiedFiles)) for (const file of details.modifiedFiles) fileOps.edited.add(file);
    }
  }
  for (const message of messages) extractFileOpsFromMessage(message, fileOps);
  return fileOps;
}

export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: CompactionMessage[];
  turnPrefixMessages: CompactionMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

export function prepareCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
  resolvedContextMessages: CompactionMessage[],
): CompactionPreparation | undefined {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") return undefined;

  let previousCompactionIndex = -1;
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    if (pathEntries[index].type === "compaction") {
      previousCompactionIndex = index;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (previousCompactionIndex >= 0) {
    const previous = pathEntries[previousCompactionIndex] as CompactionEntry;
    previousSummary = previous.summary;
    const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
    boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : previousCompactionIndex + 1;
  }

  const tokensBefore = estimateContextTokens(resolvedContextMessages).tokens;
  const cutPoint = findCutPoint(pathEntries, boundaryStart, pathEntries.length, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) return undefined;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: CompactionMessage[] = [];
  for (let index = boundaryStart; index < historyEnd; index++) {
    const message = getMessageFromEntryForCompaction(pathEntries[index]);
    if (message) messagesToSummarize.push(message);
  }

  const turnPrefixMessages: CompactionMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let index = cutPoint.turnStartIndex; index < cutPoint.firstKeptEntryIndex; index++) {
      const message = getMessageFromEntryForCompaction(pathEntries[index]);
      if (message) turnPrefixMessages.push(message);
    }
  }

  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0 && !previousSummary) return undefined;

  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, previousCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);
  }

  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  };
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.\n\nSummarize the prefix to provide context for the retained suffix:\n\n## Original Request\n[What did the user ask for in this turn?]\n\n## Early Progress\n- [Key decisions and work done in the prefix]\n\n## Context for Suffix\n- [Information needed to understand the retained recent work]\n\nBe concise. Focus on what's needed to understand the kept suffix.`;

async function generateTurnPrefixSummary(
  messages: CompactionMessage[],
  model: ModelLike,
  reserveTokens: number,
  apiKey: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
): Promise<string> {
  const maxTokens = Math.floor(0.5 * reserveTokens);
  const promptText = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [asUserMessage(promptText)] },
    model.reasoning && thinkingLevel && thinkingLevel !== "off"
      ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
      : { maxTokens, signal, apiKey, headers },
  );
  if (response.stopReason === "error") {
    throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function compact(
  preparation: CompactionPreparation,
  model: ModelLike,
  apiKey: string,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
): Promise<CompactionResult<CompactionDetails>> {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  } = preparation;

  let summary: string;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummary(
            messagesToSummarize,
            model,
            settings.reserveTokens,
            apiKey,
            headers,
            signal,
            customInstructions,
            previousSummary,
            thinkingLevel,
          )
        : Promise.resolve("No prior history."),
      generateTurnPrefixSummary(
        turnPrefixMessages,
        model,
        settings.reserveTokens,
        apiKey,
        headers,
        signal,
        thinkingLevel,
      ),
    ]);
    summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
  } else {
    summary = await generateSummary(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      thinkingLevel,
    );
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  if (!firstKeptEntryId) throw new Error("First kept entry has no UUID - session may need migration");
  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}
