import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const PLUGIN_API_VERSION = "1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface InstalledPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: "1";
  readonly entrypoint: string;
  readonly builtIn: boolean;
  readonly enabled: boolean;
}

interface PackageManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: "1";
  readonly entrypoint: string;
}

export function pluginHome(): string {
  return resolve(process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin metadata must be an object");
  return value as Record<string, unknown>;
}

function parseManifest(raw: unknown): PackageManifest {
  const manifest = object(raw);
  if (typeof manifest.id !== "string" || !ID.test(manifest.id)) throw new Error("plugin id is invalid");
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 128) throw new Error("plugin name is invalid");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(manifest.version)) throw new Error("plugin version is invalid");
  if (manifest.apiVersion !== PLUGIN_API_VERSION) throw new Error(`unsupported plugin API version: ${String(manifest.apiVersion)}`);
  if (typeof manifest.entrypoint !== "string" || !/^\.\/[^\\]+\.m?js$/u.test(manifest.entrypoint)) throw new Error("plugin entrypoint must be a relative .js or .mjs file");
  return { id: manifest.id, name: manifest.name.trim(), version: manifest.version, apiVersion: "1", entrypoint: manifest.entrypoint };
}

async function packageAt(root: string): Promise<PackageManifest & { readonly entrypointPath: string }> {
  const dir = await lstat(root);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error(`plugin package must be a directory: ${root}`);
  const manifestPath = join(root, "manifest.json");
  const file = await lstat(manifestPath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`plugin manifest must be a regular file: ${root}`);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const target = resolve(root, manifest.entrypoint);
  if (!isInside(root, target)) throw new Error(`plugin entrypoint escapes its package: ${manifest.id}`);
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (!isInside(canonicalRoot, canonicalTarget) || !(await lstat(target)).isFile()) {
    throw new Error(`plugin entrypoint escapes its package or is not a file: ${manifest.id}`);
  }
  return { ...manifest, entrypointPath: target };
}

async function overrides(home: string): Promise<Record<string, boolean>> {
  let raw: string;
  try { raw = await readFile(join(home, "plugin-state.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const state = object(JSON.parse(raw) as unknown);
  if (state.version !== 1) throw new Error("unsupported plugin state version");
  const entries = object(state.enabled);
  const result: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(entries)) {
    if (!ID.test(id) || typeof enabled !== "boolean") throw new Error("plugin state contains an invalid enablement");
    result[id] = enabled;
  }
  return result;
}

export async function discoverPlugins(configured: readonly string[], home = pluginHome()): Promise<readonly InstalledPlugin[]> {
  const enabled = await overrides(home);
  const plugins: InstalledPlugin[] = configured.map((entrypoint) => {
    const match = /^\.\/plugins\/([A-Za-z0-9._-]+)\/index\.ts$/u.exec(entrypoint);
    // Legacy source configs can still contain explicit non-built-in module specifiers.
    const id = match?.[1] ?? entrypoint;
    return { id, name: id, version: "bundled", apiVersion: "1", entrypoint, builtIn: Boolean(match), enabled: enabled[id] ?? true };
  });
  const seen = new Set(plugins.map((plugin) => plugin.id));
  const root = join(home, "plugins");
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return plugins;
    throw error;
  }
  for (const dir of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory() || dir.isSymbolicLink() || !ID.test(dir.name)) throw new Error(`invalid plugin package directory: ${dir.name}`);
    const manifest = await packageAt(join(root, dir.name));
    if (manifest.id !== dir.name || seen.has(manifest.id)) throw new Error(`duplicate or mismatched plugin id: ${manifest.id}`);
    seen.add(manifest.id);
    plugins.push({ ...manifest, entrypoint: manifest.entrypointPath, builtIn: false, enabled: enabled[manifest.id] ?? true });
  }
  for (const id of Object.keys(enabled)) {
    if (!seen.has(id)) throw new Error(`plugin state refers to an uninstalled plugin: ${id}`);
  }
  return plugins;
}

export async function setPluginEnabled(id: string, value: boolean, configured: readonly string[], home = pluginHome()): Promise<void> {
  if (!ID.test(id)) throw new Error("only installed package ids and built-in plugin ids can be toggled");
  const plugins = await discoverPlugins(configured, home);
  const plugin = plugins.find((entry) => entry.id === id);
  if (!plugin) throw new Error(`plugin is not installed: ${id}`);
  if (id === "capabilities" && !value) throw new Error("the capability kernel cannot be disabled");
  const state = { ...(await overrides(home)), [id]: value };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, "plugin-state.json");
  const temporary = join(home, `.plugin-state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, enabled: state }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function installPlugin(source: string, configured: readonly string[], home = pluginHome()): Promise<InstalledPlugin> {
  const root = resolve(source);
  const manifest = await packageAt(root);
  if ((await discoverPlugins(configured, home)).some((plugin) => plugin.id === manifest.id)) throw new Error(`plugin is already installed: ${manifest.id}`);
  const targetRoot = join(home, "plugins");
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const target = join(targetRoot, manifest.id);
  const temporary = join(targetRoot, `.install-${randomUUID()}`);
  try {
    await cp(root, temporary, {
      recursive: true,
      filter: async (path) => {
        const info = await lstat(path);
        if (!info.isFile() && !info.isDirectory()) throw new Error(`plugin package contains a link or special file: ${path}`);
        return true;
      },
    });
    await packageAt(temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { ...manifest, entrypoint: join(target, relative(root, manifest.entrypointPath)), builtIn: false, enabled: true };
}
