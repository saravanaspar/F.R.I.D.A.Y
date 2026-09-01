import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface WorkspaceRecord {
  name: string;
  path: string;
}

interface AssetRecord {
  source: string;
  target: string;
  manifest: string;
  role?: string;
  context?: string;
}

function runJson(script: string, args: readonly string[]): unknown {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${script} exited ${result.status}`);
  return JSON.parse(result.stdout) as unknown;
}

describe("workspace and binary packaging discovery", () => {
  it("discovers workspace packages from layout patterns instead of a package-name registry", async () => {
    const [rootPackage, lock] = await Promise.all([
      readFile("package.json", "utf8").then((text) => JSON.parse(text) as { workspaces?: string[]; scripts?: Record<string, string> }),
      readFile("package-lock.json", "utf8").then((text) => JSON.parse(text) as { packages?: Record<string, { workspaces?: string[] }> }),
    ]);
    expect(rootPackage.workspaces).toEqual(["packages/*", "plugins/*/runtime"]);
    expect(lock.packages?.[""]?.workspaces).toEqual(rootPackage.workspaces);
    expect(rootPackage.scripts?.["build:workspaces"]).toBe("node scripts/workspace-packages.mjs build");
    expect(rootPackage.scripts?.["test:workspaces"]).toContain("node scripts/workspace-packages.mjs test");
    expect(rootPackage.scripts?.["clean:workspace-node-modules"]).toBe("node scripts/workspace-packages.mjs clean-node-modules");
    expect(rootPackage.scripts?.["check:workspace-node-modules"]).toBe("node scripts/workspace-packages.mjs check-node-modules");
    expect(rootPackage.scripts?.["check:packaging"]).toContain("node scripts/workspace-packages.mjs check-node-modules");
    expect(await readFile(".npmrc", "utf8")).toContain("install-strategy=hoisted");

    const workspaces = runJson("scripts/workspace-packages.mjs", ["list", "--json"]) as WorkspaceRecord[];
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "@friday/operational-errors", path: "packages/operational-errors" }),
      expect.objectContaining({ name: "@friday/channels", path: "plugins/channels/runtime" }),
      expect.objectContaining({ name: "@friday/agent", path: "plugins/agent/runtime" }),
    ]));
    expect(new Set(workspaces.map((workspace) => workspace.name)).size).toBe(workspaces.length);
    const operationalErrors = workspaces.findIndex((workspace) => workspace.name === "@friday/operational-errors");
    expect(operationalErrors).toBeGreaterThanOrEqual(0);
    expect(operationalErrors).toBeLessThan(workspaces.findIndex((workspace) => workspace.name === "@friday/agent"));
    expect(operationalErrors).toBeLessThan(workspaces.findIndex((workspace) => workspace.name === "@friday/channels"));
  });

  it("collects embedded runtime files from owner manifests with layout-independent targets", async () => {
    const assets = runJson("scripts/binary-assets.mjs", ["list", "--json"]) as AssetRecord[];
    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "sandbox/Containerfile", role: "sandbox-containerfile", context: "plugins/sandbox" }),
      expect.objectContaining({ target: "channels/email/email_bridge.py" }),
      expect.objectContaining({ target: "channels/whatsapp/bridge.mjs" }),
      expect.objectContaining({ target: "rlm/python/rlm/__init__.py" }),
    ]));
    expect(assets.every((asset) => !asset.target.startsWith("plugins/") && !asset.target.startsWith("packages/"))).toBe(true);
    expect(new Set(assets.map((asset) => asset.target)).size).toBe(assets.length);
  });

  it("keeps bundled-runtime consumers on the stable logical asset targets", async () => {
    const [sandbox, email, whatsapp, rlm, setup] = await Promise.all([
      readFile("plugins/sandbox/podman.ts", "utf8"),
      readFile("plugins/channels/runtime/src/transports/email.ts", "utf8"),
      readFile("plugins/channels/runtime/src/transports/whatsapp.ts", "utf8"),
      readFile("plugins/rlm/runtime/src/python-runtime.ts", "utf8"),
      readFile("src/setup-cli.ts", "utf8"),
    ]);
    expect(sandbox).toContain('join(bundled, "sandbox", "Containerfile")');
    expect(email).toContain('join(bundled, "channels", "email", "email_bridge.py")');
    expect(whatsapp).toContain('join(bundled, "channels", "whatsapp")');
    expect(rlm).toContain('resolve(bundled, "rlm", "python")');
    expect(setup).toContain('join(bundledRoot()!, "channels", "whatsapp")');
    expect(setup).toContain('join(bundledRoot()!, "sandbox")');
  });

  it("keeps CI and the SEA builder independent from plugin-internal asset paths", async () => {
    const [ci, binaryBuilder] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("scripts/build-binary.mjs", "utf8"),
    ]);
    expect(ci).toContain("npm run verify");
    expect(ci).toContain("npm run build:sandbox-image -- --tag friday-sandbox:ci");
    expect(ci).not.toContain("plugins/sandbox/Containerfile");
    expect(binaryBuilder).toContain("discoverBinaryAssets");
    expect(binaryBuilder).not.toContain("plugins/sandbox/Containerfile");
    expect(binaryBuilder).not.toContain("bridge/email/email_bridge.py");
    expect(binaryBuilder).not.toContain("plugins/rlm/runtime/python");
  });
});
