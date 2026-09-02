import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type GenerationsRuntime = typeof import("@friday/generations");

/** Durable generation lineage and promotion state. */
export interface GenerationsService {
  readonly createGenerationsManager: GenerationsRuntime["createGenerationsManager"];
}

export const GENERATIONS_CAPABILITY: Capability<GenerationsService> =
  defineCapability<GenerationsService>("generations");
