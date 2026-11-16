#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Self-contained local inference worker.

The Node runner starts this persistent process and exchanges JSONL frames over
stdin/stdout.  Models are loaded in-process; there is no HTTP server, no
provider key and no remote model fallback.  Logs are written to stderr only.

Usage::

    python3 /app/local-inference/worker.py                 # protocol mode
    python3 /app/local-inference/worker.py --self-test     # load + health JSON
    python3 /app/local-inference/worker.py --probe         # real model probe
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from typing import Any, Dict

# Make sibling modules importable when the worker is launched by absolute path.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _configure_offline_environment() -> None:
    """Guarantee the worker never downloads models or calls a model API."""
    defaults = {
        "PYTHONUNBUFFERED": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "INFERENCE_MODEL_DOWNLOAD": "false",
        "INFERENCE_MOCK_MODELS": "false",
        "INFERENCE_DEVICE": "cpu",
        "DECISION_BACKEND": "local",
    }
    for key, value in defaults.items():
        os.environ.setdefault(key, value)


def _configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Keep third-party chatter on stderr and out of the response stream.
    for name in ("httpx", "huggingface_hub", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _parse_args(argv: Any = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="SynapseOne local inference worker (JSONL stdin/stdout)"
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="load enabled models, print health JSON and exit (non-zero when not ready)",
    )
    parser.add_argument(
        "--probe",
        action="store_true",
        help="run real embedding + route inference and print a JSON summary",
    )
    parser.add_argument(
        "--health-json",
        action="store_true",
        help="alias for --self-test",
    )
    parser.add_argument(
        "--wait-seconds",
        type=float,
        default=300.0,
        help="maximum time to wait for model loading in --self-test/--probe (default 300)",
    )
    parser.add_argument("--verbose", action="store_true", help="debug logging")
    parser.add_argument(
        "--version", action="store_true", help="print the worker version and exit"
    )
    return parser.parse_args(argv)


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _run_probe(runtime: Any) -> Dict[str, Any]:
    """Exercise the real models; never fabricate a success."""
    result: Dict[str, Any] = {"probe": True}
    try:
        response = runtime.infer(
            "embeddings", {"input": "SynapseOne local inference worker probe"}
        )
        vector = response["data"][0]["embedding"]  # type: ignore[index]
        norm = sum(float(x) * float(x) for x in vector) ** 0.5
        result["embeddings"] = {
            "ok": True,
            "model": response.get("model"),
            "dimensions": len(vector),
            "norm": round(norm, 6),
            "sample": [round(float(x), 6) for x in vector[:4]],
        }
    except Exception as exc:  # noqa: BLE001 - reported, not hidden
        result["embeddings"] = {"ok": False, "error": str(exc)}

    decision = runtime.supervisor.snapshot().get("decision", {})
    if not decision.get("supported") or not decision.get("enabled"):
        result["route"] = {"ok": False, "skipped": "decision capability disabled"}
    else:
        try:
            response = runtime.infer(
                "route",
                {
                    "input": "Run a queued workflow DAG and execute its nodes",
                    "choices": {
                        "workflow": "execute a workflow DAG on the queue",
                        "embeddings": "compute text embedding vectors",
                    },
                    "instruction": "Pick the best lane for this request.",
                },
            )
            result["route"] = {
                "ok": True,
                "model": response.get("model"),
                "best_choice": response.get("best_choice"),
                "confidence": response.get("confidence"),
                "probabilities": response.get("probabilities"),
                "durationMs": response.get("duration_ms"),
            }
        except Exception as exc:  # noqa: BLE001 - reported, not hidden
            result["route"] = {"ok": False, "error": str(exc)}
    return result


def main(argv: Any = None) -> int:
    args = _parse_args(argv)
    _configure_offline_environment()
    _configure_logging(args.verbose)

    # Import after the offline env is in place: config.py reads env at import.
    from protocol import JsonlServer, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_RESPONSE_BYTES
    from runtime import WORKER_VERSION, runtime_from_env

    if args.version:
        print(WORKER_VERSION)
        return 0

    runtime = runtime_from_env()
    if args.self_test or args.health_json or args.probe:
        runtime.supervisor.start(background=True)
        runtime.supervisor.wait_until_settled(float(args.wait_seconds))
        health = runtime.health({"waitMs": 0})
        if args.probe:
            payload = {"health": health, "probe": _run_probe(runtime)}
            print(_json_dump(payload))
            probe_ok = all(
                item.get("ok")
                for item in payload["probe"].values()
                if isinstance(item, dict)
            )
            return 0 if health.get("ready") and probe_ok else 1
        print(_json_dump(health))
        return 0 if health.get("ready") else 1

    max_line = int(os.environ.get("LOCAL_INFERENCE_MAX_LINE_BYTES", DEFAULT_MAX_LINE_BYTES))
    max_response = int(
        os.environ.get("LOCAL_INFERENCE_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES)
    )

    server: JsonlServer

    def handler(record: Dict[str, Any]) -> Any:
        op = str(record.get("op") or "").strip().lower()
        if op == "shutdown":
            server.request_stop()
            return {"stopping": True}
        return runtime.handle(record)

    server = JsonlServer(
        handler, max_line_bytes=max_line, max_response_bytes=max_response
    )
    runtime.supervisor.start(background=True)
    logging.getLogger(__name__).info(
        "local inference worker %s ready for JSONL on stdin (pid=%s)",
        WORKER_VERSION,
        os.getpid(),
    )
    try:
        exit_code = server.serve()
    finally:
        runtime.supervisor.shutdown()
    logging.getLogger(__name__).info(
        "local inference worker stopped requests=%s errors=%s",
        server.requests,
        server.errors,
    )
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
