import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { RefinementResult } from "@friday/refinement";

interface RefinementHistoryState {
  readonly schema: 1;
  readonly results: readonly RefinementResult[];
}

const FILE_NAME = "history.json";
const MAX_RESULTS = 500;

function rootDir(): string {
  const configured = process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "refinement");
}

function filePath(): string {
  return join(rootDir(), FILE_NAME);
}

function assertPrivateRoot(create: boolean): void {
  const dir = rootDir();
  if (!existsSync(dir)) {
    if (!create) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refinement history directory must be a private directory: ${dir}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Refinement history directory permissions are too broad: ${dir}`);
}

function assertPrivateFile(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refinement history is not a regular file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Refinement history permissions are too broad: ${path}`);
}

function loadState(): RefinementHistoryState {
  assertPrivateRoot(false);
  const path = filePath();
  if (!existsSync(path)) return { schema: 1, results: [] };
  assertPrivateFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Refinement history is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Refinement history is malformed");
  const raw = parsed as Record<string, unknown>;
  if (raw.schema !== 1 || !Array.isArray(raw.results)) throw new Error("Refinement history schema is unsupported");
  const results = raw.results.filter((value): value is RefinementResult => {
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).id === "string"
      && Array.isArray((value as Record<string, unknown>).appliedEdits));
  });
  if (results.length !== raw.results.length) throw new Error("Refinement history contains malformed records");
  return { schema: 1, results };
}

function saveState(state: RefinementHistoryState): void {
  const dir = rootDir();
  assertPrivateRoot(true);
  const path = filePath();
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, mode === 0o600 ? 0o600 : 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export class RefinementHistoryStore {
  list(limit = 10): readonly RefinementResult[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error(`refinement history limit must be between 1 and ${MAX_RESULTS}`);
    return Object.freeze(loadState().results.slice(-limit).reverse().map((result) => structuredClone(result)));
  }

  get(id: string): RefinementResult | undefined {
    const normalized = id.trim();
    if (!normalized) throw new Error("refinement id is required");
    const found = loadState().results.find((result) => result.id === normalized);
    return found ? structuredClone(found) : undefined;
  }

  record(result: RefinementResult): void {
    const state = loadState();
    if (state.results.some((entry) => entry.id === result.id)) throw new Error(`Refinement history already contains ${result.id}`);
    const results = [...state.results, structuredClone(result)].slice(-MAX_RESULTS);
    saveState({ schema: 1, results });
  }
}
