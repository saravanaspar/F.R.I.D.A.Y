import { stat } from "node:fs/promises";
import {
  createVoiceProbeWav,
  createVoiceRuntime,
  DEEPGRAM_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
  LOCAL_STT_CATALOG,
  LOCAL_STT_MODELS,
  LOCAL_TTS_CATALOG,
  LOCAL_TTS_MODELS,
  LOCAL_TTS_VOICES,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  type VoiceCredentialProvider,
  type VoiceLocalCompute,
  type VoiceSettings,
  type VoiceSttProvider,
  type VoiceTtsProvider,
} from "@friday/voice";
import { modelCredentialVaultRef } from "../plugins/auth/model-credential-ref.js";
import { getFridayHome, getFridayWorkspace } from "../plugins/runtime-settings/runtime-env.js";
import { voiceCredentialVaultRef } from "../plugins/voice/credential-ref.js";
import { readVoiceSettings, saveVoiceSettings } from "../plugins/voice/settings.js";
import { hasFridayPrivilegedHelper, installFridayPrivilegeBroker, installVoiceHostDependencies } from "./privileged-setup.js";
import {
  detectLocalVoiceGpu,
  localVoiceToolingRoot,
  missingLocalVoiceHostDependencies,
  provisionLocalVoice,
  stageLocalVoiceReference,
  type LocalVoiceGpuInfo,
} from "./voice-local-setup.js";
import type { OnboardingIO } from "./onboarding.js";
import { createTerminalOnboardingIO } from "./terminal-setup-ui.js";

export interface VoiceSetupOptions {
  readonly home?: string | undefined;
  readonly io?: OnboardingIO | undefined;
  readonly verify?: ((settings: VoiceSettings, credential: (provider: VoiceCredentialProvider) => Promise<string | undefined>) => Promise<void>) | undefined;
  readonly provisionLocal?: ((settings: VoiceSettings, home: string) => Promise<void>) | undefined;
  readonly ensureLocalHostDependencies?: ((settings: VoiceSettings, home: string, io: OnboardingIO) => Promise<void>) | undefined;
  readonly detectLocalGpu?: (() => LocalVoiceGpuInfo | undefined) | undefined;
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
    { value: "local", label: "Local / offline", hint: "quantized OpenAI Whisper via whisper.cpp; no API key" },
    { value: "openai", label: "OpenAI", hint: "hosted gpt-4o transcription models" },
    { value: "deepgram", label: "Deepgram", hint: "hosted Nova speech recognition" },
    { value: "disabled", label: "Disabled", hint: "do not transcribe audio" },
  ], existing?.stt?.provider ?? "openai");
  if (providerValue === "disabled") return undefined;
  const provider = providerValue as VoiceSttProvider;
  const models = provider === "openai" ? OPENAI_STT_MODELS : provider === "deepgram" ? DEEPGRAM_STT_MODELS : LOCAL_STT_MODELS;
  const defaultModel = existing?.stt?.provider === provider ? existing.stt.model : provider === "local" ? "base-q5_1" : models[0]!;
  const choices = provider === "local"
    ? LOCAL_STT_CATALOG.map((entry) => ({ value: entry.id, label: entry.label, hint: `${entry.ram} · ${entry.accuracy} · ${entry.disk}` }))
    : models.map((value) => ({ value, label: value }));
  const model = await select(io, provider === "local" ? "Local speech-to-text model" : "Speech-to-text model", choices, defaultModel);
  if (provider === "local") {
    showInfo(io, "Local STT uses OpenAI Whisper weights converted/quantized for whisper.cpp. RAM figures are setup guidance, not hard process limits.");
  }
  const languageRaw = (await text(io, "Language code (`auto` for detection)", existing?.stt?.language ?? "auto")).trim();
  const language = languageRaw.toLowerCase() === "auto" || !languageRaw ? undefined : languageRaw;
  return Object.freeze({ provider, model, ...(language === undefined ? {} : { language }) });
}

