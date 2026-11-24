# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""SynapseNotifications client: outbox, templates and preferences (#25)."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._http import HttpClient

_PREFIX = "/v1/notifications"


class NotificationsService:
    """Namespace for SynapseNotifications operations."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def send(
        self,
        recipient: dict[str, Any],
        body: str | None = None,
        channel: str | None = None,
        channels: list[str] | None = None,
        subject: str = "",
        data: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        template_id: str | None = None,
        template_slug: str | None = None,
    ) -> dict:
        """Queue a notification (one record per channel) from inline text or a template."""
        payload: dict[str, Any] = {"recipient": recipient, "subject": subject}
        if body is not None:
            payload["body"] = body
        if template_id:
            payload["templateId"] = template_id
        if template_slug:
            payload["templateSlug"] = template_slug
        if channel:
            payload["channel"] = channel
        if channels:
            payload["channels"] = channels
        if data is not None:
            payload["data"] = data
        if idempotency_key:
            payload["idempotencyKey"] = idempotency_key
        return self._http.request("POST", _PREFIX, payload)

    def get(self, notification_id: str) -> dict:
        return self._http.request("GET", f"{_PREFIX}/{quote(notification_id, safe='')}")

    def list(self, status: str | None = None, limit: int = 50) -> list:
        params = [f"limit={int(limit)}"]
        if status:
            params.append("status=" + quote(status, safe=""))
        return self._http.request("GET", f"{_PREFIX}?{'&'.join(params)}")

    def cancel(self, notification_id: str) -> dict:
        return self._http.request(
            "POST", f"{_PREFIX}/{quote(notification_id, safe='')}/cancel", {}
        )

    def retry(self, notification_id: str) -> dict:
        """Restart a failed/dead delivery with a fresh attempt budget."""
        return self._http.request(
            "POST", f"{_PREFIX}/{quote(notification_id, safe='')}/retry", {}
        )

    def create_template(
        self, slug: str, name: str, body: str, subject: str = ""
    ) -> dict:
        return self._http.request(
            "POST",
            f"{_PREFIX}/templates",
            {"slug": slug, "name": name, "subject": subject, "body": body},
        )

    def list_templates(
        self,
        q: str = "",
        include_archived: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        params = [f"limit={int(limit)}", f"offset={int(offset)}"]
        if q:
            params.append("q=" + quote(q, safe=""))
        if include_archived:
            params.append("includeArchived=true")
        return self._http.request("GET", f"{_PREFIX}/templates?{'&'.join(params)}")

    def get_template(self, template_id: str) -> dict:
        return self._http.request(
            "GET", f"{_PREFIX}/templates/{quote(template_id, safe='')}"
        )

    def update_template(
        self,
        template_id: str,
        name: str | None = None,
        subject: str | None = None,
        body: str | None = None,
    ) -> dict:
        payload: dict[str, Any] = {}
        if name is not None:
            payload["name"] = name
        if subject is not None:
            payload["subject"] = subject
        if body is not None:
            payload["body"] = body
        return self._http.request(
            "PATCH",
            f"{_PREFIX}/templates/{quote(template_id, safe='')}",
            payload,
        )

    def delete_template(self, template_id: str) -> dict:
        return self._http.request(
            "DELETE", f"{_PREFIX}/templates/{quote(template_id, safe='')}"
        )

    def preview_template(
        self, template_id: str, data: dict[str, Any] | None = None
    ) -> dict:
        return self._http.request(
            "POST",
            f"{_PREFIX}/templates/{quote(template_id, safe='')}/preview",
            {"data": data or {}},
        )

    def get_preference(self, recipient: str) -> dict:
        return self._http.request(
            "GET", f"{_PREFIX}/preferences/{quote(recipient, safe='')}"
        )

    def set_preference(
        self,
        recipient: str,
        channels: list[str] | None = None,
        unsubscribed: bool | None = None,
    ) -> dict:
        payload: dict[str, Any] = {}
        if channels is not None:
            payload["channels"] = channels
        if unsubscribed is not None:
            payload["unsubscribed"] = unsubscribed
        return self._http.request(
            "PUT", f"{_PREFIX}/preferences/{quote(recipient, safe='')}", payload
        )

    def unsubscribe(self, recipient: str) -> dict:
        return self._http.request(
            "POST", f"{_PREFIX}/unsubscribe", {"recipient": recipient}
        )
