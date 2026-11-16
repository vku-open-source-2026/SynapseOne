# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""CPU-first ONNX Runtime backend for sentence embeddings.

The official ``sentence-transformers`` ONNX exports are used when present:
an int8 graph is picked when the host CPU supports it, otherwise the fp32
graph. Vectors match ``SentenceTransformer.encode`` defaults: mean pooling
over the attention mask, then L2 normalisation.
"""

from __future__ import annotations

import logging
import platform
from pathlib import Path
from typing import List, Sequence

import numpy as np

from .model_lock import MODEL_IMPORT_LOCK

logger = logging.getLogger(__name__)

# Repo-relative files shipped by sentence-transformers/all-MiniLM-L6-v2.
_INT8_AVX512_VNNI = "onnx/model_qint8_avx512_vnni.onnx"
_INT8_AVX2 = "onnx/model_quint8_avx2.onnx"
_INT8_ARM64 = "onnx/model_qint8_arm64.onnx"
_FP32 = "onnx/model.onnx"


def cpu_flags() -> set[str]:
    """Return the CPU feature flags from /proc/cpuinfo (empty on non-Linux)."""
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as handle:
            for line in handle:
                if line.lower().startswith("flags"):
                    return set(line.split(":", 1)[1].split())
    except OSError:
        pass
    return set()


def candidate_onnx_files(explicit: str = "") -> List[str]:
    """Ordered ONNX file candidates, best CPU-specific int8 graph first."""
    if explicit:
        return [explicit]

    machine = platform.machine().lower()
    flags = cpu_flags()
    candidates: List[str] = []

    if machine in ("x86_64", "amd64"):
        if "avx512_vnni" in flags:
            candidates.append(_INT8_AVX512_VNNI)
        if "avx2" in flags:
            candidates.append(_INT8_AVX2)
    elif machine in ("aarch64", "arm64"):
        candidates.append(_INT8_ARM64)

    candidates.append(_FP32)

    # Preserve order while removing duplicates.
    seen: set[str] = set()
    return [f for f in candidates if not (f in seen or seen.add(f))]


def all_onnx_files() -> List[str]:
    """Every shipped graph, used to prefetch a portable cache at build time."""
    return [_INT8_AVX512_VNNI, _INT8_AVX2, _INT8_ARM64, _FP32]


def _resolve_local_path(path: str) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_dir():
        for name in ("model.onnx", "model_quantized.onnx"):
            if (candidate / name).is_file():
                return candidate / name
        matches = sorted(candidate.glob("*.onnx"))
        if matches:
            return matches[0]
        raise FileNotFoundError(f"no .onnx file found in {path}")
    if not candidate.is_file():
        raise FileNotFoundError(f"ONNX model not found: {path}")
    return candidate


def _download_onnx(model_name: str, filename: str, allow_download: bool) -> Path:
    from huggingface_hub import hf_hub_download

    last_error: Exception | None = None
    for candidate in candidate_onnx_files(filename):
        try:
            resolved = hf_hub_download(
                repo_id=model_name,
                filename=candidate,
                local_files_only=not allow_download,
            )
            logger.info("using ONNX embedding graph %s", candidate)
            return Path(resolved)
        except Exception as exc:  # try the next precision/variant
            last_error = exc
            logger.debug("ONNX file %s unavailable: %s", candidate, exc)
    raise RuntimeError(
        f"no usable ONNX graph for {model_name!r}: {last_error}"
    ) from last_error


class OnnxEmbedder:
    """Minimal ONNX text embedder (no torch dependency)."""

    def __init__(
        self,
        model_name: str,
        *,
        onnx_path: str = "",
        filename: str = "",
        max_length: int = 256,
        threads: int = 0,
        allow_download: bool = True,
    ):
        with MODEL_IMPORT_LOCK:
            import onnxruntime as ort
            from transformers import AutoTokenizer

        if onnx_path:
            resolved = _resolve_local_path(onnx_path)
        else:
            resolved = _download_onnx(model_name, filename, allow_download)

        self.onnx_file = str(resolved)
        self.max_length = max_length
        self._tokenizer = AutoTokenizer.from_pretrained(
            model_name, local_files_only=not allow_download
        )

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = True
        if threads > 0:
            options.intra_op_num_threads = threads
            options.inter_op_num_threads = 1

        self._session = ort.InferenceSession(
            self.onnx_file,
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        self._input_names = {item.name for item in self._session.get_inputs()}
        self._output_names = [item.name for item in self._session.get_outputs()]
        logger.info(
            "ONNX embedder ready: file=%s threads=%s max_length=%s",
            self.onnx_file,
            threads or "auto",
            max_length,
        )

    def encode(self, texts: Sequence[str], batch_size: int = 32) -> List[List[float]]:
        vectors: List[List[float]] = []
        for start in range(0, len(texts), max(1, batch_size)):
            batch = list(texts[start : start + max(1, batch_size)])
            encoded = self._tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="np",
            )
            feeds = {
                name: np.asarray(encoded[name])
                for name in self._input_names
                if name in encoded
            }
            outputs = self._session.run(self._output_names, feeds)
            hidden = np.asarray(outputs[0])

            if hidden.ndim == 3:
                mask = np.asarray(encoded["attention_mask"], dtype=np.float32)
                mask = mask[..., None]
                pooled = (hidden * mask).sum(axis=1) / np.clip(
                    mask.sum(axis=1), 1e-9, None
                )
            elif hidden.ndim == 2:
                pooled = hidden
            else:
                raise ValueError(
                    f"unexpected ONNX output shape {hidden.shape} for {self.onnx_file}"
                )

            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            pooled = pooled / np.clip(norms, 1e-12, None)
            vectors.extend(pooled.astype(np.float32).tolist())

        return vectors