async function chooseTts(io: OnboardingIO, existing: VoiceSettings | undefined, home: string, detectGpu: () => LocalVoiceGpuInfo | undefined): Promise<VoiceSettings["tts"]> {
  const providerValue = await select(io, "Text-to-speech provider", [
    { value: "local", label: "Local / offline", hint: "3 low-memory choices; no API key" },
    { value: "openai", label: "OpenAI", hint: "hosted gpt-4o-mini-tts" },
    { value: "elevenlabs", label: "ElevenLabs", hint: "hosted multilingual voice synthesis" },
    { value: "disabled", label: "Disabled", hint: "text replies only" },
  ], existing?.tts?.provider ?? "openai");
  if (providerValue === "disabled") return undefined;
  const provider = providerValue as VoiceTtsProvider;
  const models = provider === "openai" ? OPENAI_TTS_MODELS : provider === "elevenlabs" ? ELEVENLABS_TTS_MODELS : LOCAL_TTS_MODELS;
  const defaultModel = existing?.tts?.provider === provider ? existing.tts.model : provider === "local" ? "piper" : models[0]!;
  const choices = provider === "local"
    ? LOCAL_TTS_CATALOG.map((entry) => ({
        value: entry.id,
        label: entry.label,
        hint: `${entry.ram} · clone ${entry.cloning ? "yes" : "no"} · expression ${entry.expression ? "yes" : "no"} · ${entry.accuracy}`,
      }))
    : models.map((value) => ({ value, label: value }));
  const model = await select(io, provider === "local" ? "Local text-to-speech model" : "Text-to-speech model", choices, defaultModel);

  if (provider === "openai") {
    const defaultVoice = existing?.tts?.provider === provider ? existing.tts.voice : "alloy";
    const voice = await select(io, "Voice", OPENAI_TTS_VOICES.map((value) => ({ value, label: value })), defaultVoice);
    return Object.freeze({ provider, model, voice, format: "mp3" as const });
  }
  if (provider === "elevenlabs") {
    const current = existing?.tts?.provider === provider ? existing.tts.voice : undefined;
    const voice = (await text(io, "ElevenLabs voice ID", current)).trim();
    if (!voice) throw new Error("ElevenLabs voice ID is required");
    return Object.freeze({ provider, model, voice, format: "mp3" as const });
  }

  const localModel = model as keyof typeof LOCAL_TTS_VOICES;
  const voices = LOCAL_TTS_VOICES[localModel];
  const currentVoice = existing?.tts?.provider === "local" && existing.tts.model === model ? existing.tts.voice : voices[0]!;
  const voice = voices.length === 1 ? voices[0]! : await select(io, "Local voice", voices.map((value) => ({ value, label: value })), currentVoice);
  if (model !== "chatterbox-nano") return Object.freeze({ provider, model, voice, format: "wav" as const });

  const gpu = detectGpu();
  const existingCompute = existing?.tts?.provider === "local" && existing.tts.model === model ? existing.tts.compute : undefined;
  let compute: VoiceLocalCompute = "cpu";
  if (gpu) {
    compute = await select(io, "Chatterbox compute backend", [
      { value: "cpu", label: "CPU", hint: "default; installs CPU-only PyTorch and never downloads NVIDIA/CUDA wheels" },
      { value: "cuda", label: `NVIDIA GPU · ${gpu.name}`, hint: "opt-in; installs CUDA 12.6 PyTorch runtime wheels (large download); does not install an OS GPU driver" },
    ], existingCompute ?? "cpu") as VoiceLocalCompute;
  } else {
    showInfo(io, "No usable NVIDIA CUDA GPU was detected; Chatterbox will use CPU-only PyTorch.");
  }

  showInfo(io, "Chatterbox Nano supports zero-shot voice cloning plus FRIDAY expression intents such as laugh, chuckle, sigh, angry/annoyed cues, tsundere, gasp, groan, and tsk. Voice identity stays separate from expression. Use a clean reference clip longer than 5 seconds for cloning. Its 110M model targets the 0.8–1.0 GB class, but Python/PyTorch overhead can make peak RSS host-dependent.");
  const existingReference = existing?.tts?.provider === "local" && existing.tts.model === model ? existing.tts.referenceAudio : undefined;
  const referenceInput = (await text(io, "Optional reference voice clip path (leave blank for default voice)", existingReference)).trim();
  if (!referenceInput) return Object.freeze({ provider, model, voice, format: "wav" as const, compute });
  const info = await stat(referenceInput);
  if (!info.isFile()) throw new Error("Voice reference must be a regular file");
  if (info.size <= 0 || info.size > 20 * 1024 * 1024) throw new Error("Voice reference must be between 1 byte and 20 MiB");
  const referenceAudio = await stageLocalVoiceReference(referenceInput, home);
  return Object.freeze({ provider, model, voice, format: "wav" as const, compute, referenceAudio });
}

