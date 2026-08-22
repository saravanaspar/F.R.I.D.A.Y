import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TrustedIdentityRole } from "./contract.js";
import type {
  ChannelIdentitySelector,
  TrustedChannelIdentity,
  TrustChannelIdentityInput,
} from "./trusted-contract.js";

interface TrustedIdentityState {
  readonly schema: 1;
  readonly identities: Record<string, TrustedChannelIdentity>;
}

export const PERMISSIONS_IDENTITIES_FILE_NAME = "trusted_identities.json";

export function getPermissionsStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = environment.FRIDAY_HOME?.trim();
  const root = configuredHome
    ? isAbsolute(configuredHome)
      ? configuredHome
      : resolve(configuredHome)
    : join(homedir(), ".friday");
  return join(root, "permissions");
}

export function getPermissionsIdentitiesPath(stateDir: string): string {
  return join(stateDir, PERMISSIONS_IDENTITIES_FILE_NAME);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedIdentityPart(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new Error(`Invalid trusted identity ${label}`);
  }
  return normalized;
}

function normalizeRole(value: TrustedIdentityRole | undefined): TrustedIdentityRole {
  return value ?? "operator";
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return boundedIdentityPart(value, "label", 128);
}

function normalizeSelector(selector: ChannelIdentitySelector): ChannelIdentitySelector {
  return {
    channel: boundedIdentityPart(selector.channel, "channel", 64),
    accountId: boundedIdentityPart(selector.accountId, "accountId", 128),
    senderId: boundedIdentityPart(selector.senderId, "senderId", 256),
  };
}

export function channelIdentityKey(selector: ChannelIdentitySelector): string {
  const normalized = normalizeSelector(selector);
  return createHash("sha256")
    .update(JSON.stringify([normalized.channel, normalized.accountId, normalized.senderId]))
    .digest("hex");
}

function parseRole(value: unknown): TrustedIdentityRole | undefined {
  return value === "read-only" || value === "operator" ? value : undefined;
}

function parseIdentity(key: string, value: unknown): TrustedChannelIdentity | undefined {
  const record = objectRecord(value);
  const role = parseRole(record?.role);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.channel !== "string" ||
    typeof record.accountId !== "string" ||
    typeof record.senderId !== "string" ||
    !role ||
    typeof record.label !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) return undefined;

  let selector: ChannelIdentitySelector;
  try {
    selector = normalizeSelector({
      channel: record.channel,
      accountId: record.accountId,
      senderId: record.senderId,
    });
  } catch {
    return undefined;
  }
  if (channelIdentityKey(selector) !== key || record.id !== `channel:${key.slice(0, 24)}`) return undefined;

  let label: string;
  try {
    label = normalizeLabel(record.label, selector.senderId);
  } catch {
    return undefined;
  }

  return {
    id: record.id,
    ...selector,
    role,
    label,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

export function loadTrustedIdentities(stateDir: string): readonly TrustedChannelIdentity[] {
  const path = getPermissionsIdentitiesPath(stateDir);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse trusted identity state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectRecord(parsed);
  const rawIdentities = root?.schema === 1 ? objectRecord(root.identities) : undefined;
  if (!rawIdentities) throw new Error("Unsupported or malformed trusted identity state");
  const identities: TrustedChannelIdentity[] = [];
  for (const [key, raw] of Object.entries(rawIdentities)) {
    const identity = parseIdentity(key, raw);
    if (!identity) throw new Error(`Malformed trusted channel identity: ${key}`);
    identities.push(identity);
  }
  return identities.sort((a, b) => a.id.localeCompare(b.id));
}

export function findTrustedIdentity(
  stateDir: string,
  selector: ChannelIdentitySelector,
): TrustedChannelIdentity | undefined {
  const key = channelIdentityKey(selector);
  return loadTrustedIdentities(stateDir).find((identity) => channelIdentityKey(identity) === key);
}

export function saveTrustedIdentities(stateDir: string, identities: readonly TrustedChannelIdentity[]): void {
  const path = getPermissionsIdentitiesPath(stateDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const records = Object.fromEntries(identities.map((identity) => [channelIdentityKey(identity), identity]));
  const state: TrustedIdentityState = { schema: 1, identities: records };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function upsertTrustedIdentity(
  stateDir: string,
  input: TrustChannelIdentityInput,
  now: () => Date = () => new Date(),
): TrustedChannelIdentity {
  const selector = normalizeSelector(input);
  const key = channelIdentityKey(selector);
  const identities = [...loadTrustedIdentities(stateDir)];
  const existingIndex = identities.findIndex((identity) => channelIdentityKey(identity) === key);
  const existing = existingIndex >= 0 ? identities[existingIndex] : undefined;
  const timestamp = now().toISOString();
  const identity: TrustedChannelIdentity = {
    id: `channel:${key.slice(0, 24)}`,
    ...selector,
    role: normalizeRole(input.role),
    label: normalizeLabel(input.label, existing?.label ?? selector.senderId),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (existingIndex >= 0) identities[existingIndex] = identity;
  else identities.push(identity);
  saveTrustedIdentities(stateDir, identities);
  return identity;
}

export function revokeTrustedIdentity(stateDir: string, selector: ChannelIdentitySelector): boolean {
  const key = channelIdentityKey(selector);
  const identities = [...loadTrustedIdentities(stateDir)];
  const next = identities.filter((identity) => channelIdentityKey(identity) !== key);
  if (next.length === identities.length) return false;
  saveTrustedIdentities(stateDir, next);
  return true;
}
