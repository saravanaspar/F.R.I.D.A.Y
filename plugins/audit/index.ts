import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  AUDIT_CAPABILITY,
  type AuditCategory,
  type AuditOutcome,
} from "./contract.js";
import { AUDIT_TRUSTED_CAPABILITY } from "./trusted-contract.js";
import { createAuditController, type AuditServiceOptions } from "./audit.js";

export type AuditPluginOptions = AuditServiceOptions;

function optionalString(input: Readonly<SystemJsonObject>, name: string, maximum = 256): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function optionalInteger(
  input: Readonly<SystemJsonObject>,
  name: string,
  minimum: number,
): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function optionalCategory(input: Readonly<SystemJsonObject>): AuditCategory | undefined {
  const value = input.category;
  if (value === undefined) return undefined;
  if (value === "authorization" || value === "identity") return value;
  throw new Error("category must be authorization or identity");
}

function optionalOutcome(input: Readonly<SystemJsonObject>): AuditOutcome | undefined {
  const value = input.outcome;
  if (value === undefined) return undefined;
  if (value === "allowed" || value === "denied" || value === "error" || value === "changed") return value;
  throw new Error("outcome must be allowed, denied, error, or changed");
}

export function createAuditPlugin(options: AuditPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "audit", provides: [AUDIT_CAPABILITY, AUDIT_TRUSTED_CAPABILITY] }, (ctx) => {
    const controller = createAuditController(options);
    ctx.services.provide(AUDIT_CAPABILITY, controller.audit);
    ctx.services.provide(AUDIT_TRUSTED_CAPABILITY, controller.trusted);

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "audit",
      label: "Audit",
      snapshot: () => controller.audit.status(),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "audit.verify",
      label: "Verify audit ledger",
      description: "Verify the complete tamper-evident Audit ledger and authenticated head anchor.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => controller.audit.verify(),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "audit.records",
      label: "Audit records",
      description: "Query bounded Audit authority records using host-owned filters. Default to the latest 10 records when the user does not specify a count; honor explicit counts up to 500.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          category: { type: "string", enum: ["authorization", "identity"] },
          outcome: { type: "string", enum: ["allowed", "denied", "error", "changed"] },
          afterSequence: { type: "integer", minimum: 0 },
          beforeSequence: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          action: { type: "string" },
          actorId: { type: "string" },
          order: { type: "string", enum: ["asc", "desc"] },
        },
        additionalProperties: false,
      }),
      execute(input) {
        const order = optionalString(input, "order", 4);
        if (order !== undefined && order !== "asc" && order !== "desc") {
          throw new Error("order must be asc or desc");
        }
        const limit = optionalInteger(input, "limit", 1);
        if (limit !== undefined && limit > 500) throw new Error("limit must be <= 500");
        const category = optionalCategory(input);
        const outcome = optionalOutcome(input);
        const afterSequence = optionalInteger(input, "afterSequence", 0);
        const beforeSequence = optionalInteger(input, "beforeSequence", 0);
        const action = optionalString(input, "action");
        const actorId = optionalString(input, "actorId");
        return controller.audit.records({
          ...(category === undefined ? {} : { category }),
          ...(outcome === undefined ? {} : { outcome }),
          ...(afterSequence === undefined ? {} : { afterSequence }),
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
          limit: limit ?? 10,
          ...(action === undefined ? {} : { action }),
          ...(actorId === undefined ? {} : { actorId }),
          order: order ?? "desc",
        });
      },
    });
  });
}

export default createAuditPlugin();
export * from "./contract.js";
export * from "./trusted-contract.js";
export { createAuditController, type AuditController, type AuditServiceOptions } from "./audit.js";
export {
  AUDIT_DATABASE_FILE_NAME,
  AUDIT_HEAD_FILE_NAME,
  AUDIT_HMAC_KEY_BYTES,
  AUDIT_HMAC_KEY_FILE_NAME,
  assertAuditOutsideWorkspace,
  getAuditDatabasePath,
  getAuditHeadPath,
  getAuditHmacKeyPath,
  getAuditStateDir,
} from "./store.js";
