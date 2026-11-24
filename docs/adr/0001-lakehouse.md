# ADR 0001 — Synapse Lakehouse

- **Status:** Accepted — implemented in `apps/lakehouse-service` with explicit limits.
- **Date:** 2026-11-23 (updated 2026-11-24)
- **Owners:** Data Platform / Architecture

## Context

Synapse Warehouse currently provides tenant-scoped DuckDB databases, dataset
tables, read-only SQL, and batch/stream ETL. It is a strong analytical query
engine, but it has no durable open table format, snapshot catalog, schema
evolution, or cross-engine table metadata.

The requested Lakehouse capability needs:

- namespaces and tables;
- Parquet data files;
- transactional metadata/snapshots;
- schema evolution and time travel where supported;
- ingestion from the existing Base → outbox → Stream pipeline;
- query through Warehouse without weakening its tenant SQL sandbox;
- tenant isolation across catalog, object paths, credentials, and quotas.

## Decision

The target design is **Apache Iceberg tables stored as Parquet in SynapseOCS**,
with an **Iceberg REST Catalog** (or a compatible catalog) as metadata authority,
and the existing **DuckDB Warehouse** as the initial query engine.

- Do **not** introduce Spark, Hadoop, or a distributed compute cluster for this
  phase. The current workload and deployment size do not justify it.
- Keep Synapse Warehouse as the query surface. A Lakehouse table must be exposed
  as a read-only DuckDB view/table function behind the same tenant check and SQL
  sandbox.
- Store table data under tenant-scoped OCS prefixes. The catalog must record the
  tenant and never expose raw S3/catalog credentials to tenant APIs.
- Ingestion remains `Base → transactional outbox → Stream → ETL → Lakehouse`.
  Consumers are idempotent and acknowledge only after the table commit.

## Why not a bespoke DuckDB-only “lake”

A local Parquet directory would be durable on one host but would not provide
catalog semantics, concurrent writers, snapshot isolation, or a credible path to
object storage. It would create a second, incompatible storage model and violate
the “preserve existing architecture” constraint.

## Security requirements (blocking)

1. Tenant identity is resolved before any catalog or object path.
2. Table metadata, snapshots, and data files are scoped by organization/account.
3. The Warehouse SQL sandbox remains enabled: `enable_external_access=false`,
   locked configuration, and no replacement-scan/file access.
4. Catalog credentials stay in service configuration, never in tenant responses.
5. Quotas are enforced at OCS and at the catalog layer.
6. Deletion/retention of a table must remove metadata and data files, with an
   auditable tombstone.

## Implemented scope

- Real Iceberg v2 tables, Parquet data files and manifests in the shared
  S3-compatible store, produced by PyIceberg (Apache-2.0).
- SQL catalog in platform Postgres; tenant namespaces are SHA-256-derived and
  never client-selected.
- Append, bounded current/historical scan, snapshots/time travel, additive
  schema evolution, idempotency keys, namespace/table/row quotas.
- Warehouse materializes authorized tables through a trusted internal scan;
  tenant SQL keeps external access disabled.
- Cross-tenant, restart, real-Parquet/metadata and backup/restore tests pass in
  the isolated QA project.

## Known limits

- Unpartitioned append-only tables; no row-level deletes/merges or partition
  evolution API yet.
- One catalog lock per process; concurrent replicas can return
  `409 commit_conflict`.
- Storage-byte quotas are reported but not enforced; use object-store quotas.
- Table drop retains data files; snapshot expiry/orphan cleanup is an operator
  action. A crash between Parquet write and catalog commit can leave orphans.
