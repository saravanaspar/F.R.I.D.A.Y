import type { SandboxProvider } from "../contract.js";
import { assertSandboxProviderSatisfiesContract } from "../contract.js";
import { KERN_SANDBOX_PROVIDER } from "./kern/index.js";

// Built-in providers are intentionally registered in one place. To ship a new
// in-repo backend, add its provider module and one entry here. Core tools,
// permissions, execution, evaluation and self-improvement remain unchanged.
export const BUILTIN_SANDBOX_PROVIDERS: readonly SandboxProvider[] = Object.freeze([
  KERN_SANDBOX_PROVIDER,
]);

export function sandboxProviderMap(extra: readonly SandboxProvider[] = []): ReadonlyMap<string, SandboxProvider> {
  const providers = new Map<string, SandboxProvider>();
  for (const provider of [...BUILTIN_SANDBOX_PROVIDERS, ...extra]) {
    assertSandboxProviderSatisfiesContract(provider);
    const id = provider.descriptor.id;
    if (providers.has(id)) throw new Error(`Duplicate sandbox provider id: ${id}`);
    providers.set(id, provider);
  }
  return providers;
}

export function configuredSandboxProviderId(explicit?: string): string {
  const builtinDefault = BUILTIN_SANDBOX_PROVIDERS[0]?.descriptor.id;
  const id = explicit?.trim() || process.env.FRIDAY_SANDBOX_PROVIDER?.trim() || builtinDefault;
  if (!id) throw new Error("No built-in sandbox provider is registered and FRIDAY_SANDBOX_PROVIDER is unset");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("FRIDAY_SANDBOX_PROVIDER is invalid");
  return id;
}

export function selectSandboxProvider(
  explicitId?: string,
  extra: readonly SandboxProvider[] = [],
): SandboxProvider {
  const id = configuredSandboxProviderId(explicitId);
  const provider = sandboxProviderMap(extra).get(id);
  if (!provider) {
    const known = [...sandboxProviderMap(extra).keys()].sort().join(", ") || "none";
    throw new Error(`Sandbox provider '${id}' is not registered. Registered providers: ${known}`);
  }
  return provider;
}

export { createKernSandboxProvider, createKernSandboxService, KERN_SANDBOX_PROVIDER } from "./kern/index.js";
