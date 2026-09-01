import type { Contribution } from "../capabilities/protocol.js";
import { defineContribution } from "../capabilities/protocol.js";
import type { PermissionAction } from "../permissions/contract.js";
import type { InboundTurn, TurnFinalizerDescriptor } from "../turn-loop/contract.js";

/** Values are validated as JSON-safe at the executor boundary. */
export type SystemJsonValue = unknown;
export type SystemJsonObject = Record<string, unknown>;

export interface SystemActionExecutionContext {
  readonly signal?: AbortSignal | undefined;
  /** Exact host-owned turn origin. Actions may use this for safe reply/capture workflows. */
  readonly turn: InboundTurn;
  /** Durable Session Jobs attribution when this action runs in background. */
  readonly jobId?: string | undefined;
  /** Host-owned routed session destination for restart-safe continuations. */
  readonly destinationId?: string | undefined;
  /** Register host-only work that must run only after the final response is delivered and recorded. */
  deferAfterReply(callback: () => void | Promise<void>, durable?: TurnFinalizerDescriptor): void;
  /** Register compensation that runs if execution, presentation, publication, or reply delivery fails. */
  deferOnFailure?(callback: (error: unknown) => void | Promise<void>): void;
}

/**
 * Host-owned action surface for explicit FRIDAY control/configuration requests.
 * The System executor only selects among contributions; the owning plugin keeps
 * validation, authorization metadata, and implementation of the action itself.
 */
export interface SystemActionContribution {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<SystemJsonObject>;
  /** Every host action must declare authorization. The executor fails closed. */
  permission(input: Readonly<SystemJsonObject>): PermissionAction;
  execute(
    input: Readonly<SystemJsonObject>,
    context: SystemActionExecutionContext,
  ): SystemJsonValue | Promise<SystemJsonValue>;
}

export interface SystemStatusContribution {
  readonly id: string;
  readonly label: string;
  snapshot(): SystemJsonValue | Promise<SystemJsonValue>;
}

/** Generic restart-safety view contributed by work-owning plugins. */
export interface SystemActiveWorkQuery {
  /** Exclude the durable background job that is itself requesting the restart. */
  readonly excludeJobId?: string | undefined;
  /** Exclude the foreground turn that is itself requesting the restart. */
  readonly excludeForegroundTurns?: number | undefined;
}

export interface SystemActiveWorkSnapshot {
  readonly backgroundSessions?: number | undefined;
  readonly foregroundTurns?: number | undefined;
}

export interface SystemActiveWorkContribution {
  readonly id: string;
  snapshot(query: SystemActiveWorkQuery): SystemActiveWorkSnapshot;
}

export interface SystemActiveWorkSummary {
  readonly backgroundSessions: number;
  readonly foregroundTurns: number;
}

export function summarizeSystemActiveWork(
  contributions: readonly SystemActiveWorkContribution[],
  query: SystemActiveWorkQuery = {},
): SystemActiveWorkSummary {
  let backgroundSessions = 0;
  let foregroundTurns = 0;
  for (const contribution of contributions) {
    const snapshot = contribution.snapshot(query);
    if (snapshot.backgroundSessions !== undefined) {
      if (!Number.isSafeInteger(snapshot.backgroundSessions) || snapshot.backgroundSessions < 0) {
        throw new Error(`Invalid background session count from ${contribution.id}`);
      }
      backgroundSessions += snapshot.backgroundSessions;
    }
    if (snapshot.foregroundTurns !== undefined) {
      if (!Number.isSafeInteger(snapshot.foregroundTurns) || snapshot.foregroundTurns < 0) {
        throw new Error(`Invalid foreground turn count from ${contribution.id}`);
      }
      foregroundTurns += snapshot.foregroundTurns;
    }
  }
  return Object.freeze({ backgroundSessions, foregroundTurns });
}

export const SYSTEM_ACTION_CONTRIBUTION: Contribution<SystemActionContribution> =
  defineContribution<SystemActionContribution>("system.action");

export const SYSTEM_STATUS_CONTRIBUTION: Contribution<SystemStatusContribution> =
  defineContribution<SystemStatusContribution>("system.status");

export const SYSTEM_ACTIVE_WORK_CONTRIBUTION: Contribution<SystemActiveWorkContribution> =
  defineContribution<SystemActiveWorkContribution>("system.active-work");
