import {
  MEMORY_ENTRY_KINDS,
  type MemoryOverviewOptions,
  type MemoryRelationResult,
  type MemorySearchResult,
  type MemoryState,
} from "./types.js";

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatMemoryOverview(
  state: MemoryState,
  options: MemoryOverviewOptions = {},
): string {
  const maxEntriesPerKind = options.maxEntriesPerKind ?? 6;
  const maxRefinements = options.maxRefinements ?? 5;
  const maxContentLength = options.maxContentLength ?? 180;
  const lines = ["# Continual Memory State", ""];

  let totalEntries = 0;
  for (const kind of MEMORY_ENTRY_KINDS) {
    const entries = Object.values(state.entries[kind]).sort((left, right) =>
      [left.path, left.title, left.id]
        .join("\0")
        .localeCompare([right.path, right.title, right.id].join("\0")),
    );
    totalEntries += entries.length;
    lines.push(`${kind}: ${entries.length}`);
    for (const entry of entries.slice(0, maxEntriesPerKind)) {
      const reference =
        kind === "skill" && Object.keys(entry.reference).length > 0
          ? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
          : "";
      const args =
        kind === "skill" && Object.keys(entry.arguments).length > 0
          ? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
          : "";
      lines.push(
        `- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${reference}${args}: ${compactText(entry.content, maxContentLength)}`,
      );
    }
    const overflow = entries.length - Math.min(entries.length, maxEntriesPerKind);
    if (overflow > 0) lines.push(`- +${overflow} more ${kind} entries`);
    lines.push("");
  }

  if (totalEntries === 0) lines.push("No saved memory entries yet.", "");

  lines.push(`recent refinements: ${state.refinements.length}`);
  for (const event of state.refinements.slice(-maxRefinements)) {
    const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
    const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
    lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
  }
  const overflow = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
  if (overflow > 0) lines.push(`- +${overflow} older refinement events`);

  return lines.join("\n").trim();
}

/** Compact, query-selected memory context intended for a model turn. */
export function formatRelevantMemory(
  entries: readonly MemorySearchResult[],
  relations: readonly MemoryRelationResult[],
  options: { maxCharacters?: number | undefined } = {},
): string | undefined {
  if (entries.length === 0 && relations.length === 0) return undefined;
  const lines = ["Relevant saved memory (use only when it applies):"];
  for (const result of relations) {
    const relation = result.relation;
    const context = Object.keys(relation.context).length > 0
      ? ` ${compactText(JSON.stringify(relation.context), 320)}`
      : "";
    lines.push(`- preference: ${relation.subject} ${relation.predicate.replaceAll("_", " ")} ${relation.object}${context} [seen ${relation.occurrences}x; last ${relation.last_observed_at}]`);
  }
  for (const result of entries) {
    lines.push(`- note: ${result.entry.title}: ${compactText(result.entry.content, 320)}`);
  }
  const maximum = options.maxCharacters ?? 2_400;
  const text = lines.join("\n");
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}\u2026`;
}
