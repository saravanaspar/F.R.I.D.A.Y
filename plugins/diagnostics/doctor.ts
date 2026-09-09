/**
 * Compatibility type surface only.
 *
 * Canonical host Doctor execution is intentionally not owned by Diagnostics;
 * the model/channel-facing plugin consumes the typed doctor.host capability.
 */
export type {
  DoctorCheck,
  DoctorLevel,
  DoctorRepairId,
  DoctorSection,
} from "../host-doctor/contract.js";
