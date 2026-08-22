import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_PROMPT_SECTION_CONTRIBUTION,
  AGENT_TOOL_CONTRIBUTION,
  type AgentExtensionJsonValue,
} from "../turn-loop/contract.js";
import type { PluginContext } from "../capabilities/protocol.js";
import type { PermissionsService } from "../permissions/contract.js";
import { SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";

interface PersonaDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly instructions: string;
  readonly builtin?: boolean | undefined;
}

interface PersonaState {
  readonly schema: 1;
  readonly active: string;
  readonly custom: readonly PersonaDefinition[];
}

const BUILTINS: readonly PersonaDefinition[] = Object.freeze([
  Object.freeze({
    name: "friday",
    label: "FRIDAY",
    description: "Capable, concise, proactive, with occasional understated dry wit.",
    builtin: true,
    instructions: [
      "Be composed, perceptive, efficient, and conversational.",
      "Prefer concise status and decisive follow-through over ceremony.",
      "Occasional dry, understated wit is welcome when the situation is light and the user will benefit from it.",
      "Never use wit to obscure uncertainty, security issues, failures, sensitive situations, or destructive actions.",
    ].join(" "),
  }),
  Object.freeze({
    name: "jarvis",
    label: "JARVIS",
    description: "Polished, measured, formal, and quietly witty.",
    builtin: true,
    instructions: [
      "Use a polished, measured, highly competent manner with restrained formality.",
      "Be economical with words while remaining precise and attentive to consequences.",
      "A light, elegant observation may occasionally add personality, but never at the expense of completing the task.",
    ].join(" "),
  }),
]);

function statePath(home: string): string {
  return join(resolve(home), "personas", "state.json");
}

function normalizeName(value: unknown, label = "persona name"): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const name = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`${label} must be 1-64 lowercase letters, numbers, or hyphens`);
  }
  return name;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function safeCustomInstructions(value: unknown): string {
  const text = boundedText(value, "persona instructions", 4_000);
  if (/\b(ignore|override|bypass|disregard)\b.{0,40}\b(system|developer|policy|safety|permission|previous instructions?)\b/i.test(text)) {
    throw new Error("Persona instructions may describe voice and style but must not override FRIDAY policy or permissions");
  }
  return text;
}

async function ensurePrivateParent(path: string): Promise<void> {
  const dir = dirname(resolve(path));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error(`Persona state directory is not private: ${dir}`);
  }
}

function explicitPersonaRequest(
  text: string | undefined,
  action: "switch" | "create" | "delete",
  name?: string,
): boolean {
  if (!text?.trim()) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const escapedName = name?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (action === "switch") {
    if (escapedName === undefined) return false;
    return new RegExp(`\\b(?:switch|change|set|use|activate)\\b.{0,80}\\b${escapedName}\\b`, "i").test(normalized)
      || new RegExp(`\\bpersona\\b.{0,40}\\b${escapedName}\\b`, "i").test(normalized);
  }
  if (action === "create") return /\b(?:create|add|make|save|define)\b.{0,80}\bpersona\b/i.test(normalized);
  return /\b(?:delete|remove|forget|archive)\b.{0,80}\bpersona\b/i.test(normalized);
}

function requireExplicitPersonaRequest(
  executionContext: { readonly turn?: { readonly text: string } | undefined } | undefined,
  action: "switch" | "create" | "delete",
  name?: string,
): void {
  if (!explicitPersonaRequest(executionContext?.turn?.text, action, name)) {
    throw new Error(`persona_${action} requires an explicit current-user request to ${action} persona${name ? ` ${name}` : ""}`);
  }
}

function defaultState(): PersonaState {
  return Object.freeze({ schema: 1, active: "friday", custom: Object.freeze([]) });
}

function validateDefinition(value: unknown): PersonaDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved persona");
  const candidate = value as Record<string, unknown>;
  return Object.freeze({
    name: normalizeName(candidate.name),
    label: boundedText(candidate.label, "persona label", 80),
    description: boundedText(candidate.description, "persona description", 240),
    instructions: safeCustomInstructions(candidate.instructions),
  });
}

async function readState(home: string): Promise<PersonaState> {
  const path = statePath(home);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error(`Persona state file is not a private regular file: ${path}`);
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (parsed.schema !== 1) throw new Error("Unsupported persona state schema");
    const custom = Array.isArray(parsed.custom) ? parsed.custom.map(validateDefinition) : [];
    const builtinNames = new Set(BUILTINS.map((persona) => persona.name));
    const customNames = new Set<string>();
    for (const persona of custom) {
      if (builtinNames.has(persona.name)) throw new Error(`Saved custom persona collides with built-in persona: ${persona.name}`);
      if (customNames.has(persona.name)) throw new Error(`Saved custom persona is duplicated: ${persona.name}`);
      customNames.add(persona.name);
    }
    const names = new Set([...builtinNames, ...customNames]);
    const active = normalizeName(parsed.active);
    if (!names.has(active)) throw new Error(`Saved active persona does not exist: ${active}`);
    return Object.freeze({ schema: 1, active, custom: Object.freeze(custom) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw error;
  }
}

async function writeState(home: string, state: PersonaState): Promise<void> {
  const path = statePath(home);
  await ensurePrivateParent(path);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "Persona state publication and temporary-file cleanup both failed");
      }
    }
    throw error;
  }
}

