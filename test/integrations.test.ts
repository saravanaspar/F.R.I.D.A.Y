import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import { AGENT_TOOL_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import integrationsPlugin from "../plugins/integrations/index.js";
import { PERMISSIONS_CAPABILITY, type PermissionsService } from "../plugins/permissions/contract.js";
import type { IntegrationAdapter } from "../plugins/integrations/contract.js";
import { createIntegrationsService } from "../plugins/integrations/integrations.js";
import { getIntegrationsStatePath } from "../plugins/integrations/store.js";

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-integrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  uninstallCapabilityRegistry();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function adapter(overrides: Partial<IntegrationAdapter> = {}): IntegrationAdapter {
  return {
    id: "example",
    displayName: "Example",
    actions: [
      { id: "read", description: "Read remote data", mutatesExternalState: false },
      { id: "write", description: "Write remote data", mutatesExternalState: true },
    ],
    async execute({ connection, action, input }) {
      return { connection: connection.id, action: action.id, input };
    },
    ...overrides,
  };
}

describe("integrations plugin", () => {
  it("contributes safe Agent tools without depending on the Agent or Turn Loop", async () => {
    const previousState = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = await tempDir();
    const permissions: PermissionsService = {
      normalizeMode: () => "auto",
      async authorize() { return { allowed: true, approvedBy: "policy" }; },
      assertWorkspacePath: (_workspace, path) => path,
    };
    const permissionProvider = definePlugin(
      { id: "test-integrations-permissions", provides: [PERMISSIONS_CAPABILITY] },
      (ctx) => { ctx.services.provide(PERMISSIONS_CAPABILITY, permissions); },
    );
    try {
      const friday = new PluginTestHost();
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(permissionProvider);
      await friday.activatePlugin(integrationsPlugin);
      expect(collectContributions(AGENT_TOOL_CONTRIBUTION).map((tool) => tool.name).sort()).toEqual([
        "integrations_connections",
        "integrations_invoke",
      ]);
    } finally {
      if (previousState === undefined) delete process.env.FRIDAY_STATE_DIR;
      else process.env.FRIDAY_STATE_DIR = previousState;
    }
  });

  it("registers adapters and persists non-secret connection metadata", async () => {
    const stateDir = await tempDir();
    const integrations = createIntegrationsService({ stateDir, now: () => new Date("2026-08-18T12:00:00Z") });
    integrations.registerAdapter(adapter());

    const connection = integrations.connect({
      id: "work",
      provider: "example",
      name: "Work Example",
      credentialRef: "secret://integrations/work",
      settings: { account: "primary", scopes: ["read", "write"] },
    });

    expect(connection).toMatchObject({
      id: "work",
      provider: "example",
      credentialRef: "secret://integrations/work",
      enabled: true,
    });
    expect(integrations.adapters().map((entry) => entry.id)).toEqual(["example"]);

    const reopened = createIntegrationsService({ stateDir });
    expect(reopened.get("work")?.settings).toEqual({ account: "primary", scopes: ["read", "write"] });
    expect(reopened.adapters()).toEqual([]);
  });

  it("rejects secret-looking values from durable integration settings", async () => {
    const stateDir = await tempDir();
    const integrations = createIntegrationsService({ stateDir });
    integrations.registerAdapter(adapter());

    expect(() =>
      integrations.connect({
        id: "unsafe",
        provider: "example",
        settings: { access_token: "plaintext-token" },
      }),
    ).toThrow(/credentialRef/);
  });

  it("authorizes every remote action before invoking the provider adapter", async () => {
    const stateDir = await tempDir();
    const authorization: string[] = [];
    const calls: string[] = [];
    const integrations = createIntegrationsService({
      stateDir,
      authorize: async ({ connection, action }) => {
        authorization.push(`${connection.id}:${action.id}:${action.mutatesExternalState}`);
      },
    });
    integrations.registerAdapter(
      adapter({
        async execute({ connection, action, input }) {
          calls.push(`${connection.id}:${action.id}`);
          return { ok: true, echo: input };
        },
      }),
    );
    integrations.connect({ id: "work", provider: "example", credentialRef: "secret://work" });

    await expect(integrations.invoke("work", "write", { message: "hello" })).resolves.toEqual({
      ok: true,
      echo: { message: "hello" },
    });
    expect(authorization).toEqual(["work:write:true"]);
    expect(calls).toEqual(["work:write"]);
  });

  it("rejects duplicate adapters, duplicate actions, unknown providers, and unknown actions", async () => {
    const stateDir = await tempDir();
    const integrations = createIntegrationsService({ stateDir });
    integrations.registerAdapter(adapter());
    expect(() => integrations.registerAdapter(adapter())).toThrow(/already registered/);
    expect(() =>
      integrations.registerAdapter(
        adapter({ id: "duplicate-actions", actions: [
          { id: "same", description: "one", mutatesExternalState: false },
          { id: "same", description: "two", mutatesExternalState: true },
        ] }),
      ),
    ).toThrow(/Duplicate integration action/);
    expect(() => integrations.connect({ id: "missing", provider: "unknown" })).toThrow(/not registered/);

    integrations.connect({ id: "work", provider: "example" });
    await expect(integrations.invoke("work", "missing")).rejects.toThrow(/Unknown integration action/);
  });

  it("fails closed on corrupt connection state", async () => {
    const stateDir = await tempDir();
    await writeFile(getIntegrationsStatePath(stateDir), "{broken", { mode: 0o600 });
    const integrations = createIntegrationsService({ stateDir });
    expect(() => integrations.connections()).toThrow(/Unable to parse integrations state/);
  });
});
