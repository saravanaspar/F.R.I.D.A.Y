import { synthesizeLocal, transcribeLocal } from "./local.js";
export type VoiceSttProvider = "openai" | "deepgram" | "local";
export type VoiceTtsProvider = "openai" | "elevenlabs" | "local";
export type VoiceCredentialProvider = "openai" | "deepgram" | "elevenlabs";
export type VoiceLocalCompute = "cpu" | "cuda";

export const VOICE_EXPRESSION_STYLES = Object.freeze([
  "neutral", "happy", "sad", "angry", "sarcastic", "annoyed", "embarrassed", "tsundere", "playful", "excited", "nervous", "sleepy",
] as const);
export type VoiceExpressionStyle = typeof VOICE_EXPRESSION_STYLES[number];

export const VOICE_EXPRESSION_EVENTS = Object.freeze([
  "laugh", "chuckle", "sigh", "gasp", "groan", "cough", "clear-throat", "shush", "sniff", "tsk",
] as const);
export type VoiceExpressionEvent = typeof VOICE_EXPRESSION_EVENTS[number];

export interface VoiceExpressionRequest {
  /** High-level delivery intent. Exact acoustic rendering remains provider-dependent. */
  readonly style?: VoiceExpressionStyle | undefined;
  /** Ordered non-verbal/paralinguistic events requested around the utterance. */
  readonly events?: readonly VoiceExpressionEvent[] | undefined;
}

export interface VoiceSynthesisOptions {
  readonly signal?: AbortSignal | undefined;
  readonly expression?: VoiceExpressionRequest | undefined;
}

export interface VoiceSttSettings {
  readonly provider: VoiceSttProvider;
  readonly model: string;
  readonly language?: string | undefined;
}

export interface VoiceTtsSettings {
  readonly provider: VoiceTtsProvider;
  readonly model: string;
  readonly voice: string;
  readonly format: "mp3" | "wav";
  /** Private local copy of a reference clip used only by cloning-capable local models. */
  readonly referenceAudio?: string | undefined;
  /** Explicit local accelerator choice. Omitted legacy settings default to CPU. */
  readonly compute?: VoiceLocalCompute | undefined;
}

export interface VoiceSettings {
  readonly schema: 1;
  readonly stt?: VoiceSttSettings | undefined;
  readonly tts?: VoiceTtsSettings | undefined;
}

