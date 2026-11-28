# Architecture Decision Records

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-lakehouse.md) | Lakehouse: Iceberg/Parquet on S3-compatible storage with Warehouse materialization | Accepted — implemented with documented limits |
| [0002](0002-search.md) | Search: extend SynapseBase index instead of adding a second engine | Accepted — implemented |
| [0003](0003-runtime-parity.md) | Rust binaries are the production runtime; TypeScript is a reference | Accepted — Rust suites green for this RC |
| [0004](0004-workflow-approval-and-runners.md) | Human tasks and runners enforce engine/account bindings | Accepted — implemented in Phase 1 |
| [0005](0005-synapsedns-tunnel.md) | Standalone SynapseDNS and Synapse Tunnel edge services | Accepted for MVP; gateway/Tier-2/3 integration pending |
