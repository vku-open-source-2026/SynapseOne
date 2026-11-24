# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Synapse Lakehouse client: tenant-scoped Apache Iceberg namespaces, tables,
snapshots and bounded scans through the Tier-1 gateway."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._http import HttpClient

_P = "/v1/lakehouse"


class LakehouseService:
    """Methods for every ``/v1/lakehouse`` endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    @staticmethod
    def _table(namespace: str, table: str) -> str:
        return f"{_P}/namespaces/{quote(namespace, safe='')}/tables/{quote(table, safe='')}"

    def usage(self) -> dict:
        return self._req("GET", f"{_P}/usage")

    def list_namespaces(self) -> dict:
        return self._req("GET", f"{_P}/namespaces")

    def create_namespace(self, name: str) -> dict:
        return self._req("POST", f"{_P}/namespaces", {"name": name})

    def delete_namespace(self, namespace: str) -> dict:
        return self._req("DELETE", f"{_P}/namespaces/{quote(namespace, safe='')}")

    def list_tables(self, namespace: str) -> dict:
        return self._req("GET", f"{_P}/namespaces/{quote(namespace, safe='')}/tables")

    def create_table(self, namespace: str, name: str, schema: list[dict]) -> dict:
        return self._req(
            "POST",
            f"{_P}/namespaces/{quote(namespace, safe='')}/tables",
            {"name": name, "schema": schema},
        )

    def get_table(self, namespace: str, table: str) -> dict:
        return self._req("GET", self._table(namespace, table))

    def delete_table(self, namespace: str, table: str) -> dict:
        return self._req("DELETE", self._table(namespace, table))

    def append(
        self,
        namespace: str,
        table: str,
        rows: list[dict],
        idempotency_key: str | None = None,
    ) -> dict:
        body: dict[str, Any] = {"rows": rows}
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        return self._req("POST", f"{self._table(namespace, table)}/rows", body)

    def query(
        self,
        namespace: str,
        table: str,
        limit: int | None = None,
        snapshot_id: str | int | None = None,
    ) -> dict:
        body: dict[str, Any] = {}
        if limit is not None:
            body["limit"] = limit
        if snapshot_id is not None:
            body["snapshotId"] = str(snapshot_id)
        return self._req("POST", f"{self._table(namespace, table)}/query", body)

    def snapshots(self, namespace: str, table: str) -> dict:
        return self._req("GET", f"{self._table(namespace, table)}/snapshots")

    def evolve(self, namespace: str, table: str, add: list[dict]) -> dict:
        return self._req(
            "POST", f"{self._table(namespace, table)}/schema", {"add": add}
        )