export interface VoiceTranscriptionInput {
  readonly audio: Uint8Array;
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface VoiceTranscriptionResult {
  readonly text: string;
  readonly provider: VoiceSttProvider;
  readonly model: string;
}

export interface VoiceAudioChunk {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly provider: VoiceTtsProvider;
  readonly model: string;
  readonly voice: string;
}

export interface VoiceRuntimeStatus {
  readonly sttConfigured: boolean;
  readonly ttsConfigured: boolean;
  readonly sttProvider?: VoiceSttProvider | undefined;
  readonly sttModel?: string | undefined;
  readonly ttsProvider?: VoiceTtsProvider | undefined;
  readonly ttsModel?: string | undefined;
  readonly ttsVoice?: string | undefined;
}

export interface VoiceRuntime {
  readonly settings: VoiceSettings | undefined;
  status(): VoiceRuntimeStatus;
  transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>;
  synthesize(text: string, options?: VoiceSynthesisOptions): Promise<readonly VoiceAudioChunk[]>;
}

export interface VoiceRuntimeOptions {
  readonly settings?: VoiceSettings | undefined;
  readonly credential: (provider: VoiceCredentialProvider) => Promise<string | undefined>;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly localRoot?: string | undefined;
  readonly localRunner?: string | undefined;
}

export const OPENAI_STT_MODELS = Object.freeze(["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"] as const);
export const DEEPGRAM_STT_MODELS = Object.freeze(["nova-3", "nova-3-general"] as const);
export const OPENAI_TTS_MODELS = Object.freeze(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const);
export const OPENAI_TTS_VOICES = Object.freeze([
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar",
] as const);
export const ELEVENLABS_TTS_MODELS = Object.freeze(["eleven_multilingual_v2", "eleven_v3"] as const);
export const LOCAL_STT_MODELS = Object.freeze(["tiny-q5_1", "base-q5_1", "small-q5_1"] as const);
export const LOCAL_TTS_MODELS = Object.freeze(["chatterbox-nano", "kitten-nano-int8", "piper"] as const);
export const LOCAL_TTS_VOICES = Object.freeze({
  "chatterbox-nano": ["clone/default"],
  "kitten-nano-int8": ["Jasper", "Luna", "Bella", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"],
  piper: ["en_US-lessac-medium", "en_US-amy-medium", "en_GB-alan-medium"],
} as const);

export const LOCAL_STT_CATALOG = Object.freeze([
  Object.freeze({ id: "tiny-q5_1", label: "Whisper tiny Q5_1", ram: "~300 MB target", accuracy: "fast / basic", disk: "~32 MB model" }),
  Object.freeze({ id: "base-q5_1", label: "Whisper base Q5_1", ram: "~450 MB target", accuracy: "balanced", disk: "~60 MB model" }),
  Object.freeze({ id: "small-q5_1", label: "Whisper small Q5_1", ram: "~900 MB target", accuracy: "best of the low-memory set", disk: "~190 MB model" }),
] as const);

export const LOCAL_TTS_CATALOG = Object.freeze([
  Object.freeze({ id: "chatterbox-nano", label: "Chatterbox Nano 110M", ram: "~0.8-1.0 GB target; host-dependent", cloning: true, expression: true, accuracy: "best expressiveness / clone · ~1.94 GB required model assets" }),
  Object.freeze({ id: "kitten-nano-int8", label: "KittenTTS Nano int8 15M", ram: "well under 500 MB target", cloning: false, expression: false, accuracy: "tiny / efficient" }),
  Object.freeze({ id: "piper", label: "Piper", ram: "typically under 500 MB target", cloning: false, expression: false, accuracy: "fast / robust / Pi-friendly" }),
] as const);

export const DEFAULT_OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_DEEPGRAM_STT_MODEL = "nova-3";
export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_TTS_VOICE = "alloy";
export const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_multilingual_v2";

const VOICE_EXPRESSION_STYLE_SET = new Set<string>(VOICE_EXPRESSION_STYLES);
const VOICE_EXPRESSION_EVENT_SET = new Set<string>(VOICE_EXPRESSION_EVENTS);

function normalizeExpression(value: unknown): VoiceExpressionRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("voice expression must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!new Set(["style", "events"]).has(key)) throw new Error(`unsupported voice expression field: ${key}`);
  let style: VoiceExpressionStyle | undefined;
  if (raw.style !== undefined) {
    if (typeof raw.style !== "string" || !VOICE_EXPRESSION_STYLE_SET.has(raw.style)) throw new Error("voice expression style is unsupported");
    style = raw.style as VoiceExpressionStyle;
  }
  let events: readonly VoiceExpressionEvent[] | undefined;
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || raw.events.length > 8) throw new Error("voice expression events must be an array with at most 8 entries");
    const normalized = raw.events.map((event) => {
      if (typeof event !== "string" || !VOICE_EXPRESSION_EVENT_SET.has(event)) throw new Error("voice expression event is unsupported");
      return event as VoiceExpressionEvent;
    });
    events = Object.freeze(normalized);
  }
  return Object.freeze({ ...(style === undefined ? {} : { style }), ...(events === undefined ? {} : { events }) });
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 128_000;
const MAX_TTS_INPUT_CHARS = 32_000;
const TTS_CHUNK_CHARS = 4_000;
const MAX_ERROR_BODY = 2_000;
const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TTS_CHUNK_BYTES = 16 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 60_000;

function safeText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function optionalLanguage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = safeText(value, "voice language", 64);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) throw new Error("voice language must be a BCP-47-like language code");
  return normalized;
}

function sttProvider(value: unknown): VoiceSttProvider {
  if (value === "openai" || value === "deepgram" || value === "local") return value;
  throw new Error("STT provider must be openai, deepgram, or local");
}

function ttsProvider(value: unknown): VoiceTtsProvider {
  if (value === "openai" || value === "elevenlabs" || value === "local") return value;
  throw new Error("TTS provider must be openai, elevenlabs, or local");
}

