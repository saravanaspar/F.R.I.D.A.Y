import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const POSIX_SYSTEM_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;
const SETUP_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SYSTEMROOT", "WINDIR",
] as const);

function fridayHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_HOME?.trim();
  return resolve(configured || join(homedir(), ".friday"));
}

export function executionSetupProcessEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
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
  const result = spawnSync(command, [...args], { stdio: "ignore", windowsHide: true, env: executionSetupProcessEnv() });
  return result.status === 0 && result.error === undefined;
}

function python311Available(command: string, prefix: readonly string[] = []): boolean {
  return commandAvailable(command, [
    ...prefix,
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)",
  ]);
}

async function run(command: string, args: readonly string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: executionSetupProcessEnv() });
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

export function executionPythonPath(home = fridayHome()): string {
  const venv = join(home, "tooling", "execution-python", "venv");
  return process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}

export async function setupExecutionPython(home = fridayHome()): Promise<string> {
  const python = executionPythonPath(home);
  const venv = dirname(dirname(python));
  const root = dirname(venv);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const dependencies = ["ipykernel==6.30.1", "dill==0.4.0"] as const;

  if (commandAvailable("uv")) {
    await run("uv", ["venv", venv, "--python", "3.11", "--clear"]);
    await run("uv", ["pip", "install", "--python", python, ...dependencies]);
  } else {
    const candidates: readonly { command: string; args: readonly string[] }[] = process.platform === "win32"
      ? [{ command: "py", args: ["-3.11"] }, { command: "python", args: [] }]
      : [{ command: "python3.11", args: [] }, { command: "python3", args: [] }];
    const selected = candidates.find((candidate) => python311Available(candidate.command, candidate.args));
    if (!selected) throw new Error("Python 3.11 or uv is required for the execution kernel");
    await run(selected.command, [...selected.args, "-m", "venv", "--clear", venv]);
    await run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...dependencies]);
  }
  if (!existsSync(python)) throw new Error(`Execution Python provisioning did not create ${python}`);
  return python;
}
