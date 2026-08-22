import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as publicVaultApi from "../src/index.js";
import {
  VAULT_MASTER_KEY_FILE_NAME,
  VAULT_STATE_FILE_NAME,
  VaultStore,
  getVaultStateDir,
  normalizeVaultRef,
} from "../src/index.js";
import { loadVaultState, recordKey } from "../src/storage.js";

const directories: string[] = [];

function temp(prefix = "friday-vault-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

function store(
  options: {
    dir?: string;
    workspaceRoot?: string;
    now?: () => Date;
    randomBytes?: (size: number) => Buffer;
  } = {},
): VaultStore {
  const dir = options.dir ?? temp();
  return new VaultStore({
    stateDir: dir,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("vault public API", () => {
  it("does not export raw master-key accessors or a direct secret getter", () => {
    expect(publicVaultApi).not.toHaveProperty("loadMasterKey");
    expect(publicVaultApi).not.toHaveProperty("loadOrCreateMasterKey");
    const vault = store();
    expect("getSecret" in vault).toBe(false);
    expect("readSecret" in vault).toBe(false);
  });
});

describe("vault references", () => {
  it("accepts bounded opaque vault references and rejects traversal or encoded paths", () => {
    expect(normalizeVaultRef(" vault://gmail/account-1/oauth ")).toBe("vault://gmail/account-1/oauth");
    for (const value of [
      "secret://gmail/account",
      "vault://gmail/../secret",
      "vault://gmail/%2e%2e/secret",
      "vault://gmail/account?secret=x",
      "vault://gmail/account#fragment",
      "vault:///missing-host",
    ]) {
      expect(() => normalizeVaultRef(value), value).toThrow(/Invalid vault reference/);
    }
  });

  it("keeps the vault state root stable under FRIDAY_HOME and ignores mission state overrides", () => {
    expect(getVaultStateDir({ FRIDAY_HOME: "/tmp/friday-home", FRIDAY_STATE_DIR: "/tmp/mission" })).toBe(
      "/tmp/friday-home/vault",
    );
  });

  it("rejects a vault directory that overlaps the model workspace", () => {
    const workspace = temp("friday-vault-workspace-");
    expect(() => new VaultStore({ stateDir: join(workspace, ".friday", "vault"), workspaceRoot: workspace })).toThrow(
      /must not overlap the model workspace/,
    );
    expect(() => new VaultStore({ stateDir: workspace, workspaceRoot: join(workspace, "project") })).toThrow(
      /must not overlap the model workspace/,
    );

    const redirectRoot = temp("friday-vault-redirect-");
    const redirect = join(redirectRoot, "home-link");
    symlinkSync(workspace, redirect);
    expect(() => new VaultStore({ stateDir: join(redirect, ".friday", "vault"), workspaceRoot: workspace })).toThrow(
      /must not overlap the model workspace/,
    );
  });

  it("revalidates mutable symlink ancestors before every vault filesystem operation", () => {
    const workspace = temp("friday-vault-revalidate-workspace-");
    const safeTarget = temp("friday-vault-revalidate-safe-");
    const redirectRoot = temp("friday-vault-revalidate-link-root-");
    const redirect = join(redirectRoot, "home-link");
    symlinkSync(safeTarget, redirect);
    const vault = new VaultStore({ stateDir: join(redirect, "vault"), workspaceRoot: workspace });

    rmSync(redirect, { force: true });
    symlinkSync(workspace, redirect);
    expect(() => vault.create({ ref: "vault://service/account/token", kind: "token", secret: "secret" })).toThrow(
      /must not overlap the model workspace/,
    );
  });
});

describe("encrypted vault persistence", () => {
  it("creates encrypted-at-rest state with private permissions and metadata only", () => {
    const dir = temp();
    const sentinel = "FRIDAY_SUPER_SECRET_SENTINEL_7319";
    const vault = store({ dir, randomBytes: (size) => Buffer.alloc(size, 7) });
    const created = vault.create({ ref: "vault://gmail/work/oauth", kind: "oauth", secret: sentinel });

    expect(created).toEqual({
      ref: "vault://gmail/work/oauth",
      kind: "oauth",
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(vault.inspect(created.ref)).toEqual(created);
    expect(vault.list()).toEqual([created]);
    expect(JSON.stringify(vault.inspect(created.ref))).not.toContain(sentinel);

    const statePath = join(dir, VAULT_STATE_FILE_NAME);
    const keyPath = join(dir, VAULT_MASTER_KEY_FILE_NAME);
    expect(readFileSync(statePath, "utf8")).not.toContain(sentinel);
    expect(readFileSync(keyPath).toString("utf8")).not.toContain(sentinel);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("persists across store reopen without ever returning secret material from metadata calls", async () => {
    const dir = temp();
    const first = store({ dir });
    first.create({ ref: "vault://github/personal/token", kind: "token", secret: "gh-secret-value" });

    const reopened = store({ dir });
    expect(reopened.exists("vault://github/personal/token")).toBe(true);
    expect(reopened.inspect("vault://github/personal/token")).toMatchObject({
      ref: "vault://github/personal/token",
      kind: "token",
      version: 1,
    });
    let observed = "";
    await reopened.consume("vault://github/personal/token", (secret) => {
      observed = Buffer.from(secret).toString("utf8");
    });
    expect(observed).toBe("gh-secret-value");
  });

  it("filters metadata by vault reference prefix", () => {
    const vault = store();
    vault.create({ ref: "vault://gmail/a/oauth", kind: "oauth", secret: "a" });
    vault.create({ ref: "vault://gmail/b/oauth", kind: "oauth", secret: "b" });
    vault.create({ ref: "vault://github/a/token", kind: "token", secret: "c" });
    expect(vault.list("vault://gmail").map((entry) => entry.ref)).toEqual([
      "vault://gmail/a/oauth",
      "vault://gmail/b/oauth",
    ]);
  });

  it("reloads state for each mutation so independent store instances do not hide prior writes", () => {
    const dir = temp();
    const first = store({ dir });
    const second = store({ dir });
    first.create({ ref: "vault://service/a/token", kind: "token", secret: "a" });
    second.create({ ref: "vault://service/b/token", kind: "token", secret: "b" });
    expect(first.list().map((entry) => entry.ref)).toEqual([
      "vault://service/a/token",
      "vault://service/b/token",
    ]);
  });

  it("does not publish a record when encryption setup fails", () => {
    const dir = temp();
    let calls = 0;
    const vault = store({
      dir,
      randomBytes(size) {
        calls += 1;
        if (calls === 1) return Buffer.alloc(size, 3);
        throw new Error("rng failed");
      },
    });
    expect(() => vault.create({ ref: "vault://service/a/token", kind: "token", secret: "secret" })).toThrow(
      "rng failed",
    );
    expect(vault.list()).toEqual([]);
  });

  it("rotates ciphertext atomically while preserving identity and creation time", async () => {
    const dir = temp();
    const times = [new Date("2026-08-18T00:00:00.000Z"), new Date("2026-08-19T00:00:00.000Z")];
    const vault = store({ dir, now: () => times.shift()! });
    const first = vault.create({ ref: "vault://calendar/work/oauth", kind: "oauth", secret: "old-secret" });
    const rotated = vault.rotate(first.ref, "new-secret");
    expect(rotated).toMatchObject({ ref: first.ref, kind: "oauth", version: 2, createdAt: first.createdAt });
    expect(rotated.updatedAt).not.toBe(first.updatedAt);
    let observed = "";
    await vault.consume(first.ref, (secret) => {
      observed = Buffer.from(secret).toString("utf8");
    });
    expect(observed).toBe("new-secret");
    expect(readFileSync(join(dir, VAULT_STATE_FILE_NAME), "utf8")).not.toContain("old-secret");
    expect(readFileSync(join(dir, VAULT_STATE_FILE_NAME), "utf8")).not.toContain("new-secret");
  });

  it("removes a secret without exposing its previous value", async () => {
    const vault = store();
    vault.create({ ref: "vault://service/account/password", kind: "password", secret: "removed-secret" });
    expect(vault.remove("vault://service/account/password")).toBe(true);
    expect(vault.remove("vault://service/account/password")).toBe(false);
    expect(vault.inspect("vault://service/account/password")).toBeUndefined();
    await expect(vault.consume("vault://service/account/password", () => {})).rejects.toThrow(/Unknown vault secret/);
  });

  it("rejects duplicate, empty, and oversized secret writes without including secret values in errors", () => {
    const vault = store();
    const sentinel = "do-not-echo-this-secret";
    vault.create({ ref: "vault://service/account/token", kind: "token", secret: sentinel });
    for (const action of [
      () => vault.create({ ref: "vault://service/account/token", kind: "token", secret: sentinel }),
      () => vault.create({ ref: "vault://service/empty/token", kind: "token", secret: "" }),
      () => vault.create({ ref: "vault://service/huge/token", kind: "token", secret: Buffer.alloc(256 * 1024 + 1, 1) }),
    ]) {
      try {
        action();
        throw new Error("expected vault write to fail");
      } catch (error) {
        expect(String(error)).not.toContain(sentinel);
      }
    }
  });

  it("fails closed on corrupt state instead of silently resetting secrets", () => {
    const dir = temp();
    const vault = store({ dir });
    vault.create({ ref: "vault://service/account/token", kind: "token", secret: "secret" });
    writeFileSync(join(dir, VAULT_STATE_FILE_NAME), "{broken", { mode: 0o600 });
    expect(() => vault.list()).toThrow(/Unable to parse vault state/);
  });

  it("authenticates encrypted records so ciphertext or metadata tampering cannot be consumed", async () => {
    const dir = temp();
    const vault = store({ dir });
    const ref = "vault://service/account/token";
    vault.create({ ref, kind: "token", secret: "secret" });
    const state = loadVaultState(dir);
    const key = recordKey(ref);
    const record = state.records[key]!;
    const ciphertext = Buffer.from(record.cipher.ciphertext, "base64");
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = {
      ...state,
      records: {
        ...state.records,
        [key]: {
          ...record,
          cipher: { ...record.cipher, ciphertext: ciphertext.toString("base64") },
        },
      },
    };
    ciphertext.fill(0);
    writeFileSync(join(dir, VAULT_STATE_FILE_NAME), `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await expect(vault.consume(ref, () => {})).rejects.toThrow(/authentication failed/);
  });

  it("fails closed when encrypted records exist but the master key is missing", async () => {
    const dir = temp();
    const vault = store({ dir });
    const ref = "vault://service/account/token";
    vault.create({ ref, kind: "token", secret: "secret" });
    rmSync(join(dir, VAULT_MASTER_KEY_FILE_NAME), { force: true });

    await expect(vault.consume(ref, () => {})).rejects.toThrow(/master key is missing/);
    expect(() => vault.rotate(ref, "replacement")).toThrow(/master key is missing/);
    expect(() => vault.create({ ref: "vault://service/other/token", kind: "token", secret: "other" })).toThrow(
      /master key is missing/,
    );
    expect(() => readFileSync(join(dir, VAULT_MASTER_KEY_FILE_NAME))).toThrow();
  });

  it("refuses symlinked master-key or state files", async () => {
    const dir = temp();
    const outside = temp("friday-vault-outside-");
    const vault = store({ dir });
    const ref = "vault://service/account/token";
    vault.create({ ref, kind: "token", secret: "secret" });

    const keyPath = join(dir, VAULT_MASTER_KEY_FILE_NAME);
    renameSync(keyPath, `${keyPath}.real`);
    const outsideKey = join(outside, "outside.key");
    writeFileSync(outsideKey, Buffer.alloc(32, 9), { mode: 0o600 });
    symlinkSync(outsideKey, keyPath);
    await expect(vault.consume(ref, () => {})).rejects.toThrow(/must not be a symbolic link/);

    rmSync(keyPath, { force: true });
    renameSync(`${keyPath}.real`, keyPath);
    const statePath = join(dir, VAULT_STATE_FILE_NAME);
    renameSync(statePath, `${statePath}.real`);
    const outsideState = join(outside, "outside.json");
    writeFileSync(outsideState, "{}", { mode: 0o600 });
    symlinkSync(outsideState, statePath);
    expect(() => vault.list()).toThrow(/must not be a symbolic link/);
  });

  it("fails closed when persisted key/state permissions become group or world readable", () => {
    const dir = temp();
    const vault = store({ dir });
    vault.create({ ref: "vault://service/account/token", kind: "token", secret: "secret" });
    const statePath = join(dir, VAULT_STATE_FILE_NAME);
    chmodSync(statePath, 0o644);
    expect(() => vault.list()).toThrow(/permissions are too broad/);

    chmodSync(statePath, 0o600);
    chmodSync(dir, 0o755);
    expect(() => vault.list()).toThrow(/permissions are too broad/);
  });
});

describe("trusted secret consumption", () => {
  it("wipes the borrowed plaintext buffer after a successful callback", async () => {
    const vault = store();
    vault.create({ ref: "vault://service/account/token", kind: "token", secret: "transient-secret" });
    let borrowed: Uint8Array | undefined;
    await vault.consume("vault://service/account/token", async (secret) => {
      borrowed = secret;
      expect(Buffer.from(secret).toString("utf8")).toBe("transient-secret");
      await Promise.resolve();
    });
    expect(borrowed).toBeDefined();
    expect([...borrowed!].every((value) => value === 0)).toBe(true);
  });

  it("wipes borrowed plaintext even when the trusted consumer fails", async () => {
    const vault = store();
    vault.create({ ref: "vault://service/account/token", kind: "token", secret: "transient-secret" });
    let borrowed: Uint8Array | undefined;
    await expect(
      vault.consume("vault://service/account/token", (secret) => {
        borrowed = secret;
        throw new Error("consumer failed");
      }),
    ).rejects.toThrow("consumer failed");
    expect([...borrowed!].every((value) => value === 0)).toBe(true);
  });
});

describe("vault recovery", () => {
  it("recovers a missing master key from a passphrase-encrypted kit", async () => {
    const dir = temp();
    const vault = store({ dir });
    const ref = "vault://service/recover/token";
    const sentinel = "recoverable-secret-value";
    vault.create({ ref, kind: "token", secret: sentinel });

    const kit = vault.createRecoveryKit("correct horse battery staple");
    const encoded = Buffer.from(kit).toString("utf8");
    expect(encoded).not.toContain(sentinel);
    expect(Buffer.from(kit).includes(readFileSync(join(dir, VAULT_MASTER_KEY_FILE_NAME)))).toBe(false);

    rmSync(join(dir, VAULT_MASTER_KEY_FILE_NAME), { force: true });
    vault.recoverFromKit(kit, "correct horse battery staple");

    let observed = "";
    await vault.consume(ref, (secret) => { observed = Buffer.from(secret).toString("utf8"); });
    expect(observed).toBe(sentinel);
    expect(lstatSync(join(dir, VAULT_MASTER_KEY_FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it("rejects the wrong passphrase or a kit from another vault before changing local state", () => {
    const firstDir = temp();
    const first = store({ dir: firstDir });
    first.create({ ref: "vault://service/one/token", kind: "token", secret: "first" });
    const kit = first.createRecoveryKit("correct horse battery staple");

    const secondDir = temp();
    const second = store({ dir: secondDir });
    second.create({ ref: "vault://service/two/token", kind: "token", secret: "second" });
    const originalKey = readFileSync(join(secondDir, VAULT_MASTER_KEY_FILE_NAME));

    expect(() => second.recoverFromKit(kit, "definitely the wrong passphrase", { replaceExisting: true })).toThrow(
      /passphrase or kit is invalid/,
    );
    expect(() => second.recoverFromKit(kit, "correct horse battery staple", { replaceExisting: true })).toThrow(
      /authentication failed/,
    );
    expect(readFileSync(join(secondDir, VAULT_MASTER_KEY_FILE_NAME))).toEqual(originalKey);
    originalKey.fill(0);
  });

  it("requires explicit replacement when a master key is already present", () => {
    const vault = store();
    vault.create({ ref: "vault://service/account/token", kind: "token", secret: "secret" });
    const kit = vault.createRecoveryKit("correct horse battery staple");
    expect(() => vault.recoverFromKit(kit, "correct horse battery staple")).toThrow(/explicit replacement/);
    expect(() => vault.createRecoveryKit("short")).toThrow(/12 to 1024/);
  });
});
