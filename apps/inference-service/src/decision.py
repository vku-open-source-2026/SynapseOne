# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
import logging
import math
import os
import threading
import time
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field

from .config import Settings, settings
from .model_lock import MODEL_IMPORT_LOCK

logger = logging.getLogger(__name__)


class DecisionQuestion(BaseModel):
    type: str = Field(
        description="Question type: 'choice', 'noul' (yes/no), or 'score'"
    )
    instructions: str = Field(description="Instructions or criteria for the question")
    criteria: Optional[Union[Dict[str, str], List[str]]] = Field(
        default=None,
        description=(
            "Choice questions: mapping of choice key -> description. "
            "Score questions: ordered list of scale labels."
        ),
    )


class DecisionRequest(BaseModel):
    state: str = Field(
        description="Context, user query, or request payload to evaluate"
    )
    questions: Dict[str, DecisionQuestion] = Field(
        description="Dictionary of question ID -> DecisionQuestion specification"
    )


class DecisionResponse(BaseModel):
    model: str
    results: Dict[str, Any]
    duration_ms: float


class RouteRequest(BaseModel):
    input: str = Field(description="The input text or query to route")
    choices: Dict[str, str] = Field(
        description="Available destination choices: { 'choice_id': 'semantic description of choice' }"
    )
    instruction: Optional[str] = Field(
        default="Select the best destination or category for this input.",
        description="Guiding instruction for the routing decision",
    )


class RouteResponse(BaseModel):
    best_choice: str
    confidence: float
    probabilities: Dict[str, float]
    model: str
    duration_ms: float


