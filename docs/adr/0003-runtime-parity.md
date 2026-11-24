# ADR 0003 — Production runtime parity

- **Status:** Accepted — Rust suites run and pass for the current release candidate; TS remains a reference.
- **Date:** 2026-11-23 (updated 2026-11-24)
- **Owners:** Platform Engineering

## Context

Ten services have both TypeScript reference sources and Rust/Axum production
binaries. The Dockerfiles build Rust; the `dev` scripts and `make test` run the
TypeScript implementation. A change can therefore pass the default local test
loop while shipping different code.

## Decision

1. **The Rust binary is the authoritative production runtime** for gateway,
   base, faststore, queue, stream, lds, ocs, notifications, ai and warehouse.
2. TypeScript sources remain a behavioural reference until the Rust test/API
   contract coverage is sufficient; they must not be presented as verification
   of the shipped binary.
3. CI must run both `cargo test` for the Rust services and the TypeScript/Python/
   Go suites. A green `make test` alone is not a data-plane release gate.
4. New endpoints and semantic changes must be implemented in the Rust runtime
   first, with contract tests. The TypeScript reference is updated only when it
   is still needed for developer utility.
5. Removing the TypeScript runtime paths is a follow-up, not a mass rewrite.

## Consequences

- Short term, fixes may need to be applied twice; reviewers must check both.
- Release notes must say which runtime was tested.
- For this release candidate the Rust binaries were compiled and their suites
  ran: gateway 47, base 53, faststore 30, queue 30, stream 11, LDS 12, OCS 23,
  notifications 15, warehouse 40, AI 5 (266 total). Warehouse links the pinned
  official DuckDB 2.0.0 shared library so the test/image build is
  resource-bounded.
- The TypeScript directories are retained as a compact contract oracle for
  developer utility; they are not a second production implementation, are not
  copied into images, and must not receive new features ahead of the Rust
  runtime.
- `make test` alone still does not certify Rust; `make test-rust` and the CI
  Rust matrix remain the release gate.
