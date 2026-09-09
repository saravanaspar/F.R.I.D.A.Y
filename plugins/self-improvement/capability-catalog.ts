import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const MAX_CONFIGURED_PLUGINS = 128;
const MAX_DETAILED_CONTRACTS = 12;
const MAX_DECLARATION_CHARS = 3_000;
const MAX_PUBLIC_API_CHARS = 6_000;
const MAX_PUBLIC_TYPES = 48;
const MAX_CATALOG_CHARS = 32_000;
const MAX_ISSUES = 32;
const CONTRACTLESS_KERNEL_PLUGINS = new Set(["capabilities"]);

export interface ContractSurfaceBinding {
  readonly kind: "capability" | "contribution" | "hook";
  readonly id: string;
  readonly type: string;
}

export interface CapabilityContractSummary {
  readonly plugin: string;
  readonly path: string;
  readonly capabilities: readonly string[];
  readonly contributions: readonly string[];
  readonly hooks: readonly string[];
  readonly services: readonly string[];
  readonly publicTypes: readonly string[];
  /** Exact public type bound to each callable/extension identifier. */
  readonly surfaces: readonly ContractSurfaceBinding[];
  readonly publicApi?: string | undefined;
}

export interface CapabilityContractCatalog {
  readonly source: "configured-plugin-contracts";
  /** False means reuse discovery was incomplete and code generation must fail closed. */
  readonly complete: boolean;
  readonly issues: readonly string[];
  readonly contracts: readonly CapabilityContractSummary[];
}

interface ConfiguredPluginList {
  readonly names: readonly string[];
  readonly issues: readonly string[];
}

interface PublicInterfaceBlock {
  readonly name: string;
  readonly text: string;
}

