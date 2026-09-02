import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { provideCapability, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import evaluationPlugin from "../plugins/evaluation/index.js";
import { EVALUATION_CAPABILITY } from "../plugins/evaluation/contract.js";
import { SANDBOX_CAPABILITY } from "../plugins/sandbox/contract.js";

afterEach(() => uninstallCapabilityRegistry());

describe("evaluation plugin", () => {
  it("runs deterministic command evaluation through the execution-backed capability", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);
    provideCapability(SANDBOX_CAPABILITY, {
      sandboxKind: "podman",
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount() { return () => {}; },
      sandboxShell(request) {
        return { command: request.command, cwd: request.cwd, env: request.env };
      },
      sandboxProcess(request) { return { command: request.command, args: request.args, cwd: request.cwd, env: request.env }; },
      sandboxKernel(request) { return { command: "true", args: [], cwd: request.cwd, env: request.env }; },
    });
    await friday.activatePlugin(evaluationPlugin);

    const evaluation = requireCapability(EVALUATION_CAPABILITY);
    const passing = await evaluation.runCommandEvaluation({
      id: "pass",
      command: `${process.execPath} -e "process.exit(0)"`,
      cwd: process.cwd(),
    });
    expect(passing.status).toBe("pass");

    const failing = await evaluation.runCommandEvaluation({
      id: "fail",
      command: `${process.execPath} -e "console.error('evaluation failed'); process.exit(1)"`,
      cwd: process.cwd(),
    });
    expect(failing.status).toBe("fail");
    expect(failing.output).toContain("evaluation failed");
  });
});
