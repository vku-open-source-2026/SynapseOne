# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Synapse Lakehouse — tenant-scoped Apache Iceberg catalog and table API.

The service is intentionally thin: PyIceberg owns the Iceberg metadata,
Parquet files, catalog commits and snapshot semantics. Tenant isolation is
enforced here by mapping each organization/account to a hidden physical
namespace and never accepting a client-supplied storage location.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, PlainTextResponse
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.exceptions import (
    CommitFailedException,
    NamespaceAlreadyExistsError,
    NamespaceNotEmptyError,
    NoSuchNamespaceError,
    NoSuchTableError,
    TableAlreadyExistsError,
    ValidationError,
)
from pyiceberg.schema import Schema
from pyiceberg.types import (
    BooleanType,
    DateType,
    DoubleType,
    IcebergType,
    LongType,
    NestedField,
    StringType,
    TimestampType,
)

VERSION = "0.9.0"
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
MAX_BODY_BYTES = int(os.getenv("LAKEHOUSE_MAX_BODY_BYTES", str(8 * 1024 * 1024)))


@dataclass(frozen=True)
class Settings:
    catalog_uri: str
    warehouse: str
    internal_secret: str
    is_prod: bool
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_region: str
    max_namespaces: int
    max_tables: int
    max_rows_per_append: int
    max_bytes: int

    @classmethod
    def from_env(cls) -> "Settings":
        uri = os.getenv("LAKEHOUSE_CATALOG_URI", "").strip()
        if not uri:
            # Dev/test fallback only. Production fails closed below.
            uri = f"sqlite:///{Path(tempfile.gettempdir()) / 'synapseone-lakehouse.db'}"
        if uri.startswith("postgres://"):
            uri = "postgresql+pg8000://" + uri[len("postgres://") :]
        elif uri.startswith("postgresql://"):
            uri = "postgresql+pg8000://" + uri[len("postgresql://") :]
        elif uri.startswith("postgresql+psycopg://"):
            uri = "postgresql+pg8000://" + uri[len("postgresql+psycopg://") :]
        warehouse = os.getenv("LAKEHOUSE_WAREHOUSE", "").strip()
        if not warehouse:
            warehouse = f"file://{Path(tempfile.gettempdir()) / 'synapseone-lakehouse'}"
        return cls(
            catalog_uri=uri,
            warehouse=warehouse,
            internal_secret=os.getenv("SYNAPSEONE_INTERNAL_SECRET", "")
            or os.getenv("SYNAPSEDX_INTERNAL_SECRET", ""),
            is_prod=os.getenv("NODE_ENV") == "production",
            s3_endpoint=os.getenv("LAKEHOUSE_S3_ENDPOINT", "").strip(),
            s3_access_key=os.getenv("LAKEHOUSE_S3_ACCESS_KEY", ""),
            s3_secret_key=os.getenv("LAKEHOUSE_S3_SECRET_KEY", ""),
            s3_region=os.getenv("LAKEHOUSE_S3_REGION", "us-east-1"),
            max_namespaces=int(os.getenv("LAKEHOUSE_MAX_NAMESPACES", "20")),
            max_tables=int(os.getenv("LAKEHOUSE_MAX_TABLES_PER_NAMESPACE", "100")),
            max_rows_per_append=int(os.getenv("LAKEHOUSE_MAX_ROWS_PER_APPEND", "5000")),
            max_bytes=int(os.getenv("LAKEHOUSE_MAX_BYTES", str(1024 * 1024 * 1024))),
        )

    def validate(self) -> None:
        if not self.is_prod:
            return
        if not self.internal_secret:
            raise RuntimeError("SYNAPSEONE_INTERNAL_SECRET is required in production")
        if not os.getenv("LAKEHOUSE_CATALOG_URI", "").strip():
            raise RuntimeError("LAKEHOUSE_CATALOG_URI is required in production")
        if not os.getenv("LAKEHOUSE_WAREHOUSE", "").strip():
            raise RuntimeError("LAKEHOUSE_WAREHOUSE is required in production")
        if not self.s3_endpoint or not self.s3_access_key or not self.s3_secret_key:
            raise RuntimeError("S3 endpoint and credentials are required in production")


class WriterLockLost(RuntimeError):
    pass


class QuotaExceeded(Exception):
    pass