function objectiveTerms(objective: string): ReadonlySet<string> {
  return new Set(
    objective
      .toLowerCase()
      .split(/[^a-z0-9._:-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 || /^(ai|db|io|os|ui)$/u.test(term))
      .slice(0, 64),
  );
}

function configuredPluginNames(configSource: string): ConfiguredPluginList {
  const parsed = JSON.parse(configSource) as { plugins?: unknown };
  if (!Array.isArray(parsed.plugins)) {
    return Object.freeze({ names: Object.freeze([]), issues: Object.freeze(["friday.config.json does not contain a plugins array"]) });
  }
  const names: string[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.plugins.slice(0, MAX_CONFIGURED_PLUGINS).entries()) {
    if (typeof entry !== "string") {
      issues.push(`plugins[${index}] is not a string entrypoint`);
      continue;
    }
    const match = /^\.\/plugins\/([A-Za-z0-9._-]+)\/index\.ts$/.exec(entry);
    if (!match) {
      issues.push(`plugins[${index}] is not a supported built-in plugin entrypoint`);
      continue;
    }
    const name = match[1]!;
    if (seen.has(name)) {
      issues.push(`plugin ${name} is configured more than once`);
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  if (parsed.plugins.length > MAX_CONFIGURED_PLUGINS) {
    issues.push(`configured plugin count exceeds the discovery limit of ${MAX_CONFIGURED_PLUGINS}`);
  }
  return Object.freeze({ names: Object.freeze(names), issues: Object.freeze(issues.slice(0, MAX_ISSUES)) });
}

function surfaceBindings(source: string): readonly ContractSurfaceBinding[] {
  const bindings: ContractSurfaceBinding[] = [];
  const seen = new Set<string>();
  const expression = /export\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(?::[^=]{0,240})?=\s*define(Capability|Contribution|Hook)\s*<\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*>\s*\(\s*["']([A-Za-z0-9._:-]+)["']/g;
  for (const match of source.matchAll(expression)) {
    const factory = match[1]!;
    const type = match[2]!.trim();
    const id = match[3]!;
    const kind = factory === "Capability" ? "capability" : factory === "Contribution" ? "contribution" : "hook";
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(Object.freeze({ kind, id, type }));
  }
  return Object.freeze(bindings);
}

function rawSurfaceDefinitionCount(source: string): number {
  return [...source.matchAll(/\bdefine(?:Capability|Contribution|Hook)\s*<\s*[A-Za-z_$][A-Za-z0-9_$]*\s*>\s*\(\s*["'][A-Za-z0-9._:-]+["']/g)].length;
}

function definitionIds(bindings: readonly ContractSurfaceBinding[]): readonly string[] {
  return Object.freeze(bindings.map((binding) => binding.id));
}

function interfaceBlocks(source: string): readonly PublicInterfaceBlock[] {
  const blocks: PublicInterfaceBlock[] = [];
  const expression = /export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b[^\{]*\{/g;
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
    let blockStart = start;
    const commentEnd = source.lastIndexOf("*/", start);
    const commentStart = commentEnd >= 0 ? source.lastIndexOf("/**", commentEnd) : -1;
    if (commentStart >= 0 && commentEnd >= commentStart && source.slice(commentEnd + 2, start).trim() === "") {
      blockStart = commentStart;
    }
    const text = source.slice(blockStart, Math.min(end, source.length)).trim().slice(0, MAX_DECLARATION_CHARS);
    blocks.push(Object.freeze({ name: match[1]!, text }));
  }
  return Object.freeze(blocks);
}

function exportedPublicTypeNames(source: string): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    result.push(name);
  };
  for (const match of source.matchAll(/export\s+(?:interface|type|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/export\s+type\s*\{([\s\S]*?)\}/g)) {
    for (const raw of match[1]!.split(",")) {
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "").trim();
      const alias = /^(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(cleaned);
      if (alias) add(alias[2] ?? alias[1]);
    }
  }
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const raw of match[1]!.split(",")) {
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/g, "").trim();
      const alias = /^type\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/u.exec(cleaned);
      if (alias) add(alias[2] ?? alias[1]);
    }
  }
  return Object.freeze(result);
}

function semanticApiIssues(
  source: string,
  surfaces: readonly ContractSurfaceBinding[],
  publicTypes: readonly string[],
): readonly string[] {
  const issues: string[] = [];
  const exported = new Set(publicTypes);
  const interfaces = new Map(interfaceBlocks(source).map((block) => [block.name, block.text] as const));
  const reachable = new Set(surfaces.map((surface) => surface.type));
  const pending = [...reachable];
  while (pending.length > 0) {
    const name = pending.pop()!;
    const text = interfaces.get(name);
    if (!text) continue;
    for (const match of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
      const referenced = match[0];
      if (!exported.has(referenced) || reachable.has(referenced)) continue;
      reachable.add(referenced);
      pending.push(referenced);
    }
  }
  for (const surface of surfaces) {
    if (!exported.has(surface.type)) issues.push(`${surface.id} binds non-exported type ${surface.type}`);
    if (surface.kind === "capability" && (!surface.type.endsWith("Service") || !interfaces.has(surface.type))) {
      issues.push(`${surface.id} must bind to an exported *Service interface`);
    }
  }
  for (const name of interfaces.keys()) {
    if (!/(?:Service|Contribution|Hook)$/u.test(name)) continue;
    if (!reachable.has(name)) issues.push(`exported semantic API ${name} is not reachable from any public surface`);
  }
  return Object.freeze(issues);
}

function boundedPublicApi(blocks: readonly PublicInterfaceBlock[], terms: ReadonlySet<string>): string {
  const ranked = blocks.map((block, index) => {
    const name = block.name.toLowerCase();
    const text = block.text.toLowerCase();
    let score = block.name.endsWith("Service") ? 2 : 0;
    for (const term of terms) {
      if (name.includes(term)) score += 8;
      if (text.includes(term)) score += 2;
    }
    return { block, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  let result = "";
  for (const { block } of ranked) {
    const next = result ? `${result}\n\n${block.text}` : block.text;
    if (next.length > MAX_PUBLIC_API_CHARS) continue;
    result = next;
  }
  return result;
}

function relevance(
  plugin: string,
  source: string,
  capabilities: readonly string[],
  contributions: readonly string[],
  hooks: readonly string[],
  services: readonly string[],
  publicTypes: readonly string[],
  terms: ReadonlySet<string>,
): number {
  if (terms.size === 0) return 0;
  const identifiers = [...capabilities, ...contributions, ...hooks, ...services, ...publicTypes];
  const haystack = `${plugin}\n${identifiers.join(" ")}\n${source}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (plugin.toLowerCase().includes(term)) score += 8;
    if (capabilities.some((id) => id.toLowerCase().includes(term))) score += 6;
    if (contributions.some((id) => id.toLowerCase().includes(term))) score += 6;
    if (hooks.some((id) => id.toLowerCase().includes(term))) score += 6;
    if (services.some((name) => name.toLowerCase().includes(term))) score += 4;
    if (publicTypes.some((name) => name.toLowerCase().includes(term))) score += 3;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/**
 * Build a bounded, source-derived catalog of ordinary public contracts belonging
 * to configured plugins. Capabilities are callable services; contributions and
 * hooks are typed extension points. Trusted/admin companion contracts and
 * runtime implementation files are intentionally excluded.
 */
export async function buildCapabilityContractCatalog(
  repository: string,
  objective: string,
): Promise<CapabilityContractCatalog> {
  const empty = (issues: readonly string[]): CapabilityContractCatalog => Object.freeze({
    source: "configured-plugin-contracts",
    complete: false,
    issues: Object.freeze([...issues].slice(0, MAX_ISSUES)),
    contracts: Object.freeze([]),
  });

  const root = resolve(repository);
  let canonicalRoot: string;
  let configSource: string;
  try {
    canonicalRoot = await realpath(root);
    const configPath = await realpath(join(canonicalRoot, "friday.config.json"));
    const configRelative = relative(canonicalRoot, configPath);
    if (configRelative === ".." || configRelative.startsWith(`..${sep}`)) {
      return empty(["friday.config.json resolves outside the repository root"]);
    }
    configSource = await readFile(configPath, "utf8");
  } catch {
    return empty(["repository root or friday.config.json could not be read"]);
  }

  let configured: ConfiguredPluginList;
  try {
    configured = configuredPluginNames(configSource);
  } catch {
    return empty(["friday.config.json could not be parsed"]);
  }

  const issues = [...configured.issues];
  const terms = objectiveTerms(objective);
  const candidates: Array<{
    readonly plugin: string;
    readonly path: string;
    readonly capabilities: readonly string[];
    readonly contributions: readonly string[];
    readonly hooks: readonly string[];
    readonly services: readonly string[];
    readonly publicTypes: readonly string[];
    readonly surfaces: readonly ContractSurfaceBinding[];
    readonly publicApi: string;
    readonly score: number;
  }> = [];

  for (const plugin of configured.names) {
    if (CONTRACTLESS_KERNEL_PLUGINS.has(plugin)) continue;
    const relativePath = `plugins/${plugin}/contract.ts`;
    let source: string;
    try {
      const contractPath = await realpath(join(canonicalRoot, relativePath));
      const contractRelative = relative(canonicalRoot, contractPath);
      if (contractRelative === ".." || contractRelative.startsWith(`..${sep}`)) {
        issues.push(`${plugin}: contract.ts resolves outside the repository root`);
        continue;
      }
      source = await readFile(contractPath, "utf8");
    } catch {
      issues.push(`${plugin}: configured plugin contract.ts could not be read`);
      continue;
    }

    const interfaces = interfaceBlocks(source);
    const surfaces = surfaceBindings(source);
    const capabilities = definitionIds(surfaces.filter((surface) => surface.kind === "capability"));
    const contributions = definitionIds(surfaces.filter((surface) => surface.kind === "contribution"));
    const hooks = definitionIds(surfaces.filter((surface) => surface.kind === "hook"));
    const services = Object.freeze(interfaces.map((entry) => entry.name).filter((name) => name.endsWith("Service")));
    const discoveredPublicTypes = exportedPublicTypeNames(source);
    const publicTypes = Object.freeze(discoveredPublicTypes.slice(0, MAX_PUBLIC_TYPES));
    if (surfaces.length !== rawSurfaceDefinitionCount(source)) {
      issues.push(`${plugin}: every ordinary capability/contribution/hook must be an exported const in contract.ts`);
    }
    if (capabilities.length === 0 && contributions.length === 0 && hooks.length === 0) {
      issues.push(`${plugin}: contract.ts exposes no capability, contribution, or hook identifier`);
    }
    if (discoveredPublicTypes.length > MAX_PUBLIC_TYPES) {
      issues.push(`${plugin}: exported public type count exceeds the discovery limit of ${MAX_PUBLIC_TYPES}`);
    }
    for (const issue of semanticApiIssues(source, surfaces, discoveredPublicTypes)) {
      issues.push(`${plugin}: ${issue}`);
    }
    const publicApi = boundedPublicApi(interfaces, terms);
    candidates.push(Object.freeze({
      plugin,
      path: relativePath,
      capabilities,
      contributions,
      hooks,
      services,
      publicTypes,
      surfaces,
      publicApi,
      score: relevance(plugin, source, capabilities, contributions, hooks, services, publicTypes, terms),
    }));
  }

  const configuredOrdinaryCount = configured.names.filter((plugin) => !CONTRACTLESS_KERNEL_PLUGINS.has(plugin)).length;
  if (candidates.length !== configuredOrdinaryCount) {
    issues.push(`discovered ${candidates.length} of ${configuredOrdinaryCount} configured ordinary plugin contracts`);
  }

  const summaries = new Map<string, CapabilityContractSummary>();
  let totalChars = 0;
  for (const candidate of [...candidates].sort((left, right) => left.plugin.localeCompare(right.plugin))) {
    const summary: CapabilityContractSummary = Object.freeze({
      plugin: candidate.plugin,
      path: candidate.path,
      capabilities: candidate.capabilities,
      contributions: candidate.contributions,
      hooks: candidate.hooks,
      services: candidate.services,
      publicTypes: candidate.publicTypes,
      surfaces: candidate.surfaces,
    });
    summaries.set(candidate.plugin, summary);
    totalChars += JSON.stringify(summary).length;
  }

  if (totalChars > MAX_CATALOG_CHARS) {
    issues.push(`base plugin contract catalog exceeds the ${MAX_CATALOG_CHARS}-character bound`);
  } else {
    const detailed = [...candidates]
      .sort((left, right) => right.score - left.score || left.plugin.localeCompare(right.plugin))
      .slice(0, MAX_DETAILED_CONTRACTS);
    for (const candidate of detailed) {
      if (!candidate.publicApi) continue;
      const current = summaries.get(candidate.plugin)!;
      const withApi: CapabilityContractSummary = Object.freeze({ ...current, publicApi: candidate.publicApi });
      const delta = JSON.stringify(withApi).length - JSON.stringify(current).length;
      if (totalChars + delta > MAX_CATALOG_CHARS) continue;
      summaries.set(candidate.plugin, withApi);
      totalChars += delta;
    }
  }

  return Object.freeze({
    source: "configured-plugin-contracts",
    complete: issues.length === 0,
    issues: Object.freeze(issues.slice(0, MAX_ISSUES)),
    contracts: Object.freeze([...summaries.values()].sort((left, right) => left.plugin.localeCompare(right.plugin))),
  });
}
