# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Unit/contract tests against a real SQLite-backed Iceberg catalog and
local-filesystem warehouse. They exercise real PyIceberg commits, Parquet
writes, snapshots and schema evolution; no Iceberg mocks."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.main import Settings, create_app

SECRET = "qa-lakehouse-secret"


@pytest.fixture()
def client(tmp_path: Path):
    settings = Settings(
        catalog_uri=f"sqlite:///{tmp_path / 'catalog.db'}",
        warehouse=f"file://{tmp_path / 'warehouse'}",
        internal_secret=SECRET,
        is_prod=False,
        s3_endpoint="",
        s3_access_key="",
        s3_secret_key="",
        s3_region="us-east-1",
        max_namespaces=2,
        max_tables=2,
        max_rows_per_append=100,
        max_bytes=1_000_000,
    )
    return TestClient(create_app(settings))


def headers(org: str = "org-a") -> dict[str, str]:
    return {
        "x-synapseone-internal": SECRET,
        "x-synapseone-org": org,
        "content-type": "application/json",
    }


def test_requires_internal_secret_and_tenant_scope(client: TestClient):
    assert client.get("/v1/lakehouse/namespaces").status_code == 401
    assert client.get("/v1/lakehouse/namespaces", headers={"x-synapseone-internal": SECRET}).status_code == 403
    assert client.get("/health").status_code == 200


def test_quota_rejects_excess_namespaces(client: TestClient):
    h = headers()
    assert client.post("/v1/lakehouse/namespaces", headers=h, json={"name": "one"}).status_code == 201
    assert client.post("/v1/lakehouse/namespaces", headers=h, json={"name": "two"}).status_code == 201
    third = client.post("/v1/lakehouse/namespaces", headers=h, json={"name": "three"})
    assert third.status_code == 409
    assert third.json()["error"] == "quota_exceeded"


def test_iceberg_table_append_query_snapshot_schema_and_tenant_isolation(client: TestClient):
    h = headers()
    assert client.post("/v1/lakehouse/namespaces", headers=h, json={"name": "analytics"}).status_code == 201
    created = client.post(
        "/v1/lakehouse/namespaces/analytics/tables",
        headers=h,
        json={
            "name": "events",
            "schema": [
                {"name": "id", "type": "string"},
                {"name": "value", "type": "long"},
                {"name": "observed_at", "type": "timestamp"},
            ],
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["formatVersion"] >= 2
    usage = client.get("/v1/lakehouse/usage", headers=h)
    assert usage.status_code == 200
    assert usage.json()["namespaces"] == 1
    assert usage.json()["maxRowsPerAppend"] == 100

    first = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/rows",
        headers=h,
        json={
            "rows": [
                {"id": "a", "value": 1, "observed_at": "2026-11-24T00:00:00Z"},
                {"id": "b", "value": 2, "observed_at": "2026-11-24T00:01:00Z"},
            ],
            "idempotencyKey": "batch-1",
        },
    )
    assert first.status_code == 201, first.text
    first_snapshot = first.json()["snapshotId"]
    assert first.json()["rows"] == 2

    duplicate = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/rows",
        headers=h,
        json={"rows": [{"id": "c", "value": 3}], "idempotencyKey": "batch-1"},
    )
    assert duplicate.status_code == 201
    assert duplicate.json()["duplicate"] is True
    assert duplicate.json()["snapshotId"] == first_snapshot

    second = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/rows",
        headers=h,
        json={"rows": [{"id": "c", "value": 3}], "idempotencyKey": "batch-2"},
    )
    assert second.status_code == 201
    assert second.json()["rows"] == 1

    current = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/query",
        headers=h,
        json={"limit": 100},
    )
    assert current.status_code == 200, current.text
    assert sorted(row["id"] for row in current.json()["rows"]) == ["a", "b", "c"]

    previous = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/query",
        headers=h,
        json={"limit": 100, "snapshotId": first_snapshot},
    )
    assert previous.status_code == 200
    assert sorted(row["id"] for row in previous.json()["rows"]) == ["a", "b"]

    snapshots = client.get(
        "/v1/lakehouse/namespaces/analytics/tables/events/snapshots", headers=h
    )
    assert snapshots.status_code == 200
    assert len(snapshots.json()["items"]) == 2

    evolved = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/schema",
        headers=h,
        json={"add": [{"name": "source", "type": "string"}]},
    )
    assert evolved.status_code == 200, evolved.text
    assert any(column["name"] == "source" for column in evolved.json()["schema"])

    after_evolution = client.post(
        "/v1/lakehouse/namespaces/analytics/tables/events/rows",
        headers=h,
        json={"rows": [{"id": "d", "value": 4, "source": "sensor"}]},
    )
    assert after_evolution.status_code == 201, after_evolution.text

    # A different organization sees an empty catalog and cannot address the
    # first organization's table.
    other = headers("org-b")
    assert client.get("/v1/lakehouse/namespaces", headers=other).json()["items"] == []
    hidden = client.get(
        "/v1/lakehouse/namespaces/analytics/tables/events", headers=other
    )
    assert hidden.status_code == 404

    # Dropping the table removes the catalog pointer but retains data files.
    dropped = client.delete(
        "/v1/lakehouse/namespaces/analytics/tables/events", headers=h
    )
    assert dropped.status_code == 200
    assert dropped.json()["dataFilesRetained"] is True
    assert (
        client.get("/v1/lakehouse/namespaces/analytics/tables/events", headers=h).status_code
        == 404
    )

def test_byte_quota_and_maintenance_report(tmp_path: Path):
    settings = Settings(
        catalog_uri=f"sqlite:///{tmp_path / 'quota.db'}",
        warehouse=f"file://{tmp_path / 'quota-warehouse'}",
        internal_secret=SECRET,
        is_prod=False,
        s3_endpoint="",
        s3_access_key="",
        s3_secret_key="",
        s3_region="us-east-1",
        max_namespaces=2,
        max_tables=2,
        max_rows_per_append=100,
        max_bytes=64,
    )
    client = TestClient(create_app(settings))
    h = headers()
    assert client.post("/v1/lakehouse/namespaces", headers=h, json={"name": "quota"}).status_code == 201
    assert client.post(
        "/v1/lakehouse/namespaces/quota/tables",
        headers=h,
        json={"name": "events", "schema": [{"name": "id", "type": "string"}]},
    ).status_code == 201
    usage = client.get("/v1/lakehouse/usage", headers=h)
    assert usage.status_code == 200
    assert usage.json()["maxBytes"] == 64
    assert usage.json()["bytesQuotaEnforced"] is True
    blocked = client.post(
        "/v1/lakehouse/namespaces/quota/tables/events/rows",
        headers=h,
        json={"rows": [{"id": "x" * 200}]},
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"] == "quota_exceeded"
    report = client.get(
        "/v1/lakehouse/namespaces/quota/tables/events/maintenance", headers=h
    )
    assert report.status_code == 200
    assert report.json()["physicalCleanup"] == "disabled"
    assert report.json()["referencedFilesRetained"] is True

