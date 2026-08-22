import type {
  IntegrationActionDefinition,
  IntegrationAdapter,
  IntegrationAdapterDescriptor,
  IntegrationConnection,
  IntegrationConnectionInput,
  IntegrationJsonValue,
  IntegrationSettings,
  IntegrationsService,
} from "./contract.js";
import {
  getIntegrationsStateDir,
  loadIntegrationsState,
  saveIntegrationsState,
} from "./store.js";

export interface IntegrationAuthorizationRequest {
  connection: IntegrationConnection;
  action: IntegrationActionDefinition;
}

export type IntegrationAuthorizer = (request: IntegrationAuthorizationRequest) => Promise<void>;

export interface IntegrationsServiceOptions {
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  authorize?: IntegrationAuthorizer | undefined;
}

const SECRET_LIKE_KEY = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|access[_-]?key|authorization|credential)(?:$|[_-])/i;

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function cloneJson<T extends IntegrationJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSettings(settings: IntegrationSettings): IntegrationSettings {
  return cloneJson(settings) as IntegrationSettings;
}

function cloneConnection(connection: IntegrationConnection): IntegrationConnection {
  return { ...connection, settings: cloneSettings(connection.settings) };
}

function cloneDescriptor(adapter: IntegrationAdapter): IntegrationAdapterDescriptor {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    actions: adapter.actions.map((action) => ({ ...action })),
  };
}

function assertJsonValue(value: unknown, path = "value"): asserts value is IntegrationJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must contain only JSON-safe values`);
}

function validateSettingsValue(value: IntegrationJsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateSettingsValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_LIKE_KEY.test(key)) {
      throw new Error(`${path}.${key} looks secret-bearing; store secrets outside integrations and use credentialRef`);
    }
    validateSettingsValue(entry, `${path}.${key}`);
  }
}

function validateSettings(settings: IntegrationSettings, path = "settings"): void {
  assertJsonValue(settings, path);
  validateSettingsValue(settings, path);
}

function validateAdapter(adapter: IntegrationAdapter): { id: string; actions: IntegrationActionDefinition[] } {
  const id = normalizeId(adapter.id, "integration adapter id");
  if (!adapter.displayName.trim()) throw new Error(`Integration adapter ${id} requires a display name`);
  const seen = new Set<string>();
  const actions = adapter.actions.map((action) => {
    const actionId = normalizeId(action.id, `action id for ${id}`);
    if (seen.has(actionId)) throw new Error(`Duplicate integration action ${id}:${actionId}`);
    seen.add(actionId);
    if (!action.description.trim()) throw new Error(`Integration action ${id}:${actionId} requires a description`);
    if (typeof action.mutatesExternalState !== "boolean") {
      throw new Error(`Integration action ${id}:${actionId} must declare mutatesExternalState`);
    }
    return { ...action, id: actionId };
  });
  return { id, actions };
}

export function createIntegrationsService(options: IntegrationsServiceOptions = {}): IntegrationsService {
  const stateDir = options.stateDir ?? getIntegrationsStateDir();
  const now = options.now ?? (() => new Date());
  const authorize = options.authorize ?? (async () => {});
  const adapters = new Map<string, IntegrationAdapter>();

  const service: IntegrationsService = {
    registerAdapter(adapter) {
      const validated = validateAdapter(adapter);
      if (adapters.has(validated.id)) throw new Error(`Integration adapter already registered: ${validated.id}`);
      const registered: IntegrationAdapter = Object.freeze({
        ...adapter,
        id: validated.id,
        displayName: adapter.displayName.trim(),
        actions: Object.freeze(validated.actions.map((action) => Object.freeze(action))),
      });
      adapters.set(validated.id, registered);
      return () => {
        if (adapters.get(validated.id) === registered) adapters.delete(validated.id);
      };
    },

    adapters() {
      return [...adapters.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((adapter) => cloneDescriptor(adapter));
    },

    connect(input: IntegrationConnectionInput) {
      const id = normalizeId(input.id, "connection id");
      const provider = normalizeId(input.provider, "integration provider id");
      const adapter = adapters.get(provider);
      if (!adapter) throw new Error(`Integration provider is not registered: ${provider}`);
      const settings = input.settings ?? {};
      validateSettings(settings);
      adapter.validateSettings?.(cloneSettings(settings));
      const credentialRef = input.credentialRef?.trim();
      if (input.credentialRef !== undefined && !credentialRef) throw new Error("credentialRef cannot be empty");
      const state = loadIntegrationsState(stateDir);
      if (state.connections[id]) throw new Error(`Integration connection already exists: ${id}`);
      const timestamp = now().toISOString();
      const connection: IntegrationConnection = {
        id,
        provider,
        name: input.name?.trim() || id,
        ...(credentialRef ? { credentialRef } : {}),
        settings: cloneSettings(settings),
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.connections[id] = connection;
      saveIntegrationsState(stateDir, state);
      return cloneConnection(connection);
    },

    disconnect(connectionId) {
      const id = normalizeId(connectionId, "connection id");
      const state = loadIntegrationsState(stateDir);
      if (!state.connections[id]) return false;
      delete state.connections[id];
      saveIntegrationsState(stateDir, state);
      return true;
    },

    get(connectionId) {
      const connection = loadIntegrationsState(stateDir).connections[normalizeId(connectionId, "connection id")];
      return connection ? cloneConnection(connection) : undefined;
    },

    connections() {
      return Object.values(loadIntegrationsState(stateDir).connections)
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
        .map((connection) => cloneConnection(connection));
    },

    async invoke(connectionId, actionId, input = null, signal) {
      signal?.throwIfAborted();
      assertJsonValue(input, "integration input");
      const connection = loadIntegrationsState(stateDir).connections[normalizeId(connectionId, "connection id")];
      if (!connection) throw new Error(`Unknown integration connection: ${connectionId}`);
      if (!connection.enabled) throw new Error(`Integration connection is disabled: ${connection.id}`);
      const adapter = adapters.get(connection.provider);
      if (!adapter) throw new Error(`Integration provider is not registered: ${connection.provider}`);
      const normalizedAction = normalizeId(actionId, "integration action id");
      const action = adapter.actions.find((candidate) => candidate.id === normalizedAction);
      if (!action) throw new Error(`Unknown integration action: ${connection.provider}:${normalizedAction}`);
      await authorize({ connection: cloneConnection(connection), action: { ...action } });
      signal?.throwIfAborted();
      const result = await adapter.execute({
        connection: cloneConnection(connection),
        action: { ...action },
        input: cloneJson(input),
        ...(signal ? { signal } : {}),
      });
      assertJsonValue(result, "integration result");
      return cloneJson(result);
    },
  };

  return Object.freeze(service);
}
