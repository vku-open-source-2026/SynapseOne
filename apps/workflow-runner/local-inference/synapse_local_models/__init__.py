# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Safe local copy of the pure inference model modules.

The runner Dockerfile copies only ``config.py``, ``model_lock.py``,
``embedding.py``, ``decision.py`` and ``onnx_embedding.py`` from
``apps/inference-service/src`` into this package.  The FastAPI app
(``src.main``) and ``uvicorn`` are deliberately absent.

This marker is kept in the repository so the worker can also run against a
development checkout via ``SYNAPSE_LOCAL_MODELS_DIR``.
"""
