import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BGE_SMALL_EN_V15_DIMENSIONS,
  BGE_SMALL_EN_V15_MODEL_ID,
  BGE_SMALL_EN_V15_MODEL_REVISION,
  BGE_SMALL_EN_V15_MODEL_SHA256,
  BGE_SMALL_EN_V15_INT8_PROVIDER_ID,
  MEMORY_BGE_PROFILE_SCHEMA,
} from "./runtime/src/bge.js";

const ONNXRUNTIME_VERSION = "1.29.0";
const TOKENIZERS_VERSION = "0.23.2";
const POSIX_SYSTEM_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;
const SETUP_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SYSTEMROOT", "WINDIR",
] as const);

function fridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

function bundledRoot(): string | undefined {
  const value = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return value ? resolve(value) : undefined;
}

function memoryAssetsRoot(): string {
  const bundled = bundledRoot();
  return bundled ? join(bundled, "memory") : resolve("plugins", "memory", "runtime", "tooling");
}

export function memoryToolingProcessEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1" };
  for (const name of SETUP_ENV_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined) env[name] = value;
  }
  if (process.platform !== "win32") {
    const current = environment.PATH?.trim();
    env.PATH = [...new Set([...(current ? current.split(":") : []), ...POSIX_SYSTEM_PATHS].filter(Boolean))].join(":");
  }
  return env;
}

function commandAvailable(command: string, args: readonly string[] = ["--version"]): boolean {
  const result = spawnSync(command, [...args], { stdio: "ignore", windowsHide: true, env: memoryToolingProcessEnv() });
  return result.status === 0 && result.error === undefined;
}

async function run(command: string, args: readonly string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: memoryToolingProcessEnv(),
    });
    let tail = "";
    const capture = (chunk: Buffer, target: NodeJS.WriteStream): void => {
      target.write(chunk);
      tail = `${tail}${String(chunk)}`.slice(-8_000);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, process.stderr));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) { resolveRun(); return; }
      rejectRun(new Error([
        `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
        tail.trim() ? `Recent subprocess output:\n${tail.trim()}` : "",
      ].filter(Boolean).join("\n")));
    });
  });
}

function pythonCommand(): string {
  for (const command of ["python3.12", "python3.11", "python3.10", "python3", "python"] as const) {
    const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
      stdio: "ignore",
      windowsHide: true,
      env: memoryToolingProcessEnv(),
    });
    if (result.status === 0 && result.error === undefined) return command;
  }
  throw new Error("Memory BGE setup requires Python 3.10 or newer");
}

async function ensureVenv(root: string): Promise<string> {
  const venv = join(root, "venv");
  const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  if (existsSync(python)) return python;
  if (commandAvailable("uv")) await run("uv", ["venv", venv, "--python", "3.11"]);
  else await run(pythonCommand(), ["-m", "venv", venv]);
  return python;
}

async function installRuntime(python: string): Promise<void> {
  const requirements = [`onnxruntime==${ONNXRUNTIME_VERSION}`, `tokenizers==${TOKENIZERS_VERSION}`];
  if (commandAvailable("uv")) {
    await run("uv", ["pip", "install", "--python", python, ...requirements]);
    return;
  }
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...requirements]);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url: string, destination: string, maxBytes: number): Promise<void> {
  if (!commandAvailable("curl")) throw new Error("Memory BGE setup requires curl to download the pinned ONNX model");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  try {
    await run("curl", [
      "--fail", "--location", "--retry", "3",
      "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "5",
      "--max-filesize", String(maxBytes), "--output", partial, url,
    ]);
    await chmod(partial, 0o600);
    await rm(destination, { force: true });
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function modelUrl(path: string): string {
  return `https://huggingface.co/${BGE_SMALL_EN_V15_MODEL_ID}/resolve/${BGE_SMALL_EN_V15_MODEL_REVISION}/${path}?download=true`;
}

async function provisionModel(root: string): Promise<string> {
  const model = join(root, "models", "Xenova", "bge-small-en-v1.5", "onnx", "model_int8.onnx");
  const tokenizer = join(root, "models", "Xenova", "bge-small-en-v1.5", "tokenizer.json");
  if (existsSync(model)) {
    const actual = await sha256(model);
    if (actual !== BGE_SMALL_EN_V15_MODEL_SHA256) await rm(model, { force: true });
  }
  if (!existsSync(model)) await download(modelUrl("onnx/model_int8.onnx"), model, 64 * 1024 * 1024);
  const actual = await sha256(model);
  if (actual !== BGE_SMALL_EN_V15_MODEL_SHA256) {
    await rm(model, { force: true });
    throw new Error(`BGE INT8 model integrity check failed: expected ${BGE_SMALL_EN_V15_MODEL_SHA256}, got ${actual}`);
  }
  if (!existsSync(tokenizer)) await download(modelUrl("tokenizer.json"), tokenizer, 8 * 1024 * 1024);
  try {
    const parsed = JSON.parse(await readFile(tokenizer, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid tokenizer JSON");
  } catch (error) {
    await rm(tokenizer, { force: true });
    throw new Error("BGE tokenizer integrity/parse check failed", { cause: error });
  }
  await chmod(model, 0o600);
  await chmod(tokenizer, 0o600);
  return model;
}

export interface MemoryEmbeddingSetupResult {
  readonly root: string;
  readonly providerId: string;
  readonly dimensions: number;
  readonly modelBytes: number;
}

/** Provision the private, offline BGE-small-en-v1.5 INT8 ONNX Memory runtime. */
export async function setupMemoryEmbeddings(home = fridayHome()): Promise<MemoryEmbeddingSetupResult> {
  const sourceWorker = join(memoryAssetsRoot(), "bge_worker.py");
  if (!existsSync(sourceWorker)) throw new Error(`Memory BGE worker asset is missing: ${sourceWorker}`);
  const root = join(home, "tooling", "memory");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const worker = join(root, "bge_worker.py");
  await copyFile(sourceWorker, worker);
  await chmod(worker, 0o600);

  const python = await ensureVenv(root);
  await installRuntime(python);
  const model = await provisionModel(root);

  // The probe loads the exact local INT8 model with network-free ONNX Runtime
  // before the profile is published as ready.
  await run(python, [worker, "--probe"], root);
  const profile = {
    schema: MEMORY_BGE_PROFILE_SCHEMA,
    providerId: BGE_SMALL_EN_V15_INT8_PROVIDER_ID,
    dimensions: BGE_SMALL_EN_V15_DIMENSIONS,
    modelId: BGE_SMALL_EN_V15_MODEL_ID,
    modelRevision: BGE_SMALL_EN_V15_MODEL_REVISION,
    modelSha256: BGE_SMALL_EN_V15_MODEL_SHA256,
    runtime: `python-onnxruntime-${ONNXRUNTIME_VERSION};tokenizers-${TOKENIZERS_VERSION};cpu-int8-cls`,
  } as const;
  const profilePath = join(root, "profile.json");
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await chmod(profilePath, 0o600);
  const modelBytes = (await stat(model)).size;
  process.stdout.write(`[memory] BGE-small-en-v1.5 INT8 ready · ${BGE_SMALL_EN_V15_DIMENSIONS}d · ${(modelBytes / 1024 / 1024).toFixed(1)} MiB model\n`);
  return Object.freeze({ root, providerId: BGE_SMALL_EN_V15_INT8_PROVIDER_ID, dimensions: BGE_SMALL_EN_V15_DIMENSIONS, modelBytes });
}
