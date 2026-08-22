import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = join(root, "plugins");
const hostRoot = join(root, "src");
const pluginProtocol = join(hostRoot, "plugin.ts");
const retiredHostDomainShims = [
  join(hostRoot, "custom-models.ts"),
  join(hostRoot, "model-credential-ref.ts"),
  join(hostRoot, "runtime-env.ts"),
];
const retiredPseudoPluginPaths = [
  join(pluginsRoot, "operational-errors"),
];

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile() && extname(entry.name) === ".ts") out.push(path);
  }
  return out;
}

function resolveImport(source, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const raw = resolve(dirname(source), specifier);
  return raw.endsWith(".js") ? `${raw.slice(0, -3)}.ts` : raw;
}

const violations = [];

for (const file of retiredHostDomainShims) {
  try {
    await access(file);
    violations.push(`${relative(root, file)} is a retired host/domain compatibility shim`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

for (const path of retiredPseudoPluginPaths) {
  try {
    await access(path);
    violations.push(`${relative(root, path)} is a utility package and must not exist in the plugin graph`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

async function hostDependencyClosure(entries) {
  const pending = [...entries];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    const imports = source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g);
    for (const match of imports) {
      const target = resolveImport(file, match[2]);
      if (!target) continue;
      const pluginRel = relative(pluginsRoot, target);
      const insidePlugins = pluginRel === "" || (pluginRel !== ".." && !pluginRel.startsWith(`..${sep}`));
      if (insidePlugins) {
        violations.push(`${relative(root, file)} -> ${match[2]} (host runtime dependency)`);
        continue;
      }
      const hostRel = relative(hostRoot, target);
      const insideHost = hostRel === "" || (hostRel !== ".." && !hostRel.startsWith(`..${sep}`));
      if (insideHost) pending.push(target);
    }
  }
}

for (const file of await walk(pluginsRoot)) {
  const source = await readFile(file, "utf8");
  const imports = source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g);
  for (const match of imports) {
    const target = resolveImport(file, match[2]);
    if (!target) continue;
    const rel = relative(hostRoot, target);
    const insideHost = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
    if (insideHost && target !== pluginProtocol) {
      violations.push(`${relative(root, file)} -> ${match[2]}`);
    }
  }
}

await hostDependencyClosure([
  join(hostRoot, "bootstrap.ts"),
  join(hostRoot, "runtime.ts"),
]);

if (violations.length > 0) {
  console.error("Architecture boundary violations: plugins may only import src/plugin.ts, and the runtime host may not depend on domain plugins.");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Plugin boundary check: PASS");
}
