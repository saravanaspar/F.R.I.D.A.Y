import {
  createVoiceProbeWav,
  createVoiceRuntime,
  DEEPGRAM_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  type VoiceCredentialProvider,
  type VoiceSettings,
  type VoiceSttProvider,
  type VoiceTtsProvider,
} from "@friday/voice";
import { modelCredentialVaultRef } from "../plugins/auth/model-credential-ref.js";
import { getFridayHome } from "../plugins/runtime-settings/runtime-env.js";
import { voiceCredentialVaultRef } from "../plugins/voice/credential-ref.js";
import { readVoiceSettings, saveVoiceSettings } from "../plugins/voice/settings.js";
import type { OnboardingIO } from "./onboarding.js";
import { createTerminalOnboardingIO } from "./terminal-setup-ui.js";

export interface VoiceSetupOptions {
  readonly home?: string | undefined;
  readonly io?: OnboardingIO | undefined;
  readonly verify?: ((settings: VoiceSettings, credential: (provider: VoiceCredentialProvider) => Promise<string | undefined>) => Promise<void>) | undefined;
}

function showInfo(io: OnboardingIO, message: string): void { io.info ? io.info(message) : io.write(`${message}\n`); }
function showSuccess(io: OnboardingIO, message: string): void { io.success ? io.success(message) : io.write(`${message} ✓\n`); }
function showWarning(io: OnboardingIO, message: string): void { io.warning ? io.warning(message) : io.write(`${message}\n`); }
async function task<T>(io: OnboardingIO, message: string, operation: () => Promise<T>): Promise<T> { return io.runTask ? io.runTask(message, operation) : operation(); }

