import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runOnboarding } from "./onboarding.js";
import { runOnboardingCli } from "./cli.js";
import { getFridayHome, readRuntimeSettings, updateRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { runVoiceSetup } from "./voice-setup.js";

function bundledRoot(): string | undefined {
  const value = process.env.FRIDAY_BUNDLED_ROOT?.trim();
  return value ? resolve(value) : undefined;
}

function toolingRoot(component: string): string {
  return join(getFridayHome(process.env), "tooling", component);
}

function whatsappAssetsRoot(): string {
  return bundledRoot()
    ? join(bundledRoot()!, "channels", "whatsapp")
    : resolve("plugins", "channels", "runtime", "bridge", "whatsapp");
}

function sandboxRoot(): string {
  return bundledRoot()
    ? join(bundledRoot()!, "sandbox")
    : resolve("plugins", "sandbox");
}

async function run(command: string, args: readonly string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit", env: process.env });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`));
    });
  });
}

function commandAvailable(command: string, args: readonly string[] = ["--version"]): boolean {
  const result = spawnSync(command, [...args], { stdio: "ignore", windowsHide: true });
  return result.status === 0 && result.error === undefined;
}

function python311Available(command: string, prefix: readonly string[] = []): boolean {
  return commandAvailable(command, [
    ...prefix,
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)",
  ]);
}

async function setupExecutionPython(): Promise<void> {
  const root = toolingRoot("execution-python");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const venv = join(root, "venv");
  const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  const dependencies = ["ipykernel==6.30.1", "dill==0.4.0"] as const;
  process.stdout.write("[execution] provisioning the private Python 3.11 kernel environment\n");

  if (commandAvailable("uv")) {
    await run("uv", ["venv", venv, "--python", "3.11", "--clear"]);
    await run("uv", ["pip", "install", "--python", python, ...dependencies]);
  } else {
    const candidates: readonly { command: string; args: readonly string[] }[] = process.platform === "win32"
      ? [
          { command: "py", args: ["-3.11"] },
          { command: "python", args: [] },
        ]
      : [
          { command: "python3.11", args: [] },
          { command: "python3", args: [] },
        ];
    const selected = candidates.find((candidate) => python311Available(candidate.command, candidate.args));
    if (!selected) throw new Error("Python 3.11 or uv is required for the execution kernel");
    await run(selected.command, [...selected.args, "-m", "venv", "--clear", venv]);
    await run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...dependencies]);
  }
  process.stdout.write(`[execution] ready: ${python}\n`);
}

async function setupSelfRepository(path: string): Promise<void> {
  const repository = resolve(path);
  if (!existsSync(join(repository, "package.json")) || !existsSync(join(repository, ".git")) || !existsSync(join(repository, "plugins", "self-improvement"))) {
    throw new Error(`Not a FRIDAY source checkout: ${repository}`);
  }
  const home = getFridayHome(process.env);
  await updateRuntimeSettings({ selfRepository: repository }, home);
  process.env.FRIDAY_SELF_REPOSITORY = repository;
  process.stdout.write(`[self-improvement] source repository: ${repository}\n`);
  process.stdout.write("Restart FRIDAY to apply the saved self-improvement source.\n");
}

async function setupWhatsApp(): Promise<void> {
  const source = whatsappAssetsRoot();
  if (!existsSync(join(source, "package.json")) || !existsSync(join(source, "package-lock.json")) || !existsSync(join(source, "bridge.mjs"))) {
    throw new Error(`WhatsApp bridge assets are missing: ${source}`);
  }
  if (!commandAvailable("node") || !commandAvailable("npm")) {
    throw new Error("WhatsApp bridge setup requires a host Node.js/npm installation");
  }
  const root = toolingRoot("whatsapp");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  for (const file of ["bridge.mjs", "package.json", "package-lock.json"] as const) {
    await copyFile(join(source, file), join(root, file));
    await chmod(join(root, file), 0o600);
  }
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  process.stdout.write(`[whatsapp] ready: ${root}\n`);
}

async function setupSandbox(): Promise<void> {
  const root = sandboxRoot();
  const containerfile = join(root, "Containerfile");
  if (!existsSync(containerfile)) throw new Error(`Sandbox Containerfile is missing: ${containerfile}`);
  await run("podman", ["build", "--tag", "localhost/friday-sandbox:gen0", "--file", containerfile, root]);
}

function setupHelp(): void {
  process.stdout.write([
    "FRIDAY setup",
    "",
    "Usage:",
    "  friday setup                    First run: model, timezone, credential, and mandatory channel setup",
    "  friday setup [model options]    Scriptable model/routing/permission configuration",
    "  friday setup execution-python   Provision the private IPython kernel environment",
    "  friday setup sandbox            Build the approved rootless Podman sandbox image",
    "  friday setup whatsapp           Install the optional WhatsApp bridge dependencies",
    "  friday setup voice              Configure and verify speech-to-text / text-to-speech providers",
    "  friday setup self-repository <path>  Save the canonical FRIDAY source checkout for self-improvement",
    "  friday setup --help",
    "",
    "First-run setup requires the main model, its credential when needed, a timezone, and at least one enabled ingress channel.",
    "Routing defaults to the main model and permissions default to ask. Additional channels, sandbox, Python,",
    "MCP servers, and skills can be configured later.",
    "",
    "When FRIDAY is running, MCP, skills, and other plugin-owned operations can be configured from",
    "trusted ingress channels. The local terminal remains the setup/foreground runtime surface, not chat ingress.",
    "",
  ].join("\n"));
}

async function runInteractiveSetup(): Promise<void> {
  const home = getFridayHome(process.env);
  const existing = await readRuntimeSettings(home);
  if (!existing) {
    await runOnboarding({
      home,
      useMainForRouting: true,
      permission: "ask",
      configureChannels: true,
      setupSandbox: false,
      requireMainCredential: true,
    });
    return;
  }

  await runOnboarding({ home });
}

export async function runSetupCli(args: readonly string[]): Promise<void> {
  const [component, ...rest] = args;
  if (component === undefined) return runInteractiveSetup();
  if (component === "--help" || component === "-h" || component === "help") {
    if (rest.length > 0) throw new Error(`Unexpected setup arguments: ${rest.join(" ")}`);
    setupHelp();
    return;
  }
  if (component.startsWith("--")) return runOnboardingCli(args);
  if (component === "self-repository") {
    if (rest.length !== 1) throw new Error("Usage: friday setup self-repository <path>");
    return setupSelfRepository(rest[0]!);
  }
  if (rest.length > 0) throw new Error(`Unexpected setup arguments: ${rest.join(" ")}`);
  if (component === "execution-python") return setupExecutionPython();
  if (component === "whatsapp") return setupWhatsApp();
  if (component === "voice") return runVoiceSetup({ home: getFridayHome(process.env) }).then(() => undefined);
  if (component === "sandbox") return setupSandbox();
  throw new Error(`Unknown setup component: ${component}. Run \`friday setup --help\`.`);
}
