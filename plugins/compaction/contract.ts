import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type CompactionModule = typeof import("@friday/compaction");

export interface CompactionService {
  readonly api: CompactionModule;
}

export const COMPACTION_CAPABILITY: Capability<CompactionService> =
  defineCapability<CompactionService>("compaction");
