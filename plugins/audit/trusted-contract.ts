import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { AuditRecord, AuditRecordInput } from "./contract.js";

export interface AuditTrustedService {
  append(input: AuditRecordInput): AuditRecord;
}

export const AUDIT_TRUSTED_CAPABILITY: Capability<AuditTrustedService> =
  defineCapability<AuditTrustedService>("audit.trusted");
