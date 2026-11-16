# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Fail-closed wrapper tests (no real model imports)."""

from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import WorkerError  # noqa: E402
from models_loader import (  # noqa: E402
    make_strict_decision,
    make_strict_embedding,
    resolve_models_dir,
)


class FakeEmbeddingBase:
    def __init__(self, cfg=None):
        self.cfg = cfg

    def embed(self, texts):
        return self._generate_mock_embedding(texts[0])

    def _generate_mock_embedding(self, text, dim=384):
        return [0.0] * dim


class FakeDecisionBase:
    def __init__(self, cfg=None):
        self.cfg = cfg

    def _uses_openrouter(self):
        return True

    def evaluate(self, state, questions):
        return self._fallback_system_one(state, questions)

    def _fallback_system_one(self, state, questions):
        return {"fake": True}


def _package(embedding_base=None, decision_base=None):
    return types.SimpleNamespace(
        embedding=types.SimpleNamespace(EmbeddingEngine=embedding_base or FakeEmbeddingBase),
        decision=types.SimpleNamespace(DecisionEngine=decision_base or FakeDecisionBase),
    )


class StrictWrapperTests(unittest.TestCase):
    def test_embedding_mock_fallback_raises(self):
        engine = make_strict_embedding(_package(), None)
        with self.assertRaises(WorkerError) as ctx:
            engine.embed(["hello"])
        self.assertEqual(ctx.exception.code, "model_not_ready")
        self.assertTrue(ctx.exception.retryable)

    def test_decision_fallback_raises(self):
        engine = make_strict_decision(_package(), None)
        self.assertFalse(engine._uses_openrouter())
        with self.assertRaises(WorkerError) as ctx:
            engine.evaluate("state", {})
        self.assertEqual(ctx.exception.code, "model_not_ready")

    def test_resolve_models_dir_dev_fallback_has_modules(self):
        directory = resolve_models_dir()
        self.assertTrue(os.path.isfile(os.path.join(directory, "embedding.py")))
        self.assertTrue(os.path.isfile(os.path.join(directory, "decision.py")))


if __name__ == "__main__":
    unittest.main()
