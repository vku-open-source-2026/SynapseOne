<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

# SynapseDNS

SynapseDNS is a standalone Tier-1 authoritative DNS service. It answers DNS over
UDP and TCP and exposes a bearer-protected zone/record API. It never performs
recursive resolution or forwards queries.

> **Cutover warning:** the service is not delegated for `synapseone.space` yet.
> Migrate and verify every existing record before changing registrar NS/glue.
> If the registrar has DNSSEC enabled, remove or replace its DS record because
> this MVP does not sign zones. Keep the current provider available during the
> transition.

## Supported behavior

- Record types: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SOA`, `SRV`, `CAA`, `PTR`.
- Longest matching zone, wildcards, empty non-terminals, in-zone CNAME chains.
- `NXDOMAIN` and `NODATA` include the zone SOA; unknown zones return `REFUSED`.
- UDP truncation with `TC`; TCP returns the full answer.
- Atomic mode-0600 JSON persistence; one writer/instance per data file.
- No DNSSEC, AXFR, recursive forwarding, rate limiting, or HA in this MVP.

## Console management

Open **SynapseDNS** in the organization Console at `/dns`. Any signed-in
organization user can manage only that organization's zones; scoped API keys need
`dns:read` or `dns:write`. The page creates SOA/NS records, manages application
records and shows the current SOA serial. The browser never receives
`SYNAPSEDNS_ADMIN_TOKEN` or the gateway internal secret.

The gateway exposes tenant management at `/v1/dns/*`. It authenticates the JWT or
API key, enforces `dns` scopes and stamps the verified organization identity plus
`x-synapseone-internal`. SynapseDNS validates that internal credential before
trusting ownership headers. Cross-organization reads and mutations return `404`.
Anonymous callers are rejected.

Platform operators retain direct admin-token access and the separate
`/v1/platform/edge/dns/*` namespace for global operations. Existing version-1
zones migrate to version 2 as platform-owned (`orgId=null`) and are not exposed to
tenant users; new zones always inherit the authenticated organization.

## Standalone deployment

```bash
export SYNAPSEDNS_ADMIN_TOKEN="$(openssl rand -hex 32)"
export SYNAPSEDNS_BIND_IP=139.162.16.140
docker compose -f docker-compose.dns.yml up -d --build
```

`SYNAPSEDNS_BIND_IP` avoids the host's loopback `systemd-resolved` listener on
port 53. The management API remains bound to loopback.

Create a zone:

```bash
curl -fsS http://127.0.0.1:4014/v1/zones \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"example.test","nameservers":["ns1.example.test","ns2.example.test"]}'
```

Add an A record:

```bash
curl -fsS http://127.0.0.1:4014/v1/zones/example.test/records \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"www.example.test","address":"192.0.2.10","ttl":300}'
```

Query directly:

```bash
dig @139.162.16.140 www.example.test A +norecurse
dig @139.162.16.140 www.example.test AAAA +tcp +norecurse
```

## Operations

- Keep the management API private; it does not terminate TLS.
- Use a high-entropy admin token and protect the JSON volume.
- Authoritative UDP can be used for amplification; add network-level rate
  limiting before broad public exposure.
- Back up the JSON store and monitor `/health` and `/ready`.
- Run one instance per data file. A second DNS instance for HA needs shared or
  replicated storage and is not included yet.

See [`apps/dns-service/README.md`](../apps/dns-service/README.md) for the complete
API, record payloads, environment variables, DNS semantics, and test instructions.
