import { chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readSavedChannels } from "../plugins/channels/config.js";
import { modelCredentialVaultRef, modelOAuthCredentialVaultRef, modelProviderTypicallyNeedsApiKey } from "../plugins/auth/model-credential-ref.js";
import { collectDoctorChecks as collectCanonicalDoctorChecks, type DoctorSources } from "../plugins/host-doctor/collector.js";
import { hasFridayPrivilegedHelper } from "../plugins/host-privileges/privileged.js";
import type { DoctorCheck, DoctorLevel, DoctorRepairId, DoctorSection } from "../plugins/host-doctor/contract.js";
import { getFridayHome, readRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { selectSandboxProvider } from "../plugins/sandbox/providers/index.js";
import { voiceCredentialVaultRef } from "../plugins/voice/credential-ref.js";
import { readVoiceSettings } from "../plugins/voice/settings.js";
import { runSetupCli } from "./setup-cli.js";
import { FRIDAY_VERSION } from "./version.js";

export type { DoctorCheck, DoctorLevel, DoctorRepairId, DoctorSection } from "../plugins/host-doctor/contract.js";

const CLI_DOCTOR_SOURCES: DoctorSources = Object.freeze({
  runtimeSettings: (home: string) => readRuntimeSettings(home),
  async channels(home: string) {
    const saved = await readSavedChannels(home);
    const enabledEntries = Object.entries(saved.channels).filter(([, value]) => value?.enabled);
    return Object.freeze({
      enabled: Object.freeze(enabledEntries.map(([id]) => id).sort()),
      allowAll: Object.freeze(enabledEntries.filter(([, value]) => value?.allowAll === true).map(([id]) => id).sort()),
      whatsappEnabled: saved.channels.whatsapp?.enabled === true,
    });
  },
  async modelCredential(provider: string, vaultRefs: ReadonlySet<string>) {
    const apiKeyRef = modelCredentialVaultRef(provider);
    const oauthRef = modelOAuthCredentialVaultRef(provider);
    return Object.freeze({
      apiKeyRef,
      oauthRef,
      hasApiKey: vaultRefs.has(apiKeyRef),
      hasOAuth: vaultRefs.has(oauthRef),
      typicallyNeedsApiKey: modelProviderTypicallyNeedsApiKey(provider),
    });
  },
  async voice(home: string, vaultRefs: ReadonlySet<string>) {
    const settings = await readVoiceSettings(home);
    if (!settings?.stt && !settings?.tts) {
      return Object.freeze({ configured: false, missingCredentials: Object.freeze([]) });
    }
    const providers = [...new Set([settings.stt?.provider, settings.tts?.provider].filter((value): value is "openai" | "deepgram" | "elevenlabs" => Boolean(value)))];
    const missing = providers.filter((provider) => {
      const ref = provider === "openai" ? modelCredentialVaultRef("openai") : voiceCredentialVaultRef(provider);
      return !vaultRefs.has(ref);
    });
    return Object.freeze({
      configured: true,
      detail: [settings.stt ? `STT=${settings.stt.provider}/${settings.stt.model}` : undefined, settings.tts ? `TTS=${settings.tts.provider}/${settings.tts.model}` : undefined].filter(Boolean).join(" · "),
      missingCredentials: Object.freeze(missing),
    });
  },
  async hostPrivileges(home: string) {
    const settings = await readRuntimeSettings(home);
    const privilegeMode = settings?.hostPrivilegeMode ?? "none";
    const privilegedHelperInstalled = await hasFridayPrivilegedHelper();
    return Object.freeze({
      privilegeMode,
      privilegedHelperInstalled,
      ready: privilegeMode === "none" || privilegedHelperInstalled,
    });
  },
  async sandbox() {
    const provider = selectSandboxProvider();
    const service = provider.createService();
    const status = provider.probe();
    return Object.freeze({
      available: status.available,
      displayName: provider.descriptor.displayName,
      detail: [provider.descriptor.id, provider.descriptor.isolationClass, service.image, status.reason ?? status.status].filter(Boolean).join(" · "),
      status: status.status,
      imageMissing: status.status === "image-missing",
      repairHint: provider.repairHint(status),
    });
  },
});

export function collectDoctorChecks(environment: NodeJS.ProcessEnv = process.env): Promise<readonly DoctorCheck[]> {
  return collectCanonicalDoctorChecks(environment, CLI_DOCTOR_SOURCES);
}

const SECTION_ORDER: readonly DoctorSection[] = Object.freeze(["Installation", "Configuration", "Security", "Tooling", "Recovery"]);

function levelSymbol(level: DoctorLevel): string {
  if (level === "ok") return "✓";
  if (level === "info") return "·";
  if (level === "warn") return "!";
  return "✗";
}

function resultLabel(checks: readonly DoctorCheck[]): string {
  if (checks.some((item) => item.level === "error")) return "NEEDS ATTENTION";
  if (checks.some((item) => item.level === "warn")) return "READY WITH WARNINGS";
  return "READY";
}

export function formatDoctorReport(checks: readonly DoctorCheck[], environment: NodeJS.ProcessEnv = process.env): string {
  const counts = {
    ok: checks.filter((item) => item.level === "ok").length,
    info: checks.filter((item) => item.level === "info").length,
    warn: checks.filter((item) => item.level === "warn").length,
    error: checks.filter((item) => item.level === "error").length,
  };
  const home = getFridayHome(environment);
  const lines = [
    `F.R.I.D.A.Y Doctor  v${FRIDAY_VERSION}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Status   ${resultLabel(checks)}`,
    `System   ${process.platform}/${process.arch} · Node ${process.version}`,
    `Home     ${home}`,
    `Summary  ${counts.ok} healthy · ${counts.info} optional/info · ${counts.warn} warning · ${counts.error} blocked`,
  ];

  for (const section of SECTION_ORDER) {
    const sectionChecks = checks.filter((item) => item.section === section);
    if (sectionChecks.length === 0) continue;
    lines.push("", section.toUpperCase());
    for (const item of sectionChecks) {
      lines.push(`  ${levelSymbol(item.level)} ${item.label.padEnd(22)} ${item.message}`);
      if (item.detail) lines.push(`      ${item.detail}`);
      if (item.level !== "ok" && item.fix) lines.push(`      → ${item.fix}`);
    }
  }

  const actionable = checks.filter((item) => item.level !== "ok" && item.fix);
  if (actionable.length > 0) {
    lines.push("", `Next  ${actionable.length} item(s) have a one-line repair guide above.`);
    if (checks.some((item) => item.repair && item.level !== "ok")) {
      lines.push("      Run `friday doctor --fix` for guided repairs that F.R.I.D.A.Y can perform safely.");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function confirmRepair(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function runRepairs(checks: readonly DoctorCheck[], environment: NodeJS.ProcessEnv): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`friday doctor --fix` requires an interactive terminal; use plain `friday doctor` or `--json` in automation");
  }
  const repairs = [...new Set(checks.filter((item) => item.level !== "ok").map((item) => item.repair).filter((item): item is DoctorRepairId => Boolean(item)))];
  if (repairs.length === 0) {
    process.stdout.write("\nNo safe automatic repairs are currently available. Follow the one-line guides above.\n");
    return;
  }

  for (const repair of repairs) {
    if (repair === "home-permissions") {
      const home = getFridayHome(environment);
      if (await confirmRepair(`Set ${home} permissions to 0700?`)) await chmod(home, 0o700);
      continue;
    }
    if (repair === "setup") {
      if (await confirmRepair("Run interactive `friday setup` now?")) await runSetupCli([]);
      continue;
    }
    if (repair === "execution-python") {
      if (await confirmRepair("Provision the private Python execution environment now?")) await runSetupCli(["execution-python"]);
      continue;
    }
    if (repair === "sandbox") {
      if (await confirmRepair("Prepare/repair the configured sandbox provider now?")) await runSetupCli(["sandbox"]);
    }
  }
}

function doctorHelp(): string {
  return [
    "F.R.I.D.A.Y doctor",
    "",
    "Usage:",
    "  friday doctor          Run local health/security/recovery diagnostics",
    "  friday doctor --fix    Offer guided repairs only for deterministic supported fixes",
    "  friday doctor --json   Emit machine-readable diagnostics without prompts",
    "  friday doctor --help",
    "",
    "Doctor does not make outbound network requests or read plaintext Vault secrets.",
    "Potentially consequential repairs are never performed unless `--fix` is explicitly requested and confirmed.",
    "",
  ].join("\n");
}

export async function runDoctor(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    if (args.length !== 1) throw new Error("`friday doctor --help` does not accept additional options");
    process.stdout.write(doctorHelp());
    return 0;
  }
  const json = args.includes("--json");
  const fix = args.includes("--fix");
  const unknown = args.filter((arg) => arg !== "--json" && arg !== "--fix");
  if (unknown.length > 0) throw new Error(`Unknown doctor option(s): ${unknown.join(" ")}`);
  if (json && fix) throw new Error("`friday doctor --json` cannot be combined with `--fix`");

  let checks = await collectDoctorChecks(process.env);
  if (json) {
    const publicChecks = checks.map(({ repair: _repair, ...item }) => item);
    process.stdout.write(`${JSON.stringify({ version: FRIDAY_VERSION, status: resultLabel(checks), checks: publicChecks }, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorReport(checks, process.env));
    if (fix) {
      await runRepairs(checks, process.env);
      checks = await collectDoctorChecks(process.env);
      process.stdout.write(`\nAfter guided repairs\n${formatDoctorReport(checks, process.env)}`);
    }
  }
  return checks.some((item) => item.level === "error") ? 1 : 0;
}
