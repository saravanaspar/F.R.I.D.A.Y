import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateConfiguredPlugins, readBootstrapConfig } from "../src/bootstrap.js";
import { activePluginKernel, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { activeCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CLIENT_GATEWAY_CAPABILITY } from "../plugins/clients/contract.js";
import { discoverPlugins, installPlugin, setPluginEnabled } from "../src/plugin-packages.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-bootstrap-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__fridayConfiguredPlugin;
  uninstallCapabilityRegistry();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FRIDAY bootstrap config", () => {
  it("builds the current declarative plugin graph from friday.config.json", async () => {
    const isolatedHome = await temporaryDirectory();
    const previousHome = process.env.FRIDAY_HOME;
    const previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_HOME = isolatedHome;
    process.env.FRIDAY_STATE_DIR = isolatedHome;
    let runtime: Awaited<ReturnType<typeof activateConfiguredPlugins>> | undefined;
    try {
      runtime = await activateConfiguredPlugins(resolve("friday.config.json"));
      const status = activePluginKernel().status();
      expect(status.length).toBeGreaterThan(0);
      expect(status.every((plugin) => plugin.state === "ready")).toBe(true);
    } finally {
      try {
        await runtime?.dispose();
      } finally {
        if (previousHome === undefined) delete process.env.FRIDAY_HOME;
        else process.env.FRIDAY_HOME = previousHome;
        if (previousStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
        else process.env.FRIDAY_STATE_DIR = previousStateDir;
      }
    }
  }, 30_000);

  it("starts the gateway after the complete plugin graph when a runtime port is configured", async () => {
    const isolatedHome = await temporaryDirectory();
    const previousHome = process.env.FRIDAY_HOME;
    const previousStateDir = process.env.FRIDAY_STATE_DIR;
    const previousPort = process.env.FRIDAY_GATEWAY_PORT;
    process.env.FRIDAY_HOME = isolatedHome;
    process.env.FRIDAY_STATE_DIR = isolatedHome;
    process.env.FRIDAY_GATEWAY_PORT = "0";
    let runtime: Awaited<ReturnType<typeof activateConfiguredPlugins>> | undefined;
    try {
      runtime = await activateConfiguredPlugins(resolve("friday.config.json"));
      const gateway = activeCapabilityRegistry().require(CLIENT_GATEWAY_CAPABILITY);
      const status = gateway.serverStatus();
      expect(status.running).toBe(true);
      const response = await fetch(`http://127.0.0.1:${status.port}/health`);
      expect(await response.json()).toMatchObject({ status: "ok", protocolVersion: 1 });
    } finally {
      await runtime?.dispose();
      if (previousHome === undefined) delete process.env.FRIDAY_HOME;
      else process.env.FRIDAY_HOME = previousHome;
      if (previousStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
      else process.env.FRIDAY_STATE_DIR = previousStateDir;
      if (previousPort === undefined) delete process.env.FRIDAY_GATEWAY_PORT;
      else process.env.FRIDAY_GATEWAY_PORT = previousPort;
    }
  }, 30_000);

  it("loads ordinary external plugin modules from config without a command API", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "hello.mjs"),
      'export default (api) => { if (Object.keys(api).length !== 0) throw new Error("unexpected string bootstrap API"); globalThis.__fridayConfiguredPlugin = "loaded"; };\n',
    );
    await writeFile(
      join(directory, "friday.config.json"),
      JSON.stringify({ plugins: ["./hello.mjs"] }),
    );

    const runtime = await activateConfiguredPlugins(join(directory, "friday.config.json"));
    try {
      expect((globalThis as Record<string, unknown>).__fridayConfiguredPlugin).toBe("loaded");
    } finally {
      await runtime.dispose();
    }
  });

  it("installs a package without rebuilding and honors its persisted enablement", async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, "home");
    const source = join(directory, "package");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(join(source, "manifest.json"), JSON.stringify({
      id: "example.plugin", name: "Example", version: "1.0.0", apiVersion: "1", entrypoint: "./dist/index.mjs",
    }));
    await writeFile(join(source, "dist/index.mjs"), 'export default () => { globalThis.__fridayConfiguredPlugin = "installed"; };\n');
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, JSON.stringify({ plugins: [] }));
    await installPlugin(source, [], home);
    expect(await discoverPlugins([], home)).toMatchObject([{ id: "example.plugin", builtIn: false, enabled: true }]);

    const previous = process.env.FRIDAY_HOME;
    process.env.FRIDAY_HOME = home;
    try {
      const runtime = await activateConfiguredPlugins(configPath);
      expect((globalThis as Record<string, unknown>).__fridayConfiguredPlugin).toBe("installed");
      await runtime.dispose();
      delete (globalThis as Record<string, unknown>).__fridayConfiguredPlugin;
      await setPluginEnabled("example.plugin", false, [], home);
      const disabled = await activateConfiguredPlugins(configPath);
      expect((globalThis as Record<string, unknown>).__fridayConfiguredPlugin).toBeUndefined();
      await disabled.dispose();
      await setPluginEnabled("example.plugin", true, [], home);
      expect((await discoverPlugins([], home))[0]?.enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FRIDAY_HOME;
      else process.env.FRIDAY_HOME = previous;
    }
  });

  it("rejects package entrypoint traversal and symlinks", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "package");
    await mkdir(source);
    await writeFile(join(directory, "outside.mjs"), "export default () => {};\n");
    const manifest = { id: "outside", name: "Outside", version: "1.0.0", apiVersion: "1", entrypoint: "./../outside.mjs" };
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    await expect(installPlugin(source, [], join(directory, "home"))).rejects.toThrow("escapes its package");
    await writeFile(join(source, "manifest.json"), JSON.stringify({ ...manifest, entrypoint: "./index.mjs" }));
    await symlink(join(directory, "outside.mjs"), join(source, "index.mjs"));
    await expect(installPlugin(source, [], join(directory, "home"))).rejects.toThrow("escapes its package");
  });

  it("fails closed on corrupt persisted plugin enablement", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "plugin-state.json"), JSON.stringify({ version: 1, enabled: { agent: "false" } }));
    await expect(discoverPlugins(["./plugins/agent/index.ts"], directory)).rejects.toThrow("invalid enablement");
  });

  it("keeps unknown config fields opaque to bootstrap", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, JSON.stringify({ plugins: [], model: { provider: "future-plugin-owned" } }));

    await expect(readBootstrapConfig(configPath)).resolves.toEqual({ plugins: [] });
  });

  it("rejects malformed JSON", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, "{ not-json");

    await expect(readBootstrapConfig(configPath)).rejects.toThrow("Invalid JSON in FRIDAY config");
  });

  it("rejects invalid plugin lists", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, JSON.stringify({ plugins: [""] }));

    await expect(readBootstrapConfig(configPath)).rejects.toThrow("plugins[0] must be a non-empty string");
  });

  it("reports plugin import failures with the configured entrypoint", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, JSON.stringify({ plugins: ["./missing.mjs"] }));

    await expect(activateConfiguredPlugins(configPath)).rejects.toThrow(
      'Failed to import FRIDAY plugin "./missing.mjs"',
    );
  });

  it("preserves import and bootstrap cleanup failures together", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "cleanup.mjs"),
      'export default (api) => { api[Symbol.for("friday.plugin.bootstrap-disposer.v1")](() => { throw new Error("cleanup-boom"); }); };\n',
    );
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, JSON.stringify({ plugins: ["./cleanup.mjs", "./missing.mjs"] }));

    let failure: unknown;
    try {
      await activateConfiguredPlugins(configPath);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('Failed to import FRIDAY plugin "./missing.mjs"');
    expect(message).toContain(
      "bootstrap cleanup also failed: FRIDAY bootstrap cleanup failed: cleanup-boom",
    );
  });

  it("rejects modules that are not FRIDAY plugin entrypoints", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "not-plugin.mjs"), "export const value = 42;\n");
    const configPath = join(directory, "friday.config.json");
    await writeFile(configPath, JSON.stringify({ plugins: ["./not-plugin.mjs"] }));

    await expect(activateConfiguredPlugins(configPath)).rejects.toThrow(
      'FRIDAY plugin "./not-plugin.mjs" must default-export a function',
    );
  });
});