export function normalizeVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("voice settings must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 1) throw new Error("unsupported voice settings schema");
  const allowed = new Set(["schema", "stt", "tts"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`unsupported voice settings field: ${key}`);

  let stt: VoiceSttSettings | undefined;
  if (raw.stt !== undefined) {
    if (!raw.stt || typeof raw.stt !== "object" || Array.isArray(raw.stt)) throw new Error("voice STT settings must be an object");
    const entry = raw.stt as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!["provider", "model", "language"].includes(key)) throw new Error(`unsupported voice STT field: ${key}`);
    const language = optionalLanguage(entry.language);
    stt = Object.freeze({
      provider: sttProvider(entry.provider),
      model: safeText(entry.model, "STT model"),
      ...(language === undefined ? {} : { language }),
    });
  }

  let tts: VoiceTtsSettings | undefined;
  if (raw.tts !== undefined) {
    if (!raw.tts || typeof raw.tts !== "object" || Array.isArray(raw.tts)) throw new Error("voice TTS settings must be an object");
    const entry = raw.tts as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!["provider", "model", "voice", "format", "referenceAudio", "compute"].includes(key)) throw new Error(`unsupported voice TTS field: ${key}`);
    const provider = ttsProvider(entry.provider);
    const expectedFormat = provider === "local" ? "wav" : "mp3";
    if (entry.format !== expectedFormat) throw new Error(`voice TTS format must be ${expectedFormat} for ${provider}`);
    const referenceAudio = entry.referenceAudio === undefined ? undefined : safeText(entry.referenceAudio, "TTS reference audio", 4096);
    if (referenceAudio !== undefined && (provider !== "local" || entry.model !== "chatterbox-nano")) {
      throw new Error("TTS referenceAudio is supported only by local chatterbox-nano");
    }
    let compute: VoiceLocalCompute | undefined;
    if (entry.compute !== undefined) {
      if (entry.compute !== "cpu" && entry.compute !== "cuda") throw new Error("voice TTS compute must be cpu or cuda");
      if (provider !== "local" || entry.model !== "chatterbox-nano") throw new Error("voice TTS compute is currently supported only by local chatterbox-nano");
      compute = entry.compute;
    }
    tts = Object.freeze({
      provider,
      model: safeText(entry.model, "TTS model"),
      voice: safeText(entry.voice, "TTS voice", 256),
      format: expectedFormat,
      ...(referenceAudio === undefined ? {} : { referenceAudio }),
      ...(compute === undefined ? {} : { compute }),
    });
  }

  return Object.freeze({ schema: 1, ...(stt === undefined ? {} : { stt }), ...(tts === undefined ? {} : { tts }) });
}

export function defaultSttSettings(provider: VoiceSttProvider): VoiceSttSettings {
  return Object.freeze({
    provider,
    model: provider === "openai" ? DEFAULT_OPENAI_STT_MODEL : provider === "deepgram" ? DEFAULT_DEEPGRAM_STT_MODEL : "base-q5_1",
  });
}

export function defaultTtsSettings(provider: VoiceTtsProvider): VoiceTtsSettings {
  return Object.freeze(provider === "openai"
    ? { provider, model: DEFAULT_OPENAI_TTS_MODEL, voice: DEFAULT_OPENAI_TTS_VOICE, format: "mp3" as const }
    : provider === "elevenlabs"
      ? { provider, model: DEFAULT_ELEVENLABS_TTS_MODEL, voice: "", format: "mp3" as const }
      : { provider, model: "piper", voice: "en_US-lessac-medium", format: "wav" as const });
}

function extensionForMime(mimeType: string | undefined): string {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/mp4" || mime === "audio/m4a" || mime === "audio/x-m4a") return "m4a";
  if (mime === "audio/ogg" || mime === "application/ogg") return "ogg";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/webm") return "webm";
  if (mime === "audio/flac") return "flac";
  return "bin";
}

function normalizedAudioInput(input: VoiceTranscriptionInput): { audio: Uint8Array; mimeType: string; fileName: string } {
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0) throw new Error("voice audio must not be empty");
  if (input.audio.byteLength > MAX_AUDIO_BYTES) throw new Error(`voice audio exceeds ${MAX_AUDIO_BYTES} bytes`);
  const mimeType = input.mimeType?.trim().toLowerCase() || "application/octet-stream";
  if (mimeType.length > 128 || /[\r\n\0]/.test(mimeType)) throw new Error("voice audio MIME type is invalid");
  const fallback = `audio.${extensionForMime(mimeType)}`;
  const candidate = input.fileName?.trim() || fallback;
  const fileName = candidate.replace(/[\\/\0\r\n]/g, "_").slice(0, 240) || fallback;
  return { audio: input.audio, mimeType, fileName };
}

async function requiredCredential(options: VoiceRuntimeOptions, provider: VoiceCredentialProvider): Promise<string> {
  const value = (await options.credential(provider))?.trim();
  if (!value) throw new Error(`Voice credential for ${provider} is not configured`);
  if (value.length > 16_384 || /\s/.test(value)) throw new Error(`Voice credential for ${provider} is invalid`);
  return value;
}

