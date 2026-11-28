# SynapseOne docs

[Tiếng Việt](vi/README.md) · English

| Guide | Content | Tiếng Việt |
|---|---|---|
| [quickstart.md](quickstart.md) | 3 commands to run, first flow, Authentik/S3/workflow setup | — |
| [architecture.md](architecture.md) | Tier-1 PaaS architecture + technical decisions | — |
| [synapsedns.md](synapsedns.md) | SynapseDNS authoritative server, zone/record API, standalone deployment | — |
| [synapse-tunnel.md](synapse-tunnel.md) | Synapse Tunnel control plane, outbound connector, HTTP ingress and limits | — |
| [business-flows.md](business-flows.md) | Canonical actors, lifecycle, BF-01..BF-22 business rules and traceability | — |
| [iam-model.md](iam-model.md) | Organization/Account/Role/Policy model + tokens + OIDC | — |
| [api.md](api.md) | Full API reference via the gateway | [vi/api.md](vi/api.md) |
| [synapsebase.md](synapsebase.md) | SynapseBase — documents, object↔data mapping, queries, changes | — |
| [faststore.md](faststore.md) | Synapse Faststore — cache, key/value, hashes, lists, sets, locks | — |
| [queue.md](queue.md) | SynapseQueue — publish, consume, leases, retries, dead letters | — |
| [workflow-runners.md](workflow-runners.md) | Runner Engine: workflow/inference/hybrid connectors, network hardening | — |
| [configuration.md](configuration.md) | Environment table for the whole stack | [vi/configuration.md](vi/configuration.md) |
| [object-storage.md](object-storage.md) | SynapseOCS bucket/object API, SeaweedFS backend, object backups | — |
| [notifications.md](notifications.md) | SynapseNotifications — outbox, inline variables, preferences, delivery, retries | — |
| [capability-matrix.md](capability-matrix.md) | Resource-by-resource operation coverage, interfaces and supported limitations | — |
| [lakehouse.md](lakehouse.md) | Apache Iceberg Lakehouse, snapshots, schema evolution and ETL paths | — |
| [troubleshooting.md](troubleshooting.md) | Busy ports, Windows curl, gateway 404s, backup/restore, OIDC errors | — |
| [console.md](console.md) | Management UI (run, configure, SSO, frontend dev) | — |
| [platform-superadmin.md](platform-superadmin.md) | Platform Super Admin dashboard: bootstrap, MFA, platform admins, rollback | [vi/platform-superadmin.md](vi/platform-superadmin.md) |
| [platform-superadmin-login.md](platform-superadmin-login.md) | Provisioned local Platform Owner: login, MFA, modules, recovery, verification | — |
| [hackathon.md](hackathon.md) | VIC Hackathon #1: schedule, rules, prizes, registration API and superadmin review | [vi/hackathon.md](vi/hackathon.md) |
| [ai-assistant.md](ai-assistant.md) | AI testing assistant (agent design, models, limits, chatbot) | — |
| [database-performance.md](database-performance.md) | PgBouncer, Postgres tuning, IAM audit reads, quota metering and Base cache | [vi/database-performance.md](vi/database-performance.md) |
| [monitoring.md](monitoring.md) | Prometheus (run, targets, alerts, useful queries) | — |
| [production.md](production.md) | Production checklist (secrets, TLS, backups, image pinning) | — |
| [authentication-sso.md](authentication-sso.md) | Public SSO/OIDC: activation, security invariants, verification, error reference | — |
| [sdk-js.md](sdk-js.md) | JavaScript/TypeScript SDK — install, auth, full API reference | — |
| [sdk-python.md](sdk-python.md) | Python SDK — install, auth, full API reference | — |
| [sdk-go.md](sdk-go.md) | Go SDK — install, auth, full API reference | — |
| [sdk-rust.md](sdk-rust.md) | Rust SDK — install, authentication, namespaces, retries and errors | — |
| [sdk-parity.md](sdk-parity.md) | Honest per-language service coverage, generic escape hatches and limitations | — |
| [services/](services/) | Per-service guides with JavaScript, Python, Go and Rust SDK examples | — |
| [sdk-0.10.2.md](sdk-0.10.2.md) | SDK 0.10.2 packages, language-specific guides, Go module path and release tags | [vi/sdk-0.10.2.md](vi/sdk-0.10.2.md) |
| [sdk-0.10.1.md](sdk-0.10.1.md) | SDK 0.10.1 packages, release tags and audit consistency | — |
| [cli.md](cli.md) | CLI — install, configuration, all commands | — |
| [adr/](adr/) | Architecture decisions (Lakehouse, search, runtime parity, workflow security) | — |
| [production-readiness.md](production-readiness.md) | Current verification matrix, release blockers and operator prerequisites | — |
| [migration-0.9.0-hardening.md](migration-0.9.0-hardening.md) | Deployment order, migration compatibility and rollback for the hardening pass | — |
| [migration-edge-org.md](migration-edge-org.md) | Organization ownership migration, verification and rollback for DNS/Tunnel | — |
| [migration-synapseone.md](migration-synapseone.md) | Upgrade an existing SynapseDX deployment to SynapseOne 0.9.0 | — |
| [agents/services.md](agents/services.md) | Per-service endpoint, data, rule and environment reference | [vi/agents/services.md](vi/agents/services.md) |
| [org-quota-api-key-ui.md](org-quota-api-key-ui.md) | Quota/API-key feature deployment, verification, limitations and rollback | [vi/org-quota-api-key-ui.md](vi/org-quota-api-key-ui.md) |

Start at [../README.md](../README.md) → [quickstart.md](quickstart.md).
Contributing: [../CONTRIBUTING.md](../CONTRIBUTING.md). K8s operations: [../infra/k8s/README.md](../infra/k8s/README.md).
