import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const fridayHome = resolve(process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
const runtimeRoot = join(fridayHome, "tooling", "execution-python");
const venv = join(runtimeRoot, "venv");
const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") chmodSync(runtimeRoot, 0o700);
const PYTHON_PACKAGES = ["ipykernel==6.30.1", "dill==0.4.0"];

function probe(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
  return !result.error && result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fallbackPython() {
  const candidates = process.platform === "win32"
    ? [["py", ["-3.11"]], ["python", []]]
    : [["python3.11", []], ["python3", []]];
  for (const [command, prefix] of candidates) {
    if (probe(command, [...prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)"])) {
      return { command, prefix };
    }
  }
  throw new Error("Python 3.11 is required when uv is unavailable");
}

console.log("[execution] provisioning Python 3.11 kernel environment");
if (probe("uv")) {
  run("uv", ["venv", venv, "--python", "3.11", "--clear"]);
  run("uv", ["pip", "install", "--python", python, ...PYTHON_PACKAGES]);
} else {
  const fallback = fallbackPython();
  run(fallback.command, [...fallback.prefix, "-m", "venv", "--clear", venv]);
  if (!existsSync(python)) throw new Error(`Python virtual environment was not created: ${python}`);
  run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...PYTHON_PACKAGES]);
}
console.log(`[execution] ready: ${python}`);
