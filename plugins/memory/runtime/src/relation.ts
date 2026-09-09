import { createHash } from "node:crypto";
import type { MemoryScope } from "./types.js";

const MAX_RELATION_CONTEXT_JSON = 8_192;

function setOwn(output: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(output, key, {
    value: structuredClone(value),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Relation identity is semantic: context is observation/provenance metadata and
 * must not split the same subject/predicate/object edge into separate facts.
 */
export function memoryRelationIdentity(
  scope: MemoryScope,
  subject: string,
  predicate: string,
  object: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ scope, subject, predicate, object }))
    .digest("hex")
    .slice(0, 32);
  return `rel_${hash}`;
}

/**
 * Prefer the newest observation's context while retaining older keys when they
 * fit. The result stays bounded so repeated observations cannot grow one edge
 * without limit.
 */
export function mergeMemoryRelationContext(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const incomingKeys = Object.keys(incoming).sort((left, right) => left.localeCompare(right));
  const olderKeys = Object.keys(current)
    .filter((key) => !Object.prototype.hasOwnProperty.call(incoming, key))
    .sort((left, right) => left.localeCompare(right));

  for (const key of [...incomingKeys, ...olderKeys]) {
    const value = Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] : current[key];
    setOwn(output, key, value);
    if (JSON.stringify(output).length > MAX_RELATION_CONTEXT_JSON) {
      delete output[key];
    }
  }
  return output;
}

export interface MergeableMemoryRelation {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly context: Record<string, unknown>;
  readonly source: string;
  readonly confidence: number;
  readonly occurrences: number;
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly updated_at: string;
}

/** Merge repeated observations of the same semantic relation. */
export function mergeMemoryRelationObservations<T extends MergeableMemoryRelation>(
  current: T,
  incoming: T,
): T {
  if (
    current.scope !== incoming.scope
    || current.subject !== incoming.subject
    || current.predicate !== incoming.predicate
    || current.object !== incoming.object
  ) {
    throw new Error(`memory relation identity collision: ${incoming.id}`);
  }
  const incomingIsNewer = incoming.updated_at.localeCompare(current.updated_at) >= 0;
  return {
    ...current,
    id: current.id,
    context: incomingIsNewer
      ? mergeMemoryRelationContext(current.context, incoming.context)
      : mergeMemoryRelationContext(incoming.context, current.context),
    source: incomingIsNewer ? incoming.source : current.source,
    confidence: Math.max(current.confidence, incoming.confidence),
    occurrences: current.occurrences + incoming.occurrences,
    first_observed_at: current.first_observed_at.localeCompare(incoming.first_observed_at) <= 0
      ? current.first_observed_at
      : incoming.first_observed_at,
    last_observed_at: current.last_observed_at.localeCompare(incoming.last_observed_at) >= 0
      ? current.last_observed_at
      : incoming.last_observed_at,
    updated_at: incomingIsNewer ? incoming.updated_at : current.updated_at,
  } as T;
}
