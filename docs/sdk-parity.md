<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->
# SDK service parity

All four SDKs cover the platform's gateway-routed service groups. They do not
expose every endpoint through an identical convenience method. Use the generic
request method for a route that does not have a wrapper yet:
`client.call` (JavaScript), `client.call` (Python), `Client.Call` (Go), or
`client.client().request` (Rust). Standalone SynapseDNS and Synapse Tunnel APIs
are currently demonstrated with direct HTTP because gateway integration is
pending.

| Area | JavaScript / TypeScript | Python | Go | Rust |
| --- | --- | --- | --- | --- |
| IAM | Full namespace, including usage analytics | Usage analytics not wrapped | Usage analytics not wrapped; some API-key/SCIM options are narrower | Usage analytics not wrapped |
| Workflow | Runners, human tasks, secrets, cancellation, `expectedRevision` | Runners, human tasks, secrets, cancellation; no `expectedRevision` | Core workflows/executions/human tasks/secrets; runners and revision preconditions use `Call` | Runners, human tasks, secrets; cancellation/revision preconditions use `request` |
| Base | Typed mapping, graph/GIS, paged reads | Typed mapping, graph/GIS | Typed mapping, documents/vector search; graph/GIS use `Call` | Documents, graph/GIS; raw `data` writes rather than typed model mapping |
| Search | `client.search` | `client.base.search_*` | `Client.Search*` | `client.base().search_*` |
| Lakehouse | Namespaces, tables, append/query, snapshots, evolution | Same | Same | Same |
| SynapseDNS | Direct HTTP zone/record API; no typed wrapper | Direct HTTP; no typed wrapper | Direct HTTP; no typed wrapper | Direct HTTP; no typed wrapper |
| Synapse Tunnel | Direct HTTP connector/route API; connector CLI | Direct HTTP; no typed wrapper | Direct HTTP; no typed wrapper | Direct HTTP; no typed wrapper |
| Inference streaming | Incremental SSE iterator | Incremental SSE iterator | No SSE iterator; `Stream: true` is not a supported convenience path | `chat_stream` buffers the complete SSE body |
| Legacy flat aliases | Supported alias list only; namespaced API is canonical | Deprecated flat aliases forward to namespaces | Flat methods are the primary Go API | Low-level and namespaced handles |

## Compatibility rules

- A missing convenience wrapper does not mean the service endpoint is absent.
  The generic escape hatch uses the same authentication, redirect, timeout,
  retry and error handling as typed methods.
- Queue delivery remains at-least-once in every language. Consumers must be
  idempotent and acknowledge only after durable processing.
- Warehouse SQL is read-only for tenant queries and keeps external access
  disabled. Lakehouse owns Iceberg metadata/data; Warehouse only materializes
  it.
- New methods are added in patch releases when they are additive. A document
  must name the exact method/route it demonstrates and must not claim parity
  that the implementation does not provide.

See [sdk-0.10.2.md](sdk-0.10.2.md) for versions/tags and
[services/](services/README.md) for per-service examples.