def _field_type(name: str) -> IcebergType:
    normalized = str(name).lower()
    if normalized in {"string", "text", "json", "uuid"}:
        return StringType()
    if normalized in {"long", "integer", "int", "bigint"}:
        return LongType()
    if normalized in {"double", "number", "float", "decimal"}:
        return DoubleType()
    if normalized in {"boolean", "bool"}:
        return BooleanType()
    if normalized in {"timestamp", "timestamptz", "datetime"}:
        return TimestampType()
    if normalized == "date":
        return DateType()
    raise ValueError(f"unsupported column type '{name}'")


def _schema_from_body(columns: Any) -> Schema:
    if not isinstance(columns, list) or not columns:
        raise ValueError("schema must be a non-empty array")
    fields: list[NestedField] = []
    seen: set[str] = set()
    for index, column in enumerate(columns, start=1):
        if not isinstance(column, dict):
            raise ValueError("each column must be an object")
        name = str(column.get("name", "")).strip()
        if not NAME_RE.match(name):
            raise ValueError(f"invalid column name '{name}'")
        if name in seen:
            raise ValueError(f"duplicate column '{name}'")
        seen.add(name)
        fields.append(
            NestedField(
                field_id=index,
                name=name,
                field_type=_field_type(str(column.get("type", ""))),
                required=bool(column.get("required", False)),
            )
        )
    return Schema(*fields)


def _coerce_value(field_type: IcebergType, value: Any) -> Any:
    if value is None:
        return None
    if isinstance(field_type, StringType):
        return value if isinstance(value, str) else json.dumps(value) if isinstance(value, (dict, list)) else str(value)
    if isinstance(field_type, LongType):
        return int(value)
    if isinstance(field_type, DoubleType):
        return float(value)
    if isinstance(field_type, BooleanType):
        if isinstance(value, bool):
            return value
        return str(value).lower() in {"1", "true", "yes", "on"}
    if isinstance(field_type, DateType):
        return value if isinstance(value, date) and not isinstance(value, datetime) else date.fromisoformat(str(value)[:10])
    if isinstance(field_type, TimestampType):
        if isinstance(value, datetime):
            parsed = value
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    return value


