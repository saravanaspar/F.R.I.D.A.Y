import type {
  AutoRefineReview,
  RefinementAction,
  RefinementEdit,
  RefinementKind,
  RefinementProposal,
} from "./types.js";

export const TRUNCATED_JSON_ERROR =
  "the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function isIncompleteJson(candidate: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }
  return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    if (isIncompleteJson(candidate)) throw new Error(TRUNCATED_JSON_ERROR);
    throw new Error(
      `the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fencedJsonCandidate(text: string): string | undefined {
  const open = text.indexOf("```");
  if (open < 0) return undefined;
  let start = open + 3;
  if (text.startsWith("json", start)) start += 4;

  while (start < text.length) {
    const code = text.charCodeAt(start);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
    start += 1;
  }

  const close = text.indexOf("```", start);
  if (close < 0) return undefined;
  const candidate = text.slice(start, close).trim();
  return candidate || undefined;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return parseJsonCandidate(trimmed);
  const fenced = fencedJsonCandidate(trimmed);
  if (fenced) return parseJsonCandidate(fenced);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return parseJsonCandidate(trimmed.slice(start));
    }
  }
  if (isIncompleteJson(trimmed)) throw new Error(TRUNCATED_JSON_ERROR);
  throw new Error("Refiner did not return a JSON object");
}

export function parseProposal(text: string): RefinementProposal {
  const value = extractJsonObject(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Refiner JSON must be an object");
  }
  const record = value as Record<string, unknown>;
  const edits = Array.isArray(record.edits) ? record.edits : [];
  return {
    summary: typeof record.summary === "string" ? record.summary : "Refined continual state",
    rationale: typeof record.rationale === "string" ? record.rationale : "",
    expectedOutcome: typeof record.expectedOutcome === "string" ? record.expectedOutcome : "",
    edits: edits
      .filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
      .map((edit) => {
        const parsed: RefinementEdit = {
          action: edit.action as RefinementAction,
          kind: edit.kind as RefinementKind,
        };
        if (typeof edit.id === "string") parsed.id = edit.id;
        if (typeof edit.title === "string") parsed.title = edit.title;
        if (typeof edit.content === "string") parsed.content = edit.content;
        if (typeof edit.path === "string") parsed.path = edit.path;
        const reference = objectRecord(edit.reference);
        if (reference) parsed.reference = reference;
        const argumentsValue = objectRecord(edit.arguments);
        if (argumentsValue) parsed.arguments = argumentsValue;
        const metadata = objectRecord(edit.metadata);
        if (metadata) parsed.metadata = metadata;
        if (typeof edit.reason === "string") parsed.reason = edit.reason;
        return parsed;
      }),
  };
}

export function parseAutoRefineReview(text: string): AutoRefineReview {
  const value = extractJsonObject(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Auto-refine review JSON must be an object");
  }
  const record = value as Record<string, unknown>;
  const review: AutoRefineReview = {
    shouldRefine: record.shouldRefine === true,
    rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
  };
  if (typeof record.instructions === "string") review.instructions = record.instructions;
  return review;
}
