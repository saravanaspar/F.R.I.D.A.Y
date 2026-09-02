import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { PermissionMode } from "../permissions/contract.js";

type AutonomyRuntime = typeof import("@friday/autonomy");

export interface AutonomousGateSpec {
  id?: string;
  command: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface AutonomousRunOptions {
  objective: string;
  cwd: string;
  provider: string;
  model: string;
  gates?: readonly AutonomousGateSpec[] | undefined;
  stateDir?: string | undefined;
  maxContinuations?: number | undefined;
  maxTurns?: number | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  additionalSystemPrompt?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  signal?: AbortSignal | undefined;
}

export interface AutonomousRunResult {
  sessionId: string;
  finalText: string;
  gatesPassed: boolean;
}

/** Bounded autonomous execution primitives plus the high-level objective runner. */
export interface AutonomyService {
  readonly createAutonomousRuntimeState: AutonomyRuntime["createAutonomousRuntimeState"];
  readonly nextAutonomousContinuation: AutonomyRuntime["nextAutonomousContinuation"];
  runObjective(options: AutonomousRunOptions): Promise<AutonomousRunResult>;
}

export const AUTONOMY_CAPABILITY: Capability<AutonomyService> =
  defineCapability<AutonomyService>("autonomy");
