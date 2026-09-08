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
    expect(rootPackage.scripts?.["presetup:execution-python"]).toBe("npm run build:workspaces");
    expect(rootPackage.scripts?.["presetup:whatsapp"]).toBe("npm run build:workspaces");
    expect(rootPackage.scripts?.preonboard).toBe("npm run build:workspaces");
    expect(rootPackage.scripts?.["test:workspaces"]).toContain("node scripts/workspace-packages.mjs test");
    expect(rootPackage.scripts?.["version:set"]).toBe("node scripts/release-version.mjs --set");
    expect(rootPackage.scripts?.["check:versions"]).toBe("node scripts/release-version.mjs --check-packages");
    expect(rootPackage.scripts?.["check:packaging"]).toContain("npm run check:versions");
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

  it("keeps workspace test runners from recreating node_modules inside plugins or packages", async () => {
    const workspaces = runJson("scripts/workspace-packages.mjs", ["list", "--json"]) as WorkspaceRecord[];
    for (const workspace of workspaces) {
      const manifest = JSON.parse(await readFile(`${workspace.path}/package.json`, "utf8")) as { scripts?: Record<string, string> };
      const testScript = manifest.scripts?.test;
      if (testScript === undefined) continue;
      expect(testScript).toContain("--configLoader runner");
      expect(testScript).toContain("--no-cache");
    }
  });

  it("collects embedded runtime files from owner manifests with layout-independent targets", async () => {
    const assets = runJson("scripts/binary-assets.mjs", ["list", "--json"]) as AssetRecord[];
    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "sandbox/providers/kern/Containerfile", role: "sandbox-containerfile", context: "plugins/sandbox/providers/kern" }),
      expect.objectContaining({ target: "channels/email/email_bridge.py" }),
      expect.objectContaining({ target: "channels/whatsapp/bridge.mjs" }),
      expect.objectContaining({ target: "rlm/python/rlm/__init__.py" }),
    ]));
    expect(assets.every((asset) => !asset.target.startsWith("plugins/") && !asset.target.startsWith("packages/"))).toBe(true);
    expect(new Set(assets.map((asset) => asset.target)).size).toBe(assets.length);
  });

  it("keeps bundled-runtime consumers on the stable logical asset targets", async () => {
    const [sandbox, email, whatsapp, whatsappTooling, rlm, setup] = await Promise.all([
      readFile("plugins/sandbox/providers/kern/index.ts", "utf8"),
      readFile("plugins/channels/runtime/src/transports/email.ts", "utf8"),
      readFile("plugins/channels/runtime/src/transports/whatsapp.ts", "utf8"),
      readFile("plugins/channels/tooling.ts", "utf8"),
      readFile("plugins/rlm/runtime/src/python-runtime.ts", "utf8"),
      readFile("src/setup-cli.ts", "utf8"),
    ]);
    expect(sandbox).toContain('join(bundled, "sandbox", "providers", "kern", "Containerfile")');
    expect(email).toContain('join(bundled, "channels", "email", "email_bridge.py")');
    expect(whatsapp).toContain('join(bundled, "channels", "whatsapp")');
    expect(whatsappTooling).toContain('join(bundled, "channels", "whatsapp")');
    expect(rlm).toContain('resolve(bundled, "rlm", "python")');
    expect(setup).toContain('setupWhatsApp');
  });

  it("keeps CI and the SEA builder independent from plugin-internal asset paths", async () => {
    const [ci, binaryBuilder] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("scripts/build-binary.mjs", "utf8"),
    ]);
    expect(ci).toContain("npm run verify");
    expect(ci).toContain("test/sandbox-provider.test.ts test/security.test.ts");
    expect(ci).not.toContain("plugins/sandbox/providers/kern/Containerfile");
    expect(binaryBuilder).toContain("discoverBinaryAssets");
    expect(binaryBuilder).not.toContain("plugins/sandbox/providers/kern/Containerfile");
    expect(binaryBuilder).not.toContain("bridge/email/email_bridge.py");
    expect(binaryBuilder).not.toContain("plugins/rlm/runtime/python");
  });
  it("keeps deployment workspace isolation, installer provenance, and Linux SEA smoke checks release-enforced", async () => {
    const [service, readme, prepareRelease, release, ci, installer, runtime, memory, channelsManifest] = await Promise.all([
      readFile("deploy/systemd/friday.service", "utf8"),
      readFile("README.md", "utf8"),
      readFile(".github/workflows/prepare-release.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("scripts/install-release.sh", "utf8"),
      readFile("src/runtime.ts", "utf8"),
      readFile("plugins/memory/index.ts", "utf8"),
      readFile("plugins/channels/runtime/package.json", "utf8"),
    ]);
    expect(service).toContain("WorkingDirectory=-%h/FRIDAY-workspace");
    expect(service).not.toContain("WorkingDirectory=%h\n");
    expect(readme).not.toContain("raw.githubusercontent.com/saravanaspar/F.R.I.D.A.Y/main/scripts/install-release.sh");
    expect(readme).toContain("releases/latest/download/install-release.sh");
    expect(prepareRelease).toContain("npm run version:set");
    expect(prepareRelease).toContain("pull-requests: write");
    expect(prepareRelease).toContain("gh pr create");
    expect(prepareRelease).toContain("release/${{ steps.version.outputs.tag }}");
    expect(release).toContain("push:");
    expect(release).toContain("- package.json");
    expect(release).toContain("needs.validate.outputs.publish == 'true'");
    expect(release).toContain("release/install-release.sh");
    expect(release).toContain("scripts/smoke-release-binary.sh");
    expect(release).toContain('release-version.mjs "$release_version" --check-packages');
    expect(ci).toContain("linux-binary-smoke");
    expect(ci).toContain("scripts/smoke-release-binary.sh");
    expect(installer.indexOf('"$target_tmp" --version')).toBeGreaterThanOrEqual(0);
    expect(installer.indexOf('"$target_tmp" --version')).toBeLessThan(installer.indexOf('mv -f "$target_tmp" "$target"'));
    expect(installer).toContain("restoring the previous installation");
    const bootstrapConfigAssignment = "process.env.FRIDAY_BOOTSTRAP_CONFIG = bootstrapConfigPath;";
    const workspacePreparation = "await prepareRuntimeWorkspace(process.env);";
    expect(runtime).toContain(bootstrapConfigAssignment);
    expect(runtime).toContain(workspacePreparation);
    expect(runtime.indexOf(bootstrapConfigAssignment)).toBeLessThan(runtime.indexOf(workspacePreparation));
    expect(memory).toContain('join(homedir(), ".friday")');
    expect(JSON.parse(channelsManifest) as { scripts?: Record<string, string> }).not.toHaveProperty("scripts.setup:whatsapp");
  });

  it("keeps Node runtime typings on the shipped Node 22 major across all workspaces", async () => {
    const nodeVersion = (await readFile(".node-version", "utf8")).trim();
    expect(nodeVersion.startsWith("22.")).toBe(true);
    const workspaces = runJson("scripts/workspace-packages.mjs", ["list", "--json"]) as WorkspaceRecord[];
    for (const workspace of [{ path: "", name: "friday" }, ...workspaces]) {
      const manifest = JSON.parse(await readFile(workspace.path ? `${workspace.path}/package.json` : "package.json", "utf8")) as { devDependencies?: Record<string, string> };
      const nodeTypes = manifest.devDependencies?.["@types/node"];
      if (nodeTypes !== undefined) expect(nodeTypes).toMatch(/^\^22\./u);
    }
  });

});
