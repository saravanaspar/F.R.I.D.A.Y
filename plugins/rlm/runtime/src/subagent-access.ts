import type { RlmModel, RlmModelMatch } from "./types.js";

export interface RlmSubagentAccess {
  findModelMatches(query: string, models: readonly RlmModel[], limit: number): RlmModelMatch[];
}

let activeSubagentAccess: RlmSubagentAccess | undefined;

export function installSubagentAccess(access: RlmSubagentAccess): void {
  activeSubagentAccess = access;
}

export function uninstallSubagentAccess(): void {
  activeSubagentAccess = undefined;
}

export function findModelMatches(
  query: string,
  models: readonly RlmModel[],
  limit: number,
): RlmModelMatch[] {
  if (!activeSubagentAccess) {
    throw new Error("RLM subagent access is not installed");
  }
  return activeSubagentAccess.findModelMatches(query, models, limit);
}
