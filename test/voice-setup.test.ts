import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelCredentialVaultRef } from "../plugins/auth/model-credential-ref.js";
import { readVoiceSettings } from "../plugins/voice/settings.js";
import type { OnboardingIO, OnboardingSelectInput } from "../src/onboarding.js";
import { runVoiceSetup } from "../src/voice-setup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "friday-voice-setup-"));
  roots.push(home);
  await chmod(home, 0o700);
  return home;
}

function fakeIo(): OnboardingIO {
  return {
    isInteractive: true,
    question: async () => "",
    text: async (_prompt, initialValue) => initialValue ?? "",
    secretQuestion: async () => "OPENAI_VOICE_KEY_SENTINEL",
    write: () => undefined,
    select: async (input: OnboardingSelectInput) => {
      if (input.message === "Speech-to-text provider") return "openai";
      if (input.message === "Speech-to-text model") return "gpt-4o-mini-transcribe";
      if (input.message === "Text-to-speech provider") return "openai";
      if (input.message === "Text-to-speech model") return "gpt-4o-mini-tts";
      if (input.message === "Voice") return "alloy";
      return input.initialValue ?? input.choices[0]!.value;
    },
    confirm: async () => false,
    runTask: async (_message, operation) => operation(),
    intro: () => undefined,
    outro: () => undefined,
    info: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    close: () => undefined,
  };
}

function localFakeIo(): OnboardingIO {
  return {
    isInteractive: true,
    question: async () => "",
    text: async (_prompt, initialValue) => initialValue ?? "",
    secretQuestion: async () => { throw new Error("local voice setup must not request a secret"); },
    write: () => undefined,
    select: async (input: OnboardingSelectInput) => {
      if (input.message === "Speech-to-text provider") return "local";
      if (input.message === "Local speech-to-text model") return "base-q5_1";
      if (input.message === "Text-to-speech provider") return "local";
      if (input.message === "Local text-to-speech model") return "piper";
      if (input.message === "Local voice") return "en_US-lessac-medium";
      return input.initialValue ?? input.choices[0]!.value;
    },
    confirm: async () => false,
    runTask: async (_message, operation) => operation(),
    intro: () => undefined,
    outro: () => undefined,
    info: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    close: () => undefined,
  };
}

describe("voice setup", () => {
  it("verifies once, stores OpenAI voice credential in the canonical model Vault ref, and saves only non-secret settings", async () => {
    const home = await tempHome();
    let verifiedKey: string | undefined;
    const saved = await runVoiceSetup({
      home,
      io: fakeIo(),
      verify: async (settings, credential) => {
        expect(settings).toMatchObject({
          stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
          tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy" },
        });
        verifiedKey = await credential("openai");
      },
    });
    expect(verifiedKey).toBe("OPENAI_VOICE_KEY_SENTINEL");
    expect(saved.stt?.provider).toBe("openai");

    const vault = await import("@friday/vault");
    const store = new vault.VaultStore({ stateDir: vault.getVaultStateDir({ FRIDAY_HOME: home }), workspaceRoot: process.cwd() });
    const ref = modelCredentialVaultRef("openai");
    expect(store.exists(ref)).toBe(true);
    let secret = "";
    await store.consume(ref, (bytes) => { secret = Buffer.from(bytes).toString("utf8"); });
    expect(secret).toBe("OPENAI_VOICE_KEY_SENTINEL");

    const rawSettings = JSON.stringify(await readVoiceSettings(home));
    expect(rawSettings).not.toContain("OPENAI_VOICE_KEY_SENTINEL");
    expect(rawSettings).toContain("gpt-4o-mini-tts");
  });

  it("provisions selected local STT/TTS models without asking for API credentials", async () => {
    const home = await tempHome();
    let dependencyChecks = 0;
    let provisions = 0;
    let verifications = 0;
    const saved = await runVoiceSetup({
      home,
      io: localFakeIo(),
      ensureLocalHostDependencies: async (settings, providedHome) => {
        dependencyChecks += 1;
        expect(providedHome).toBe(home);
        expect(settings).toMatchObject({
          stt: { provider: "local", model: "base-q5_1" },
          tts: { provider: "local", model: "piper", voice: "en_US-lessac-medium", format: "wav" },
        });
      },
      provisionLocal: async (settings, providedHome) => {
        provisions += 1;
        expect(providedHome).toBe(home);
        expect(settings.stt?.provider).toBe("local");
        expect(settings.tts?.provider).toBe("local");
      },
      verify: async (settings, credential) => {
        verifications += 1;
        expect(settings.stt?.model).toBe("base-q5_1");
        expect(settings.tts?.model).toBe("piper");
        await expect(credential("openai")).resolves.toBeUndefined();
      },
    });

    expect(dependencyChecks).toBe(1);
    expect(provisions).toBe(1);
    expect(verifications).toBe(1);
    expect(saved).toMatchObject({
      schema: 1,
      stt: { provider: "local", model: "base-q5_1" },
      tts: { provider: "local", model: "piper", voice: "en_US-lessac-medium", format: "wav" },
    });
    expect(JSON.stringify(await readVoiceSettings(home))).not.toContain("vault://");
  });
});
