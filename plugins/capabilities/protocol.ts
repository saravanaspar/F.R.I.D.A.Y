import {
  PLUGIN_BOOTSTRAP_DEFERRED,
  type FridayPlugin,
} from "../../src/plugin.js";

/** A typed identifier for an opaque plugin-provided service capability. */
export interface Capability<T> {
  readonly id: string;
  readonly __valueType?: T;
}

export interface CapabilityRegistry {
  provide<T>(capability: Capability<T>, value: T): void;
  require<T>(capability: Capability<T>): T;
  has<T>(capability: Capability<T>): boolean;
  ids(): readonly string[];
}

export interface Contribution<T> {
  readonly id: string;
  readonly __valueType?: T;
}

export interface Hook<T> {
  readonly id: string;
  readonly __eventType?: T;
}

export type PluginActivationClass = "normal" | "last";
export type PluginLifecycleState =
  | "discovered"
  | "resolved"
  | "activating"
  | "ready"
  | "disposing"
  | "disposed"
  | "failed";

export interface PluginManifest {
  readonly id: string;
  readonly requires?: readonly Capability<unknown>[];
  readonly optional?: readonly Capability<unknown>[];
  readonly provides?: readonly Capability<unknown>[];
  readonly activation?: PluginActivationClass;
}

export interface PluginStatus {
  readonly id: string;
  readonly state: PluginLifecycleState;
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  readonly provides: readonly string[];
  readonly activation: PluginActivationClass;
  readonly error?: string;
}

export interface PluginGraphNode {
  readonly id: string;
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  readonly provides: readonly string[];
  readonly activation: PluginActivationClass;
}

export interface PluginContext {
  readonly plugin: Readonly<PluginGraphNode>;
  readonly services: {
    provide<T>(capability: Capability<T>, value: T): void;
    require<T>(capability: Capability<T>): T;
    optional<T>(capability: Capability<T>): T | undefined;
    has<T>(capability: Capability<T>): boolean;
  };
  contribute<T>(contribution: Contribution<T>, value: T): () => void;
  collect<T>(contribution: Contribution<T>): readonly T[];
  on<T>(hook: Hook<T>, listener: (event: T) => void | Promise<void>): () => void;
  emit<T>(hook: Hook<T>, event: T): Promise<void>;
  /** Run once after the complete configured plugin graph is ready. */
  afterReady(callback: () => void | Promise<void>): void;
  effect(disposer: () => void | Promise<void>): () => Promise<void>;
}

export type DeclarativePluginActivation = (context: PluginContext) => void | Promise<void>;

export interface PluginKernelService {
  register(
    manifest: PluginManifest,
    activate: DeclarativePluginActivation,
    options?: { readonly deferred?: boolean },
  ): Promise<void>;
  finalize(): Promise<void>;
  status(): readonly PluginStatus[];
  graph(): readonly PluginGraphNode[];
  dispose(pluginId: string, options?: { readonly cascade?: boolean }): Promise<void>;
  disposeAll(): Promise<void>;
  contribute<T>(ownerId: string, contribution: Contribution<T>, value: T): () => void;
  collect<T>(contribution: Contribution<T>): readonly T[];
  on<T>(ownerId: string, hook: Hook<T>, listener: (event: T) => void | Promise<void>): () => void;
  emit<T>(hook: Hook<T>, event: T): Promise<void>;
  afterReady(ownerId: string, callback: () => void | Promise<void>): void;
  effect(ownerId: string, disposer: () => void | Promise<void>): () => Promise<void>;
  captureCapability<T>(ownerId: string, capability: Capability<T>, value: T): void;
  assertCapabilityAccess<T>(ownerId: string, capability: Capability<T>): void;
  currentOwnerId(): string | undefined;
}

const REGISTRY_SLOT = Symbol.for("friday.capabilities.registry.v1");
const KERNEL_SLOT = Symbol.for("friday.capabilities.kernel.v2");
const MANIFEST_SLOT = Symbol.for("friday.plugin.manifest.v2");

function globals(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

function validateId(id: string): string {
  const normalized = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error(`Invalid capability id: ${JSON.stringify(id)}`);
  }
  return normalized;
}

function uniqueCapabilities(
  values: readonly Capability<unknown>[] | undefined,
  label: string,
): readonly Capability<unknown>[] {
  if (values === undefined) return Object.freeze([]);
  const ids = new Set<string>();
  const normalized: Capability<unknown>[] = [];
  for (const capability of values) {
    if (capability === null || typeof capability !== "object") {
      throw new Error(`Invalid plugin ${label} capability`);
    }
    const id = validateId(capability.id);
    if (ids.has(id)) throw new Error(`Duplicate plugin ${label} capability: ${id}`);
    ids.add(id);
    normalized.push(capability);
  }
  return Object.freeze(normalized);
}

export function normalizePluginManifest(manifest: PluginManifest): Readonly<Required<PluginManifest>> {
  const id = validateId(manifest.id);
  const requires = uniqueCapabilities(manifest.requires, "required");
  const optional = uniqueCapabilities(manifest.optional, "optional");
  const provides = uniqueCapabilities(manifest.provides, "provided");
  const requiredIds = new Set(requires.map((capability) => capability.id));
  for (const capability of optional) {
    if (requiredIds.has(capability.id)) {
      throw new Error(`Plugin ${id} lists ${capability.id} as both required and optional`);
    }
  }
  const activation = manifest.activation ?? "normal";
  if (activation !== "normal" && activation !== "last") {
    throw new Error(`Invalid plugin activation class for ${id}: ${JSON.stringify(activation)}`);
  }
  return Object.freeze({
    id,
    requires,
    optional,
    provides,
    activation,
  });
}

