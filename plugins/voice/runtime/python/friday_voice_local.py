#!/usr/bin/env python3
from __future__ import annotations

import argparse
import inspect
from pathlib import Path
import sys


CHATTERBOX_NANO_REPO = "ResembleAI/chatterbox-nano"
CHATTERBOX_NANO_MODEL_REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"
CHATTERBOX_NANO_REQUIRED_FILES = (
    "added_tokens.json",
    "conds.pt",
    "merges.txt",
    "s3gen_meanflow.safetensors",
    "special_tokens_map.json",
    "t3_nano_v1.safetensors",
    "tokenizer_config.json",
    "ve.safetensors",
    "vocab.json",
)


def chatterbox_nano_snapshot() -> str:
    from huggingface_hub import snapshot_download

    download = dict(
        repo_id=CHATTERBOX_NANO_REPO,
        revision=CHATTERBOX_NANO_MODEL_REVISION,
        allow_patterns=list(CHATTERBOX_NANO_REQUIRED_FILES),
    )
    try:
        return snapshot_download(**download)
    except Exception as exc:
        if "xet" not in str(exc).lower() and "hex hash" not in str(exc).lower():
            raise
        import huggingface_hub.constants as hf_constants
        hf_constants.HF_HUB_DISABLE_XET = True
        return snapshot_download(**download)


def load_chatterbox_nano(device: str):
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    parameters = inspect.signature(ChatterboxTurboTTS.from_local).parameters
    if "nano" not in parameters:
        raise RuntimeError(
            "Installed Chatterbox build does not support Nano. Re-run `friday setup voice` "
            "so FRIDAY can install its pinned Nano-compatible source revision."
        )
    local_path = chatterbox_nano_snapshot()
    return ChatterboxTurboTTS.from_local(local_path, device=device, nano=True)


def chatterbox(model_name: str, text: str, output: Path, reference: str | None, device: str) -> None:
    import torch
    import torchaudio as ta
    torch.set_grad_enabled(False)
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was selected for Chatterbox but torch.cuda.is_available() is false")
    model = load_chatterbox_nano(device)
    kwargs = {"audio_prompt_path": reference} if reference else {}
    wav = model.generate(text, **kwargs)
    ta.save(str(output), wav.cpu(), model.sr)


def kitten(text: str, output: Path, voice: str, root: Path) -> None:
    from kittentts import KittenTTS

    model = KittenTTS("KittenML/kitten-tts-nano-0.8-int8", cache_dir=str(root / "cache" / "huggingface"))
    model.generate_to_file(text, str(output), voice=voice)


def piper(text: str, output: Path, voice: str, root: Path) -> None:
    import subprocess

    result = subprocess.run(
        [sys.executable, "-m", "piper", "-m", voice, "--data-dir", str(root / "voices"), "-f", str(output), "--", text],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "piper synthesis failed")[-4000:])


def preload(model_name: str, voice: str, root: Path, device: str) -> None:
    if model_name == "chatterbox-nano":
        import torch
        torch.set_grad_enabled(False)
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was selected for Chatterbox but torch.cuda.is_available() is false")
        load_chatterbox_nano(device)
        return
    if model_name == "kitten-nano-int8":
        from kittentts import KittenTTS
        KittenTTS("KittenML/kitten-tts-nano-0.8-int8", cache_dir=str(root / "cache" / "huggingface"))
        return
    if model_name == "piper":
        if not (root / "voices" / f"{voice}.onnx").exists():
            raise RuntimeError(f"Piper voice is missing: {voice}")
        return
    raise RuntimeError(f"unsupported local TTS model: {model_name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["preload", "synthesize"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--text")
    parser.add_argument("--output")
    parser.add_argument("--reference")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if args.operation == "preload":
        preload(args.model, args.voice, root, args.device)
        return 0
    if not args.text or not args.output:
        raise RuntimeError("synthesize requires --text and --output")
    output = Path(args.output).resolve()
    if args.model == "chatterbox-nano":
        chatterbox(args.model, args.text, output, args.reference, args.device)
    elif args.model == "kitten-nano-int8":
        kitten(args.text, output, args.voice, root)
    elif args.model == "piper":
        piper(args.text, output, args.voice, root)
    else:
        raise RuntimeError(f"unsupported local TTS model: {args.model}")
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("local TTS produced no audio")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"friday local voice error: {exc}", file=sys.stderr)
        raise SystemExit(1)
