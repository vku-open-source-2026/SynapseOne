# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Model lifecycle supervisor for the local inference worker.

Capabilities are loaded in background threads at startup (or synchronously for
``--self-test``).  Each capability has its own readiness state, so the Console
can show exactly which model is loading, ready, failed or unsupported.

Fail-closed rules enforced here:

* ``INFERENCE_MOCK_MODELS`` is always false;
* ``INFERENCE_MODEL_DOWNLOAD`` is always false (weights are baked into the image);
* the decision engine is forced to the local backend (no OpenRouter);
* a capability is only ``ready`` after the real model reports ``loaded`` and
  ``mock_mode=false``;
* the strict engine wrappers raise instead of returning deterministic fallbacks.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

from chat_engine import LocalChatEngine
from errors import WorkerError
from models_loader import (
    ModelPackage,
    build_settings,
    load_model_package,
    make_strict_decision,
    make_strict_embedding,
)

logger = logging.getLogger(__name__)

CAPABILITIES = ("embeddings", "decision", "chat")


def _initial_state(name: str, *, supported: bool, enabled: bool, model: str = "") -> Dict[str, Any]:
    if not supported:
        state = "unsupported"
    elif not enabled:
        state = "disabled"
    else:
        state = "pending"
    return {
        "name": name,
        "supported": bool(supported),
        "enabled": bool(enabled),
        "ready": False,
        "state": state,
        "model": model or None,
        "backend": None,
        "error": None,
        "attempts": 0,
        "loadedAt": None,
        "retryAt": None,
    }


