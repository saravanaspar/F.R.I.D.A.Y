import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOnboarding, runRouterBootstrap, type OnboardingIO } from "./onboarding.js";
import { runOnboardingCli } from "./cli.js";
import { getFridayHome, readRuntimeSettings, updateRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { runVoiceSetup } from "./voice-setup.js";
import { installFridayPrivilegeBroker } from "../plugins/host-privileges/privileged.js";
import { setupExecutionPython } from "../plugins/execution/setup.js";
import { setupWhatsApp } from "../plugins/channels/tooling.js";
import { createTerminalOnboardingIO } from "./terminal-setup-ui.js";
import { initializeOnboardingState, updateOnboardingStep, type OnboardingStepId } from "../plugins/runtime-settings/onboarding-state.js";
import type { HostPrivilegeMode } from "../plugins/runtime-settings/runtime-env.js";
import { selectSandboxProvider } from "../plugins/sandbox/providers/index.js";
import { recordSetupLog } from "./setup-log.js";

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

export async function setupSandbox(): Promise<void> {
  const provider = selectSandboxProvider();
  const result = await provider.setup();
  const artifact = result.image ? ` · ${result.image}` : "";
  process.stdout.write(`[sandbox] ${provider.descriptor.displayName} ${result.status}${artifact}\n`);
}

function setupHelp(): void {
  process.stdout.write([
    "FRIDAY setup",
    "",
    "Usage:",
    "  friday setup                    First run: Quick or Custom; router + trusted operator channel + privilege policy are mandatory",
    "  friday setup [model options]    Scriptable model/routing/permission configuration",
    "  friday setup execution-python   Provision the private IPython kernel environment",
    "  friday setup sandbox            Prepare the configured sandbox provider and its approved image",
    "  friday setup whatsapp           Install the optional WhatsApp bridge dependencies",
    "  friday setup voice              Configure hosted/local STT + TTS and automatically provision selected local models",
    "  friday setup privileges [broker|none]  Locally enable the restricted privilege broker or disable all FRIDAY sudo operations",
    "  friday setup self-repository <path>  Save the canonical FRIDAY source checkout for self-improvement",
    "  friday setup --help",
    "",
    "First-run setup requires a routing model, its credential when needed, one trusted operator channel, and a host privilege policy.",
    "Quick setup stops after those mandatory items so onboarding can continue from the paired channel. Custom setup offers",
    "the existing terminal model/runtime/voice/sandbox/Python sections as optional steps. The main reasoning model is optional during bootstrap.",
    "",
    "When FRIDAY is running, onboarding and plugin-owned administration can continue from trusted ingress channels.",
    "Local setup remains fully available; sudo authentication and privilege-broker installation are always terminal-only.",
    "",
  ].join("\n"));
}

async function chooseSetupMode(io: OnboardingIO): Promise<"quick" | "custom"> {
  if (io.select) {
    const value = await io.select({
      message: "Setup style",
      searchable: false,
      initialValue: "quick",
      maxItems: 2,
      choices: [
        { value: "quick", label: "Quick setup", hint: "mandatory local bootstrap, finish from your trusted channel" },
        { value: "custom", label: "Custom setup", hint: "mandatory bootstrap first, then optional terminal setup" },
      ],
    });
    return value === "custom" ? "custom" : "quick";
  }
  const answer = (await io.question("Setup style [quick/custom] [quick]: ")).trim().toLowerCase();
  if (!answer || answer === "quick" || answer === "q") return "quick";
  if (answer === "custom" || answer === "c") return "custom";
  throw new Error("setup style must be quick or custom");
}

async function chooseHostPrivilegeMode(io: OnboardingIO): Promise<HostPrivilegeMode> {
  if (io.select) {
    const value = await io.select({
      message: "Privileged host operations",
      searchable: false,
      initialValue: "none",
      maxItems: 2,
      choices: [
        {
          value: "broker",
          label: "Allow approved FRIDAY operations",
          hint: "restricted root-owned broker; never arbitrary sudo",
        },
        {
          value: "none",
          label: "Never allow privileged operations",
          hint: "FRIDAY returns manual commands when root is required",
        },
      ],
    });
    return value === "broker" ? "broker" : "none";
  }
  const answer = (await io.question("Privileged host operations [broker/none] [none]: ")).trim().toLowerCase();
  if (!answer || answer === "none" || answer === "n") return "none";
  if (answer === "broker" || answer === "b") return "broker";
  throw new Error("privileged host operations must be broker or none");
}

async function optionalStep(
  io: OnboardingIO,
  home: string,
  step: OnboardingStepId,
  message: string,
  operation: () => Promise<void>,
): Promise<void> {
  const approved = io.confirm
    ? await io.confirm(message, false)
    : ["y", "yes"].includes((await io.question(`${message} [y/N] `)).trim().toLowerCase());
  if (!approved) {
    await updateOnboardingStep(step, "skipped", home);
    return;
  }
  await operation();
  await updateOnboardingStep(step, "complete", home);
}

async function runCustomOptionalSetup(io: OnboardingIO, home: string, hostPrivilegeMode: HostPrivilegeMode): Promise<void> {
  const configureCore = io.confirm
    ? await io.confirm("Configure the main reasoning model, permissions, timezone, and additional channels in this terminal?", false)
    : ["y", "yes"].includes((await io.question("Configure main model/runtime settings now? [y/N] ")).trim().toLowerCase());
  if (configureCore) {
    await runOnboarding({ home, io, configureChannels: true, setupSandbox: false, hostPrivilegeMode });
    for (const step of ["mainModel", "permissions", "timezone"] as const) await updateOnboardingStep(step, "complete", home);
  } else {
    for (const step of ["mainModel", "permissions", "timezone"] as const) await updateOnboardingStep(step, "skipped", home);
  }

  await optionalStep(io, home, "voice", "Configure voice now?", async () => {
    await runVoiceSetup({ home, io });
  });
  await optionalStep(io, home, "sandbox", "Prepare the coding sandbox now?", setupSandbox);
  await optionalStep(io, home, "executionPython", "Provision the private execution Python environment now?", async () => { await setupExecutionPython(home); });

  const selfRepo = io.confirm
    ? await io.confirm("Configure the self-improvement source repository now?", false)
    : ["y", "yes"].includes((await io.question("Configure self-improvement source repository now? [y/N] ")).trim().toLowerCase());
  if (selfRepo) {
    const value = io.text ? await io.text("FRIDAY source checkout path", process.cwd()) : await io.question(`FRIDAY source checkout path [${process.cwd()}]: `);
    await setupSelfRepository(value.trim() || process.cwd());
    await updateOnboardingStep("selfRepository", "complete", home);
  } else {
    await updateOnboardingStep("selfRepository", "skipped", home);
  }

  // MCP and Skills already expose typed trusted-channel administration. Custom
  // setup keeps them explicitly visible and optional rather than inventing a
  // second local configuration surface that did not exist before v1.0.3.
  const optionalAdminNote = [
    "MCP and Skills remain optional. They do not have a separate terminal wizard,",
    "so this Custom pass leaves them for normal typed administration after FRIDAY starts.",
    "You can configure them from the trusted channel, or use their existing local/runtime actions later.",
  ].join(" ");
  if (io.info) io.info(optionalAdminNote);
  else io.write(`${optionalAdminNote}\n`);
  await updateOnboardingStep("mcp", "skipped", home);
  await updateOnboardingStep("skills", "skipped", home);
}

async function runInteractiveSetup(): Promise<void> {
  const home = getFridayHome(process.env);
  const existing = await readRuntimeSettings(home);
  if (existing) {
    // Existing installations retain the full local onboarding flow. On the
    // first v1.0.3 setup we can derive router/operator completion from v1.0.2,
    // but the new host-privilege policy still requires a conscious LOCAL
    // operator decision before it is marked complete.
    const onboarding = await import("../plugins/runtime-settings/onboarding-state.js");
    const currentState = await onboarding.readOnboardingState(home);
    const io = createTerminalOnboardingIO();
    try {
      if (!currentState) {
        await onboarding.initializeOnboardingState("custom", home);
        await onboarding.updateOnboardingStep("router", "complete", home);
        await onboarding.updateOnboardingStep("operatorChannel", "complete", home);
        const hostPrivilegeMode = await chooseHostPrivilegeMode(io);
        if (hostPrivilegeMode === "broker") await installFridayPrivilegeBroker();
        await updateRuntimeSettings({ hostPrivilegeMode }, home);
        await onboarding.updateOnboardingStep("privilegePolicy", "complete", home);
      }
      await runOnboarding({ home, io });
      await onboarding.updateOnboardingStep("mainModel", "complete", home);
      await onboarding.updateOnboardingStep("permissions", "complete", home);
      await onboarding.updateOnboardingStep("timezone", "complete", home);
    } finally {
      io.close?.();
    }
    return;
  }

  const io = createTerminalOnboardingIO();
  try {
    const mode = await chooseSetupMode(io);
    await initializeOnboardingState(mode, home);

    // The privilege decision is deliberately local-only. If broker mode is
    // selected, sudo authentication happens here in the host terminal and is
    // never captured by FRIDAY or a remote channel.
    const hostPrivilegeMode = await chooseHostPrivilegeMode(io);
    if (hostPrivilegeMode === "broker") await installFridayPrivilegeBroker();
    await updateOnboardingStep("privilegePolicy", "complete", home);

    await runRouterBootstrap({ home, io, hostPrivilegeMode, permission: "ask" });
    await updateOnboardingStep("router", "complete", home);
    await updateOnboardingStep("operatorChannel", "complete", home);

    if (mode === "quick") {
      io.outro?.("Mandatory setup complete", [
        "Router, trusted operator channel, and host privilege policy are ready.",
        "Start FRIDAY, then send `continue setup` from the paired trusted channel.",
        "The full local setup remains available later with `friday setup` and component commands.",
      ]);
      return;
    }

    await runCustomOptionalSetup(io, home, hostPrivilegeMode);
    const state = await import("../plugins/runtime-settings/onboarding-state.js").then((module) => module.readOnboardingState(home));
    io.outro?.("Custom setup complete", [
      `Onboarding phase: ${state?.phase ?? "unknown"}`,
      "Skipped optional items can still be configured later locally or from the trusted channel.",
      "Run `friday` to start.",
    ]);
  } finally {
    io.close?.();
  }
}

async function runSetupCliInternal(args: readonly string[]): Promise<void> {
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
  if (component === "privileges") {
    if (rest.length > 1) throw new Error("Usage: friday setup privileges [broker|none]");
    const mode = rest[0]?.trim().toLowerCase() || "broker";
    if (mode !== "broker" && mode !== "none") throw new Error("Usage: friday setup privileges [broker|none]");
    if (mode === "broker") await installFridayPrivilegeBroker();
    const home = getFridayHome(process.env);
    if (await readRuntimeSettings(home)) await updateRuntimeSettings({ hostPrivilegeMode: mode }, home);
    process.stdout.write(mode === "broker"
      ? "[privileges] policy=broker: FRIDAY may run only explicitly allowlisted privileged helper operations; the model has no arbitrary sudo tool or password access.\n"
      : "[privileges] policy=none: FRIDAY will not invoke sudo; root-required operations must be run manually on this host.\n");
    return;
  }
  if (rest.length > 0) throw new Error(`Unexpected setup arguments: ${rest.join(" ")}`);
  if (component === "execution-python") { await setupExecutionPython(); return; }
  if (component === "whatsapp") { await setupWhatsApp(); return; }
  if (component === "voice") return runVoiceSetup({ home: getFridayHome(process.env) }).then(() => undefined);
  if (component === "sandbox") return setupSandbox();
  throw new Error(`Unknown setup component: ${component}. Run \`friday setup --help\`.`);
}


export async function runSetupCli(args: readonly string[]): Promise<void> {
  const operation = args.length === 0 ? "interactive" : args.join(" ").slice(0, 256);
  const started = Date.now();
  await recordSetupLog({ component: "setup", operation, outcome: "started" });
  try {
    await runSetupCliInternal(args);
    await recordSetupLog({ component: "setup", operation, outcome: "success", durationMs: Date.now() - started });
  } catch (error) {
    await recordSetupLog({
      component: "setup",
      operation,
      outcome: "failure",
      durationMs: Date.now() - started,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    throw error;
  }
}
