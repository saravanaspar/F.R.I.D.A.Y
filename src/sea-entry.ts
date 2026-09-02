import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolveFridayActiveExecutable } from "@friday/lifecycle";
import { chmod, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getAsset, getAssetKeys, isSea } from "node:sea";

declare const __FRIDAY_BINARY_BUILD_ID__: string;

function safeRelative(asset: string): string {
  const prefix = "runtime/";
  if (!asset.startsWith(prefix)) throw new Error(`Unexpected embedded asset: ${asset}`);
  const value = asset.slice(prefix.length);
  if (!value || isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe embedded asset path: ${asset}`);
  }
  return value.split("/").join(sep);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`Bundled runtime directory is not private: ${path}`);
  }
}

async function delegateToActiveExecutable(): Promise<boolean> {
  if (!isSea() || process.env.FRIDAY_LIFECYCLE_EXPLICIT_EXECUTABLE === "1") return false;
  let active;
  try {
    active = resolveFridayActiveExecutable(process.env);
  } catch (error) {
    process.stderr.write(`friday: ignored invalid self-update pointer: ${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
  if (!active) return false;
  let current: string;
  try { current = realpathSync(process.execPath); } catch { current = resolve(process.execPath); }
  if (active.path === current) return false;

  await new Promise<void>((resolveChild, rejectChild) => {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete childEnvironment.FRIDAY_LIFECYCLE_EXPLICIT_EXECUTABLE;
    const child = spawn(active.path, process.argv.slice(2), {
      stdio: "inherit",
      env: childEnvironment,
      windowsHide: false,
    });
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      rejectChild(error);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (signal) process.stderr.write(`friday: active self-updated binary exited by ${signal}\n`);
      process.exitCode = code ?? 1;
      resolveChild();
    });
  });
  return true;
}


async function cleanupOldBundles(runtimeRoot: string, currentRoot: string): Promise<void> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("bundle-") || !entry.isDirectory()) continue;
    const path = join(runtimeRoot, entry.name);
    if (resolve(path) === resolve(currentRoot)) continue;
    const info = await stat(path);
    candidates.push({ path, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of candidates.slice(2)) {
    await rm(stale.path, { recursive: true, force: true });
  }
}

async function extractAssets(): Promise<void> {
  if (!isSea()) return;
  const configured = process.env.FRIDAY_HOME?.trim();
  const home = configured ? resolve(configured) : join(homedir(), ".friday");
  const buildId = __FRIDAY_BINARY_BUILD_ID__.replace(/[^A-Za-z0-9._-]/g, "");
  if (!buildId) throw new Error("FRIDAY binary build id is invalid");
  const runtimeRoot = join(home, ".runtime");
  const root = join(runtimeRoot, `bundle-${buildId}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await assertPrivateDirectory(root);

  for (const key of getAssetKeys().filter((value) => value.startsWith("runtime/")).sort()) {
    const target = join(root, safeRelative(key));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(getAsset(key));
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await rename(temp, target);
    await chmod(target, 0o600);
  }
  await cleanupOldBundles(runtimeRoot, root);
  process.env.FRIDAY_BUNDLED_ROOT = root;
  process.env.FRIDAY_SINGLE_BINARY = "1";
}

async function main(): Promise<void> {
  if (await delegateToActiveExecutable()) return;
  await extractAssets();
  const [{ installBundledPlugins }, { BUILTIN_PLUGINS }, { runFridayCli }] = await Promise.all([
    import("./bootstrap.js"),
    import("./builtin-plugins.js"),
    import("./friday.js"),
  ]);
  installBundledPlugins(BUILTIN_PLUGINS);
  await runFridayCli();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`friday: ${message}\n`);
  process.exitCode = 1;
});
