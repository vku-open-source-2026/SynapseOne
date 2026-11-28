# Roadmap

Current platform release: `0.9.0` (release candidate in this worktree).

## Shipped and verified

- Gateway, IAM (password/OIDC/MFA/API keys/service accounts/policies/audit),
  tenant isolation, platform Super Admin and last-owner protection.
- Base document database + transactional outbox with backoff, quarantine and
  replay; Base Search (full-text/semantic/hybrid/facets/reindex/status).
- Faststore, Queue (leases/retries/DLQ/replay), Stream (groups/acks/range),
  OCS (buckets/objects/multipart/presign/quotas), LDS (NGSI-LD/licences),
  Notifications (outbox/templates/preferences/SSRF guard).
- Workflow DAG engine, queue-backed execution, human tasks with engine-bound
  checkpoints, cancellation, runners and credentials.
- Warehouse datasets, sandboxed read-only SQL, batch/stream ETL, Base snapshot
  ETL and Lakehouse materialization.
- Lakehouse: real Apache Iceberg v2 + Parquet on S3-compatible storage, SQL
  catalog, tenant namespaces, snapshots/time travel, additive schema evolution,
  idempotent appends and quotas.
- Console tenant pages, Search/Warehouse/Lakehouse, platform Super Admin.
- JS/Python/Go/Rust SDKs, single-install CLI, API catalogue and docs.
- Backups for Postgres and object storage with restore drills.

## Current release targets

- Production staging rollout from one commit, with OIDC/DNS/TLS and backups.
- Self-hosted runner fleet + mixed-version rollout verification.
- Notification provider relays and one synthetic end-to-end delivery.
- Off-host backup copy and a separate-host restore drill.
- Optional: Firefox/WebKit browser certification.
- Optional: Lakehouse storage-byte quotas and scheduled snapshot/orphan cleanup.

## Known limitations

- Lakehouse tables are unpartitioned, append-only, Iceberg v2; no row-level
  delete/merge or partition evolution API.
- Lakehouse catalog locking is per process; concurrent replicas may return
  `409 commit_conflict`.
- Base outbox ordering is best-effort; consumers dedupe by event id.
- Queue dedupe is bounded by message retention, not permanent.
- Search is bounded by a 50k-row scan window; no Elasticsearch protocol.
- Warehouse tenant SQL is read-only; DDL/ingestion is through dataset APIs.
- ETL has no OCS-file source yet; streams and snapshots are the supported
  sources.
- Legacy unbound paused workflow executions are not resumable.

## Future / out of scope

- Distributed compute clusters (Spark/Hadoop), new message brokers, managed
  database provisioning marketplaces, or a custom search engine.
- Multi-region active-active control plane.
