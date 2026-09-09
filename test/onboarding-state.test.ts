import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeOnboardingState,
  onboardingNextSteps,
  readOnboardingState,
  updateOnboardingStep,
} from "../plugins/runtime-settings/onboarding-state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "friday-onboarding-state-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

describe("persistent onboarding state", () => {
  it("keeps mandatory local steps non-skippable and moves to remote onboarding only after all are complete", async () => {
    const root = await home();
    const initial = await initializeOnboardingState("quick", root);
    expect(initial.phase).toBe("local-bootstrap");
    await expect(updateOnboardingStep("router", "skipped", root)).rejects.toThrow("mandatory onboarding step router cannot be skipped");
    await updateOnboardingStep("router", "complete", root);
    await updateOnboardingStep("operatorChannel", "complete", root);
    const stillLocal = await readOnboardingState(root);
    expect(stillLocal?.phase).toBe("local-bootstrap");
    const remote = await updateOnboardingStep("privilegePolicy", "complete", root);
    expect(remote.phase).toBe("remote-onboarding");
    expect(onboardingNextSteps(remote)).toContain("mainModel");
  });

  it("persists private state and reaches operational when optional steps are explicitly completed or skipped", async () => {
    const root = await home();
    await initializeOnboardingState("custom", root);
    for (const step of ["router", "operatorChannel", "privilegePolicy"] as const) await updateOnboardingStep(step, "complete", root);
    for (const step of ["mainModel", "permissions", "timezone", "voice", "sandbox", "executionPython", "mcp", "skills", "selfRepository"] as const) {
      await updateOnboardingStep(step, "skipped", root);
    }
    const state = await readOnboardingState(root);
    expect(state?.phase).toBe("operational");
    expect(onboardingNextSteps(state!)).toEqual([]);
    const info = await stat(join(root, "onboarding", "state.json"));
    if (process.platform !== "win32") expect(info.mode & 0o077).toBe(0);
  });
});
