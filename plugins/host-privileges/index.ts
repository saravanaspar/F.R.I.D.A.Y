import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../runtime-settings/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { HOST_PRIVILEGES_CAPABILITY, type HostPrivilegesService } from "./contract.js";
import { hasFridayPrivilegedHelper, installVoiceHostDependencies } from "./privileged.js";

const hostPrivilegesPlugin: FridayPlugin = definePlugin({
  id: "host-privileges",
  requires: [RUNTIME_SETTINGS_CAPABILITY],
  provides: [HOST_PRIVILEGES_CAPABILITY],
}, (ctx) => {
  const runtime = ctx.services.require(RUNTIME_SETTINGS_CAPABILITY);
  const service: HostPrivilegesService = Object.freeze({
    async status() {
      const settings = await runtime.read();
      const privilegeMode = settings?.hostPrivilegeMode ?? "none";
      const privilegedHelperInstalled = await hasFridayPrivilegedHelper();
      return Object.freeze({
        privilegeMode,
        privilegedHelperInstalled,
        ready: privilegeMode === "none" || privilegedHelperInstalled,
      });
    },
    async installApprovedVoiceDependencies() {
      const settings = await runtime.read();
      if ((settings?.hostPrivilegeMode ?? "none") !== "broker") {
        throw new Error("Privileged host operations are disabled by the mandatory local host privilege policy");
      }
      await installVoiceHostDependencies();
    },
  });
  ctx.services.provide(HOST_PRIVILEGES_CAPABILITY, service);

  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "host-privileges",
    label: "Host privilege boundary",
    snapshot: () => service.status(),
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "host.privilege.status",
    label: "Host privilege policy",
    description: "Show whether FRIDAY uses the restricted approved-operation broker or no privileged operations. This local-only policy cannot be changed through a channel.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() {
      return { id: "host.privilege.status", effect: "global-operational-read", resource: "host:privilege-policy", network: false };
    },
    execute: () => service.status(),
  });
});

export default hostPrivilegesPlugin;
