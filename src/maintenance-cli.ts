import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { VaultStore, getVaultStateDir } from "@friday/vault";
import { getFridayWorkspace } from "../plugins/runtime-settings/runtime-env.js";
import {
  createStateBackup,
  getStateBackupRoot,
  listStateBackups,
  restoreStateBackup,
  verifyStateBackup,
} from "./state-backup.js";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  if (args.indexOf(name, index + 1) >= 0) throw new Error(`${name} may be specified only once`);
  return value;
}

function ensureKnown(args: readonly string[], valueOptions: readonly string[], flags: readonly string[]): void {
  const values = new Set(valueOptions);
  const booleans = new Set(flags);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (booleans.has(token)) continue;
    if (values.has(token)) { index += 1; continue; }
    throw new Error(`Unknown maintenance argument: ${token}`);
  }
}

async function hiddenPassphrase(options: {
  readonly environmentName: string;
  readonly label: string;
  readonly confirm: boolean;
}): Promise<string> {
  const configured = process.env[options.environmentName];
  if (configured !== undefined) {
    if (configured.length < 12) throw new Error(`${options.environmentName} must contain at least 12 characters`);
    return configured;
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error(`Set ${options.environmentName} for non-interactive ${options.label.toLowerCase()} operations`);
  }
  const readHidden = async (prompt: string): Promise<string> => {
    process.stderr.write(prompt);
    process.stdin.setRawMode!(true);
    process.stdin.resume();
    let value = "";
    try {
      while (true) {
        const chunk = await new Promise<Buffer>((resolveChunk, reject) => {
          const onData = (data: Buffer): void => { cleanup(); resolveChunk(data); };
          const onError = (error: Error): void => { cleanup(); reject(error); };
          const cleanup = (): void => {
            process.stdin.off("data", onData);
            process.stdin.off("error", onError);
          };
          process.stdin.once("data", onData);
          process.stdin.once("error", onError);
        });
        for (const byte of chunk) {
          if (byte === 3) throw new Error(`${options.label} passphrase entry cancelled`);
          if (byte === 13 || byte === 10) { process.stderr.write("\n"); return value; }
          if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
          if (byte >= 32) value += String.fromCharCode(byte);
        }
      }
    } finally {
      process.stdin.setRawMode!(false);
      process.stdin.pause();
    }
  };
  const first = await readHidden(`${options.label} passphrase: `);
  if (first.length < 12) throw new Error(`${options.label} passphrase must contain at least 12 characters`);
  if (options.confirm) {
    const second = await readHidden(`Confirm ${options.label.toLowerCase()} passphrase: `);
    if (first !== second) throw new Error(`${options.label} passphrases do not match`);
  }
  return first;
}

async function recoveryPassphrase(confirm: boolean): Promise<string> {
  return hiddenPassphrase({
    environmentName: "FRIDAY_VAULT_RECOVERY_PASSPHRASE",
    label: "Vault recovery",
    confirm,
  });
}

async function backupPassphrase(confirm: boolean): Promise<string> {
  return hiddenPassphrase({
    environmentName: "FRIDAY_BACKUP_PASSPHRASE",
    label: "Backup encryption",
    confirm,
  });
}


export async function runBackupCli(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  const backupRoot = optionValue(rest, "--directory");
  if (command === "create") {
    ensureKnown(rest, ["--directory", "--retain"], ["--encrypt"]);
    const retainValue = optionValue(rest, "--retain");
    const retain = retainValue === undefined ? undefined : Number(retainValue);
    const passphrase = rest.includes("--encrypt") ? await backupPassphrase(true) : undefined;
    const manifest = await createStateBackup({
      ...(backupRoot ? { backupRoot: resolve(backupRoot) } : {}),
      ...(retain === undefined ? {} : { retain }),
      ...(passphrase === undefined ? {} : { passphrase }),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "list") {
    ensureKnown(rest, ["--directory"], []);
    const manifests = await listStateBackups(backupRoot ? { backupRoot: resolve(backupRoot) } : {});
    process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const id = rest[0];
    if (!id || id.startsWith("--")) throw new Error("backup verify requires an id");
    ensureKnown(rest.slice(1), ["--directory"], []);
    let passphrase: string | undefined;
    try {
      const manifest = await verifyStateBackup(id, backupRoot ? { backupRoot: resolve(backupRoot) } : {});
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/backup is encrypted/i.test(error.message)) throw error;
      passphrase = await backupPassphrase(false);
    }
    const manifest = await verifyStateBackup(id, {
      ...(backupRoot ? { backupRoot: resolve(backupRoot) } : {}),
      ...(passphrase === undefined ? {} : { passphrase }),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "restore") {
    const id = rest[0];
    if (!id || id.startsWith("--")) throw new Error("backup restore requires an id");
    ensureKnown(rest.slice(1), ["--directory"], ["--yes"]);
    let passphrase: string | undefined;
    try {
      await verifyStateBackup(id, backupRoot ? { backupRoot: resolve(backupRoot) } : {});
    } catch (error) {
      if (!(error instanceof Error) || !/backup is encrypted/i.test(error.message)) throw error;
      passphrase = await backupPassphrase(false);
    }
    const result = await restoreStateBackup(id, {
      ...(backupRoot ? { backupRoot: resolve(backupRoot) } : {}),
      ...(passphrase === undefined ? {} : { passphrase }),
      confirm: rest.includes("--yes"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: friday backup create [--encrypt]|list|verify <id>|restore <id> --yes [--directory <path>]");
}

export async function runVaultRecoveryCli(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  const stateDir = optionValue(rest, "--vault-directory") ?? getVaultStateDir();
  const vault = new VaultStore({ stateDir: resolve(stateDir), workspaceRoot: getFridayWorkspace(process.env) });
  if (command === "create") {
    ensureKnown(rest, ["--out", "--vault-directory"], []);
    const output = optionValue(rest, "--out");
    if (!output) throw new Error("vault recovery create requires --out <path>");
    const passphrase = await recoveryPassphrase(true);
    const kit = vault.createRecoveryKit(passphrase);
    const handle = await open(resolve(output), "wx", 0o600);
    try { await handle.writeFile(kit); } finally { await handle.close(); }
    process.stdout.write(`Recovery kit written to ${resolve(output)}. Keep it separate from this machine.\n`);
    return;
  }
  if (command === "restore") {
    ensureKnown(rest, ["--in", "--vault-directory"], ["--replace"]);
    const input = optionValue(rest, "--in");
    if (!input) throw new Error("vault recovery restore requires --in <path>");
    const bytes = await readFile(resolve(input));
    const passphrase = await recoveryPassphrase(false);
    vault.recoverFromKit(bytes, passphrase, { replaceExisting: rest.includes("--replace") });
    process.stdout.write("Vault recovery key verified and installed.\n");
    return;
  }
  throw new Error("Usage: friday vault recovery create --out <path> | restore --in <path> [--replace]");
}

export function maintenanceHelp(): string {
  return [
    "Maintenance:",
    `  friday backup create [--encrypt] [--retain N] [--directory PATH]  (default ${getStateBackupRoot()})`,
    "  friday backup list|verify <id>",
    "  friday backup restore <id> --yes",
    "  friday vault recovery create --out PATH",
    "  friday vault recovery restore --in PATH [--replace]",
    "",
    "Run backup/restore while FRIDAY is stopped. Backup and recovery passphrases are read from a hidden TTY",
    "or FRIDAY_BACKUP_PASSPHRASE / FRIDAY_VAULT_RECOVERY_PASSPHRASE; they are never accepted as command-line arguments.",
  ].join("\n");
}
