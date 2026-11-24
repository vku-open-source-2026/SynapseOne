# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Synapse Warehouse client: tenant-scoped OLAP datasets, read-only SQL and
batch/stream ETL jobs through the Tier-1 gateway."""

from __future__ import annotations

from typing import Any

from ._http import HttpClient

_P = "/v1/warehouse"


class WarehouseService:
    """Methods for every ``/v1/warehouse`` endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    def list_datasets(self) -> dict:
        return self._req("GET", f"{_P}/datasets")

    def get_dataset(self, dataset_id: str) -> dict:
        return self._req("GET", f"{_P}/datasets/{dataset_id}")

    def create_dataset(self, dataset: dict) -> dict:
        return self._req("POST", f"{_P}/datasets", dataset)

    def update_dataset(
        self, dataset_id: str, name: str | None = None, description: str | None = None
    ) -> dict:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        return self._req("PATCH", f"{_P}/datasets/{dataset_id}", body)

    def delete_dataset(self, dataset_id: str) -> dict:
        return self._req("DELETE", f"{_P}/datasets/{dataset_id}")

    def ingest(self, dataset_id: str, rows: list[dict]) -> dict:
        return self._req("POST", f"{_P}/datasets/{dataset_id}/rows", {"rows": rows})

    def query(self, sql: str, limit: int | None = None) -> dict:
        body: dict[str, Any] = {"sql": sql}
        if limit is not None:
            body["limit"] = limit
        return self._req("POST", f"{_P}/query", body)

    def templates(self) -> dict:
        return self._req("GET", f"{_P}/templates")

    def list_jobs(self) -> dict:
        return self._req("GET", f"{_P}/jobs")

    def get_job(self, job_id: str) -> dict:
        return self._req("GET", f"{_P}/jobs/{job_id}")

    def create_job(self, job: dict) -> dict:
        return self._req("POST", f"{_P}/jobs", job)

    def update_job(self, job_id: str, name: str) -> dict:
        return self._req("PATCH", f"{_P}/jobs/{job_id}", {"name": name})

    def run_batch(self, job: dict) -> dict:
        return self._req("POST", f"{_P}/etl/batch", job)

    def ensure_stream(self, job: dict) -> dict:
        return self._req("POST", f"{_P}/etl/stream", job)

    def base_to_warehouse(self, job: dict) -> dict:
        """One-shot Base snapshot → Warehouse current-state dataset (Path A)."""
        return self._req("POST", f"{_P}/etl/base", job)

    def lakehouse_to_warehouse(self, job: dict) -> dict:
        """Authorized Lakehouse snapshot/table → Warehouse dataset (Path C)."""
        return self._req("POST", f"{_P}/etl/lakehouse", job)

    def base_to_lakehouse(self, job: dict) -> dict:
        """Create a durable Base→Stream→Iceberg change-log ETL job."""
        return self._req("POST", f"{_P}/etl/base-lakehouse", job)

    def preview_ocs(self, job: dict) -> dict:
        """Preview schema and rows for an authorized OCS CSV/JSONL/Parquet object."""
        return self._req("POST", f"{_P}/etl/ocs/preview", job)

    def import_ocs(self, job: dict) -> dict:
        """Import an authorized OCS CSV/JSONL/Parquet object into a dataset."""
        return self._req("POST", f"{_P}/etl/ocs", job)

    def run_job(self, job_id: str) -> dict:
        return self._req("POST", f"{_P}/jobs/{job_id}/run")

    def pause_job(self, job_id: str) -> dict:
        return self._req("POST", f"{_P}/jobs/{job_id}/pause")

    def resume_job(self, job_id: str) -> dict:
        return self._req("POST", f"{_P}/jobs/{job_id}/resume")

    def delete_job(self, job_id: str) -> dict:
        return self._req("DELETE", f"{_P}/jobs/{job_id}")

    def pipeline_status(self) -> dict:
        return self._req("GET", f"{_P}/pipeline/status")