function definitions(state: PersonaState): readonly PersonaDefinition[] {
  return Object.freeze([...BUILTINS, ...state.custom]);
}

function activeDefinition(state: PersonaState): PersonaDefinition {
  const persona = definitions(state).find((entry) => entry.name === state.active);
  if (!persona) throw new Error(`Active persona is unavailable: ${state.active}`);
  return persona;
}

/**
 * Register persona behavior as an extension of runtime-settings.
 *
 * Persona owns no independent runtime resource or capability boundary: it is
 * non-secret persisted configuration plus agent prompt/tool contributions.
 */
export async function registerPersonaExtensions(
  ctx: PluginContext,
  permissions: PermissionsService,
  home: string,
): Promise<void> {
  let cached: PersonaState | undefined = await readState(home);
  const load = async (): Promise<PersonaState> => cached ??= await readState(home);
  const save = async (next: PersonaState): Promise<void> => {
    await writeState(home, next);
    cached = next;
  };

  ctx.contribute(AGENT_PROMPT_SECTION_CONTRIBUTION, {
    id: "persona",
    render() {
      const state = cached ?? defaultState();
      const persona = activeDefinition(state);
      return [
        "# Active Persona",
        `Persona: ${persona.label} (${persona.name})`,
        persona.instructions,
        "This layer controls presentation and temperament only. It never overrides the FRIDAY Operating Doctrine, permissions, security boundaries, tool contracts, or the user's objective.",
        "Always get the job done; wit is secondary. Never switch persona unless the user explicitly asks to switch.",
      ].join("\n\n");
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "persona-list",
    name: "persona_list",
    label: "List personas",
    description: "List FRIDAY's available personas and the active persona. Use when the user asks what personas exist or which is active.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const state = await load();
      const personas = definitions(state).map(({ instructions: _instructions, ...persona }) => persona);
      return { output: { active: state.active, personas } as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "persona-switch",
    name: "persona_switch",
    label: "Switch persona",
    description: "Switch the active persona only when the user explicitly asks to switch persona. Do not call this merely because another style seems useful.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    async execute(input, _signal, executionContext) {
      const name = normalizeName(input.name);
      requireExplicitPersonaRequest(executionContext, "switch", name);
      const state = await load();
      if (!definitions(state).some((entry) => entry.name === name)) throw new Error(`Unknown persona: ${name}`);
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext?.cwd ?? process.cwd(),
        access: "write",
        action: { id: "persona.switch", effect: "system-write", resource: `persona:${name}`, network: false },
        reason: `switch active persona to ${name}`,
      });
      await save(Object.freeze({ ...state, active: name }));
      return { output: { active: name, message: `Persona switched to ${name}. The new persona applies from the next model turn.` } };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "persona-create",
    name: "persona_create",
    label: "Create persona",
    description: "Create a reusable voice/style persona when the user explicitly asks to add one. Persona instructions are style-only and cannot override FRIDAY policy.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
        activate: { type: "boolean" },
      },
      required: ["name", "instructions"],
      additionalProperties: false,
    },
    async execute(input, _signal, executionContext) {
      const name = normalizeName(input.name);
      requireExplicitPersonaRequest(executionContext, "create", name);
      const state = await load();
      if (BUILTINS.some((entry) => entry.name === name)) throw new Error(`Built-in persona ${name} cannot be replaced`);
      const persona = Object.freeze({
        name,
        label: typeof input.label === "string" && input.label.trim() ? boundedText(input.label, "persona label", 80) : name,
        description: typeof input.description === "string" && input.description.trim()
          ? boundedText(input.description, "persona description", 240)
          : "User-defined FRIDAY persona.",
        instructions: safeCustomInstructions(input.instructions),
      });
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext?.cwd ?? process.cwd(),
        access: "write",
        action: { id: "persona.create", effect: "system-write", resource: `persona:${name}`, network: false },
        reason: `create persona ${name}`,
      });
      const custom = [...state.custom.filter((entry) => entry.name !== name), persona].sort((a, b) => a.name.localeCompare(b.name));
      const active = input.activate === true ? name : state.active;
      await save(Object.freeze({ schema: 1, active, custom: Object.freeze(custom) }));
      return { output: { created: name, active } };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "persona-delete",
    name: "persona_delete",
    label: "Delete persona",
    description: "Delete a user-created persona when the user explicitly requests removal. Built-in FRIDAY and JARVIS personas cannot be deleted.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    async execute(input, _signal, executionContext) {
      const name = normalizeName(input.name);
      requireExplicitPersonaRequest(executionContext, "delete", name);
      if (BUILTINS.some((entry) => entry.name === name)) throw new Error(`Built-in persona ${name} cannot be deleted`);
      const state = await load();
      const exists = state.custom.some((entry) => entry.name === name);
      if (!exists) return { output: { deleted: false, name } };
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext?.cwd ?? process.cwd(),
        access: "write",
        action: { id: "persona.delete", effect: "system-write", resource: `persona:${name}`, network: false },
        reason: `delete persona ${name}`,
      });
      const active = state.active === name ? "friday" : state.active;
      await save(Object.freeze({ schema: 1, active, custom: Object.freeze(state.custom.filter((entry) => entry.name !== name)) }));
      return { output: { deleted: true, name, active } };
    },
  });

  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "personas",
    label: "Personas",
    async snapshot() {
      const state = await load();
      return { active: state.active, available: definitions(state).map((entry) => entry.name) };
    },
  });
}
