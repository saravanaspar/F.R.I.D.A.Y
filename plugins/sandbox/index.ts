import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
} from "../system/contract.js";
import { SANDBOX_CAPABILITY } from "./contract.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import {
  createPodmanSandboxService,
  ensurePodmanSandboxImage,
  probePodman,
  type PodmanImageSetupResult,
  type PodmanSandboxOptions,
} from "./podman.js";

export interface SandboxPluginOptions {
  sandbox?: PodmanSandboxOptions | undefined;
  ensureImage?: (() => PodmanImageSetupResult) | undefined;
}

export function createSandboxPlugin(options: SandboxPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "sandbox", optional: [OBSERVABILITY_CAPABILITY], provides: [SANDBOX_CAPABILITY] }, (ctx) => {
    const observability = ctx.services.optional(OBSERVABILITY_CAPABILITY);
    const service = createPodmanSandboxService({
      ...options.sandbox,
      onExecution(event) {
        options.sandbox?.onExecution?.(event);
        observability?.log({
          level: "info",
          component: "sandbox",
          message: "sandbox execution prepared",
          fields: event,
        });
      },
    });
    const probe = options.sandbox?.probe ?? probePodman;
    ctx.services.provide(SANDBOX_CAPABILITY, service);
    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "sandbox",
      label: "Sandbox",
      snapshot() {
        const status = probe(service.image);
        return {
          image: service.image,
          status: status.status ?? (status.available ? "ready" : "unavailable"),
          available: status.available,
          networkMode: service.networkMode ?? "requested",
          limits: service.limits,
          ...(status.reason ? { reason: status.reason } : {}),
        };
      },
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "sandbox.setup",
      label: "Set up sandbox image",
      description: "Build FRIDAY's approved local sandbox image when rootless Podman is available and the image is missing.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return {
          id: "sandbox.setup",
          effect: "system-write",
          resource: `sandbox-image:${service.image}`,
          network: true,
        };
      },
      execute() {
        const before = probe(service.image);
        if (before.available) return { image: service.image, status: "already-ready" };
        if (before.status !== "image-missing") {
          throw new Error(before.reason ?? "Rootless Podman is unavailable");
        }
        return options.ensureImage?.() ?? ensurePodmanSandboxImage({ image: service.image, probe });
      },
    });
  });
}

export default createSandboxPlugin();
