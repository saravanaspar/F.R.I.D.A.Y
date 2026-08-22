#!/usr/bin/env -S node --experimental-strip-types
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(scriptRoot, "plugins/model/runtime/src/models.generated.ts");
const providerAliases: Readonly<Record<string, string>> = Object.freeze({
  "azure-openai-responses": "azure",
  fireworks: "fireworks-ai",
  "kimi-coding": "kimi-for-coding",
  "openai-codex": "openai",
  "vercel-ai-gateway": "vercel",
});

interface CatalogModel {
  readonly id?: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly attachment?: boolean;
  readonly modalities?: { readonly input?: readonly string[] };
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly cost?: { readonly input?: number; readonly output?: number; readonly cache_read?: number; readonly cache_write?: number };
}

interface CatalogProvider { readonly models?: Readonly<Record<string, CatalogModel>> }
type Catalog = Readonly<Record<string, CatalogProvider>>;
type GeneratedModel = Record<string, unknown> & {
  id: string; name: string; provider: string; api: string; baseUrl: string;
  reasoning: boolean; input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number; maxTokens: number;
};
type GeneratedCatalog = Record<string, Record<string, GeneratedModel>>;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateModel(provider: string, key: string, model: GeneratedModel): void {
  const label = `${provider}/${key}`;
  if (model.id !== key || model.provider !== provider) throw new Error(`${label} has inconsistent identity`);
  for (const field of ["name", "api", "baseUrl"] as const) {
    if (typeof model[field] !== "string") throw new Error(`${label}.${field} is invalid`);
  }
  if (typeof model.reasoning !== "boolean") throw new Error(`${label}.reasoning is invalid`);
  if (!Array.isArray(model.input) || model.input.length === 0 || model.input.some((value) => value !== "text" && value !== "image")) {
    throw new Error(`${label}.input is invalid`);
  }
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) throw new Error(`${label}.contextWindow is invalid`);
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) throw new Error(`${label}.maxTokens is invalid`);
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!finiteNonNegative(model.cost[field])) throw new Error(`${label}.cost.${field} is invalid`);
  }
}

function validateGenerated(catalog: GeneratedCatalog): void {
  const providers = Object.keys(catalog);
  if (providers.length === 0 || providers.join("\n") !== [...providers].sort().join("\n")) {
    throw new Error("Generated providers must be non-empty and sorted");
  }
  let count = 0;
  for (const provider of providers) {
    const models = catalog[provider]!;
    const ids = Object.keys(models);
    if (ids.length === 0 || ids.join("\n") !== [...ids].sort().join("\n")) {
      throw new Error(`Generated models for ${provider} must be non-empty and sorted`);
    }
    for (const id of ids) { validateModel(provider, id, models[id]!); count += 1; }
  }
  if (count < 100) throw new Error(`Generated model catalog is unexpectedly small (${count})`);
}

async function readCatalog(source: string): Promise<Catalog> {
  let text: string;
  if (/^https:\/\//i.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(source, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error(`model catalog returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) throw new Error("model catalog exceeds the download limit");
      text = await response.text();
    } finally {
      clearTimeout(timer);
    }
  } else {
    const path = isAbsolute(source) ? source : resolve(scriptRoot, source);
    if (statSync(path).size > MAX_CATALOG_BYTES) throw new Error("model catalog exceeds the file-size limit");
    text = readFileSync(path, "utf8");
  }
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error("model catalog exceeds the content limit");
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch (error) {
    throw new Error("model catalog is invalid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model catalog must be an object");
  return parsed as Catalog;
}

function applyCatalog(generated: GeneratedCatalog, source: Catalog): { matched: number; retained: number } {
  let matched = 0;
  let retained = 0;
  for (const [provider, models] of Object.entries(generated)) {
    const catalogProvider = source[providerAliases[provider] ?? provider];
    for (const model of Object.values(models)) {
      const upstream = catalogProvider?.models?.[model.id];
      if (!upstream) { retained += 1; continue; }
      matched += 1;
      if (typeof upstream.name === "string" && upstream.name.trim()) model.name = upstream.name.trim();
      if (typeof upstream.reasoning === "boolean") model.reasoning = upstream.reasoning;
      const modalities = upstream.modalities?.input ?? [];
      model.input = modalities.includes("image") || modalities.includes("pdf") || upstream.attachment === true
        ? ["text", "image"]
        : ["text"];
      if (Number.isSafeInteger(upstream.limit?.context) && upstream.limit!.context! > 0) model.contextWindow = upstream.limit!.context!;
      if (Number.isSafeInteger(upstream.limit?.output) && upstream.limit!.output! > 0) model.maxTokens = upstream.limit!.output!;
      if (finiteNonNegative(upstream.cost?.input)) model.cost.input = upstream.cost.input;
      if (finiteNonNegative(upstream.cost?.output)) model.cost.output = upstream.cost.output;
      if (finiteNonNegative(upstream.cost?.cache_read)) model.cost.cacheRead = upstream.cost.cache_read;
      if (finiteNonNegative(upstream.cost?.cache_write)) model.cost.cacheWrite = upstream.cost.cache_write;
    }
  }
  return { matched, retained };
}

function serialize(catalog: GeneratedCatalog): string {
  const lines = [
    "// This file is auto-generated by scripts/generate-models.ts",
    "// Curated transports/compatibility are retained while models.dev metadata is refreshed.",
    "// Do not edit manually - run 'npm run generate-models' to update",
    "",
    'import type { Model } from "./types.js";',
    "",
    "export const MODELS = {",
  ];
  for (const provider of Object.keys(catalog).sort()) {
    lines.push(`\t${JSON.stringify(provider)}: {`);
    for (const id of Object.keys(catalog[provider]!).sort()) {
      const model = catalog[provider]![id]!;
      const json = JSON.stringify(model, null, "\t").split("\n");
      lines.push(`\t\t${JSON.stringify(id)}: ${json[0]}`);
      lines.push(...json.slice(1, -1).map((line) => `\t\t${line}`));
      lines.push(`\t\t} satisfies Model<${JSON.stringify(model.api)}>,`);
    }
    lines.push("\t},");
  }
  lines.push("} as const;", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const sourceIndex = args.indexOf("--catalog");
  if (sourceIndex >= 0 && !args[sourceIndex + 1]) throw new Error("--catalog requires an HTTPS URL or file path");
  const allowed = new Set(["--check", "--catalog", ...(sourceIndex >= 0 ? [args[sourceIndex + 1]!] : [])]);
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);

  const imported = await import(`${pathToFileURL(outputPath).href}?generator=${randomUUID()}`) as { MODELS?: unknown };
  const generated = structuredClone(imported.MODELS) as GeneratedCatalog;
  validateGenerated(generated);
  if (check) {
    process.stdout.write(`Model catalog is valid (${Object.values(generated).reduce((sum, models) => sum + Object.keys(models).length, 0)} models).\n`);
    return;
  }
  const catalog = await readCatalog(sourceIndex >= 0 ? args[sourceIndex + 1]! : SOURCE_URL);
  const result = applyCatalog(generated, catalog);
  validateGenerated(generated);
  const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, serialize(generated), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o644);
  process.stdout.write(`Updated ${result.matched} model records; retained ${result.retained} curated-only records.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`generate-models: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
