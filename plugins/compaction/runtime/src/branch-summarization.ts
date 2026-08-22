import { completeSimple } from "./model-access.js";
import { asUserMessage, convertToLlm } from "./message-conversion.js";
import { estimateTokens } from "./compaction.js";
import type { CompactionMessage, CompactionSessionPort, ModelLike, SessionEntry } from "./types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  serializeConversation,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./utils.js";

export interface BranchSummaryResult {
  summary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  aborted?: boolean;
  error?: string;
}

export interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface BranchPreparation {
  messages: CompactionMessage[];
  fileOps: FileOperations;
  totalTokens: number;
}

export interface CollectEntriesResult {
  entries: SessionEntry[];
  commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
  model: ModelLike;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  customInstructions?: string;
  replaceInstructions?: boolean;
  reserveTokens?: number;
}

export function collectEntriesForBranchSummary(
  session: Pick<CompactionSessionPort, "getBranch" | "getEntry">,
  oldLeafId: string | null,
  targetId: string,
): CollectEntriesResult {
  if (!oldLeafId) return { entries: [], commonAncestorId: null };

  const oldPath = new Set(session.getBranch(oldLeafId).map((entry) => entry.id));
  const targetPath = session.getBranch(targetId);
  let commonAncestorId: string | null = null;
  for (let index = targetPath.length - 1; index >= 0; index--) {
    if (oldPath.has(targetPath[index].id)) {
      commonAncestorId = targetPath[index].id;
      break;
    }
  }

  const entries: SessionEntry[] = [];
  let current: string | null = oldLeafId;
  while (current && current !== commonAncestorId) {
    const entry = session.getEntry(current);
    if (!entry) break;
    entries.push(entry);
    current = entry.parentId;
  }
  entries.reverse();
  return { entries, commonAncestorId };
}

function messageFromEntry(entry: SessionEntry): CompactionMessage | undefined {
  if (entry.type === "message") {
    if (entry.message.role === "toolResult") return undefined;
    return entry.message;
  }
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

export function prepareBranchEntries(entries: SessionEntry[], tokenBudget = 0): BranchPreparation {
  const messages: CompactionMessage[] = [];
  const fileOps = createFileOps();
  let totalTokens = 0;

  for (const entry of entries) {
    if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
      const details = entry.details as Partial<BranchSummaryDetails>;
      if (Array.isArray(details.readFiles)) for (const file of details.readFiles) fileOps.read.add(file);
      if (Array.isArray(details.modifiedFiles)) for (const file of details.modifiedFiles) fileOps.edited.add(file);
    }
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const message = messageFromEntry(entry);
    if (!message) continue;
    extractFileOpsFromMessage(message, fileOps);
    const tokens = estimateTokens(message);
    if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
      if ((entry.type === "compaction" || entry.type === "branch_summary") && totalTokens < tokenBudget * 0.9) {
        messages.unshift(message);
        totalTokens += tokens;
      }
      break;
    }
    messages.unshift(message);
    totalTokens += tokens;
  }

  return { messages, fileOps, totalTokens };
}

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n`;
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.\n\nUse this EXACT format:\n\n## Goal\n[What was the user trying to accomplish in this branch?]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned]\n- [Or "(none)" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Work that was started but not finished]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [What should happen next to continue this work]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.`;

export async function generateBranchSummary(
  entries: SessionEntry[],
  options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
  const {
    model,
    apiKey,
    headers,
    signal,
    customInstructions,
    replaceInstructions,
    reserveTokens = 16384,
  } = options;
  const contextWindow = model.contextWindow || 128000;
  const tokenBudget = contextWindow - reserveTokens;
  const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);
  if (messages.length === 0) return { summary: "No content to summarize" };

  let instructions = BRANCH_SUMMARY_PROMPT;
  if (replaceInstructions && customInstructions) instructions = customInstructions;
  else if (customInstructions) instructions += `\n\nAdditional focus: ${customInstructions}`;

  const promptText = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${instructions}`;
  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [asUserMessage(promptText)] },
    { apiKey, headers, signal, maxTokens: 2048 },
  );
  if (response.stopReason === "aborted") return { aborted: true };
  if (response.stopReason === "error") return { error: response.errorMessage || "Summarization failed" };

  let summary = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  summary = BRANCH_SUMMARY_PREAMBLE + summary;
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  return { summary: summary || "No summary generated", readFiles, modifiedFiles };
}
