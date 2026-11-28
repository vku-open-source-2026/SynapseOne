<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

# ADR 0005 — Standalone SynapseDNS and Synapse Tunnel edge services

Status: Accepted for the OLP MVP; organization-scoped management is integrated with the gateway, while Tier-2/3 application integration remains pending.

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
- Keep DNS wire traffic, Tunnel ingress and connector WebSockets outside the
  management gateway. Expose organization-scoped management through `/v1/dns`
  and `/v1/tunnel`, with gateway scope checks, verified owner-org headers and a
  shared internal secret. Keep separate platform-admin routes for global
  operators.
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
- Zones and connectors carry `orgId`; routes inherit connector ownership and
  cross-organization access returns `404`. Version-1 records migrate as
  platform-owned so existing data is never silently assigned to a tenant.
- Future Tier-2/3 integration may use the organization-scoped APIs while keeping
  public application traffic on a dedicated HTTPS/WSS edge.
