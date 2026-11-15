# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Line-delimited JSON protocol for the local inference worker.

Contract (stable, version 1)::

    stdin   {"id": "...", "op": "health"|"infer"|"shutdown", "type": "...", "request": {...}}
    stdout  {"id": "...", "ok": true,  "result": {...}}
    stdout  {"id": "...", "ok": false, "error": {"code": "...", "message": "...", "retryable": false}}

One request produces exactly one response, in request order.  stdout is reserved
for protocol frames; every log line goes to stderr.  Lines and responses are
bounded so a malformed caller cannot make the worker exhaust memory.
"""

from __future__ import annotations

import json
import signal
import sys
import threading
from typing import Any, Callable, Dict, Optional, Tuple

from errors import WorkerError

DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class JsonlServer:
    """Serial JSONL request/response loop.

    ``handler`` receives the decoded request object and returns the ``result``
    payload, or raises :class:`WorkerError`.  The loop is deliberately
    single-threaded: model evaluation is serialized by design.
    """

    def __init__(
        self,
        handler: Callable[[Dict[str, Any]], Any],
        *,
        stdin: Any = None,
        stdout: Any = None,
        max_line_bytes: int = DEFAULT_MAX_LINE_BYTES,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ) -> None:
        self.handler = handler
        self.stdin = stdin or sys.stdin
        self.stdout = stdout or sys.stdout
        self.max_line_bytes = max(1024, int(max_line_bytes))
        self.max_response_bytes = max(1024, int(max_response_bytes))
        self.stop_requested = threading.Event()
        self._write_lock = threading.Lock()
        self.requests = 0
        self.errors = 0

    # -- lifecycle ---------------------------------------------------------
    def request_stop(self) -> None:
        self.stop_requested.set()

    def _install_signal_handlers(self) -> None:
        def _stop(_signum: int, _frame: Any) -> None:
            raise KeyboardInterrupt

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, _stop)
            except (ValueError, OSError):
                # Not running in the main thread (tests): callers stop the loop
                # by closing stdin or calling request_stop().
                pass

    def serve(self) -> int:
        self._install_signal_handlers()
        try:
            while not self.stop_requested.is_set():
                kind, payload = self._read_record()
                if kind == "eof":
                    break
                if kind == "too_large":
                    self._write_frame(
                        self._error_frame(None, WorkerError(
                            "request_too_large",
                            f"request line exceeds {self.max_line_bytes} bytes",
                        ))
                    )
                    continue
                response = self._handle_line(payload)
                if response is not None:
                    self._write_frame(response)
        except KeyboardInterrupt:
            pass
        return 0

    # -- framing -----------------------------------------------------------
    def _read_record(self) -> Tuple[str, bytes]:
        buffer = getattr(self.stdin, "buffer", None)
        reader = buffer if buffer is not None else self.stdin
        try:
            line = reader.readline(self.max_line_bytes + 1)
        except (ValueError, OSError):
            return "eof", b""
        if not line:
            return "eof", b""
        if isinstance(line, str):  # text-mode StringIO in tests
            line = line.encode("utf-8")
        if len(line) > self.max_line_bytes and not line.endswith(b"\n"):
            # Drain the rest of this oversize line so the stream stays aligned.
            while True:
                chunk = reader.readline(65536)
                if not chunk:
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                if chunk.endswith(b"\n"):
                    break
            return "too_large", b""
        return "line", line

    def _write_frame(self, frame: Dict[str, Any]) -> None:
        encoded = json.dumps(
            frame, ensure_ascii=False, separators=(",", ":"), default=str
        )
        if len(encoded.encode("utf-8")) > self.max_response_bytes:
            encoded = json.dumps(
                self._error_frame(
                    frame.get("id"),
                    WorkerError(
                        "response_too_large",
                        f"response exceeds {self.max_response_bytes} bytes",
                    ),
                ),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        with self._write_lock:
            self.stdout.write(encoded + "\n")
            flush = getattr(self.stdout, "flush", None)
            if flush:
                flush()

    # -- dispatch ----------------------------------------------------------
    def _handle_line(self, raw: bytes) -> Optional[Dict[str, Any]]:
        try:
            text = raw.decode("utf-8").strip()
        except UnicodeDecodeError:
            self.errors += 1
            return self._error_frame(None, WorkerError("bad_request", "request is not UTF-8"))
        if not text:
            return None

        try:
            record = json.loads(text)
        except json.JSONDecodeError as exc:
            self.errors += 1
            return self._error_frame(
                None, WorkerError("bad_request", f"invalid JSON: {exc.msg}")
            )
        if not isinstance(record, dict):
            self.errors += 1
            return self._error_frame(
                None, WorkerError("bad_request", "request must be a JSON object")
            )

        request_id = record.get("id")
        if request_id is not None and not isinstance(request_id, (str, int)):
            return self._error_frame(
                None, WorkerError("bad_request", "id must be a string or integer")
            )

        self.requests += 1
        try:
            result = self.handler(record)
        except WorkerError as exc:
            self.errors += 1
            return self._error_frame(request_id, exc)
        except ShutdownSentinel:
            return {"id": request_id, "ok": True, "result": {"stopping": True}}
        except Exception as exc:  # noqa: BLE001 - never leak a traceback to stdout
            self.errors += 1
            return self._error_frame(
                request_id,
                WorkerError("internal_error", str(exc) or exc.__class__.__name__),
            )
        return {"id": request_id, "ok": True, "result": result}

    @staticmethod
    def _error_frame(request_id: Any, error: WorkerError) -> Dict[str, Any]:
        return {"id": request_id, "ok": False, "error": error.to_dict()}


class ShutdownSentinel(Exception):
    """Internal marker used by the command handler to stop the loop."""
