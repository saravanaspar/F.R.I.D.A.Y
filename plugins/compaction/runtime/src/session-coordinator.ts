import { generateBranchSummary, collectEntriesForBranchSummary } from "./branch-summarization.js";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type CompactionDetails,
  type CompactionResult,
  type CompactionSettings,
} from "./compaction.js";
import { openSession } from "./session-access.js";
import type { CompactionSessionPort, ModelLike, ThinkingLevel } from "./types.js";

export interface CompactSessionOptions {
  model: ModelLike;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  settings?: CompactionSettings;
  customInstructions?: string;
  force?: boolean;
}

export interface PersistedCompactionResult extends CompactionResult<CompactionDetails> {
  entryId: string;
}

export async function compactSession(
  session: CompactionSessionPort,
  options: CompactSessionOptions,
): Promise<PersistedCompactionResult | undefined> {
  const settings = options.settings ?? DEFAULT_COMPACTION_SETTINGS;
  const context = session.buildSessionContext();
  const usage = estimateContextTokens(context.messages);
  if (!options.force && !shouldCompact(usage.tokens, options.model.contextWindow, settings)) return undefined;

  const preparation = prepareCompaction(session.getBranch(), settings, context.messages);
  if (!preparation) return undefined;
  const result = await compact(
    preparation,
    options.model,
    options.apiKey,
    options.headers,
    options.customInstructions,
    options.signal,
    options.thinkingLevel,
  );
  const entryId = session.appendCompaction(
    result.summary,
    result.firstKeptEntryId,
    result.tokensBefore,
    result.details,
    false,
    options.customInstructions,
  );
  return { ...result, entryId };
}

export async function compactSessionFile(
  sessionPath: string,
  options: CompactSessionOptions & { cwdOverride?: string },
): Promise<PersistedCompactionResult | undefined> {
  return compactSession(openSession(sessionPath, options.cwdOverride), options);
}

export interface SummarizeBranchOptions {
  model: ModelLike;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  customInstructions?: string;
  replaceInstructions?: boolean;
  reserveTokens?: number;
}

export async function summarizeAndBranch(
  session: CompactionSessionPort,
  oldLeafId: string | null,
  targetId: string,
  options: SummarizeBranchOptions,
): Promise<{ entryId?: string; summary?: string; aborted?: boolean; error?: string }> {
  const { entries } = collectEntriesForBranchSummary(session, oldLeafId, targetId);
  const result = await generateBranchSummary(entries, options);
  if (result.aborted || result.error || !result.summary) return result;
  const entryId = session.branchWithSummary(
    targetId,
    result.summary,
    { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
    false,
  );
  return { entryId, summary: result.summary };
}
