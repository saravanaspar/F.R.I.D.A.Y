import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Capability,
  CapabilityRegistry,
  Contribution,
  DeclarativePluginActivation,
  Hook,
  PluginContext,
  PluginGraphNode,
  PluginKernelService,
  PluginLifecycleState,
  PluginManifest,
  PluginStatus,
} from "./protocol.js";
import { normalizePluginManifest } from "./protocol.js";

interface ReversibleCapabilityRegistry extends CapabilityRegistry {
  withdraw<T>(capability: Capability<T>, value: T): void;
}

interface PluginRecord {
  readonly manifest: Readonly<Required<PluginManifest>>;
  readonly activate: DeclarativePluginActivation;
  readonly sequence: number;
  state: PluginLifecycleState;
  error?: string;
  readonly effects: Array<() => void | Promise<void>>;
  readonly readyCallbacks: Array<() => void | Promise<void>>;
}

interface OwnedContribution {
  readonly ownerId: string;
  readonly value: unknown;
}

interface OwnedHook {
  readonly ownerId: string;
  readonly listener: (event: unknown) => void | Promise<void>;
}

interface ActivationScope {
  readonly ownerId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function frozenIds(capabilities: readonly Capability<unknown>[]): readonly string[] {
  return Object.freeze(capabilities.map((capability) => capability.id));
}

function graphNode(manifest: Readonly<Required<PluginManifest>>): PluginGraphNode {
  return Object.freeze({
    id: manifest.id,
    requires: frozenIds(manifest.requires),
    optional: frozenIds(manifest.optional),
    provides: frozenIds(manifest.provides),
    activation: manifest.activation,
  });
}

export class PluginKernel implements PluginKernelService {
  readonly #registry: ReversibleCapabilityRegistry;
  readonly #records = new Map<string, PluginRecord>();
  readonly #contributions = new Map<string, OwnedContribution[]>();
  readonly #hooks = new Map<string, OwnedHook[]>();
  readonly #activationScope = new AsyncLocalStorage<ActivationScope>();
  readonly #activationOrder: string[] = [];
  #nextSequence = 1;
  #discoveryClosed = false;
  #finalized = false;
  #bootstrapError?: string;

  constructor(registry: ReversibleCapabilityRegistry) {
    this.#registry = registry;
  }

  currentOwnerId(): string | undefined {
    return this.#activationScope.getStore()?.ownerId;
  }

