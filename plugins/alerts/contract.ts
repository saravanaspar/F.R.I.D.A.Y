import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface AlertRule {
  readonly id: string;
  readonly type?: string | undefined;
  readonly source?: string | undefined;
  readonly subject?: string | undefined;
  readonly cooldownSeconds: number;
  readonly target: {
    readonly channel: string;
    readonly accountId: string;
    readonly conversationId: string;
    readonly threadId?: string | undefined;
  };
  readonly createdAt: string;
}

export interface AlertsService {
  rules(): readonly AlertRule[];
  remove(id: string): Promise<boolean>;
}

export const ALERTS_CAPABILITY: Capability<AlertsService> = defineCapability<AlertsService>("alerts");
