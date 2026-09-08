import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type DoctorLevel = "ok" | "info" | "warn" | "error";
export type DoctorSection = "Installation" | "Configuration" | "Security" | "Tooling" | "Recovery";
export type DoctorRepairId = "setup" | "home-permissions" | "execution-python" | "sandbox";

export interface DoctorCheck {
  readonly id: string;
  readonly section: DoctorSection;
  readonly level: DoctorLevel;
  readonly label: string;
  readonly message: string;
  readonly detail?: string | undefined;
  /** One-line human repair instruction. Safe to expose in JSON and logs. */
  readonly fix?: string | undefined;
  /** Internal repair action used only by explicit `friday doctor --fix`. */
  readonly repair?: DoctorRepairId | undefined;
}

/**
 * Host-owned, read-only Doctor port.
 *
 * This capability deliberately exposes only canonical typed results. It has no
 * command execution, repair, secret-read, or arbitrary filesystem surface.
 */
export interface HostDoctorService {
  collect(): Promise<readonly DoctorCheck[]>;
}

export const HOST_DOCTOR_CAPABILITY: Capability<HostDoctorService> =
  defineCapability<HostDoctorService>("doctor.host");