  async register(
    manifest: PluginManifest,
    activate: DeclarativePluginActivation,
    options: { readonly deferred?: boolean } = {},
  ): Promise<void> {
    if (this.#discoveryClosed) throw new Error("Plugin discovery is already finalized");
    const normalized = normalizePluginManifest(manifest);
    if (this.#records.has(normalized.id)) throw new Error(`Plugin already registered: ${normalized.id}`);

    const record: PluginRecord = {
      manifest: normalized,
      activate,
      sequence: this.#nextSequence++,
      state: "discovered",
      effects: [],
      readyCallbacks: [],
    };
    this.#records.set(normalized.id, record);

    if (options.deferred !== true) {
      this.#assertNoProviderConflicts();
      this.#assertRequiredAvailableForImmediate(record);
      await this.#activate(record);
    }
  }

  async finalize(): Promise<void> {
    if (this.#finalized) return;
    if (this.#bootstrapError !== undefined) {
      throw new Error(`Plugin bootstrap previously failed: ${this.#bootstrapError}`);
    }
    this.#discoveryClosed = true;

    try {
      this.#assertNoProviderConflicts();
      this.#assertNoMissingProviders();
      await this.#activateClass("normal");
      await this.#activateClass("last");
      const unresolved = [...this.#records.values()].filter((record) => record.state === "discovered");
      if (unresolved.length > 0) throw this.#dependencyDeadlockError(unresolved);
      await this.#runReadyCallbacks();
      this.#finalized = true;
    } catch (error) {
      const original = errorMessage(error);
      try {
        await this.#rollbackReadyPlugins();
      } catch (rollbackError) {
        const combined = `${original}; plugin bootstrap rollback also failed: ${errorMessage(rollbackError)}`;
        this.#bootstrapError = combined;
        throw new Error(combined);
      }
      this.#bootstrapError = original;
      throw error;
    }
  }

  status(): readonly PluginStatus[] {
    return [...this.#records.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((record) => Object.freeze({
        id: record.manifest.id,
        state: record.state,
        requires: frozenIds(record.manifest.requires),
        optional: frozenIds(record.manifest.optional),
        provides: frozenIds(record.manifest.provides),
        activation: record.manifest.activation,
        ...(record.error === undefined ? {} : { error: record.error }),
      }));
  }

  graph(): readonly PluginGraphNode[] {
    return [...this.#records.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((record) => graphNode(record.manifest));
  }

  async dispose(pluginId: string, options: { readonly cascade?: boolean } = {}): Promise<void> {
    const record = this.#records.get(pluginId);
    if (!record) throw new Error(`Unknown plugin: ${pluginId}`);
    if (record.state === "disposed") return;
    if (record.state !== "ready" && record.state !== "failed") {
      throw new Error(`Plugin ${pluginId} cannot be disposed from state ${record.state}`);
    }

    const dependents = this.#readyDependents(record);
    if (dependents.length > 0 && options.cascade !== true) {
      throw new Error(`Plugin ${pluginId} is required by: ${dependents.map((item) => item.manifest.id).sort().join(", ")}`);
    }
    if (options.cascade === true) {
      for (const dependent of this.#dependentClosure(record)) await this.#disposeRecord(dependent);
    }
    await this.#disposeRecord(record);
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.#activationOrder].reverse();
    let firstError: unknown;
    for (const id of ids) {
      const record = this.#records.get(id);
      if (!record || (record.state !== "ready" && record.state !== "failed")) continue;
      try {
        await this.#disposeRecord(record);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw new Error(`Plugin shutdown failed: ${errorMessage(firstError)}`);
    }
  }

  contribute<T>(ownerId: string, contribution: Contribution<T>, value: T): () => void {
    this.#assertOwnerActive(ownerId);
    const bucket = this.#contributions.get(contribution.id) ?? [];
    const owned: OwnedContribution = { ownerId, value };
    bucket.push(owned);
    this.#contributions.set(contribution.id, bucket);
    const dispose = () => {
      const current = this.#contributions.get(contribution.id);
      if (!current) return;
      const index = current.indexOf(owned);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#contributions.delete(contribution.id);
    };
    this.effect(ownerId, dispose);
    return dispose;
  }

  collect<T>(contribution: Contribution<T>): readonly T[] {
    return Object.freeze((this.#contributions.get(contribution.id) ?? []).map((entry) => entry.value as T));
  }

  on<T>(ownerId: string, hook: Hook<T>, listener: (event: T) => void | Promise<void>): () => void {
    this.#assertOwnerActive(ownerId);
    const bucket = this.#hooks.get(hook.id) ?? [];
    const owned: OwnedHook = { ownerId, listener: listener as (event: unknown) => void | Promise<void> };
    bucket.push(owned);
    this.#hooks.set(hook.id, bucket);
    const dispose = () => {
      const current = this.#hooks.get(hook.id);
      if (!current) return;
      const index = current.indexOf(owned);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#hooks.delete(hook.id);
    };
    this.effect(ownerId, dispose);
    return dispose;
  }

  async emit<T>(hook: Hook<T>, event: T): Promise<void> {
    const listeners = [...(this.#hooks.get(hook.id) ?? [])];
    for (const { listener } of listeners) await listener(event);
  }

  afterReady(ownerId: string, callback: () => void | Promise<void>): void {
    const record = this.#records.get(ownerId);
    if (!record || (record.state !== "activating" && record.state !== "ready")) {
      throw new Error(`Plugin ${ownerId} cannot register graph-ready work from state ${record?.state ?? "unknown"}`);
    }
    record.readyCallbacks.push(callback);
  }

  effect(ownerId: string, disposer: () => void | Promise<void>): () => Promise<void> {
    const record = this.#records.get(ownerId);
    if (!record) throw new Error(`Unknown plugin effect owner: ${ownerId}`);
    if (record.state !== "activating" && record.state !== "ready") {
      throw new Error(`Plugin ${ownerId} cannot register effects from state ${record.state}`);
    }
    let active = true;
    const wrapped = async () => {
      if (!active) return;
      active = false;
      await disposer();
    };
    record.effects.push(wrapped);
    return async () => {
      await wrapped();
    };
  }

  assertCapabilityAccess<T>(ownerId: string, capability: Capability<T>): void {
    const record = this.#records.get(ownerId);
    if (!record) throw new Error(`Unknown plugin capability consumer: ${ownerId}`);
    const declared = [...record.manifest.requires, ...record.manifest.optional, ...record.manifest.provides]
      .some((item) => item.id === capability.id);
    if (!declared) {
      throw new Error(`Plugin ${ownerId} accessed undeclared capability: ${capability.id}`);
    }
  }

  captureCapability<T>(ownerId: string, capability: Capability<T>, value: T): void {
    const record = this.#records.get(ownerId);
    if (!record) {
      this.#registry.withdraw(capability, value);
      throw new Error(`Unknown plugin capability owner: ${ownerId}`);
    }
    if (!record.manifest.provides.some((declared) => declared.id === capability.id)) {
      this.#registry.withdraw(capability, value);
      throw new Error(`Plugin ${ownerId} provided undeclared capability: ${capability.id}`);
    }
    this.effect(ownerId, () => this.#registry.withdraw(capability, value));
  }

  #assertOwnerActive(ownerId: string): void {
    const record = this.#records.get(ownerId);
    if (!record || (record.state !== "activating" && record.state !== "ready")) {
      throw new Error(`Plugin ${ownerId} does not own an active context`);
    }
  }

  #assertRequiredAvailableForImmediate(record: PluginRecord): void {
    const missing = record.manifest.requires
      .map((capability) => capability.id)
      .filter((id) => !this.#registry.ids().includes(id));
    if (missing.length > 0) {
      throw new Error(`Plugin ${record.manifest.id} requires unavailable capabilities: ${missing.join(", ")}`);
    }
  }

  #assertNoProviderConflicts(): void {
    const providers = new Map<string, string>();
    for (const record of this.#records.values()) {
      for (const capability of record.manifest.provides) {
        const existing = providers.get(capability.id);
        if (existing !== undefined) {
          throw new Error(`Capability ${capability.id} is declared by multiple plugins: ${existing}, ${record.manifest.id}`);
        }
        providers.set(capability.id, record.manifest.id);
      }
    }
  }

  #assertNoMissingProviders(): void {
    const providers = new Set<string>(this.#registry.ids());
    for (const record of this.#records.values()) {
      for (const capability of record.manifest.provides) providers.add(capability.id);
    }
    const missing: string[] = [];
    for (const record of this.#records.values()) {
      for (const capability of record.manifest.requires) {
        if (!providers.has(capability.id)) missing.push(`${record.manifest.id}->${capability.id}`);
      }
    }
    if (missing.length > 0) throw new Error(`Missing plugin capability providers: ${missing.sort().join(", ")}`);
  }

  async #activateClass(activation: "normal" | "last"): Promise<void> {
    while (true) {
      const pending = [...this.#records.values()].filter(
        (record) => record.state === "discovered" && record.manifest.activation === activation,
      );
      if (pending.length === 0) return;

      const ready = pending.filter((record) => this.#requirementsAvailable(record));
      if (ready.length === 0) {
        if (activation === "normal") throw this.#dependencyDeadlockError(pending);
        throw new Error(`Last-stage plugins are unresolved: ${pending.map((record) => record.manifest.id).sort().join(", ")}`);
      }

      ready.sort((a, b) => {
        const optionalA = this.#missingOptionalCount(a);
        const optionalB = this.#missingOptionalCount(b);
        if (optionalA !== optionalB) return optionalA - optionalB;
        return a.sequence - b.sequence;
      });
      await this.#activate(ready[0]!);
    }
  }

  #requirementsAvailable(record: PluginRecord): boolean {
    return record.manifest.requires.every((capability) => this.#registry.has(capability));
  }

  #missingOptionalCount(record: PluginRecord): number {
    return record.manifest.optional.reduce(
      (count, capability) => count + (this.#registry.has(capability) ? 0 : 1),
      0,
    );
  }

  #context(record: PluginRecord): PluginContext {
    const node = graphNode(record.manifest);
    return Object.freeze({
      plugin: node,
      services: Object.freeze({
        provide: <T>(capability: Capability<T>, value: T) => {
          this.#registry.provide(capability, value);
          this.captureCapability(record.manifest.id, capability, value);
        },
        require: <T>(capability: Capability<T>) => {
          this.assertCapabilityAccess(record.manifest.id, capability);
          return this.#registry.require(capability);
        },
        optional: <T>(capability: Capability<T>) => {
          this.assertCapabilityAccess(record.manifest.id, capability);
          return this.#registry.has(capability) ? this.#registry.require(capability) : undefined;
        },
        has: <T>(capability: Capability<T>) => {
          this.assertCapabilityAccess(record.manifest.id, capability);
          return this.#registry.has(capability);
        },
      }),
      contribute: <T>(contribution: Contribution<T>, value: T) => this.contribute(record.manifest.id, contribution, value),
      collect: <T>(contribution: Contribution<T>) => this.collect(contribution),
      on: <T>(hook: Hook<T>, listener: (event: T) => void | Promise<void>) => this.on(record.manifest.id, hook, listener),
      emit: <T>(hook: Hook<T>, event: T) => this.emit(hook, event),
      afterReady: (callback: () => void | Promise<void>) => this.afterReady(record.manifest.id, callback),
      effect: (disposer: () => void | Promise<void>) => this.effect(record.manifest.id, disposer),
    });
  }

  async #activate(record: PluginRecord): Promise<void> {
    record.state = "resolved";
    record.state = "activating";
    const context = this.#context(record);
    try {
      await this.#activationScope.run({ ownerId: record.manifest.id }, () => record.activate(context));
      const missingProvides = record.manifest.provides.filter((capability) => !this.#registry.has(capability));
      if (missingProvides.length > 0) {
        throw new Error(
          `Plugin ${record.manifest.id} did not provide declared capabilities: ${missingProvides.map((item) => item.id).join(", ")}`,
        );
      }
      record.state = "ready";
      this.#activationOrder.push(record.manifest.id);
    } catch (error) {
      const activationError = errorMessage(error);
      record.state = "failed";
      record.error = activationError;
      try {
        await this.#disposeEffects(record);
      } catch (cleanupError) {
        const combined = `${activationError}; activation cleanup also failed: ${errorMessage(cleanupError)}`;
        record.error = combined;
        throw new Error(`Plugin ${record.manifest.id} activation failed: ${combined}`);
      }
      throw new Error(`Plugin ${record.manifest.id} activation failed: ${activationError}`);
    }
  }

  async #runReadyCallbacks(): Promise<void> {
    for (const id of this.#activationOrder) {
      const record = this.#records.get(id);
      if (!record || record.state !== "ready") continue;
      const callbacks = record.readyCallbacks.splice(0);
      for (const callback of callbacks) {
        try {
          await this.#activationScope.run({ ownerId: record.manifest.id }, callback);
        } catch (error) {
          const message = errorMessage(error);
          record.error = `graph-ready failed: ${message}`;
          throw new Error(`Plugin ${record.manifest.id} graph-ready failed: ${message}`);
        }
      }
    }
  }

  async #disposeEffects(record: PluginRecord): Promise<void> {
    let firstError: unknown;
    for (const dispose of [...record.effects].reverse()) {
      try {
        await dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    record.effects.length = 0;
    if (firstError !== undefined) throw firstError;
  }

  async #disposeRecord(record: PluginRecord): Promise<void> {
    if (record.state === "disposed") return;
    record.state = "disposing";
    try {
      await this.#disposeEffects(record);
      record.state = "disposed";
      const index = this.#activationOrder.lastIndexOf(record.manifest.id);
      if (index >= 0) this.#activationOrder.splice(index, 1);
    } catch (error) {
      record.state = "failed";
      record.error = `dispose failed: ${errorMessage(error)}`;
      throw new Error(`Plugin ${record.manifest.id} disposal failed: ${errorMessage(error)}`);
    }
  }

  #readyDependents(record: PluginRecord): PluginRecord[] {
    const provided = new Set(record.manifest.provides.map((capability) => capability.id));
    return [...this.#records.values()].filter((candidate) =>
      candidate.state === "ready"
      && candidate.manifest.requires.some((capability) => provided.has(capability.id)),
    );
  }

  #dependentClosure(record: PluginRecord): PluginRecord[] {
    const visited = new Set<string>();
    const ordered: PluginRecord[] = [];
    const visit = (current: PluginRecord) => {
      for (const dependent of this.#readyDependents(current)) {
        if (visited.has(dependent.manifest.id)) continue;
        visited.add(dependent.manifest.id);
        visit(dependent);
        ordered.push(dependent);
      }
    };
    visit(record);
    return ordered;
  }

  #dependencyDeadlockError(records: readonly PluginRecord[]): Error {
    const pendingIds = new Set(records.map((record) => record.manifest.id));
    const providerByCapability = new Map<string, string>();
    for (const record of this.#records.values()) {
      for (const capability of record.manifest.provides) providerByCapability.set(capability.id, record.manifest.id);
    }

    const edges = new Map<string, string[]>();
    for (const record of records) {
      const dependencies = record.manifest.requires
        .filter((capability) => !this.#registry.has(capability))
        .map((capability) => providerByCapability.get(capability.id))
        .filter((provider): provider is string => provider !== undefined && pendingIds.has(provider));
      edges.set(record.manifest.id, dependencies);
    }

    const cycle = this.#findCycle(edges);
    if (cycle) return new Error(`Plugin dependency cycle: ${cycle.join(" -> ")}`);
    return new Error(
      `Unresolved plugin dependencies: ${records.map((record) => {
        const missing = record.manifest.requires.filter((capability) => !this.#registry.has(capability));
        return `${record.manifest.id}[${missing.map((capability) => capability.id).join(",")}]`;
      }).sort().join("; ")}`,
    );
  }

  #findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const visit = (id: string): string[] | undefined => {
      if (visiting.has(id)) {
        const start = stack.indexOf(id);
        return [...stack.slice(start), id];
      }
      if (visited.has(id)) return undefined;
      visiting.add(id);
      stack.push(id);
      for (const next of edges.get(id) ?? []) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
      stack.pop();
      visiting.delete(id);
      visited.add(id);
      return undefined;
    };
    for (const id of edges.keys()) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
    return undefined;
  }

  async #rollbackReadyPlugins(): Promise<void> {
    let firstError: unknown;
    for (const id of [...this.#activationOrder].reverse()) {
      const record = this.#records.get(id);
      if (!record || record.state !== "ready") continue;
      try {
        await this.#disposeRecord(record);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw new Error(`Plugin bootstrap rollback failed: ${errorMessage(firstError)}`);
    }
  }
}
