import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import authPlugin from "../plugins/auth/index.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import {
  definePlugin,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import modelPlugin from "../plugins/model/index.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { AUTH_CAPABILITY } from "../plugins/auth/contract.js";
import { VAULT_CAPABILITY } from "../plugins/vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../plugins/vault/trusted-contract.js";

describe("auth plugin", () => {
  it("resolves the model catalog through capabilities instead of a package dependency", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(definePlugin({
      id: "test-auth-vault",
      provides: [VAULT_CAPABILITY, VAULT_TRUSTED_CAPABILITY],
    }, (ctx) => {
      ctx.services.provide(VAULT_CAPABILITY, {
        normalizeRef: (ref: string) => ref,
        exists: () => false,
        inspect: () => undefined,
        list: () => [],
      });
      ctx.services.provide(VAULT_TRUSTED_CAPABILITY, {
        create: () => { throw new Error("not used"); },
        rotate: () => { throw new Error("not used"); },
        remove: () => false,
        consume: async () => { throw new Error("not used"); },
      });
    }));
    await friday.activatePlugin(authPlugin);

    const service = requireCapability(AUTH_CAPABILITY);
    expect(service.api.getOAuthProviders().length).toBeGreaterThan(0);

    uninstallCapabilityRegistry();
  });
});
