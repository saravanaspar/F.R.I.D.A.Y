import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceProbeWav } from "@friday/voice";
import { ARTIFACT_INPUT_ENRICHMENT_CONTRIBUTION, type ArtifactRecord } from "../plugins/artifacts/contract.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../plugins/auth/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { saveVoiceSettings, readVoiceSettings } from "../plugins/voice/settings.js";
import voicePlugin, { buildVoiceCandidate } from "../plugins/voice/index.js";
import { stageLocalVoiceReference, stageLocalVoiceReferenceBytes } from "../plugins/voice/local-setup.js";
import { VOICE_CAPABILITY } from "../plugins/voice/contract.js";
import { createVaultPlugin } from "../plugins/vault/index.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;

afterEach(async () => {
  uninstallCapabilityRegistry();
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "friday-voice-home-"));
  roots.push(home);
  await chmod(home, 0o700);
  return home;
}

describe("voice plugin", () => {
  it("applies partial typed setup without enabling or resetting the untouched voice side", () => {
    const existing = {
      schema: 1 as const,
      stt: { provider: "local" as const, model: "base-q5_1", language: "en" },
      tts: { provider: "local" as const, model: "chatterbox-nano", voice: "clone/default", format: "wav" as const, compute: "cuda" as const },
    };
    const gpu = { backend: "cuda" as const, name: "Test NVIDIA GPU" };

    expect(buildVoiceCandidate({ language: "auto" }, existing, gpu)).toEqual({
      schema: 1,
      stt: { provider: "local", model: "base-q5_1" },
      tts: existing.tts,
    });
    expect(buildVoiceCandidate({ sttModel: "small-q5_1" }, existing, gpu)).toEqual({
      schema: 1,
      stt: { provider: "local", model: "small-q5_1", language: "en" },
      tts: existing.tts,
    });
    expect(buildVoiceCandidate({ sttProvider: "disabled" }, undefined, undefined)).toEqual({ schema: 1 });
    expect(buildVoiceCandidate({ ttsProvider: "disabled" }, existing, gpu)).toEqual({ schema: 1, stt: existing.stt });
  });

  it("patches and clears a Chatterbox cloning reference without resetting unrelated Voice settings", () => {
    const existing = {
      schema: 1 as const,
      stt: { provider: "local" as const, model: "base-q5_1", language: "en" },
      tts: {
        provider: "local" as const,
        model: "chatterbox-nano",
        voice: "clone/default",
        format: "wav" as const,
        compute: "cuda" as const,
        referenceAudio: "/private/old-reference.wav",
      },
    };
    const gpu = { backend: "cuda" as const, name: "Test NVIDIA GPU" };

    expect(buildVoiceCandidate({ referenceAudio: "/private/new-reference.wav" }, existing, gpu)).toEqual({
      schema: 1,
      stt: existing.stt,
      tts: { ...existing.tts, referenceAudio: "/private/new-reference.wav" },
    });
    expect(buildVoiceCandidate({ clearReferenceAudio: true }, existing, gpu)).toEqual({
      schema: 1,
      stt: existing.stt,
      tts: { provider: "local", model: "chatterbox-nano", voice: "clone/default", format: "wav", compute: "cuda" },
    });
    expect(() => buildVoiceCandidate({ ttsProvider: "local", ttsModel: "piper", referenceAudio: "/tmp/ref.wav" }, existing, gpu))
      .toThrow("referenceAudio is supported only by local chatterbox-nano");
    expect(() => buildVoiceCandidate({ clearReferenceAudio: true, referenceAudio: "/tmp/ref.wav" }, existing, gpu))
      .toThrow("cannot be combined");
  });

  it("stages cloning references as private content-addressed files", async () => {
    const home = await tempHome();
    const bytes = createVoiceProbeWav();
    const staged = await stageLocalVoiceReferenceBytes(bytes, "my voice.wav", home);
    expect(staged).toContain(join(home, "tooling", "voice", "references"));
    expect(staged).toMatch(/[a-f0-9]{64}-my-voice\.wav$/);
    expect((await stat(staged)).mode & 0o077).toBe(0);

    const source = join(home, "source.wav");
    await writeFile(source, bytes, { mode: 0o600 });
    const stagedFromPath = await stageLocalVoiceReference(source, home);
    expect(stagedFromPath).toMatch(/[a-f0-9]{64}-source\.wav$/);
    expect((await stat(stagedFromPath)).mode & 0o077).toBe(0);
  });

  it("requires an explicit Chatterbox CPU/GPU choice only for a new GPU-capable setup", () => {
    const gpu = { backend: "cuda" as const, name: "Test NVIDIA GPU" };
    expect(() => buildVoiceCandidate({ ttsProvider: "local", ttsModel: "chatterbox-nano" }, undefined, gpu))
      .toThrow("choose cpu or cuda explicitly");
    expect(buildVoiceCandidate({ ttsProvider: "local", ttsModel: "chatterbox-nano" }, undefined, undefined)).toMatchObject({
      tts: { provider: "local", model: "chatterbox-nano", compute: "cpu" },
    });
    expect(buildVoiceCandidate({ ttsProvider: "local", ttsModel: "chatterbox-nano", compute: "cuda" }, undefined, gpu)).toMatchObject({
      tts: { compute: "cuda" },
    });
  });

  it("persists non-secret voice settings privately", async () => {
    const home = await tempHome();
    await saveVoiceSettings({
      schema: 1,
      stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
      tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy", format: "mp3" },
    }, home);
    expect(await readVoiceSettings(home)).toMatchObject({ schema: 1, stt: { provider: "openai" }, tts: { provider: "openai", voice: "alloy" } });
    expect((await stat(join(home, "voice"))).mode & 0o077).toBe(0);
    expect((await stat(join(home, "voice", "settings.json"))).mode & 0o077).toBe(0);
  });

  it("provides STT/TTS capability and enriches audio attachments without exposing credentials", async () => {
    const home = await tempHome();
    process.env.FRIDAY_HOME = home;
    await saveVoiceSettings({
      schema: 1,
      stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
      tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy", format: "mp3" },
    }, home);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "please remember this voice note" }), { headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }));

    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(createVaultPlugin({ stateDir: join(home, "vault"), workspaceRoot: process.cwd() }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-model-credentials", provides: [MODEL_CREDENTIALS_CAPABILITY] }, (ctx) => {
      ctx.services.provide(MODEL_CREDENTIALS_CAPABILITY, Object.freeze({
        ref: () => "vault://models/openai/api-key",
        oauthRef: () => "vault://models/openai/oauth",
        has: () => true,
        hasOAuth: () => false,
        supportsOAuth: () => false,
        typicallyNeedsApiKey: () => true,
        getApiKey: async () => "OPENAI_SECRET_SENTINEL",
        requestApiKeyCapture: async () => ({ id: "unused" }),
        captureApiKey: async () => ({ id: "unused" }),
        captureOAuth: async () => ({ id: "unused" }),
      }));
    }), { defer: true });
    await friday.activatePlugin(voicePlugin, { defer: true });
    await friday.completePluginBootstrap();

    const voice = requireCapability(VOICE_CAPABILITY);
    expect(voice.status()).toMatchObject({ sttConfigured: true, ttsConfigured: true, sttCredentialConfigured: true, ttsCredentialConfigured: true });
    expect(JSON.stringify(voice.status())).not.toContain("OPENAI_SECRET_SENTINEL");

    const enricher = collectContributions(ARTIFACT_INPUT_ENRICHMENT_CONTRIBUTION).find((candidate) => candidate.id === "voice-stt")!;
    const record: ArtifactRecord = Object.freeze({
      ref: "artifact:00000000-0000-0000-0000-000000000000",
      id: "00000000-0000-0000-0000-000000000000",
      fileName: "note.wav",
      mimeType: "audio/wav",
      sizeBytes: createVoiceProbeWav().byteLength,
      sha256: "0".repeat(64),
      createdAt: new Date(0).toISOString(),
    });
    expect(enricher.supports(record)).toBe(true);
    const enriched = await enricher.enrich({ record, read: async () => createVoiceProbeWav() });
    expect(enriched?.context).toContain("please remember this voice note");
    expect(enriched?.context).toContain("friday_untrusted_speech_transcript");
    expect(enriched?.context).not.toContain("OPENAI_SECRET_SENTINEL");

    const audio = await voice.synthesize("hello");
    expect(audio).toHaveLength(1);
    expect([...audio[0]!.bytes]).toEqual([1, 2, 3]);
  });
});
