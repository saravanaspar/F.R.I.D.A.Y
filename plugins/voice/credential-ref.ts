import type { VoiceCredentialProvider } from "@friday/voice";

export function voiceCredentialVaultRef(provider: VoiceCredentialProvider): string {
  if (provider === "deepgram") return "vault://voice/deepgram/api-key";
  if (provider === "elevenlabs") return "vault://voice/elevenlabs/api-key";
  throw new Error("OpenAI voice credentials use the canonical model-provider Vault ref");
}
