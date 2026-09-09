#!/usr/bin/env python3
"""Private offline BGE-small-en-v1.5 INT8 ONNX worker for FRIDAY Memory."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from typing import Any

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIMENSIONS = 384
MAX_SEQUENCE_LENGTH = 512
MAX_BATCH = 8
MAX_TEXT_LENGTH = 64_000
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT / "models" / "Xenova" / "bge-small-en-v1.5"
MODEL_PATH = MODEL_ROOT / "onnx" / "model_int8.onnx"
TOKENIZER_PATH = MODEL_ROOT / "tokenizer.json"


def _threads() -> int:
    raw = os.environ.get("FRIDAY_MEMORY_EMBEDDING_THREADS", "").strip()
    if raw.isdigit():
        return max(1, min(8, int(raw)))
    cpu = os.cpu_count() or 1
    return max(1, min(4, cpu))


class BgeEngine:
    def __init__(self) -> None:
        if not MODEL_PATH.is_file() or not TOKENIZER_PATH.is_file():
            raise RuntimeError("BGE INT8 model/tokenizer is missing; run `friday setup memory`")
        self.tokenizer = Tokenizer.from_file(str(TOKENIZER_PATH))
        self.tokenizer.enable_truncation(max_length=MAX_SEQUENCE_LENGTH)
        self.tokenizer.enable_padding(pad_id=0, pad_type_id=0, pad_token="[PAD]")

        options = ort.SessionOptions()
        options.intra_op_num_threads = _threads()
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            str(MODEL_PATH),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

    def encode(self, texts: list[str], *, query: bool) -> list[list[float]]:
        if not 1 <= len(texts) <= MAX_BATCH:
            raise ValueError(f"embedding batch must contain between 1 and {MAX_BATCH} texts")
        prepared: list[str] = []
        for text in texts:
            if not isinstance(text, str):
                raise TypeError("embedding input must be text")
            if len(text) > MAX_TEXT_LENGTH:
                raise ValueError(f"embedding text exceeds {MAX_TEXT_LENGTH} characters")
            prepared.append(f"{QUERY_PREFIX}{text}" if query else text)

        encodings = self.tokenizer.encode_batch(prepared)
        input_ids = np.asarray([encoding.ids for encoding in encodings], dtype=np.int64)
        attention_mask = np.asarray([encoding.attention_mask for encoding in encodings], dtype=np.int64)
        token_type_ids = np.asarray([encoding.type_ids for encoding in encodings], dtype=np.int64)
        feed: dict[str, np.ndarray] = {}
        if "input_ids" in self.input_names:
            feed["input_ids"] = input_ids
        if "attention_mask" in self.input_names:
            feed["attention_mask"] = attention_mask
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = token_type_ids
        if not feed:
            raise RuntimeError("BGE ONNX model exposes no supported text inputs")

        outputs = self.session.run(None, feed)
        if not outputs:
            raise RuntimeError("BGE ONNX model returned no outputs")
        hidden = np.asarray(outputs[0], dtype=np.float32)
        if hidden.ndim != 3 or hidden.shape[0] != len(prepared) or hidden.shape[2] != MODEL_DIMENSIONS:
            raise RuntimeError(f"unexpected BGE output shape: {tuple(hidden.shape)}")
        vectors = hidden[:, 0, :]
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1.0, norms)
        vectors = vectors / norms
        return vectors.astype(np.float32, copy=False).tolist()


def _write(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def serve() -> None:
    engine = BgeEngine()
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        request_id: Any = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            kind = request.get("kind")
            texts = request.get("texts")
            if not isinstance(request_id, int):
                raise ValueError("embedding request id must be an integer")
            if kind not in ("query", "document"):
                raise ValueError("embedding request kind must be query or document")
            if not isinstance(texts, list):
                raise ValueError("embedding request texts must be an array")
            vectors = engine.encode(texts, query=kind == "query")
            _write({"id": request_id, "ok": True, "vectors": vectors})
        except Exception as exc:  # Boundary must convert failures to bounded protocol errors.
            _write({"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:4000]})


def probe() -> None:
    engine = BgeEngine()
    vector = engine.encode(["FRIDAY memory embedding health check"], query=True)[0]
    if len(vector) != MODEL_DIMENSIONS:
        raise RuntimeError("BGE probe returned wrong dimensions")
    _write({"ok": True, "dimensions": len(vector), "provider": "bge-small-en-v1.5-int8-cls-v1"})


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("--serve", "--probe"):
        raise SystemExit("usage: bge_worker.py --serve|--probe")
    if sys.argv[1] == "--probe":
        probe()
    else:
        serve()