export function defineCapability<T>(id: string): Capability<T> {
  return Object.freeze({ id: validateId(id) }) as Capability<T>;
}

export function defineContribution<T>(id: string): Contribution<T> {
  return Object.freeze({ id: validateId(id) }) as Contribution<T>;
}

export function defineHook<T>(id: string): Hook<T> {
  return Object.freeze({ id: validateId(id) }) as Hook<T>;
}

export const PLUGIN_KERNEL_CAPABILITY = defineCapability<PluginKernelService>("plugin-kernel");

/** Install the active registry. The composition implementation is replaceable. */
export function installCapabilityRegistry(registry: CapabilityRegistry): void {
  const state = globals();
  if (state[REGISTRY_SLOT] !== undefined) {
    throw new Error("Capability registry already installed");
  }
  state[REGISTRY_SLOT] = registry;
}

export function installPluginKernel(kernel: PluginKernelService): void {
  const state = globals();
  if (state[KERNEL_SLOT] !== undefined) throw new Error("Plugin kernel already installed");
  state[KERNEL_SLOT] = kernel;
}

/** Remove active composition state. Primarily useful for tests. */
export function uninstallCapabilityRegistry(): void {
  const state = globals();
  delete state[KERNEL_SLOT];
  delete state[REGISTRY_SLOT];
}

export function activeCapabilityRegistry(): CapabilityRegistry {
  const registry = globals()[REGISTRY_SLOT];
  if (registry === undefined) {
    throw new Error("Capability composition plugin is not active");
  }
  return registry as CapabilityRegistry;
}

export function activePluginKernel(): PluginKernelService {
  const kernel = globals()[KERNEL_SLOT];
  if (kernel === undefined) throw new Error("Plugin kernel is not active");
  return kernel as PluginKernelService;
}

export function provideCapability<T>(capability: Capability<T>, value: T): void {
  const registry = activeCapabilityRegistry();
  registry.provide(capability, value);
  const kernel = globals()[KERNEL_SLOT] as PluginKernelService | undefined;
  const ownerId = kernel?.currentOwnerId();
  if (kernel !== undefined && ownerId !== undefined) {
    kernel.captureCapability(ownerId, capability, value);
  }
}

export function requireCapability<T>(capability: Capability<T>): T {
  const registry = activeCapabilityRegistry();
  const kernel = globals()[KERNEL_SLOT] as PluginKernelService | undefined;
  const ownerId = kernel?.currentOwnerId();
  if (kernel !== undefined && ownerId !== undefined) kernel.assertCapabilityAccess(ownerId, capability);
  return registry.require(capability);
}

export function optionalCapability<T>(capability: Capability<T>): T | undefined {
  const registry = activeCapabilityRegistry();
  const kernel = globals()[KERNEL_SLOT] as PluginKernelService | undefined;
  const ownerId = kernel?.currentOwnerId();
  if (kernel !== undefined && ownerId !== undefined) kernel.assertCapabilityAccess(ownerId, capability);
  return registry.has(capability) ? registry.require(capability) : undefined;
}

export function contribute<T>(contribution: Contribution<T>, value: T): () => void {
  const kernel = activePluginKernel();
  const ownerId = kernel.currentOwnerId();
  if (ownerId === undefined) throw new Error("Contributions must be registered from an active plugin context");
  return kernel.contribute(ownerId, contribution, value);
}

export function collectContributions<T>(contribution: Contribution<T>): readonly T[] {
  return activePluginKernel().collect(contribution);
}

export function onHook<T>(hook: Hook<T>, listener: (event: T) => void | Promise<void>): () => void {
  const kernel = activePluginKernel();
  const ownerId = kernel.currentOwnerId();
  if (ownerId === undefined) throw new Error("Hooks must be registered from an active plugin context");
  return kernel.on(ownerId, hook, listener);
}

export function emitHook<T>(hook: Hook<T>, event: T): Promise<void> {
  return activePluginKernel().emit(hook, event);
}

export function registerEffect(disposer: () => void | Promise<void>): () => Promise<void> {
  const kernel = activePluginKernel();
  const ownerId = kernel.currentOwnerId();
  if (ownerId === undefined) throw new Error("Effects must be registered from an active plugin context");
  return kernel.effect(ownerId, disposer);
}

export function definePlugin(
  manifest: PluginManifest,
  activate: DeclarativePluginActivation,
): FridayPlugin {
  const normalized = normalizePluginManifest(manifest);
  const plugin: FridayPlugin = async (bootstrap) => {
    await activePluginKernel().register(normalized, activate, {
      deferred: bootstrap[PLUGIN_BOOTSTRAP_DEFERRED],
    });
  };
  Object.defineProperty(plugin, MANIFEST_SLOT, { value: normalized, enumerable: false });
  return plugin;
}

export function getPluginManifest(plugin: FridayPlugin): Readonly<Required<PluginManifest>> | undefined {
  return (plugin as FridayPlugin & { readonly [MANIFEST_SLOT]?: Readonly<Required<PluginManifest>> })[MANIFEST_SLOT];
}
