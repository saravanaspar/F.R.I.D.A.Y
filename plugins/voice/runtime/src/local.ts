import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { VoiceAudioChunk, VoiceExpressionRequest, VoiceExpressionStyle, VoiceSttSettings, VoiceTranscriptionInput, VoiceTtsSettings } from "./index.js";

const MAX_LOCAL_PROCESS_OUTPUT = 32_000;
const LOCAL_PROCESS_TIMEOUT_MS = 180_000;
const MAX_LOCAL_AUDIO_BYTES = 32 * 1024 * 1024;
const LOCAL_PROCESS_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SYSTEMROOT",
  "WINDIR",
] as const);

export interface LocalVoiceRuntimeOptions {
  readonly localRoot: string;
  readonly localRunner?: string | undefined;
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_LOCAL_PROCESS_OUTPUT ? next : next.slice(-MAX_LOCAL_PROCESS_OUTPUT);
}

function localProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1" };
  for (const name of LOCAL_PROCESS_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function runProcess(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolveRun, rejectRun) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`local voice process timed out after ${LOCAL_PROCESS_TIMEOUT_MS}ms`)), LOCAL_PROCESS_TIMEOUT_MS);
    const onAbort = () => controller.abort(signal?.reason ?? new Error("local voice request aborted"));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    let stdout = "";
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: controller.signal,
      // Never leak FRIDAY/Vault/API-key environment variables into local model
      // subprocesses. They receive only the OS/runtime variables required to run.
      env: { ...localProcessEnv(), ...envOverrides },
    });
    child.stdout?.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => { cleanup(); rejectRun(error); });
    child.once("exit", (code, childSignal) => {
      cleanup();
      if (code === 0) resolveRun();
      else rejectRun(new Error(`local voice process failed${childSignal ? ` with ${childSignal}` : ` with exit code ${code ?? "unknown"}`}${stderr || stdout ? `: ${(stderr || stdout).trim()}` : ""}`));
    });
  });
}

function inputExtension(input: VoiceTranscriptionInput): string {
  const fileExt = input.fileName ? extname(input.fileName).replace(/^\./, "").toLowerCase() : "";
  if (/^[a-z0-9]{1,8}$/.test(fileExt)) return fileExt;
  const mime = input.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/webm") return "webm";
  if (mime === "audio/flac") return "flac";
  if (mime === "audio/mp4" || mime === "audio/m4a") return "m4a";
  return "audio";
}

function whisperBinary(localRoot: string): string {
  const source = join(resolve(localRoot), "whisper.cpp", "source", "build", "bin");
  const unix = join(source, "whisper-cli");
  if (existsSync(unix)) return unix;
  const win = join(source, "Release", "whisper-cli.exe");
  if (existsSync(win)) return win;
  throw new Error("Local Whisper executable is not installed; run `friday setup voice`");
}

