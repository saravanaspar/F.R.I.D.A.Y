import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type ConditionalHookPhase = "turn" | "before-action" | "after-action" | "before-handover";

export interface ConditionalHookRule {
  readonly id: string;
  readonly ownerScope: string;
  readonly condition: string;
  readonly instruction: string;
  readonly phase: ConditionalHookPhase;
  readonly maxInvocations: number | null;
  readonly invocationCount: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConditionalHooksService {
  list(ownerScope: string): readonly ConditionalHookRule[];
  create(input: {
    ownerScope: string;
    condition: string;
    instruction: string;
    phase: ConditionalHookPhase;
    maxInvocations: number | null;
  }): ConditionalHookRule;
  remove(ownerScope: string, id: string): boolean;
  invoke(ownerScope: string, id: string): ConditionalHookRule | undefined;
  status(): { total: number; active: number; exhausted: number };
}

export const CONDITIONAL_HOOKS_CAPABILITY: Capability<ConditionalHooksService> =
  defineCapability<ConditionalHooksService>("conditional-hooks");
