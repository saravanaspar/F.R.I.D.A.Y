import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateConfiguredPlugins, readBootstrapConfig } from "../src/bootstrap.js";
import { activePluginKernel, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";

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
