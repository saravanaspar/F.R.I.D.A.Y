import type { McpDiscoveryCandidate, McpRegistryPackageDescriptor, McpRegistryRemoteEndpoint } from "./contract.js";

const REGISTRY_ENDPOINT = "https://registry.modelcontextprotocol.io/v0.1/servers";
const MAX_QUERY_CHARS = 160;
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_CANDIDATES = 10;
const REGISTRY_TIMEOUT_MS = 12_000;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\r\n\0]+/g, " ");
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const raw = boundedString(value, 2_048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseRemotes(value: unknown): readonly McpRegistryRemoteEndpoint[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const remotes: McpRegistryRemoteEndpoint[] = [];
  for (const raw of value.slice(0, 16)) {
    const entry = objectRecord(raw);
    if (!entry) continue;
    const type = boundedString(entry.type, 64)?.toLowerCase();
    const url = safeHttpsUrl(entry.url);
    if (!url || !type) continue;
    remotes.push(Object.freeze({ type, url }));
  }
  return Object.freeze(remotes);
}

function parsePackages(value: unknown): readonly McpRegistryPackageDescriptor[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const packages: McpRegistryPackageDescriptor[] = [];
  for (const raw of value.slice(0, 16)) {
    const entry = objectRecord(raw);
    if (!entry) continue;
    const registryType = boundedString(entry.registryType, 32);
    const identifier = boundedString(entry.identifier, 256);
    const version = boundedString(entry.version, 96);
    const transport = objectRecord(entry.transport);
    const transportType = boundedString(transport?.type, 64);
    if (!registryType || !identifier) continue;
    packages.push(Object.freeze({
      registryType,
      identifier,
      ...(version === undefined ? {} : { version }),
      ...(transportType === undefined ? {} : { transportType }),
    }));
  }
  return Object.freeze(packages);
}

function parseCandidate(value: unknown): McpDiscoveryCandidate | undefined {
  const envelope = objectRecord(value);
  const server = objectRecord(envelope?.server) ?? envelope;
  if (!server) return undefined;
  const name = boundedString(server.name, 240);
  const version = boundedString(server.version, 96);
  if (!name || !version) return undefined;
  const description = boundedString(server.description, 2_000);
  const title = boundedString(server.title, 240);
  const repository = objectRecord(server.repository);
  const repositoryUrl = safeHttpsUrl(repository?.url);
  const remotes = parseRemotes(server.remotes);
  const packages = parsePackages(server.packages);
  return Object.freeze({
    name,
    version,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    remotes,
    packages,
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_REGISTRY_BYTES) throw new Error("MCP Registry response exceeds FRIDAY discovery limit");
  if (!response.body) throw new Error("MCP Registry returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REGISTRY_BYTES) {
        const limitError = new Error("MCP Registry response exceeds FRIDAY discovery limit");
        try {
          await reader.cancel();
        } catch (cancelError) {
          throw new AggregateError([limitError, cancelError], "MCP Registry response exceeded the discovery limit and stream cancellation failed");
        }
        throw limitError;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("MCP Registry returned malformed JSON", { cause: error });
  }
}

export async function searchMcpRegistry(
  queryInput: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<readonly McpDiscoveryCandidate[]> {
  const query = queryInput.trim().replace(/[\r\n\0]+/g, " ");
  if (!query || query.length > MAX_QUERY_CHARS) throw new Error(`MCP Registry query must contain 1-${MAX_QUERY_CHARS} characters`);
  const url = new URL(REGISTRY_ENDPOINT);
  url.searchParams.set("search", query);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(MAX_CANDIDATES));
  const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "FRIDAY-MCP-Discovery/1" },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) throw new Error(`MCP Registry search failed with HTTP ${response.status}`);
  const parsed = objectRecord(await readBoundedJson(response));
  const servers = Array.isArray(parsed?.servers) ? parsed.servers : undefined;
  if (!servers) throw new Error("MCP Registry response is missing servers[]");
  const candidates = servers.map(parseCandidate).filter((entry): entry is McpDiscoveryCandidate => entry !== undefined).slice(0, MAX_CANDIDATES);
  return Object.freeze(candidates);
}
