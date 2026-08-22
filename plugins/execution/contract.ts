import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type ExecutionModule = typeof import("@friday/execution");

export interface ExecutionService {
  readonly api: ExecutionModule;
  readonly processes: InstanceType<ExecutionModule["ManagedProcessSupervisor"]>;
}

export const EXECUTION_CAPABILITY: Capability<ExecutionService> =
  defineCapability<ExecutionService>("execution");
