# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Load the pure Python model modules without importing the FastAPI app.

The production inference service ships ``embedding.py``, ``decision.py`` and
``onnx_embedding.py``.  The runner image copies only those modules into a safe
package (``synapse_local_models``); ``src.main`` and ``uvicorn`` are never
copied or imported.  During development the same loader can point at
``apps/inference-service/src`` through ``SYNAPSE_LOCAL_MODELS_DIR``.

Nothing in this module imports torch/onnx/pydantic at import time; the chosen
directory is only validated when the worker actually loads a capability.
"""

from __future__ import annotations

import importlib
import importlib.machinery
import importlib.util
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, Optional

from errors import WorkerError

PACKAGE_NAME = "synapse_local_models"
_REQUIRED_MODULES = ("config", "model_lock", "embedding", "decision", "onnx_embedding")


@dataclass
class ModelPackage:
    """The imported model package and its public modules."""

    directory: str
    root: Any
    config: Any
    embedding: Any
    decision: Any
    onnx_embedding: Any


def _default_package_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), PACKAGE_NAME)


def _dev_package_dir() -> str:
    # apps/workflow-runner/local-inference -> apps/inference-service/src
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(
        os.path.join(here, "..", "..", "inference-service", "src")
    )


def resolve_models_dir(models_dir: Optional[str] = None) -> str:
    """Return the directory that contains the model modules."""
    if models_dir:
        return os.path.abspath(os.path.expanduser(models_dir))
    env = os.environ.get("SYNAPSE_LOCAL_MODELS_DIR", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    packaged = _default_package_dir()
    if os.path.isfile(os.path.join(packaged, "embedding.py")):
        return packaged
    # Repository-local tests / development: use the inference service source.
    dev = _dev_package_dir()
    if os.path.isfile(os.path.join(dev, "embedding.py")):
        return dev
    return packaged


def load_model_package(models_dir: Optional[str] = None) -> ModelPackage:
    """Import the model package from ``models_dir`` under a stable alias."""
    directory = resolve_models_dir(models_dir)
    missing = [
        name
        for name in _REQUIRED_MODULES
        if not os.path.isfile(os.path.join(directory, f"{name}.py"))
    ]
    if missing:
        raise WorkerError(
            "model_stack_unavailable",
            "model modules are missing from "
            f"{directory}: {', '.join(missing)}. Build the runner image with the "
            "inference model stack or set SYNAPSE_LOCAL_MODELS_DIR.",
        )

    existing = sys.modules.get(PACKAGE_NAME)
    if existing is not None and getattr(existing, "__synapse_models_dir__", None) == directory:
        root = existing
    else:
        # Drop a previously imported (possibly empty) package so submodules are
        # always resolved from the directory selected above.
        for key in [k for k in sys.modules if k == PACKAGE_NAME or k.startswith(PACKAGE_NAME + ".")]:
            del sys.modules[key]
        init_file = os.path.join(directory, "__init__.py")
        if not os.path.isfile(init_file):
            # Synthesise an empty package marker for directories that do not
            # ship one; the model modules only need a package context.
            init_file = None
        if init_file:
            spec = importlib.util.spec_from_file_location(
                PACKAGE_NAME, init_file, submodule_search_locations=[directory]
            )
        else:
            spec = importlib.machinery.ModuleSpec(
                PACKAGE_NAME, loader=None, is_package=True
            )
            spec.submodule_search_locations = [directory]
        if spec is None or spec.loader is None and init_file:
            raise WorkerError("model_stack_unavailable", f"cannot import {directory}")
        root = importlib.util.module_from_spec(spec)
        sys.modules[PACKAGE_NAME] = root
        if init_file:
            spec.loader.exec_module(root)
        root.__synapse_models_dir__ = directory

    modules: Dict[str, Any] = {}
    for name in ("config", "model_lock", "embedding", "decision", "onnx_embedding"):
        modules[name] = importlib.import_module(f"{PACKAGE_NAME}.{name}")

    return ModelPackage(
        directory=directory,
        root=root,
        config=modules["config"],
        embedding=modules["embedding"],
        decision=modules["decision"],
        onnx_embedding=modules["onnx_embedding"],
    )


def build_settings(package: ModelPackage, overrides: Dict[str, Any]) -> Any:
    """Create a Settings instance and force the worker's safe overrides."""
    cfg = package.config.Settings()
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def make_strict_embedding(package: ModelPackage, cfg: Any) -> Any:
    """Embedding engine that raises instead of returning mock vectors."""

    base = package.embedding.EmbeddingEngine

    class StrictEmbeddingEngine(base):  # type: ignore[misc, valid-type]
        def _generate_mock_embedding(self, text: str, dim: int = 384):  # noqa: ANN001
            raise WorkerError(
                "model_not_ready",
                "embedding model is not loaded; refusing to return a mock vector",
                retryable=True,
            )

    return StrictEmbeddingEngine(cfg)


def make_strict_decision(package: ModelPackage, cfg: Any) -> Any:
    """Decision engine that raises instead of using the lexical fallback."""

    base = package.decision.DecisionEngine

    class StrictDecisionEngine(base):  # type: ignore[misc, valid-type]
        def _uses_openrouter(self) -> bool:  # noqa: D401 - hard local-only guard
            return False

        def _fallback_system_one(self, state: str, questions: Any):  # noqa: ANN001
            raise WorkerError(
                "model_not_ready",
                "decision model is not loaded; refusing to return a fallback answer",
                retryable=True,
            )

    return StrictDecisionEngine(cfg)
