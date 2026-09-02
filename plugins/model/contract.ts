import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type ModelRuntime = typeof import("@friday/model");

/**
 * Provider-neutral model inference and validation operations available to plugins.
 * Provider transports, caches, registry mutation, and test-only helpers remain private.
 */
export interface ModelService {
  readonly getModel: ModelRuntime["getModel"];
  readonly getModels: ModelRuntime["getModels"];
  readonly getProviders: ModelRuntime["getProviders"];
  readonly complete: ModelRuntime["complete"];
  readonly completeSimple: ModelRuntime["completeSimple"];
  readonly stream: ModelRuntime["stream"];
  readonly streamSimple: ModelRuntime["streamSimple"];
  readonly validateToolArguments: ModelRuntime["validateToolArguments"];
  readonly createAssistantMessageDiagnostic: ModelRuntime["createAssistantMessageDiagnostic"];
  readonly parseJsonWithRepair: ModelRuntime["parseJsonWithRepair"];
  readonly Type: ModelRuntime["Type"];
}

/** Trusted registry mutation used by runtime settings for user-configured models. */
export interface ModelRegistryService {
  readonly registerModel: ModelRuntime["registerModel"];
  readonly unregisterModel: ModelRuntime["unregisterModel"];
}

export const MODEL_CAPABILITY: Capability<ModelService> =
  defineCapability<ModelService>("model");

export const MODEL_REGISTRY_CAPABILITY: Capability<ModelRegistryService> =
  defineCapability<ModelRegistryService>("model.registry");
