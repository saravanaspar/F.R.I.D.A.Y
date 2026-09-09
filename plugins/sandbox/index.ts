import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
} from "../system/contract.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../runtime-settings/contract.js";
import {
  SANDBOX_CAPABILITY,
  SANDBOX_HEALTH_CAPABILITY,
  assertSandboxProviderSatisfiesContract,
  type SandboxNetworkMode,
  type SandboxProvider,
  type SandboxResourceLimits,
} from "./contract.js";
import { selectSandboxProvider } from "./providers/index.js";

export interface SandboxPluginOptions {
  /** Provider id to select. Defaults to FRIDAY_SANDBOX_PROVIDER, then the first registered built-in provider. */
  providerId?: string | undefined;
  /** Additional providers supplied by an embedding host or future plugin package. */
  providers?: readonly SandboxProvider[] | undefined;
  networkMode?: SandboxNetworkMode | undefined;
  /** Provider-neutral outbound domain allowlist used for explicitly requested networking. */
  egressAllow?: readonly string[] | undefined;
  limits?: Partial<SandboxResourceLimits> | undefined;
}

export function createSandboxPlugin(options: SandboxPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "sandbox", optional: [OBSERVABILITY_CAPABILITY, RUNTIME_SETTINGS_CAPABILITY], provides: [SANDBOX_CAPABILITY, SANDBOX_HEALTH_CAPABILITY] }, (ctx) => {
    const observability = ctx.services.optional(OBSERVABILITY_CAPABILITY);
    const provider = selectSandboxProvider(options.providerId, options.providers ?? []);
    assertSandboxProviderSatisfiesContract(provider);
    const service = provider.createService({
      ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
      ...(options.egressAllow === undefined ? {} : { egressAllow: options.egressAllow }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      onExecution(event) {
        observability?.log({
          level: "info",
          component: "sandbox",
          message: "sandbox execution prepared",
          // Object spread intentionally materializes a plain record; SandboxExecutionEvent is a
          // closed interface and is not assignable to Record<string, unknown> by itself.
          fields: { ...event },
        });
      },
    });

    ctx.services.provide(SANDBOX_CAPABILITY, service);
    ctx.services.provide(SANDBOX_HEALTH_CAPABILITY, Object.freeze({
      snapshot() {
        const probe = provider.probe();
        return Object.freeze({
          provider: provider.descriptor,
          probe,
          ...(service.image ? { image: service.image } : {}),
          repairHint: provider.repairHint(probe),
        });
      },
    }));
    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "sandbox",
      label: "Sandbox",
      snapshot() {
        const status = provider.probe();
        return {
          provider: provider.descriptor.id,
          providerName: provider.descriptor.displayName,
          isolationClass: provider.descriptor.isolationClass,
          capabilities: provider.descriptor.capabilities,
          ...(service.image ? { image: service.image } : {}),
          status: status.status,
          available: status.available,
          networkMode: service.networkMode ?? "requested",
          ...(service.egressAllow && service.egressAllow.length > 0 ? { egressAllow: service.egressAllow } : {}),
          limits: service.limits,
          ...(status.reason ? { reason: status.reason } : {}),
        };
      },
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "sandbox.setup",
      label: provider.setupLabel,
      description: provider.setupDescription,
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return {
          id: "sandbox.setup",
          effect: "system-write",
          resource: `sandbox-provider:${provider.descriptor.id}`,
          network: true,
        };
      },
      async execute() {
        const result = await provider.setup();
        await ctx.services.optional(RUNTIME_SETTINGS_CAPABILITY)?.markOnboardingStep("sandbox", "complete");
        return result;
      },
    });
  });
}

export default createSandboxPlugin();
