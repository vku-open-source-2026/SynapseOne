# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
import asyncio
import json
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field

from .config import Settings, settings


class ChatMessage(BaseModel):
    role: str
    # Assistant tool-call turns have no content; tool results are also allowed
    # to be structured. Keep this permissive and forward exactly what came in.
    content: Optional[Any] = None
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    messages: List[ChatMessage]
    model: Optional[str] = None
    temperature: Optional[float] = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=1024, ge=1, le=32768)
    stream: Optional[bool] = False
    top_p: Optional[float] = Field(default=1.0, ge=0.0, le=1.0)
    # OpenAI-compatible tool calling: the workflow AI Agent depends on these
    # fields surviving the inference hop.
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Any] = None
    parallel_tool_calls: Optional[bool] = None
    response_format: Optional[Dict[str, Any]] = None


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: Optional[str] = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: Optional[Dict[str, int]] = None


class LlmError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _is_retryable(status_code: int) -> bool:
    return status_code >= 500 or status_code in (429, 408)


def _should_try_fallback(status_code: int) -> bool:
    # A different upstream model can recover rate limits, outages and model
    # deprecation, but not a malformed request or bad credentials.
    return _is_retryable(status_code) or status_code in (404, 410)


def _model_candidates(req: ChatCompletionRequest, config: Settings) -> List[str]:
    """Primary model first, then the configured fallback (deduplicated)."""
    primary = req.model or config.OPENROUTER_MODEL
    candidates = [primary]
    fallback = config.OPENROUTER_FALLBACK_MODEL
    if fallback and fallback not in candidates:
        candidates.append(fallback)
    return candidates


def _tool_fields(req: ChatCompletionRequest) -> Dict[str, Any]:
    """Only forward optional fields the caller actually supplied."""
    out: Dict[str, Any] = {}
    if req.tools is not None:
        out["tools"] = req.tools
    if req.tool_choice is not None:
        out["tool_choice"] = req.tool_choice
    if req.parallel_tool_calls is not None:
        out["parallel_tool_calls"] = req.parallel_tool_calls
    if req.response_format is not None:
        out["response_format"] = req.response_format
    return out


def _payload(req: ChatCompletionRequest, model: str, *, stream: bool) -> Dict[str, Any]:
    return {
        "model": model,
        "messages": [m.model_dump(exclude_none=True) for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "top_p": req.top_p,
        "stream": stream,
        **_tool_fields(req),
    }


def _headers(config: Settings) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://synapseone.dev",
        "X-Title": "SynapseOne Inference Engine",
    }


async def call_chat_completion(
    req: ChatCompletionRequest,
    cfg: Optional[Settings] = None,
) -> Dict[str, Any]:
    """Execute non-streaming chat completion, retrying then falling back."""
    config = cfg or settings
    if not config.OPENROUTER_API_KEY:
        raise LlmError(503, "OPENROUTER_API_KEY is not configured on the server")

    url = f"{config.OPENROUTER_BASE_URL}/chat/completions"
    timeout_seconds = config.OPENROUTER_TIMEOUT_MS / 1000.0
    attempts = max(1, config.OPENROUTER_RETRIES + 1)
    last_error: Optional[LlmError] = None

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        for target_model in _model_candidates(req, config):
            for attempt in range(attempts):
                try:
                    resp = await client.post(
                        url,
                        headers=_headers(config),
                        json=_payload(req, target_model, stream=False),
                    )
                    if resp.status_code == 200:
                        return resp.json()

                    body_text = resp.text[:1000]
                    last_error = LlmError(
                        resp.status_code,
                        f"OpenRouter upstream returned status {resp.status_code} "
                        f"for {target_model}: {body_text}",
                    )
                    if attempt + 1 < attempts and _is_retryable(resp.status_code):
                        await asyncio.sleep(0.5 * (2**attempt))
                        continue
                    break
                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    last_error = LlmError(
                        504,
                        f"OpenRouter upstream connection failed for "
                        f"{target_model}: {exc}",
                    )
                    if attempt + 1 < attempts:
                        await asyncio.sleep(0.5 * (2**attempt))
                        continue
                    break

            if last_error and not _should_try_fallback(last_error.status_code):
                break

    raise last_error or LlmError(500, "Unknown LLM upstream failure")


async def stream_chat_completion(
    req: ChatCompletionRequest,
    cfg: Optional[Settings] = None,
) -> AsyncGenerator[str, None]:
    """Stream chat completion tokens, falling back before the first token."""
    config = cfg or settings
    if not config.OPENROUTER_API_KEY:
        error_chunk = {
            "error": {
                "message": "OPENROUTER_API_KEY is not configured on the server",
                "type": "server_error",
                "code": 503,
            }
        }
        yield f"data: {json.dumps(error_chunk)}\n\n"
        yield "data: [DONE]\n\n"
        return

    url = f"{config.OPENROUTER_BASE_URL}/chat/completions"
    timeout_seconds = config.OPENROUTER_TIMEOUT_MS / 1000.0
    last_error: Optional[Dict[str, Any]] = None

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        for target_model in _model_candidates(req, config):
            try:
                async with client.stream(
                    "POST",
                    url,
                    headers=_headers(config),
                    json=_payload(req, target_model, stream=True),
                ) as response:
                    if response.status_code != 200:
                        err_body = await response.aread()
                        err_msg = err_body.decode("utf-8", errors="replace")[:1000]
                        last_error = {
                            "message": f"Upstream error {response.status_code} "
                            f"for {target_model}: {err_msg}",
                            "code": response.status_code,
                        }
                        if _should_try_fallback(response.status_code):
                            continue
                        yield f"data: {json.dumps({'error': last_error})}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        if line.startswith("data:"):
                            yield f"{line}\n\n"
                        else:
                            yield f"data: {line}\n\n"
                    return
            except Exception as exc:  # noqa: BLE001 - try the fallback model
                last_error = {
                    "message": f"Streaming failed for {target_model}: {exc}",
                    "code": 500,
                }
                continue

    yield f"data: {json.dumps({'error': last_error or {'message': 'Streaming failed', 'code': 500}})}\n\n"
    yield "data: [DONE]\n\n"
