import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import {
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import { createVaultPlugin } from "../plugins/vault/index.js";
import { VAULT_CAPABILITY } from "../plugins/vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../plugins/vault/trusted-contract.js";

const dirs: string[] = [];

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "friday-vault-root-"));
  dirs.push(path);
  return path;
}

afterEach(() => {
  uninstallCapabilityRegistry();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function activateVault(home: string) {
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(createVaultPlugin({ stateDir: join(home, "vault"), workspaceRoot: process.cwd() }));
  return friday;
}

describe("vault plugin", () => {
  it("provides a metadata-only model-safe capability and a distinct trusted host capability", async () => {
    await activateVault(temp());
    const safe = requireCapability(VAULT_CAPABILITY);
    const trusted = requireCapability(VAULT_TRUSTED_CAPABILITY);

    expect(Object.keys(safe).sort()).toEqual(["exists", "inspect", "list", "normalizeRef"]);
    expect(safe).not.toHaveProperty("create");
    expect(safe).not.toHaveProperty("rotate");
    expect(safe).not.toHaveProperty("remove");
    expect(safe).not.toHaveProperty("consume");
    expect(Object.keys(trusted).sort()).toEqual([
      "consume",
      "create",
      "createRecoveryKit",
      "recoverFromKit",
      "remove",
      "rotate",
    ]);
  });

  it("keeps plaintext outside metadata and persistent vault state while allowing trusted consumption", async () => {
    const home = temp();
    await activateVault(home);
    const safe = requireCapability(VAULT_CAPABILITY);
    const trusted = requireCapability(VAULT_TRUSTED_CAPABILITY);
    const sentinel = "ROOT_VAULT_SECRET_SENTINEL_9281";
    const created = trusted.create({
      ref: "vault://gmail/work/oauth",
      kind: "oauth",
      secret: sentinel,
    });

    expect(safe.inspect(created.ref)).toEqual(created);
    expect(JSON.stringify(safe.list())).not.toContain(sentinel);
    expect(readFileSync(join(home, "vault", "vault.json"), "utf8")).not.toContain(sentinel);

    let observed = "";
    await trusted.consume(created.ref, (secret) => {
      observed = Buffer.from(secret).toString("utf8");
    });
    expect(observed).toBe(sentinel);
  });
});