class ModelSupervisor:
    """Owns model loading, readiness and access."""

    def __init__(
        self,
        *,
        models_dir: Optional[str] = None,
        overrides: Optional[Dict[str, Any]] = None,
        enable_embedding: bool = True,
        enable_decision: bool = True,
        chat_model: str = "",
        threads: int = 0,
        retry_seconds: int = 60,
    ) -> None:
        self.models_dir = models_dir
        self.overrides = dict(overrides or {})
        self.enable_embedding = bool(enable_embedding)
        self.enable_decision = bool(enable_decision)
        self.chat_model = str(chat_model or "").strip()
        self.threads = max(0, int(threads or 0))
        self.retry_seconds = max(5, int(retry_seconds or 60))

        self._lock = threading.RLock()
        self._package_lock = threading.Lock()
        self._package: Optional[ModelPackage] = None
        self._package_error: Optional[str] = None
        self._cfg: Any = None
        self._embedding: Any = None
        self._decision: Any = None
        self._chat: Any = None
        self._active: set[str] = set()
        self._threads: list[threading.Thread] = []
        self._started = False

        self._states: Dict[str, Dict[str, Any]] = {
            "embeddings": _initial_state(
                "embeddings",
                supported=True,
                enabled=self.enable_embedding,
                model=str(os_env("EMBEDDING_MODEL_NAME", "sentence-transformers/all-MiniLM-L6-v2")),
            ),
            "decision": _initial_state(
                "decision",
                supported=True,
                enabled=self.enable_decision,
                model=str(os_env("DECISION_MODEL_NAME", "vllm-sr/Decision-2.0-Eos-0.8B")),
            ),
            "chat": _initial_state(
                "chat",
                supported=bool(self.chat_model),
                enabled=bool(self.chat_model),
                model=self.chat_model,
            ),
        }

    # -- public lifecycle --------------------------------------------------
    def start(self, *, background: bool = True) -> None:
        if self._started:
            return
        self._started = True
        for name in CAPABILITIES:
            if not self._enabled(name):
                continue
            if background:
                self._spawn(name)
            else:
                self._mark_loading(name)
                self._load_one(name)

    def wait_until_settled(self, timeout: float = 0.0) -> Dict[str, Dict[str, Any]]:
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            snapshot = self.snapshot()
            if not any(item["state"] == "loading" for item in snapshot.values()):
                return snapshot
            if time.monotonic() >= deadline:
                return snapshot
            time.sleep(0.05)

    def maybe_retry(self) -> None:
        """Restart failed loads after their backoff, at most one per capability."""
        now = time.time()
        with self._lock:
            candidates = [
                name
                for name, state in self._states.items()
                if state["state"] == "failed"
                and state.get("retryAt") is not None
                and now >= float(state["retryAt"])
                and name not in self._active
            ]
        for name in candidates:
            logger.info("retrying %s model load", name)
            self._spawn(name)

    def shutdown(self, timeout: float = 2.0) -> None:
        for thread in list(self._threads):
            thread.join(timeout=max(0.0, timeout))

    # -- status ------------------------------------------------------------
    def snapshot(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {name: dict(state) for name, state in self._states.items()}

    @property
    def package_directory(self) -> Optional[str]:
        return self._package.directory if self._package else None

    @property
    def package_error(self) -> Optional[str]:
        return self._package_error

    # -- capability access -------------------------------------------------
    def require_embedding(self) -> Any:
        return self._require("embeddings", self._embedding)

    def require_decision(self) -> Any:
        return self._require("decision", self._decision)

    def require_chat(self) -> Any:
        return self._require("chat", self._chat)

    def chat_supported(self) -> bool:
        with self._lock:
            state = dict(self._states["chat"])
        return bool(state["supported"])

    def decision_question_class(self) -> Any:
        """Return the DecisionQuestion model class from the loaded package."""
        with self._lock:
            package = self._package
        if package is None:
            try:
                package = self._package_or_raise()
            except Exception as exc:  # noqa: BLE001 - surface as fail-closed
                raise WorkerError(
                    "model_not_ready",
                    f"decision model package is unavailable: {exc}",
                    retryable=True,
                ) from exc
        return package.decision.DecisionQuestion

    # -- internals ---------------------------------------------------------
    def _enabled(self, name: str) -> bool:
        state = self._states[name]
        return bool(state["supported"] and state["enabled"])

    def _require(self, name: str, engine: Any) -> Any:
        with self._lock:
            state = dict(self._states[name])
            ready = engine is not None and state["state"] == "ready"
        if ready:
            return engine
        if not state["supported"]:
            raise WorkerError(
                "unsupported_type",
                f"{name} is not available in this local runner build",
            )
        if not state["enabled"]:
            raise WorkerError(
                "capability_disabled",
                f"{name} is disabled on this runner",
            )
        if state["state"] == "loading":
            raise WorkerError(
                "model_loading",
                f"{name} model is still loading",
                retryable=True,
            )
        if state["state"] == "failed":
            raise WorkerError(
                "model_not_ready",
                f"{name} model is not available: {state.get('error') or 'load failed'}",
                retryable=True,
                details={"capability": name},
            )
        raise WorkerError(
            "model_not_ready",
            f"{name} model has not been loaded yet",
            retryable=True,
            details={"capability": name},
        )

    def _mark_loading(self, name: str) -> None:
        with self._lock:
            state = self._states[name]
            state["state"] = "loading"
            state["ready"] = False
            state["error"] = None
            state["attempts"] = int(state.get("attempts") or 0) + 1
            state["retryAt"] = None

    def _spawn(self, name: str) -> None:
        with self._lock:
            if name in self._active:
                return
            self._active.add(name)
        self._mark_loading(name)
        thread = threading.Thread(
            target=self._load_one,
            args=(name,),
            name=f"local-inference-{name}",
            daemon=True,
        )
        self._threads.append(thread)
        thread.start()

    def _load_one(self, name: str) -> None:
        try:
            if name == "embeddings":
                self._load_embedding()
            elif name == "decision":
                self._load_decision()
            elif name == "chat":
                self._load_chat()
        except Exception as exc:  # noqa: BLE001 - convert to capability failure
            self._fail(name, exc)
        finally:
            with self._lock:
                self._active.discard(name)

    def _package_or_raise(self) -> ModelPackage:
        if self._package is not None:
            return self._package
        with self._package_lock:
            if self._package is not None:
                return self._package
            try:
                package = load_model_package(self.models_dir)
                self._cfg = build_settings(package, self.overrides)
            except Exception as exc:  # noqa: BLE001 - reported per capability
                self._package_error = str(exc)
                raise
            self._package = package
            self._package_error = None
            return package

    def _mark_ready(self, name: str, engine: Any, status: Dict[str, Any]) -> None:
        with self._lock:
            state = self._states[name]
            state["state"] = "ready"
            state["ready"] = True
            state["error"] = None
            state["backend"] = status.get("backend")
            state["model"] = status.get("model") or state.get("model")
            state["loadedAt"] = time.time()
            state["retryAt"] = None
        logger.info(
            "%s model ready backend=%s model=%s",
            name,
            status.get("backend"),
            status.get("model"),
        )

    def _fail(self, name: str, exc: BaseException) -> None:
        message = str(exc) or exc.__class__.__name__
        with self._lock:
            state = self._states[name]
            state["state"] = "failed"
            state["ready"] = False
            state["error"] = message
            state["retryAt"] = time.time() + self.retry_seconds
        logger.error("%s model unavailable (fail closed): %s", name, message)

    def _load_embedding(self) -> None:
        package = self._package_or_raise()
        engine = make_strict_embedding(package, self._cfg)
        usable = bool(engine.load_model())
        status = dict(getattr(engine, "status", {}) or {})
        if not usable or not status.get("loaded"):
            raise WorkerError(
                "model_not_ready",
                status.get("error") or "embedding model did not load",
            )
        if status.get("mock_mode"):
            raise WorkerError(
                "model_not_ready", "embedding backend reported mock mode"
            )
        with self._lock:
            self._embedding = engine
        self._mark_ready("embeddings", engine, status)

    def _load_decision(self) -> None:
        package = self._package_or_raise()
        engine = make_strict_decision(package, self._cfg)
        usable = bool(engine.load_model())
        status = dict(getattr(engine, "status", {}) or {})
        if not usable or not status.get("loaded"):
            raise WorkerError(
                "model_not_ready",
                status.get("error") or "decision model did not load",
            )
        if status.get("mock_mode"):
            raise WorkerError(
                "model_not_ready", "decision backend reported mock mode"
            )
        if str(status.get("backend") or "").lower() == "openrouter":
            raise WorkerError(
                "invalid_configuration",
                "remote decision backend is not allowed in the local runner",
            )
        with self._lock:
            self._decision = engine
        self._mark_ready("decision", engine, status)

    def _load_chat(self) -> None:
        engine = LocalChatEngine(self.chat_model, threads=self.threads)
        usable = bool(engine.load_model())
        status = dict(getattr(engine, "status", {}) or {})
        if not usable or not status.get("loaded"):
            raise WorkerError(
                "model_not_ready", status.get("error") or "chat model did not load"
            )
        with self._lock:
            self._chat = engine
        self._mark_ready("chat", engine, status)


def os_env(name: str, default: str) -> str:
    import os

    value = os.environ.get(name, "")
    return value.strip() if value and value.strip() else default
