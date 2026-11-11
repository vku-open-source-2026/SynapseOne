# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .config import settings
from .decision import DecisionRequest, RouteRequest, decision_engine
from .embedding import EmbeddingRequest, embedding_engine
from .llm import (
    ChatCompletionRequest,
    LlmError,
    call_chat_completion,
    stream_chat_completion,
)
from .usage import Timer, report_usage

VERSION = "0.7.0"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Warm the embedding backend without delaying the socket bind.

    The ONNX graph is small enough to load in about a second, but a cold HF
    download can take longer. Doing it on a daemon thread keeps /health and the
    LLM proxy responsive while the model becomes ready.
    """
    if (
        settings.INFERENCE_WARMUP
        and not settings.INFERENCE_MOCK_MODELS
        and settings.EMBEDDING_BACKEND != "mock"
    ):
        threading.Thread(
            target=embedding_engine.load_model,
            name="embedding-warmup",
            daemon=True,
        ).start()
    if (
        settings.DECISION_WARMUP
        and settings.DECISION_ENABLED
        and not settings.INFERENCE_MOCK_MODELS
    ):
        threading.Thread(
            target=decision_engine.load_model,
            name="decision-warmup",
            daemon=True,
        ).start()
    yield


app = FastAPI(
    title="Synapse Inference Engine",
    description="Multi-model inference microservice (OpenRouter LLM + Local Embedding + Decision-2.0-Eos-0.8B)",
    version=VERSION,
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

# CORS configuration: explicit allowlist in production (never wildcard), the
# permissive default is dev/test only.
_cors_origins = settings.cors_origins
if not _cors_origins and settings.is_production:
    raise RuntimeError(
        "[inference] CORS_ORIGIN must be set in production (wildcard CORS is not allowed)."
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins or ["*"],
    allow_credentials=bool(_cors_origins),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=[
        "authorization",
        "content-type",
        "x-api-key",
        "x-synapseone-internal",
        "x-request-id",
    ],
)


@app.middleware("http")
async def security_and_telemetry_middleware(request: Request, call_next):
    # 1. Propagate or generate X-Request-ID
    req_id = request.headers.get("x-request-id")
    if not req_id:
        req_id = f"{int(time.time() * 1000):x}-{secrets.token_hex(4)}"

    # 2. Defense-in-depth: check SYNAPSEONE_INTERNAL_SECRET on /v1/*
    internal_secret = settings.SYNAPSEONE_INTERNAL_SECRET
    if request.url.path.startswith("/v1/"):
        if internal_secret:
            incoming_secret = request.headers.get("x-synapseone-internal", "")
            if not secrets.compare_digest(incoming_secret, internal_secret):
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={
                        "error": "unauthorized",
                        "message": "Missing or invalid internal credential",
                    },
                    headers={"x-request-id": req_id},
                )
        elif settings.is_production:
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={
                    "error": "misconfigured",
                    "message": "internal secret required in production",
                },
                headers={"x-request-id": req_id},
            )

    response: Response = await call_next(request)

    # 3. Security headers
    response.headers["x-request-id"] = req_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"

    return response


@app.get("/health")
@app.get("/v1/inference/health")
async def health():
    """Health check endpoint reporting readiness of inference subsystems."""
    now_iso = datetime.now(timezone.utc).isoformat()
    embedding_status = embedding_engine.status
    decision_status = decision_engine.status
    # Explicit mock mode is a dev/test choice; an unexpected failure to load a
    # real model is reported as degraded instead of a misleading "ok".
    decision_failed = (
        settings.DECISION_ENABLED
        and not decision_status.get("loaded")
        and bool(decision_status.get("error"))
    )
    degraded = (
        bool(embedding_status.get("mock_mode")) and not settings.INFERENCE_MOCK_MODELS
    ) or decision_failed
    return {
        "status": "degraded" if degraded else "ok",
        "degraded": degraded,
        "service": "inference",
        "version": VERSION,
        "models": {
            "llm": settings.OPENROUTER_MODEL,
            "llm_fallback": settings.OPENROUTER_FALLBACK_MODEL,
            "embedding": settings.EMBEDDING_MODEL_NAME,
            "decision": settings.DECISION_MODEL_NAME,
        },
        "components": {
            "llm": {
                "provider": "openrouter",
                "configured": bool(settings.OPENROUTER_API_KEY),
                "base_url": settings.OPENROUTER_BASE_URL,
                "fallback_model": settings.OPENROUTER_FALLBACK_MODEL,
            },
            "embedding": embedding_status,
            "decision": decision_status,
        },
        "time": now_iso,
    }


@app.post("/v1/chat/completions")
@app.post("/v1/inference/chat/completions")
async def chat_completions(req: ChatCompletionRequest, request: Request):
    """OpenAI-compatible LLM Chat Completions endpoint (proxied to OpenRouter)."""
    if req.stream:
        return StreamingResponse(
            stream_chat_completion(req),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    timer = Timer()
    try:
        data = await call_chat_completion(req)
        usage = data.get("usage") if isinstance(data, dict) else None
        await report_usage(
            request,
            path="/v1/inference/chat/completions",
            status_code=200,
            duration_ms=timer.ms(),
            model=data.get("model") if isinstance(data, dict) else req.model,
            prompt_tokens=int((usage or {}).get("prompt_tokens") or 0),
            completion_tokens=int((usage or {}).get("completion_tokens") or 0),
            total_tokens=int((usage or {}).get("total_tokens") or 0),
        )
        return data
    except LlmError as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"error": "llm_error", "message": e.message},
        )
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "internal_error", "message": str(e)},
        )


@app.post("/v1/embeddings")
@app.post("/v1/inference/embeddings")
async def create_embeddings(req: EmbeddingRequest):
    """OpenAI-compatible embeddings endpoint using self-hosted lightweight embedding model."""
    try:
        resp = embedding_engine.embed(inputs=req.input, model_override=req.model)
        return resp.model_dump()
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "embedding_error", "message": str(e)},
        )


@app.post("/v1/decision")
@app.post("/v1/inference/decision")
async def evaluate_decision(req: DecisionRequest):
    """Run structured question evaluation using self-hosted Decision-2.0-Eos-0.8B (system_one)."""
    try:
        resp = decision_engine.evaluate(state=req.state, questions=req.questions)
        return resp.model_dump()
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "decision_error", "message": str(e)},
        )


@app.post("/v1/decision/route")
@app.post("/v1/inference/decision/route")
async def route_decision(req: RouteRequest):
    """Workflow-friendly semantic router: pick the best branch among given candidates."""
    try:
        resp = decision_engine.route(
            input_text=req.input,
            choices=req.choices,
            instruction=req.instruction or "",
        )
        return resp.model_dump()
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "routing_error", "message": str(e)},
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