def _rows_for_schema(table_schema: Schema, rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not rows:
        raise ValueError("rows must be a non-empty array")
    if len(rows) > 5000:
        raise ValueError("rows must contain at most 5000 objects")
    allowed = {field.name: field for field in table_schema.fields}
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("each row must be a JSON object")
        unknown = set(row) - set(allowed)
        if unknown:
            raise ValueError(f"unknown column(s): {', '.join(sorted(unknown))}")
        out.append(
            {
                name: _coerce_value(field.field_type, row.get(name))
                for name, field in allowed.items()
            }
        )
    return out


def _tenant(headers: Any) -> tuple[str, str] | None:
    org = (headers.get("x-synapseone-org") or "").strip()
    if org:
        return "org", f"o_{hashlib.sha256(org.encode()).hexdigest()[:24]}"
    account = (headers.get("x-synapseone-account") or "").strip()
    if account:
        return "account", f"a_{hashlib.sha256(account.encode()).hexdigest()[:24]}"
    return None


def _physical(tenant: str, namespace: str) -> tuple[str, ...]:
    if not NAME_RE.match(namespace):
        raise ValueError("namespace must match [a-z][a-z0-9_]{0,40}")
    return (f"{tenant}__{namespace}",)


def _logical_namespace(tenant: str, identifier: Any) -> str | None:
    parts = tuple(identifier)
    if len(parts) != 1:
        return None
    prefix = f"{tenant}__"
    if not parts[0].startswith(prefix):
        return None
    return parts[0][len(prefix) :]


def _table_meta(table: Any) -> dict[str, Any]:
    snapshot = table.current_snapshot()
    return {
        "location": table.location(),
        "formatVersion": int(table.metadata.format_version),
        "schema": [
            {
                "id": field.field_id,
                "name": field.name,
                "type": str(field.field_type).lower(),
                "required": bool(field.required),
            }
            for field in table.schema().fields
        ],
        "currentSnapshotId": str(snapshot.snapshot_id) if snapshot else None,
        "snapshotCount": len(table.snapshots()),
        "properties": dict(table.properties),
    }


def _snapshot_bytes(table: Any) -> int:
    snapshot = table.current_snapshot()
    if snapshot is None or snapshot.summary is None:
        return 0
    raw = (snapshot.summary.additional_properties or {}).get("total-files-size", "0")
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def _tenant_bytes(catalog: Any, tenant: str) -> int:
    total = 0
    for identifier in catalog.list_namespaces():
        logical = _logical_namespace(tenant, identifier)
        if logical is None:
            continue
        for table_identifier in catalog.list_tables(identifier):
            try:
                table = catalog.load_table(table_identifier)
                total += _snapshot_bytes(table)
            except Exception:  # noqa: BLE001 - a damaged table must not hide the rest
                continue
    return total


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings.from_env()
    config.validate()
    props = {
        "uri": config.catalog_uri,
        "warehouse": config.warehouse,
    }
    if config.s3_access_key:
        props.update(
            {
                "s3.endpoint": config.s3_endpoint,
                "s3.access-key-id": config.s3_access_key,
                "s3.secret-access-key": config.s3_secret_key,
                "s3.region": config.s3_region,
                "s3.force-virtual-addressing": "false",
            }
        )
    catalog = SqlCatalog("synapseone_lakehouse", **props)
    catalog_lock = threading.RLock()
    # The SQL catalog itself has no cross-process writer lease. Enforce a
    # single active writer with a session-scoped Postgres advisory lock; the
    # lock is released automatically if the process dies.
    writer_lock_connection = None
    if config.catalog_uri.startswith("postgresql"):
        from sqlalchemy import create_engine, text

        lock_engine = create_engine(config.catalog_uri, pool_pre_ping=True)
        writer_lock_connection = lock_engine.connect()
        acquired = writer_lock_connection.execute(
            text("select pg_try_advisory_lock(hashtext('synapseone_lakehouse_single_writer'))")
        ).scalar()
        if not acquired:
            writer_lock_connection.close()
            raise RuntimeError(
                "another Lakehouse writer holds the PostgreSQL advisory lock; "
                "drain the old replica before starting a new one"
            )
    writer_lock_state = {"lost": False}

    def assert_writer_lock() -> None:
        """Fail closed when the catalog writer lease is no longer provable.

        The session-scoped advisory lock is released automatically if its
        PostgreSQL connection dies. A process that keeps writing after that
        could race a replacement replica, so every mutation re-checks the
        dedicated lock connection before touching the catalog.
        """
        if writer_lock_connection is None:
            return
        if writer_lock_state["lost"]:
            raise WriterLockLost("the Lakehouse writer lock connection is lost")
        from sqlalchemy import text as sql_text

        try:
            with catalog_lock:
                writer_lock_connection.execute(sql_text("select 1"))
        except Exception as exc:  # noqa: BLE001 - mark the writer unhealthy
            writer_lock_state["lost"] = True
            raise WriterLockLost("the Lakehouse writer lock connection is lost") from exc

    metrics = {"appends": 0, "queries": 0, "errors": 0, "requests": 0}

    app = FastAPI(title="Synapse Lakehouse", version=VERSION, docs_url=None, redoc_url=None)
    # Keep the advisory-lock connection alive for the process lifetime.
    app.state.writer_lock_connection = writer_lock_connection

    @app.middleware("http")
    async def guard(request: Request, call_next):
        metrics["requests"] += 1
        path = request.url.path
        if path in {"/health", "/ready", "/metrics"}:
            return await call_next(request)
        if path.startswith("/v1/") or path.startswith("/internal/"):
            if config.internal_secret:
                supplied = request.headers.get("x-synapseone-internal", "")
                if supplied != config.internal_secret:
                    return JSONResponse({"error": "unauthorized"}, status_code=401)
            elif config.is_prod:
                return JSONResponse(
                    {"error": "misconfigured", "message": "internal secret required in production"},
                    status_code=500,
                )
            tenant = _tenant(request.headers)
            if tenant is None:
                return JSONResponse(
                    {"error": "tenant_scope_required", "message": "org or account headers required"},
                    status_code=403,
                )
            request.state.tenant = tenant[1]
            request.state.tenant_kind = tenant[0]
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse({"error": "payload_too_large"}, status_code=413)
        response = await call_next(request)
        response.headers.setdefault("x-content-type-options", "nosniff")
        response.headers.setdefault("cache-control", "no-store")
        return response

    def fail(exc: Exception) -> JSONResponse:
        metrics["errors"] += 1
        if isinstance(exc, (NoSuchNamespaceError, NoSuchTableError)):
            return JSONResponse({"error": "not_found", "message": str(exc)}, status_code=404)
        if isinstance(exc, (NamespaceAlreadyExistsError, TableAlreadyExistsError)):
            return JSONResponse({"error": "already_exists", "message": str(exc)}, status_code=409)
        if isinstance(exc, NamespaceNotEmptyError):
            return JSONResponse({"error": "namespace_not_empty", "message": str(exc)}, status_code=409)
        if isinstance(exc, QuotaExceeded):
            return JSONResponse({"error": "quota_exceeded", "message": str(exc)}, status_code=409)
        if isinstance(exc, CommitFailedException):
            return JSONResponse({"error": "commit_conflict", "message": str(exc)}, status_code=409)
        if isinstance(exc, WriterLockLost):
            return JSONResponse({"error": "writer_lock_lost", "message": str(exc)}, status_code=503)
        if isinstance(exc, (ValidationError, ValueError)):
            return JSONResponse({"error": "invalid_request", "message": str(exc)}, status_code=400)
        return JSONResponse({"error": "internal", "message": "lakehouse operation failed"}, status_code=500)

    def tenant_of(request: Request) -> str:
        return request.state.tenant

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "service": "lakehouse",
            "version": VERSION,
            "storage": "s3" if config.warehouse.startswith("s3://") else "file",
        }

    @app.get("/ready")
    def ready():
        try:
            assert_writer_lock()
            with catalog_lock:
                catalog.list_namespaces()
            return {"ok": True, "status": "ready", "writerLock": "held" if writer_lock_connection is not None else "not-configured"}
        except Exception as exc:  # noqa: BLE001 - readiness must report failure
            return JSONResponse({"ok": False, "status": "degraded", "error": str(exc)}, status_code=503)

    @app.get("/metrics", response_class=PlainTextResponse)
    def prometheus():
        return "\n".join(
            [
                "# HELP synapseone_lakehouse_up Service is running.",
                "# TYPE synapseone_lakehouse_up gauge",
                "synapseone_lakehouse_up 1",
                "# TYPE synapseone_lakehouse_requests_total counter",
                f"synapseone_lakehouse_requests_total {metrics['requests']}",
                "# TYPE synapseone_lakehouse_appends_total counter",
                f"synapseone_lakehouse_appends_total {metrics['appends']}",
                "# TYPE synapseone_lakehouse_queries_total counter",
                f"synapseone_lakehouse_queries_total {metrics['queries']}",
                "# TYPE synapseone_lakehouse_errors_total counter",
                f"synapseone_lakehouse_errors_total {metrics['errors']}",
                "",
            ]
        )

    @app.get("/v1/lakehouse/namespaces")
    def list_namespaces(request: Request):
        tenant = tenant_of(request)
        try:
            with catalog_lock:
                names = [
                    logical
                    for identifier in catalog.list_namespaces()
                    if (logical := _logical_namespace(tenant, identifier))
                ]
            return {"items": sorted(names)}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.get("/v1/lakehouse/usage")
    def usage(request: Request):
        tenant = tenant_of(request)
        try:
            with catalog_lock:
                namespaces = [
                    logical
                    for identifier in catalog.list_namespaces()
                    if (logical := _logical_namespace(tenant, identifier))
                ]
                tables = 0
                for name in namespaces:
                    tables += len(catalog.list_tables(_physical(tenant, name)))
            return {
                "namespaces": len(namespaces),
                "tables": tables,
                "maxNamespaces": config.max_namespaces,
                "maxTablesPerNamespace": config.max_tables,
                "maxRowsPerAppend": config.max_rows_per_append,
                "bytes": _tenant_bytes(catalog, tenant),
                "maxBytes": config.max_bytes,
                "bytesQuotaEnforced": config.max_bytes > 0,
                "bytesBasis": "current snapshot total-files-size; excludes historical snapshots and orphans",
            }
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.post("/v1/lakehouse/namespaces", status_code=201)
    def create_namespace(request: Request, body: dict = Body(...)):
        tenant = tenant_of(request)
        assert_writer_lock()
        name = str(body.get("name", "")).strip().lower()
        try:
            physical = _physical(tenant, name)
            with catalog_lock:
                existing = [
                    logical
                    for identifier in catalog.list_namespaces()
                    if (logical := _logical_namespace(tenant, identifier))
                ]
                if len(existing) >= config.max_namespaces:
                    raise QuotaExceeded(
                        f"tenant namespace quota reached ({config.max_namespaces})"
                    )
                catalog.create_namespace(physical)
            return {"name": name, "created": True}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.delete("/v1/lakehouse/namespaces/{namespace}")
    def delete_namespace(request: Request, namespace: str):
        tenant = tenant_of(request)
        assert_writer_lock()
        try:
            with catalog_lock:
                catalog.drop_namespace(_physical(tenant, namespace.lower()))
            return {"name": namespace, "deleted": True}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.get("/v1/lakehouse/namespaces/{namespace}/tables")
    def list_tables(request: Request, namespace: str):
        tenant = tenant_of(request)
        try:
            physical = _physical(tenant, namespace.lower())
            with catalog_lock:
                tables = [identifier[-1] for identifier in catalog.list_tables(physical)]
            return {"items": sorted(tables)}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.post("/v1/lakehouse/namespaces/{namespace}/tables", status_code=201)
    def create_table(request: Request, namespace: str, body: dict = Body(...)):
        tenant = tenant_of(request)
        assert_writer_lock()
        name = str(body.get("name", "")).strip().lower()
        try:
            if not NAME_RE.match(name):
                raise ValueError("table name must match [a-z][a-z0-9_]{0,40}")
            schema = _schema_from_body(body.get("schema"))
            physical = _physical(tenant, namespace.lower())
            with catalog_lock:
                existing = catalog.list_tables(physical)
                if len(existing) >= config.max_tables:
                    raise QuotaExceeded(f"table quota reached ({config.max_tables})")
                table = catalog.create_table(physical + (name,), schema=schema)
                meta = _table_meta(table)
            return {"namespace": namespace, "name": name, **meta}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.get("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}")
    def table_metadata(request: Request, namespace: str, table_name: str):
        tenant = tenant_of(request)
        try:
            with catalog_lock:
                table = catalog.load_table(_physical(tenant, namespace.lower()) + (table_name.lower(),))
                meta = _table_meta(table)
            return {"namespace": namespace, "name": table_name, **meta}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.delete("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}")
    def delete_table(request: Request, namespace: str, table_name: str):
        tenant = tenant_of(request)
        assert_writer_lock()
        try:
            with catalog_lock:
                # drop_table removes the catalog pointer only. Data files are
                # retained (no purge) so a mistaken drop never deletes bytes.
                catalog.drop_table(_physical(tenant, namespace.lower()) + (table_name.lower(),))
            return {
                "namespace": namespace,
                "name": table_name,
                "deleted": True,
                "dataFilesRetained": True,
            }
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.post("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}/rows", status_code=201)
    def append_rows(request: Request, namespace: str, table_name: str, body: dict = Body(...)):
        tenant = tenant_of(request)
        assert_writer_lock()
        try:
            import pyarrow as pa

            physical = _physical(tenant, namespace.lower()) + (table_name.lower(),)
            key = str(body.get("idempotencyKey", "")).strip()[:200]
            if isinstance(body.get("rows"), list) and len(body["rows"]) > config.max_rows_per_append:
                raise QuotaExceeded(
                    f"rows per append exceeds quota ({config.max_rows_per_append})"
                )
            with catalog_lock:
                table = catalog.load_table(physical)
                if key:
                    for snapshot in table.snapshots():
                        summary = snapshot.summary
                        if summary and summary.get("synapseone.idempotency-key") == key:
                            return {
                                "ok": True,
                                "duplicate": True,
                                "snapshotId": str(snapshot.snapshot_id),
                                "rows": 0,
                            }
                rows = _rows_for_schema(table.schema(), body.get("rows"))
                if config.max_bytes > 0:
                    estimated = len(
                        json.dumps(rows, separators=(",", ":"), default=str).encode("utf-8")
                    )
                    # Conservative pre-write guard; the exact Parquet size is
                    # only known after the write. Historical snapshots and
                    # orphan files are intentionally outside this estimate.
                    current = _tenant_bytes(catalog, tenant)
                    if current + estimated > config.max_bytes:
                        raise QuotaExceeded(
                            f"tenant byte quota would be exceeded (current={current}, "
                            f"estimated={estimated}, limit={config.max_bytes})"
                        )
                arrow = pa.Table.from_pylist(rows, schema=table.schema().as_arrow())
                properties = {"synapseone.idempotency-key": key} if key else {}
                table.append(arrow, snapshot_properties=properties)
                table = catalog.load_table(physical)
                snapshot = table.current_snapshot()
            metrics["appends"] += 1
            return {
                "ok": True,
                "duplicate": False,
                "snapshotId": str(snapshot.snapshot_id) if snapshot else None,
                "rows": len(rows),
            }
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.post("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}/query")
    def query_rows(request: Request, namespace: str, table_name: str, body: dict = Body(...)):
        tenant = tenant_of(request)
        try:
            limit = int(body.get("limit", 1000))
            limit = max(1, min(limit, 5000))
            snapshot_id = body.get("snapshotId")
            if snapshot_id is not None:
                snapshot_id = int(snapshot_id)
            with catalog_lock:
                table = catalog.load_table(_physical(tenant, namespace.lower()) + (table_name.lower(),))
                scan = table.scan(snapshot_id=snapshot_id, limit=limit)
                arrow = scan.to_arrow()
                current = table.current_snapshot()
            metrics["queries"] += 1
            return {
                "rows": jsonable_encoder(arrow.to_pylist()),
                "rowCount": arrow.num_rows,
                "limit": limit,
                "snapshotId": str(snapshot_id)
                if snapshot_id is not None
                else (str(current.snapshot_id) if current else None),
                "columns": arrow.column_names,
            }
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.get("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}/maintenance")
    def maintenance_report(request: Request, namespace: str, table_name: str):
        tenant = tenant_of(request)
        try:
            with catalog_lock:
                table = catalog.load_table(
                    _physical(tenant, namespace.lower()) + (table_name.lower(),)
                )
                snapshot = table.current_snapshot()
                return {
                    "namespace": namespace,
                    "name": table_name,
                    "physicalCleanup": "disabled",
                    "reason": "snapshot expiry/orphan cleanup requires an operator-reviewed Iceberg maintenance job",
                    "snapshotCount": len(table.snapshots()),
                    "currentSnapshotId": str(snapshot.snapshot_id) if snapshot else None,
                    "currentSnapshotBytes": _snapshot_bytes(table),
                    "referencedFilesRetained": True,
                }
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.get("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}/snapshots")
    def list_snapshots(request: Request, namespace: str, table_name: str):
        tenant = tenant_of(request)
        try:
            with catalog_lock:
                table = catalog.load_table(_physical(tenant, namespace.lower()) + (table_name.lower(),))
                snapshots = [
                    {
                        "snapshotId": str(snapshot.snapshot_id),
                        "parentSnapshotId": str(snapshot.parent_snapshot_id)
                        if snapshot.parent_snapshot_id is not None
                        else None,
                        "timestampMs": snapshot.timestamp_ms,
                        "operation": snapshot.summary.operation.value
                        if snapshot.summary
                        else "",
                        "summary": dict(snapshot.summary.additional_properties or {})
                        if snapshot.summary
                        else {},
                    }
                    for snapshot in table.snapshots()
                ]
            return {"items": snapshots}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    @app.post("/v1/lakehouse/namespaces/{namespace}/tables/{table_name}/schema")
    def evolve_schema(request: Request, namespace: str, table_name: str, body: dict = Body(...)):
        tenant = tenant_of(request)
        assert_writer_lock()
        try:
            additions = body.get("add")
            if not isinstance(additions, list) or not additions:
                raise ValueError("add must be a non-empty array")
            with catalog_lock:
                table = catalog.load_table(_physical(tenant, namespace.lower()) + (table_name.lower(),))
                with table.update_schema() as update:
                    for column in additions:
                        if not isinstance(column, dict):
                            raise ValueError("each added column must be an object")
                        name = str(column.get("name", "")).strip()
                        if not NAME_RE.match(name):
                            raise ValueError(f"invalid column name '{name}'")
                        update.add_column(
                            name,
                            _field_type(str(column.get("type", ""))),
                            required=bool(column.get("required", False)),
                        )
                table = catalog.load_table(_physical(tenant, namespace.lower()) + (table_name.lower(),))
                meta = _table_meta(table)
            return {"ok": True, **meta}
        except Exception as exc:  # noqa: BLE001
            return fail(exc)

    return app


app = create_app()
