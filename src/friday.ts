#!/usr/bin/env node
import { maintenanceHelp, runBackupCli, runVaultRecoveryCli } from "./maintenance-cli.js";
import { runRuntime } from "./runtime.js";
import { runSetupCli } from "./setup-cli.js";
import { pathToFileURL } from "node:url";
import { installFatalCrashHandlers, recordFatalCrash } from "./crash-log.js";
import { FRIDAY_VERSION } from "./version.js";
import { runDoctor } from "./doctor.js";



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
    "  friday --version",
    "",
    maintenanceHelp(),
    "",
  ].join("\n"));
}

export async function runFridayCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "run") return runRuntime();
  if (command === "onboard") {
    process.stderr.write("friday: `friday onboard` is deprecated; use `friday setup`.\n");
    return runSetupCli(rest);
  }
  if (command === "backup") return runBackupCli(rest);
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
