import type {
  VoiceAudioChunk,
  VoiceRuntimeStatus,
  VoiceSettings,
  VoiceTranscriptionInput,
  VoiceTranscriptionResult,
} from "@friday/voice";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

/** Speech transcription/synthesis semantics exposed to other FRIDAY plugins. */
export interface VoiceService {
  readonly settings: VoiceSettings | undefined;
  transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>;
  synthesize(
    text: string,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<readonly VoiceAudioChunk[]>;
  credentialConfigured(provider: "openai" | "deepgram" | "elevenlabs"): boolean;
  status(): VoiceRuntimeStatus & {
    readonly sttCredentialConfigured: boolean;
    readonly ttsCredentialConfigured: boolean;
  };
}

export const VOICE_CAPABILITY: Capability<VoiceService> = defineCapability<VoiceService>("voice");
