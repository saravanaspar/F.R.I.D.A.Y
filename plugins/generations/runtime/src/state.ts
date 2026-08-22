import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GenerationsStateError } from "./errors.js";
import type { GenerationRecord, GenerationsState } from "./types.js";

export const GENERATIONS_STATE_FILE_NAME = "generations.json";

export function createEmptyGenerationsState(): GenerationsState {
  return {
    schema: 1,
    nextSequence: 1,
    activeGenerationId: undefined,
    generations: {},
  };
}

export function getGenerationsStatePath(stateDir: string): string {
  return join(stateDir, GENERATIONS_STATE_FILE_NAME);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GenerationsStateError(`invalid generations state: ${field} must be a non-empty string`);
  }
  return value;
}

function parseGeneration(id: string, value: unknown): GenerationRecord {
  const raw = record(value);
  if (!raw) {
    throw new GenerationsStateError(`invalid generations state: generation ${id} is not an object`);
  }
  const sequence = raw.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
    throw new GenerationsStateError(`invalid generations state: generation ${id} has an invalid sequence`);
  }
  const parsedId = requiredString(raw.id, `generation ${id}.id`);
  if (parsedId !== id) {
    throw new GenerationsStateError(`invalid generations state: generation key ${id} does not match record id ${parsedId}`);
  }
  const parentId = raw.parentId;
  const label = raw.label;
  if (parentId !== undefined && typeof parentId !== "string") {
    throw new GenerationsStateError(`invalid generations state: generation ${id}.parentId must be a string`);
  }
  if (label !== undefined && typeof label !== "string") {
    throw new GenerationsStateError(`invalid generations state: generation ${id}.label must be a string`);
  }
  const expectedId = `gen-${String(sequence).padStart(6, "0")}`;
  if (id !== expectedId) {
    throw new GenerationsStateError(
      `invalid generations state: generation ${id} does not match sequence ${sequence}`,
    );
  }
  const ref = requiredString(raw.ref, `generation ${id}.ref`);
  const expectedRef = `refs/friday/generations/${id}`;
  if (ref !== expectedRef) {
    throw new GenerationsStateError(
      `invalid generations state: generation ${id} has unexpected ref ${ref}`,
    );
  }
  return {
    id,
    sequence,
    repository: requiredString(raw.repository, `generation ${id}.repository`),
    commit: requiredString(raw.commit, `generation ${id}.commit`),
    ref,
    parentId,
    label,
    createdAt: requiredString(raw.createdAt, `generation ${id}.createdAt`),
  };
}

export function loadGenerationsState(stateDir: string): GenerationsState {
  const statePath = getGenerationsStatePath(stateDir);
  if (!existsSync(statePath)) return createEmptyGenerationsState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  } catch (error) {
    throw new GenerationsStateError(
      `failed to parse generations state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = record(parsed);
  if (!raw || raw.schema !== 1) {
    throw new GenerationsStateError(`unsupported or malformed generations state at ${statePath}`);
  }
  const rawGenerations = record(raw.generations);
  if (!rawGenerations) {
    throw new GenerationsStateError(`invalid generations state at ${statePath}: generations must be an object`);
  }
  const nextSequence = raw.nextSequence;
  if (typeof nextSequence !== "number" || !Number.isInteger(nextSequence) || nextSequence < 1) {
    throw new GenerationsStateError(`invalid generations state at ${statePath}: nextSequence must be a positive integer`);
  }

  const generations: Record<string, GenerationRecord> = {};
  for (const [id, value] of Object.entries(rawGenerations)) {
    generations[id] = parseGeneration(id, value);
  }

  const activeGenerationId = raw.activeGenerationId;
  if (activeGenerationId !== undefined && typeof activeGenerationId !== "string") {
    throw new GenerationsStateError(`invalid generations state at ${statePath}: activeGenerationId must be a string`);
  }
  if (typeof activeGenerationId === "string" && !generations[activeGenerationId]) {
    throw new GenerationsStateError(
      `invalid generations state at ${statePath}: active generation ${activeGenerationId} is missing`,
    );
  }
  if (activeGenerationId === undefined && Object.keys(generations).length > 0) {
    throw new GenerationsStateError(
      `invalid generations state at ${statePath}: non-empty history requires an active generation`,
    );
  }

  const sequences = new Set<number>();
  let maxSequence = 0;
  for (const generation of Object.values(generations)) {
    if (sequences.has(generation.sequence)) {
      throw new GenerationsStateError(
        `invalid generations state at ${statePath}: duplicate generation sequence ${generation.sequence}`,
      );
    }
    sequences.add(generation.sequence);
    maxSequence = Math.max(maxSequence, generation.sequence);
    if (generation.parentId !== undefined) {
      const parent = generations[generation.parentId];
      if (!parent) {
        throw new GenerationsStateError(
          `invalid generations state at ${statePath}: generation ${generation.id} references missing parent ${generation.parentId}`,
        );
      }
      if (parent.sequence >= generation.sequence) {
        throw new GenerationsStateError(
          `invalid generations state at ${statePath}: generation ${generation.id} must follow its parent sequence`,
        );
      }
    }
  }
  if (nextSequence <= maxSequence) {
    throw new GenerationsStateError(
      `invalid generations state at ${statePath}: nextSequence must be greater than recorded generation sequences`,
    );
  }

  for (const generation of Object.values(generations)) {
    const seen = new Set<string>();
    let current: GenerationRecord | undefined = generation;
    while (current) {
      if (seen.has(current.id)) {
        throw new GenerationsStateError(
          `invalid generations state at ${statePath}: generation lineage contains a cycle at ${current.id}`,
        );
      }
      seen.add(current.id);
      current = current.parentId ? generations[current.parentId] : undefined;
    }
  }

  return {
    schema: 1,
    nextSequence,
    activeGenerationId,
    generations,
  };
}

export function saveGenerationsState(stateDir: string, state: GenerationsState): string {
  const statePath = getGenerationsStatePath(stateDir);
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  try {
    const mode = existsSync(statePath) ? statSync(statePath).mode & 0o777 : 0o600;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
    // Make permissions final before publication so rename is the last fallible
    // step that can expose a new state snapshot.
    chmodSync(tempPath, mode);
    renameSync(tempPath, statePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return statePath;
}
