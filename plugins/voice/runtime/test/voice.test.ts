import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createVoiceProbeWav,
  createVoiceRuntime,
  normalizeVoiceSettings,
  type VoiceSettings,
} from "../src/index.js";
import { renderChatterboxExpression, transcribeLocal } from "../src/local.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const openaiSettings: VoiceSettings = Object.freeze({
  schema: 1,
  stt: Object.freeze({ provider: "openai", model: "gpt-4o-mini-transcribe" }),
  tts: Object.freeze({ provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy", format: "mp3" }),
});

describe("voice runtime", () => {
  it("normalizes bounded provider settings and rejects unknown fields", () => {
    expect(normalizeVoiceSettings(openaiSettings)).toEqual(openaiSettings);
    expect(normalizeVoiceSettings({
      schema: 1,
      stt: { provider: "local", model: "base-q5_1" },
      tts: { provider: "local", model: "piper", voice: "en_US-lessac-medium", format: "wav" },
    })).toEqual({
      schema: 1,
      stt: { provider: "local", model: "base-q5_1" },
      tts: { provider: "local", model: "piper", voice: "en_US-lessac-medium", format: "wav" },
    });
    expect(() => normalizeVoiceSettings({ ...openaiSettings, extra: true })).toThrow(/unsupported voice settings field/);
    expect(() => normalizeVoiceSettings({ schema: 1, stt: { provider: "other", model: "x" } })).toThrow(/STT provider/);
    expect(() => normalizeVoiceSettings({ schema: 1, tts: { provider: "openai", model: "x", voice: "alloy", format: "wav" } })).toThrow(/format/);
    expect(() => normalizeVoiceSettings({ schema: 1, tts: { provider: "local", model: "piper", voice: "lessac", format: "mp3" } })).toThrow(/format/);
    expect(normalizeVoiceSettings({
      schema: 1,
      tts: { provider: "local", model: "chatterbox-nano", voice: "clone/default", format: "wav", compute: "cpu" },
    })).toEqual({
      schema: 1,
      tts: { provider: "local", model: "chatterbox-nano", voice: "clone/default", format: "wav", compute: "cpu" },
    });
    expect(() => normalizeVoiceSettings({ schema: 1, tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "alloy", format: "mp3", referenceAudio: "/tmp/ref.wav" } })).toThrow(/referenceAudio/);
    expect(() => normalizeVoiceSettings({ schema: 1, tts: { provider: "local", model: "piper", voice: "lessac", format: "wav", compute: "cuda" } })).toThrow(/compute/);
    expect(() => normalizeVoiceSettings({ schema: 1, tts: { provider: "local", model: "chatterbox-nano", voice: "clone/default", format: "wav", compute: "metal" } })).toThrow(/compute/);
  });

  it("normalizes local WAV input through a distinct ffmpeg output path before Whisper", async () => {
    if (process.platform === "win32") return;
    const sandbox = await mkdtemp(join(tmpdir(), "friday-local-stt-test-"));
    const previousPath = process.env.PATH;
    try {
      const bin = join(sandbox, "bin");
      const localRoot = join(sandbox, "voice");
      const whisperDir = join(localRoot, "whisper.cpp", "source", "build", "bin");
      const modelDir = join(localRoot, "whisper.cpp", "models");
      await mkdir(bin, { recursive: true });
      await mkdir(whisperDir, { recursive: true });
      await mkdir(modelDir, { recursive: true });
      await writeFile(join(modelDir, "ggml-base-q5_1.bin"), "model", { mode: 0o600 });

      const ffmpeg = join(bin, "ffmpeg");
      await writeFile(ffmpeg, [
        "#!/bin/sh",
        "in=",
        "prev=",
        "out=",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = \"-i\" ]; then in=\"$arg\"; fi",
        "  prev=\"$arg\"",
        "  out=\"$arg\"",
        "done",
        "[ -n \"$in\" ] || exit 90",
        "[ \"$in\" != \"$out\" ] || exit 91",
        "cp \"$in\" \"$out\"",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(ffmpeg, 0o755);

      const whisper = join(whisperDir, "whisper-cli");
      await writeFile(whisper, [
        "#!/bin/sh",
        "out=",
        "prev=",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = \"-of\" ]; then out=\"$arg\"; fi",
        "  prev=\"$arg\"",
        "done",
        "[ -n \"$out\" ] || exit 92",
        "printf '%s\n' 'local probe ok' > \"${out}.txt\"",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(whisper, 0o755);

      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      await expect(transcribeLocal(
        { localRoot },
        { provider: "local", model: "base-q5_1", language: "auto" },
        { audio: createVoiceProbeWav(), mimeType: "audio/wav", fileName: "probe.wav" },
      )).resolves.toBe("local probe ok");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("transcribes OpenAI audio with multipart form data and the configured credential", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-openai");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
      expect(form.get("file")).toBeInstanceOf(Blob);
      return jsonResponse({ text: "hello friday" });
    });
    const runtime = createVoiceRuntime({
      settings: openaiSettings,
      credential: async (provider) => provider === "openai" ? "secret-openai" : undefined,
      fetch: fetchMock as typeof fetch,
    });
    await expect(runtime.transcribe({ audio: createVoiceProbeWav(), mimeType: "audio/wav", fileName: "probe.wav" }))
      .resolves.toEqual({ text: "hello friday", provider: "openai", model: "gpt-4o-mini-transcribe" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("transcribes Deepgram audio with token auth and smart formatting", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
      expect(url.searchParams.get("model")).toBe("nova-3");
      expect(url.searchParams.get("smart_format")).toBe("true");
      expect(url.searchParams.get("language")).toBe("en-US");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Token deepgram-secret");
      expect(headers["Content-Type"]).toBe("audio/wav");
      return jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "deepgram transcript" }] }] } });
    });
    const runtime = createVoiceRuntime({
      settings: { schema: 1, stt: { provider: "deepgram", model: "nova-3", language: "en-US" } },
      credential: async (provider) => provider === "deepgram" ? "deepgram-secret" : undefined,
      fetch: fetchMock as typeof fetch,
    });
    await expect(runtime.transcribe({ audio: createVoiceProbeWav(), mimeType: "audio/wav" }))
      .resolves.toEqual({ text: "deepgram transcript", provider: "deepgram", model: "nova-3" });
  });

  it("synthesizes OpenAI speech and keeps long output in bounded chunks", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.openai.com/v1/audio/speech");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("gpt-4o-mini-tts");
      expect(body.voice).toBe("alloy");
      expect(body.response_format).toBe("mp3");
      expect(String(body.input).length).toBeLessThanOrEqual(4_000);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    });
    const runtime = createVoiceRuntime({
      settings: openaiSettings,
      credential: async (provider) => provider === "openai" ? "secret-openai" : undefined,
      fetch: fetchMock as typeof fetch,
    });
    const chunks = await runtime.synthesize(`${"word ".repeat(1200)}done`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.mimeType === "audio/mpeg" && chunk.provider === "openai")).toBe(true);
  });

  it("synthesizes ElevenLabs speech using the configured voice id and API key", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/text-to-speech/voice-123");
      expect(url.searchParams.get("output_format")).toBe("mp3_44100_128");
      const headers = init?.headers as Record<string, string>;
      expect(headers["xi-api-key"]).toBe("eleven-secret");
      expect(JSON.parse(String(init?.body))).toEqual({ text: "hello", model_id: "eleven_multilingual_v2" });
      return new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "audio/mpeg" } });
    });
    const runtime = createVoiceRuntime({
      settings: { schema: 1, tts: { provider: "elevenlabs", model: "eleven_multilingual_v2", voice: "voice-123", format: "mp3" } },
      credential: async (provider) => provider === "elevenlabs" ? "eleven-secret" : undefined,
      fetch: fetchMock as typeof fetch,
    });
    const chunks = await runtime.synthesize("hello");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ provider: "elevenlabs", model: "eleven_multilingual_v2", voice: "voice-123", mimeType: "audio/mpeg" });
    expect([...chunks[0]!.bytes]).toEqual([9, 8, 7]);
  });

  it("maps provider-neutral expression intents to Chatterbox cues without separate voice identities", () => {
    expect(renderChatterboxExpression("Fine, I will do it.", { style: "tsundere", events: ["laugh", "tsk"] })).toBe(
      "Tsk. [sigh] [laugh] Fine, I will do it.",
    );
    expect(renderChatterboxExpression("Hello", { style: "neutral" })).toBe("Hello");
  });

  it("fails closed when expression is requested on a backend that does not support it", async () => {
    const runtime = createVoiceRuntime({
      settings: openaiSettings,
      credential: async () => "secret-openai",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(runtime.synthesize("hello", { expression: { style: "angry", events: ["tsk"] } })).rejects.toThrow(/does not support FRIDAY expression intents/);
    await expect(runtime.synthesize("hello", { expression: { style: "invalid" } as never })).rejects.toThrow(/expression style is unsupported/);
  });

  it("bounds provider response bodies and rejects non-audio synthesis responses", async () => {
    const oversized = createVoiceRuntime({
      settings: openaiSettings,
      credential: async () => "secret-openai",
      fetch: vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/audio/speech")
        ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg", "content-length": String(16 * 1024 * 1024 + 1) } })
        : jsonResponse({ text: "ok" })) as unknown as typeof fetch,
    });
    await expect(oversized.synthesize("hello")).rejects.toThrow(/response limit/);

    const wrongType = createVoiceRuntime({
      settings: openaiSettings,
      credential: async () => "secret-openai",
      fetch: vi.fn(async () => new Response("not audio", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });
    await expect(wrongType.synthesize("hello")).rejects.toThrow(/non-audio response/);
  });

  it("fails clearly when a configured provider has no credential", async () => {
    const runtime = createVoiceRuntime({ settings: openaiSettings, credential: async () => undefined, fetch: vi.fn() as unknown as typeof fetch });
    await expect(runtime.transcribe({ audio: createVoiceProbeWav(), mimeType: "audio/wav" })).rejects.toThrow(/credential for openai is not configured/);
  });
});
