import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { PERMISSIONS_CAPABILITY, type PermissionEffect } from "../permissions/contract.js";
import { AGENT_PROMPT_SECTION_CONTRIBUTION, AGENT_TOOL_CONTRIBUTION, type AgentExtensionJsonValue, type AgentToolContributionContent, type AgentToolExecutionContext } from "../turn-loop/contract.js";
import { CuaDriver } from "./driver.js";
import { CUA_CAPABILITY } from "./contract.js";

const READ_TOOLS = new Set([
  "list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state",
  "get_screen_size", "get_cursor_position", "get_browser_state", "get_config", "get_recording_state",
]);

function toolEffect(name: string): PermissionEffect {
  return READ_TOOLS.has(name) || name.startsWith("get_") || name.startsWith("list_") ? "private-read" : "external-write";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value)) throw new Error(`Invalid CUA ${field}`);
  return value;
}

function toolArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CUA arguments must be an object");
  if (JSON.stringify(value).length > 64 * 1024) throw new Error("CUA arguments exceed 64 KiB");
  return value as Record<string, unknown>;
}

function jsonValue(value: unknown): AgentExtensionJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, jsonValue(item)]),
  );
  throw new Error("CUA driver returned non-JSON data");
}

export interface CuaPluginOptions {
  readonly driver?: CuaDriver;
}

export function createCuaPlugin(options: CuaPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "cua", requires: [PERMISSIONS_CAPABILITY], provides: [CUA_CAPABILITY] }, (ctx) => {
    const driver = options.driver ?? new CuaDriver();
    const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
    ctx.services.provide(CUA_CAPABILITY, driver);
    ctx.effect(() => driver.close());

    async function authorize(name: string, context?: AgentToolExecutionContext): Promise<void> {
      const effect = toolEffect(name);
      await permissions.authorize({
        mode: context?.permissionMode ?? permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: context?.cwd ?? process.cwd(),
        access: effect === "external-write" ? "write" : "read",
        action: { id: `cua.${name}`, effect, resource: `cua:${context?.sessionId ?? "local"}:${name}`, network: true },
        reason: `Use CUA Driver ${name} on the local desktop or browser`,
        ...(context?.jobId ? { jobId: context.jobId } : {}),
      });
    }

    ctx.contribute(AGENT_PROMPT_SECTION_CONTRIBUTION, {
      id: "cua-driver-guidance",
      render() {
        return {
          authority: "host-policy",
          cache: "stable",
          content: "For computer and browser interaction use CUA Driver through cua_list_tools and cua_call_tool. Discover the CUA schemas before calling. For browser work prepare an isolated browser with browser_prepare, inspect get_browser_state for session-scoped target/tab IDs and fresh refs, then use browser_* tools. For native apps inspect list_windows/get_window_state first. Refresh state after actions; never guess stale refs or coordinates. Do not send secrets, passwords, OTPs or CAPTCHA solutions through tool arguments.",
        };
      },
    });
    ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
      id: "cua-list-tools", sourcePluginId: "cua", name: "cua_list_tools", label: "List CUA tools",
      description: "Discover available CUA Driver desktop and browser tools, their current argument schemas, and descriptions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, signal, context) {
        await authorize("list_tools", context);
        return { output: jsonValue((await driver.listTools(signal)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))) };
      },
    });
    ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
      id: "cua-call-tool", sourcePluginId: "cua", name: "cua_call_tool", label: "Call CUA tool",
      description: "Call a CUA Driver desktop or browser tool after discovering its schema with cua_list_tools. Native window and browser target IDs must come from fresh CUA observations.",
      parameters: {
        type: "object",
        properties: { tool: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
        required: ["tool"], additionalProperties: false,
      },
      async execute(input, signal, context) {
        const name = requiredString(input.tool, "tool");
        const args = toolArgs(input.arguments);
        await authorize(name, context);
        const result = await driver.callTool(name, args, signal);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("CUA driver returned an invalid tool result");
        const response = result as { isError?: boolean; structuredContent?: unknown; content?: unknown };
        if (response.isError) return { isError: true, output: jsonValue(response.structuredContent ?? response.content ?? "CUA tool failed") };
        const content: AgentToolContributionContent[] = Array.isArray(response.content) ? response.content.flatMap((item: unknown): AgentToolContributionContent[] => {
          if (!item || typeof item !== "object") return [];
          const block = item as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") return [{ type: "text" as const, text: block.text }];
          if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
            return [{ type: "image" as const, data: block.data, mimeType: block.mimeType }];
          }
          return [];
        }) : [];
        return content.length ? { content } : { output: jsonValue(response.structuredContent ?? {}) };
      },
    });
  });
}

export default createCuaPlugin();