function requiredLocalRoot(options: VoiceRuntimeOptions): string {
  const root = options.localRoot?.trim();
  if (!root) throw new Error("Local voice runtime root is not configured");
  return root;
}

function providerSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function readBoundedBytes(response: Response, maximum: number, label: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maximum) throw new Error(`${label} exceeds FRIDAY response limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximum) {
        const limitError = new Error(`${label} exceeds FRIDAY response limit`);
        try {
          await reader.cancel();
        } catch (cancelError) {
          throw new AggregateError([limitError, cancelError], `${label} exceeded the response limit and stream cancellation failed`);
        }
        throw limitError;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readBoundedJson<T>(response: Response, label: string): Promise<T> {
  const bytes = await readBoundedBytes(response, MAX_PROVIDER_JSON_BYTES, label);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

async function errorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_ERROR_BODY - total;
      chunks.push(value.subarray(0, remaining));
      total += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining || total >= MAX_ERROR_BODY) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    return "";
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes).replace(/[\r\n\0]+/g, " ").slice(0, MAX_ERROR_BODY);
}

async function assertOk(response: Response, provider: string, operation: string): Promise<Response> {
  if (response.ok) return response;
  const detail = await errorBody(response);
  throw new Error(`${provider} ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

function audioResponseMimeType(response: Response, provider: string): string {
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "audio/mpeg";
  if (!mimeType.startsWith("audio/")) throw new Error(`${provider} speech synthesis returned a non-audio response`);
  return mimeType;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function transcribeOpenAI(options: VoiceRuntimeOptions, settings: VoiceSttSettings, input: VoiceTranscriptionInput): Promise<string> {
  const credential = await requiredCredential(options, "openai");
  const audio = normalizedAudioInput(input);
  const form = new FormData();
  form.set("file", new Blob([ownedArrayBuffer(audio.audio)], { type: audio.mimeType }), audio.fileName);
  form.set("model", settings.model);
  if (settings.language) form.set("language", settings.language);
  const response = await (options.fetch ?? globalThis.fetch)("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}` },
    body: form,
    signal: providerSignal(input.signal),
  });
  await assertOk(response, "OpenAI", "transcription");
  const body = await readBoundedJson<{ text?: unknown }>(response, "OpenAI transcription response");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new Error("OpenAI transcription exceeds FRIDAY transcript limit");
  return text;
}

async function transcribeDeepgram(options: VoiceRuntimeOptions, settings: VoiceSttSettings, input: VoiceTranscriptionInput): Promise<string> {
  const credential = await requiredCredential(options, "deepgram");
  const audio = normalizedAudioInput(input);
  const endpoint = new URL("https://api.deepgram.com/v1/listen");
  endpoint.searchParams.set("model", settings.model);
  endpoint.searchParams.set("smart_format", "true");
  if (settings.language) endpoint.searchParams.set("language", settings.language);
  const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Token ${credential}`,
      "Content-Type": audio.mimeType,
    },
    body: ownedArrayBuffer(audio.audio),
    signal: providerSignal(input.signal),
  });
  await assertOk(response, "Deepgram", "transcription");
  const body = await readBoundedJson<{
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> };
  }>(response, "Deepgram transcription response");
  const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  const text = typeof transcript === "string" ? transcript.trim() : "";
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new Error("Deepgram transcription exceeds FRIDAY transcript limit");
  return text;
}

function chunkSpeechText(textInput: string): readonly string[] {
  const text = textInput.trim();
  if (!text) throw new Error("TTS text must not be empty");
  if (text.length > MAX_TTS_INPUT_CHARS) throw new Error(`TTS text exceeds ${MAX_TTS_INPUT_CHARS} characters`);
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TTS_CHUNK_CHARS) {
    const window = remaining.slice(0, TTS_CHUNK_CHARS + 1);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf(" ")];
    const cut = Math.max(...candidates);
    const index = cut >= Math.floor(TTS_CHUNK_CHARS * 0.5) ? cut + 1 : TTS_CHUNK_CHARS;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return Object.freeze(chunks);
}

async function synthesizeOpenAI(options: VoiceRuntimeOptions, settings: VoiceTtsSettings, text: string, signal?: AbortSignal): Promise<VoiceAudioChunk> {
  const credential = await requiredCredential(options, "openai");
  const response = await (options.fetch ?? globalThis.fetch)("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model, input: text, voice: settings.voice, response_format: settings.format }),
    signal: providerSignal(signal),
  });
  await assertOk(response, "OpenAI", "speech synthesis");
  const mimeType = audioResponseMimeType(response, "OpenAI");
  const bytes = await readBoundedBytes(response, MAX_TTS_CHUNK_BYTES, "OpenAI speech synthesis response");
  if (bytes.byteLength === 0) throw new Error("OpenAI speech synthesis returned empty audio");
  return Object.freeze({ bytes, mimeType, provider: "openai", model: settings.model, voice: settings.voice });
}

async function synthesizeElevenLabs(options: VoiceRuntimeOptions, settings: VoiceTtsSettings, text: string, signal?: AbortSignal): Promise<VoiceAudioChunk> {
  const credential = await requiredCredential(options, "elevenlabs");
  const endpoint = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voice)}`);
  endpoint.searchParams.set("output_format", "mp3_44100_128");
  const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
    method: "POST",
    headers: { "xi-api-key": credential, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: settings.model }),
    signal: providerSignal(signal),
  });
  await assertOk(response, "ElevenLabs", "speech synthesis");
  const mimeType = audioResponseMimeType(response, "ElevenLabs");
  const bytes = await readBoundedBytes(response, MAX_TTS_CHUNK_BYTES, "ElevenLabs speech synthesis response");
  if (bytes.byteLength === 0) throw new Error("ElevenLabs speech synthesis returned empty audio");
  return Object.freeze({ bytes, mimeType, provider: "elevenlabs", model: settings.model, voice: settings.voice });
}

