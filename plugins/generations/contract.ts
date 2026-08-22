import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type GenerationsModule = typeof import("@friday/generations");

export interface GenerationsService {
  readonly api: GenerationsModule;
}

export const GENERATIONS_CAPABILITY: Capability<GenerationsService> =
  defineCapability<GenerationsService>("generations");
