import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { AgentProfilesService } from "../agent-profiles/contract.js";
import type { ConversationsService } from "../conversations/contract.js";
import type { TurnRuntimeService } from "../turn-loop/contract.js";
import type { SessionJobsService } from "../session-jobs/contract.js";
import type { ProjectsService } from "../projects/contract.js";
import type { ComputerService } from "../computer/contract.js";

/** Wire-compatible event envelope. The canonical generated schemas live in @friday/client-protocol. */
export interface ClientEventMessage {
  readonly kind: "event";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly event: {
    readonly sequence: number;
    readonly id: string;
    readonly type: string;
    readonly source: string;
    readonly subject?: string | undefined;
    readonly occurredAt: string;
    readonly publishedAt: string;
    readonly data: unknown;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
}

export interface ClientConnectInput {
  readonly deviceId: string;
  readonly challenge: string;
  readonly signature: string;
}

export interface ClientConnection {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly connectedAt: string;
  resume(afterSequence?: number): readonly ClientEventMessage[];
  subscribe(listener: (message: ClientEventMessage) => void): () => void;
  close(): void;
}

export interface ClientGatewayService {
  connect(input: ClientConnectInput): Promise<ClientConnection>;
  connections(): readonly Pick<ClientConnection, "connectionId" | "deviceId" | "connectedAt">[];
  latestSequence(): number;
  start(options?: ClientGatewayListenOptions): Promise<ClientGatewayServerStatus>;
  stop(): Promise<void>;
  serverStatus(): ClientGatewayServerStatus;
}

export interface ClientGatewayResources {
  readonly agentProfiles?: AgentProfilesService | undefined;
  readonly conversations?: ConversationsService | undefined;
  readonly turnRuntime?: TurnRuntimeService | undefined;
  readonly sessionJobs?: SessionJobsService | undefined;
  readonly projects?: ProjectsService | undefined;
  readonly computer?: ComputerService | undefined;
}

export interface ClientGatewayListenOptions {
  /** Defaults to loopback. Public exposure should happen through an authenticated TLS reverse proxy. */
  readonly host?: string | undefined;
  /** Zero selects an ephemeral port for tests. */
  readonly port?: number | undefined;
  readonly authenticationTimeoutMs?: number | undefined;
}

export interface ClientGatewayServerStatus {
  readonly running: boolean;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly startedAt?: string | undefined;
  readonly connections: number;
  readonly latestSequence: number;
}

export const CLIENT_GATEWAY_CAPABILITY: Capability<ClientGatewayService> = defineCapability<ClientGatewayService>("clients.gateway");
