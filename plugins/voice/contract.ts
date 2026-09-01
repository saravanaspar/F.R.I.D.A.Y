import type { VoiceRuntime, VoiceRuntimeStatus } from "@friday/voice";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface VoiceService extends VoiceRuntime {
  credentialConfigured(provider: "openai" | "deepgram" | "elevenlabs"): boolean;
  status(): VoiceRuntimeStatus & {
    readonly sttCredentialConfigured: boolean;
    readonly ttsCredentialConfigured: boolean;
  };
}

export const VOICE_CAPABILITY: Capability<VoiceService> = defineCapability<VoiceService>("voice");
