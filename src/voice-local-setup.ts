import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { VoiceSettings } from "@friday/voice";
import { getFridayHome } from "../plugins/runtime-settings/runtime-env.js";

const WHISPER_CPP_VERSION = "v1.9.2";
const WHISPER_MODEL_REVISION = "c521a4b02f422512d734391fdf08bb08c0862f68";
const WHISPER_MODEL_SHA256 = Object.freeze({
  "tiny-q5_1": "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
  "base-q5_1": "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  "small-q5_1": "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
} as const);
const CHATTERBOX_VERSION = "0.1.7";
const PIPER_VERSION = "1.8.0";
const KITTEN_WHEEL = "https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl";
const LOCAL_STT = new Set(Object.keys(WHISPER_MODEL_SHA256));
const LOCAL_TTS = new Set(["chatterbox-nano", "kitten-nano-int8", "piper"]);
const WHISPER_HOST_COMMANDS = ["git", "cmake", "ffmpeg"] as const;
const SETUP_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SYSTEMROOT",
  "WINDIR",
] as const);

function setupProcessEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SETUP_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...overrides };
}

function commandAvailable(command: string, args: readonly string[] = ["--version"]): boolean {
  const result = spawnSync(command, [...args], { stdio: "ignore", windowsHide: true });
  return result.status === 0 && result.error === undefined;
}

async function run(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit", env: env ?? setupProcessEnv() });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`));
    });
  });
}

function bundledVoiceRunner(): string {
  const bundled = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return bundled
    ? join(resolve(bundled), "voice", "python", "friday_voice_local.py")
    : resolve("plugins", "voice", "runtime", "python", "friday_voice_local.py");
}

function pythonCommand(): string {
  for (const command of ["python3.11", "python3", "python"] as const) {
    const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], { stdio: "ignore" });
    if (result.status === 0 && result.error === undefined) return command;
  }
  throw new Error("Local voice setup requires Python 3.10 or newer");
}

async function ensureVenv(root: string): Promise<string> {
  const venv = join(root, "venv");
  const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  if (existsSync(python)) return python;
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (commandAvailable("uv")) await run("uv", ["venv", venv, "--python", "3.11"]);
  else await run(pythonCommand(), ["-m", "venv", venv]);
  return python;
}

