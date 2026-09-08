import type {
  VoiceAudioChunk,
  VoiceRuntimeStatus,
  VoiceSettings,
  VoiceSynthesisOptions,
  VoiceTranscriptionInput,
  VoiceTranscriptionResult,
  VoiceSttProvider,
  VoiceTtsProvider,
} from "@friday/voice";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

/** Speech transcription/synthesis semantics exposed to other FRIDAY plugins. */
export interface VoiceService {
  readonly settings: VoiceSettings | undefined;
  transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>;
  synthesize(
    text: string,
    options?: VoiceSynthesisOptions,
  ): Promise<readonly VoiceAudioChunk[]>;
  credentialConfigured(provider: VoiceSttProvider | VoiceTtsProvider): boolean;
  status(): VoiceRuntimeStatus & {
    readonly sttCredentialConfigured: boolean;
    readonly ttsCredentialConfigured: boolean;
  };
}

export const VOICE_CAPABILITY: Capability<VoiceService> = defineCapability<VoiceService>("voice");

export type { VoiceSettings } from "@friday/voice";
