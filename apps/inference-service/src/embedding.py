# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
import hashlib
import logging
import math
import os
import threading
import time
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel

from .config import Settings, settings
from .model_lock import MODEL_IMPORT_LOCK

logger = logging.getLogger(__name__)


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: Optional[str] = None
    dimensions: Optional[int] = None


class EmbeddingItem(BaseModel):
    object: str = "embedding"
    index: int
    embedding: List[float]


class EmbeddingUsage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class EmbeddingResponse(BaseModel):
    object: str = "list"
    data: List[EmbeddingItem]
    model: str
    usage: EmbeddingUsage


class EmbeddingEngine:
    """Self-hosted lightweight embedding service (default: sentence-transformers/all-MiniLM-L6-v2).

    Backend order for ``EMBEDDING_BACKEND=auto`` on CPU: ONNX Runtime int8 ->
    PyTorch/sentence-transformers -> deterministic hash mock. ONNX avoids the
    torch dependency, uses a ~23 MB int8 graph and is faster on CPU (measured
    ~1.2-1.5x on AVX2, more with AVX-512 VNNI).
    """

    def __init__(self, cfg: Optional[Settings] = None):
        self.cfg = cfg or settings
        self.model_name = self.cfg.EMBEDDING_MODEL_NAME
        self.dimension = self.cfg.EMBEDDING_DIM
        self._model = None
        self._backend = "mock"
        self._is_loaded = False
        self._load_error: Optional[str] = None
        self._load_lock = threading.Lock()
        self._encode_lock = threading.Lock()
        self._retry_after = 0.0

    def _threads(self) -> int:
        configured = self.cfg.INFERENCE_CPU_THREADS
        if configured > 0:
            return configured
        return max(1, min(4, os.cpu_count() or 1))

    def _determine_device(self) -> str:
        dev = self.cfg.INFERENCE_DEVICE.lower()
        if dev in ("cuda", "cpu"):
            return dev
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"

    def _backend_order(self) -> List[str]:
        requested = self.cfg.EMBEDDING_BACKEND
        if requested in ("onnx", "torch", "mock"):
            return [requested]
        if requested != "auto":
            logger.warning("unknown EMBEDDING_BACKEND=%r, using auto", requested)
        # CUDA hosts are faster with torch; every other host uses ONNX first.
        if self._determine_device() == "cuda":
            return ["torch", "onnx"]
        return ["onnx", "torch"]

    def _load_onnx(self) -> None:
        from .onnx_embedding import OnnxEmbedder

        self._model = OnnxEmbedder(
            self.model_name,
            onnx_path=self.cfg.EMBEDDING_ONNX_PATH,
            filename=self.cfg.EMBEDDING_ONNX_FILE,
            max_length=self.cfg.EMBEDDING_MAX_LENGTH,
            threads=self._threads(),
            allow_download=self.cfg.INFERENCE_MODEL_DOWNLOAD,
        )
        self._backend = "onnx"

    def _load_torch(self) -> None:
        with MODEL_IMPORT_LOCK:
            import torch
            from sentence_transformers import SentenceTransformer

        if self.cfg.INFERENCE_CPU_THREADS > 0:
            torch.set_num_threads(self.cfg.INFERENCE_CPU_THREADS)
        self._model = SentenceTransformer(
            self.model_name, device=self._determine_device()
        )
        if hasattr(self._model, "eval"):
            self._model.eval()
        self._backend = "torch"

    def load_model(self) -> bool:
        """Load the best available backend. Returns True when a real model is ready."""
        if self._is_loaded:
            return True
        if self.cfg.INFERENCE_MOCK_MODELS or self.cfg.EMBEDDING_BACKEND == "mock":
            return False

        with self._load_lock:
            if self._is_loaded:
                return True
            if time.monotonic() < self._retry_after:
                return False

            errors: List[str] = []
            for backend in self._backend_order():
                if backend == "mock":
                    continue
                try:
                    if backend == "onnx":
                        self._load_onnx()
                    else:
                        self._load_torch()
                    self._is_loaded = True
                    self._load_error = None
                    logger.info(
                        "embedding backend=%s model=%s", self._backend, self.model_name
                    )
                    return True
                except Exception as exc:  # noqa: BLE001 - report and try next backend
                    errors.append(f"{backend}: {exc}")
                    logger.warning("embedding backend %s failed: %s", backend, exc)

            self._is_loaded = False
            self._backend = "mock"
            self._load_error = " | ".join(errors) or "no usable backend"
            self._retry_after = time.monotonic() + self.cfg.MODEL_LOAD_RETRY_SECONDS
            logger.error(
                "embedding model unavailable, using mock vectors: %s", self._load_error
            )
            return False

    def _generate_mock_embedding(self, text: str, dim: int = 384) -> List[float]:
        """Generate a deterministic 384-dimensional unit-normalized vector for testing/offline use."""
        # Seeded pseudo-random vector based on sha256 of text
        h = hashlib.sha256(text.encode("utf-8")).digest()
        vec = []
        for i in range(dim):
            byte_val = h[i % len(h)]
            # Mix with index to create variation across dimensions
            val = ((byte_val ^ ((i * 7) & 0xFF)) - 128) / 128.0
            vec.append(val)

        # L2 normalize
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [round(x / norm, 6) for x in vec]

    def _encode(self, texts: List[str]) -> List[List[float]]:
        if self._backend == "onnx":
            # ONNX Runtime sessions are thread-safe; the lock only bounds CPU
            # contention from concurrent requests.
            with self._encode_lock:
                return self._model.encode(
                    texts, batch_size=self.cfg.EMBEDDING_BATCH_SIZE
                )
        if self._backend == "torch":
            with self._encode_lock:
                embeddings = self._model.encode(
                    texts,
                    batch_size=self.cfg.EMBEDDING_BATCH_SIZE,
                    convert_to_numpy=True,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )
            return [[float(x) for x in emb.tolist()] for emb in embeddings]
        raise RuntimeError(f"no embedding backend loaded (backend={self._backend})")

    def embed(
        self, inputs: Union[str, List[str]], model_override: Optional[str] = None
    ) -> EmbeddingResponse:
        texts = [inputs] if isinstance(inputs, str) else inputs
        if not texts:
            texts = [""]

        model_to_report = model_override or self.model_name
        target_dim = self.dimension

        vectors: List[List[float]] = []
        prompt_tokens = 0

        # Try real model if available
        if not self._is_loaded and not self.cfg.INFERENCE_MOCK_MODELS:
            self.load_model()

        if self._is_loaded and self._model is not None:
            try:
                vectors = self._encode(texts)
            except Exception as exc:  # noqa: BLE001 - degrade, never 500
                # Fallback to mock if runtime failure occurs
                self._load_error = str(exc)
                logger.exception("embedding inference failed, using mock vectors")
                vectors = [self._generate_mock_embedding(t, target_dim) for t in texts]
        else:
            vectors = [self._generate_mock_embedding(t, target_dim) for t in texts]

        # Calculate approximate token count (~4 chars per token)
        for t in texts:
            prompt_tokens += max(1, len(t) // 4)

        data = [
            EmbeddingItem(index=idx, embedding=vec) for idx, vec in enumerate(vectors)
        ]

        return EmbeddingResponse(
            data=data,
            model=model_to_report,
            usage=EmbeddingUsage(
                prompt_tokens=prompt_tokens, total_tokens=prompt_tokens
            ),
        )

    @property
    def status(self) -> Dict[str, Any]:
        return {
            "model": self.model_name,
            "dimension": self.dimension,
            "backend": self._backend,
            "loaded": self._is_loaded,
            "device": self._determine_device(),
            "threads": self._threads(),
            "onnx_file": getattr(self._model, "onnx_file", None)
            if self._backend == "onnx"
            else None,
            "mock_mode": self.cfg.INFERENCE_MOCK_MODELS or not self._is_loaded,
            "error": self._load_error,
        }


# Global singleton instance
embedding_engine = EmbeddingEngine()
