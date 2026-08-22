import type {
  CompletionContext,
  CompletionOptions,
  CompletionResponse,
  ModelLike,
} from "./types.js";

export interface CompactionModelAccess {
  completeSimple(
    model: ModelLike,
    context: CompletionContext,
    options: CompletionOptions,
  ): Promise<CompletionResponse>;
}

let activeModelAccess: CompactionModelAccess | undefined;

export function installModelAccess(access: CompactionModelAccess): void {
  activeModelAccess = access;
}

export function uninstallModelAccess(): void {
  activeModelAccess = undefined;
}

export function completeSimple(
  model: ModelLike,
  context: CompletionContext,
  options: CompletionOptions,
): Promise<CompletionResponse> {
  if (!activeModelAccess) {
    throw new Error("Compaction model access is not installed");
  }
  return activeModelAccess.completeSimple(model, context, options);
}
