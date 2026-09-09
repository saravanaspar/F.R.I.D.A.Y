import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { normalizeVoiceSettings, type VoiceSettings } from "@friday/voice";
import { voiceFridayHome } from "./paths.js";

const SETTINGS_FILE = "settings.json";

function voiceRoot(home = voiceFridayHome()): string {
  return join(resolve(home), "voice");
}

export function getVoiceSettingsPath(home = voiceFridayHome()): string {
  return join(voiceRoot(home), SETTINGS_FILE);
}

async function ensurePrivateDirectory(path: string, create: boolean): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Voice settings root must be a private directory: ${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Voice settings root permissions are too broad: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error(`Voice settings root could not be made private: ${path}`);
    }
    return true;
  }
}

export async function readVoiceSettings(home = voiceFridayHome()): Promise<VoiceSettings | undefined> {
  const root = voiceRoot(home);
  if (!(await ensurePrivateDirectory(root, false))) return undefined;
  const path = getVoiceSettingsPath(home);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Voice settings must be a regular file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Voice settings permissions are too broad: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse voice settings: ${path}`, { cause: error });
  }
  return normalizeVoiceSettings(parsed);
}

export async function saveVoiceSettings(settings: VoiceSettings, home = voiceFridayHome()): Promise<VoiceSettings> {
  const normalized = normalizeVoiceSettings(settings);
  const root = voiceRoot(home);
  await ensurePrivateDirectory(root, true);
  const path = getVoiceSettingsPath(home);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`Voice settings must be a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = join(root, `.settings.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    try { await unlink(tmp); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanupError], "Voice settings publication and cleanup both failed");
    }
    throw error;
  }
  return normalized;
}
