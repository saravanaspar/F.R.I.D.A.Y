import { describe, expect, it } from "vitest";
import type { SandboxProvider, SandboxService } from "../plugins/sandbox/contract.js";
import { assertSandboxProviderSatisfiesContract } from "../plugins/sandbox/contract.js";
import {
  BUILTIN_SANDBOX_PROVIDERS,
  sandboxProviderMap,
  selectSandboxProvider,
} from "../plugins/sandbox/providers/index.js";

function fakeService(): SandboxService {
  return {
    assertAvailable() {},
    registerTrustedReadOnlyMount() { return () => undefined; },
    sandboxShell(request) { return { command: request.command, cwd: request.cwd, env: request.env }; },
    sandboxProcess(request) { return { command: request.command, args: request.args, cwd: request.cwd, env: request.env }; },
    sandboxKernel(request) { return { command: "python3", args: [], cwd: request.cwd, env: request.env }; },
  };
}

function fakeProvider(id: string, resourceLimits = true): SandboxProvider {
  return {
    descriptor: {
      id,
      displayName: id,
      isolationClass: "namespaces-seccomp",
      capabilities: {
        filesystemIsolation: true,
        processIsolation: true,
        networkIsolation: true,
        resourceLimits,
        writableWorkspace: true,
        trustedReadOnlyMounts: true,
        persistentProcesses: true,
        rootless: true,
        daemonless: true,
        sharesHostKernel: true,
      },
    },
    setupLabel: `Set up ${id}`,
    setupDescription: `Prepare ${id}`,
    createService: fakeService,
    probe: () => ({ available: true, status: "ready" }),
    repairHint: () => `repair ${id}`,
    setup: () => ({ status: "already-ready", providerId: id }),
  };
}

describe("sandbox provider registry", () => {
  it("ships kern as the built-in default without coupling the generic contract to kern", () => {
    expect(BUILTIN_SANDBOX_PROVIDERS.map((provider) => provider.descriptor.id)).toEqual(["kern"]);
    expect(selectSandboxProvider().descriptor.id).toBe("kern");
  });

  it("can equip an additional provider by registering it and selecting its id", () => {
    const custom = fakeProvider("custom-sandbox");
    expect(selectSandboxProvider("custom-sandbox", [custom])).toBe(custom);
  });

  it("never silently falls back when the configured provider is unknown", () => {
    expect(() => selectSandboxProvider("missing-provider")).toThrow(/not registered/);
  });

  it("fails closed when a provider cannot enforce a required sandbox guarantee", () => {
    expect(() => assertSandboxProviderSatisfiesContract(fakeProvider("weak", false))).toThrow(/resourceLimits/);
  });

  it("rejects duplicate provider ids instead of depending on registration order", () => {
    expect(() => sandboxProviderMap([fakeProvider("kern")])).toThrow(/Duplicate sandbox provider id/);
  });
});
