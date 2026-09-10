import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { DEVICES_CAPABILITY, type DeviceDescriptor, type DeviceRecord, type DevicesService, type PairingRequest } from "./contract.js";

interface DeviceState { readonly schema: 1; readonly devices: readonly DeviceRecord[]; }
interface PendingState { readonly schema: 1; readonly pairings: readonly PairingRequest[]; }
const MAX_DEVICES = 64;
const MAX_PENDING = 16;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;

function rootDir(): string {
  const configured = process.env.FRIDAY_HOME?.trim() || process.env.FRIDAY_STATE_DIR?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "devices");
}
function pathFor(name: string): string { return join(rootDir(), name); }
async function privateRoot(create: boolean): Promise<void> {
  const root = rootDir();
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("device state directory must be private");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}
function publicKeyText(value: unknown): string {
  if (typeof value !== "string") throw new Error("device public key must be a string");
  const normalized = value.trim();
  if (!normalized || normalized.length > 16_384 || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) throw new Error("device public key is invalid");
  return normalized;
}
function deviceType(value: unknown): DeviceDescriptor["type"] {
  if (value === "desktop" || value === "android" || value === "computer-node" || value === "test") return value;
  throw new Error("device type is invalid");
}
function parseDevice(value: unknown): DeviceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("device record is malformed");
  const raw = value as Record<string, unknown>;
  const deviceId = text(raw.deviceId, "deviceId", 128);
  const name = text(raw.name, "device name", 128);
  const type = deviceType(raw.type);
  const publicKey = publicKeyText(raw.publicKey);
  const pairedAt = text(raw.pairedAt, "pairedAt", 64);
  const lastSeenAt = raw.lastSeenAt === undefined ? undefined : text(raw.lastSeenAt, "lastSeenAt", 64);
  const revokedAt = raw.revokedAt === undefined ? undefined : text(raw.revokedAt, "revokedAt", 64);
  return Object.freeze({ deviceId, name, type, publicKey, pairedAt, ...(lastSeenAt === undefined ? {} : { lastSeenAt }), ...(revokedAt === undefined ? {} : { revokedAt }) });
}
function parsePairing(value: unknown): PairingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pairing is malformed");
  const raw = value as Record<string, unknown>;
  const device = raw.device;
  if (!device || typeof device !== "object" || Array.isArray(device)) throw new Error("pairing device is malformed");
  const d = device as Record<string, unknown>;
  const descriptor: DeviceDescriptor = Object.freeze({ deviceId: text(d.deviceId, "deviceId", 128), name: text(d.name, "device name", 128), type: deviceType(d.type), publicKey: publicKeyText(d.publicKey) });
  return Object.freeze({ pairingId: text(raw.pairingId, "pairingId", 128), device: descriptor, challenge: text(raw.challenge, "challenge", 512), expiresAt: text(raw.expiresAt, "expiresAt", 64) });
}
async function readJson<T>(name: string, fallback: T, parser: (value: unknown) => T): Promise<T> {
  await privateRoot(false);
  try {
    const info = await lstat(pathFor(name));
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`device state file ${name} is not private`);
    return parser(JSON.parse(await readFile(pathFor(name), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
async function writeJson(name: string, value: unknown): Promise<void> {
  await privateRoot(true);
  const target = pathFor(name);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reportOperationalError({ component: "devices", operation: "remove temporary device state file", error });
      }
    });
  }
}
function parseDeviceState(value: unknown): readonly DeviceRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).schema !== 1 || !Array.isArray((value as Record<string, unknown>).devices)) throw new Error("device state schema is unsupported");
  const devices = (value as Record<string, unknown>).devices as unknown[];
  if (devices.length > MAX_DEVICES) throw new Error("device state exceeds device limit");
  return Object.freeze(devices.map(parseDevice));
}
function parsePendingState(value: unknown): readonly PairingRequest[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).schema !== 1 || !Array.isArray((value as Record<string, unknown>).pairings)) throw new Error("pairing state schema is unsupported");
  const pairings = (value as Record<string, unknown>).pairings as unknown[];
  if (pairings.length > MAX_PENDING) throw new Error("pairing state exceeds pending limit");
  return Object.freeze(pairings.map(parsePairing));
}
function validKey(value: string): void {
  try { createPublicKey(value); } catch { throw new Error("device public key must be a valid public key"); }
}
function ttl(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 30_000 || resolved > 24 * 60 * 60 * 1_000) throw new Error("pairing ttl must be between 30 seconds and 24 hours");
  return resolved;
}

