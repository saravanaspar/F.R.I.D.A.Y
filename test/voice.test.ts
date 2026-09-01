import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceProbeWav } from "@friday/voice";
import { ARTIFACT_INPUT_ENRICHMENT_CONTRIBUTION, type ArtifactRecord } from "../plugins/artifacts/contract.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../plugins/auth/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { saveVoiceSettings, readVoiceSettings } from "../plugins/voice/settings.js";
import voicePlugin from "../plugins/voice/index.js";
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
        has: () => true,
        getApiKey: async () => "OPENAI_SECRET_SENTINEL",
        requestApiKeyCapture: async () => ({ id: "unused" }),
        captureApiKey: async () => ({ id: "unused" }),
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
