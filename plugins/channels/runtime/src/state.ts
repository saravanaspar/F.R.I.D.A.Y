import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_STATE_BYTES = 256 * 1024;

export function channelsStateRoot(): string {
  const configured = process.env.FRIDAY_HOME?.trim();
  const home = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(home, "channels");
}

export function accountStatePath(channel: string, accountId: string, suffix: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/i.test(channel) || !/^[a-z][a-z0-9.-]{0,63}$/i.test(suffix) || suffix.includes("..")) {
    throw new Error("Invalid channel state path component");
  }
  const key = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  return join(channelsStateRoot(), channel, `${key}.${suffix}`);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error(`Channel state directory must be private: ${path}`);
  chmodSync(path, 0o700);
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function readPrivateJson<T>(path: string, maxBytes = MAX_STATE_BYTES): T | undefined {
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0) throw new Error(`Channel state file must be a bounded private regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writePrivateJson(path: string, value: unknown, maxBytes = MAX_STATE_BYTES): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`Channel state exceeds ${maxBytes} bytes`);
  privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    syncPath(temporary);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    syncPath(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function removePrivateJson(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
    syncPath(dirname(path));
  }
}
