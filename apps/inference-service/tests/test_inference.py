# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
import math
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Ensure src is on python path for direct imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.config import settings
from src.decision import decision_engine
from src.main import app

client = TestClient(app)

TEST_SECRET = "test-internal-secret-999"


@pytest.fixture(autouse=True)
def _local_decision_defaults(monkeypatch):
    """Keep unit tests independent from the deployment .env (dotenv loads it)."""
    monkeypatch.setattr(settings, "DECISION_BACKEND", "local")
    monkeypatch.setattr(
        settings, "DECISION_MODEL_NAME", "vllm-sr/Decision-2.0-Eos-0.8B"
    )
    monkeypatch.setattr(
        decision_engine, "model_name", "vllm-sr/Decision-2.0-Eos-0.8B"
    )
    monkeypatch.setattr(decision_engine, "_is_loaded", False)
    monkeypatch.setattr(decision_engine, "_model", None)
    monkeypatch.setattr(decision_engine, "_load_error", None)


def auth_headers():
    secret = settings.SYNAPSEONE_INTERNAL_SECRET or TEST_SECRET
    return {"x-synapseone-internal": secret, "Content-Type": "application/json"}


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] in ("ok", "degraded")
    assert data["service"] == "inference"
    assert "models" in data
    assert data["models"]["decision"] == "vllm-sr/Decision-2.0-Eos-0.8B"
    assert "sentence-transformers" in data["models"]["embedding"]
    assert data["components"]["embedding"]["backend"] in ("mock", "onnx", "torch")
    assert "time" in data


def test_internal_secret_auth():
    with patch.object(settings, "SYNAPSEONE_INTERNAL_SECRET", "super_secret_test_123"):
        # /health should still be public
        res_health = client.get("/health")
        assert res_health.status_code == 200

        # /v1/* without header -> 401
        res_no_auth = client.post("/v1/embeddings", json={"input": "hello"})
        assert res_no_auth.status_code == 401
        assert res_no_auth.json()["error"] == "unauthorized"

        # /v1/* with invalid header -> 401
        res_bad_auth = client.post(
            "/v1/embeddings",
            json={"input": "hello"},
            headers={"x-synapseone-internal": "wrong_secret"},
        )
        assert res_bad_auth.status_code == 401

        # /v1/* with valid header -> 200
        res_ok = client.post(
            "/v1/embeddings",
            json={"input": "hello"},
            headers={"x-synapseone-internal": "super_secret_test_123"},
        )
        assert res_ok.status_code == 200


def test_embeddings_single_and_batch():
    # 1. Single text
    res = client.post(
        "/v1/embeddings", json={"input": "Test embedding"}, headers=auth_headers()
    )
    assert res.status_code == 200
    body = res.json()
    assert body["object"] == "list"
    assert len(body["data"]) == 1
    emb0 = body["data"][0]["embedding"]
    assert len(emb0) == 384
    # Check L2 norm is ~1.0
    norm = math.sqrt(sum(x * x for x in emb0))
    assert abs(norm - 1.0) < 0.01

    # 2. Batch input
    res_batch = client.post(
        "/v1/embeddings",
        json={"input": ["First text", "Second text", "Third text"]},
        headers=auth_headers(),
    )
    assert res_batch.status_code == 200
    batch_body = res_batch.json()
    assert len(batch_body["data"]) == 3
    for idx, item in enumerate(batch_body["data"]):
        assert item["index"] == idx
        assert len(item["embedding"]) == 384


def test_decision_system_one():
    payload = {
        "state": "The order arrived damaged yesterday. The customer has a receipt and asks for a replacement today.",
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Which team should handle this request?",
                "criteria": {
                    "returns": "Refunds, replacements and damaged deliveries",
                    "billing": "Payments, invoices and charges",
                    "technical": "Product setup and faults",
                },
            },
            "has_receipt": {
                "type": "noul",
                "instructions": "Does the customer have a receipt?",
            },
        },
    }

    res = client.post("/v1/decision", json=payload, headers=auth_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["model"] == "vllm-sr/Decision-2.0-Eos-0.8B"
    assert "route" in data["results"]
    assert "has_receipt" in data["results"]
    # Check route question
    route_res = data["results"]["route"]
    assert route_res["best_choice"] == "returns"
    assert "returns" in route_res["probabilities"]
    # Probabilities should sum to approximately 1.0
    total_p = sum(route_res["probabilities"].values())
    assert abs(total_p - 1.0) < 0.05

    # Check noul question
    receipt_res = data["results"]["has_receipt"]
    assert receipt_res["answer"] == "yes"


def test_decision_route_helper():
    payload = {
        "input": "Where can I configure webhook nodes and trigger executions?",
        "instruction": "Route to the best service module.",
        "choices": {
            "workflow": "Creating, automating, and triggering DAG workflows",
            "iam": "User roles, permissions, and session tokens",
            "billing": "Invoices, pricing tiers, and credit cards",
        },
    }
    res = client.post("/v1/decision/route", json=payload, headers=auth_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["best_choice"] == "workflow"
    assert data["confidence"] > 0.4
    assert "workflow" in data["probabilities"]
    assert "iam" in data["probabilities"]


def test_chat_completions_missing_key():
    with patch.object(settings, "OPENROUTER_API_KEY", ""):
        res = client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Hello"}],
            },
            headers=auth_headers(),
        )
        assert res.status_code == 503
        assert "OPENROUTER_API_KEY" in res.json()["message"]


