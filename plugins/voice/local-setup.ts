import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { VoiceLocalCompute, VoiceSettings } from "@friday/voice";

import { voiceFridayHome } from "./paths.js";

const WHISPER_CPP_VERSION = "v1.9.2";
const WHISPER_MODEL_REVISION = "c521a4b02f422512d734391fdf08bb08c0862f68";
const WHISPER_MODEL_SHA256 = Object.freeze({
  "tiny-q5_1": "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
  "base-q5_1": "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  "small-q5_1": "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
} as const);
const CHATTERBOX_VERSION = "0.1.7";
const CHATTERBOX_NANO_REVISION = "5de7a54aa4e5e2baadb0182dde554908b48b85c2";
const CHATTERBOX_NANO_SOURCE = `git+https://github.com/resemble-ai/chatterbox.git@${CHATTERBOX_NANO_REVISION}`;
const RESEMBLE_PERTH_REVISION = "ff1c8ac55a976971245cdd53c18d6131ca00d993";
const RESEMBLE_PERTH_SOURCE = `resemble-perth @ git+https://github.com/resemble-ai/Perth.git@${RESEMBLE_PERTH_REVISION}`;
const CHATTERBOX_TORCH_VERSION = "2.6.0";
const CHATTERBOX_RUNTIME_REQUIREMENTS = Object.freeze([
  "numpy>=1.24.0,<2.0.0",
  "librosa==0.11.0",
  "s3tokenizer",
  "transformers==5.2.0",
  "diffusers==0.29.0",
  "conformer==0.3.2",
  "safetensors==0.5.3",
  "spacy-pkuseg",
  "pykakasi==2.3.0",
  "gradio==6.8.0",
  "pyloudnorm",
  "omegaconf",
  // Perth 1.1 runtime dependencies. Torch/Torchaudio are installed separately
  // from the operator-selected CPU/CUDA index before this dependency set.
  "PyYAML>=6.0",
  "pydub>=0.25.1",
  "soundfile>=0.12.0",
] as const);
const PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";
const PYTORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu126";
const PYPI_INDEX = "https://pypi.org/simple";
const PIPER_VERSION = "1.8.0";
const KITTEN_WHEEL = "https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl";
const LOCAL_STT = new Set(Object.keys(WHISPER_MODEL_SHA256));
const LOCAL_TTS = new Set(["chatterbox-nano", "kitten-nano-int8", "piper"]);
const WHISPER_HOST_COMMANDS = ["git", "cmake", "ffmpeg"] as const;
const POSIX_SYSTEM_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;
const HOST_COMMAND_PROBES = Object.freeze({
  git: ["--version"],
  cmake: ["--version"],
  ffmpeg: ["-version"],
  curl: ["--version"],
  uv: ["--version"],
} satisfies Readonly<Record<string, readonly string[]>>);
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

function setupPath(): string | undefined {
  const current = process.env.PATH?.trim();
  if (process.platform === "win32") return current || undefined;
  const entries = [...(current ? current.split(":") : []), ...POSIX_SYSTEM_PATHS];
  return [...new Set(entries.filter(Boolean))].join(":");
}

function setupProcessEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SETUP_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const path = setupPath();
  if (path !== undefined) env.PATH = path;
  return { ...env, ...overrides };
}

function commandAvailable(command: string, args?: readonly string[]): boolean {
  const probeArgs = args ?? HOST_COMMAND_PROBES[command as keyof typeof HOST_COMMAND_PROBES] ?? ["--version"];
  const result = spawnSync(command, [...probeArgs], { stdio: "ignore", windowsHide: true, env: setupProcessEnv() });
  return result.status === 0 && result.error === undefined;
}

const MAX_SUBPROCESS_FAILURE_TAIL = 8_000;

function appendFailureTail(current: string, chunk: Buffer | string): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= MAX_SUBPROCESS_FAILURE_TAIL ? next : next.slice(-MAX_SUBPROCESS_FAILURE_TAIL);
}

