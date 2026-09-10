import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type AgentNotificationPreference = "all" | "important" | "muted";

export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly avatar?: string | undefined;
  readonly roleInstructions: string;
  readonly defaultConversationId?: string | undefined;
  readonly memoryScope: string;
  readonly enabledSkills: readonly string[];
  readonly enabledPlugins: readonly string[];
  readonly defaultProjectId?: string | undefined;
  readonly defaultComputerScreen?: string | undefined;
  readonly notificationPreference: AgentNotificationPreference;
  readonly approvalPolicy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentProfileCreateInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly avatar?: string | undefined;
  readonly roleInstructions?: string | undefined;
  readonly defaultConversationId?: string | undefined;
  readonly memoryScope?: string | undefined;
  readonly enabledSkills?: readonly string[] | undefined;
  readonly enabledPlugins?: readonly string[] | undefined;
  readonly defaultProjectId?: string | undefined;
  readonly defaultComputerScreen?: string | undefined;
  readonly notificationPreference?: AgentNotificationPreference | undefined;
  readonly approvalPolicy?: string | undefined;
}

export interface AgentProfileUpdateInput {
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly avatar?: string | null | undefined;
  readonly roleInstructions?: string | undefined;
  readonly defaultConversationId?: string | null | undefined;
  readonly memoryScope?: string | undefined;
  readonly enabledSkills?: readonly string[] | undefined;
  readonly enabledPlugins?: readonly string[] | undefined;
  readonly defaultProjectId?: string | null | undefined;
  readonly defaultComputerScreen?: string | null | undefined;
  readonly notificationPreference?: AgentNotificationPreference | undefined;
  readonly approvalPolicy?: string | undefined;
}

export interface AgentProfilesService {
  create(input: AgentProfileCreateInput): Promise<AgentProfile>;
  get(id: string): AgentProfile | undefined;
  list(): readonly AgentProfile[];
  update(id: string, input: AgentProfileUpdateInput): Promise<AgentProfile>;
  remove(id: string): Promise<boolean>;
}

export const AGENT_PROFILES_CAPABILITY: Capability<AgentProfilesService> =
  defineCapability<AgentProfilesService>("agent-profiles");
