#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workspaceSearchRoots } from "./workspace-packages.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const projectRoot = resolve(dirname(scriptPath), "..");
export const BINARY_ASSET_MANIFEST = "friday.binary-assets.json";

function globPattern(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") { expression += ".*"; index += 1; }
      else expression += "[^/]*";
      continue;
    }
    if (char === "?") { expression += "[^/]"; continue; }
    expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function matchesPattern(path, pattern) {
  const normalized = path.replaceAll("\\", "/");
  if (globPattern(pattern).test(normalized)) return true;
  if (pattern.startsWith("**/")) return globPattern(pattern.slice(3)).test(normalized);
  return false;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty relative path`);
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path: ${value}`);
  }
  return normalized;
}

function safeContext(value, label) {
  if (value === undefined) return undefined;
  if (value === ".") return ".";
  return safeRelative(value, label);
}

function safeRole(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)) throw new Error(`Invalid binary asset role: ${value}`);
  return value;
}

function safeGlob(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty glob`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) throw new Error(`${label} must remain relative`);
  return normalized;
}

function manifestFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === ".git") continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) { visit(child); continue; }
      if (entry.isFile() && entry.name === BINARY_ASSET_MANIFEST) files.push(relative(root, child).replaceAll("\\", "/"));
    }
  };
  for (const scope of workspaceSearchRoots(root)) {
    const directory = resolve(root, scope);
    if (existsSync(directory)) visit(directory);
  }
  return files.sort();
}

function walkTree(sourceRoot, targetRoot, excludes, manifestPath, role) {
  const records = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(directory, entry.name);
      const relativeSource = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (excludes.some((pattern) => matchesPattern(relativeSource, pattern))) continue;
      const info = lstatSync(source);
      if (info.isSymbolicLink()) throw new Error(`Binary asset trees refuse symlinks: ${source}`);
      if (entry.isDirectory()) {
        visit(source, relativeSource);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Binary asset trees require regular files: ${source}`);
      records.push(Object.freeze({
        source,
        target: `${targetRoot}/${relativeSource}`.replaceAll("\\", "/"),
        manifestPath,
        ...(role === undefined ? {} : { role }),
      }));
    }
  };
  visit(sourceRoot);
  return records;
}

export function discoverBinaryAssets(root = projectRoot) {
  const assets = [];
  const roles = new Map();
  const targets = new Map();

  for (const relativeManifest of manifestFiles(root)) {
    const manifestPath = resolve(root, relativeManifest);
    const info = lstatSync(manifestPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Binary asset manifest must be a regular file: ${relativeManifest}`);
    const manifest = readJson(manifestPath);
    if (manifest.schema !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw new Error(`Binary asset manifest ${relativeManifest} must use schema 1 with a non-empty assets array`);
    }
    const ownerRoot = dirname(manifestPath);

    for (const [index, raw] of manifest.assets.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${relativeManifest} asset ${index} must be an object`);
      const sourceValue = safeRelative(raw.source, `${relativeManifest} asset ${index} source`);
      const targetValue = safeRelative(raw.target, `${relativeManifest} asset ${index} target`);
      const role = safeRole(raw.role);
      const recursive = raw.recursive === true;
      if (role !== undefined && recursive) throw new Error(`${relativeManifest} asset ${index} roles must identify one file, not a recursive tree`);
      const contextValue = safeContext(raw.context, `${relativeManifest} asset ${index} context`);
      const excludes = raw.exclude === undefined
        ? []
        : Array.isArray(raw.exclude)
          ? raw.exclude.map((pattern, patternIndex) => safeGlob(pattern, `${relativeManifest} asset ${index} exclude ${patternIndex}`))
          : (() => { throw new Error(`${relativeManifest} asset ${index} exclude must be an array`); })();
      const source = resolve(ownerRoot, ...sourceValue.split("/"));
      const context = contextValue === undefined ? undefined : resolve(ownerRoot, ...contextValue.split("/"));
      const sourceRelativeToOwner = relative(ownerRoot, source);
      if (sourceRelativeToOwner.startsWith(`..${sep}`) || sourceRelativeToOwner === "..") throw new Error(`Binary asset source escapes owner: ${sourceValue}`);
      if (!existsSync(source)) throw new Error(`Binary asset source is missing: ${relative(root, source)}`);
      if (context !== undefined) {
        const contextRelativeToOwner = relative(ownerRoot, context);
        if (contextRelativeToOwner.startsWith(`..${sep}`) || contextRelativeToOwner === "..") throw new Error(`Binary asset context escapes owner: ${contextValue}`);
        if (!existsSync(context) || !lstatSync(context).isDirectory()) throw new Error(`Binary asset context must be an existing directory: ${relative(root, context)}`);
      }
      const sourceInfo = lstatSync(source);
      if (sourceInfo.isSymbolicLink()) throw new Error(`Binary asset source may not be a symlink: ${relative(root, source)}`);

      const expanded = recursive
        ? (() => {
            if (!sourceInfo.isDirectory()) throw new Error(`Recursive binary asset source must be a directory: ${relative(root, source)}`);
            return walkTree(source, targetValue, excludes, relativeManifest, role);
          })()
        : (() => {
            if (!sourceInfo.isFile()) throw new Error(`Binary asset source must be a regular file unless recursive=true: ${relative(root, source)}`);
            return [Object.freeze({ source, target: targetValue, manifestPath: relativeManifest, ...(role === undefined ? {} : { role }), ...(context === undefined ? {} : { context }) })];
          })();

      for (const asset of expanded) {
        const priorTarget = targets.get(asset.target);
        if (priorTarget) throw new Error(`Duplicate binary asset target ${asset.target}: ${priorTarget} and ${asset.manifestPath}`);
        targets.set(asset.target, asset.manifestPath);
        assets.push(asset);
      }
      if (role !== undefined) {
        const priorRole = roles.get(role);
        if (priorRole) throw new Error(`Duplicate binary asset role ${role}: ${priorRole} and ${relativeManifest}`);
        roles.set(role, relativeManifest);
      }
    }
  }

  if (assets.length === 0) throw new Error(`No ${BINARY_ASSET_MANIFEST} manifests were discovered`);
  return Object.freeze(assets.sort((left, right) => left.target.localeCompare(right.target)));
}

export function assetByRole(role, root = projectRoot) {
  const matches = discoverBinaryAssets(root).filter((asset) => asset.role === role);
  if (matches.length !== 1) throw new Error(`Expected exactly one binary asset with role ${role}; found ${matches.length}`);
  return matches[0];
}

function main() {
  const [command = "check", option] = process.argv.slice(2);
  const assets = discoverBinaryAssets();
  if (command === "check") {
    process.stdout.write(`Binary asset manifests: PASS (${assets.length} files)\n`);
    return;
  }
  if (command === "list") {
    if (option === "--json") {
      process.stdout.write(`${JSON.stringify(assets.map((asset) => ({
        source: relative(projectRoot, asset.source).replaceAll("\\", "/"),
        target: asset.target,
        manifest: asset.manifestPath,
        ...(asset.role === undefined ? {} : { role: asset.role }),
        ...(asset.context === undefined ? {} : { context: relative(projectRoot, asset.context).replaceAll("\\", "/") }),
      })), null, 2)}\n`);
    } else {
      for (const asset of assets) process.stdout.write(`${asset.target}\t${relative(projectRoot, asset.source)}\n`);
    }
    return;
  }
  throw new Error("Usage: node scripts/binary-assets.mjs <check|list> [--json]");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
