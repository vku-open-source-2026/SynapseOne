# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Request handling for the local inference worker.

Supported inference types:

``embeddings``  OpenAI-compatible embedding response (local ONNX MiniLM)
``decision``    Decision-2.0 ``{state, questions}`` evaluation
``route``       Decision-2.0 choice routing ``{input, choices}``
``chat``        only when a real local causal-LM directory is configured

Anything else is reported as unsupported.  There is no HTTP server and no
remote/provider fallback in this process.
"""

from __future__ import annotations

import glob
import logging
import math
import os
import time
from typing import Any, Dict, Iterable, List, Optional

from errors import WorkerError
from models import ModelSupervisor

logger = logging.getLogger(__name__)

WORKER_NAME = "synapseone-local-inference"
WORKER_VERSION = "0.1.0"
PROTOCOL_VERSION = 1

MAX_EMBEDDING_INPUTS = 256
MAX_TEXT_CHARS = 65_536
MAX_TOTAL_TEXT_CHARS = 1_000_000
MAX_QUESTIONS = 64
MAX_STATE_CHARS = 131_072
MAX_CHAT_MESSAGES = 64
MAX_CHAT_CONTENT_CHARS = 32_768

_TYPE_ALIASES = {
    "embedding": "embeddings",
    "embeddings": "embeddings",
    "embed": "embeddings",
    "decision": "decision",
    "decide": "decision",
    "route": "route",
    "routing": "route",
    "chat": "chat",
    "chat.completion": "chat",
    "chat.completions": "chat",
    "chat_completion": "chat",
    "generic": "generic",
}

SUPPORTED_TYPES = ("embeddings", "decision", "route")


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(value, maximum))


def _to_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    for method in ("model_dump", "dict"):
        fn = getattr(value, method, None)
        if callable(fn):
            dumped = fn()
            if isinstance(dumped, dict):
                return dumped
    raise WorkerError("model_error", f"model returned an unsupported value type: {type(value).__name__}")


def _bounded_int(value: Any, name: str, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise WorkerError("bad_request", f"{name} must be an integer") from None
    return max(minimum, min(parsed, maximum))


def _normalise_type(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        raise WorkerError("bad_request", "type is required for an infer request")
    resolved = _TYPE_ALIASES.get(value)
    if resolved is None:
        raise WorkerError(
            "unsupported_type",
            f"inference type {value!r} is not supported by the local worker; "
            f"supported types: {', '.join(SUPPORTED_TYPES)} and chat when configured",
        )
    return resolved


def _normalise_inputs(value: Any, limit: int = MAX_EMBEDDING_INPUTS) -> List[str]:
    if isinstance(value, str):
        texts = [value]
    elif isinstance(value, list) and all(isinstance(item, str) for item in value):
        texts = list(value)
    else:
        raise WorkerError(
            "bad_request", "request.input must be a string or a list of strings"
        )
    if not texts:
        texts = [""]
    if len(texts) > limit:
        raise WorkerError(
            "request_too_large",
            f"at most {limit} embedding inputs are allowed",
        )
    total = 0
    for text in texts:
        if len(text) > MAX_TEXT_CHARS:
            raise WorkerError(
                "request_too_large",
                f"each embedding input must be at most {MAX_TEXT_CHARS} characters",
            )
        total += len(text)
    if total > MAX_TOTAL_TEXT_CHARS:
        raise WorkerError(
            "request_too_large",
            f"total embedding input must be at most {MAX_TOTAL_TEXT_CHARS} characters",
        )
    return texts


def _finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


class LocalInferenceRuntime:
    """Maps protocol requests to the local model supervisor."""

    def __init__(
        self,
        supervisor: ModelSupervisor,
        *,
        enable_route: bool = True,
        max_embedding_inputs: int = MAX_EMBEDDING_INPUTS,
        max_chat_tokens: int = 512,
        max_rss_mb: int = 0,
        timeout_ms: int = 0,
    ) -> None:
        self.supervisor = supervisor
        self.started_at = time.time()
        self.enable_route = bool(enable_route)
        self.max_embedding_inputs = max(1, min(int(max_embedding_inputs), 1024))
        self.max_chat_tokens = max(1, min(int(max_chat_tokens), 512))
        self.max_rss_mb = max(0, int(max_rss_mb))
        self.timeout_ms = max(0, int(timeout_ms))

    # -- entrypoints -------------------------------------------------------
    def handle(self, record: Dict[str, Any]) -> Dict[str, Any]:
        op = str(record.get("op") or "").strip().lower()
        if op == "health":
            return self.health(record.get("request") or {})
        if op == "infer":
            return self.infer(record.get("type"), record.get("request") or {})
        raise WorkerError(
            "bad_request", f"unknown op {op!r}; expected health, infer or shutdown"
        )

    def health(self, request: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        request = request if isinstance(request, dict) else {}
        self.supervisor.maybe_retry()
        wait_ms = _bounded_int(request.get("waitMs"), "waitMs", 0, 0, 600_000)
        if wait_ms > 0:
            snapshot = self.supervisor.wait_until_settled(wait_ms / 1000.0)
        else:
            snapshot = self.supervisor.snapshot()

        capabilities = {
            name: self._capability_payload(state) for name, state in snapshot.items()
        }
        # `route` is served by the same Decision-2.0 engine as `decision`.  It is
        # exposed as its own capability because the Node bridge checks
        # ``health.capabilities[type].ready`` before sending a job.
        decision_capability = capabilities.get("decision")
        if decision_capability is not None:
            route_capability = dict(decision_capability)
            route_capability["enabled"] = bool(
                decision_capability.get("enabled") and self.enable_route
            )
            route_capability["ready"] = bool(
                decision_capability.get("ready") and self.enable_route
            )
            if not self.enable_route:
                route_capability["state"] = "disabled"
            capabilities["route"] = route_capability

        required = [
            name
            for name, capability in capabilities.items()
            if capability["supported"] and capability["enabled"]
        ]
        ready_names = [name for name in required if capabilities[name]["ready"]]
        failed = [name for name in required if capabilities[name]["state"] == "failed"]
        loading = [name for name in required if capabilities[name]["state"] == "loading"]
        ready = bool(required) and len(ready_names) == len(required)

        if ready:
            status = "ready"
        elif loading:
            status = "starting"
        elif failed and ready_names:
            status = "degraded"
        elif failed:
            status = "failed"
        elif not required:
            status = "unavailable"
        else:
            status = "starting"

        return {
            "worker": WORKER_NAME,
            "version": WORKER_VERSION,
            "protocol": PROTOCOL_VERSION,
            "pid": os.getpid(),
            "uptimeSeconds": round(time.time() - self.started_at, 3),
            "ready": ready,
            "status": status,
            "readyCapabilities": ready_names,
            "failClosed": True,
            "mockMode": False,
            "unsupportedTypes": self._unsupported_types(capabilities),
            "memory": self._memory_guidance(snapshot),
            "network": {
                "httpServer": False,
                "listeners": [],
                "outboundModelApi": False,
                "controlPlane": "node-runner",
            },
            "modelPackage": self.supervisor.package_directory,
            "modelPackageError": self.supervisor.package_error,
            "capabilities": capabilities,
            "limits": {
                "maxEmbeddingInputs": self.max_embedding_inputs,
                "maxTextChars": MAX_TEXT_CHARS,
                "maxQuestions": MAX_QUESTIONS,
                "maxStateChars": MAX_STATE_CHARS,
                "maxChatMessages": MAX_CHAT_MESSAGES,
                "maxChatTokens": self.max_chat_tokens,
                "maxRssMb": self.max_rss_mb or None,
                "timeoutMs": self.timeout_ms or None,
            },
        }

    def infer(self, raw_type: Any, request: Any) -> Dict[str, Any]:
        if not isinstance(request, dict):
            raise WorkerError("bad_request", "request must be a JSON object")
        inference_type = _normalise_type(raw_type)
        if inference_type == "embeddings":
            return self._embeddings(request)
        if inference_type == "decision":
            return self._decision(request)
        if inference_type == "route":
            return self._route(request)
        if inference_type == "chat":
            return self._chat(request)
        raise WorkerError(
            "unsupported_type",
            f"inference type {inference_type!r} is not supported by the local worker",
        )

    # -- capabilities ------------------------------------------------------
    def _capability_payload(self, state: Dict[str, Any]) -> Dict[str, Any]:
        loaded_at = state.get("loadedAt")
        return {
            "supported": bool(state["supported"]),
            "enabled": bool(state["enabled"]),
            "ready": bool(state["ready"]),
            "state": state["state"],
            "model": state.get("model"),
            "backend": state.get("backend"),
            "error": state.get("error"),
            "attempts": int(state.get("attempts") or 0),
            "loadedAt": (
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(loaded_at)))
                if loaded_at
                else None
            ),
        }

    def _unsupported_types(self, capabilities: Dict[str, Any]) -> List[str]:
        unsupported = ["generic"]
        if not capabilities.get("chat", {}).get("supported"):
            unsupported.append("chat")
        return unsupported

    def _memory_guidance(self, snapshot: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        decision = snapshot.get("decision") or {}
        decision_enabled = bool(decision.get("supported") and decision.get("enabled"))
        minimum = 4096 if decision_enabled else 1024
        recommended = 6144 if decision_enabled else 1536
        warning = None
        if self.max_rss_mb and self.max_rss_mb < minimum:
            warning = (
                f"LOCAL_INFERENCE_MAX_RSS_MB={self.max_rss_mb} is below the "
                f"{minimum} MiB needed by "
                f"{'Decision-2.0 (FP32 0.8B)' if decision_enabled else 'the model stack'}"
                "; the container may be OOM-killed while loading"
            )
        return {
            "minimumRssMb": minimum,
            "recommendedRssMb": recommended,
            "maxRssMb": self.max_rss_mb or None,
            "decisionEnabled": decision_enabled,
            "warning": warning,
        }

    # -- embeddings --------------------------------------------------------
    def _embeddings(self, request: Dict[str, Any]) -> Dict[str, Any]:
        engine = self.supervisor.require_embedding()
        texts = _normalise_inputs(request.get("input"), self.max_embedding_inputs)
        dimensions = request.get("dimensions")
        if dimensions is not None:
            parsed = _bounded_int(dimensions, "dimensions", 0, 1, 65_536)
            expected = int(getattr(engine, "dimension", 384) or 384)
            if parsed != expected:
                raise WorkerError(
                    "unsupported_dimensions",
                    f"this local model produces {expected}-dimension vectors, "
                    f"not {parsed}",
                )
        try:
            response = engine.embed(texts)
        except WorkerError:
            raise
        except Exception as exc:  # noqa: BLE001 - fail closed, no mock vectors
            raise WorkerError(
                "model_error", f"embedding inference failed: {exc}", retryable=True
            ) from exc

        result = _to_dict(response)
        data = result.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise WorkerError(
                "model_error", "embedding model returned an unexpected response shape"
            )
        for item in data:
            vector = item.get("embedding") if isinstance(item, dict) else None
            if not isinstance(vector, list) or not vector or not all(_finite(x) for x in vector):
                raise WorkerError(
                    "model_error", "embedding model returned a non-finite vector"
                )
        return result

    # -- decision / route --------------------------------------------------
    def _question_class(self) -> Any:
        cls = self.supervisor.decision_question_class()
        return cls

    def _build_questions(self, questions: Any) -> Dict[str, Any]:
        if not isinstance(questions, dict) or not questions:
            raise WorkerError("bad_request", "request.questions must be a non-empty object")
        if len(questions) > MAX_QUESTIONS:
            raise WorkerError(
                "request_too_large", f"at most {MAX_QUESTIONS} questions are allowed"
            )
        cls = self._question_class()
        built: Dict[str, Any] = {}
        for question_id, spec in questions.items():
            if not isinstance(question_id, str) or not question_id:
                raise WorkerError("bad_request", "question ids must be non-empty strings")
            if not isinstance(spec, dict):
                raise WorkerError("bad_request", f"question {question_id} must be an object")
            cleaned = {
                key: spec[key]
                for key in ("type", "instructions", "criteria")
                if key in spec and spec[key] is not None
            }
            if "type" not in cleaned or "instructions" not in cleaned:
                raise WorkerError(
                    "bad_request",
                    f"question {question_id} needs both 'type' and 'instructions'",
                )
            try:
                built[question_id] = cls(**cleaned)
            except Exception as exc:  # noqa: BLE001 - pydantic validation
                raise WorkerError(
                    "bad_request", f"question {question_id} is invalid: {exc}"
                ) from exc
        return built

    def _decision(self, request: Dict[str, Any]) -> Dict[str, Any]:
        engine = self.supervisor.require_decision()
        state = request.get("state")
        if not isinstance(state, str):
            raise WorkerError("bad_request", "request.state must be a string")
        if len(state) > MAX_STATE_CHARS:
            raise WorkerError(
                "request_too_large",
                f"request.state must be at most {MAX_STATE_CHARS} characters",
            )
        questions = self._build_questions(request.get("questions"))
        try:
            response = engine.evaluate(state, questions)
        except WorkerError:
            raise
        except Exception as exc:  # noqa: BLE001 - fail closed, no lexical fallback
            raise WorkerError(
                "model_error", f"decision inference failed: {exc}", retryable=True
            ) from exc
        result = _to_dict(response)
        answers = result.get("results")
        if not isinstance(answers, dict) or not answers:
            raise WorkerError("model_error", "decision model returned no answers")
        return result

    def _route(self, request: Dict[str, Any]) -> Dict[str, Any]:
        if not self.enable_route:
            raise WorkerError(
                "capability_disabled",
                "route is disabled for this runner (not in LOCAL_INFERENCE_CAPABILITIES)",
            )
        engine = self.supervisor.require_decision()
        input_text = request.get("input")
        choices = request.get("choices")
        if not isinstance(input_text, str):
            raise WorkerError("bad_request", "request.input must be a string")
        if len(input_text) > MAX_STATE_CHARS:
            raise WorkerError(
                "request_too_large",
                f"request.input must be at most {MAX_STATE_CHARS} characters",
            )
        if (
            not isinstance(choices, dict)
            or not choices
            or not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in choices.items()
            )
        ):
            raise WorkerError(
                "bad_request", "request.choices must be a non-empty {id: description} object"
            )
        if len(choices) > MAX_QUESTIONS:
            raise WorkerError(
                "request_too_large", f"at most {MAX_QUESTIONS} route choices are allowed"
            )
        instruction = request.get("instruction")
        if instruction is not None and not isinstance(instruction, str):
            raise WorkerError("bad_request", "request.instruction must be a string")
        cls = self._question_class()
        question = cls(
            type="choice",
            instructions=instruction
            or "Select the most suitable destination for this input.",
            criteria=choices,
        )
        try:
            response = engine.evaluate(input_text, {"route": question})
        except WorkerError:
            raise
        except Exception as exc:  # noqa: BLE001 - fail closed
            raise WorkerError(
                "model_error", f"route inference failed: {exc}", retryable=True
            ) from exc
        result = _to_dict(response)
        answers = result.get("results")
        route_result = answers.get("route") if isinstance(answers, dict) else None
        if not isinstance(route_result, dict):
            raise WorkerError("model_error", "decision model returned no route result")
        probabilities = route_result.get("probabilities")
        if not isinstance(probabilities, dict) or not probabilities:
            raise WorkerError(
                "model_error", "decision model returned no route probabilities"
            )
        clean_probs: Dict[str, float] = {}
        for key, value in probabilities.items():
            if not _finite(value):
                raise WorkerError(
                    "model_error", "decision model returned a non-finite probability"
                )
            clean_probs[str(key)] = float(value)
        best = route_result.get("best_choice") or max(clean_probs, key=clean_probs.get)
        if best not in clean_probs:
            raise WorkerError("model_error", "decision model returned an unknown best choice")
        if best not in choices:
            raise WorkerError(
                "model_error",
                "decision model returned a choice outside the requested set",
            )
        return {
            "best_choice": str(best),
            "confidence": float(clean_probs[str(best)]),
            "probabilities": clean_probs,
            "model": result.get("model"),
            "duration_ms": result.get("duration_ms"),
        }

    # -- chat --------------------------------------------------------------
    def _chat(self, request: Dict[str, Any]) -> Dict[str, Any]:
        if not self.supervisor.chat_supported():
            raise WorkerError(
                "unsupported_type",
                "chat is not available: no local chat model is configured "
                "(the local worker never calls a remote inference API)",
            )
        engine = self.supervisor.require_chat()
        messages = request.get("messages")
        if not isinstance(messages, list) or not messages:
            raise WorkerError("bad_request", "request.messages must be a non-empty array")
        if len(messages) > MAX_CHAT_MESSAGES:
            raise WorkerError(
                "request_too_large", f"at most {MAX_CHAT_MESSAGES} messages are allowed"
            )
        cleaned: List[Dict[str, str]] = []
        for message in messages:
            if not isinstance(message, dict):
                raise WorkerError("bad_request", "each message must be an object")
            role = str(message.get("role") or "user")
            content = message.get("content")
            if not isinstance(content, str):
                raise WorkerError("bad_request", "message.content must be a string")
            if len(content) > MAX_CHAT_CONTENT_CHARS:
                raise WorkerError(
                    "request_too_large",
                    f"message.content must be at most {MAX_CHAT_CONTENT_CHARS} characters",
                )
            cleaned.append({"role": role, "content": content})
        max_tokens = _bounded_int(
            request.get("max_tokens"),
            "max_tokens",
            min(256, self.max_chat_tokens),
            1,
            self.max_chat_tokens,
        )
        try:
            temperature = float(request.get("temperature", 0.0) or 0.0)
        except (TypeError, ValueError):
            raise WorkerError("bad_request", "temperature must be a number") from None
        return engine.generate(
            cleaned, max_tokens=max_tokens, temperature=max(0.0, min(temperature, 2.0))
        )


def _capability_flags() -> Dict[str, bool]:
    raw = os.environ.get("LOCAL_INFERENCE_CAPABILITIES", "").strip()
    if not raw:
        return {
            "embeddings": _env_bool("LOCAL_INFERENCE_EMBEDDING", True),
            "decision": _env_bool("LOCAL_INFERENCE_DECISION", True),
            "route": _env_bool("LOCAL_INFERENCE_DECISION", True),
            "chat": bool(
                os.environ.get("LOCAL_INFERENCE_CHAT_MODEL", "").strip()
                or os.environ.get("LOCAL_INFERENCE_MODEL_CHAT", "").strip()
            ),
        }
    requested = {item.strip().lower() for item in raw.split(",") if item.strip()}
    return {
        "embeddings": "embeddings" in requested,
        "decision": "decision" in requested or "route" in requested,
        "route": "route" in requested,
        "chat": "chat" in requested,
    }


# The Console/backend historically sends the short MiniLM name.  The baked
# Hugging Face cache only contains the fully-qualified repository id, so map the
# exact known alias; custom repos and local paths are preserved verbatim.
_EMBEDDING_MODEL_ALIASES = {
    "all-MiniLM-L6-v2": "sentence-transformers/all-MiniLM-L6-v2",
}


def _normalize_embedding_model_name(value: str) -> str:
    normalized = str(value or "").strip()
    return _EMBEDDING_MODEL_ALIASES.get(normalized, normalized)


def _apply_model_overrides(overrides: Dict[str, Any]) -> str:
    """Apply owner-provided local model paths. Unknown/remote ids fail closed."""
    embedding_model = _normalize_embedding_model_name(
        os.environ.get("LOCAL_INFERENCE_MODEL_EMBEDDINGS", "").strip()
        or os.environ.get("EMBEDDING_MODEL_NAME", "").strip()
    )
    if embedding_model:
        overrides["EMBEDDING_MODEL_NAME"] = embedding_model
        base = os.path.expanduser(embedding_model)
        if os.path.isdir(base):
            for candidate in (
                os.path.join(base, "onnx", "model.onnx"),
                os.path.join(base, "model.onnx"),
            ):
                if os.path.isfile(candidate):
                    overrides["EMBEDDING_ONNX_PATH"] = candidate
                    break
    decision_model = (
        os.environ.get("LOCAL_INFERENCE_MODEL_DECISION", "").strip()
        or os.environ.get("LOCAL_INFERENCE_MODEL_ROUTE", "").strip()
    )
    if decision_model:
        overrides["DECISION_MODEL_NAME"] = decision_model
    return (
        os.environ.get("LOCAL_INFERENCE_MODEL_CHAT", "").strip()
        or os.environ.get("LOCAL_INFERENCE_CHAT_MODEL", "").strip()
    )


def runtime_from_env() -> LocalInferenceRuntime:
    """Build the runtime from worker environment variables."""
    capabilities = _capability_flags()
    enable_embedding = capabilities["embeddings"]
    enable_decision = capabilities["decision"]
    enable_route = capabilities["route"]
    threads = _env_int(
        "LOCAL_INFERENCE_THREADS",
        _env_int("INFERENCE_CPU_THREADS", 0, 0, 256),
        0,
        256,
    )
    retry_seconds = _env_int("LOCAL_INFERENCE_MODEL_RETRY_SECONDS", 60, 5, 86_400)
    requested_backend = os.environ.get("EMBEDDING_BACKEND", "onnx").strip().lower()
    embedding_backend = (
        requested_backend if requested_backend in ("onnx", "torch", "auto") else "onnx"
    )
    if requested_backend not in ("onnx", "torch", "auto"):
        logger.warning(
            "EMBEDDING_BACKEND=%r is not a real backend; forcing onnx",
            requested_backend,
        )
    overrides: Dict[str, Any] = {
        "INFERENCE_MOCK_MODELS": False,
        "INFERENCE_MODEL_DOWNLOAD": False,
        "INFERENCE_DEVICE": "cpu",
        "INFERENCE_WARMUP": False,
        "EMBEDDING_BACKEND": embedding_backend,
        "DECISION_BACKEND": "local",
        "DECISION_ENABLED": enable_decision,
        "DECISION_WARMUP": False,
    }
    if threads > 0:
        overrides["INFERENCE_CPU_THREADS"] = threads
        overrides["DECISION_THREADS"] = threads
    chat_model = _apply_model_overrides(overrides)
    if not capabilities["chat"]:
        chat_model = ""
    supervisor = ModelSupervisor(
        models_dir=os.environ.get("SYNAPSE_LOCAL_MODELS_DIR", "").strip() or None,
        overrides=overrides,
        enable_embedding=enable_embedding,
        enable_decision=enable_decision,
        chat_model=chat_model,
        threads=threads,
        retry_seconds=retry_seconds,
    )
    runtime = LocalInferenceRuntime(
        supervisor,
        enable_route=enable_route,
        max_embedding_inputs=_env_int(
            "LOCAL_INFERENCE_MAX_BATCH", MAX_EMBEDDING_INPUTS, 1, 1024
        ),
        max_chat_tokens=_env_int("LOCAL_INFERENCE_MAX_TOKENS", 512, 1, 512),
        max_rss_mb=_env_int("LOCAL_INFERENCE_MAX_RSS_MB", 0, 0, 1_048_576),
        timeout_ms=_env_int("LOCAL_INFERENCE_TIMEOUT_MS", 0, 0, 3_600_000),
    )
    if (
        runtime.max_rss_mb
        and enable_decision
        and runtime.max_rss_mb < 4096
    ):
        logger.warning(
            "LOCAL_INFERENCE_MAX_RSS_MB=%s is below the 4096 MiB needed by "
            "Decision-2.0 (~3 GiB FP32); use 4096 (minimum) or 6144 "
            "(recommended) to avoid an OOM kill while loading",
            runtime.max_rss_mb,
        )
    return runtime
