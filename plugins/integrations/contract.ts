import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type IntegrationJsonPrimitive = string | number | boolean | null;
export type IntegrationJsonValue =
  | IntegrationJsonPrimitive
  | IntegrationJsonValue[]
  | { [key: string]: IntegrationJsonValue };
export type IntegrationSettings = { [key: string]: IntegrationJsonValue };

export interface IntegrationActionDefinition {
  id: string;
  description: string;
  mutatesExternalState: boolean;
}

export interface IntegrationAdapterDescriptor {
  id: string;
  displayName: string;
  actions: readonly IntegrationActionDefinition[];
}

export interface IntegrationConnectionInput {
  id: string;
  provider: string;
  name?: string | undefined;
  credentialRef?: string | undefined;
  settings?: IntegrationSettings | undefined;
}

export interface IntegrationConnection {
  id: string;
  provider: string;
  name: string;
  credentialRef?: string | undefined;
  settings: IntegrationSettings;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationInvocation {
  connection: IntegrationConnection;
  action: IntegrationActionDefinition;
  input: IntegrationJsonValue;
  signal?: AbortSignal | undefined;
}

export interface IntegrationAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly actions: readonly IntegrationActionDefinition[];
  validateSettings?(settings: IntegrationSettings): void;
  execute(invocation: IntegrationInvocation): Promise<IntegrationJsonValue>;
}

export interface IntegrationsService {
  registerAdapter(adapter: IntegrationAdapter): () => void;
  adapters(): readonly IntegrationAdapterDescriptor[];
  connect(input: IntegrationConnectionInput): IntegrationConnection;
  disconnect(connectionId: string): boolean;
  get(connectionId: string): IntegrationConnection | undefined;
  connections(): readonly IntegrationConnection[];
  invoke(
    connectionId: string,
    actionId: string,
    input?: IntegrationJsonValue,
    signal?: AbortSignal,
  ): Promise<IntegrationJsonValue>;
}

export const INTEGRATIONS_CAPABILITY: Capability<IntegrationsService> =
  defineCapability<IntegrationsService>("integrations");
