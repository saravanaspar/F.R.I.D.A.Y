# Voice

FRIDAY Voice is an optional runtime plugin for speech-to-text (STT) and text-to-speech (TTS). It does not create a second Agent or Turn Loop. Voice can use hosted providers or private local models.

## Setup

```bash
friday setup voice
```

The setup flow stores only non-secret provider/model/voice choices in `FRIDAY_HOME/voice/settings.json` with private permissions. Hosted API keys are verified before publication and stored in Vault. Local models are downloaded/provisioned automatically only after the operator selects them; no manual model download is required.

After the mandatory v1.0.3 local bootstrap, Voice can also be configured from the paired trusted channel. Hosted provider keys use protected credential capture directly into Vault and are never forwarded through ordinary model text. Local Voice presents the same bounded model choices, and Chatterbox still requires an explicit CPU/GPU selection whenever a working NVIDIA GPU is available. Voice settings remain mutable after onboarding: STT language can return to `auto`, Chatterbox CPU/CUDA and voice choices can be changed, and cloning reference audio can be set/replaced from a validated host path, replaced from exactly one attached audio artifact, or cleared. These are patch operations and do not reset the untouched STT/TTS side.

### Local speech-to-text

Selecting **Local / offline** for STT offers a bounded low-memory set:

| Choice | Runtime RAM guidance | Accuracy/speed guidance | Model file |
| --- | ---: | --- | ---: |
| Whisper tiny Q5_1 | ~300 MB target | Fastest / basic accuracy | ~32 MB |
| Whisper base Q5_1 | ~450 MB target | Balanced default | ~60 MB |
| Whisper small Q5_1 | ~900 MB target | Best accuracy of this low-memory set | ~190 MB |

These are OpenAI Whisper weights converted and quantized for `whisper.cpp`; the quantized files are not published by OpenAI itself. Setup pins/builds `whisper.cpp`, downloads exactly the selected Q5_1 model from a fixed model-repository revision, verifies the selected file against its expected SHA-256 digest, and keeps it below `FRIDAY_HOME/tooling/voice/`. Runtime converts inbound audio to 16 kHz mono PCM WAV locally before transcription.

RAM figures are practical setup targets, not hard RSS guarantees. Decoder settings, platform libraries, allocator behavior, and concurrent work can change peak memory.

### Local text-to-speech

Selecting **Local / offline** for TTS offers:

| Choice | Runtime RAM guidance | Voice cloning | Expression/emotion | Best fit |
| --- | ---: | --- | --- | --- |
| Chatterbox Nano 110M | ~0.8–1.0 GB target; host-dependent | Yes, zero-shot reference clip | Yes, paralinguistic tags | Best expression / cloning |
| KittenTTS Nano int8 15M | Well under 500 MB target | No | No | Very small CPU footprint |
| Piper | Typically under 500 MB target | No | No | Fast, robust, Raspberry Pi-friendly |

Chatterbox Nano is the cloning/expressive option. Setup or the trusted-channel `voice.setup` action copies a selected reference clip into FRIDAY's private voice-reference directory as a content-addressed file with mode `0600`; channel attachments are first persisted through Artifacts and then staged privately. The runtime refuses reference paths outside that directory. Voice identity is separate from expression: callers can request provider-neutral styles such as `happy`, `sad`, `angry`, `sarcastic`, `annoyed`, `embarrassed`, `tsundere`, `playful`, `excited`, `nervous`, and `sleepy`, plus events such as `laugh`, `chuckle`, `sigh`, `gasp`, `groan`, `cough`, `clear-throat`, `shush`, `sniff`, and `tsk`. Chatterbox maps these to its supported paralinguistic cues where possible; high-level character phrasing still belongs to the Agent rather than to a separate `.voice` identity. Chatterbox's Python/PyTorch dependency overhead makes its peak RSS more host-dependent than its parameter count alone suggests.

For Chatterbox, CPU is the safe default. If setup detects a working NVIDIA GPU through `nvidia-smi`, it still asks **Chatterbox compute backend** before installing PyTorch. Choosing **CPU** pins Torch/Torchaudio to PyTorch's CPU wheel index and verifies that the resulting Torch build has no CUDA runtime. Choosing **NVIDIA GPU** is explicit opt-in, pins the compatible CUDA 12.6 wheel index, verifies `torch.cuda.is_available()`, and persists `compute: "cuda"` so runtime synthesis uses the same backend. The CUDA choice can download multiple gigabytes of NVIDIA runtime wheels, but FRIDAY does not install or replace the operating-system NVIDIA driver. If a Chatterbox environment is incomplete or was provisioned for a different backend, setup rebuilds only that model's private venv before retrying; model caches remain separate.

