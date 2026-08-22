import type { FridayPlugin } from "../../src/plugin.js";
import { AGENT_TOOL_CONTRIBUTION, type AgentExtensionJsonValue } from "../turn-loop/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  INTEGRATIONS_CAPABILITY,
  type IntegrationJsonValue,
  type IntegrationSettings,
} from "./contract.js";
import { createIntegrationsService } from "./integrations.js";

function agentString(input: Readonly<Record<string, AgentExtensionJsonValue>>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function systemString(
  input: Readonly<SystemJsonObject>,
  name: string,
  options: { readonly required?: boolean; readonly maximum?: number } = {},
): string | undefined {
  const value = input[name];
  if (value === undefined && options.required !== true) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    if (options.required === true) throw new Error(`${name} must not be empty`);
    return undefined;
  }
  const maximum = options.maximum ?? 256;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function systemSettings(input: Readonly<SystemJsonObject>): IntegrationSettings {
  const value = input.settings ?? {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be a JSON object");
  }
  return value as IntegrationSettings;
}

const integrationsPlugin: FridayPlugin = definePlugin({
  id: "integrations",
  requires: [PERMISSIONS_CAPABILITY],
  provides: [INTEGRATIONS_CAPABILITY],
}, (ctx) => {
  const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
  const integrations = createIntegrationsService({
    async authorize({ connection, action }) {
      const mode = permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE);
      await permissions.authorize({
        mode,
        workspace: process.cwd(),
        access: action.mutatesExternalState ? "write" : "read",
        action: {
          id: action.mutatesExternalState ? "integrations.invoke.write" : "integrations.invoke.read",
          effect: action.mutatesExternalState ? "external-write" : "external-read",
          resource: `${connection.provider}:${connection.id}:${action.id}`,
          network: true,
        },
        reason: `integration ${connection.provider}:${action.id} through ${connection.id}`,
      });
    },
  });
  ctx.services.provide(INTEGRATIONS_CAPABILITY, integrations);

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "integrations-connections",
    name: "integrations_connections",
    label: "Integration connections",
    description: "List configured integration connections and the actions exposed by installed adapters.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const adapters = new Map(integrations.adapters().map((adapter) => [adapter.id, adapter]));
      return {
        output: integrations.connections().map((connection) => ({
          id: connection.id,
          provider: connection.provider,
          name: connection.name,
          enabled: connection.enabled,
          actions: (adapters.get(connection.provider)?.actions ?? []).map((action) => ({
            id: action.id,
            description: action.description,
            mutatesExternalState: action.mutatesExternalState,
          })),
        })),
      };
    },
  });
  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "integrations-invoke",
    name: "integrations_invoke",
    label: "Invoke integration",
    description: "Invoke an action on an existing integration connection. Permission policy is enforced by the integration service.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "Existing integration connection id" },
        actionId: { type: "string", description: "Action id exposed by the connection provider" },
        input: { description: "JSON input for the action" },
      },
      required: ["connectionId", "actionId"],
      additionalProperties: false,
    },
    async execute(input, signal) {
      return {
        output: await integrations.invoke(
          agentString(input, "connectionId"),
          agentString(input, "actionId"),
          (input.input ?? null) as IntegrationJsonValue,
          signal,
        ),
      };
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "integrations.connections",
    label: "Integration connections",
    description: "List configured integration connections.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    execute: () => integrations.connections(),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "integrations.providers",
    label: "Integration providers",
    description: "List installed integration adapters and their actions.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    execute: () => integrations.adapters(),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "integrations.connect",
    label: "Connect integration",
    description: "Create or update an integration connection using non-secret settings and an optional Vault credential reference.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        id: { type: "string" },
        provider: { type: "string" },
        name: { type: "string" },
        credentialRef: { type: "string" },
        settings: { type: "object", additionalProperties: true },
      },
      required: ["id", "provider"],
      additionalProperties: false,
    }),
    permission(input) {
      const id = systemString(input, "id", { required: true })!;
      return {
        id: "integrations.connect",
        effect: "system-write",
        resource: `integration:${id}`,
        network: false,
      };
    },
    execute(input) {
      const id = systemString(input, "id", { required: true })!;
      const provider = systemString(input, "provider", { required: true })!;
      const name = systemString(input, "name", { maximum: 160 });
      const credentialRef = systemString(input, "credentialRef", { maximum: 512 });
      return integrations.connect({
        id,
        provider,
        ...(name === undefined ? {} : { name }),
        ...(credentialRef === undefined ? {} : { credentialRef }),
        settings: systemSettings(input),
      });
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "integrations.disconnect",
    label: "Disconnect integration",
    description: "Remove a configured integration connection.",
    parameters: Object.freeze({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    }),
    permission(input) {
      const id = systemString(input, "id", { required: true })!;
      return {
        id: "integrations.disconnect",
        effect: "system-write",
        resource: `integration:${id}`,
        network: false,
      };
    },
    execute(input) {
      const id = systemString(input, "id", { required: true })!;
      return { id, disconnected: integrations.disconnect(id) };
    },
  });
});

export default integrationsPlugin;