export function createDevicesService(): DevicesService {
  let devices: readonly DeviceRecord[] = [];
  let pairings: readonly PairingRequest[] = [];
  const challenges = new Map<string, { value: string; expiresAt: number }>();
  let loaded = false;
  let mutationTail: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  async function load(): Promise<void> {
    if (loaded) return;
    devices = await readJson("devices.json", Object.freeze([]), parseDeviceState);
    pairings = await readJson("pairings.json", Object.freeze([]), parsePendingState);
    loaded = true;
  }
  async function persist(): Promise<void> {
    await writeJson("devices.json", { schema: 1, devices });
    await writeJson("pairings.json", { schema: 1, pairings });
  }
  const service: DevicesService = Object.freeze({
    beginPairing: (input: DeviceDescriptor, options: { readonly ttlMs?: number | undefined } = {}) => serialize(async () => {
      await load();
      const device: DeviceDescriptor = Object.freeze({ deviceId: text(input.deviceId, "deviceId", 128), name: text(input.name, "device name", 128), type: deviceType(input.type), publicKey: publicKeyText(input.publicKey) });
      validKey(device.publicKey);
      if (devices.some((entry) => entry.deviceId === device.deviceId && entry.revokedAt === undefined)) throw new Error("device is already paired");
      pairings = Object.freeze(pairings.filter((entry) => Date.parse(entry.expiresAt) > Date.now()));
      if (pairings.length >= MAX_PENDING) throw new Error("too many pending pairings");
      const expiresAt = new Date(Date.now() + ttl(options.ttlMs)).toISOString();
      const pairing: PairingRequest = Object.freeze({ pairingId: randomUUID(), device, challenge: randomBytes(32).toString("base64url"), expiresAt });
      pairings = Object.freeze([...pairings, pairing]);
      await persist();
      return pairing;
    }),
    approvePairing: (pairingId: string) => serialize(async () => {
      await load();
      const id = text(pairingId, "pairingId", 128);
      const pairing = pairings.find((entry) => entry.pairingId === id);
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) throw new Error("pairing request is missing or expired");
      if (devices.length >= MAX_DEVICES) throw new Error("device limit reached");
      const record: DeviceRecord = Object.freeze({ ...pairing.device, pairedAt: new Date().toISOString() });
      devices = Object.freeze([...devices.filter((entry) => entry.deviceId !== record.deviceId), record]);
      pairings = Object.freeze(pairings.filter((entry) => entry.pairingId !== id));
      await persist();
      return record;
    }),
    pendingPairings: () => Object.freeze(pairings.filter((entry) => Date.parse(entry.expiresAt) > Date.now()).map((entry) => Object.freeze({ ...entry, device: Object.freeze({ ...entry.device }) }))),
    devices: () => Object.freeze(devices.map((entry) => Object.freeze({ ...entry }))),
    issueChallenge: (deviceId: string) => serialize(async () => {
      await load();
      const id = text(deviceId, "deviceId", 128);
      const device = devices.find((entry) => entry.deviceId === id && entry.revokedAt === undefined);
      if (!device) throw new Error("device is not paired");
      const value = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + 2 * 60 * 1_000;
      challenges.set(id, { value, expiresAt });
      return Object.freeze({ challenge: value, expiresAt: new Date(expiresAt).toISOString() });
    }),
    authenticate: (deviceId: string, challenge: string, signature: string) => serialize(async () => {
      await load();
      const id = text(deviceId, "deviceId", 128);
      const expected = challenges.get(id);
      if (!expected || expected.expiresAt <= Date.now() || expected.value !== text(challenge, "challenge", 512)) throw new Error("device challenge is invalid or expired");
      const device = devices.find((entry) => entry.deviceId === id && entry.revokedAt === undefined);
      if (!device) throw new Error("device is not paired");
      let valid = false;
      try { valid = verify(null, Buffer.from(expected.value), createPublicKey(device.publicKey), Buffer.from(text(signature, "signature", 16_384), "base64url")); } catch { valid = false; }
      if (!valid) throw new Error("device signature is invalid");
      challenges.delete(id);
      const updated: DeviceRecord = Object.freeze({ ...device, lastSeenAt: new Date().toISOString() });
      devices = Object.freeze(devices.map((entry) => entry.deviceId === id ? updated : entry));
      await writeJson("devices.json", { schema: 1, devices });
      return updated;
    }),
    revoke: (deviceId: string) => serialize(async () => {
      await load();
      const id = text(deviceId, "deviceId", 128);
      const device = devices.find((entry) => entry.deviceId === id && entry.revokedAt === undefined);
      if (!device) return false;
      devices = Object.freeze(devices.map((entry) => entry.deviceId === id ? Object.freeze({ ...entry, revokedAt: new Date().toISOString() }) : entry));
      challenges.delete(id);
      await writeJson("devices.json", { schema: 1, devices });
      return true;
    }),
  });
  return service;
}

