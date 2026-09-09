import type { FridayPlugin } from "../../src/plugin.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { CHANNELS_CAPABILITY } from "../channels/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../runtime-settings/contract.js";
import { SANDBOX_HEALTH_CAPABILITY } from "../sandbox/contract.js";
import { HOST_PRIVILEGES_CAPABILITY } from "../host-privileges/contract.js";
import { VOICE_CAPABILITY } from "../voice/contract.js";
import { collectDoctorChecks, type DoctorSources } from "./collector.js";
import { HOST_DOCTOR_CAPABILITY, type HostDoctorService } from "./contract.js";

/**
 * Read-only host adapter for the canonical Doctor collector.
 *
 * Every domain observation is obtained through ordinary typed capabilities;
 * Diagnostics receives only HOST_DOCTOR_CAPABILITY and never gains sibling
 * implementation, process-spawn, secret-read, or repair authority.
 */
export function createHostDoctorPlugin(): FridayPlugin {
  return definePlugin({
    id: "host-doctor",
    requires: [
      CHANNELS_CAPABILITY,
      HOST_PRIVILEGES_CAPABILITY,
      MODEL_CREDENTIALS_CAPABILITY,
      RUNTIME_SETTINGS_CAPABILITY,
      SANDBOX_HEALTH_CAPABILITY,
      VOICE_CAPABILITY,
    ],
    provides: [HOST_DOCTOR_CAPABILITY],
  }, (ctx) => {
    const channels = ctx.services.require(CHANNELS_CAPABILITY);
    const hostPrivileges = ctx.services.require(HOST_PRIVILEGES_CAPABILITY);
    const credentials = ctx.services.require(MODEL_CREDENTIALS_CAPABILITY);
    const runtime = ctx.services.require(RUNTIME_SETTINGS_CAPABILITY);
    const sandboxHealth = ctx.services.require(SANDBOX_HEALTH_CAPABILITY);
    const voice = ctx.services.require(VOICE_CAPABILITY);

    const sources: DoctorSources = Object.freeze({
      runtimeSettings: () => runtime.read(),
      async channels() {
        return channels.access();
      },
      async modelCredential(provider: string) {
        return Object.freeze({
          apiKeyRef: credentials.ref(provider),
          oauthRef: credentials.oauthRef(provider),
          hasApiKey: credentials.has(provider),
          hasOAuth: credentials.hasOAuth(provider),
          typicallyNeedsApiKey: credentials.typicallyNeedsApiKey(provider),
        });
      },
      async voice() {
        const status = voice.status();
        const missing: string[] = [];
        if (status.sttProvider && !status.sttCredentialConfigured) missing.push(status.sttProvider);
        if (status.ttsProvider && !status.ttsCredentialConfigured && !missing.includes(status.ttsProvider)) missing.push(status.ttsProvider);
        return Object.freeze({
          configured: Boolean(status.sttProvider || status.ttsProvider),
          detail: [
            status.sttProvider && status.sttModel ? `STT=${status.sttProvider}/${status.sttModel}` : undefined,
            status.ttsProvider && status.ttsModel ? `TTS=${status.ttsProvider}/${status.ttsModel}` : undefined,
          ].filter(Boolean).join(" · "),
          missingCredentials: Object.freeze(missing),
        });
      },
      hostPrivileges: (_home: string) => hostPrivileges.status(),
      async sandbox() {
        const status = sandboxHealth.snapshot();
        return Object.freeze({
          available: status.probe.available,
          displayName: status.provider.displayName,
          detail: [status.provider.id, status.provider.isolationClass, status.image, status.probe.reason ?? status.probe.status].filter(Boolean).join(" · "),
          status: status.probe.status,
          imageMissing: status.probe.status === "image-missing",
          repairHint: status.repairHint,
        });
      },
    });

    const service: HostDoctorService = Object.freeze({
      collect: () => collectDoctorChecks(process.env, sources),
    });
    ctx.services.provide(HOST_DOCTOR_CAPABILITY, service);
  });
}

export default createHostDoctorPlugin();
