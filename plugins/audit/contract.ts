import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type AuditCategory = "authorization" | "identity";
export type AuditOutcome = "allowed" | "denied" | "error" | "changed";
export type AuditActorKind = "local" | "system" | "channel";
export type AuditActorRole = "operator" | "read-only" | "untrusted";
export type AuditDetailValue = string | number | boolean | null;
export type AuditDetails = Record<string, AuditDetailValue>;

export interface AuditActor {
  readonly id: string;
  readonly kind: AuditActorKind;
  readonly role: AuditActorRole;
}

export interface AuditRecordInput {
  readonly category: AuditCategory;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly occurredAt?: string | undefined;
  readonly effect?: string | undefined;
  readonly resource?: string | undefined;
  readonly subject?: string | undefined;
  readonly network?: boolean | undefined;
  readonly mode?: string | undefined;
  readonly access?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface AuditRecord {
  readonly sequence: number;
  readonly id: string;
  readonly occurredAt: string;
  readonly category: AuditCategory;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly effect?: string | undefined;
  readonly resource?: string | undefined;
  readonly subject?: string | undefined;
  readonly network?: boolean | undefined;
  readonly mode?: string | undefined;
  readonly access?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly details: AuditDetails;
  readonly previousHash: string;
  readonly recordHash: string;
}

export interface AuditQuery {
  readonly afterSequence?: number | undefined;
  readonly beforeSequence?: number | undefined;
  readonly category?: AuditCategory | undefined;
  readonly action?: string | undefined;
  readonly outcome?: AuditOutcome | undefined;
  readonly actorId?: string | undefined;
  readonly limit?: number | undefined;
  readonly order?: "asc" | "desc" | undefined;
}

export interface AuditVerification {
  readonly valid: true;
  readonly recordCount: number;
  readonly headSequence: number;
  readonly headHash: string;
  readonly verifiedAt: string;
}

export interface AuditStatus {
  readonly recordCount: number;
  readonly headSequence: number;
  readonly headHash: string;
}

export interface AuditService {
  records(query?: AuditQuery): readonly AuditRecord[];
  verify(): AuditVerification;
  status(): AuditStatus;
}

export const AUDIT_CAPABILITY: Capability<AuditService> = defineCapability<AuditService>("audit");
