import type {
  RefinementCompletionContext,
  RefinementCompletionOptions,
  RefinementCompletionResponse,
  RefinementModelLike,
} from "./types.js";

export interface RefinementModelAccess {
  completeSimple(
    model: RefinementModelLike,
    context: RefinementCompletionContext,
    options: RefinementCompletionOptions,
  ): Promise<RefinementCompletionResponse>;
}

let activeModelAccess: RefinementModelAccess | undefined;

export function installModelAccess(access: RefinementModelAccess): void {
  activeModelAccess = access;
}

export function uninstallModelAccess(): void {
  activeModelAccess = undefined;
}

export function completeSimple(
  model: RefinementModelLike,
  context: RefinementCompletionContext,
  options: RefinementCompletionOptions,
): Promise<RefinementCompletionResponse> {
  if (!activeModelAccess) throw new Error("Refinement model access is not installed");
  return activeModelAccess.completeSimple(model, context, options);
}
