import type { FridayPlugin } from "../../src/plugin.js";
import {
  PLUGIN_BOOTSTRAP_DISPOSER,
  PLUGIN_BOOTSTRAP_FINALIZER,
} from "../../src/plugin.js";
import { PluginKernel } from "./kernel.js";
import {
  PLUGIN_KERNEL_CAPABILITY,
  type Capability,
  type CapabilityRegistry,
  installCapabilityRegistry,
  installPluginKernel,
  uninstallCapabilityRegistry,
} from "./protocol.js";

export class MapCapabilityRegistry implements CapabilityRegistry {
  readonly #values = new Map<string, unknown>();

  provide<T>(capability: Capability<T>, value: T): void {
    if (this.#values.has(capability.id)) {
      throw new Error(`Capability already provided: ${capability.id}`);
    }
    this.#values.set(capability.id, value);
  }

  require<T>(capability: Capability<T>): T {
    if (!this.#values.has(capability.id)) {
      throw new Error(`Capability not available: ${capability.id}`);
    }
    return this.#values.get(capability.id) as T;
  }

  has<T>(capability: Capability<T>): boolean {
    return this.#values.has(capability.id);
  }

  ids(): readonly string[] {
    return [...this.#values.keys()].sort();
  }

  withdraw<T>(capability: Capability<T>, value: T): void {
    if (this.#values.get(capability.id) === value) this.#values.delete(capability.id);
  }
}

/**
 * Installs FRIDAY's composition microkernel during the short bootstrap phase.
 * The host understands only generic finalize/dispose hooks; all dependency
 * resolution, services, hooks, contributions, and effects remain kernel-owned.
 */
const capabilityCompositionPlugin: FridayPlugin = (bootstrap) => {
  const registry = new MapCapabilityRegistry();
  const kernel = new PluginKernel(registry);
  installCapabilityRegistry(registry);
  installPluginKernel(kernel);
  registry.provide(PLUGIN_KERNEL_CAPABILITY, kernel);
  bootstrap[PLUGIN_BOOTSTRAP_FINALIZER](() => kernel.finalize());
  bootstrap[PLUGIN_BOOTSTRAP_DISPOSER](async () => {
    try {
      await kernel.disposeAll();
    } finally {
      uninstallCapabilityRegistry();
    }
  });
};

export default capabilityCompositionPlugin;
export { PluginKernel } from "./kernel.js";
export * from "./protocol.js";