async function run(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: env ?? setupProcessEnv() });
    let stdoutTail = "";
    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdoutTail = appendFailureTail(stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = appendFailureTail(stderrTail, chunk);
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) { resolveRun(); return; }
      const tail = (stderrTail.trim() || stdoutTail.trim()).slice(-MAX_SUBPROCESS_FAILURE_TAIL);
      rejectRun(new Error([
        `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
        tail ? `Recent subprocess output:\n${tail}` : "",
      ].filter(Boolean).join("\n")));
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

async function pipInstallArgs(python: string, args: readonly string[]): Promise<void> {
  if (commandAvailable("uv")) await run("uv", ["pip", "install", "--python", python, ...args]);
  else await run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...args]);
}

async function pipInstall(python: string, requirement: string): Promise<void> {
  await pipInstallArgs(python, [requirement]);
}

export interface LocalVoiceGpuInfo {
  readonly backend: "cuda";
  readonly name: string;
}

export function detectLocalVoiceGpu(): LocalVoiceGpuInfo | undefined {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    encoding: "utf8",
    windowsHide: true,
    env: setupProcessEnv(),
  });
  if (result.status !== 0 || result.error) return undefined;
  const name = String(result.stdout ?? "").split(/\r?\n/, 1)[0]?.trim();
  return Object.freeze({ backend: "cuda", name: name || "NVIDIA GPU" });
}

export interface ChatterboxTorchInstallPlan {
  readonly compute: VoiceLocalCompute;
  readonly indexUrl: string;
  readonly requirements: readonly string[];
}

export function chatterboxTorchInstallPlan(compute: VoiceLocalCompute): ChatterboxTorchInstallPlan {
  return Object.freeze({
    compute,
    indexUrl: compute === "cuda" ? PYTORCH_CUDA_INDEX : PYTORCH_CPU_INDEX,
    requirements: Object.freeze([`torch==${CHATTERBOX_TORCH_VERSION}`, `torchaudio==${CHATTERBOX_TORCH_VERSION}`]),
  });
}

export interface ChatterboxPackageInstallPlan {
  readonly runtimeRequirements: readonly string[];
  readonly perthSourceRequirement: string;
  readonly perthRevision: string;
  readonly nanoSourceRequirement: string;
  readonly nanoRevision: string;
}

export function chatterboxPackageInstallPlan(): ChatterboxPackageInstallPlan {
  return Object.freeze({
    runtimeRequirements: CHATTERBOX_RUNTIME_REQUIREMENTS,
    perthSourceRequirement: RESEMBLE_PERTH_SOURCE,
    perthRevision: RESEMBLE_PERTH_REVISION,
    nanoSourceRequirement: CHATTERBOX_NANO_SOURCE,
    nanoRevision: CHATTERBOX_NANO_REVISION,
  });
}

function chatterboxProfile(compute: VoiceLocalCompute): string {
  const plan = chatterboxTorchInstallPlan(compute);
  return `chatterbox-tts=${CHATTERBOX_VERSION};nano-revision=${CHATTERBOX_NANO_REVISION};torch=${CHATTERBOX_TORCH_VERSION};compute=${compute};index=${plan.indexUrl}`;
}

async function resetChatterboxVenvIfProfileChanged(ttsRoot: string, compute: VoiceLocalCompute): Promise<void> {
  const profilePath = join(ttsRoot, ".friday-runtime-profile");
  let current: string | undefined;
  try { current = (await readFile(profilePath, "utf8")).trim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const desired = chatterboxProfile(compute);
  if (current === desired) return;
  await rm(join(ttsRoot, "venv"), { recursive: true, force: true });
  await rm(join(ttsRoot, ".friday-ready"), { force: true });
  await rm(profilePath, { force: true });
}

async function installChatterbox(python: string, compute: VoiceLocalCompute): Promise<void> {
  if (compute === "cuda" && !detectLocalVoiceGpu()) {
    throw new Error("Chatterbox CUDA was selected but no working NVIDIA GPU/driver was detected by nvidia-smi");
  }
  const plan = chatterboxTorchInstallPlan(compute);
  const packages = chatterboxPackageInstallPlan();
  await pipInstallArgs(python, [...plan.requirements, "--index-url", plan.indexUrl]);
  // Chatterbox's upstream metadata carries Perth as a transitive Git URL. uv rejects
  // transitive URL requirements, so install the declared runtime dependency set
  // explicitly, then install immutable Perth and Nano sources without dependency
  // resolution. This also prevents either source package from replacing the
  // operator-selected CPU/CUDA Torch build.
  await pipInstallArgs(python, [...packages.runtimeRequirements, "--index-url", PYPI_INDEX, "--extra-index-url", plan.indexUrl]);
  await pipInstallArgs(python, [packages.perthSourceRequirement, "--no-deps"]);
  await pipInstallArgs(python, [packages.nanoSourceRequirement, "--no-deps"]);
  const check = compute === "cuda"
    ? "import torch; raise SystemExit(0 if torch.version.cuda and torch.cuda.is_available() else 1)"
    : "import torch; raise SystemExit(0 if torch.version.cuda is None else 1)";
  await run(python, ["-c", check]);
  await run(python, [
    "-c",
    "import perth; assert getattr(perth, 'PerthImplicitWatermarker', None) is not None, 'installed Perth build does not expose PerthImplicitWatermarker'",
  ]);
  await run(python, [
    "-c",
    "import inspect; from chatterbox.tts_turbo import ChatterboxTurboTTS; params = inspect.signature(ChatterboxTurboTTS.from_pretrained).parameters; assert 'nano' in params, 'installed Chatterbox build does not support Nano'",
  ]);
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

async function provisionTts(root: string, model: string, voice: string, compute: VoiceLocalCompute = "cpu"): Promise<void> {
  if (!LOCAL_TTS.has(model)) throw new Error(`Unsupported local TTS model: ${model}`);
  const ttsRoot = join(root, "tts", model);
  if (model === "chatterbox-nano") await resetChatterboxVenvIfProfileChanged(ttsRoot, compute);
  const python = await ensureVenv(ttsRoot);
  const marker = join(ttsRoot, ".friday-ready");
  const profilePath = join(ttsRoot, ".friday-runtime-profile");
  const cacheRoot = join(ttsRoot, "cache");
  const hfHome = join(cacheRoot, "huggingface");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  if (!existsSync(marker)) {
    if (model === "chatterbox-nano") await installChatterbox(python, compute);
    else if (model === "kitten-nano-int8") await pipInstall(python, KITTEN_WHEEL);
    else await pipInstall(python, `piper-tts==${PIPER_VERSION}`);
    await mkdir(ttsRoot, { recursive: true, mode: 0o700 });
    if (model === "chatterbox-nano") await writeFile(profilePath, `${chatterboxProfile(compute)}\n`, { mode: 0o600 });
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
  await run(python, [runner, "preload", "--model", model, "--voice", voice, "--root", ttsRoot, "--device", model === "chatterbox-nano" ? compute : "cpu"], undefined, setupProcessEnv({
    HF_HOME: hfHome,
    HF_HUB_CACHE: join(hfHome, "hub"),
    XDG_CACHE_HOME: cacheRoot,
    TORCH_HOME: join(cacheRoot, "torch"),
  }));
  // A dependency install is not a ready model. Persist readiness only after the
  // selected model has actually loaded successfully during the setup preload.
  if (!existsSync(marker)) await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function localVoiceToolingRoot(home = voiceFridayHome(process.env)): string {
  return join(home, "tooling", "voice");
}

export async function provisionLocalVoice(settings: VoiceSettings, home = voiceFridayHome(process.env)): Promise<void> {
  const root = localVoiceToolingRoot(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (settings.stt?.provider === "local") await provisionWhisper(root, settings.stt.model);
  if (settings.tts?.provider === "local") await provisionTts(root, settings.tts.model, settings.tts.voice, settings.tts.compute ?? "cpu");
}

export function localVoiceRunnerPath(): string {
  return bundledVoiceRunner();
}

export function localVoiceReferenceName(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96) || "voice-reference.wav";
}

const MAX_LOCAL_VOICE_REFERENCE_BYTES = 20 * 1024 * 1024;

export async function stageLocalVoiceReferenceBytes(
  bytes: Uint8Array,
  fileName = "voice-reference.wav",
  home = voiceFridayHome(process.env),
): Promise<string> {
  if (bytes.byteLength < 1) throw new Error("Voice cloning reference is empty");
  if (bytes.byteLength > MAX_LOCAL_VOICE_REFERENCE_BYTES) {
    throw new Error(`Voice cloning reference exceeds ${MAX_LOCAL_VOICE_REFERENCE_BYTES / (1024 * 1024)} MiB`);
  }
  const root = join(localVoiceToolingRoot(home), "references");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const safeName = localVoiceReferenceName(fileName);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = join(root, `${digest}-${safeName}`);
  if (!existsSync(target)) {
    const temporary = join(root, `.${digest}-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }
  await chmod(target, 0o600);
  return target;
}

export function missingLocalVoiceHostDependencies(settings: VoiceSettings): readonly string[] {
  const required = new Set<string>();
  if (settings.stt?.provider === "local") {
    for (const command of WHISPER_HOST_COMMANDS) required.add(command);
    required.add("curl");
  }
  if (settings.tts?.provider === "local") {
    if (settings.tts.model === "chatterbox-nano") required.add("git");
    if (!commandAvailable("uv")) {
      try { pythonCommand(); } catch { required.add("python>=3.10"); }
    }
  }
  return Object.freeze([...required].filter((command) => command === "python>=3.10" || !commandAvailable(command)));
}

export async function stageLocalVoiceReference(path: string, home = voiceFridayHome(process.env)): Promise<string> {
  const source = resolve(path);
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Voice cloning reference must be a regular file, not a symlink");
  if (info.size < 1) throw new Error("Voice cloning reference is empty");
  if (info.size > MAX_LOCAL_VOICE_REFERENCE_BYTES) {
    throw new Error(`Voice cloning reference exceeds ${MAX_LOCAL_VOICE_REFERENCE_BYTES / (1024 * 1024)} MiB`);
  }
  return stageLocalVoiceReferenceBytes(await readFile(source), localVoiceReferenceName(source), home);
}
