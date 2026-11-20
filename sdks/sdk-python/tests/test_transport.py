# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Transport contract tests: non-JSON guard, retries, timeouts and SSE."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from synapseone_sdk import (
    SynapseOneClient,
    SynapseOneError,
    iter_text,
    parse_chat_delta,
)
from synapseone_sdk._http import DEFAULT_BASE_URL

_hits: dict = {}


class Transport(BaseHTTPRequestHandler):
    def _send(self):
        path = self.path.split("?")[0]
        _hits[path] = _hits.get(path, 0) + 1
        if path == "/v1/orgs" and self.headers.get("X-Test-Html") == "1":
            payload = b"<!doctype html><html>console</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/v1/flaky":
            if _hits[path] < 3:
                payload = b'{"error":"unavailable"}'
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            payload = json.dumps({"ok": True, "attempts": _hits[path]}).encode()
            self.send_response(200)
        elif path == "/ready":
            payload = json.dumps(
                {
                    "status": "degraded",
                    "service": "gateway",
                    "version": "0",
                    "upstreams": [{"name": "base", "ok": False}],
                    "time": "t",
                }
            ).encode()
            self.send_response(503)
        elif path == "/health":
            payload = json.dumps(
                {"status": "ok", "service": "gateway", "version": "0", "time": "t"}
            ).encode()
            self.send_response(200)
        elif path == "/v1/inference/chat/completions":
            payload = b'data: {"choices":[{"delta":{"content":"he"}}]}\n\nevent: done\ndata: [DONE]\n\n'
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        elif path == "/v1/slow":
            time.sleep(0.4)
            payload = b'{"ok":true}'
            self.send_response(200)
        else:
            payload = b'{"ok":true}'
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _send
    do_POST = _send
    do_PUT = _send
    do_DELETE = _send

    def log_message(self, *a):
        pass


@pytest.fixture()
def server():
    _hits.clear()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Transport)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}"
    finally:
        srv.shutdown()


def test_default_base_url_is_the_gateway():
    assert DEFAULT_BASE_URL == "https://api.synapseone.space"


def test_html_2xx_is_rejected(server):
    c = SynapseOneClient(server, max_attempts=1)
    with pytest.raises(SynapseOneError) as exc:
        c._http.request("GET", "/v1/orgs", headers={"X-Test-Html": "1"})
    assert exc.value.code == "non_json_response"
    assert exc.value.status == 200
    assert "api.synapseone.space" in str(exc.value)
    assert exc.value.base_url == server


def test_retries_idempotent_requests(server):
    c = SynapseOneClient(server, max_attempts=3)
    c._http.retry_base = 0.001
    out = c._http.request("GET", "/v1/flaky")
    assert out["ok"] is True
    assert _hits["/v1/flaky"] == 3


def test_no_retry_for_posts(server):
    c = SynapseOneClient(server, max_attempts=3)
    c._http.retry_base = 0.001
    with pytest.raises(SynapseOneError) as exc:
        c._http.request("POST", "/v1/flaky", {})
    assert exc.value.status == 503
    assert _hits["/v1/flaky"] == 1


def test_per_call_timeout(server):
    c = SynapseOneClient(server)
    started = time.time()
    with pytest.raises(SynapseOneError):
        c._http.request("GET", "/v1/slow", timeout=0.05, max_attempts=1)
    assert time.time() - started < 0.35


def test_ready_returns_degraded_payload(server):
    c = SynapseOneClient(server)
    ready = c.health.ready()
    assert ready["status"] == "degraded"
    assert ready["upstreams"][0]["name"] == "base"
    with pytest.raises(SynapseOneError):
        c.health.ready(throw_on_degraded=True)


def test_status_projection(server):
    c = SynapseOneClient(server)
    status = c.health.status()
    assert status["ok"] is False
    assert status["tier1"]["reachable"] is True
    assert status["upstreams"][0]["name"] == "base"


def test_chat_stream_yields_deltas(server):
    c = SynapseOneClient(server)
    chunks = list(
        iter_text(c.inference.chat_stream([{"role": "user", "content": "hi"}]))
    )
    assert chunks == ["he"]
    assert parse_chat_delta("[DONE]") is None
