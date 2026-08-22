import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { provideCapability, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import evaluationPlugin from "../plugins/evaluation/index.js";
import autonomyPlugin from "../plugins/autonomy/index.js";
import { AUTONOMY_CAPABILITY } from "../plugins/autonomy/contract.js";
import { AGENT_CAPABILITY } from "../plugins/agent/contract.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { PROMPTS_CAPABILITY } from "../plugins/prompts/contract.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import { TOOLS_CAPABILITY } from "../plugins/tools/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { createPermissionsService } from "../plugins/permissions/policy.js";
import { SANDBOX_CAPABILITY, type SandboxProcessRequest } from "../plugins/sandbox/contract.js";


afterEach(() => uninstallCapabilityRegistry());

describe("autonomy plugin", () => {
  it("uses execution-backed quality gates through the autonomy capability", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);
    provideCapability(PERMISSIONS_CAPABILITY, createPermissionsService({ approve: async () => true }));
    provideCapability(AGENT_CAPABILITY, {} as never);
    provideCapability(MODEL_CAPABILITY, {} as never);
    provideCapability(PROMPTS_CAPABILITY, {} as never);
    provideCapability(SESSIONS_CAPABILITY, {} as never);
    provideCapability(TOOLS_CAPABILITY, {} as never);
    const sandboxProcessRequests: SandboxProcessRequest[] = [];
    provideCapability(SANDBOX_CAPABILITY, {
      sandboxKind: "podman",
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount() { return () => {}; },
      sandboxShell(request) { return { command: request.command, cwd: request.cwd, env: request.env }; },
      sandboxProcess(request) {
        sandboxProcessRequests.push(request);
        return { command: request.command, args: request.args, cwd: request.cwd, env: request.env };
      },
      sandboxKernel(request) { return { command: "true", args: [], cwd: request.cwd, env: request.env }; },
    });
    await friday.activatePlugin(evaluationPlugin);
    await friday.activatePlugin(autonomyPlugin);

    const autonomy = requireCapability(AUTONOMY_CAPABILITY);
    const passing = autonomy.api.createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 1,
      gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
    });
    const passingContinuation = await autonomy.api.nextAutonomousContinuation(
      passing,
      { stopReason: "stop" },
      { cwd: process.cwd() },
    );
    expect(passingContinuation).toBeUndefined();
    expect(sandboxProcessRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "git", access: "read", network: false }),
      ]),
    );

    const failing = autonomy.api.createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 1,
      gates: {
        commands: [`${process.execPath} -e "console.error('gate failed'); process.exit(1)"`],
        maxRetries: 2,
      },
    });
    const failingContinuation = await autonomy.api.nextAutonomousContinuation(
      failing,
      { stopReason: "stop" },
      { cwd: process.cwd() },
    );
    expect(failingContinuation?.content[0]?.text).toContain("Autonomous quality gate failed");
    expect(failingContinuation?.content[0]?.text).toContain("gate failed");
  });
});
