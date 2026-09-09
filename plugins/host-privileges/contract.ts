import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface HostPrivilegeStatus {
  readonly privilegeMode: "broker" | "none";
  /** True only when the root-owned helper and matching sudoers file pass integrity checks. */
  readonly privilegedHelperInstalled: boolean;
  /** Ready means the selected local policy can be honored without privilege surprises. */
  readonly ready: boolean;
}

/** Narrow privileged-host boundary. Never exposes arbitrary command or shell execution. */
export interface HostPrivilegesService {
  status(): Promise<HostPrivilegeStatus>;
  installApprovedVoiceDependencies(): Promise<void>;
}

export const HOST_PRIVILEGES_CAPABILITY: Capability<HostPrivilegesService> =
  defineCapability<HostPrivilegesService>("host-privileges");