export async function transcribeLocal(
  options: LocalVoiceRuntimeOptions,
  settings: VoiceSttSettings,
  input: VoiceTranscriptionInput,
): Promise<string> {
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0 || input.audio.byteLength > MAX_LOCAL_AUDIO_BYTES) {
    throw new Error("local voice audio is empty or exceeds the local input limit");
  }
  const root = resolve(options.localRoot);
  const model = join(root, "whisper.cpp", "models", `ggml-${settings.model}.bin`);
  if (!existsSync(model)) throw new Error(`Local Whisper model ${settings.model} is not installed; run \`friday setup voice\``);
  const scratch = await mkdtemp(join(tmpdir(), "friday-stt-"));
  try {
    const inputPath = join(scratch, `input.${inputExtension(input)}`);
    const wavPath = join(scratch, "normalized.wav");
    const outputBase = join(scratch, "transcript");
    await writeFile(inputPath, input.audio, { mode: 0o600 });
    await runProcess("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], input.signal);
    await runProcess(whisperBinary(root), [
      "-m", model,
      "-f", wavPath,
      "-otxt",
      "-of", outputBase,
      "-nt",
      "-np",
      "-l", settings.language ?? "auto",
    ], input.signal);
    return (await readFile(`${outputBase}.txt`, "utf8")).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function ttsPython(localRoot: string, model: string): string {
  const venv = join(resolve(localRoot), "tts", model, "venv");
  const candidate = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  if (!existsSync(candidate)) throw new Error(`Local TTS model ${model} is not installed; run \`friday setup voice\``);
  return candidate;
}

function runnerPath(options: LocalVoiceRuntimeOptions): string {
  if (options.localRunner) return resolve(options.localRunner);
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return bundled
    ? join(resolve(bundled), "voice", "python", "friday_voice_local.py")
    : resolve("plugins", "voice", "runtime", "python", "friday_voice_local.py");
}

const CHATTERBOX_EVENT_TAGS = Object.freeze({
  laugh: "[laugh]",
  chuckle: "[chuckle]",
  sigh: "[sigh]",
  gasp: "[gasp]",
  groan: "[groan]",
  cough: "[cough]",
  "clear-throat": "[clear throat]",
  shush: "[shush]",
  sniff: "[sniff]",
  tsk: "Tsk.",
} as const);

const CHATTERBOX_STYLE_CUES: Readonly<Partial<Record<VoiceExpressionStyle, readonly (keyof typeof CHATTERBOX_EVENT_TAGS)[]>>> = Object.freeze({
  happy: ["chuckle"],
  sad: ["sigh"],
  angry: ["groan"],
  sarcastic: ["chuckle"],
  annoyed: ["groan"],
  embarrassed: ["sigh"],
  tsundere: ["tsk", "sigh"],
  playful: ["chuckle"],
  excited: ["gasp"],
  nervous: ["sigh"],
  sleepy: ["sigh"],
});

export function renderChatterboxExpression(text: string, expression?: VoiceExpressionRequest): string {
  if (!expression) return text;
  const events = [...(expression.style ? CHATTERBOX_STYLE_CUES[expression.style] ?? [] : []), ...(expression.events ?? [])];
  const prefix: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const rendered = CHATTERBOX_EVENT_TAGS[event];
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    prefix.push(rendered);
  }
  return prefix.length === 0 ? text : `${prefix.join(" ")} ${text}`;
}

export async function synthesizeLocal(
  options: LocalVoiceRuntimeOptions,
  settings: VoiceTtsSettings,
  text: string,
  signal?: AbortSignal,
  expression?: VoiceExpressionRequest,
): Promise<VoiceAudioChunk> {
  const scratch = await mkdtemp(join(tmpdir(), "friday-tts-"));
  try {
    const output = join(scratch, "speech.wav");
    const ttsRoot = join(resolve(options.localRoot), "tts", settings.model);
    let reference: string | undefined;
    if (settings.referenceAudio) {
      const referencesRoot = join(resolve(options.localRoot), "references");
      reference = resolve(settings.referenceAudio);
      const rel = relative(referencesRoot, reference);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Local TTS reference audio must be staged under FRIDAY's private voice reference directory");
    }
    const expressiveText = settings.model === "chatterbox-nano" ? renderChatterboxExpression(text, expression) : text;
    const args = [
      runnerPath(options), "synthesize",
      "--model", settings.model,
      "--voice", settings.voice,
      "--root", ttsRoot,
      "--device", settings.model === "chatterbox-nano" ? (settings.compute ?? "cpu") : "cpu",
      "--text", expressiveText,
      "--output", output,
      ...(reference ? ["--reference", reference] : []),
    ];
    const cacheRoot = join(ttsRoot, "cache");
    const hfHome = join(cacheRoot, "huggingface");
    await runProcess(ttsPython(options.localRoot, settings.model), args, signal, {
      HF_HOME: hfHome,
      HF_HUB_CACHE: join(hfHome, "hub"),
      XDG_CACHE_HOME: cacheRoot,
      TORCH_HOME: join(cacheRoot, "torch"),
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    });
    const bytes = new Uint8Array(await readFile(output));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOCAL_AUDIO_BYTES) throw new Error("local TTS returned empty or oversized audio");
    return Object.freeze({ bytes, mimeType: "audio/wav", provider: "local", model: settings.model, voice: settings.voice });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