FRIDAY installs Chatterbox's declared runtime dependencies explicitly, then installs the official Perth watermarking dependency from immutable revision `ff1c8ac55a976971245cdd53c18d6131ca00d993` and overlays the immutable upstream Nano implementation revision `5de7a54aa4e5e2baadb0182dde554908b48b85c2`, both without dependency resolution. This avoids `uv` rejecting Chatterbox's transitive moving `resemble-perth @ ...@master` URL while keeping the operator-selected CPU/CUDA Torch build unchanged. The pinned Nano source is still required because the PyPI 0.1.7 wheel predates the upstream `nano=True` loader even though the repository reports version 0.1.7. Setup verifies both Perth and the Nano loader before model download and records `.friday-ready` only after preload succeeds, so failed or incompatible environments are never treated as complete.

FRIDAY pins the Nano model snapshot to Hugging Face revision `71ccd1d0081b430592cea481f4307e764e07bc64` and downloads only files the Nano loader actually consumes. The upstream repository is about 3 GB because it contains both `s3gen.safetensors` and `s3gen_meanflow.safetensors` at roughly 1.06 GB each; Nano uses only the meanflow checkpoint. FRIDAY excludes the unused checkpoint, reducing required Nano model assets to about 1.94 GB plus Python dependencies.

KittenTTS and Chatterbox Hugging Face caches are redirected into the selected model's private FRIDAY tooling directory. Setup preloads the selected model so downloads happen during setup; local runtime forces Hugging Face/Transformers offline mode and does not silently fetch model assets during a voice request. Piper voices are downloaded into the same private tooling tree.

### Hosted providers

Supported hosted built-ins remain:

- STT: OpenAI (`gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`)
- STT: Deepgram (`nova-3`, `nova-3-general`)
- TTS: OpenAI (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`)
- TTS: ElevenLabs (`eleven_multilingual_v2`, `eleven_v3`)

OpenAI Voice reuses the canonical `vault://models/openai/api-key` credential so the same key does not need to be stored twice. Deepgram and ElevenLabs use Voice-owned Vault references. Local STT/TTS requires no API credential.

## Privileged host dependencies

On Debian/Ubuntu, `friday setup voice` detects the host commands required by the selected local STT/TTS models and installs the fixed approved dependency set automatically when anything is missing. On the first local setup it can bootstrap the restricted privilege broker itself; the operating system may show a normal local `sudo` password prompt. The password is handled by `sudo` in the terminal and is never exposed to FRIDAY or to the model. The standalone `friday setup privileges` command remains available for administrators who want to pre-provision or repair the broker manually.

This does **not** give the model an arbitrary sudo shell. Setup installs a root-owned `/usr/local/libexec/friday-privileged` helper and a sudoers rule that permits only the exact `voice-deps` operation. The helper accepts exactly one operation and uses a fixed package allowlist; there is no `NOPASSWD: ALL`, no arbitrary command argument, and no model-facing sudo tool. Local model subprocesses also receive a scrubbed environment rather than FRIDAY's API-key/Vault-related process environment. Dependency probes use command-specific version flags (including `ffmpeg -version`) and include standard system binary directories when validating an installation.

The current automatic host dependency operation is intentionally limited to Debian/Ubuntu. GPU selection is separate from this privileged operation: FRIDAY never auto-installs an NVIDIA driver. GPU mode is offered only when a working NVIDIA driver is already visible through `nvidia-smi`; otherwise Chatterbox remains CPU-only. Other hosts must already provide the required commands.

## Inbound audio

Channels continue to publish generic turns. Artifacts owns download/persistence of attachments. Voice contributes an `artifact.input-enrichment` processor for audio records; Artifacts calls it after the attachment has been persisted, so the audio is not fetched twice.

The transcript is bounded and wrapped as untrusted user content before it is added to model context. Durable sessions persist the bounded transcript so a restart does not call the STT provider again for the same prepared turn.

## TTS

TTS is exposed through the typed `voice` capability. Hosted providers return bounded MP3 chunks; local providers return bounded WAV chunks. Audio-capable channel adapters can consume the same capability without changing Turn Loop or Agent.

## Security and privacy

- API keys remain in Vault and are never written to Voice settings.
- Local model subprocesses do not inherit FRIDAY provider/API-key environment variables.
- Local runtime model caches are private and network-offline after setup.
- Provider errors and local subprocess output are bounded before they become operational errors.
- Audio attachments retain Artifacts size and private-file protections.
- Hosted STT network/cost behavior is opt-in through `friday setup voice`; selected local inference is offline after provisioning.
- The transcript is user data, not trusted host instruction text.
- Wake-word detection is intentionally outside this plugin; any future capture surface should keep that detection local rather than sending always-on microphone audio through Voice.
