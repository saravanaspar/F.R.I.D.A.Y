import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { getFridayHome } from "./runtime-env.js";

export interface CustomModelRecord {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly api: "openai-completions";
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomModelInput {
  readonly provider: string;
  readonly modelId: string;
  readonly name?: string | undefined;
  readonly baseUrl: string;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export function toCustomModelDescriptor(record: CustomModelRecord) {
  return Object.freeze({
    id: record.modelId,
    name: record.name,
    api: "openai-completions" as const,
    provider: record.provider,
    baseUrl: record.baseUrl,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    featured: true,
  });
}

interface CustomModelState {
  readonly schema: 1;
  readonly models: readonly CustomModelRecord[];
}

const FILE_NAME = "custom-models.json";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function configDir(home = getFridayHome()): string {
  return join(home, "models");
}

export function getCustomModelConfigPath(home = getFridayHome()): string {
  return join(configDir(home), FILE_NAME);
}

async function assertPrivateConfigDir(dir: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Custom model config directory must be a private directory: ${dir}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Custom model config directory permissions are too broad: ${dir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error(`Custom model config directory could not be made private: ${dir}`);
    }
  }
}

function safeId(raw: string, label: string): string {
  const value = raw.trim();
  if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function normalizeCustomProvider(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  const providerName = normalized.startsWith("custom:") ? normalized.slice("custom:".length) : normalized;
  const value = providerName.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) throw new Error("custom provider id is required");
  return `custom:${value}`;
}

export function normalizeCustomModelEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("custom model endpoint must be a valid URL"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("custom model endpoint must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.username || url.password || url.hash) throw new Error("custom model endpoint must not include credentials or fragments");
  return url.toString().replace(/\/$/, "");
}

function parseRecord(value: unknown): CustomModelRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("custom model record is malformed");
  const raw = value as Record<string, unknown>;
  const provider = normalizeCustomProvider(String(raw.provider ?? ""));
  const modelId = safeId(String(raw.modelId ?? ""), "custom model id");
  const name = String(raw.name ?? modelId).trim();
  if (!name || name.length > 240) throw new Error("custom model name is invalid");
  const baseUrl = normalizeCustomModelEndpoint(String(raw.baseUrl ?? ""));
  if (raw.api !== "openai-completions") throw new Error("custom model API is unsupported");
  const contextWindow = Number(raw.contextWindow);
  const maxTokens = Number(raw.maxTokens);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1_024 || contextWindow > 10_000_000) throw new Error("custom model context window is invalid");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("custom model max tokens is invalid");
  const createdAt = String(raw.createdAt ?? "");
  const updatedAt = String(raw.updatedAt ?? "");
  if (!createdAt || !updatedAt) throw new Error("custom model timestamps are invalid");
  return Object.freeze({ provider, modelId, name, baseUrl, api: "openai-completions", contextWindow, maxTokens, createdAt, updatedAt });
}

async function assertPrivate(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Custom model config is not a regular file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Custom model config permissions are too broad: ${path}`);
}

export async function readCustomModels(home = getFridayHome()): Promise<readonly CustomModelRecord[]> {
  const dir = configDir(home);
  await assertPrivateConfigDir(dir, false);
  const path = getCustomModelConfigPath(home);
  let raw: string;
  try {
    await assertPrivate(path);
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error(`Custom model config is corrupt: ${path}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Custom model config is malformed");
  const state = parsed as Record<string, unknown>;
  if (state.schema !== 1 || !Array.isArray(state.models)) throw new Error("Custom model config schema is unsupported");
  const models = state.models.map(parseRecord);
  const keys = new Set<string>();
  for (const model of models) {
    const key = `${model.provider}\0${model.modelId}`;
    if (keys.has(key)) throw new Error(`Duplicate custom model: ${model.provider}/${model.modelId}`);
    keys.add(key);
  }
  return Object.freeze(models);
}

async function saveCustomModels(models: readonly CustomModelRecord[], home = getFridayHome()): Promise<void> {
  const dir = configDir(home);
  const path = getCustomModelConfigPath(home);
  await assertPrivateConfigDir(dir, true);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ schema: 1, models } satisfies CustomModelState, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reportOperationalError({ component: "custom-models", operation: "remove temporary config", error });
      }
    });
  }
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error("Custom model config could not be made private");
}

function customModelRecord(input: CustomModelInput, existing?: CustomModelRecord): CustomModelRecord {
  const provider = normalizeCustomProvider(input.provider);
  const modelId = safeId(input.modelId, "custom model id");
  const name = input.name?.trim() || modelId;
  if (name.length > 240) throw new Error("custom model name is too long");
  const baseUrl = normalizeCustomModelEndpoint(input.baseUrl);
  const contextWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = input.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1_024 || contextWindow > 10_000_000) throw new Error("contextWindow is invalid");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("maxTokens is invalid");
  const now = new Date().toISOString();
  return Object.freeze({
    provider,
    modelId,
    name,
    baseUrl,
    api: "openai-completions",
    contextWindow,
    maxTokens,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/** Validate and materialize a descriptor candidate without registering or persisting it. */
export async function prepareCustomModel(input: CustomModelInput, home = getFridayHome()): Promise<CustomModelRecord> {
  const models = await readCustomModels(home);
  const provider = normalizeCustomProvider(input.provider);
  const modelId = safeId(input.modelId, "custom model id");
  const existing = models.find((entry) => entry.provider === provider && entry.modelId === modelId);
  return customModelRecord(input, existing);
}

export async function upsertCustomModel(input: CustomModelInput, home = getFridayHome()): Promise<CustomModelRecord> {
  const models = [...await readCustomModels(home)];
  const record = customModelRecord(input, models.find((entry) => (
    entry.provider === normalizeCustomProvider(input.provider)
    && entry.modelId === safeId(input.modelId, "custom model id")
  )));
  const index = models.findIndex((entry) => entry.provider === record.provider && entry.modelId === record.modelId);
  if (index >= 0) models[index] = record;
  else models.push(record);
  await saveCustomModels(models, home);
  return record;
}

export async function removeCustomModel(providerInput: string, modelIdInput: string, home = getFridayHome()): Promise<boolean> {
  const provider = normalizeCustomProvider(providerInput);
  const modelId = safeId(modelIdInput, "custom model id");
  const models = [...await readCustomModels(home)];
  const next = models.filter((entry) => !(entry.provider === provider && entry.modelId === modelId));
  if (next.length === models.length) return false;
  await saveCustomModels(next, home);
  return true;
}
