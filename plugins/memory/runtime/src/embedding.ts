import type { MemoryEntry } from "./types.js";

export interface MemoryEmbeddingProviderState {
  readonly ready: boolean;
  /** Whether the provider currently has a warm inference worker/process. */
  readonly active?: boolean | undefined;
  readonly reason?: string | undefined;
}

export type MemoryEmbeddingVector = Float32Array | Promise<Float32Array>;
export type MemoryEmbeddingBatch = readonly Float32Array[] | Promise<readonly Float32Array[]>;

export interface MemoryEmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  /** Cheap readiness probe. Providers without one are treated as ready. */
  status?(): MemoryEmbeddingProviderState;
  /** Embed one persisted document/memory payload. */
  embed(text: string): MemoryEmbeddingVector;
  /** Optional retrieval-query embedding (for providers with query instructions). */
  embedQuery?(text: string): MemoryEmbeddingVector;
  /** Optional batched document inference for explicit maintenance. */
  embedBatch?(texts: readonly string[]): MemoryEmbeddingBatch;
  /** Release provider-owned runtime resources. Shared providers may defer this to plugin shutdown. */
  dispose?(): void | Promise<void>;
}

export const LOCAL_SUBWORD_EMBEDDING_ID = "local-subword-v1";
export const LOCAL_SUBWORD_EMBEDDING_DIMENSIONS = 384;

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    hash ^= codePoint & 0xff;
    hash = Math.imul(hash, 0x01000193);
    if (codePoint > 0xff) {
      hash ^= (codePoint >>> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (codePoint >>> 16) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const hash = fnv1a32(feature);
  const index = hash % vector.length;
  const sign = (hash & 0x80000000) === 0 ? 1 : -1;
  vector[index] = (vector[index] ?? 0) + sign * weight;
}

function normalizedTokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(TOKEN_PATTERN) ?? []
  ).slice(0, 2048);
}

function addSubwordFeatures(vector: Float32Array, token: string): void {
  addFeature(vector, `t:${token}`, 1.0);
  const bounded = `^${token.slice(0, 64)}$`;
  for (let size = 3; size <= 5; size += 1) {
    if (bounded.length < size) continue;
    for (let index = 0; index <= bounded.length - size; index += 1) {
      addFeature(vector, `g${size}:${bounded.slice(index, index + size)}`, 0.22);
    }
  }
}

export function normalizeEmbedding(vector: Float32Array): Float32Array {
  let magnitudeSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("memory embedding contains a non-finite value");
    magnitudeSquared += value * value;
  }
  if (magnitudeSquared === 0) return vector;
  const scale = 1 / Math.sqrt(magnitudeSquared);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) * scale;
  }
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error("memory embedding dimensions do not match");
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function memoryEntryEmbeddingText(entry: Pick<MemoryEntry, "title" | "content" | "path">): string {
  return `${entry.title}\n${entry.path}\n${entry.content}`;
}

/**
 * Zero-dependency local embedding baseline.
 *
 * This is intentionally deterministic, synchronous, and zero-dependency. It is
 * retained as an explicit bootstrap/test provider; production semantic Memory
 * uses the BGE INT8 provider when that private tooling has been provisioned.
 */
export class LocalSubwordEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = LOCAL_SUBWORD_EMBEDDING_ID;
  readonly dimensions: number;

  constructor(dimensions = LOCAL_SUBWORD_EMBEDDING_DIMENSIONS) {
    if (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 4096) {
      throw new Error("memory embedding dimensions must be an integer between 64 and 4096");
    }
    this.dimensions = dimensions;
  }

  embed(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = normalizedTokens(text);
    for (const token of tokens) addSubwordFeatures(vector, token);
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      addFeature(vector, `b:${tokens[index]}\u0000${tokens[index + 1]}`, 0.35);
    }
    return normalizeEmbedding(vector);
  }
}

export function createLocalEmbeddingProvider(
  dimensions = LOCAL_SUBWORD_EMBEDDING_DIMENSIONS,
): MemoryEmbeddingProvider {
  return new LocalSubwordEmbeddingProvider(dimensions);
}
