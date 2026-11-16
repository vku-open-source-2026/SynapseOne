# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Protocol-level tests: framing, ordering, bounds and error envelopes."""

from __future__ import annotations

import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import WorkerError  # noqa: E402
from protocol import JsonlServer  # noqa: E402


def _run(lines, handler, **kwargs):
    stdin = io.StringIO("".join(line + "\n" for line in lines))
    stdout = io.StringIO()
    server = JsonlServer(handler, stdin=stdin, stdout=stdout, **kwargs)
    server.serve()
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line], server


class ProtocolTests(unittest.TestCase):
    def test_round_trip_and_ids(self):
        def handler(record):
            if record.get("op") == "health":
                return {"ready": True}
            return {"echo": record.get("request")}

        replies, server = _run(
            [
                json.dumps({"id": "1", "op": "health"}),
                json.dumps({"id": 2, "op": "infer", "type": "embeddings", "request": {"input": "x"}}),
            ],
            handler,
        )
        self.assertEqual(server.requests, 2)
        self.assertEqual(replies[0], {"id": "1", "ok": True, "result": {"ready": True}})
        self.assertEqual(replies[1]["id"], 2)
        self.assertEqual(replies[1]["result"], {"echo": {"input": "x"}})

    def test_bad_json_keeps_stream_aligned(self):
        replies, _ = _run(
            ["{not json", json.dumps({"id": "ok", "op": "health"})],
            lambda record: {"ok": True},
        )
        self.assertFalse(replies[0]["ok"])
        self.assertEqual(replies[0]["error"]["code"], "bad_request")
        self.assertIsNone(replies[0]["id"])
        self.assertEqual(replies[1]["id"], "ok")

    def test_worker_error_is_structured(self):
        def handler(record):
            raise WorkerError("model_not_ready", "still loading", retryable=True)

        replies, _ = _run([json.dumps({"id": "a", "op": "infer"})], handler)
        self.assertEqual(
            replies[0],
            {
                "id": "a",
                "ok": False,
                "error": {
                    "code": "model_not_ready",
                    "message": "still loading",
                    "retryable": True,
                },
            },
        )

    def test_unexpected_exception_is_bounded(self):
        def handler(record):
            raise RuntimeError("boom")

        replies, _ = _run([json.dumps({"id": "a", "op": "infer"})], handler)
        self.assertEqual(replies[0]["error"]["code"], "internal_error")
        self.assertEqual(replies[0]["error"]["message"], "boom")

    def test_request_bounds(self):
        replies, _ = _run(
            ["x" * 2000, json.dumps({"id": "after", "op": "health"})],
            lambda record: {"ok": True},
            max_line_bytes=1024,
        )
        self.assertEqual(replies[0]["error"]["code"], "request_too_large")
        self.assertEqual(replies[1]["id"], "after")

    def test_response_bounds(self):
        replies, _ = _run(
            [json.dumps({"id": "big", "op": "health"})],
            lambda record: {"payload": "y" * 5000},
            max_response_bytes=1024,
        )
        self.assertEqual(replies[0]["error"]["code"], "response_too_large")

    def test_blank_lines_are_ignored(self):
        replies, server = _run(["", "   ", json.dumps({"id": "1", "op": "health"})], lambda record: {})
        self.assertEqual(server.requests, 1)
        self.assertEqual(replies[0]["id"], "1")


if __name__ == "__main__":
    unittest.main()
