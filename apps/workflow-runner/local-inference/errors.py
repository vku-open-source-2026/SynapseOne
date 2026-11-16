# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Error types shared by the local inference worker.

The worker is fail-closed: an unavailable or partially loaded model must never
produce a mock/fallback answer.  Every failure is surfaced as a structured
``WorkerError`` so the Node bridge can report it truthfully to the Console.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class WorkerError(Exception):
    """A bounded, protocol-safe error returned to the caller."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = str(code or "internal_error")
        self.message = str(message or "local inference failed")
        self.retryable = bool(retryable)
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            payload["details"] = self.details
        return payload


class ShutdownRequested(Exception):
    """Raised by the command handler after a graceful shutdown request."""
