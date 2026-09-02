import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStateBackup,
  getStateBackupRoot,
  listStateBackups,
  restoreStateBackup,
  verifyStateBackup,
} from "../src/state-backup.js";
import { acquireRuntimeLease } from "../src/runtime-coordination.js";

const directories: string[] = [];

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "friday-state-backup-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("full-state backup", () => {

  it("excludes rebuildable runtime bundles and tooling from durable state backups", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(join(home, ".runtime", "bundle-old"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "tooling", "execution-python", "venv"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".runtime", "bundle-old", "asset"), "rebuildable", { mode: 0o600 });
    await writeFile(join(home, "tooling", "execution-python", "venv", "python"), "rebuildable", { mode: 0o600 });
    await writeFile(join(home, "state.json"), "durable", { mode: 0o600 });

    const manifest = await createStateBackup({
      environment: { FRIDAY_HOME: home } as NodeJS.ProcessEnv,
      backupRoot: backups,
      idFactory: () => "exclude-rebuildable",
    });
    expect(manifest.entries.map((entry) => `${entry.root}/${entry.path}`)).toEqual(["home/state.json"]);
  });
  it("derives a sibling hidden backup directory without duplicating a leading dot", async () => {
    const parent = await temp();
    expect(getStateBackupRoot({ FRIDAY_HOME: join(parent, ".friday") } as NodeJS.ProcessEnv)).toBe(
      join(parent, ".friday-backups"),
    );
    expect(getStateBackupRoot({ FRIDAY_HOME: join(parent, "custom-home") } as NodeJS.ProcessEnv)).toBe(
      join(parent, ".custom-home-backups"),
    );
    expect(getStateBackupRoot({
      FRIDAY_HOME: join(parent, ".friday"),
      FRIDAY_BACKUP_DIR: join(parent, "explicit-backups"),
    } as NodeJS.ProcessEnv)).toBe(join(parent, "explicit-backups"));
  });

  it("copies home and disjoint mission state, verifies hashes, and restores atomically", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const state = join(parent, "mission");
    const backups = join(parent, "backups");
    await mkdir(join(home, "vault"), { recursive: true, mode: 0o700 });
    await mkdir(join(state, "sessions"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "vault", "vault.json"), "encrypted-vault-state", { mode: 0o600 });
    await writeFile(join(state, "sessions", "one.jsonl"), "session-one", { mode: 0o600 });
    const environment = { FRIDAY_HOME: home, FRIDAY_STATE_DIR: state } as NodeJS.ProcessEnv;

    const manifest = await createStateBackup({
      environment,
      backupRoot: backups,
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      idFactory: () => "one",
    });
    expect(manifest.roots.map((root) => root.kind)).toEqual(["home", "state"]);
    expect(manifest.entries.map((entry) => `${entry.root}/${entry.path}`)).toEqual([
      "home/vault/vault.json",
      "state/sessions/one.jsonl",
    ]);
    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups })).resolves.toMatchObject({
      id: manifest.id,
      complete: true,
    });

    await writeFile(join(home, "vault", "vault.json"), "broken-current-state", { mode: 0o600 });
    await writeFile(join(state, "sessions", "one.jsonl"), "broken-session", { mode: 0o600 });
    const restored = await restoreStateBackup(manifest.id, { environment, backupRoot: backups, confirm: true });
    expect(await readFile(join(home, "vault", "vault.json"), "utf8")).toBe("encrypted-vault-state");
    expect(await readFile(join(state, "sessions", "one.jsonl"), "utf8")).toBe("session-one");
    expect(restored.previousRoots).toHaveLength(2);
  });

  it("rejects tampering and requires explicit restore confirmation", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "state.json"), "original", { mode: 0o600 });
    const environment = { FRIDAY_HOME: home } as NodeJS.ProcessEnv;
    const manifest = await createStateBackup({ environment, backupRoot: backups, idFactory: () => "tamper" });
    await writeFile(join(backups, manifest.id, "data", "home", "state.json"), "tampered", { mode: 0o600 });

    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups })).rejects.toThrow(/metadata mismatch|hash mismatch/);
    await expect(restoreStateBackup(manifest.id, { environment, backupRoot: backups, confirm: false })).rejects.toThrow(
      /explicit confirmation/,
    );
  });

  it("treats file mode as authenticated backup metadata and restores the verified mode", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const stateFile = join(home, "secret.json");
    await writeFile(stateFile, "secret", { mode: 0o600 });
    const environment = { FRIDAY_HOME: home } as NodeJS.ProcessEnv;
    const manifest = await createStateBackup({ environment, backupRoot: backups, idFactory: () => "mode" });
    const backupFile = join(backups, manifest.id, "data", "home", "secret.json");

    await chmod(backupFile, 0o644);
    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups })).rejects.toThrow(/metadata mismatch/);

    await chmod(backupFile, 0o600);
    await chmod(stateFile, 0o666);
    await restoreStateBackup(manifest.id, { environment, backupRoot: backups, confirm: true });
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
  });


  it("encrypts full-state backup contents, authenticates metadata, and restores only with the correct passphrase", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const stateFile = join(home, "private-session.json");
    const plaintext = "private conversation and scheduler state\n";
    await writeFile(stateFile, plaintext, { mode: 0o600 });
    const environment = { FRIDAY_HOME: home } as NodeJS.ProcessEnv;
    const passphrase = "correct horse battery staple";

    const manifest = await createStateBackup({
      environment,
      backupRoot: backups,
      idFactory: () => "encrypted",
      passphrase,
    });
    expect(manifest.encryption).toMatchObject({ algorithm: "aes-256-gcm", kdf: "scrypt" });
    const stored = join(backups, manifest.id, "data", "home", "private-session.json");
    const ciphertext = await readFile(stored);
    expect(ciphertext.toString("utf8")).not.toContain(plaintext.trim());
    expect((await stat(stored)).mode & 0o777).toBe(0o600);

    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups })).rejects.toThrow(/passphrase/i);
    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups, passphrase: "wrong password that is long" })).rejects.toThrow(
      /incorrect|modified/i,
    );
    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups, passphrase })).resolves.toMatchObject({
      id: manifest.id,
      complete: true,
    });

    await writeFile(stateFile, "replacement current state", { mode: 0o600 });
    await restoreStateBackup(manifest.id, { environment, backupRoot: backups, passphrase, confirm: true });
    expect(await readFile(stateFile, "utf8")).toBe(plaintext);
  });

  it("rejects encrypted ciphertext tampering before restore", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "secret.txt"), "secret-state", { mode: 0o600 });
    const environment = { FRIDAY_HOME: home } as NodeJS.ProcessEnv;
    const passphrase = "another sufficiently long passphrase";
    const manifest = await createStateBackup({ environment, backupRoot: backups, idFactory: () => "tampered-encrypted", passphrase });
    const stored = join(backups, manifest.id, "data", "home", "secret.txt");
    const bytes = await readFile(stored);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await writeFile(stored, bytes, { mode: 0o600 });

    await expect(verifyStateBackup(manifest.id, { environment, backupRoot: backups, passphrase })).rejects.toThrow(/authentication failed/i);
    await expect(restoreStateBackup(manifest.id, { environment, backupRoot: backups, passphrase, confirm: true })).rejects.toThrow(
      /authentication failed/i,
    );
  });

  it("applies bounded retention only after a complete replacement exists", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "state.json"), "one", { mode: 0o600 });
    const environment = { FRIDAY_HOME: home } as NodeJS.ProcessEnv;
    for (const [day, id] of [[1, "one"], [2, "two"], [3, "three"]] as const) {
      await createStateBackup({
        environment,
        backupRoot: backups,
        retain: 2,
        now: () => new Date(`2026-08-0${day}T00:00:00.000Z`),
        idFactory: () => id,
      });
    }
    const manifests = await listStateBackups({ environment, backupRoot: backups });
    expect(manifests.map((entry) => entry.id)).toEqual([
      "20260803T000000000Z-three",
      "20260802T000000000Z-two",
    ]);
  });

  it("refuses a live runtime so SQLite and append-only files cannot be copied mid-transaction", async () => {
    const parent = await temp();
    const home = join(parent, "home");
    const backups = join(parent, "backups");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "state.json"), "stable", { mode: 0o600 });
    const environment = { FRIDAY_HOME: home } as NodeJS.ProcessEnv;
    const release = await acquireRuntimeLease({ environment });
    try {
      await expect(createStateBackup({ environment, backupRoot: backups, idFactory: () => "blocked" })).rejects.toThrow(
        /must be stopped/,
      );
    } finally {
      await release();
    }
    await expect(createStateBackup({ environment, backupRoot: backups, idFactory: () => "safe" })).resolves.toMatchObject({
      complete: true,
    });
  });
});
