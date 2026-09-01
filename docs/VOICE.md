# Voice

FRIDAY Voice is an optional runtime plugin for speech-to-text (STT) and text-to-speech (TTS). It does not create a second Agent or Turn Loop.

## Setup

```bash
friday setup voice
```

The setup flow stores only non-secret provider/model/voice choices in `FRIDAY_HOME/voice/settings.json` with private permissions. API keys are verified before publication and stored in Vault.

Supported built-ins:

- STT: OpenAI (`gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`)
- STT: Deepgram (`nova-3`, `nova-3-general`)
- TTS: OpenAI (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`)
- TTS: ElevenLabs (`eleven_multilingual_v2`, `eleven_v3`)

OpenAI Voice reuses the canonical `vault://models/openai/api-key` credential so the same key does not need to be stored twice. Deepgram and ElevenLabs use Voice-owned Vault references.

## Inbound audio

Channels continue to publish generic turns. Artifacts owns download/persistence of attachments. Voice contributes an `artifact.input-enrichment` processor for audio records; Artifacts calls it after the attachment has been persisted, so the audio is not fetched twice.

The transcript is bounded and wrapped as untrusted user content before it is added to model context. Durable sessions persist the bounded transcript so a restart does not call the STT provider again for the same prepared turn.

## TTS

TTS is exposed through the typed `voice` capability. It returns bounded MP3 chunks instead of assuming a particular transport. A future mobile companion, local voice surface, or audio-capable channel adapter can consume that capability without changing Turn Loop or Agent.

## Security and privacy

- API keys remain in Vault and are never written to Voice settings.
- Provider errors are bounded before they become operational errors.
- Audio attachments retain Artifacts size and private-file protections.
- STT network/cost behavior is opt-in through `friday setup voice`.
- The transcript is user data, not trusted host instruction text.
- Wake-word detection is intentionally outside this plugin and should run locally on the client device.
