import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = join(root, "plugins");
const hostRoot = join(root, "src");
const pluginProtocol = join(hostRoot, "plugin.ts");
const configPath = join(root, "friday.config.json");
const contractlessKernelPlugins = new Set(["capabilities"]);
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

function importSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) found.push(match[2]);
  for (const match of source.matchAll(/(?:^|[;\n])\s*import\s+(["'])([^"']+)\1/g)) found.push(match[2]);
  return [...new Set(found)];
}


function exportedPublicTypeNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:interface|type|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s+type\s*\{([\s\S]*?)\}/g)) {
    for (const raw of match[1].split(",")) {
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "").trim();
      if (!cleaned) continue;
      const alias = /^(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(cleaned);
      if (alias) names.add(alias[2] ?? alias[1]);
    }
  }
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const raw of match[1].split(",")) {
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "").trim();
      const alias = /^type\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(cleaned);
      if (alias) names.add(alias[2] ?? alias[1]);
    }
  }
  return names;
}

function exportedInterfaceBlocks(source) {
  const blocks = new Map();
  const expression = /export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b[^\{]*\{/g;
  for (const match of source.matchAll(expression)) {
    const start = match.index;
    if (start === undefined) continue;
    const opening = source.indexOf("{", start);
    if (opening < 0) continue;
    let depth = 0;
    let end = opening;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    blocks.set(match[1], source.slice(start, end));
  }
  return blocks;
}

function exportedDeclarationBlocks(source) {
  const blocks = new Map(exportedInterfaceBlocks(source));
  const braceExpression = /export\s+(?:class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b[^\{]*\{/g;
  for (const match of source.matchAll(braceExpression)) {
    const start = match.index;
    if (start === undefined) continue;
    const opening = source.indexOf("{", start);
    if (opening < 0) continue;
    let depth = 0;
    let end = opening;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    blocks.set(match[1], source.slice(start, end));
  }
  const typeExpression = /export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b[^=]*=/g;
  for (const match of source.matchAll(typeExpression)) {
    const start = match.index;
    if (start === undefined) continue;
    const equal = source.indexOf("=", start);
    if (equal < 0) continue;
    let braces = 0;
    let brackets = 0;
    let parens = 0;
    let end = equal + 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "{") braces += 1;
      else if (char === "}") braces = Math.max(0, braces - 1);
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets = Math.max(0, brackets - 1);
      else if (char === "(") parens += 1;
      else if (char === ")") parens = Math.max(0, parens - 1);
      else if (char === ";" && braces === 0 && brackets === 0 && parens === 0) {
        end += 1;
        break;
      }
    }
    blocks.set(match[1], source.slice(start, end));
  }
  return blocks;
}

function exportedSurfaceDeclarations(source) {
  return [...source.matchAll(/export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]{0,240})?=\s*define(Capability|Contribution|Hook)\s*<\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*>\s*\(\s*["']([A-Za-z0-9._:-]+)["']/g)]
    .map((match) => ({
      constant: match[1],
      factory: match[2],
      type: match[3],
      id: match[4],
      kind: match[2] === "Capability" ? "capability" : match[2] === "Contribution" ? "contribution" : "hook",
    }));
}

function semanticSurfaceReachability(source, publicTypes, surfaces) {
  const declarationBlocks = exportedDeclarationBlocks(source);
  const interfaceBlocks = exportedInterfaceBlocks(source);
  const reachable = new Set(surfaces.map((surface) => surface.type));
  const pending = [...reachable];
  while (pending.length > 0) {
    const name = pending.pop();
    const block = declarationBlocks.get(name);
    if (!block) continue;
    for (const match of block.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
      const referenced = match[0];
      if (!publicTypes.has(referenced) || reachable.has(referenced)) continue;
      reachable.add(referenced);
      pending.push(referenced);
    }
  }
  return { reachable, interfaceBlocks };
}

const violations = [];
const contractCatalog = [];
const definedSurfaceOwners = new Map();

try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!Array.isArray(config.plugins)) {
    violations.push("friday.config.json must contain a plugins array");
  } else {
    const seen = new Set();
    for (const [index, entry] of config.plugins.entries()) {
      if (typeof entry !== "string") {
        violations.push(`friday.config.json plugins[${index}] is not a string`);
        continue;
      }
      const match = /^\.\/plugins\/([A-Za-z0-9._-]+)\/index\.ts$/.exec(entry);
      if (!match) {
        violations.push(`friday.config.json plugins[${index}] is not a supported built-in plugin entrypoint: ${entry}`);
        continue;
      }
      const pluginName = match[1];
      if (seen.has(pluginName)) {
        violations.push(`friday.config.json configures plugin ${pluginName} more than once`);
        continue;
      }
      seen.add(pluginName);
      if (contractlessKernelPlugins.has(pluginName)) continue;
      const entrypointPath = join(pluginsRoot, pluginName, "index.ts");
      let entrypointSource = "";
      try {
        entrypointSource = await readFile(entrypointPath, "utf8");
        const manifestId = /\bdefinePlugin\s*\(\s*\{[\s\S]{0,1600}?\bid\s*:\s*["']([^"']+)["']/.exec(entrypointSource)?.[1];
        if (manifestId !== pluginName) {
          violations.push(`${relative(root, entrypointPath)} must declare plugin id ${pluginName}; found ${manifestId ?? "no static definePlugin id"}`);
        }
      } catch {
        violations.push(`${relative(root, entrypointPath)} could not be read`);
      }
      const contractPath = join(pluginsRoot, pluginName, "contract.ts");
      let contract;
      try {
        contract = await readFile(contractPath, "utf8");
      } catch {
        violations.push(`${relative(root, contractPath)} is required for configured plugin discoverability`);
        continue;
      }
      const exportedPublicTypes = exportedPublicTypeNames(contract);
      const exportedInterfaces = exportedInterfaceBlocks(contract);
      const rawDefinitions = [...contract.matchAll(/\bdefine(Capability|Contribution|Hook)\s*<\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*>\s*\(\s*["']([A-Za-z0-9._:-]+)["']/g)];
      const definitions = exportedSurfaceDeclarations(contract);
      const pluginSurfaces = [];
      if (rawDefinitions.length === 0) {
        violations.push(`${relative(root, contractPath)} exposes no typed capability, contribution, or hook identifier`);
      }
      if (definitions.length !== rawDefinitions.length) {
        violations.push(`${relative(root, contractPath)} contains a capability/contribution/hook definition that is not an exported const; every ordinary public surface must be exported from contract.ts`);
      }
      for (const definition of definitions) {
        const { factory, type: publicType, id, kind: semanticKind, constant } = definition;
        pluginSurfaces.push({ kind: semanticKind, id, type: publicType, constant });
        const definitionKey = `${semanticKind}:${id}`;
        const previousOwner = definedSurfaceOwners.get(definitionKey);
        if (previousOwner !== undefined && previousOwner !== pluginName) {
          violations.push(`${relative(root, contractPath)} redefines ${semanticKind} ${id}; already owned by plugin ${previousOwner}`);
        } else {
          definedSurfaceOwners.set(definitionKey, pluginName);
        }
        if (!exportedPublicTypes.has(publicType)) {
          violations.push(`${relative(root, contractPath)} ${id} references non-exported public type ${publicType}`);
        }
        if (factory === "Capability") {
          if (!publicType.endsWith("Service")) {
            violations.push(`${relative(root, contractPath)} capability ${id} must use an exported *Service interface for semantic API discovery`);
          }
          if (!exportedInterfaces.has(publicType)) {
            violations.push(`${relative(root, contractPath)} capability ${id} must bind to an exported interface; ${publicType} is not an exported interface`);
          }
        }
      }

      const { reachable: reachablePublicTypes } = semanticSurfaceReachability(contract, exportedPublicTypes, pluginSurfaces);
      for (const publicType of exportedInterfaces.keys()) {
        if (!/(?:Service|Contribution|Hook)$/u.test(publicType)) continue;
        if (!reachablePublicTypes.has(publicType)) {
          violations.push(`${relative(root, contractPath)} exports semantic API type ${publicType} but it is not reachable from any defineCapability/defineContribution/defineHook surface`);
        }
      }

      const providesBlock = /\bprovides\s*:\s*\[([\s\S]*?)\]/u.exec(entrypointSource)?.[1] ?? "";
      for (const surface of pluginSurfaces.filter((surface) => surface.kind === "capability")) {
        if (!providesBlock.includes(surface.constant)) {
          violations.push(`${relative(root, entrypointPath)} does not expose ${surface.constant} in manifest provides[]`);
        }
      }

      contractCatalog.push({
        plugin: pluginName,
        surfaces: pluginSurfaces.map(({ kind, id, type }) => ({ kind, id, type })),
        publicTypes: [...exportedPublicTypes].sort((left, right) => left.localeCompare(right)),
        reachablePublicTypes: [...reachablePublicTypes].sort((left, right) => left.localeCompare(right)),
      });
    }
  }
} catch (error) {
  violations.push(`friday.config.json could not be validated for plugin discovery: ${error instanceof Error ? error.message : String(error)}`);
}

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
    for (const specifier of importSpecifiers(source)) {
      const target = resolveImport(file, specifier);
      if (!target) continue;
      const pluginRel = relative(pluginsRoot, target);
      const insidePlugins = pluginRel === "" || (pluginRel !== ".." && !pluginRel.startsWith(`..${sep}`));
      if (insidePlugins) {
        violations.push(`${relative(root, file)} -> ${specifier} (host runtime dependency)`);
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
  const sourcePluginRelative = relative(pluginsRoot, file);
  const sourceOwner = sourcePluginRelative.split(sep)[0];
  const sourceName = sourcePluginRelative.split(sep).at(-1);
  if (sourceOwner !== "capabilities" && sourceName !== "contract.ts" && sourceName !== "trusted-contract.ts"
    && /\bdefine(?:Capability|Contribution|Hook)\s*</u.test(source)) {
    violations.push(`${relative(root, file)} defines a public plugin surface outside contract.ts/trusted-contract.ts`);
  }
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith("@friday/")) {
      const packageOwner = specifier.slice("@friday/".length).split("/")[0];
      if (packageOwner !== "operational-errors" && packageOwner !== sourceOwner) {
        violations.push(`${relative(root, file)} -> ${specifier} (direct sibling plugin package import)`);
      }
    }
    const target = resolveImport(file, specifier);
    if (!target) continue;
    const rel = relative(hostRoot, target);
    const insideHost = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
    if (insideHost && target !== pluginProtocol) {
      violations.push(`${relative(root, file)} -> ${specifier}`);
    }

    const pluginRel = relative(pluginsRoot, target);
    const insidePlugins = pluginRel === "" || (pluginRel !== ".." && !pluginRel.startsWith(`..${sep}`));
    if (!insidePlugins) continue;
    const parts = pluginRel.split(sep);
    if (parts.length < 2) continue; // shared plugin-layer utilities such as principal-scope.ts
    const targetOwner = parts[0];
    if (targetOwner === sourceOwner) continue;
    const targetName = parts.at(-1);
    const publicContract = targetName === "contract.ts" || targetName === "trusted-contract.ts";
    const capabilityProtocol = pluginRel === join("capabilities", "protocol.ts");
    if (!publicContract && !capabilityProtocol) {
      violations.push(`${relative(root, file)} -> ${specifier} (direct sibling plugin implementation import)`);
    }
  }
}

await hostDependencyClosure([
  join(hostRoot, "bootstrap.ts"),
  join(hostRoot, "runtime.ts"),
]);

if (violations.length > 0) {
  console.error("Architecture/discoverability violations: configured plugins must expose typed public contracts, cross-plugin access must use those contracts, and the runtime host must remain domain-neutral.");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  const sortedCatalog = [...contractCatalog].sort((left, right) => left.plugin.localeCompare(right.plugin));
  const rows = sortedCatalog.flatMap((entry) => entry.surfaces.map((surface) => ({ plugin: entry.plugin, ...surface })));
  const publicTypeCount = sortedCatalog.reduce((sum, entry) => sum + entry.publicTypes.length, 0);
  const reachablePublicTypeCount = sortedCatalog.reduce((sum, entry) => sum + entry.reachablePublicTypes.length, 0);
  if (process.argv.includes("--catalog-json")) {
    console.log(JSON.stringify({
      configuredOrdinaryPlugins: sortedCatalog.length,
      typedPublicSurfaces: rows.length,
      exportedPublicTypes: publicTypeCount,
      surfaceReachablePublicTypes: reachablePublicTypeCount,
      plugins: sortedCatalog,
    }, null, 2));
  } else if (process.argv.includes("--catalog")) {
    const widths = {
      plugin: Math.max("PLUGIN".length, ...rows.map((row) => row.plugin.length)),
      kind: Math.max("KIND".length, ...rows.map((row) => row.kind.length)),
      id: Math.max("ID".length, ...rows.map((row) => row.id.length)),
    };
    console.log(`${"PLUGIN".padEnd(widths.plugin)}  ${"KIND".padEnd(widths.kind)}  ${"ID".padEnd(widths.id)}  PUBLIC TYPE`);
    for (const row of rows) {
      console.log(`${row.plugin.padEnd(widths.plugin)}  ${row.kind.padEnd(widths.kind)}  ${row.id.padEnd(widths.id)}  ${row.type}`);
    }
    console.log(`\nConfigured ordinary plugins: ${sortedCatalog.length}; typed public surfaces: ${rows.length}; exported public types: ${publicTypeCount}; surface-reachable public types: ${reachablePublicTypeCount}`);
    console.log("All ordinary surface ids/type bindings are derived automatically from contract.ts; trusted-contract.ts surfaces are intentionally excluded from model/self-improvement discovery.");
  } else {
    console.log("Plugin boundary check: PASS");
  }
}
