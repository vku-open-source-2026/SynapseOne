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
_final_headers: dict = {}


class Transport(BaseHTTPRequestHandler):
    redirect_target = ""

    def _send(self):
        path = self.path.split("?")[0]
        _hits[path] = _hits.get(path, 0) + 1
        if path == "/v1/redirect-same":
            self.send_response(302)
            self.send_header("Location", "/v1/final")
            self.end_headers()
            return
        if path == "/v1/final":
            global _final_headers
            _final_headers = {k.lower(): v for k, v in self.headers.items()}
            payload = b'{"ok":true,"path":"/v1/final"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/v1/redirect-cross":
            self.send_response(302)
            self.send_header("Location", Transport.redirect_target + "/capture")
            self.end_headers()
            return
        if path == "/v1/stall-body":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b'{"ok":')
            self.wfile.flush()
            time.sleep(0.8)
            return
        if path == "/v1/partial-body":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b'{"ok"')
            self.wfile.flush()
            return
        if path == "/v1/bytes":
            payload = bytes([0, 1, 2, 254, 255])
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/v1/bytes-big":
            payload = b"x" * 100
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == "/v1/large-json":
            payload = json.dumps({"data": "x" * 200}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
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
    _final_headers.clear()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Transport)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}"
    finally:
        srv.shutdown()


class OtherOrigin(BaseHTTPRequestHandler):
    hits = 0
    seen: dict = {}

    def do_GET(self):
        OtherOrigin.hits += 1
        OtherOrigin.seen = {k.lower(): v for k, v in self.headers.items()}
        payload = b'{"ok":true,"other":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


@pytest.fixture()
def other_server():
    OtherOrigin.hits = 0
    OtherOrigin.seen = {}
    srv = ThreadingHTTPServer(("127.0.0.1", 0), OtherOrigin)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    old_target = Transport.redirect_target
    Transport.redirect_target = base
    try:
        yield base
    finally:
        Transport.redirect_target = old_target
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


def test_timeout_covers_a_stalled_body(server):
    c = SynapseOneClient(server)
    started = time.time()
    with pytest.raises(SynapseOneError) as exc:
        c._http.request("GET", "/v1/stall-body", timeout=0.05, max_attempts=1)
    assert exc.value.code == "timeout"
    assert time.time() - started < 0.5


def test_partial_body_is_an_error_not_truncated_data(server):
    c = SynapseOneClient(server)
    with pytest.raises(SynapseOneError) as exc:
        c._http.request("GET", "/v1/partial-body", timeout=1, max_attempts=1)
    assert exc.value.code in {"network_error", "timeout"}


def test_same_origin_redirect_keeps_credentials(server):
    c = SynapseOneClient(server, token="jwt-1", api_key="key-1", tenant="acme")
    out = c._http.request("GET", "/v1/redirect-same")
    assert out["path"] == "/v1/final"
    assert _final_headers.get("authorization") == "Bearer jwt-1"
    assert _final_headers.get("x-api-key") == "key-1"
    assert _final_headers.get("x-synapseone-tenant") == "acme"


def test_untrusted_cross_origin_redirect_is_refused(server, other_server):
    c = SynapseOneClient(server, token="jwt-1", api_key="key-1")
    with pytest.raises(SynapseOneError) as exc:
        c._http.request("GET", "/v1/redirect-cross")
    assert exc.value.code == "redirect_not_allowed"
    assert OtherOrigin.hits == 0


def test_trusted_cross_origin_redirect_never_forwards_credentials(server, other_server):
    c = SynapseOneClient(
        server,
        token="jwt-1",
        api_key="key-1",
        tenant="acme",
        trusted_redirect_origins=[other_server],
    )
    out = c._http.request("GET", "/v1/redirect-cross")
    assert out["other"] is True
    assert OtherOrigin.hits == 1
    assert OtherOrigin.seen.get("authorization") is None
    assert OtherOrigin.seen.get("x-api-key") is None
    assert OtherOrigin.seen.get("x-synapseone-tenant") is None
    assert OtherOrigin.seen.get("cookie") is None


def test_binary_response_preserves_exact_bytes(server):
    c = SynapseOneClient(server)
    assert c._http.request_binary("GET", "/v1/bytes") == bytes([0, 1, 2, 254, 255])


def test_binary_limit_is_explicit(server):
    c = SynapseOneClient(server, max_binary_bytes=4)
    with pytest.raises(SynapseOneError) as exc:
        c._http.request_binary("GET", "/v1/bytes-big")
    assert exc.value.code == "response_too_large"


def test_json_limit_is_explicit(server):
    c = SynapseOneClient(server, max_json_bytes=16)
    with pytest.raises(SynapseOneError) as exc:
        c._http.request("GET", "/v1/large-json", max_attempts=1)
    assert exc.value.code == "response_too_large"


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