async function pipInstall(python: string, requirement: string): Promise<void> {
  if (commandAvailable("uv")) await run("uv", ["pip", "install", "--python", python, requirement]);
  else await run(python, ["-m", "pip", "install", "--disable-pip-version-check", requirement]);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyWhisperModel(path: string, model: string): Promise<void> {
  const expected = WHISPER_MODEL_SHA256[model as keyof typeof WHISPER_MODEL_SHA256];
  if (!expected) throw new Error(`Unsupported local Whisper model: ${model}`);
  const actual = await sha256(path);
  if (actual !== expected) {
    await rm(path, { force: true });
    throw new Error(`Whisper model integrity check failed for ${model}: expected ${expected}, got ${actual}`);
  }
}

async function provisionWhisper(root: string, model: string): Promise<void> {
  if (!LOCAL_STT.has(model)) throw new Error(`Unsupported local Whisper model: ${model}`);
  for (const command of WHISPER_HOST_COMMANDS) {
    if (!commandAvailable(command)) throw new Error(`Local Whisper setup requires ${command}; run \`friday setup privileges\` then retry voice setup`);
  }
  const whisperRoot = join(root, "whisper.cpp");
  const source = join(whisperRoot, "source");
  const binary = process.platform === "win32" ? join(source, "build", "bin", "Release", "whisper-cli.exe") : join(source, "build", "bin", "whisper-cli");
  const models = join(whisperRoot, "models");
  const modelPath = join(models, `ggml-${model}.bin`);
  await mkdir(whisperRoot, { recursive: true, mode: 0o700 });
  if (!existsSync(join(source, ".git"))) {
    await rm(source, { recursive: true, force: true });
    await run("git", ["clone", "--depth", "1", "--branch", WHISPER_CPP_VERSION, "https://github.com/ggml-org/whisper.cpp.git", source]);
  }
  if (!existsSync(binary)) {
    await run("cmake", ["-S", source, "-B", join(source, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DGGML_NATIVE=OFF"]);
    await run("cmake", ["--build", join(source, "build"), "--config", "Release", "-j"]);
  }
  await mkdir(models, { recursive: true, mode: 0o700 });
  if (!existsSync(modelPath)) {
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-${model}.bin`;
    await run("curl", ["--fail", "--location", "--retry", "3", "--output", modelPath, modelUrl]);
  }
  if (!existsSync(modelPath)) throw new Error(`Whisper model download did not produce ${modelPath}`);
  await verifyWhisperModel(modelPath, model);
  await chmod(modelPath, 0o600);
}

async function provisionTts(root: string, model: string, voice: string): Promise<void> {
  if (!LOCAL_TTS.has(model)) throw new Error(`Unsupported local TTS model: ${model}`);
  const ttsRoot = join(root, "tts", model);
  const python = await ensureVenv(ttsRoot);
  const marker = join(ttsRoot, ".friday-ready");
  const cacheRoot = join(ttsRoot, "cache");
  const hfHome = join(cacheRoot, "huggingface");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  if (!existsSync(marker)) {
    if (model === "chatterbox-nano") await pipInstall(python, `chatterbox-tts==${CHATTERBOX_VERSION}`);
    else if (model === "kitten-nano-int8") await pipInstall(python, KITTEN_WHEEL);
    else await pipInstall(python, `piper-tts==${PIPER_VERSION}`);
    await mkdir(ttsRoot, { recursive: true, mode: 0o700 });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }));
  }
  if (model === "piper") {
    const dataDir = join(ttsRoot, "voices");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(dataDir, `${voice}.onnx`))) {
      await run(python, ["-m", "piper.download_voices", "--data-dir", dataDir, voice]);
    }
  }
  // Force model download/initialization during setup so first runtime use remains offline-capable.
  const runner = bundledVoiceRunner();
  await run(python, [runner, "preload", "--model", model, "--voice", voice, "--root", ttsRoot], undefined, setupProcessEnv({
    HF_HOME: hfHome,
    HF_HUB_CACHE: join(hfHome, "hub"),
    XDG_CACHE_HOME: cacheRoot,
    TORCH_HOME: join(cacheRoot, "torch"),
  }));
}

export function localVoiceToolingRoot(home = getFridayHome(process.env)): string {
  return join(home, "tooling", "voice");
}

export async function provisionLocalVoice(settings: VoiceSettings, home = getFridayHome(process.env)): Promise<void> {
  const root = localVoiceToolingRoot(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (settings.stt?.provider === "local") await provisionWhisper(root, settings.stt.model);
  if (settings.tts?.provider === "local") await provisionTts(root, settings.tts.model, settings.tts.voice);
}

export function localVoiceRunnerPath(): string {
  return bundledVoiceRunner();
}

export function localVoiceReferenceName(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96) || "voice-reference.wav";
}


export function missingLocalVoiceHostDependencies(settings: VoiceSettings): readonly string[] {
  const required = new Set<string>();
  if (settings.stt?.provider === "local") {
    for (const command of WHISPER_HOST_COMMANDS) required.add(command);
    required.add("curl");
  }
  if (settings.tts?.provider === "local" && !commandAvailable("uv")) {
    try { pythonCommand(); } catch { required.add("python>=3.10"); }
  }
  return Object.freeze([...required].filter((command) => command === "python>=3.10" || !commandAvailable(command)));
}

export async function stageLocalVoiceReference(path: string, home = getFridayHome(process.env)): Promise<string> {
  const source = resolve(path);
  const root = join(localVoiceToolingRoot(home), "references");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, localVoiceReferenceName(source));
  if (source !== target) await copyFile(source, target);
  await chmod(target, 0o600);
  return target;
}
