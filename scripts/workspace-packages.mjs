#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
export const projectRoot = resolve(dirname(scriptPath), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function globPattern(pattern) {
  const normalized = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
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

function patternSearchRoot(pattern) {
  const normalized = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  const stable = [];
  for (const segment of segments) {
    if (/[*?[]/.test(segment)) break;
    stable.push(segment);
  }
  return stable.join("/") || ".";
}

export function workspaceSearchRoots(root = projectRoot) {
  const rootPackage = readJson(resolve(root, "package.json"));
  const patterns = workspacePatterns(rootPackage);
  const roots = new Set();
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern.trim()) throw new Error("Workspace patterns must be non-empty strings");
    const relativeRoot = patternSearchRoot(pattern.trim());
    const absoluteRoot = resolve(root, relativeRoot);
    if (existsSync(absoluteRoot)) roots.add(relativeRoot);
  }
  return Object.freeze([...roots].sort());
}

function discoverPackageManifests(root, roots) {
  const manifests = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === ".git") continue;
      const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) { visit(child, childRelative); continue; }
      if (entry.isFile() && entry.name === "package.json" && relativeDirectory) manifests.push(`${relativeDirectory}/package.json`);
    }
  };
  for (const scope of roots) {
    const directory = resolve(root, scope);
    if (existsSync(directory)) visit(directory, scope === "." ? "" : scope);
  }
  return manifests;
}

function workspacePatterns(rootPackage) {
  const value = rootPackage.workspaces;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.packages)) return value.packages;
  throw new Error("Root package.json must declare workspaces as an array or workspaces.packages array");
}

export function discoverWorkspacePackages(root = projectRoot) {
  const rootPackage = readJson(resolve(root, "package.json"));
  const patterns = workspacePatterns(rootPackage);
  const matchers = patterns.map((pattern) => {
    if (typeof pattern !== "string" || !pattern.trim()) throw new Error("Workspace patterns must be non-empty strings");
    const normalized = pattern.trim().replaceAll("\\", "/").replace(/\/+$/, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
      throw new Error(`Unsafe workspace pattern: ${pattern}`);
    }
    return globPattern(`${normalized}/package.json`);
  });
  const manifests = discoverPackageManifests(root, workspaceSearchRoots(root))
    .filter((manifest) => matchers.some((matcher) => matcher.test(manifest)));

  const workspaces = manifests.sort().map((manifest) => {
    const absoluteManifest = resolve(root, manifest);
    if (!existsSync(absoluteManifest) || !statSync(absoluteManifest).isFile()) {
      throw new Error(`Workspace manifest is missing: ${manifest}`);
    }
    const pkg = readJson(absoluteManifest);
    if (typeof pkg.name !== "string" || !pkg.name.trim()) throw new Error(`Workspace is missing package name: ${manifest}`);
    return Object.freeze({
      name: pkg.name,
      path: dirname(absoluteManifest),
      relativePath: relative(root, dirname(absoluteManifest)).replaceAll("\\", "/"),
      manifest: Object.freeze(pkg),
    });
  });

  if (workspaces.length === 0) throw new Error("No npm workspaces were discovered");
  const names = new Set();
  for (const workspace of workspaces) {
    if (names.has(workspace.name)) throw new Error(`Duplicate workspace package name: ${workspace.name}`);
    names.add(workspace.name);
  }
  return Object.freeze(workspaces);
}

function localDependencyNames(workspace, names) {
  const manifests = workspace.manifest;
  const dependencyMaps = [
    manifests.dependencies,
    manifests.optionalDependencies,
    manifests.peerDependencies,
    manifests.devDependencies,
  ];
  const dependencies = new Set();
  for (const map of dependencyMaps) {
    if (!map || typeof map !== "object") continue;
    for (const name of Object.keys(map)) if (names.has(name)) dependencies.add(name);
  }
  return dependencies;
}

export function orderWorkspacePackages(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const names = new Set(byName.keys());
  const pending = new Map();
  const dependents = new Map();

  for (const workspace of workspaces) {
    const deps = localDependencyNames(workspace, names);
    pending.set(workspace.name, deps);
    for (const dependency of deps) {
      const list = dependents.get(dependency) ?? [];
      list.push(workspace.name);
      dependents.set(dependency, list);
    }
  }

  const ready = [...workspaces]
    .filter((workspace) => pending.get(workspace.name)?.size === 0)
    .map((workspace) => workspace.name)
    .sort();
  const ordered = [];

  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(byName.get(name));
    for (const dependent of (dependents.get(name) ?? []).sort()) {
      const deps = pending.get(dependent);
      deps.delete(name);
      if (deps.size === 0 && !ready.includes(dependent) && !ordered.some((workspace) => workspace.name === dependent)) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== workspaces.length) {
    const cycle = [...pending.entries()].filter(([, deps]) => deps.size > 0).map(([name, deps]) => `${name} -> ${[...deps].join(", ")}`);
    throw new Error(`Workspace dependency cycle detected: ${cycle.join("; ")}`);
  }
  return Object.freeze(ordered);
}

export function checkWorkspacePackages(root = projectRoot) {
  const workspaces = discoverWorkspacePackages(root);
  const ordered = orderWorkspacePackages(workspaces);
  for (const workspace of ordered) {
    const manifestPath = resolve(workspace.path, "package.json");
    if (!existsSync(manifestPath)) throw new Error(`Workspace package.json disappeared: ${workspace.relativePath}`);
  }
  return ordered;
}

function runScript(script) {
  const ordered = checkWorkspacePackages();
  let count = 0;
  for (const workspace of ordered) {
    if (typeof workspace.manifest.scripts?.[script] !== "string") continue;
    process.stdout.write(`\n==> ${workspace.name} (${workspace.relativePath}) :: ${script}\n`);
    const result = spawnSync("npm", ["run", script, "--workspace", workspace.name], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${workspace.name} ${script} failed with exit code ${result.status ?? "unknown"}`);
    count += 1;
  }
  process.stdout.write(`\nWorkspace ${script}: PASS (${count}/${ordered.length} packages expose the script)\n`);
}

function main() {
  const [command = "check", option] = process.argv.slice(2);
  if (command === "check") {
    const ordered = checkWorkspacePackages();
    process.stdout.write(`Workspace discovery: PASS (${ordered.length} packages)\n`);
    return;
  }
  if (command === "list") {
    const ordered = checkWorkspacePackages();
    if (option === "--json") {
      process.stdout.write(`${JSON.stringify(ordered.map(({ name, relativePath }) => ({ name, path: relativePath })), null, 2)}\n`);
    } else {
      for (const workspace of ordered) process.stdout.write(`${workspace.name}\t${workspace.relativePath}\n`);
    }
    return;
  }
  if (command === "build" || command === "test") {
    runScript(command);
    return;
  }
  throw new Error("Usage: node scripts/workspace-packages.mjs <check|list|build|test> [--json]");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
