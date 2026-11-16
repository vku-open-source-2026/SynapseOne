# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Shared lock for lazy third-party imports.

``transformers`` and ``torch`` are imported lazily by both the embedding and
decision backends. Importing them from two warmup/request threads at once can
observe a partially initialised ``transformers`` module and raise
``ImportError: cannot import name 'AutoModel'``. Only the imports need to be
serialised; downloads and weight loading can proceed in parallel.
"""

import threading

MODEL_IMPORT_LOCK = threading.Lock()