export function createVoiceRuntime(options: VoiceRuntimeOptions): VoiceRuntime {
  const settings = options.settings === undefined ? undefined : normalizeVoiceSettings(options.settings);
  return Object.freeze({
    settings,
    status(): VoiceRuntimeStatus {
      return Object.freeze({
        sttConfigured: settings?.stt !== undefined,
        ttsConfigured: settings?.tts !== undefined,
        ...(settings?.stt === undefined ? {} : { sttProvider: settings.stt.provider, sttModel: settings.stt.model }),
        ...(settings?.tts === undefined ? {} : { ttsProvider: settings.tts.provider, ttsModel: settings.tts.model, ttsVoice: settings.tts.voice }),
      });
    },
    async transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult> {
      const stt = settings?.stt;
      if (!stt) throw new Error("Voice STT is not configured; run `friday setup voice`");
      const text = stt.provider === "openai"
        ? await transcribeOpenAI(options, stt, input)
        : stt.provider === "deepgram"
          ? await transcribeDeepgram(options, stt, input)
          : await transcribeLocal({
              localRoot: requiredLocalRoot(options),
              ...(options.localRunner === undefined ? {} : { localRunner: options.localRunner }),
            }, stt, input);
      return Object.freeze({ text, provider: stt.provider, model: stt.model });
    },
    async synthesize(text: string, synthOptions: VoiceSynthesisOptions = {}): Promise<readonly VoiceAudioChunk[]> {
      const tts = settings?.tts;
      if (!tts) throw new Error("Voice TTS is not configured; run `friday setup voice`");
      const expression = normalizeExpression(synthOptions.expression);
      const hasExpression = expression !== undefined && (expression.style !== undefined && expression.style !== "neutral" || (expression.events?.length ?? 0) > 0);
      if (hasExpression && (tts.provider !== "local" || tts.model !== "chatterbox-nano")) {
        throw new Error("The selected TTS backend does not support FRIDAY expression intents; choose local chatterbox-nano or omit expression");
      }
      const chunks: VoiceAudioChunk[] = [];
      for (const part of chunkSpeechText(text)) {
        chunks.push(tts.provider === "openai"
          ? await synthesizeOpenAI(options, tts, part, synthOptions.signal)
          : tts.provider === "elevenlabs"
            ? await synthesizeElevenLabs(options, tts, part, synthOptions.signal)
            : await synthesizeLocal({
                localRoot: requiredLocalRoot(options),
                ...(options.localRunner === undefined ? {} : { localRunner: options.localRunner }),
              }, tts, part, synthOptions.signal, expression));
      }
      return Object.freeze(chunks);
    },
  });
}

/** Generate a small valid PCM WAV used only for provider setup/preflight. */
export function createVoiceProbeWav(durationMs = 350): Uint8Array {
  if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 2_000) throw new Error("voice probe duration is invalid");
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * durationMs / 1_000);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
}