@pytest.mark.asyncio
async def test_chat_completions_mocked():
    mock_resp = {
        "id": "gen-12345",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "liquid/lfm-2.5-2.6b:free",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "I am SynapseOne AI."},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18},
    }

    with patch.object(settings, "OPENROUTER_API_KEY", "mock_key"):
        with patch(
            "src.main.call_chat_completion", new=AsyncMock(return_value=mock_resp)
        ):
            res = client.post(
                "/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": "Who are you?"}],
                },
                headers=auth_headers(),
            )
            assert res.status_code == 200
            data = res.json()
            assert data["id"] == "gen-12345"
            assert data["choices"][0]["message"]["content"] == "I am SynapseOne AI."


def test_chat_completions_stream_sse():
    """stream=true must return an SSE event stream, not a buffered JSON body."""

    async def fake_stream(req, cfg=None):
        yield 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
        yield 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        yield "data: [DONE]\n\n"

    with patch.object(settings, "OPENROUTER_API_KEY", "mock_key"):
        with patch("src.main.stream_chat_completion", new=fake_stream):
            with client.stream(
                "POST",
                "/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": True,
                },
                headers=auth_headers(),
            ) as res:
                assert res.status_code == 200
                assert res.headers["content-type"].startswith("text/event-stream")
                text = "".join(res.iter_text())
    assert 'data: {"choices":[{"delta":{"content":"Hel"}}]}' in text
    assert text.strip().endswith("data: [DONE]")


def test_chat_completions_stream_without_key_emits_error_frame():
    with patch.object(settings, "OPENROUTER_API_KEY", ""):
        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
            headers=auth_headers(),
        ) as res:
            # SSE always opens with 200; the failure arrives as an error frame.
            assert res.status_code == 200
            text = "".join(res.iter_text())
    assert "OPENROUTER_API_KEY" in text
    assert "data: [DONE]" in text


def test_inference_health_reports_components():
    res = client.get("/v1/inference/health", headers=auth_headers())
    assert res.status_code == 200
    body = res.json()
    assert body["components"]["embedding"]["dimension"] == 384
    assert body["components"]["embedding"]["backend"] in ("mock", "onnx", "torch")
    assert "loaded" in body["components"]["decision"]


def test_decision_uses_native_answers_mapping():
    """The Decision 2.0 runtime returns {"answers": ...} with native keys."""
    from src.decision import DecisionEngine, DecisionQuestion

    class FakeDecisionModel:
        def system_one(self, *, state, questions):
            return {
                "model": "fake",
                "answers": {
                    "route": {
                        "type": "choice",
                        "choice": "returns",
                        "probabilities": {"returns": 0.99, "billing": 0.01},
                        "confidence": 0.9,
                    },
                    "receipt": {"type": "noul", "noul": 0.9989},
                    "urgency": {
                        "type": "score",
                        "score": 1.65,
                        "probabilities": {"0": 0.1, "1": 0.2, "2": 0.7},
                        "legend": {"0": "Routine", "1": "Soon", "2": "Today"},
                        "confidence": 0.35,
                    },
                },
                "usage": {},
            }

    engine = DecisionEngine()
    engine._model = FakeDecisionModel()
    engine._is_loaded = True
    engine._torch = None

    response = engine.evaluate(
        state="damaged order",
        questions={
            "route": DecisionQuestion(
                type="choice",
                instructions="Which team?",
                criteria={"returns": "refunds", "billing": "invoices"},
            ),
            "receipt": DecisionQuestion(
                type="noul", instructions="Does the customer have a receipt?"
            ),
            "urgency": DecisionQuestion(
                type="score",
                instructions="How urgent?",
                criteria=["Routine", "Soon", "Today"],
            ),
        },
    )
    assert response.results["route"]["best_choice"] == "returns"
    assert response.results["route"]["choice"] == "returns"
    assert response.results["receipt"]["answer"] == "yes"
    assert response.results["receipt"]["probabilities"]["no"] < 0.01
    assert response.results["urgency"]["score"] == 1.65
    assert response.results["urgency"]["legend"]["2"] == "Today"
    assert "answers" not in response.results


