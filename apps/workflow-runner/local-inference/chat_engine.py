# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Optional local-only chat engine.

Chat is intentionally not advertised unless the operator points the worker at a
real local causal-LM directory.  URLs, Hub ids and any remote/provider path are
rejected: the worker never calls an HTTP inference API and never falls back to a
remote model.  Embeddings/decision do not depend on this module.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List, Optional

from errors import WorkerError

logger = logging.getLogger(__name__)

_IMPORT_LOCK = threading.Lock()
MAX_INPUT_TOKENS = 4096
MAX_NEW_TOKENS = 512


def validate_local_model_path(path: str) -> str:
    value = str(path or "").strip()
    if not value:
        raise WorkerError(
            "capability_disabled",
            "no local chat model configured (LOCAL_INFERENCE_CHAT_MODEL is empty)",
        )
    if "://" in value or value.startswith(("http:", "https:", "hf:")):
        raise WorkerError(
            "invalid_configuration",
            "LOCAL_INFERENCE_CHAT_MODEL must be a local directory; remote model "
            "URLs/ids are not supported",
        )
    resolved = os.path.abspath(os.path.expanduser(value))
    if not os.path.isdir(resolved):
        raise WorkerError(
            "invalid_configuration",
            f"local chat model directory does not exist: {resolved}",
        )
    return resolved


class LocalChatEngine:
    """Minimal transformers chat loop over a local model directory."""

    def __init__(self, model_path: str, *, threads: int = 0) -> None:
        self.model_path = validate_local_model_path(model_path)
        self.threads = max(0, int(threads or 0))
        self._model: Any = None
        self._tokenizer: Any = None
        self._torch: Any = None
        self._loaded = False
        self._error: Optional[str] = None

    def load_model(self) -> bool:
        if self._loaded:
            return True
        try:
            with _IMPORT_LOCK:
                import torch
                from transformers import AutoModelForCausalLM, AutoTokenizer

            if self.threads > 0:
                torch.set_num_threads(self.threads)
            tokenizer = AutoTokenizer.from_pretrained(
                self.model_path, local_files_only=True
            )
            model = AutoModelForCausalLM.from_pretrained(
                self.model_path, local_files_only=True
            )
            if hasattr(model, "eval"):
                model.eval()
            self._torch = torch
            self._tokenizer = tokenizer
            self._model = model
            self._loaded = True
            self._error = None
            logger.info("local chat model loaded: %s", self.model_path)
            return True
        except Exception as exc:  # noqa: BLE001 - reported through status
            self._loaded = False
            self._error = str(exc)
            logger.error("local chat model unavailable: %s", exc)
            return False

    @property
    def status(self) -> Dict[str, Any]:
        return {
            "model": self.model_path,
            "backend": "transformers-local",
            "loaded": self._loaded,
            "device": "cpu",
            "threads": self.threads,
            "mock_mode": False,
            "error": self._error,
        }

    def generate(
        self,
        messages: List[Dict[str, str]],
        *,
        max_tokens: int = 256,
        temperature: float = 0.0,
    ) -> Dict[str, Any]:
        if not self._loaded or self._model is None:
            raise WorkerError(
                "model_not_ready",
                "local chat model is not loaded",
                retryable=True,
            )
        max_new = max(1, min(int(max_tokens or 256), MAX_NEW_TOKENS))
        prompt = self._render_prompt(messages)
        tokenizer = self._tokenizer
        encoded = tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=MAX_INPUT_TOKENS,
        )
        input_ids = encoded["input_ids"]
        generate_args: Dict[str, Any] = {
            "max_new_tokens": max_new,
            "do_sample": temperature > 0,
            "pad_token_id": tokenizer.pad_token_id or tokenizer.eos_token_id,
        }
        if temperature > 0:
            generate_args["temperature"] = max(0.01, min(float(temperature), 2.0))
        with self._torch.inference_mode():
            output = self._model.generate(**encoded, **generate_args)
        new_tokens = output[0][input_ids.shape[-1] :]
        text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
        return {
            "id": "chatcmpl-local",
            "object": "chat.completion",
            "model": self.model_path,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": int(input_ids.shape[-1]),
                "completion_tokens": int(new_tokens.shape[-1]),
                "total_tokens": int(input_ids.shape[-1] + new_tokens.shape[-1]),
            },
        }

    def _render_prompt(self, messages: List[Dict[str, str]]) -> str:
        tokenizer = self._tokenizer
        if hasattr(tokenizer, "apply_chat_template"):
            try:
                return tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            except Exception:  # noqa: BLE001 - fall back to plain formatting
                pass
        return "\n".join(
            f"{str(item.get('role') or 'user')}: {str(item.get('content') or '')}"
            for item in messages
        ) + "\nassistant:"
