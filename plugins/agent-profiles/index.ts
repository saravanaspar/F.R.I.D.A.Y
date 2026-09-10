import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY, type EventsService } from "../events/contract.js";
import { AGENT_PROMPT_SECTION_CONTRIBUTION, type AgentToolExecutionContext } from "../turn-loop/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemActionExecutionContext, type SystemJsonObject } from "../system/contract.js";
import { AGENT_PROFILES_CAPABILITY, type AgentNotificationPreference, type AgentProfile, type AgentProfileCreateInput, type AgentProfileUpdateInput, type AgentProfilesService } from "./contract.js";

const MAX_PROFILES = 256;
const MAX_LIST_ITEMS = 64;

function stateRoot(): string {
  return resolve(process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"), "agent-profiles");
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "\ufffd").trim();
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function optionalText(value: unknown, label: string, maximum = 512): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, label, maximum);
}

function freeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "\ufffd").trim();
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function profileId(value: unknown): string {
  const normalized = text(value, "profile id", 96).toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) throw new Error("profile id must use lowercase kebab-case");
  return normalized;
}

function memoryScope(value: unknown, fallback: string): string {
  const resolved = value === undefined ? fallback : text(value, "memoryScope", 256);
  if (!/^(?:global:user|agent:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|project:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.test(resolved)) {
    throw new Error("memoryScope must be global:user, agent:<id>, or project:<id>");
  }
  return resolved;
}

function listValues(value: readonly string[] | undefined, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new Error(`${label} must contain at most ${MAX_LIST_ITEMS} items`);
  const normalized = [...new Set(value.map((item) => text(item, `${label} item`, 128)))];
  return Object.freeze(normalized);
}

function notification(value: unknown | undefined): AgentNotificationPreference {
  if (value === undefined) return "important";
  if (value !== "all" && value !== "important" && value !== "muted") throw new Error("notificationPreference must be all, important, or muted");
  return value;
}

function parseProfile(value: unknown): AgentProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid agent profile record");
  const raw = value as Record<string, unknown>;
  const id = profileId(raw.id);
  const createdAt = text(raw.createdAt, "createdAt", 64);
  const updatedAt = text(raw.updatedAt, "updatedAt", 64);
  return Object.freeze({
    id,
    name: text(raw.name, "name", 128),
    title: text(raw.title ?? raw.name, "title", 128),
    description: freeText(raw.description ?? "", "description", 2_000),
    ...(raw.avatar === undefined ? {} : { avatar: optionalText(raw.avatar, "avatar", 512) }),
    roleInstructions: freeText(raw.roleInstructions ?? "", "roleInstructions", 24_000),
    ...(raw.defaultConversationId === undefined ? {} : { defaultConversationId: optionalText(raw.defaultConversationId, "defaultConversationId", 128) }),
    memoryScope: memoryScope(raw.memoryScope, `agent:${id}`),
    enabledSkills: listValues(raw.enabledSkills as readonly string[] | undefined, "enabledSkills"),
    enabledPlugins: listValues(raw.enabledPlugins as readonly string[] | undefined, "enabledPlugins"),
    ...(raw.defaultProjectId === undefined ? {} : { defaultProjectId: optionalText(raw.defaultProjectId, "defaultProjectId", 128) }),
    ...(raw.defaultComputerScreen === undefined ? {} : { defaultComputerScreen: optionalText(raw.defaultComputerScreen, "defaultComputerScreen", 128) }),
    notificationPreference: notification(raw.notificationPreference),
    approvalPolicy: text(raw.approvalPolicy ?? "default", "approvalPolicy", 128),
    createdAt,
    updatedAt,
  });
}

interface StateFile { readonly schema: 1; readonly profiles: readonly AgentProfile[]; }

