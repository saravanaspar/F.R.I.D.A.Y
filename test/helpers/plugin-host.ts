import { afterEach } from "vitest";
import {
  createPluginBootstrapSession,
  type PluginActivationOptions,
  type PluginBootstrapSession,
} from "../../src/bootstrap.js";
import type { FridayPlugin } from "../../src/plugin.js";

const activeHosts = new Set<PluginTestHost>();

/** Test-only assembly helper. It deliberately has no command-dispatch surface. */
export class PluginTestHost {
  readonly #session: PluginBootstrapSession = createPluginBootstrapSession();
  #disposed = false;

  constructor() {
    activeHosts.add(this);
  }

  activatePlugin(plugin: FridayPlugin, options?: PluginActivationOptions): Promise<void> {
    return this.#session.activatePlugin(plugin, options);
  }

  completePluginBootstrap(): Promise<void> {
    return this.#session.complete();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    activeHosts.delete(this);
    await this.#session.dispose();
  }
}

afterEach(async () => {
  const hosts = [...activeHosts];
  activeHosts.clear();
  for (const host of hosts.reverse()) await host.dispose();
});