const devicesPlugin: FridayPlugin = definePlugin({ id: "devices", provides: [DEVICES_CAPABILITY] }, (ctx) => {
  const service = createDevicesService();
  ctx.services.provide(DEVICES_CAPABILITY, service);
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "devices", label: "Devices", snapshot: () => ({ paired: service.devices().filter((device) => device.revokedAt === undefined).length, pending: service.pendingPairings().length }) });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "devices.list", label: "List paired devices", description: "List paired client and Computer Node identities without exposing private keys.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => ({ id: "devices.list", effect: "global-operational-read", resource: "devices", network: false }),
    execute: () => service.devices().map(({ deviceId, name, type, pairedAt, lastSeenAt, revokedAt }) => ({ deviceId, name, type, pairedAt, ...(lastSeenAt === undefined ? {} : { lastSeenAt }), ...(revokedAt === undefined ? {} : { revokedAt }) })),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "devices.pairings", label: "List pending pairings", description: "List pending device pairing requests so a trusted operator can approve one.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => ({ id: "devices.pairings", effect: "global-operational-read", resource: "devices:pairings", network: false }),
    execute: () => service.pendingPairings().map((pairing) => ({ pairingId: pairing.pairingId, device: { deviceId: pairing.device.deviceId, name: pairing.device.name, type: pairing.device.type }, challenge: pairing.challenge, expiresAt: pairing.expiresAt })),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "devices.approve-pairing", label: "Approve device pairing", description: "Approve one pending pairing request from a trusted operator context.",
    parameters: Object.freeze({ type: "object", properties: { pairingId: { type: "string" } }, required: ["pairingId"], additionalProperties: false }),
    permission: () => ({ id: "devices.approve-pairing", effect: "system-write", resource: "devices:pairing", network: false }),
    execute: async (input) => service.approvePairing(text(input.pairingId, "pairingId", 128)),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "devices.revoke", label: "Revoke device", description: "Revoke a paired device and invalidate future authentication challenges.",
    parameters: Object.freeze({ type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"], additionalProperties: false }),
    permission: () => ({ id: "devices.revoke", effect: "system-write", resource: "devices:identity", network: false }),
    execute: async (input) => ({ revoked: await service.revoke(text(input.deviceId, "deviceId", 128)) }),
  });
});

export default devicesPlugin;
export * from "./contract.js";
