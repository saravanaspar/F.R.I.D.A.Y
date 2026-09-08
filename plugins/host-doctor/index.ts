import type { FridayPlugin } from "../../src/plugin.js";
import { collectDoctorChecks } from "./collector.js";
import { definePlugin } from "../capabilities/protocol.js";
import { HOST_DOCTOR_CAPABILITY, type HostDoctorService } from "./contract.js";

/**
 * Read-only host adapter for the canonical Doctor collector.
 *
 * Model/channel-facing plugins consume only HOST_DOCTOR_CAPABILITY and never
 * receive process-spawn, filesystem, Vault, Channels, or repair authority.
 */
export function createHostDoctorPlugin(): FridayPlugin {
  return definePlugin({
    id: "host-doctor",
    provides: [HOST_DOCTOR_CAPABILITY],
  }, (ctx) => {
    const service: HostDoctorService = Object.freeze({
      collect: () => collectDoctorChecks(process.env),
    });
    ctx.services.provide(HOST_DOCTOR_CAPABILITY, service);
  });
}

export default createHostDoctorPlugin();
