import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import lifecyclePlugin from "../plugins/lifecycle/index.js";
import { LIFECYCLE_CAPABILITY, LIFECYCLE_HANDOFF_CONTRIBUTION } from "../plugins/lifecycle/contract.js";
import {
  activateFridayExecutable,
  describeFridayExecutable,
  resolveFridayActiveExecutable,
  stageFridayExecutable,
} from "../plugins/lifecycle/runtime/src/active-executable.js";

afterEach(() => uninstallCapabilityRegistry());

describe("lifecycle plugin", () => {
  it("restores both partial and already-quiesced participants when quiesce fails", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);
    await friday.activatePlugin(lifecyclePlugin);

    const transitions: string[] = [];
    const partialParticipant = definePlugin({ id: "partial-handoff-participant" }, (ctx) => {
      // Quiesce runs in reverse id order, so z.success stops first and must be
      // restored after a.partial fails partway through its own stop.
      ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
        id: "z.success",
        async quiesce() { transitions.push("success:quiesce"); },
        async activate() { transitions.push("success:activate"); },
      });
      ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
        id: "a.partial",
        async quiesce() {
          transitions.push("partial:quiesce");
          throw new Error("partial quiesce failure");
        },
        async activate() { transitions.push("partial:activate"); },
      });
    });
    await friday.activatePlugin(partialParticipant);

    const handoff = requireCapability(LIFECYCLE_CAPABILITY).handoff;
    expect(handoff).toBeDefined();
    await expect(handoff!.quiesce()).rejects.toThrow("could not quiesce");
    expect(transitions).toEqual([
      "success:quiesce",
      "partial:quiesce",
      "partial:activate",
      "success:activate",
    ]);
    expect(handoff!.status().quiesced).toEqual([]);
  });

  it("stages, activates, and re-verifies a single-binary successor before bootstrap delegation", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-lifecycle-update-home-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "friday-lifecycle-update-source-"));
    try {
      const source = join(sourceDir, "friday");
      await writeFile(source, "#!/bin/sh\necho successor\n", { mode: 0o700 });
      const environment = { ...process.env, FRIDAY_HOME: home };
      const sourceDescriptor = describeFridayExecutable(source);
      const staged = stageFridayExecutable(source, { generationId: "gen-000002", commit: "abcdef1234" }, environment);

      expect(staged.path).not.toBe(sourceDescriptor.path);
      expect(staged.sha256).toBe(sourceDescriptor.sha256);
      const active = activateFridayExecutable(staged, {
        generationId: "gen-000002",
        commit: "abcdef1234",
        now: "2026-08-22T00:00:00.000Z",
      }, environment);
      expect(resolveFridayActiveExecutable(environment)).toEqual(active);

      await writeFile(staged.path, "tampered successor", { mode: 0o700 });
      expect(() => resolveFridayActiveExecutable(environment)).toThrow(/SHA-256 verification/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("keeps the predecessor until the replacement acknowledges full takeover", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-lifecycle-state-"));
    const helperDir = await mkdtemp(join(tmpdir(), "friday-lifecycle-helper-"));
    try {
      const lifecycleModuleUrl = pathToFileURL(resolve("plugins/lifecycle/runtime/dist/index.js")).href;
      const helperPath = join(helperDir, "replacement.mjs");
      await writeFile(
        helperPath,
        `import { acknowledgeRestartFromEnvironment, acknowledgeTakeoverFromEnvironment, readRestartRecord, RESTART_STATUS_PATH_ENV } from ${JSON.stringify(lifecycleModuleUrl)};\n` +
          `acknowledgeRestartFromEnvironment();\n` +
          `while (readRestartRecord(process.env[RESTART_STATUS_PATH_ENV])?.phase !== "quiesced") await new Promise((resolve) => setTimeout(resolve, 5));\n` +
          `acknowledgeTakeoverFromEnvironment();\n`,
      );

      const friday = new PluginTestHost();
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(executionPlugin);
      await friday.activatePlugin(lifecyclePlugin);

      const lifecycle = requireCapability(LIFECYCLE_CAPABILITY);
      const manager = lifecycle.createLifecycleManager({
        stateDir,
        process: {
          pid: process.pid,
          execPath: process.execPath,
          execArgv: [],
          argv: [process.execPath, helperPath],
          env: { ...process.env },
          cwd: helperDir,
        },
        pollIntervalMs: 5,
      });

      const ready = await manager.launchReplacement({ timeoutMs: 5_000 });
      expect(["ready", "accepted"]).toContain(ready.phase);
      expect(ready.successor?.pid).toBeTruthy();
      expect(ready.predecessor.pid).toBe(process.pid);
      manager.releaseForTakeover(ready.requestId);
      const accepted = await manager.waitForTakeover(ready.requestId, { timeoutMs: 5_000 });
      expect(accepted.phase).toBe("accepted");
      expect(manager.readRestart(ready.requestId)?.phase).toBe("accepted");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(helperDir, { recursive: true, force: true });
    }
  });
});
