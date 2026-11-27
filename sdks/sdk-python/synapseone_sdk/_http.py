# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Shared HTTP plumbing for the synapseone SDK.

Every service module (iam, workflow, lds, base, faststore, queue) talks to the
platform through one :class:`HttpClient`, which adds auth headers, the optional
platform tenant header and maps every failure (network or HTTP) to
:class:`SynapseOneError`.
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterable, Iterator
from urllib.parse import urljoin, urlsplit

import requests

# Sentinel for "argument was not provided", distinct from None (an explicit
# null must be distinguishable from "leave untouched" in partial updates).
UNSET = object()

DEFAULT_BASE_URL = "https://api.synapseone.space"
DEFAULT_TIMEOUT = 15
INFERENCE_TIMEOUT = 120
WEBHOOK_TIMEOUT = 300
DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_BINARY_BYTES = 128 * 1024 * 1024
DEFAULT_MAX_REDIRECTS = 10
_RETRYABLE = {429, 502, 503, 504}
_REDIRECT_STATUS = {301, 302, 303, 307, 308}
_CREDENTIAL_HEADERS = {
    "authorization",
    "x-api-key",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "x-synapseone-tenant",
    "x-synapsedx-tenant",
}


def _origin(url: str) -> str:
    """Return ``scheme://host[:port]`` for redirect-origin comparisons."""
    parsed = urlsplit(url)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError:
        return f"{scheme}://{host}:invalid"
    if port is None:
        port = 443 if scheme == "https" else 80 if scheme == "http" else None
    return f"{scheme}://{host}:{port}" if port is not None else f"{scheme}://{host}"


def _parse_trusted_origin(value: str) -> str | None:
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        return None
    return _origin(value.strip())


def _strip_credentials(headers: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _CREDENTIAL_HEADERS}


class _BodyTooLarge(Exception):
    def __init__(self, status: int, limit: int) -> None:
        super().__init__(f"response body exceeds {limit} bytes")
        self.status = status
        self.limit = limit


def _is_timeout_error(exc: BaseException) -> bool:
    """Classify requests/urllib3 timeouts even when wrapped in ConnectionError."""
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (requests.exceptions.Timeout, TimeoutError)):
            return True
        if "timed out" in str(current).lower():
            return True
        current = current.__cause__ or current.__context__
    return False



