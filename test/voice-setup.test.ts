import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceSettings } from "@friday/voice";
import { modelCredentialVaultRef } from "../plugins/auth/model-credential-ref.js";
import { readVoiceSettings } from "../plugins/voice/settings.js";
import type { OnboardingIO, OnboardingSelectInput } from "../src/onboarding.js";
import { chatterboxPackageInstallPlan, chatterboxTorchInstallPlan, missingLocalVoiceHostDependencies } from "../src/voice-local-setup.js";
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

function chatterboxFakeIo(compute: "cpu" | "cuda", seen: string[]): OnboardingIO {
  return {
    isInteractive: true,
    question: async () => "",
    text: async (_prompt, initialValue) => initialValue ?? "",
    secretQuestion: async () => { throw new Error("local voice setup must not request a secret"); },
    write: () => undefined,
    select: async (input: OnboardingSelectInput) => {
      seen.push(input.message);
      if (input.message === "Speech-to-text provider") return "disabled";
      if (input.message === "Text-to-speech provider") return "local";
      if (input.message === "Local text-to-speech model") return "chatterbox-nano";
      if (input.message === "Chatterbox compute backend") return compute;
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
  it("pins and selectively downloads only Chatterbox Nano files used by the loader", async () => {
    const runner = await readFile("plugins/voice/runtime/python/friday_voice_local.py", "utf8");
    expect(runner).toContain('CHATTERBOX_NANO_MODEL_REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"');
    expect(runner).toContain('"s3gen_meanflow.safetensors"');
    expect(runner).not.toMatch(/^\s*"s3gen\.safetensors",?$/m);
    expect(runner).toContain("ChatterboxTurboTTS.from_local");
    expect(runner).not.toContain("ChatterboxTurboTTS.from_pretrained");
  });

  it("uses command-specific probes so installed ffmpeg is not reported missing", async () => {
    const bin = await mkdtemp(join(tmpdir(), "friday-voice-probes-"));
    roots.push(bin);
    const scripts = new Map<string, string>([
      ["git", "--version"],
      ["cmake", "--version"],
      ["curl", "--version"],
      ["ffmpeg", "-version"],
    ]);
    for (const [command, expectedArg] of scripts) {
      const path = join(bin, command);
      await writeFile(path, `#!/bin/sh\n[ "\${1:-}" = "${expectedArg}" ]\n`, { mode: 0o755 });
    }

    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const missing = missingLocalVoiceHostDependencies({
        schema: 1,
        stt: { provider: "local", model: "base-q5_1" },
      });
      expect(missing).toEqual([]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("pins Chatterbox PyTorch to the operator-selected CPU or CUDA wheel index", () => {
    expect(chatterboxTorchInstallPlan("cpu")).toMatchObject({
      compute: "cpu",
      indexUrl: "https://download.pytorch.org/whl/cpu",
      requirements: ["torch==2.6.0", "torchaudio==2.6.0"],
    });
    expect(chatterboxTorchInstallPlan("cuda")).toMatchObject({
      compute: "cuda",
      indexUrl: "https://download.pytorch.org/whl/cu126",
      requirements: ["torch==2.6.0", "torchaudio==2.6.0"],
    });
  });

  it("pins Chatterbox Nano and Perth without relying on a transitive moving Git dependency", () => {
    const plan = chatterboxPackageInstallPlan();
    expect(plan).toMatchObject({
      perthSourceRequirement: "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@ff1c8ac55a976971245cdd53c18d6131ca00d993",
      perthRevision: "ff1c8ac55a976971245cdd53c18d6131ca00d993",
      nanoSourceRequirement: "git+https://github.com/resemble-ai/chatterbox.git@5de7a54aa4e5e2baadb0182dde554908b48b85c2",
      nanoRevision: "5de7a54aa4e5e2baadb0182dde554908b48b85c2",
    });
    expect(plan.runtimeRequirements).toContain("librosa==0.11.0");
    expect(plan.runtimeRequirements).toContain("transformers==5.2.0");
    expect(plan.runtimeRequirements).toContain("PyYAML>=6.0");
    expect(JSON.stringify(plan)).not.toContain("@master");
  });

  it("asks before using a detected NVIDIA GPU and keeps CPU as an explicit persisted choice", async () => {
    const home = await tempHome();
    const seen: string[] = [];
    let provisioned: VoiceSettings | undefined;
    const saved = await runVoiceSetup({
      home,
      io: chatterboxFakeIo("cpu", seen),
      detectLocalGpu: () => ({ backend: "cuda", name: "Test RTX" }),
      ensureLocalHostDependencies: async () => undefined,
      provisionLocal: async (settings) => { provisioned = settings; },
      verify: async () => undefined,
    });

    expect(seen).toContain("Chatterbox compute backend");
    expect(provisioned?.tts).toMatchObject({ provider: "local", model: "chatterbox-nano", compute: "cpu" });
    expect(saved.tts).toMatchObject({ provider: "local", model: "chatterbox-nano", compute: "cpu" });
  });

  it("persists CUDA only after the operator explicitly selects the detected GPU option", async () => {
    const home = await tempHome();
    const seen: string[] = [];
    const saved = await runVoiceSetup({
      home,
      io: chatterboxFakeIo("cuda", seen),
      detectLocalGpu: () => ({ backend: "cuda", name: "Test RTX" }),
      ensureLocalHostDependencies: async () => undefined,
      provisionLocal: async () => undefined,
      verify: async () => undefined,
    });

    expect(seen).toContain("Chatterbox compute backend");
    expect(saved.tts).toMatchObject({ provider: "local", model: "chatterbox-nano", compute: "cuda" });
  });

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
