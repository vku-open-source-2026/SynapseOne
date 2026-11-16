# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Runtime tests for validation, shapes and fail-closed behaviour.

These tests do not import torch/onnx/pydantic.  Real model loading is exercised
by ``worker.py --self-test``/``--probe`` inside the model image.
"""

from __future__ import annotations

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import WorkerError  # noqa: E402
from runtime import LocalInferenceRuntime  # noqa: E402


def _cap(state="ready", *, supported=True, enabled=True, ready=None, model="model", backend="backend"):
    return {
        "name": "capability",
        "supported": supported,
        "enabled": enabled,
        "ready": (state == "ready") if ready is None else ready,
        "state": state,
        "model": model,
        "backend": backend,
        "error": None,
        "attempts": 1,
        "loadedAt": None,
        "retryAt": None,
    }


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def model_dump(self):
        return self._payload


class FakeQuestion:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeEmbedding:
    dimension = 384

    def __init__(self, vector=None, error=None):
        self.vector = [0.1] * 384 if vector is None else vector
        self.error = error

    def embed(self, texts):
        if self.error:
            raise self.error
        return _Response(
            {
                "object": "list",
                "data": [
                    {"object": "embedding", "index": index, "embedding": list(self.vector)}
                    for index, _ in enumerate(texts)
                ],
                "model": "fake-mini",
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            }
        )


class FakeDecision:
    def __init__(self, probabilities=None, error=None):
        self.probabilities = (
            {"workflow": 0.8, "inference": 0.2}
            if probabilities is None
            else probabilities
        )
        self.error = error

    def evaluate(self, state, questions):
        if self.error:
            raise self.error
        question = next(iter(questions.values()))
        if getattr(question, "type", None) == "choice":
            results = {
                "route": {
                    "type": "choice",
                    "best_choice": "workflow",
                    "probabilities": dict(self.probabilities),
                }
            }
        else:
            results = {
                "online": {
                    "type": "noul",
                    "answer": "yes",
                    "probabilities": {"yes": 1.0, "no": 0.0},
                }
            }
        return _Response({"model": "fake-decision", "results": results, "duration_ms": 1.0})


class FakeSupervisor:
    def __init__(self, capabilities=None, embedding=None, decision=None, chat=None):
        self.capabilities = capabilities or {
            "embeddings": _cap(model="fake-mini", backend="onnx"),
            "decision": _cap(model="fake-decision", backend="decision2-transformers"),
            "chat": _cap(state="unsupported", supported=False, enabled=False),
        }
        self.embedding = embedding
        self.decision = decision
        self.chat = chat
        self.retried = 0

    def snapshot(self):
        return {name: dict(value) for name, value in self.capabilities.items()}

    def maybe_retry(self):
        self.retried += 1

    def wait_until_settled(self, timeout=0.0):
        return self.snapshot()

    def _require(self, name, engine):
        capability = self.capabilities[name]
        if not capability["supported"]:
            raise WorkerError("unsupported_type", f"{name} unsupported")
        if not capability["enabled"]:
            raise WorkerError("capability_disabled", f"{name} disabled")
        if engine is None:
            raise WorkerError("model_not_ready", f"{name} not loaded", retryable=True)
        return engine

    def require_embedding(self):
        return self._require("embeddings", self.embedding)

    def require_decision(self):
        return self._require("decision", self.decision)

    def require_chat(self):
        return self._require("chat", self.chat)

    def chat_supported(self):
        return bool(self.capabilities.get("chat", {}).get("supported"))

    def decision_question_class(self):
        return FakeQuestion

    @property
    def package_directory(self):
        return "/app/local-inference/synapse_local_models"

    @property
    def package_error(self):
        return None


def _runtime(supervisor, **kwargs):
    return LocalInferenceRuntime(supervisor, **kwargs)


class HealthTests(unittest.TestCase):
    def test_health_reports_route_alias_and_no_listeners(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision())
        )
        health = runtime.health()
        self.assertTrue(health["ready"])
        self.assertEqual(health["status"], "ready")
        self.assertTrue(health["capabilities"]["route"]["ready"])
        self.assertTrue(health["capabilities"]["embeddings"]["ready"])
        self.assertEqual(health["network"]["listeners"], [])
        self.assertFalse(health["network"]["httpServer"])
        self.assertIn("generic", health["unsupportedTypes"])
        self.assertIn("chat", health["unsupportedTypes"])
        self.assertEqual(health["limits"]["maxEmbeddingInputs"], 256)

    def test_health_starting_and_failed(self):
        supervisor = FakeSupervisor(
            capabilities={
                "embeddings": _cap("ready"),
                "decision": _cap("loading", ready=False),
                "chat": _cap(state="unsupported", supported=False, enabled=False),
            }
        )
        health = _runtime(supervisor).health()
        self.assertFalse(health["ready"])
        self.assertEqual(health["status"], "starting")
        self.assertEqual(health["readyCapabilities"], ["embeddings"])

        supervisor.capabilities["decision"] = _cap("failed", ready=False)
        health = _runtime(supervisor).health()
        self.assertEqual(health["status"], "degraded")

    def test_health_calls_retry(self):
        supervisor = FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision())
        _runtime(supervisor).health()
        self.assertGreaterEqual(supervisor.retried, 1)

    def test_memory_guidance_flags_2048_for_decision(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision()),
            max_rss_mb=2048,
        )
        memory = runtime.health()["memory"]
        self.assertEqual(memory["minimumRssMb"], 4096)
        self.assertEqual(memory["recommendedRssMb"], 6144)
        self.assertIn("OOM", memory["warning"])

    def test_memory_guidance_allows_small_embedding_only(self):
        supervisor = FakeSupervisor(
            capabilities={
                "embeddings": _cap("ready"),
                "decision": _cap(state="disabled", enabled=False, ready=False),
                "chat": _cap(state="unsupported", supported=False, enabled=False),
            },
            embedding=FakeEmbedding(),
            decision=FakeDecision(),
        )
        memory = _runtime(supervisor, max_rss_mb=2048).health()["memory"]
        self.assertEqual(memory["minimumRssMb"], 1024)
        self.assertIsNone(memory["warning"])


class EmbeddingTests(unittest.TestCase):
    def test_embeddings_shape_and_alias(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision())
        )
        result = runtime.infer("embedding", {"input": ["a", "b"]})
        self.assertEqual(result["object"], "list")
        self.assertEqual(len(result["data"]), 2)
        self.assertEqual(len(result["data"][0]["embedding"]), 384)

    def test_embeddings_fail_closed_when_model_raises(self):
        runtime = _runtime(
            FakeSupervisor(
                embedding=FakeEmbedding(error=WorkerError("model_not_ready", "no model")),
                decision=FakeDecision(),
            )
        )
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer("embeddings", {"input": "x"})
        self.assertEqual(ctx.exception.code, "model_not_ready")

    def test_embeddings_reject_non_finite_vectors(self):
        vector = [0.1] * 383 + [math.nan]
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(vector=vector), decision=FakeDecision())
        )
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer("embeddings", {"input": "x"})
        self.assertEqual(ctx.exception.code, "model_error")

    def test_embeddings_dimension_mismatch_is_explicit(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision())
        )
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer("embeddings", {"input": "x", "dimensions": 128})
        self.assertEqual(ctx.exception.code, "unsupported_dimensions")

    def test_embeddings_batch_bound(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision()),
            max_embedding_inputs=2,
        )
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer("embeddings", {"input": ["a", "b", "c"]})
        self.assertEqual(ctx.exception.code, "request_too_large")


class DecisionTests(unittest.TestCase):
    def _runtime(self, decision=None):
        return _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=decision or FakeDecision())
        )

    def test_decision_shape(self):
        result = self._runtime().infer(
            "decision",
            {
                "state": "The sensor is confirmed online.",
                "questions": {"online": {"type": "noul", "instructions": "Is it online?"}},
            },
        )
        self.assertEqual(result["model"], "fake-decision")
        self.assertEqual(result["results"]["online"]["answer"], "yes")
        self.assertIn("duration_ms", result)

    def test_route_shape(self):
        result = self._runtime().infer(
            "route",
            {
                "input": "Run the queued DAG",
                "choices": {"workflow": "execute a DAG", "inference": "run a model"},
            },
        )
        self.assertEqual(result["best_choice"], "workflow")
        self.assertAlmostEqual(result["confidence"], 0.8)
        self.assertEqual(result["probabilities"]["workflow"], 0.8)

    def test_route_without_probabilities_fails(self):
        runtime = self._runtime(FakeDecision(probabilities={}))
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer(
                "route",
                {"input": "x", "choices": {"a": "a", "b": "b"}},
            )
        self.assertEqual(ctx.exception.code, "model_error")

    def test_route_choice_outside_requested_set_fails(self):
        runtime = self._runtime(FakeDecision())
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer(
                "route",
                {"input": "x", "choices": {"alpha": "a", "beta": "b"}},
            )
        self.assertEqual(ctx.exception.code, "model_error")

    def test_route_disabled(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision()),
            enable_route=False,
        )
        health = runtime.health()
        self.assertFalse(health["capabilities"]["route"]["ready"])
        self.assertEqual(health["capabilities"]["route"]["state"], "disabled")
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer("route", {"input": "x", "choices": {"a": "a"}})
        self.assertEqual(ctx.exception.code, "capability_disabled")

    def test_bad_questions_are_rejected(self):
        with self.assertRaises(WorkerError) as ctx:
            self._runtime().infer(
                "decision", {"state": "x", "questions": {"q": {"type": "noul"}}}
            )
        self.assertEqual(ctx.exception.code, "bad_request")


class UnsupportedTests(unittest.TestCase):
    def test_chat_unsupported_without_local_model(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision())
        )
        with self.assertRaises(WorkerError) as ctx:
            runtime.infer("chat", {"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(ctx.exception.code, "unsupported_type")

    def test_generic_and_unknown_types(self):
        runtime = _runtime(
            FakeSupervisor(embedding=FakeEmbedding(), decision=FakeDecision())
        )
        for kind in ("generic", "vision", "rerank"):
            with self.assertRaises(WorkerError) as ctx:
                runtime.infer(kind, {})
            self.assertEqual(ctx.exception.code, "unsupported_type")


class EnvironmentTests(unittest.TestCase):
    """Align the bridge's LOCAL_INFERENCE_* mapping with the worker."""

    def test_capability_list_limits_and_threads(self):
        from unittest.mock import patch

        from runtime import runtime_from_env

        with patch.dict(
            os.environ,
            {
                "LOCAL_INFERENCE_CAPABILITIES": "embeddings,route",
                "LOCAL_INFERENCE_MAX_BATCH": "7",
                "LOCAL_INFERENCE_MAX_TOKENS": "64",
                "LOCAL_INFERENCE_THREADS": "3",
            },
            clear=False,
        ):
            runtime = runtime_from_env()
            health = runtime.health()
        self.assertTrue(health["capabilities"]["embeddings"]["enabled"])
        self.assertTrue(health["capabilities"]["decision"]["enabled"])
        self.assertTrue(health["capabilities"]["route"]["enabled"])
        self.assertEqual(health["limits"]["maxEmbeddingInputs"], 7)
        self.assertEqual(health["limits"]["maxChatTokens"], 64)
        self.assertEqual(runtime.supervisor.threads, 3)

    def test_chat_is_unsupported_without_a_local_model(self):
        from unittest.mock import patch

        from runtime import runtime_from_env

        with patch.dict(
            os.environ,
            {
                "LOCAL_INFERENCE_CAPABILITIES": "embeddings,chat",
                "LOCAL_INFERENCE_MODEL_CHAT": "",
                "LOCAL_INFERENCE_CHAT_MODEL": "",
            },
            clear=False,
        ):
            runtime = runtime_from_env()
            health = runtime.health()
        self.assertFalse(health["capabilities"]["chat"]["supported"])
        self.assertIn("chat", health["unsupportedTypes"])

    def test_owner_model_paths_are_applied_offline(self):
        import tempfile
        from unittest.mock import patch

        from runtime import runtime_from_env

        with tempfile.TemporaryDirectory() as directory:
            onnx_dir = os.path.join(directory, "onnx")
            os.makedirs(onnx_dir)
            onnx_file = os.path.join(onnx_dir, "model.onnx")
            with open(onnx_file, "wb") as handle:
                handle.write(b"fake")
            with patch.dict(
                os.environ,
                {
                    "LOCAL_INFERENCE_CAPABILITIES": "embeddings,decision",
                    "LOCAL_INFERENCE_MODEL_EMBEDDINGS": directory,
                    "LOCAL_INFERENCE_MODEL_DECISION": directory,
                },
                clear=False,
            ):
                runtime = runtime_from_env()
        overrides = runtime.supervisor.overrides
        self.assertEqual(overrides["EMBEDDING_MODEL_NAME"], directory)
        self.assertEqual(overrides["EMBEDDING_ONNX_PATH"], onnx_file)
        self.assertEqual(overrides["DECISION_MODEL_NAME"], directory)
        self.assertFalse(overrides["INFERENCE_MOCK_MODELS"])
        self.assertFalse(overrides["INFERENCE_MODEL_DOWNLOAD"])
        self.assertEqual(overrides["DECISION_BACKEND"], "local")


    def test_ui_embedding_alias_maps_to_the_baked_canonical_repo(self):
        from unittest.mock import patch

        from runtime import runtime_from_env

        with patch.dict(
            os.environ,
            {
                "LOCAL_INFERENCE_CAPABILITIES": "embeddings",
                "LOCAL_INFERENCE_MODEL_EMBEDDINGS": "all-MiniLM-L6-v2",
            },
            clear=False,
        ):
            runtime = runtime_from_env()
        # Exact UI/backend default -> the repository id actually baked into the
        # image. A custom repo/path would stay untouched.
        self.assertEqual(
            runtime.supervisor.overrides["EMBEDDING_MODEL_NAME"],
            "sentence-transformers/all-MiniLM-L6-v2",
        )

    def test_embedding_model_env_alias_maps_to_canonical(self):
        from unittest.mock import patch

        from runtime import runtime_from_env

        with patch.dict(
            os.environ,
            {
                "LOCAL_INFERENCE_CAPABILITIES": "embeddings",
                "LOCAL_INFERENCE_MODEL_EMBEDDINGS": "",
                "EMBEDDING_MODEL_NAME": "all-MiniLM-L6-v2",
            },
            clear=False,
        ):
            runtime = runtime_from_env()
        self.assertEqual(
            runtime.supervisor.overrides["EMBEDDING_MODEL_NAME"],
            "sentence-transformers/all-MiniLM-L6-v2",
        )

    def test_custom_embedding_repo_is_preserved(self):
        from unittest.mock import patch

        from runtime import runtime_from_env

        with patch.dict(
            os.environ,
            {
                "LOCAL_INFERENCE_CAPABILITIES": "embeddings",
                "LOCAL_INFERENCE_MODEL_EMBEDDINGS": "acme/custom-minilm",
            },
            clear=False,
        ):
            runtime = runtime_from_env()
        self.assertEqual(
            runtime.supervisor.overrides["EMBEDDING_MODEL_NAME"],
            "acme/custom-minilm",
        )


class MemoryGuidanceTests(unittest.TestCase):
    def test_decision_requires_more_than_the_default_rss(self):
        # Documented guardrail: the bridge default (2048 MiB) is not enough for
        # Decision-2.0 (FP32 0.8B, ~3 GiB). Keep the guidance in the worker
        # contract so an operator cannot silently OOM at load time.
        from pathlib import Path

        readme = Path(__file__).resolve().parents[2] / "README.md"
        text = readme.read_text(encoding="utf-8")
        self.assertIn("4096", text)
        self.assertIn("6144", text)


if __name__ == "__main__":
    unittest.main()
