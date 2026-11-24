# ADR 0002 — Synapse Search

- **Status:** Accepted — implemented (Base Search is the canonical API).
- **Date:** 2026-11-23 (updated 2026-11-24)
- **Owners:** Search / Data Platform

## Context

SynapseBase already ships a tenant-scoped search index at `/v1/search`:

- full-text, semantic (384-d inference embeddings) and hybrid modes;
- collection and multi-collection filters;
- ACL re-checks against the primary document store;
- reindex and status endpoints;
- Postgres `tsvector`/pgvector indexes with a memory fallback.

The request for Elasticsearch-style search could be satisfied by adding a second
engine (OpenSearch/Elasticsearch/Tantivy). That would add a new stateful service,
a second index lifecycle, a new authorization surface, and substantial memory
cost on the current single-host deployment.

## Decision

**Do not add a second search engine now.** Extend the existing SynapseBase search
index as the single search capability and keep `/v1/search` as its API owner.
This preserves one canonical source of truth and one tenant ACL implementation.

If future requirements exceed the existing engine (large-scale aggregations,
per-field mappings, cross-cluster search), adopt **OpenSearch** behind a new
versioned service and migrate via a rebuildable index. Do not run OpenSearch and
the Base index as competing primary search APIs.

## Gaps versus an Elasticsearch-style product

- no general aggregation/facet API;
- no user-defined mappings or aliases;
- no dedicated indexer/consumer with lag metrics (index writes are best-effort
  plus explicit reindex);
- index scale is bounded by the 50k-row query window and Postgres.

These are documented limitations, not silently claimed features.

## Security requirements

- Tenant/account filters are derived from the verified principal, never trusted
  from a query parameter alone.
- Search snippets and collection names must not leak reserved machine
  collections.
- Reindex is tenant-scoped and rate/size bounded.
- A future OpenSearch deployment must keep backend credentials internal and
  enforce the same ACL checks before returning hits.

## Next steps

1. Add aggregation/facet endpoint only if a concrete product workload requires it.
2. Add indexer lag/error metrics to `/v1/search/status`.
3. Add a rebuild/restore drill against a clean Postgres.
4. Add cross-tenant and deleted-document regression tests.
