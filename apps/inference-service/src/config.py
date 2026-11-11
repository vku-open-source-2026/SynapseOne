# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
import os

from dotenv import load_dotenv

load_dotenv()


def _get_env_str(keys: list[str], default: str) -> str:
    for k in keys:
        v = os.getenv(k)
        if v is not None and v.strip() != "":
            return v.strip()
    return default


def _get_env_int(
    keys: list[str], default: int, min_val: int = 1, max_val: int = 300000
) -> int:
    for k in keys:
        v = os.getenv(k)
        if v is not None:
            try:
                val = int(v)
                return max(min_val, min(val, max_val))
            except ValueError:
                pass
    return default


def _get_env_bool(keys: list[str], default: bool) -> bool:
    for k in keys:
        v = os.getenv(k)
        if v is not None:
            return v.strip().lower() in ("true", "1", "yes", "on")
    return default


class Settings:
    """Central configuration for Synapse Inference Engine."""

    PORT: int = _get_env_int(["PORT", "INFERENCE_PORT"], 4008, 1024, 65535)
    HOST: str = _get_env_str(["INFERENCE_HOST", "HOST"], "0.0.0.0")
    ENVIRONMENT: str = _get_env_str(["NODE_ENV", "ENVIRONMENT", "ENV"], "development")
    SYNAPSEONE_INTERNAL_SECRET: str = _get_env_str(["SYNAPSEONE_INTERNAL_SECRET"], "")
    IAM_SERVICE_URL: str = _get_env_str(["IAM_SERVICE_URL"], "http://iam:4001").rstrip(
        "/"
    )
    # Token metering is best-effort; never block the request path.
    USAGE_REPORTING: bool = _get_env_bool(["INFERENCE_USAGE_REPORTING"], True)

    # LLM (OpenRouter)
    OPENROUTER_BASE_URL: str = _get_env_str(
        ["OPENROUTER_BASE_URL", "AI_BASE_URL"], "https://openrouter.ai/api/v1"
    ).rstrip("/")
    OPENROUTER_API_KEY: str = _get_env_str(["OPENROUTER_API_KEY", "AI_API_KEY"], "")
    OPENROUTER_MODEL: str = _get_env_str(
        ["OPENROUTER_MODEL", "AI_LLM_MODEL"], "liquid/lfm-2.5-2.6b:free"
    )
    OPENROUTER_FALLBACK_MODEL: str = _get_env_str(
        ["OPENROUTER_FALLBACK_MODEL", "AI_LLM_FALLBACK_MODEL"], "inception/mercury-2.5"
    )
    OPENROUTER_TIMEOUT_MS: int = _get_env_int(
        ["OPENROUTER_TIMEOUT_MS", "AI_TIMEOUT_MS"], 30000, 1000, 300000
    )
    OPENROUTER_RETRIES: int = _get_env_int(
        ["OPENROUTER_RETRIES", "AI_RETRIES"], 2, 0, 5
    )

    # Embedding Model (Self-hosted Lightweight)
    EMBEDDING_MODEL_NAME: str = _get_env_str(
        ["EMBEDDING_MODEL_NAME"], "sentence-transformers/all-MiniLM-L6-v2"
    )
    EMBEDDING_DIM: int = _get_env_int(["EMBEDDING_DIM"], 384, 16, 4096)
    # auto = ONNX int8 on CPU (falls back to torch, then mock). "onnx" and
    # "torch" force one backend; "mock" skips model loading entirely.
    EMBEDDING_BACKEND: str = _get_env_str(["EMBEDDING_BACKEND"], "auto").lower()
    # Explicit local .onnx file (or directory containing one). When empty the
    # model is resolved from the Hugging Face repo (quantized file preferred).
    EMBEDDING_ONNX_PATH: str = _get_env_str(["EMBEDDING_ONNX_PATH"], "")
    # Override the repo-relative ONNX file, e.g. onnx/model.onnx.
    EMBEDDING_ONNX_FILE: str = _get_env_str(["EMBEDDING_ONNX_FILE"], "")
    EMBEDDING_BATCH_SIZE: int = _get_env_int(["EMBEDDING_BATCH_SIZE"], 32, 1, 512)
    EMBEDDING_MAX_LENGTH: int = _get_env_int(["EMBEDDING_MAX_LENGTH"], 256, 16, 8192)

    # Decision Model (Self-hosted Decision-2.0-Eos-0.8B)
    DECISION_MODEL_NAME: str = _get_env_str(
        ["DECISION_MODEL_NAME"], "vllm-sr/Decision-2.0-Eos-0.8B"
    )
    # The 0.8B decision model needs ~3 GB RAM in FP32 on CPU. Disable it on
    # memory-constrained nodes; the deterministic router fallback stays active.
    DECISION_ENABLED: bool = _get_env_bool(["DECISION_ENABLED"], True)
    DECISION_THREADS: int = _get_env_int(["DECISION_THREADS"], 0, 0, 256)
    # Load the 0.8B model in a background thread at startup so the first
    # decision request does not pay the download/load cost.
    DECISION_WARMUP: bool = _get_env_bool(["DECISION_WARMUP"], True)

    # Device, CPU threads & Mocking
    INFERENCE_DEVICE: str = _get_env_str(["INFERENCE_DEVICE"], "auto")
    # 0 = auto (min(4, host CPUs)); pin this to the container CPU limit.
    INFERENCE_CPU_THREADS: int = _get_env_int(["INFERENCE_CPU_THREADS"], 0, 0, 256)
    INFERENCE_MOCK_MODELS: bool = _get_env_bool(["INFERENCE_MOCK_MODELS"], False)
    # Load the embedding model in a background thread at startup so the first
    # request and /health reflect the real backend.
    INFERENCE_WARMUP: bool = _get_env_bool(["INFERENCE_WARMUP"], True)
    # Allow downloading model files from Hugging Face on first use. Disable in
    # air-gapped production (models must then be baked or mounted).
    INFERENCE_MODEL_DOWNLOAD: bool = _get_env_bool(["INFERENCE_MODEL_DOWNLOAD"], True)
    # Backoff after a failed load so one bad model does not retry per request.
    MODEL_LOAD_RETRY_SECONDS: int = _get_env_int(
        ["MODEL_LOAD_RETRY_SECONDS"], 300, 0, 86400
    )

    # CORS: comma-separated allowlist. Empty is the dev default (allow all);
    # production refuses to boot without an explicit list.
    CORS_ORIGIN: str = _get_env_str(["CORS_ORIGIN"], "")

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGIN.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"


settings = Settings()
