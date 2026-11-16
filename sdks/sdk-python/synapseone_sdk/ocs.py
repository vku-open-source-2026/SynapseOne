# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""SynapseOCS client: buckets, objects, copy, listing, presign and multipart."""

from __future__ import annotations

from urllib.parse import quote

from ._http import HttpClient, SynapseOneError

_PREFIX = "/v1/ocs"


def _segment(value: str) -> str:
    return quote(str(value), safe="")


def _key_path(key: str) -> str:
    return "/".join(quote(segment, safe="") for segment in str(key).split("/"))


class OcsService:
    """Namespace for SynapseOCS bucket and object operations."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    # ---- buckets ----
    def create_bucket(self, name: str, quota_bytes: int | None = None) -> dict:
        body: dict[str, object] = {"name": name}
        if quota_bytes is not None:
            body["quotaBytes"] = int(quota_bytes)
        return self._http.request("POST", f"{_PREFIX}/buckets", body)

    def list_buckets(self, with_stats: bool = False) -> dict:
        suffix = "?withStats=1" if with_stats else ""
        return self._http.request("GET", f"{_PREFIX}/buckets{suffix}")

    def get_bucket(self, name: str) -> dict:
        return self._http.request("GET", f"{_PREFIX}/buckets/{_segment(name)}")

    def head_bucket(self, name: str) -> dict | None:
        try:
            return self._http.head(f"{_PREFIX}/buckets/{_segment(name)}")
        except SynapseOneError as error:
            if error.status == 404:
                return None
            raise

    def bucket_stats(self, name: str) -> dict:
        return self._http.request("GET", f"{_PREFIX}/buckets/{_segment(name)}/stats")

    def delete_bucket(self, name: str, force: bool = False) -> dict:
        suffix = "?force=true" if force else ""
        return self._http.request(
            "DELETE", f"{_PREFIX}/buckets/{_segment(name)}{suffix}"
        )

    # ---- objects ----
    def put_object(
        self,
        bucket: str,
        key: str,
        body: bytes,
        content_type: str = "application/octet-stream",
        checksum_sha256: str | None = None,
    ) -> dict:
        headers = {}
        if checksum_sha256:
            headers["x-object-checksum-sha256"] = checksum_sha256
        return self._http.upload(
            "PUT",
            f"{_PREFIX}/buckets/{_segment(bucket)}/objects/{_key_path(key)}",
            body,
            content_type=content_type,
            headers=headers,
        )

    def get_object(
        self,
        bucket: str,
        key: str,
        range_header: str | None = None,
        if_none_match: str | None = None,
        if_match: str | None = None,
    ) -> bytes:
        headers: dict[str, str] = {}
        if range_header:
            headers["Range"] = range_header
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        if if_match:
            headers["If-Match"] = if_match
        return self._http.request_binary(
            "GET",
            f"{_PREFIX}/buckets/{_segment(bucket)}/objects/{_key_path(key)}",
            headers=headers,
        )

    def head_object(self, bucket: str, key: str) -> dict | None:
        try:
            headers = self._http.head(
                f"{_PREFIX}/buckets/{_segment(bucket)}/objects/{_key_path(key)}"
            )
        except SynapseOneError as error:
            if error.status == 404:
                return None
            raise
        return {
            "key": headers.get("x-object-key", key),
            "bucket": headers.get("x-ocs-bucket", bucket),
            "size": int(headers.get("content-length") or 0),
            "contentType": headers.get("content-type", "application/octet-stream"),
            "etag": (headers.get("etag") or "").strip('"'),
            "checksumSha256": headers.get("x-object-checksum-sha256"),
            "createdAt": headers.get("x-object-created-at", ""),
            "updatedAt": headers.get("x-object-updated-at", ""),
        }

    def delete_object(self, bucket: str, key: str) -> dict:
        return self._http.request(
            "DELETE",
            f"{_PREFIX}/buckets/{_segment(bucket)}/objects/{_key_path(key)}",
        )

    def list_objects(
        self,
        bucket: str,
        prefix: str = "",
        delimiter: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict:
        params = [f"limit={int(limit)}"]
        if prefix:
            params.append("prefix=" + quote(prefix, safe=""))
        if delimiter:
            params.append("delimiter=" + quote(delimiter, safe=""))
        if cursor:
            params.append("cursor=" + quote(cursor, safe=""))
        return self._http.request(
            "GET",
            f"{_PREFIX}/buckets/{_segment(bucket)}/objects?{'&'.join(params)}",
        )

    def copy_object(
        self,
        bucket: str,
        source_key: str,
        destination_key: str,
        source_bucket: str | None = None,
        content_type: str | None = None,
    ) -> dict:
        body: dict[str, object] = {
            "sourceKey": source_key,
            "destinationKey": destination_key,
        }
        if source_bucket:
            body["sourceBucket"] = source_bucket
        if content_type:
            body["contentType"] = content_type
        return self._http.request(
            "POST",
            f"{_PREFIX}/buckets/{_segment(bucket)}/objects/copy",
            body,
        )

    def presign(
        self,
        bucket: str,
        key: str,
        method: str = "GET",
        expires_in: int = 900,
    ) -> dict:
        return self._http.request(
            "POST",
            f"{_PREFIX}/buckets/{_segment(bucket)}/presign",
            {"key": key, "method": method, "expiresIn": expires_in},
        )

    # ---- multipart ----
    def create_multipart(
        self,
        bucket: str,
        key: str,
        content_type: str = "application/octet-stream",
    ) -> dict:
        return self._http.request(
            "POST",
            f"{_PREFIX}/buckets/{_segment(bucket)}/uploads",
            {"key": key, "contentType": content_type},
        )

    def upload_part(
        self,
        bucket: str,
        upload_id: str,
        key: str,
        part_number: int,
        body: bytes,
    ) -> dict:
        return self._http.upload(
            "PUT",
            f"{_PREFIX}/buckets/{_segment(bucket)}/uploads/{_segment(upload_id)}"
            f"/parts/{int(part_number)}?key={quote(key, safe='')}",
            body,
            content_type="application/octet-stream",
        )

    def complete_multipart(
        self,
        bucket: str,
        upload_id: str,
        key: str,
        parts: list[dict],
    ) -> dict:
        return self._http.request(
            "POST",
            f"{_PREFIX}/buckets/{_segment(bucket)}/uploads/{_segment(upload_id)}/complete",
            {"key": key, "parts": parts},
        )

    def abort_multipart(self, bucket: str, upload_id: str, key: str) -> dict:
        return self._http.request(
            "DELETE",
            f"{_PREFIX}/buckets/{_segment(bucket)}/uploads/{_segment(upload_id)}"
            f"?key={quote(key, safe='')}",
        )