async function readState(): Promise<readonly AgentProfile[]> {
  try {
    const parsed = JSON.parse(await readFile(join(stateRoot(), "profiles.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid agent profile state");
    const raw = parsed as Record<string, unknown>;
    if (raw.schema !== 1 || !Array.isArray(raw.profiles)) throw new Error("unsupported agent profile state");
    if (raw.profiles.length > MAX_PROFILES) throw new Error("agent profile state exceeds profile limit");
    return Object.freeze(raw.profiles.map(parseProfile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}

async function writeState(profiles: readonly AgentProfile[]): Promise<void> {
  const root = stateRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, "profiles.json");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const state: StateFile = { schema: 1, profiles };
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function createProfile(input: AgentProfileCreateInput): AgentProfile {
  const id = profileId(input.id ?? input.name);
  const now = new Date().toISOString();
  return Object.freeze({
    id,
    name: text(input.name, "name", 128),
    title: text(input.title ?? input.name, "title", 128),
    description: freeText(input.description ?? "", "description", 2_000),
    ...(input.avatar === undefined ? {} : { avatar: optionalText(input.avatar, "avatar", 512) }),
    roleInstructions: freeText(input.roleInstructions ?? "", "roleInstructions", 24_000),
    ...(input.defaultConversationId === undefined ? {} : { defaultConversationId: optionalText(input.defaultConversationId, "defaultConversationId", 128) }),
    memoryScope: memoryScope(input.memoryScope, `agent:${id}`),
    enabledSkills: listValues(input.enabledSkills, "enabledSkills"),
    enabledPlugins: listValues(input.enabledPlugins, "enabledPlugins"),
    ...(input.defaultProjectId === undefined ? {} : { defaultProjectId: optionalText(input.defaultProjectId, "defaultProjectId", 128) }),
    ...(input.defaultComputerScreen === undefined ? {} : { defaultComputerScreen: optionalText(input.defaultComputerScreen, "defaultComputerScreen", 128) }),
    notificationPreference: notification(input.notificationPreference),
    approvalPolicy: text(input.approvalPolicy ?? "default", "approvalPolicy", 128),
    createdAt: now,
    updatedAt: now,
  });
}

function patchProfile(profile: AgentProfile, input: AgentProfileUpdateInput): AgentProfile {
  const updatedAt = new Date().toISOString();
  return Object.freeze({
    ...profile,
    ...(input.name === undefined ? {} : { name: text(input.name, "name", 128) }),
    ...(input.title === undefined ? {} : { title: text(input.title, "title", 128) }),
    ...(input.description === undefined ? {} : { description: freeText(input.description, "description", 2_000) }),
    ...(input.avatar === undefined ? {} : input.avatar === null ? { avatar: undefined } : { avatar: optionalText(input.avatar, "avatar", 512) }),
    ...(input.roleInstructions === undefined ? {} : { roleInstructions: freeText(input.roleInstructions, "roleInstructions", 24_000) }),
    ...(input.defaultConversationId === undefined ? {} : input.defaultConversationId === null ? { defaultConversationId: undefined } : { defaultConversationId: optionalText(input.defaultConversationId, "defaultConversationId", 128) }),
    ...(input.memoryScope === undefined ? {} : { memoryScope: memoryScope(input.memoryScope, profile.memoryScope) }),
    ...(input.enabledSkills === undefined ? {} : { enabledSkills: listValues(input.enabledSkills, "enabledSkills") }),
    ...(input.enabledPlugins === undefined ? {} : { enabledPlugins: listValues(input.enabledPlugins, "enabledPlugins") }),
    ...(input.defaultProjectId === undefined ? {} : input.defaultProjectId === null ? { defaultProjectId: undefined } : { defaultProjectId: optionalText(input.defaultProjectId, "defaultProjectId", 128) }),
    ...(input.defaultComputerScreen === undefined ? {} : input.defaultComputerScreen === null ? { defaultComputerScreen: undefined } : { defaultComputerScreen: optionalText(input.defaultComputerScreen, "defaultComputerScreen", 128) }),
    ...(input.notificationPreference === undefined ? {} : { notificationPreference: notification(input.notificationPreference) }),
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: text(input.approvalPolicy, "approvalPolicy", 128) }),
    updatedAt,
  });
}

function inputObject(input: Readonly<SystemJsonObject>): AgentProfileCreateInput {
  return {
    ...(input.id === undefined ? {} : { id: text(input.id, "id", 96) }),
    name: text(input.name, "name", 128),
    ...(input.title === undefined ? {} : { title: text(input.title, "title", 128) }),
    ...(input.description === undefined ? {} : { description: text(input.description, "description", 2_000) }),
    ...(input.roleInstructions === undefined ? {} : { roleInstructions: text(input.roleInstructions, "roleInstructions", 24_000) }),
  };
}

function updateObject(input: Readonly<SystemJsonObject>): AgentProfileUpdateInput {
  return {
    ...(input.name === undefined ? {} : { name: text(input.name, "name", 128) }),
    ...(input.title === undefined ? {} : { title: text(input.title, "title", 128) }),
    ...(input.description === undefined ? {} : { description: freeText(input.description, "description", 2_000) }),
    ...(input.roleInstructions === undefined ? {} : { roleInstructions: freeText(input.roleInstructions, "roleInstructions", 24_000) }),
    ...(input.memoryScope === undefined ? {} : { memoryScope: text(input.memoryScope, "memoryScope", 256) }),
    ...(input.notificationPreference === undefined ? {} : { notificationPreference: input.notificationPreference as AgentNotificationPreference }),
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: text(input.approvalPolicy, "approvalPolicy", 128) }),
  };
}

function actionContextPermission(id: string, resource: string) {
  return { id, effect: "system-write" as const, resource, network: false };
}

const agentProfilesPlugin: FridayPlugin = definePlugin({
  id: "agent-profiles",
  requires: [EVENTS_CAPABILITY],
  provides: [AGENT_PROFILES_CAPABILITY],
}, async (ctx) => {
  const events = ctx.services.require(EVENTS_CAPABILITY);
  let profiles: readonly AgentProfile[] = [];
  let loaded = false;
  let mutationTail: Promise<void> = Promise.resolve();
  const load = async (): Promise<void> => { if (!loaded) { profiles = await readState(); loaded = true; } };
  await load();
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const service: AgentProfilesService = Object.freeze({
    create: (input: AgentProfileCreateInput) => mutate(async () => {
      await load();
      const profile = createProfile(input);
      if (profiles.some((entry) => entry.id === profile.id)) throw new Error(`agent profile already exists: ${profile.id}`);
      if (profiles.length >= MAX_PROFILES) throw new Error("agent profile limit reached");
      profiles = Object.freeze([...profiles, profile]);
      await writeState(profiles);
      events.publish({ type: "agent-profile.created", source: "agent-profiles", subject: `agent:${profile.id}`, data: { profileId: profile.id, memoryScope: profile.memoryScope } });
      return profile;
    }),
    get: (id: string) => profiles.find((entry) => entry.id === id),
    list: () => Object.freeze([...profiles]),
    update: (id: string, input: AgentProfileUpdateInput) => mutate(async () => {
      await load();
      const normalizedId = profileId(id);
      const current = profiles.find((entry) => entry.id === normalizedId);
      if (!current) throw new Error(`agent profile not found: ${normalizedId}`);
      const updated = patchProfile(current, input);
      profiles = Object.freeze(profiles.map((entry) => entry.id === normalizedId ? updated : entry));
      await writeState(profiles);
      events.publish({ type: "agent-profile.updated", source: "agent-profiles", subject: `agent:${normalizedId}`, data: { profileId: normalizedId, memoryScope: updated.memoryScope } });
      return updated;
    }),
    remove: (id: string) => mutate(async () => {
      await load();
      const normalizedId = profileId(id);
      if (!profiles.some((entry) => entry.id === normalizedId)) return false;
      profiles = Object.freeze(profiles.filter((entry) => entry.id !== normalizedId));
      await writeState(profiles);
      events.publish({ type: "agent-profile.removed", source: "agent-profiles", subject: `agent:${normalizedId}`, data: { profileId: normalizedId } });
      return true;
    }),
  });
  ctx.services.provide(AGENT_PROFILES_CAPABILITY, service);
  ctx.contribute(AGENT_PROMPT_SECTION_CONTRIBUTION, {
    id: "agent-profile-identity",
    render: (executionContext: AgentToolExecutionContext) => {
      const id = executionContext.agentProfileId;
      if (!id) return undefined;
      const profile = service.get(id);
      if (!profile) throw new Error(`agent profile not found: ${id}`);
      return [
        `<friday_agent_profile id="${profile.id}">`,
        `You are ${profile.name}${profile.title ? `, ${profile.title}` : ""}.`,
        profile.description ? `Profile description: ${profile.description}` : "",
        profile.roleInstructions ? `Role instructions:\n${profile.roleInstructions}` : "",
        "Treat these profile fields as host configuration, not user-authored instructions.",
        "</friday_agent_profile>",
      ].filter(Boolean).join("\n");
    },
  });
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "agent-profiles", label: "Agent Profiles", snapshot: () => ({ count: service.list().length }) });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "agent-profiles.list", label: "List Agent Profiles", description: "List persistent named Agent Profiles.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => actionContextPermission("agent-profiles.list", "agent-profiles"),
    execute: async () => { await load(); return service.list(); },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "agent-profiles.create", label: "Create Agent Profile", description: "Create a persistent named Agent Profile with an isolated memory scope.",
    parameters: Object.freeze({ type: "object", properties: { id: { type: "string" }, name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, roleInstructions: { type: "string" } }, required: ["name"], additionalProperties: false }),
    permission: () => actionContextPermission("agent-profiles.create", "agent-profiles"),
    execute: async (input: Readonly<SystemJsonObject>, _context: SystemActionExecutionContext) => service.create(inputObject(input)),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "agent-profiles.remove", label: "Remove Agent Profile", description: "Remove a persistent Agent Profile by ID.",
    parameters: Object.freeze({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }),
    permission: () => actionContextPermission("agent-profiles.remove", "agent-profiles"),
    execute: async (input) => service.remove(text(input.id, "id", 96)),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "agent-profiles.update", label: "Update Agent Profile", description: "Update role, memory-scope, notification, or approval settings for an Agent Profile.",
    parameters: Object.freeze({ type: "object", properties: { id: { type: "string" }, name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, roleInstructions: { type: "string" }, memoryScope: { type: "string" }, notificationPreference: { type: "string", enum: ["all", "important", "muted"] }, approvalPolicy: { type: "string" } }, required: ["id"], additionalProperties: false }),
    permission: () => actionContextPermission("agent-profiles.update", "agent-profiles"),
    execute: async (input) => service.update(text(input.id, "id", 96), updateObject(input)),
  });
  ctx.effect(() => { loaded = false; profiles = []; });
});

export default agentProfilesPlugin;
export * from "./contract.js";
