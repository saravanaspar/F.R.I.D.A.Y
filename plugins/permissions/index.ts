import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { AUDIT_TRUSTED_CAPABILITY } from "../audit/trusted-contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
  type SystemJsonValue,
} from "../system/contract.js";
import { PERMISSIONS_CAPABILITY, type TrustedIdentityRole } from "./contract.js";
import { createPermissionsController, terminalPermissionApprover, type PermissionApprover } from "./policy.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "./trusted-contract.js";

export interface PermissionsPluginOptions {
  readonly stateDir?: string | undefined;
  readonly approve?: PermissionApprover | undefined;
}

function systemString(input: Readonly<SystemJsonObject>, name: string, maximum = 256): string {
  const value = input[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function systemRole(value: SystemJsonValue | undefined): TrustedIdentityRole {
  if (value === undefined) return "operator";
  if (value === "operator" || value === "read-only") return value;
  throw new Error("role must be operator or read-only");
}

function systemIdentity(input: Readonly<SystemJsonObject>): {
  channel: string;
  accountId: string;
  senderId: string;
} {
  return {
    channel: systemString(input, "channel", 64),
    accountId: systemString(input, "accountId"),
    senderId: systemString(input, "senderId"),
  };
}

export function createPermissionsPlugin(options: PermissionsPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "permissions",
    requires: [AUDIT_TRUSTED_CAPABILITY],
    optional: [CHANNELS_TRUSTED_CAPABILITY],
    provides: [PERMISSIONS_CAPABILITY, PERMISSIONS_TRUSTED_CAPABILITY],
  }, (ctx) => {
    const audit = ctx.services.require(AUDIT_TRUSTED_CAPABILITY);
    const approve: PermissionApprover = options.approve ?? (async (request) => {
      if (request.principal.kind !== "channel") return terminalPermissionApprover(request);
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("Channel permission approval is required, but Channels is not available");
      const { channel, accountId, senderId, conversationId, threadId } = request.principal;
      if (!channel || !accountId || !senderId || !conversationId) {
        throw new Error("Channel permission approval is missing exact originating conversation context");
      }
      return channels.requestApproval({
        principal: {
          channel,
          accountId,
          conversationId,
          senderId,
          ...(threadId === undefined ? {} : { threadId }),
        },
        actionId: request.action.id,
        effect: request.action.effect,
        resource: request.action.resource,
        reason: request.reason,
        network: request.action.network,
      });
    });
    const controller = createPermissionsController({
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
      approve,
      audit: (entry) => { audit.append(entry); },
    });
    ctx.services.provide(PERMISSIONS_CAPABILITY, controller.permissions);
    ctx.services.provide(PERMISSIONS_TRUSTED_CAPABILITY, controller.trusted);

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "permissions",
      label: "Permissions",
      snapshot: () => ({ trustedIdentities: controller.trusted.identities().length }),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "permissions.identities",
      label: "Trusted identities",
      description: "List the exact channel identities trusted by FRIDAY and their roles.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => controller.trusted.identities() as unknown as SystemJsonValue,
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "permissions.trust-channel",
      label: "Trust channel identity",
      description: "Trust an exact channel/account/sender identity with operator or read-only role.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          channel: { type: "string" },
          accountId: { type: "string" },
          senderId: { type: "string" },
          role: { type: "string", enum: ["operator", "read-only"] },
          label: { type: "string" },
        },
        required: ["channel", "accountId", "senderId"],
        additionalProperties: false,
      }),
      permission(input) {
        const identity = systemIdentity(input);
        return {
          id: "permissions.trust-channel",
          effect: "system-write",
          resource: `identity:${identity.channel}:${identity.accountId}:${identity.senderId}`,
          network: false,
        };
      },
      execute(input) {
        const identity = systemIdentity(input);
        const label = input.label === undefined ? undefined : systemString(input, "label", 160);
        return controller.trusted.trustChannelIdentity({
          ...identity,
          role: systemRole(input.role),
          ...(label === undefined ? {} : { label }),
        }) as unknown as SystemJsonValue;
      },
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "permissions.revoke-channel",
      label: "Revoke channel identity",
      description: "Revoke an exact trusted channel/account/sender identity.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          channel: { type: "string" },
          accountId: { type: "string" },
          senderId: { type: "string" },
        },
        required: ["channel", "accountId", "senderId"],
        additionalProperties: false,
      }),
      permission(input) {
        const identity = systemIdentity(input);
        return {
          id: "permissions.revoke-channel",
          effect: "system-write",
          resource: `identity:${identity.channel}:${identity.accountId}:${identity.senderId}`,
          network: false,
        };
      },
      execute(input) {
        const identity = systemIdentity(input);
        return { revoked: controller.trusted.revokeChannelIdentity(identity), ...identity };
      },
    });
  });
}

export default createPermissionsPlugin();
export * from "./contract.js";
export * from "./trusted-contract.js";
export {
  createPermissionsController,
  createPermissionsService,
  terminalPermissionApprover,
  type PermissionApprover,
  type PermissionAuditEntry,
  type PermissionAuditSink,
  type PermissionsController,
  type PermissionsServiceOptions,
} from "./policy.js";
export {
  PERMISSIONS_IDENTITIES_FILE_NAME,
  getPermissionsIdentitiesPath,
  getPermissionsStateDir,
} from "./identity-store.js";