class DecisionEngine:
    """Self-hosted Decision model runner for vllm-sr/Decision-2.0-Eos-0.8B (0.8B parameters).

    The model bundles its own inference runtime (``trust_remote_code``). It is
    FP32 on CPU (~3 GB RAM) and accepts ``device`` / ``threads`` runtime
    options. Loading and inference are serialised: one batch already saturates
    the CPU and concurrent 0.8B forwards only add memory pressure.
    """

    def __init__(self, cfg: Optional[Settings] = None):
        self.cfg = cfg or settings
        self.model_name = self.cfg.DECISION_MODEL_NAME
        self._model = None
        self._torch = None
        self._is_loaded = False
        self._load_error: Optional[str] = None
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._retry_after = 0.0

    def _threads(self) -> int:
        configured = self.cfg.DECISION_THREADS or self.cfg.INFERENCE_CPU_THREADS
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

    def load_model(self) -> bool:
        """Load the Decision 2.0 model through its bundled runtime.

        ``torch_dtype`` must not be passed: Decision 2.0 fixes numerics to FP32
        on CPU (BF16 autocast on GPU) and raises for anything else. ``device``
        and ``threads`` are passed through to the bundled runtime.
        """
        if self._is_loaded:
            return True
        if self.cfg.INFERENCE_MOCK_MODELS:
            return False
        if not self.cfg.DECISION_ENABLED:
            self._load_error = "disabled by DECISION_ENABLED"
            return False

        with self._load_lock:
            if self._is_loaded:
                return True
            if time.monotonic() < self._retry_after:
                return False

            try:
                with MODEL_IMPORT_LOCK:
                    import torch
                    from transformers import AutoModel

                device = self._determine_device()
                threads = self._threads()
                options: Dict[str, Any] = {
                    "trust_remote_code": True,
                    "device": device,
                    "local_files_only": not self.cfg.INFERENCE_MODEL_DOWNLOAD,
                }
                if threads > 0:
                    options["threads"] = threads

                try:
                    model = AutoModel.from_pretrained(self.model_name, **options)
                except TypeError:
                    # Generic HF models do not accept Decision-2 runtime options.
                    model = AutoModel.from_pretrained(
                        self.model_name, trust_remote_code=True
                    )

                if hasattr(model, "eval"):
                    model.eval()

                self._torch = torch
                self._model = model
                self._is_loaded = True
                self._load_error = None
                logger.info(
                    "decision model loaded: %s device=%s threads=%s",
                    self.model_name,
                    device,
                    threads,
                )
                return True
            except Exception as exc:  # noqa: BLE001 - keep the lexical fallback
                self._is_loaded = False
                self._model = None
                self._load_error = str(exc)
                self._retry_after = time.monotonic() + self.cfg.MODEL_LOAD_RETRY_SECONDS
                logger.warning(
                    "decision model unavailable, using deterministic fallback: %s", exc
                )
                return False

    def _fallback_system_one(
        self, state: str, questions: Dict[str, DecisionQuestion]
    ) -> Dict[str, Any]:
        """Deterministic semantic fallback for Decision-2.0-Eos when model weights are not loaded."""
        import re

        state_lower = state.lower()
        state_tokens = set(re.findall(r"\w+", state_lower))
        results: Dict[str, Any] = {}

        for q_id, q_spec in questions.items():
            q_type = q_spec.type.lower()
            if q_type == "choice" and isinstance(q_spec.criteria, dict):
                raw_scores: Dict[str, float] = {}
                for choice_key, choice_desc in q_spec.criteria.items():
                    desc_tokens = set(re.findall(r"\w+", choice_desc.lower()))
                    # Direct token overlap
                    direct_overlap = len(
                        state_tokens.intersection(desc_tokens)
                        - {"and", "or", "the", "a", "an", "is", "of", "to", "in"}
                    )

                    # Stem/prefix overlap (e.g. trigger vs triggering, workflow vs workflows)
                    stem_overlap = 0
                    for st in state_tokens:
                        if len(st) >= 4:
                            for dt in desc_tokens:
                                if len(dt) >= 4 and (
                                    st.startswith(dt[:4]) or dt.startswith(st[:4])
                                ):
                                    stem_overlap += 1

                    # Check substring presence
                    substr_bonus = 2.5 if choice_key.lower() in state_lower else 0.0
                    raw_scores[choice_key] = (
                        1.0 + direct_overlap * 2.0 + stem_overlap * 1.5 + substr_bonus
                    )

                # Softmax normalization
                max_s = max(raw_scores.values()) if raw_scores else 1.0
                exp_scores = {k: math.exp(v - max_s) for k, v in raw_scores.items()}
                total_exp = sum(exp_scores.values()) or 1.0
                probs = {k: round(v / total_exp, 4) for k, v in exp_scores.items()}

                best_choice = max(probs, key=probs.get) if probs else ""
                results[q_id] = {
                    "type": "choice",
                    "best_choice": best_choice,
                    "probabilities": probs,
                    "confidence": probs.get(best_choice, 0.0),
                }

            elif q_type in ("noul", "yes_no", "bool"):
                positive_indicators = {
                    "yes",
                    "true",
                    "has",
                    "confirmed",
                    "verified",
                    "include",
                    "with",
                }
                negative_indicators = {
                    "no",
                    "false",
                    "none",
                    "without",
                    "missing",
                    "never",
                }
                pos_hits = sum(1 for w in positive_indicators if w in state_tokens)
                neg_hits = sum(1 for w in negative_indicators if w in state_tokens)

                prob_yes = round(0.5 + (pos_hits - neg_hits) * 0.2, 2)
                prob_yes = max(0.05, min(0.95, prob_yes))
                results[q_id] = {
                    "type": "noul",
                    "answer": "yes" if prob_yes >= 0.5 else "no",
                    "probabilities": {"yes": prob_yes, "no": round(1.0 - prob_yes, 2)},
                }
            else:
                # Default score or unsupported question type
                results[q_id] = {
                    "type": q_type,
                    "score": 0.5,
                    "note": "fallback evaluation",
                }

        return results

    @staticmethod
    def _normalize_answers(results: Dict[str, Any]) -> Dict[str, Any]:
        """Keep the public API stable across the native and fallback shapes.

        Decision 2.0 returns ``choice`` (not ``best_choice``) and ``noul`` as
        P(true) (not ``answer``). Add the compatibility aliases used by the
        gateway, workflow nodes and Tier-2 capabilities.
        """
        normalized: Dict[str, Any] = {}
        for question_id, answer in results.items():
            if not isinstance(answer, dict):
                normalized[question_id] = answer
                continue

            item = dict(answer)
            kind = item.get("type")
            if kind == "choice" and item.get("best_choice") is None:
                item["best_choice"] = item.get("choice")
            elif kind == "noul":
                probability = item.get("noul")
                if isinstance(probability, (int, float)):
                    probability = max(0.0, min(1.0, float(probability)))
                    item.setdefault("answer", "yes" if probability >= 0.5 else "no")
                    item.setdefault(
                        "probabilities",
                        {"yes": probability, "no": round(1.0 - probability, 6)},
                    )
            normalized[question_id] = item

        return normalized

    def evaluate(
        self, state: str, questions: Dict[str, DecisionQuestion]
    ) -> DecisionResponse:
        t0 = time.time()

        if not self._is_loaded and not self.cfg.INFERENCE_MOCK_MODELS:
            self.load_model()

        if self._is_loaded and self._model is not None:
            try:
                # Model's native system_one interface
                # format questions dict into model's expected format
                q_dict = {
                    k: v.model_dump(exclude_none=True) for k, v in questions.items()
                }
                with self._lock:
                    if self._torch is not None:
                        with self._torch.inference_mode():
                            raw_out = self._model.system_one(
                                state=state, questions=q_dict
                            )
                    else:
                        raw_out = self._model.system_one(state=state, questions=q_dict)

                # Decision 2.0 returns {"model", "answers", "usage"}; the API
                # contract exposes the per-question answers directly.
                if isinstance(raw_out, dict) and isinstance(
                    raw_out.get("answers"), dict
                ):
                    results = raw_out["answers"]
                elif isinstance(raw_out, dict):
                    results = raw_out
                else:
                    results = {"output": raw_out}

                results = self._normalize_answers(results)

                duration = round((time.time() - t0) * 1000.0, 2)
                return DecisionResponse(
                    model=self.model_name,
                    results=results,
                    duration_ms=duration,
                )
            except Exception as e:
                self._load_error = str(e)
                # Fallback on runtime failure
                results = self._fallback_system_one(state, questions)
        else:
            results = self._fallback_system_one(state, questions)

        duration = round((time.time() - t0) * 1000.0, 2)
        return DecisionResponse(
            model=self.model_name,
            results=results,
            duration_ms=duration,
        )

    def route(
        self, input_text: str, choices: Dict[str, str], instruction: str = ""
    ) -> RouteResponse:
        """Helper to route an input text between candidate choices."""
        t0 = time.time()
        q_spec = DecisionQuestion(
            type="choice",
            instructions=instruction
            or "Select the most suitable category for the input.",
            criteria=choices,
        )
        resp = self.evaluate(state=input_text, questions={"route": q_spec})
        route_res = resp.results.get("route", {})
        probs = route_res.get("probabilities", {})

        if not probs and choices:
            # Equal uniform split
            n = len(choices)
            probs = {k: round(1.0 / n, 4) for k in choices}

        best = route_res.get("best_choice") or (
            max(probs, key=probs.get) if probs else ""
        )
        conf = probs.get(best, 0.0)

        duration = round((time.time() - t0) * 1000.0, 2)
        return RouteResponse(
            best_choice=best,
            confidence=conf,
            probabilities=probs,
            model=self.model_name,
            duration_ms=duration,
        )

    @property
    def status(self) -> Dict[str, Any]:
        return {
            "model": self.model_name,
            "architecture": "Qwen3.5-0.8B-hybrid-backbone",
            "backend": "decision2-transformers" if self._is_loaded else "fallback",
            "enabled": self.cfg.DECISION_ENABLED,
            "loaded": self._is_loaded,
            "device": self._determine_device(),
            "threads": self._threads(),
            "mock_mode": self.cfg.INFERENCE_MOCK_MODELS or not self._is_loaded,
            "error": self._load_error,
        }


# Global singleton instance
decision_engine = DecisionEngine()
