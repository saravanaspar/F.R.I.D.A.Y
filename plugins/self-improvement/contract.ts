import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { AutonomousGateSpec, AutonomousRunOptions } from "../autonomy/contract.js";
import type { TurnAttachment, TurnPrincipal } from "../turn-loop/contract.js";

export interface SelfImprovementContinuation {
  readonly id: string;
  readonly principal: TurnPrincipal;
  readonly text: string;
  /** Original durable session destination when the request must resume in place. */
  readonly destinationId?: string | undefined;
  readonly timestamp: number;
  readonly attachments?: readonly TurnAttachment[] | undefined;
}

export type SelfImprovementPlacement = "reuse-existing" | "extend-plugin" | "mcp" | "new-plugin" | "host";

export interface SelfImprovementFeasibility {
  readonly feasible: boolean;
  readonly reason: string;
  readonly objective: string;
  readonly placement: SelfImprovementPlacement;
  readonly target: string;
  readonly requiresCode: boolean;
}

export interface SelfImproveRunOptions extends Omit<AutonomousRunOptions, "additionalSystemPrompt"> {
  worktreeRoot?: string | undefined;
  restartTimeoutMs?: number | undefined;
  takeoverTimeoutMs?: number | undefined;
  continuation?: SelfImprovementContinuation | undefined;
  /** Host-only: return once the successor is ready so a channel can reply before handoff. */
  deferHandoff?: boolean | undefined;
}

export interface SelfImprovementEnsureHooks {
  onFeasible(feasibility: SelfImprovementFeasibility): void | Promise<void>;
  authorize(feasibility: SelfImprovementFeasibility): void | Promise<void>;
}

export interface SelfImprovementEnsureResult {
  readonly feasibility: SelfImprovementFeasibility;
  readonly result?: SelfImproveRunResult | undefined;
}

export interface SelfImproveRunResult {
  candidateId: string;
  generationId: string;
  commit: string;
  restartRequestId: string;
}

export interface SelfImprovementHandoffOptions {
  stateDir?: string | undefined;
  takeoverTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Runs immediately before the predecessor quiesces and transfers ownership. */
  beforeHandoff?: (() => void | Promise<void>) | undefined;
}

export type SelfImprovementGateSpec = AutonomousGateSpec;

export interface SelfImprovementActiveRun {
  readonly objective: string;
  readonly startedAt: string;
}

export interface SelfImprovementMissionView {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError?: string | undefined;
}

export interface SelfImprovementService {
  selfImprove(options: SelfImproveRunOptions): Promise<SelfImproveRunResult>;
  preflightGenerationResume(generationId: string, stateDir?: string): Promise<void>;
  preflightRollbackRecovery(missionId: string, stateDir?: string): Promise<void>;
  assessFeasibility(options: SelfImproveRunOptions): Promise<SelfImprovementFeasibility>;
  ensureCapability(options: SelfImproveRunOptions, hooks: SelfImprovementEnsureHooks): Promise<SelfImprovementEnsureResult>;
  finalizeHandoff(result: SelfImproveRunResult, options?: SelfImprovementHandoffOptions): Promise<void>;
  resumeGeneration(generationId: string): Promise<SelfImprovementContinuation | undefined>;
  reportRollbackRecovery(missionId: string): Promise<void>;
  activeRun(): SelfImprovementActiveRun | undefined;
  cancelActive(reason?: string): boolean;
  missions(stateDir?: string): readonly SelfImprovementMissionView[];
}

export const SELF_IMPROVEMENT_CAPABILITY: Capability<SelfImprovementService> =
  defineCapability<SelfImprovementService>("self-improvement");
