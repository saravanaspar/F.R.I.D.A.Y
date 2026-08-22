#!/usr/bin/env node
import { runOnboarding } from "./onboarding.js";
import { pathToFileURL } from "node:url";
import { FRIDAY_VERSION } from "./version.js";


interface CliOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly routingProvider?: string | undefined;
  readonly routingModel?: string | undefined;
  readonly useMainForRouting?: boolean | undefined;
  readonly permission?: string | undefined;
  readonly timezone?: string | undefined;
  readonly setupSandbox?: boolean | undefined;
  readonly configureChannels?: boolean | undefined;
  readonly help: boolean;
  readonly version: boolean;
}

function parseCli(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let setupSandbox: boolean | undefined;
  let configureChannels: boolean | undefined;
  let useMainForRouting: boolean | undefined;
  let help = false;
  let version = false;
  const valueOptions = new Set(["provider", "model", "routing-provider", "routing-model", "permission", "timezone"]);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected setup argument: ${token}`);
    const name = token.slice(2);
    if (name === "help" || name === "h") { help = true; continue; }
    if (name === "version" || name === "v") { version = true; continue; }
    if (name === "setup-sandbox" || name === "skip-sandbox") {
      const requested = name === "setup-sandbox";
      if (setupSandbox !== undefined && setupSandbox !== requested) {
        throw new Error("--setup-sandbox and --skip-sandbox cannot be used together");
      }
      setupSandbox = requested;
      continue;
    }
    if (name === "channels" || name === "skip-channels") {
      const requested = name === "channels";
      if (configureChannels !== undefined && configureChannels !== requested) {
        throw new Error("--channels and --skip-channels cannot be used together");
      }
      configureChannels = requested;
      continue;
    }
    if (name === "routing-main" || name === "routing-separate") {
      const requested = name === "routing-main";
      if (useMainForRouting !== undefined && useMainForRouting !== requested) {
        throw new Error("--routing-main and --routing-separate cannot be used together");
      }
      useMainForRouting = requested;
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`Unknown setup argument: --${name}`);
    if (values.has(name)) throw new Error(`--${name} may be specified only once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    values.set(name, value);
    index += 1;
  }

  return Object.freeze({
    provider: values.get("provider"),
    model: values.get("model"),
    routingProvider: values.get("routing-provider"),
    routingModel: values.get("routing-model"),
    useMainForRouting,
    permission: values.get("permission"),
    timezone: values.get("timezone"),
    setupSandbox,
    configureChannels,
    help,
    version,
  });
}

function help(): void {
  process.stdout.write([
    "FRIDAY model / runtime configuration options",
    "",
    "Usage: friday setup [options]",
    "",
    "Options:",
    "  --provider <id>          Main model provider",
    "  --model <id>             Main model id",
    "  --routing-provider <id>  Dedicated routing model provider",
    "  --routing-model <id>     Dedicated routing model id",
    "  --routing-main           Reuse the main model for routing",
    "  --routing-separate       Configure a separate routing model interactively",
    "  --permission <mode>      ask | auto | full",
    "  --timezone <IANA zone>   User wall-clock timezone, e.g. Asia/Kolkata",
    "  --setup-sandbox          Build the approved sandbox image if it is missing",
    "  --skip-sandbox           Do not prompt for sandbox image setup",
    "  --channels               Open the channel configuration manager",
    "  --skip-channels          Skip channel prompts after first-run channel requirement is satisfied",
    "  --help                   Show this help",
    "  --version                Show version",
    "",
    "Run `friday setup` without options for the interactive setup flow.",
    "Rerun setup whenever basic non-secret defaults need to change.",
    "Credentials remain Vault-owned and are never written to runtime.env.",
    "",
  ].join("\n"));
}

export async function runOnboardingCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseCli(args);
    if (options.help) {
      help();
    } else if (options.version) {
      process.stdout.write(`${FRIDAY_VERSION}\n`);
    } else {
      await runOnboarding({
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.routingProvider === undefined ? {} : { routingProvider: options.routingProvider }),
        ...(options.routingModel === undefined ? {} : { routingModel: options.routingModel }),
        ...(options.useMainForRouting === undefined ? {} : { useMainForRouting: options.useMainForRouting }),
        ...(options.permission === undefined ? {} : { permission: options.permission }),
        ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        ...(options.setupSandbox === undefined ? {} : { setupSandbox: options.setupSandbox }),
        ...(options.configureChannels === undefined ? {} : { configureChannels: options.configureChannels }),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`friday setup: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  void runOnboardingCli().catch((error: unknown) => {
    process.stderr.write(`friday setup: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
