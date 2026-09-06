import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface SpendingLimitSnapshot {
  readonly currency: "USD";
  readonly warningRatio: number;
  readonly dailyLimit?: number | undefined;
  readonly projectLimits: Readonly<Record<string, number>>;
}

export interface SpendingApprovalRecord {
  readonly at: string;
  readonly scope: "daily" | "project";
  readonly key: string;
  readonly spent: number;
  readonly limit: number;
  readonly rootSessionId: string;
  readonly jobId?: string | undefined;
}

export interface SpendingPolicyService {
  limits(): SpendingLimitSnapshot;
  setLimit(scope: "daily" | "project", amount: number, projectKey?: string): SpendingLimitSnapshot;
  clearLimit(scope: "daily" | "project", projectKey?: string): SpendingLimitSnapshot;
  approvals(): readonly SpendingApprovalRecord[];
}

export const SPENDING_POLICY_CAPABILITY: Capability<SpendingPolicyService> =
  defineCapability<SpendingPolicyService>("spending-policy");
