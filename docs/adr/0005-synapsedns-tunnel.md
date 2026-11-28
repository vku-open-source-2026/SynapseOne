<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

# ADR 0005 — Standalone SynapseDNS and Synapse Tunnel edge services

Status: Accepted for the OLP MVP; gateway and Tier-2/3 integration pending.

## Context

Tier-1 needs a self-hosted authoritative DNS capability and a way to expose HTTP
applications behind NAT without opening inbound ports on those applications. The
existing SynapseOne gateway routes tenant service APIs and does not yet provide
DNS or application tunnel transport.

## Decision

- Implement SynapseDNS as a standalone authoritative UDP/TCP server with a
  bearer-protected zone/record API.
- Implement Synapse Tunnel as a standalone control plane, HTTP ingress and
  outbound-only WebSocket connector.
- Keep both services outside the existing gateway and Tier-2/3 runtime until
  routing, identity propagation and operational ownership are designed.
- Use one atomic JSON writer per service for the MVP. This favors simple,
  inspectable deployment and deterministic tests over premature HA.
- Publish standalone Compose files and Docker images; bind management APIs to
  loopback by default.

## Consequences

- DNS and tunnel behavior can be demonstrated independently without risking the
  current production gateway or tenant applications.
- The MVP is single-instance: no shared database, DNSSEC, AXFR, raw WebSocket,
  TCP/UDP passthrough, distributed rate limiting or HA.
- Public DNS cutover requires complete record migration, TTL/DS review and a
  rollback plan. Tunnel ingress requires trusted TLS termination before public
  exposure.
- Future integration should route public application traffic through the Tier-1
  gateway or a unified edge control plane, preserving identity, scope, quota and
  audit invariants.
