import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const MAX_CONFIGURED_PLUGINS = 128;
const MAX_DETAILED_CONTRACTS = 12;
const MAX_INTERFACE_CHARS = 3_000;
const MAX_CATALOG_CHARS = 24_000;

export interface CapabilityContractSummary {
  readonly plugin: string;
  readonly path: string;
  readonly capabilities: readonly string[];
  readonly services: readonly string[];
  readonly publicApi?: string | undefined;
}

export interface CapabilityContractCatalog {
  readonly source: "configured-plugin-contracts";
  readonly contracts: readonly CapabilityContractSummary[];
}

function objectiveTerms(objective: string): ReadonlySet<string> {
  return new Set(
    objective
      .toLowerCase()
      .split(/[^a-z0-9._:-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .slice(0, 64),
  );
}

function configuredPluginNames(configSource: string): readonly string[] {
  const parsed = JSON.parse(configSource) as { plugins?: unknown };
  if (!Array.isArray(parsed.plugins)) return Object.freeze([]);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.plugins.slice(0, MAX_CONFIGURED_PLUGINS)) {
    if (typeof entry !== "string") continue;
    const match = /^\.\/plugins\/([A-Za-z0-9._-]+)\/index\.ts$/.exec(entry);
    if (!match) continue;
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return Object.freeze(names);
}

function capabilityIds(source: string): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const expression = /defineCapability(?:<[^>\n]+>)?\(\s*["']([A-Za-z0-9._:-]+)["']\s*\)/g;
  for (const match of source.matchAll(expression)) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

function interfaceBlocks(source: string): readonly { readonly name: string; readonly text: string }[] {
  const blocks: Array<{ readonly name: string; readonly text: string }> = [];
  const expression = /export\s+interface\s+([A-Za-z0-9_]+Service)\b[^\{]*\{/g;
  for (const match of source.matchAll(expression)) {
    const start = match.index;
    if (start === undefined) continue;
    const opening = source.indexOf("{", start);
    if (opening < 0) continue;
    let depth = 0;
    let end = opening;
    for (; end < source.length; end += 1) {
      const char = source[end]!;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    const text = source.slice(start, Math.min(end, source.length)).trim().slice(0, MAX_INTERFACE_CHARS);
    blocks.push(Object.freeze({ name: match[1]!, text }));
  }
  return Object.freeze(blocks);
}

function relevance(
  plugin: string,
  source: string,
  capabilities: readonly string[],
  services: readonly string[],
  terms: ReadonlySet<string>,
): number {
  if (terms.size === 0) return 0;
  const haystack = `${plugin}\n${capabilities.join(" ")}\n${services.join(" ")}\n${source}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (plugin.toLowerCase().includes(term)) score += 8;
    if (capabilities.some((id) => id.toLowerCase().includes(term))) score += 6;
    if (services.some((name) => name.toLowerCase().includes(term))) score += 4;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/**
 * Build a bounded, source-derived catalog of the public contracts belonging to
 * configured plugins. This is intentionally read-only and never scans runtime/
 * implementation files: self-improvement must consider public reuse before code.
 */
export async function buildCapabilityContractCatalog(
  repository: string,
  objective: string,
): Promise<CapabilityContractCatalog> {
  const root = resolve(repository);
  let canonicalRoot: string;
  let configSource: string;
  try {
    canonicalRoot = await realpath(root);
    const configPath = await realpath(join(canonicalRoot, "friday.config.json"));
    const configRelative = relative(canonicalRoot, configPath);
    if (configRelative === ".." || configRelative.startsWith(`..${sep}`)) {
      return Object.freeze({ source: "configured-plugin-contracts", contracts: Object.freeze([]) });
    }
    configSource = await readFile(configPath, "utf8");
  } catch {
    return Object.freeze({ source: "configured-plugin-contracts", contracts: Object.freeze([]) });
  }

  let pluginNames: readonly string[];
  try {
    pluginNames = configuredPluginNames(configSource);
  } catch {
    return Object.freeze({ source: "configured-plugin-contracts", contracts: Object.freeze([]) });
  }

  const terms = objectiveTerms(objective);
  const candidates: Array<{
    readonly plugin: string;
    readonly path: string;
    readonly capabilities: readonly string[];
    readonly services: readonly string[];
    readonly publicApi: string;
    readonly score: number;
  }> = [];

  for (const plugin of pluginNames) {
    const relativePath = `plugins/${plugin}/contract.ts`;
    let source: string;
    try {
      const contractPath = await realpath(join(canonicalRoot, relativePath));
      const contractRelative = relative(canonicalRoot, contractPath);
      if (contractRelative === ".." || contractRelative.startsWith(`..${sep}`)) continue;
      source = await readFile(contractPath, "utf8");
    } catch {
      continue;
    }
    const interfaces = interfaceBlocks(source);
    const capabilities = capabilityIds(source);
    const services = Object.freeze(interfaces.map((entry) => entry.name));
    const publicApi = interfaces.map((entry) => entry.text).join("\n\n");
    candidates.push(Object.freeze({
      plugin,
      path: relativePath,
      capabilities,
      services,
      publicApi,
      score: relevance(plugin, source, capabilities, services, terms),
    }));
  }

  const detailPlugins = new Set(
    [...candidates]
      .sort((left, right) => right.score - left.score || left.plugin.localeCompare(right.plugin))
      .slice(0, MAX_DETAILED_CONTRACTS)
      .map((entry) => entry.plugin),
  );

  const contracts: CapabilityContractSummary[] = [];
  let totalChars = 0;
  for (const candidate of candidates.sort((left, right) => left.plugin.localeCompare(right.plugin))) {
    const detailed = detailPlugins.has(candidate.plugin) && candidate.publicApi.length > 0;
    const summary: CapabilityContractSummary = Object.freeze({
      plugin: candidate.plugin,
      path: candidate.path,
      capabilities: candidate.capabilities,
      services: candidate.services,
      ...(detailed ? { publicApi: candidate.publicApi } : {}),
    });
    const serialized = JSON.stringify(summary);
    if (totalChars + serialized.length > MAX_CATALOG_CHARS) break;
    contracts.push(summary);
    totalChars += serialized.length;
  }

  return Object.freeze({
    source: "configured-plugin-contracts",
    contracts: Object.freeze(contracts),
  });
}
