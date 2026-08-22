import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ConfigurableChannelId =
  | "telegram"
  | "whatsapp"
  | "discord"
  | "slack"
  | "teams"
  | "google-chat"
  | "signal"
  | "email"
  | "sms";

export interface SavedChannelConfig {
  readonly enabled: boolean;
  readonly accountId?: string | undefined;
  readonly allowAll?: boolean | undefined;
  readonly allowedSenderIds?: readonly string[] | undefined;
  readonly allowedConversationIds?: readonly string[] | undefined;
  readonly requireMention?: boolean | undefined;
  readonly settings?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly secretRefs?: Readonly<Record<string, string>> | undefined;
}

export interface SavedChannelsState {
  readonly schema: 1;
  readonly channels: Readonly<Partial<Record<ConfigurableChannelId, SavedChannelConfig>>>;
}

const CHANNEL_IDS = Object.freeze<readonly ConfigurableChannelId[]>([
  "telegram", "whatsapp", "discord", "slack", "teams", "google-chat", "signal", "email", "sms",
]);
const CHANNEL_ID_SET = new Set<string>(CHANNEL_IDS);
const STATE_FILE = "config.json";

function rootDir(home?: string): string {
  if (home?.trim()) return join(resolve(home), "channels");
  const configured = process.env.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "channels");
}

export function getChannelsConfigPath(home?: string): string {
  return join(rootDir(home), STATE_FILE);
}

async function assertPrivateRoot(root: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`FRIDAY channel config directory must be a private directory: ${root}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`FRIDAY channel config directory permissions are too broad: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error(`FRIDAY channel config directory could not be made private: ${root}`);
    }
  }
}

function optionalText(value: unknown, label: string, maximum = 4_096): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maximum || /[\r\n\0]/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function stringList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must be a bounded string list`);
  const values = value.map((item, index) => optionalText(item, `${label}[${index}]`, 512)).filter((item): item is string => Boolean(item));
  return Object.freeze([...new Set(values)]);
}

function scalarRecord(value: unknown, label: string): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const output: Record<string, string | number | boolean> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error(`${label} has too many fields`);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new Error(`${label} contains an invalid key`);
    if (typeof item === "string") output[key] = optionalText(item, `${label}.${key}`, 8_192) ?? "";
    else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else if (typeof item === "boolean") output[key] = item;
    else throw new Error(`${label}.${key} must be a string, number, or boolean`);
  }
  return Object.freeze(output);
}

function secretRefRecord(value: unknown, label: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const scalars = scalarRecord(value, label);
  if (!scalars) return undefined;
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(scalars)) {
    if (typeof item !== "string" || !item.startsWith("vault://")) throw new Error(`${label}.${key} must be a Vault reference`);
    output[key] = item;
  }
  return Object.freeze(output);
}

function parseChannel(value: unknown, id: string): SavedChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`channel config ${id} is malformed`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== "boolean") throw new Error(`channel config ${id}.enabled must be boolean`);
  if (raw.allowAll !== undefined && typeof raw.allowAll !== "boolean") throw new Error(`channel config ${id}.allowAll must be boolean`);
  if (raw.requireMention !== undefined && typeof raw.requireMention !== "boolean") throw new Error(`channel config ${id}.requireMention must be boolean`);
  return Object.freeze({
    enabled: raw.enabled,
    ...(optionalText(raw.accountId, `${id}.accountId`, 256) === undefined ? {} : { accountId: optionalText(raw.accountId, `${id}.accountId`, 256) }),
    ...(raw.allowAll === undefined ? {} : { allowAll: raw.allowAll }),
    ...(stringList(raw.allowedSenderIds, `${id}.allowedSenderIds`) === undefined ? {} : { allowedSenderIds: stringList(raw.allowedSenderIds, `${id}.allowedSenderIds`) }),
    ...(stringList(raw.allowedConversationIds, `${id}.allowedConversationIds`) === undefined ? {} : { allowedConversationIds: stringList(raw.allowedConversationIds, `${id}.allowedConversationIds`) }),
    ...(raw.requireMention === undefined ? {} : { requireMention: raw.requireMention }),
    ...(scalarRecord(raw.settings, `${id}.settings`) === undefined ? {} : { settings: scalarRecord(raw.settings, `${id}.settings`) }),
    ...(secretRefRecord(raw.secretRefs, `${id}.secretRefs`) === undefined ? {} : { secretRefs: secretRefRecord(raw.secretRefs, `${id}.secretRefs`) }),
  });
}

export async function readSavedChannels(home?: string): Promise<SavedChannelsState> {
  const root = rootDir(home);
  await assertPrivateRoot(root, false);
  const path = getChannelsConfigPath(home);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`FRIDAY channel config must be a regular file: ${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`FRIDAY channel config permissions are too broad: ${path}`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FRIDAY channel config is malformed");
    const raw = parsed as Record<string, unknown>;
    if (raw.schema !== 1 || !raw.channels || typeof raw.channels !== "object" || Array.isArray(raw.channels)) {
      throw new Error("FRIDAY channel config schema is unsupported");
    }
    const channels: Partial<Record<ConfigurableChannelId, SavedChannelConfig>> = {};
    for (const [id, value] of Object.entries(raw.channels as Record<string, unknown>)) {
      if (!CHANNEL_ID_SET.has(id)) throw new Error(`Unsupported channel config id: ${id}`);
      channels[id as ConfigurableChannelId] = parseChannel(value, id);
    }
    return Object.freeze({ schema: 1, channels: Object.freeze(channels) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ schema: 1, channels: Object.freeze({}) });
    throw error;
  }
}

export async function saveSavedChannels(
  channels: Readonly<Partial<Record<ConfigurableChannelId, SavedChannelConfig>>>,
  home?: string,
): Promise<string> {
  const normalized: Partial<Record<ConfigurableChannelId, SavedChannelConfig>> = {};
  for (const id of CHANNEL_IDS) {
    const config = channels[id];
    if (config) normalized[id] = parseChannel(config, id);
  }
  const root = rootDir(home);
  const path = getChannelsConfigPath(home);
  await assertPrivateRoot(root, true);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ schema: 1, channels: normalized } satisfies SavedChannelsState, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reportOperationalError({ component: "channels", operation: "remove temporary channel config", error });
      }
    });
  }
  return path;
}

export async function updateSavedChannel(id: ConfigurableChannelId, config: SavedChannelConfig | undefined, home?: string): Promise<SavedChannelsState> {
  const current = await readSavedChannels(home);
  const channels: Partial<Record<ConfigurableChannelId, SavedChannelConfig>> = { ...current.channels };
  if (config === undefined) delete channels[id];
  else channels[id] = parseChannel(config, id);
  await saveSavedChannels(channels, home);
  return Object.freeze({ schema: 1, channels: Object.freeze(channels) });
}
