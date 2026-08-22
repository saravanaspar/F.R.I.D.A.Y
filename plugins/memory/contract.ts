import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type MemoryModule = typeof import("@friday/memory");

export interface MemoryService {
  readonly api: MemoryModule;
}

export const MEMORY_CAPABILITY: Capability<MemoryService> =
  defineCapability<MemoryService>("memory");
