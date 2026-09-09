import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveSavedChannels } from "../plugins/channels/config.js";
import { modelCredentialVaultRef, modelOAuthCredentialVaultRef } from "../plugins/auth/model-credential-ref.js";
import { VaultStore, getVaultStateDir } from "@friday/vault";
import { saveRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { collectDoctorChecks, formatDoctorReport } from "../src/doctor.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  await chmod(path, 0o700);
  return path;
}

async function sourceFixture(): Promise<string> {
  const repository = await temp("friday-doctor-repo-");
  await mkdir(join(repository, "plugins", "self-improvement"), { recursive: true, mode: 0o700 });
  await writeFile(join(repository, "package.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(repository, ".node-version"), `${process.version.replace(/^v/u, "")}\n`, { mode: 0o600 });
  await execFileAsync("git", ["init"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "friday-doctor@example.com"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "FRIDAY Doctor"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "doctor fixture"], { cwd: repository });
  return repository;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("friday doctor", () => {
  it("reports configured runtime, ingress, security boundaries, source checkout, tooling, and recovery health", async () => {
    const home = await temp("friday-doctor-home-");
    const workspace = await temp("friday-doctor-workspace-");
    const repository = await sourceFixture();

    await saveRuntimeSettings({
      modelProvider: "openai",
      modelId: "gpt-5",
      permissionMode: "ask",
      timezone: "UTC",
      workspaceRoot: workspace,
      selfRepository: repository,
    }, home);
    const vault = new VaultStore({ stateDir: getVaultStateDir({ FRIDAY_HOME: home }), workspaceRoot: workspace });
    vault.create({ ref: modelCredentialVaultRef("openai"), kind: "model-api-key", secret: "doctor-test-key" });
    await saveSavedChannels({ telegram: { enabled: true, allowAll: false, allowedSenderIds: ["owner"] } }, home);

    const environment = { ...process.env, FRIDAY_HOME: home, FRIDAY_SANDBOX_NETWORK_MODE: "requested" };
    const checks = await collectDoctorChecks(environment);
    const byId = new Map(checks.map((entry) => [entry.id, entry]));
    expect(byId.get("home")?.level).toBe("ok");
    expect(byId.get("runtime-settings")?.level).toBe("ok");
    expect(byId.get("workspace")).toMatchObject({ level: "ok" });
    expect(byId.get("model-credential")).toMatchObject({ level: "ok" });
    expect(byId.get("voice")).toMatchObject({ level: "info" });
    expect(byId.get("whatsapp-tooling")).toMatchObject({ level: "info" });
    expect(byId.get("channels")).toMatchObject({ level: "ok" });
    expect(byId.get("channel-access")).toMatchObject({ level: "ok" });
    expect(byId.get("permission-mode")).toMatchObject({ level: "ok", message: "ask" });
    expect(byId.get("sandbox-network")).toMatchObject({ level: "ok" });
    expect(byId.get("vault")?.level).not.toBe("error");
    expect(byId.get("self-repository")).toMatchObject({ level: "ok" });
    expect(byId.get("node-toolchain")).toMatchObject({ level: "ok" });
    expect(byId.get("disk")?.level).not.toBe("error");
    expect(checks.some((entry) => entry.level === "error")).toBe(false);

    const report = formatDoctorReport(checks, environment);
    expect(report).toContain("F.R.I.D.A.Y Doctor");
    expect(report).toContain("INSTALLATION");
    expect(report).toContain("CONFIGURATION");
    expect(report).toContain("SECURITY");
    expect(report).toContain("TOOLING");
    expect(report).toContain("RECOVERY");
    expect(report).toContain("Summary");
  }, 15_000);

  it("recognizes OAuth-only model authentication stored in Vault", async () => {
    const home = await temp("friday-doctor-oauth-home-");
    const workspace = await temp("friday-doctor-oauth-workspace-");
    await saveRuntimeSettings({
      modelProvider: "anthropic",
      modelId: "claude-test",
      permissionMode: "ask",
      timezone: "UTC",
      workspaceRoot: workspace,
    }, home);
    const vault = new VaultStore({ stateDir: getVaultStateDir({ FRIDAY_HOME: home }), workspaceRoot: workspace });
    vault.create({
      ref: modelOAuthCredentialVaultRef("anthropic"),
      kind: "model-oauth",
      secret: JSON.stringify({ access: "test-access", refresh: "test-refresh", expires: Date.now() + 60_000 }),
    });

    const checks = await collectDoctorChecks({ ...process.env, FRIDAY_HOME: home });
    const credential = checks.find((entry) => entry.id === "model-credential");
    expect(credential).toMatchObject({ level: "ok", message: "main OAuth credential stored in Vault" });
    expect(credential?.detail).toBe(modelOAuthCredentialVaultRef("anthropic"));
  });

  it("fails health when first-run configuration is missing and gives one-line fixes", async () => {
    const home = await temp("friday-doctor-empty-home-");
    const environment = { ...process.env, FRIDAY_HOME: home };
    const checks = await collectDoctorChecks(environment);
    expect(checks.find((entry) => entry.id === "runtime-settings")).toMatchObject({ level: "error", fix: "friday setup" });
    expect(checks.find((entry) => entry.id === "channels")).toMatchObject({ level: "error", fix: "friday setup" });
    const report = formatDoctorReport(checks, environment);
    expect(report).toContain("→ friday setup");
    expect(report).toContain("friday doctor --fix");
  });

  it("warns when a channel accepts all senders, full permissions are enabled, or sandbox networking is unrestricted", async () => {
    const home = await temp("friday-doctor-risk-home-");
    const workspace = await temp("friday-doctor-risk-workspace-");
    await saveRuntimeSettings({
      modelProvider: "openai",
      modelId: "gpt-5",
      permissionMode: "full",
      timezone: "UTC",
      workspaceRoot: workspace,
    }, home);
    await saveSavedChannels({ telegram: { enabled: true, allowAll: true } }, home);

    const checks = await collectDoctorChecks({
      ...process.env,
      FRIDAY_HOME: home,
      FRIDAY_SANDBOX_NETWORK_MODE: "unrestricted",
    });
    expect(checks.find((entry) => entry.id === "permission-mode")).toMatchObject({ level: "warn", fix: "friday setup --permission ask" });
    expect(checks.find((entry) => entry.id === "channel-access")?.level).toBe("warn");
    expect(checks.find((entry) => entry.id === "sandbox-network")?.level).toBe("warn");
  });
  it("fails health when the configured workspace overlaps protected FRIDAY state", async () => {
    const home = await temp("friday-doctor-overlap-home-");
    const workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await saveRuntimeSettings({
      modelProvider: "openai",
      modelId: "gpt-5",
      permissionMode: "ask",
      timezone: "UTC",
      workspaceRoot: workspace,
    }, home);

    const checks = await collectDoctorChecks({ ...process.env, FRIDAY_HOME: home });
    expect(checks.find((entry) => entry.id === "workspace")).toMatchObject({
      level: "error",
      message: "overlaps FRIDAY state",
    });
  });

});