async function defaultEnsureLocalHostDependencies(settings: VoiceSettings, _home: string, io: OnboardingIO): Promise<void> {
  const missing = missingLocalVoiceHostDependencies(settings);
  if (missing.length === 0) return;
  if (process.platform !== "linux") {
    throw new Error(`Local voice is missing host dependencies: ${missing.join(", ")}. Automatic installation is currently supported on Debian/Ubuntu hosts only.`);
  }

  showWarning(io, `Local voice needs host dependencies: ${missing.join(", ")}. FRIDAY will install its fixed approved dependency set automatically.`);
  if (!(await hasFridayPrivilegedHelper())) {
    if (!io.isInteractive) {
      throw new Error(`Local voice is missing host dependencies: ${missing.join(", ")}. Run \`friday setup voice\` once in an interactive local terminal so FRIDAY can bootstrap its restricted privilege broker.`);
    }
    showInfo(io, "A local sudo prompt may appear while FRIDAY installs its restricted voice-dependency broker. The password is handled by sudo, not by FRIDAY or the model.");
    await task(io, "Installing FRIDAY privilege broker", () => installFridayPrivilegeBroker());
  }

  await task(io, "Installing required local voice host dependencies", () => installVoiceHostDependencies());
  const after = missingLocalVoiceHostDependencies(settings);
  if (after.length > 0) throw new Error(`Voice host dependency installation completed but these commands are still unavailable: ${after.join(", ")}`);
}

async function defaultVerify(settings: VoiceSettings, credential: (provider: VoiceCredentialProvider) => Promise<string | undefined>, home: string): Promise<void> {
  const runtime = createVoiceRuntime({ settings, credential, localRoot: localVoiceToolingRoot(home) });
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
  io.intro?.("FRIDAY · Voice", "Configure hosted or private local speech. Local choices are provisioned automatically; remote keys are masked, verified, and stored only in Vault.");

  const stt = await chooseStt(io, existing);
  const tts = await chooseTts(io, existing, home, options.detectLocalGpu ?? detectLocalVoiceGpu);
  if (!stt && !tts) showWarning(io, "Both STT and TTS are disabled; voice settings will remain installed but inactive.");
  const candidate: VoiceSettings = Object.freeze({ schema: 1, ...(stt === undefined ? {} : { stt }), ...(tts === undefined ? {} : { tts }) });

  const vaultModule = await import("@friday/vault");
  const store = new vaultModule.VaultStore({
    stateDir: vaultModule.getVaultStateDir({ ...process.env, FRIDAY_HOME: home }),
    workspaceRoot: getFridayWorkspace({ ...process.env, FRIDAY_HOME: home }),
  });
  const neededProviders = new Set<VoiceCredentialProvider>();
  if (stt?.provider !== undefined && stt.provider !== "local") neededProviders.add(stt.provider);
  if (tts?.provider !== undefined && tts.provider !== "local") neededProviders.add(tts.provider);
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

    const hasLocal = stt?.provider === "local" || tts?.provider === "local";
    if (hasLocal) {
      await (options.ensureLocalHostDependencies ?? defaultEnsureLocalHostDependencies)(candidate, home, io);
      await task(io, "Provisioning selected local voice model(s)", () => (options.provisionLocal ?? provisionLocalVoice)(candidate, home));
    }
    const verifier = options.verify ?? ((settings: VoiceSettings, credential: (provider: VoiceCredentialProvider) => Promise<string | undefined>) => defaultVerify(settings, credential, home));
    await task(io, "Verifying voice providers", () => verifier(candidate, resolveCredential));

    for (const [provider, secret] of pending) {
      const ref = credentialRef(provider);
      if (store.exists(ref)) store.rotate(ref, secret);
      else store.create({ ref, kind: credentialKind(provider), secret });
    }
    const saved = await saveVoiceSettings(candidate, home);
    showSuccess(io, "Voice configuration verified and saved");
    io.outro?.("Voice ready", [
      saved.stt ? `STT · ${saved.stt.provider}/${saved.stt.model}` : "STT · disabled",
      saved.tts ? `TTS · ${saved.tts.provider}/${saved.tts.model} · ${saved.tts.voice}${saved.tts.provider === "local" && saved.tts.model === "chatterbox-nano" ? ` · ${saved.tts.compute ?? "cpu"}` : ""}` : "TTS · disabled",
      "Restart FRIDAY if it is currently running so the Voice plugin reloads these settings.",
    ]);
    return saved;
  } finally {
    for (const secret of pending.values()) secret.fill(0);
    io.close?.();
  }
}