async function select(io: OnboardingIO, message: string, choices: readonly { value: string; label: string; hint?: string }[], initialValue?: string): Promise<string> {
  if (io.select) return io.select({ message, choices, ...(initialValue === undefined ? {} : { initialValue }) });
  if (!io.isInteractive) return initialValue ?? choices[0]!.value;
  io.write(`${message}\n`);
  choices.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}${choice.hint ? ` - ${choice.hint}` : ""}\n`));
  for (;;) {
    const answer = (await io.question(`Choose 1-${choices.length}: `)).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index]!.value;
    const direct = choices.find((choice) => choice.value === answer);
    if (direct) return direct.value;
  }
}

async function text(io: OnboardingIO, message: string, initialValue?: string): Promise<string> {
  return io.text ? io.text(message, initialValue) : io.question(`${message}${initialValue ? ` [${initialValue}]` : ""}: `).then((value) => value.trim() || initialValue || "");
}

async function confirm(io: OnboardingIO, message: string, initialValue = false): Promise<boolean> {
  if (io.confirm) return io.confirm(message, initialValue);
  const answer = (await io.question(`${message} [${initialValue ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
  return answer ? answer === "y" || answer === "yes" : initialValue;
}

function strictApiKey(value: string): string {
  const token = value.trim();
  if (!token || token.length > 16_384) throw new Error("API key is empty or too long");
  if (/\s/.test(token)) throw new Error("API key must be entered by itself without spaces or extra text");
  if (/^(?:api[_ -]?key|key|token|bearer)\s*[:=]/i.test(token) || /[`'\"]/.test(token)) throw new Error("Enter only the API key value; do not include a label, quotes, or code fences");
  return token;
}

function credentialRef(provider: VoiceCredentialProvider): string {
  return provider === "openai" ? modelCredentialVaultRef("openai") : voiceCredentialVaultRef(provider);
}

function credentialKind(provider: VoiceCredentialProvider): string {
  return provider === "openai" ? "model-api-key" : "voice-api-key";
}

async function chooseStt(io: OnboardingIO, existing: VoiceSettings | undefined): Promise<VoiceSettings["stt"]> {
  const providerValue = await select(io, "Speech-to-text provider", [
    { value: "openai", label: "OpenAI", hint: "gpt-4o transcription models" },
    { value: "deepgram", label: "Deepgram", hint: "Nova speech recognition" },
    { value: "disabled", label: "Disabled", hint: "do not transcribe audio" },
  ], existing?.stt?.provider ?? "openai");
  if (providerValue === "disabled") return undefined;
  const provider = providerValue as VoiceSttProvider;
  const models = provider === "openai" ? OPENAI_STT_MODELS : DEEPGRAM_STT_MODELS;
  const defaultModel = existing?.stt?.provider === provider ? existing.stt.model : models[0]!;
  const model = await select(io, "Speech-to-text model", models.map((value) => ({ value, label: value })), defaultModel);
  const languageRaw = (await text(io, "Language code (`auto` for detection)", existing?.stt?.language ?? "auto")).trim();
  const language = languageRaw.toLowerCase() === "auto" || !languageRaw ? undefined : languageRaw;
  return Object.freeze({ provider, model, ...(language === undefined ? {} : { language }) });
}

async function chooseTts(io: OnboardingIO, existing: VoiceSettings | undefined): Promise<VoiceSettings["tts"]> {
  const providerValue = await select(io, "Text-to-speech provider", [
    { value: "openai", label: "OpenAI", hint: "gpt-4o-mini-tts" },
    { value: "elevenlabs", label: "ElevenLabs", hint: "multilingual voice synthesis" },
    { value: "disabled", label: "Disabled", hint: "text replies only" },
  ], existing?.tts?.provider ?? "openai");
  if (providerValue === "disabled") return undefined;
  const provider = providerValue as VoiceTtsProvider;
  const models = provider === "openai" ? OPENAI_TTS_MODELS : ELEVENLABS_TTS_MODELS;
  const defaultModel = existing?.tts?.provider === provider ? existing.tts.model : models[0]!;
  const model = await select(io, "Text-to-speech model", models.map((value) => ({ value, label: value })), defaultModel);
  let voice: string;
  if (provider === "openai") {
    const defaultVoice = existing?.tts?.provider === provider ? existing.tts.voice : "alloy";
    voice = await select(io, "Voice", OPENAI_TTS_VOICES.map((value) => ({ value, label: value })), defaultVoice);
  } else {
    const current = existing?.tts?.provider === provider ? existing.tts.voice : undefined;
    voice = (await text(io, "ElevenLabs voice ID", current)).trim();
    if (!voice) throw new Error("ElevenLabs voice ID is required");
  }
  return Object.freeze({ provider, model, voice, format: "mp3" as const });
}

async function defaultVerify(settings: VoiceSettings, credential: (provider: VoiceCredentialProvider) => Promise<string | undefined>): Promise<void> {
  const runtime = createVoiceRuntime({ settings, credential });
  if (settings.stt) {
    await runtime.transcribe({ audio: createVoiceProbeWav(), mimeType: "audio/wav", fileName: "friday-voice-probe.wav" });
  }
  if (settings.tts) {
    const chunks = await runtime.synthesize("FRIDAY voice setup test.");
    if (chunks.length === 0 || chunks.some((chunk) => chunk.bytes.byteLength === 0)) throw new Error("Voice TTS provider returned no audio");
  }
}

export async function runVoiceSetup(options: VoiceSetupOptions = {}): Promise<VoiceSettings> {
  const home = options.home ?? getFridayHome(process.env);
  const io = options.io ?? createTerminalOnboardingIO();
  const existing = await readVoiceSettings(home);
  io.intro?.("FRIDAY · Voice", "Configure speech-to-text and text-to-speech. Provider keys are masked, verified, and stored only in Vault.");

  const stt = await chooseStt(io, existing);
  const tts = await chooseTts(io, existing);
  if (!stt && !tts) showWarning(io, "Both STT and TTS are disabled; voice settings will remain installed but inactive.");
  const candidate: VoiceSettings = Object.freeze({ schema: 1, ...(stt === undefined ? {} : { stt }), ...(tts === undefined ? {} : { tts }) });

  const vaultModule = await import("@friday/vault");
  const store = new vaultModule.VaultStore({
    stateDir: vaultModule.getVaultStateDir({ ...process.env, FRIDAY_HOME: home }),
    workspaceRoot: process.cwd(),
  });
  const neededProviders = new Set<VoiceCredentialProvider>();
  if (stt) neededProviders.add(stt.provider);
  if (tts) neededProviders.add(tts.provider);
  const pending = new Map<VoiceCredentialProvider, Uint8Array>();

  try {
    for (const provider of neededProviders) {
      const ref = credentialRef(provider);
      const exists = store.exists(ref);
      showInfo(io, `${provider} credential · ${exists ? "stored securely in Vault" : "not configured"}`);
      const replace = exists ? await confirm(io, `Replace the saved ${provider} API key?`, false) : true;
      if (!replace) continue;
      if (!io.isInteractive) throw new Error(`${provider} voice credential is missing and setup is not interactive`);
      for (;;) {
        const raw = io.secretQuestion ? await io.secretQuestion(`${provider} API key (input hidden): `) : await io.question(`${provider} API key: `);
        try {
          const token = strictApiKey(raw);
          pending.set(provider, Buffer.from(token, "utf8"));
          break;
        } catch (error) {
          showWarning(io, error instanceof Error ? error.message : String(error));
        }
      }
    }

    const resolveCredential = async (provider: VoiceCredentialProvider): Promise<string | undefined> => {
      const pendingSecret = pending.get(provider);
      if (pendingSecret) return Buffer.from(pendingSecret).toString("utf8");
      const ref = credentialRef(provider);
      if (!store.exists(ref)) return undefined;
      let value: string | undefined;
      await store.consume(ref, (secret) => { value = Buffer.from(secret).toString("utf8"); });
      return value;
    };

    await task(io, "Verifying voice providers", () => (options.verify ?? defaultVerify)(candidate, resolveCredential));

    for (const [provider, secret] of pending) {
      const ref = credentialRef(provider);
      if (store.exists(ref)) store.rotate(ref, secret);
      else store.create({ ref, kind: credentialKind(provider), secret });
    }
    const saved = await saveVoiceSettings(candidate, home);
    showSuccess(io, "Voice configuration verified and saved");
    io.outro?.("Voice ready", [
      saved.stt ? `STT · ${saved.stt.provider}/${saved.stt.model}` : "STT · disabled",
      saved.tts ? `TTS · ${saved.tts.provider}/${saved.tts.model} · ${saved.tts.voice}` : "TTS · disabled",
      "Restart FRIDAY if it is currently running so the Voice plugin reloads these settings.",
    ]);
    return saved;
  } finally {
    for (const secret of pending.values()) secret.fill(0);
    io.close?.();
  }
}
