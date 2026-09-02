import * as model from "@friday/model";
import { closeOpenAICodexWebSocketSessions } from "@friday/model/openai-codex-responses";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import { SESSION_RESOURCES_CAPABILITY } from "../session-resources/contract.js";
import {
  MODEL_CAPABILITY,
  MODEL_REGISTRY_CAPABILITY,
  type ModelRegistryService,
  type ModelService,
} from "./contract.js";

/** Exposes the model subsystem while resolving cross-plugin lifecycle services through capabilities. */
const modelPlugin: FridayPlugin = definePlugin({ id: "model", requires: [SESSION_RESOURCES_CAPABILITY], optional: [OBSERVABILITY_CAPABILITY], provides: [MODEL_CAPABILITY, MODEL_REGISTRY_CAPABILITY] }, (ctx) => {
  const sessionResources = ctx.services.require(SESSION_RESOURCES_CAPABILITY);
  sessionResources.registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

  const observability = ctx.services.optional(OBSERVABILITY_CAPABILITY);
  if (observability) {
    model.setLogSink((entry) => {
      const { ts, level, component, msg, ...fields } = entry;
      observability.log({
        at: ts,
        level,
        component,
        message: msg,
        fields,
      });

      if (component === "ai.model" && (msg === "model request completed" || msg === "model request terminated")) {
        const label = (name: string, fallback: string): string =>
          typeof fields[name] === "string" && fields[name] ? String(fields[name]) : fallback;
        const labels = {
          provider: label("provider", "unknown"),
          model: label("model", "unknown"),
          api: label("api", "unknown"),
          status: label("status", "unknown"),
          cache: label("cacheSemantics", "unknown"),
        };
        const metric = (name: string): number | undefined => {
          const value = fields[name];
          return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
        };

        observability.increment("model.requests", 1, labels);
        const durationMs = metric("durationMs");
        if (durationMs !== undefined) observability.observe("model.request.duration_ms", durationMs, labels);
        const ttftMs = metric("ttftMs");
        if (ttftMs !== undefined) observability.observe("model.request.ttft_ms", ttftMs, labels);
        const cacheReadRatio = metric("cacheReadRatio");
        if (cacheReadRatio !== undefined) observability.observe("model.cache.read_ratio", cacheReadRatio, labels);
      }
    });
  } else {
    // Model can still be composed independently in focused tests or alternate hosts.
    model.setLogSink(undefined);
  }
  ctx.effect(() => model.setLogSink(undefined));

  const service: ModelService = Object.freeze({
    getModel: model.getModel,
    getModels: model.getModels,
    getProviders: model.getProviders,
    complete: model.complete,
    completeSimple: model.completeSimple,
    stream: model.stream,
    streamSimple: model.streamSimple,
    validateToolArguments: model.validateToolArguments,
    createAssistantMessageDiagnostic: model.createAssistantMessageDiagnostic,
    parseJsonWithRepair: model.parseJsonWithRepair,
    Type: model.Type,
  });
  ctx.services.provide(MODEL_CAPABILITY, service);
  const registry: ModelRegistryService = Object.freeze({
    registerModel: model.registerModel,
    unregisterModel: model.unregisterModel,
  });
  ctx.services.provide(MODEL_REGISTRY_CAPABILITY, registry);
});

export default modelPlugin;
