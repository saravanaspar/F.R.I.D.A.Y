#!/usr/bin/env node
import { maintenanceHelp, runBackupCli, runVaultRecoveryCli } from "./maintenance-cli.js";
import { runRuntime } from "./runtime.js";
import { runSetupCli } from "./setup-cli.js";
import { pathToFileURL } from "node:url";
import { installFatalCrashHandlers, recordFatalCrash } from "./crash-log.js";
import { FRIDAY_VERSION } from "./version.js";
import { runDoctor } from "./doctor.js";
import { readBootstrapConfig } from "./bootstrap.js";
import { discoverPlugins, installPlugin, setPluginEnabled } from "../packages/plugin-packages.js";
import { resolve } from "node:path";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { pluginHome } from "../packages/plugin-packages.js";



function help(): void {
  process.stdout.write([
    "FRIDAY personal agent",
    "",
    "Usage:",
    "  friday                     Start FRIDAY in the foreground",
    "  friday setup [options]     First-time setup or rerunnable configuration",
    "  friday run                 Alias for `friday`",
    "  friday backup ...          Create, verify, list, or restore full-state backups",
    "  friday doctor [options]    Health/security/recovery diagnostics with one-line repair guides",
    "  friday vault recovery ...  Create or restore a passphrase-encrypted recovery kit",
    "  friday plugin list          Show built-in and installed plugins",
    "  friday plugin install DIR   Install a local plugin package (requires restart)",
    "  friday plugin enable ID     Enable a plugin (requires restart)",
    "  friday plugin disable ID    Disable a plugin (requires restart)",
    "  friday device approve ID    Approve the first desktop pairing on this host",
    "  friday --version",
    "",
    maintenanceHelp(),
    "",
  ].join("\n"));
}

async function runPluginCli(args: readonly string[]): Promise<void> {
  const configPath = resolve(process.env.FRIDAY_BOOTSTRAP_CONFIG?.trim() || resolve(process.cwd(), "friday.config.json"));
  const config = await readBootstrapConfig(configPath);
  const [action, argument, ...extra] = args;
  if (extra.length > 0 || (action !== "list" && (!argument || argument.length === 0)) || (action === "list" && argument)) {
    throw new Error("Usage: friday plugin list | install DIR | enable ID | disable ID");
  }
  if (action === "list") {
    const plugins = await discoverPlugins(config.plugins);
    for (const plugin of plugins) process.stdout.write(`${plugin.id}\t${plugin.builtIn ? "built-in" : plugin.version}\t${plugin.enabled ? "enabled" : "disabled"}\n`);
    return;
  }
  if (action === "install" && argument) {
    const installed = await installPlugin(argument, config.plugins);
    process.stdout.write(`Installed ${installed.id}; restart FRIDAY to activate.\n`);
    return;
  }
  if ((action === "enable" || action === "disable") && argument) {
    await setPluginEnabled(argument, action === "enable", config.plugins);
    process.stdout.write(`${action === "enable" ? "Enabled" : "Disabled"} ${argument}; restart FRIDAY to apply.\n`);
    return;
  }
  throw new Error("Usage: friday plugin list | install DIR | enable ID | disable ID");
}

async function approveFirstDevice(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "approve" || !/^[A-Za-z0-9-]{1,128}$/u.test(args[1] ?? "")) throw new Error("Usage: friday device approve PAIRING_ID");
  const file = resolve(process.env.FRIDAY_PAIRING_BOOTSTRAP_FILE?.trim() || join(pluginHome(), "gateway-pairing-bootstrap.json"));
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.port) || typeof raw.port !== "number" || raw.port < 1 || raw.port > 65_535 || typeof raw.token !== "string") throw new Error("Gateway pairing bootstrap file is invalid");
  const response = await fetch(`http://127.0.0.1:${raw.port}/v1/pairings/bootstrap-approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: args[1], token: raw.token }),
  });
  if (!response.ok) throw new Error(`Pairing approval failed (${response.status}). Check the pairing ID and that no device is already paired.`);
  const approved = await response.json() as { deviceId: string };
  process.stdout.write(`Approved first device ${approved.deviceId}. Reconnect from Desktop.\n`);
}

export async function runFridayCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "run") return runRuntime();
  if (command === "onboard") {
    process.stderr.write("friday: `friday onboard` is deprecated; use `friday setup`.\n");
    return runSetupCli(rest);
  }
  if (command === "backup") return runBackupCli(rest);
  if (command === "plugin") return runPluginCli(rest);
  if (command === "device") return approveFirstDevice(rest);
  if (command === "doctor") { process.exitCode = await runDoctor(rest); return; }
  if (command === "vault" && rest[0] === "recovery") return runVaultRecoveryCli(rest.slice(1));
  if (command === "setup") return runSetupCli(rest);
  if (command === "--help" || command === "-h" || command === "help") { help(); return; }
  if (command === "--version" || command === "-v") { process.stdout.write(`${FRIDAY_VERSION}\n`); return; }
  throw new Error(`Unknown FRIDAY command: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  installFatalCrashHandlers();
  void runFridayCli().catch((error: unknown) => {
    recordFatalCrash("cli", error);
    process.stderr.write(`friday: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