def test_openrouter_decisions_url_derivation(monkeypatch):
    from src.decision import DecisionEngine

    monkeypatch.setattr(settings, "DECISION_BACKEND", "openrouter")
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "mock_key")
    engine = DecisionEngine()

    monkeypatch.setattr(
        settings, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
    )
    monkeypatch.setattr(settings, "OPENROUTER_DECISIONS_URL", "")
    assert (
        engine._openrouter_url() == "https://openrouter.ai/api/alpha/decisions"
    )

    monkeypatch.setattr(
        settings, "OPENROUTER_DECISIONS_URL", "https://example.test/decisions"
    )
    assert engine._openrouter_url() == "https://example.test/decisions"


def test_decision_openrouter_backend(monkeypatch):
    """DECISION_BACKEND=openrouter skips the local model and normalises answers."""
    from src.decision import DecisionEngine, DecisionQuestion

    monkeypatch.setattr(settings, "DECISION_BACKEND", "openrouter")
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "mock_key")
    engine = DecisionEngine()
    monkeypatch.setattr(
        engine,
        "_evaluate_openrouter",
        lambda state, questions: {
            "route": {
                "type": "choice",
                "choice": "billing",
                "probabilities": {"billing": 0.99, "tech": 0.01},
                "confidence": 0.98,
            }
        },
    )

    response = engine.evaluate(
        state="The customer wants a refund",
        questions={
            "route": DecisionQuestion(
                type="choice",
                instructions="Pick the team",
                criteria={"billing": "refunds", "tech": "faults"},
            )
        },
    )

    assert engine._is_loaded is False
    assert response.model == settings.DECISION_MODEL_NAME
    assert response.results["route"]["best_choice"] == "billing"
    assert response.results["route"]["choice"] == "billing"
    assert response.results["route"]["probabilities"]["billing"] == 0.99
    assert engine.status["backend"] == "openrouter"
    assert engine.status["loaded"] is True


def test_llm_model_candidates_use_fallback():
    from src.config import Settings
    from src.llm import ChatCompletionRequest, ChatMessage, _model_candidates

    cfg = Settings()
    cfg.OPENROUTER_MODEL = "primary/model"
    cfg.OPENROUTER_FALLBACK_MODEL = "fallback/model"

    default_req = ChatCompletionRequest(
        messages=[ChatMessage(role="user", content="hi")]
    )
    assert _model_candidates(default_req, cfg) == ["primary/model", "fallback/model"]

    explicit_req = ChatCompletionRequest(
        model="explicit/model", messages=[ChatMessage(role="user", content="hi")]
    )
    assert _model_candidates(explicit_req, cfg) == [
        "explicit/model",
        "fallback/model",
    ]

    cfg.OPENROUTER_FALLBACK_MODEL = ""
    assert _model_candidates(default_req, cfg) == ["primary/model"]


def test_onnx_candidates_prefer_int8(monkeypatch):
    pytest.importorskip("numpy")
    from src import onnx_embedding

    monkeypatch.setattr(onnx_embedding.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(onnx_embedding, "cpu_flags", lambda: {"avx2", "avx512_vnni"})
    candidates = onnx_embedding.candidate_onnx_files()
    assert candidates[0] == "onnx/model_qint8_avx512_vnni.onnx"
    assert candidates[-1] == "onnx/model.onnx"

    monkeypatch.setattr(onnx_embedding, "cpu_flags", lambda: set())
    assert onnx_embedding.candidate_onnx_files() == ["onnx/model.onnx"]


@pytest.mark.asyncio
async def test_chat_reports_token_usage_to_iam():
    """#26: prompt/completion tokens are metered through IAM usage ingest."""
    mock_resp = {
        "id": "gen-1",
        "object": "chat.completion",
        "created": 1,
        "model": "vendor/test-model",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hi"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 7, "completion_tokens": 11, "total_tokens": 18},
    }
    reporter = AsyncMock()
    with patch.object(settings, "OPENROUTER_API_KEY", "mock_key"):
        with patch(
            "src.main.call_chat_completion", new=AsyncMock(return_value=mock_resp)
        ):
            with patch("src.main.report_usage", new=reporter):
                res = client.post(
                    "/v1/chat/completions",
                    json={"messages": [{"role": "user", "content": "hello"}]},
                    headers={
                        **auth_headers(),
                        "x-synapseone-org": "11111111-1111-4111-8111-111111111111",
                    },
                )
    assert res.status_code == 200
    reporter.assert_awaited_once()
    kwargs = reporter.await_args.kwargs
    assert kwargs["prompt_tokens"] == 7
    assert kwargs["completion_tokens"] == 11
    assert kwargs["total_tokens"] == 18
    assert kwargs["model"] == "vendor/test-model"
