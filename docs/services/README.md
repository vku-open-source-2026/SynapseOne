# SynapseOne service SDK guides

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

This directory is the canonical index of copyable, gateway-oriented SDK examples
for every deployed product service. Start with the [API reference](../api.md) for
the HTTP contract and [SDK service parity](../sdk-parity.md) for cross-language
wrapper coverage and escape-hatch rules.

## Guides

| Area | Guide | Primary responsibility |
| --- | --- | --- |
| Gateway | [Gateway](gateway.md) | Public routing, authentication, principal propagation, readiness |
| Edge | [SynapseDNS](dns.md) | Authoritative UDP/TCP DNS and zone/record management |
| Edge | [Synapse Tunnel](tunnel.md) | Outbound-only HTTP application exposure and host/path routing |
| Identity | [IAM](iam.md) | Users, orgs/accounts, roles/policies, keys, service accounts, optional MFA |
| Automation | [Workflow](workflow.md) | Definitions, triggers, executions, human tasks, credentials, secrets |
| Compute | [Workflow runners](workflow-runners.md) | Runner registration, connector health, workflow/inference job protocol |
| AI | [AI assistant](ai-assistant.md) | Natural-language endpoint guidance and draft requests |
| AI | [Inference](inference.md) | Chat, embeddings, decisions, semantic routing, queued inference jobs |
| Linked data | [LDS](lds.md) | Licensed NGSI-LD datasources, attributes, ingestion, public exports |
| Documents | [Base](base.md) | Databases, collections, mapping, queries, concurrency, graph/GIS |
| SynapseSearch | [SynapseSearch](search.md) | Full-text, semantic, and hybrid search over Base documents |
| State | [Faststore](faststore.md) | KV/TTL, counters, data structures, batches, locks |
| Messaging | [Queue](queue.md) | At-least-once work queues, leases, retries, dead letters |
| Messaging | [Stream](stream.md) | Event log, retention, fan-out reads, consumer groups |
| Storage | [OCS](ocs.md) | Buckets, binary objects, presign, multipart uploads |
| Delivery | [Notifications](notifications.md) | Outbox, templates, preferences, retries, delivery status |
| Analytics | [Warehouse](warehouse.md) | DuckDB datasets, read-only SQL, batch/stream ETL |
| Analytics | [Lakehouse](lakehouse.md) | Iceberg namespaces/tables, snapshots, time travel, schema evolution |

## Edge services

- [SynapseDNS](../synapsedns.md) — authoritative DNS and zone/record management.
- [Synapse Tunnel](../synapse-tunnel.md) — outbound-only HTTP application exposure.

## Four-language convention

Every service guide contains the same required structure:

- `## Purpose`
- `## Main gateway routes`
- `## Important semantics and limits`
- `## Authentication and scopes`
- `## SDK usage`

Each `SDK usage` section has exactly four subsections:

- `### JavaScript/TypeScript`
- `### Python`
- `### Go`
- `### Rust`

Examples use environment variables or explicit placeholders instead of real
credentials. They target the public gateway and use typed wrappers whenever the
SDK provides one. A generic request is shown only for genuinely unwrapped routes,
with the real method, path, and body. See [SDK service parity](../sdk-parity.md)
before adding or updating an example.

## Full SDK references

- [JavaScript/TypeScript SDK](../sdk-js.md)
- [Python SDK](../sdk-python.md)
- [Go SDK](../sdk-go.md)
- [Rust SDK](../sdk-rust.md)
- [SDK service parity](../sdk-parity.md)
