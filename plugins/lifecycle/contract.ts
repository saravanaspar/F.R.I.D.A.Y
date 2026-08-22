import type { Capability, Contribution } from "../capabilities/protocol.js";
import { defineCapability, defineContribution } from "../capabilities/protocol.js";

export type LifecycleModule = typeof import("@friday/lifecycle");

export const LIFECYCLE_RESTART_STATUS_ENV = "FRIDAY_LIFECYCLE_RESTART_STATUS";

export function isLifecycleRestartEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment[LIFECYCLE_RESTART_STATUS_ENV]?.trim());
}

/** A process-local listener or worker that must have a single active owner. */
export interface LifecycleHandoffParticipant {
  readonly id: string;
  activate(): void | Promise<void>;
  quiesce(): void | Promise<void>;
}

export const LIFECYCLE_HANDOFF_CONTRIBUTION: Contribution<LifecycleHandoffParticipant> =
  defineContribution<LifecycleHandoffParticipant>("lifecycle.handoff");

export interface LifecycleHandoffCoordinator {
  /** Stop predecessor resources. Successful stops are remembered for resume. */
  quiesce(): Promise<void>;
  /** Restore resources stopped by quiesce when takeover cannot complete. */
  resume(): Promise<void>;
  /** Activate successor resources, compensating partial activation on failure. */
  activate(): Promise<void>;
  status(): Readonly<{ quiesced: readonly string[]; activated: readonly string[] }>;
}

export interface LifecycleService {
  readonly api: LifecycleModule;
  /** Present in the host plugin; optional keeps embedded legacy compositions source-compatible. */
  readonly handoff?: LifecycleHandoffCoordinator | undefined;
}

const LEGACY_NOOP_HANDOFF: LifecycleHandoffCoordinator = Object.freeze({
  quiesce: async () => undefined,
  resume: async () => undefined,
  activate: async () => undefined,
  status: () => Object.freeze({ quiesced: Object.freeze([]), activated: Object.freeze([]) }),
});

/** Resolve the coordinator while preserving old embedded LifecycleService mocks. */
export function lifecycleHandoff(service: LifecycleService): LifecycleHandoffCoordinator {
  return service.handoff ?? LEGACY_NOOP_HANDOFF;
}

export const LIFECYCLE_CAPABILITY: Capability<LifecycleService> =
  defineCapability<LifecycleService>("lifecycle");
