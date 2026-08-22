import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_BOOTSTRAP_DEFERRED,
  PLUGIN_BOOTSTRAP_DISPOSER,
  PLUGIN_BOOTSTRAP_FINALIZER,
  type FridayPlugin,
  type PluginBootstrapAPI,
  type PluginBootstrapDisposer,
  type PluginBootstrapFinalizer,
} from "./plugin.js";

export interface BootstrapConfig {
  readonly plugins: readonly string[];
}

export interface PluginActivationOptions {
  /** Configured discovery defers declarative plugin activation until all manifests are known. */
  readonly defer?: boolean;
}

export interface PluginBootstrapSession {
  activatePlugin(plugin: FridayPlugin, options?: PluginActivationOptions): Promise<void>;
  complete(): Promise<void>;
  dispose(): Promise<void>;
}

export interface FridayRuntime {
  dispose(): Promise<void>;
}

export type BundledPluginRegistry = ReadonlyMap<string, FridayPlugin>;
let bundledPlugins: BundledPluginRegistry | undefined;

/** Install the built-in registry used by the single-file SEA distribution. */
export function installBundledPlugins(registry: BundledPluginRegistry): () => void {
  if (bundledPlugins) throw new Error("Bundled FRIDAY plugins are already installed");
  bundledPlugins = registry;
  return () => { if (bundledPlugins === registry) bundledPlugins = undefined; };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateBootstrapConfig(value: unknown, configPath: string): BootstrapConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid FRIDAY config at ${configPath}: expected an object`);
  }

  const plugins = (value as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`Invalid FRIDAY config at ${configPath}: "plugins" must be an array`);
  }

  const entries = plugins.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `Invalid FRIDAY config at ${configPath}: plugins[${index}] must be a non-empty string`,
      );
    }
    return entry.trim();
  });

  return Object.freeze({ plugins: Object.freeze(entries) });
}

export async function readBootstrapConfig(
  configPath = resolve(process.cwd(), "friday.config.json"),
): Promise<BootstrapConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && bundledPlugins) {
      return Object.freeze({ plugins: Object.freeze([...bundledPlugins.keys()]) });
    }
    throw new Error(`Unable to read FRIDAY config at ${configPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in FRIDAY config at ${configPath}: ${errorMessage(error)}`);
  }

  return validateBootstrapConfig(parsed, configPath);
}

function pluginSpecifier(entrypoint: string, configPath: string): string {
  if (entrypoint.startsWith("file:")) return entrypoint;
  if (isAbsolute(entrypoint)) return pathToFileURL(entrypoint).href;
  if (entrypoint.startsWith(".")) return new URL(entrypoint, pathToFileURL(configPath)).href;
  return entrypoint;
}

async function importPlugin(entrypoint: string, configPath: string): Promise<FridayPlugin> {
  const bundled = bundledPlugins?.get(entrypoint);
  if (bundled) return bundled;
  let module: Record<string, unknown>;
  try {
    module = (await import(pluginSpecifier(entrypoint, configPath))) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to import FRIDAY plugin ${JSON.stringify(entrypoint)}: ${errorMessage(error)}`);
  }

  if (typeof module.default !== "function") {
    throw new Error(`FRIDAY plugin ${JSON.stringify(entrypoint)} must default-export a function`);
  }

  return module.default as FridayPlugin;
}

/**
 * Create the short-lived plugin discovery/finalization host.
 *
 * This object exists only during startup (and for deterministic test assembly).
 * It is not FRIDAY's runtime dispatcher and exposes no command surface.
 */
export function createPluginBootstrapSession(): PluginBootstrapSession {
  const finalizers: PluginBootstrapFinalizer[] = [];
  const disposers: PluginBootstrapDisposer[] = [];
  let completed = false;
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const failures: string[] = [];
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        await disposer();
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    if (failures.length > 0) {
      throw new Error(`FRIDAY bootstrap cleanup failed: ${failures.join("; ")}`);
    }
  };

  return Object.freeze({
    async activatePlugin(plugin: FridayPlugin, options: PluginActivationOptions = {}): Promise<void> {
      if (completed) throw new Error("Plugin bootstrap is already complete");
      if (disposed) throw new Error("Plugin bootstrap is already disposed");
      const api: PluginBootstrapAPI = Object.freeze({
        [PLUGIN_BOOTSTRAP_FINALIZER]: (finalizer: PluginBootstrapFinalizer) => {
          finalizers.push(finalizer);
        },
        [PLUGIN_BOOTSTRAP_DISPOSER]: (disposer: PluginBootstrapDisposer) => {
          disposers.push(disposer);
        },
        [PLUGIN_BOOTSTRAP_DEFERRED]: options.defer === true,
      });
      await plugin(api);
    },

    async complete(): Promise<void> {
      if (completed) return;
      if (disposed) throw new Error("Plugin bootstrap is already disposed");
      completed = true;
      try {
        for (const finalize of finalizers.splice(0)) await finalize();
      } catch (error) {
        try {
          await dispose();
        } catch (cleanupError) {
          throw new Error(
            `${errorMessage(error)}; bootstrap cleanup also failed: ${errorMessage(cleanupError)}`,
          );
        }
        throw error;
      }
    },

    dispose,
  });
}

export async function activateConfiguredPlugins(
  configPath = resolve(process.cwd(), "friday.config.json"),
): Promise<FridayRuntime> {
  const config = await readBootstrapConfig(configPath);
  const bootstrap = createPluginBootstrapSession();

  try {
    for (const entrypoint of config.plugins) {
      const plugin = await importPlugin(entrypoint, configPath);
      await bootstrap.activatePlugin(plugin, { defer: true });
    }
    await bootstrap.complete();
  } catch (error) {
    try {
      await bootstrap.dispose();
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)}; bootstrap cleanup also failed: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }

  return Object.freeze({ dispose: () => bootstrap.dispose() });
}