class SynapseOneError(Exception):
    """All SDK errors surface as SynapseOneError (network or HTTP).

    ``status`` carries the HTTP status code when the failure came from a JSON
    response (None for network errors) and ``body`` carries the parsed error
    body when one was returned, so callers can branch on codes such as
    ``not_found`` or ``version_conflict``.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: Any | None = None,
        code: str | None = None,
        base_url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.code = code
        self.base_url = base_url


class HttpClient:
    """Thin request layer shared by all SynapseOne services.

    ``base_url`` points at the gateway (defaults to
    ``https://api.synapseone.space`` or ``SYNAPSEONE_BASE_URL``) or directly at
    a service origin. ``tenant`` is only needed by platform callers of the
    tenant-scoped services (faststore/queue) and is sent as
    ``x-synapseone-tenant``.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        api_key: str | None = None,
        tenant: str | None = None,
        timeout: int = DEFAULT_TIMEOUT,
        max_attempts: int = 3,
        retry_base: float = 0.2,
        trusted_redirect_origins: Iterable[str] | str | None = None,
        max_redirects: int = DEFAULT_MAX_REDIRECTS,
        max_json_bytes: int = DEFAULT_MAX_JSON_BYTES,
        max_binary_bytes: int = DEFAULT_MAX_BINARY_BYTES,
    ) -> None:
        import os

        url = (
            base_url
            or os.environ.get("SYNAPSEONE_BASE_URL")
            or os.environ.get("SYNAPSEDX_BASE_URL")
            or DEFAULT_BASE_URL
        )
        self.base_url = url.rstrip("/")
        self.token = token
        self.api_key = api_key
        self.tenant = tenant
        self.timeout = timeout
        self.max_attempts = max(1, int(max_attempts))
        self.retry_base = max(0.0, float(retry_base))
        self.max_redirects = max(0, int(max_redirects))
        self.max_json_bytes = max(0, int(max_json_bytes))
        self.max_binary_bytes = max(0, int(max_binary_bytes))

        env_trusted = (
            os.environ.get("SYNAPSEONE_TRUSTED_REDIRECT_ORIGINS")
            or os.environ.get("SYNAPSEDX_TRUSTED_REDIRECT_ORIGINS")
            or ""
        )
        if trusted_redirect_origins is None:
            values: list[str] = [v for v in env_trusted.split(",") if v.strip()]
        elif isinstance(trusted_redirect_origins, str):
            values = [v for v in trusted_redirect_origins.split(",") if v.strip()]
        else:
            values = [str(v) for v in trusted_redirect_origins if str(v).strip()]
        self.trusted_redirect_origins = {
            origin
            for origin in (_parse_trusted_origin(v) for v in values)
            if origin is not None
        }
        self._base_origin = _origin(self.base_url)


    def headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if self.api_key:
            h["X-API-Key"] = self.api_key
        if self.tenant:
            h["x-synapseone-tenant"] = self.tenant
        if extra:
            h.update(extra)
        return h

    def _open(
        self,
        method: str,
        path: str,
        *,
        json_body: Any | None = None,
        data: Any | None = None,
        headers: dict[str, str] | None = None,
        timeout: int | float | None = None,
    ) -> tuple[requests.Response, float | None]:
        """Send one request, following only safe redirects.

        Same-origin redirects keep credentials. Cross-origin redirects are
        followed only for explicitly trusted origins and never carry
        ``Authorization``/``X-API-Key``/cookies/tenant headers. The returned
        response is streamed; the caller must read and close it.
        """
        method = (method or "GET").upper()
        url = path if path.startswith(("http://", "https://")) else self.base_url + path
        to = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + float(to) if to and float(to) > 0 else None
        request_timeout = (float(to), float(to)) if to and float(to) > 0 else None

        for redirects in range(self.max_redirects + 1):
            credentials_allowed = _origin(url) == self._base_origin
            request_headers = self.headers(headers)
            if not credentials_allowed:
                request_headers = _strip_credentials(request_headers)

            try:
                response = requests.request(
                    method,
                    url,
                    json=json_body if method not in ("GET", "HEAD") else None,
                    data=data if method not in ("GET", "HEAD") else None,
                    headers=request_headers,
                    timeout=request_timeout,
                    allow_redirects=False,
                    stream=True,
                )
            except requests.exceptions.Timeout as exc:
                raise SynapseOneError(
                    f"synapseone timeout {path} after {to}s (base {self.base_url})",
                    code="timeout",
                    base_url=self.base_url,
                ) from exc
            except requests.exceptions.RequestException as exc:
                if _is_timeout_error(exc):
                    raise SynapseOneError(
                        f"synapseone timeout {path} after {to}s (base {self.base_url})",
                        code="timeout",
                        base_url=self.base_url,
                    ) from exc
                raise SynapseOneError(
                    f"synapseone network {path}: {exc} (base {self.base_url})",
                    code="network_error",
                    base_url=self.base_url,
                ) from exc

            if response.status_code not in _REDIRECT_STATUS:
                return response, deadline

            location = response.headers.get("Location")
            if not location:
                return response, deadline

            if redirects >= self.max_redirects:
                response.close()
                raise SynapseOneError(
                    f"synapseone too many redirects ({self.max_redirects}) for {path} "
                    f"(base {self.base_url})",
                    status=response.status_code,
                    code="too_many_redirects",
                    base_url=self.base_url,
                )

            try:
                next_url = urljoin(url, location)
                parsed = urlsplit(next_url)
            except ValueError as exc:
                response.close()
                raise SynapseOneError(
                    f"synapseone invalid redirect location '{location}' for {path}",
                    status=response.status_code,
                    code="redirect_not_allowed",
                    base_url=self.base_url,
                ) from exc
            if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
                response.close()
                raise SynapseOneError(
                    f"synapseone refused a redirect to non-HTTP origin {next_url!r} for {path}",
                    status=response.status_code,
                    code="redirect_not_allowed",
                    base_url=self.base_url,
                )

            next_origin = _origin(next_url)
            if next_origin != _origin(url) and next_origin not in self.trusted_redirect_origins:
                response.close()
                raise SynapseOneError(
                    f"synapseone refused a cross-origin redirect from {_origin(url)} to "
                    f"{next_origin} for {path}; add the target origin to "
                    "trusted_redirect_origins to follow it without credentials",
                    status=response.status_code,
                    code="redirect_not_allowed",
                    base_url=self.base_url,
                )

            # 303 always becomes GET; 301/302 downgrade POST to GET.
            if response.status_code == 303 or (
                response.status_code in (301, 302) and method == "POST"
            ):
                method = "GET"
                json_body = None
                data = None
            response.close()
            url = next_url

        raise SynapseOneError(  # pragma: no cover - loop always returns/raises
            f"synapseone redirect handling failed for {path}",
            code="redirect_not_allowed",
            base_url=self.base_url,
        )

    def _read_body(
        self,
        response: requests.Response,
        limit: int,
        path: str,
        deadline: float | None,
    ) -> bytes:
        """Read a streamed body with a hard limit and total deadline."""
        declared = response.headers.get("Content-Length")
        if limit > 0 and declared:
            try:
                if int(declared) > limit:
                    raise _BodyTooLarge(response.status_code, limit)
            except ValueError:
                pass
        chunks: list[bytes] = []
        total = 0
        try:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                if deadline is not None and time.monotonic() > deadline:
                    raise SynapseOneError(
                        f"synapseone timeout {path}: response body exceeded the request "
                        f"deadline (base {self.base_url})",
                        code="timeout",
                        base_url=self.base_url,
                    )
                total += len(chunk)
                if limit > 0 and total > limit:
                    raise _BodyTooLarge(response.status_code, limit)
                chunks.append(chunk)
        except requests.exceptions.Timeout as exc:
            raise SynapseOneError(
                f"synapseone timeout {path}: response body stalled (base {self.base_url})",
                code="timeout",
                base_url=self.base_url,
            ) from exc
        except requests.exceptions.RequestException as exc:
            if _is_timeout_error(exc):
                raise SynapseOneError(
                    f"synapseone timeout {path}: response body stalled (base {self.base_url})",
                    code="timeout",
                    base_url=self.base_url,
                ) from exc
            raise SynapseOneError(
                f"synapseone network {path}: response body read failed: {exc} "
                f"(base {self.base_url})",
                code="network_error",
                base_url=self.base_url,
            ) from exc
        return b"".join(chunks)

    @staticmethod
    def _decode_text(response: requests.Response, raw: bytes) -> str:
        encoding = response.encoding or "utf-8"
        try:
            return raw.decode(encoding, errors="replace")
        except LookupError:
            return raw.decode("utf-8", errors="replace")

    # Convenience verbs (used by namespaced services).
    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, body: Any | None = None, **kw: Any) -> Any:
        return self.request("POST", path, body, **kw)

    def put(self, path: str, body: Any | None = None, **kw: Any) -> Any:
        return self.request("PUT", path, body, **kw)

    def delete(self, path: str, body: Any | None = None, **kw: Any) -> Any:
        return self.request("DELETE", path, body, **kw)

    def _retry_after(self, value: str | None) -> float | None:
        if not value:
            return None
        try:
            return min(max(float(value), 0.0), 30.0)
        except (TypeError, ValueError):
            return None

    def _raise_html(self, path: str, status: int, text: str) -> None:
        head = text[:256].lstrip().lower()
        if head.startswith("<!doctype html") or head.startswith("<html"):
            raise SynapseOneError(
                f"synapseone expected JSON from {self.base_url}{path} but received HTML "
                f"(status {status}). The base URL looks like the console/marketing host; "
                f"use {DEFAULT_BASE_URL}.",
                status=status,
                code="non_json_response",
                base_url=self.base_url,
            )

    def request(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        *,
        timeout: int | None = None,
        headers: dict[str, str] | None = None,
        max_attempts: int | None = None,
        retryable: bool | None = None,
    ) -> Any:
        method = (method or "GET").upper()
        to = self.timeout if timeout is None else timeout
        attempts = max(1, int(max_attempts or self.max_attempts))
        if retryable is None:
            retryable = method in {"GET", "HEAD", "OPTIONS", "PUT", "DELETE"}
        last: SynapseOneError | None = None
        for attempt in range(1, attempts + 1):
            try:
                response, deadline = self._open(
                    method,
                    path,
                    json_body=body,
                    headers=headers,
                    timeout=to,
                )
                try:
                    raw = self._read_body(
                        response, self.max_json_bytes, path, deadline
                    )
                    status = response.status_code
                    text = self._decode_text(response, raw)
                finally:
                    response.close()
            except _BodyTooLarge as exc:
                last = SynapseOneError(
                    f"synapseone response {path} exceeded the {exc.limit}-byte limit "
                    f"(base {self.base_url})",
                    status=exc.status,
                    code="response_too_large",
                    base_url=self.base_url,
                )
                raise last from exc
            except SynapseOneError as exc:
                last = exc
                if exc.code in {"network_error", "timeout"} and retryable and attempt < attempts:
                    time.sleep(self.retry_base * (2 ** (attempt - 1)))
                    continue
                raise

            if status >= 400:
                body_json = _try_json_text(text)
                err = SynapseOneError(
                    f"synapseone {status} {path}: {text[:500]} (base {self.base_url})",
                    status=status,
                    body=body_json,
                    code=(body_json or {}).get("error")
                    if isinstance(body_json, dict)
                    else None,
                    base_url=self.base_url,
                )
                if retryable and status in _RETRYABLE and attempt < attempts:
                    wait = self._retry_after(response.headers.get("Retry-After"))
                    if wait is None:
                        wait = self.retry_base * (2 ** (attempt - 1))
                    time.sleep(wait)
                    last = err
                    continue
                raise err
            if not text:
                return None
            self._raise_html(path, status, text)
            try:
                return json.loads(text)
            except ValueError:
                return text  # non-JSON body (text/plain endpoints)

        raise last or SynapseOneError(
            f"synapseone {path}: retries exhausted", base_url=self.base_url
        )


    def request_binary(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        *,
        timeout: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> bytes:
        """Fetch a raw binary body (object downloads, attachments)."""
        to = self.timeout if timeout is None else timeout
        try:
            response, deadline = self._open(
                method,
                path,
                data=body,
                headers=headers,
                timeout=to,
            )
            try:
                raw = self._read_body(
                    response, self.max_binary_bytes, path, deadline
                )
                status = response.status_code
                text = self._decode_text(response, raw)
            finally:
                response.close()
        except _BodyTooLarge as exc:
            raise SynapseOneError(
                f"synapseone response {path} exceeded the {exc.limit}-byte limit "
                f"(base {self.base_url})",
                status=exc.status,
                code="response_too_large",
                base_url=self.base_url,
            ) from exc
        if status >= 400:
            raise SynapseOneError(
                f"synapseone {status} {path}: {text[:500]} (base {self.base_url})",
                status=status,
                body=_try_json_text(text),
                base_url=self.base_url,
            )
        return raw

    def upload(
        self,
        method: str,
        path: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
        timeout: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        """Send a raw binary body and parse the JSON response."""
        to = self.timeout if timeout is None else timeout
        extra = {"Content-Type": content_type, **(headers or {})}
        try:
            response, deadline = self._open(
                method or "PUT",
                path,
                data=body,
                headers=extra,
                timeout=to,
            )
            try:
                raw = self._read_body(
                    response, self.max_json_bytes, path, deadline
                )
                status = response.status_code
                text = self._decode_text(response, raw)
            finally:
                response.close()
        except _BodyTooLarge as exc:
            raise SynapseOneError(
                f"synapseone response {path} exceeded the {exc.limit}-byte limit "
                f"(base {self.base_url})",
                status=exc.status,
                code="response_too_large",
                base_url=self.base_url,
            ) from exc
        if status >= 400:
            raise SynapseOneError(
                f"synapseone {status} {path}: {text[:500]} (base {self.base_url})",
                status=status,
                body=_try_json_text(text),
                base_url=self.base_url,
            )
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            return text

    def head(self, path: str, *, timeout: int | None = None) -> dict[str, str]:
        """HEAD request; returns lower-cased response headers."""
        to = self.timeout if timeout is None else timeout
        response, _deadline = self._open("HEAD", path, timeout=to)
        try:
            if response.status_code >= 400:
                raise SynapseOneError(
                    f"synapseone {response.status_code} {path} (base {self.base_url})",
                    status=response.status_code,
                    base_url=self.base_url,
                )
            return {k.lower(): v for k, v in response.headers.items()}
        finally:
            response.close()

    def stream(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        *,
        timeout: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> Iterator[tuple[str, str]]:
        """Yield ``(event, data)`` Server-Sent-Events records without buffering.

        The HTTP response is closed when the generator is exhausted or garbage
        collected; callers can stop early and the ``finally`` block closes it.
        The request timeout applies to connection, headers and each body read;
        an idle stream longer than the timeout raises instead of hanging.
        """
        to = INFERENCE_TIMEOUT if timeout is None else timeout
        response, deadline = self._open(
            method,
            path,
            json_body=body,
            headers=headers,
            timeout=to,
        )
        try:
            if response.status_code >= 400:
                raw = self._read_body(response, self.max_json_bytes, path, deadline)
                text = self._decode_text(response, raw)
                raise SynapseOneError(
                    f"synapseone {response.status_code} {path}: {text[:500]} "
                    f"(base {self.base_url})",
                    status=response.status_code,
                    body=_try_json_text(text),
                    base_url=self.base_url,
                )
            event = "message"
            data: list[str] = []
            for raw_line in response.iter_lines(decode_unicode=True):
                if deadline is not None and time.monotonic() > deadline:
                    raise SynapseOneError(
                        f"synapseone timeout {path}: stream exceeded the request deadline "
                        f"(base {self.base_url})",
                        code="timeout",
                        base_url=self.base_url,
                    )
                line = (raw_line or "").rstrip("\r")
                if not line:
                    if data:
                        yield event, "\n".join(data)
                    event, data = "message", []
                    continue
                if line.startswith(":"):
                    continue
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "event":
                    event = value
                elif field == "data":
                    data.append(value)
            if data:
                yield event, "\n".join(data)
        except requests.exceptions.Timeout as exc:
            raise SynapseOneError(
                f"synapseone timeout {path}: stream body stalled (base {self.base_url})",
                code="timeout",
                base_url=self.base_url,
            ) from exc
        except requests.exceptions.RequestException as exc:
            raise SynapseOneError(
                f"synapseone network {path}: stream body read failed: {exc} "
                f"(base {self.base_url})",
                code="network_error",
                base_url=self.base_url,
            ) from exc
        finally:
            response.close()



def parse_chat_delta(data: str) -> str | None:
    """Extract incremental text from one SSE ``data:`` payload."""
    if not data or data == "[DONE]":
        return None
    try:
        j = json.loads(data)
    except ValueError:
        return data
    try:
        choice = (j.get("choices") or [{}])[0]
        delta = (choice.get("delta") or {}).get("content") or (
            choice.get("message") or {}
        ).get("content")
    except AttributeError:
        delta = None
    if isinstance(delta, str) and delta:
        return delta
    content = j.get("content") if isinstance(j, dict) else None
    return content if isinstance(content, str) and content else None


def _try_json_text(text: str) -> Any:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def iter_text(events: Iterable[tuple[str, str]]) -> Iterator[str]:
    """Project an SSE generator to incremental assistant text chunks."""
    for _event, data in events:
        chunk = parse_chat_delta(data)
        if chunk:
            yield chunk
