<!--
SPDX-License-Identifier: Apache-2.0
SPDX-FileCopyrightText: 2026 VKU.VIC
-->

# SynapseDNS

SynapseDNS is a standalone, authoritative-only DNS server with a small bearer-protected management API. It speaks DNS over UDP and TCP, supports the record types needed for an OLP demo, and persists one JSON snapshot without a database. It never performs recursive resolution or forwards queries.

> **Production cutover warning:** do not delegate a domain to the generated `ns1.<zone>` / `ns2.<zone>` names until **all** production records have been migrated and verified with `dig`. Lower TTLs in advance, preserve SOA serial semantics, configure real reachable name servers and glue, and keep the old servers available during the transition. If DNSSEC is enabled at the registrar, remove or replace its DS record because this MVP does not sign zones. The generated NS records are placeholders, not a claim that public delegation or anycast is configured.

## Behavior

- Longest matching configured zone wins. Unknown zones return `REFUSED`; the server never asks an upstream resolver.
- Positive answers and negative answers for known zones set `AA`. `RA` is always clear.
- Missing names return `NXDOMAIN`; existing names without the requested type return `NODATA` (`NOERROR` with no answer). Both include the zone SOA in the authority section.
- Owner names are case-insensitive and stored as lower-case absolute names with a trailing dot.
- Wildcards use closest-encloser semantics, respect exact next-closer names and empty non-terminals, and synthesize the queried owner name.
- In-zone CNAME targets are followed (with loop protection). External CNAME targets are returned but never resolved.
- Non-apex NS owners produce delegation referrals, with in-zone A/AAAA glue when available.
- UDP responses are truncated with `TC` when necessary; TCP returns the complete answer. Normal UDP/TCP answers have parity.
- Zone transfers are refused (`NOTAUTH`). DNSSEC signing, RPZ, views, forwarders, and recursive resolution are not implemented.

## Build and test

Repository baseline: Node 20 and TypeScript. The service pins `dns2` 3.0.0,
which keeps the Node 20 runtime compatible; the newer RFC response-code and type
name helpers are implemented locally in `src/dns-server.ts`. The service has its
own lockfile. Use `--workspaces=false` when installing from this directory so npm
does not treat it as part of the repository-root workspace.

```bash
cd apps/dns-service
npm install --workspaces=false
npm run build
npm test
```

Tests use `node:test` on compiled JavaScript and include real UDP and TCP queries on an OS-assigned port, API CRUD and authorization, validation, persistence/restart, wildcard, NXDOMAIN, NODATA, REFUSED, delegation, CNAME, truncation, and fail-closed production configuration.

### Runtime compatibility

The full suite runs on Node `20.20.2`. `dns2` is pinned to 3.0.0 because 3.1.1
declares Node `>=22`; the service does not rely on 3.1-only APIs.

## Local run

For a loopback-only, unauthenticated demo on unprivileged ports:

```bash
SYNAPSEDNS_DNS_HOST=127.0.0.1 \
SYNAPSEDNS_DNS_PORT=1053 \
SYNAPSEDNS_API_HOST=127.0.0.1 \
SYNAPSEDNS_API_PORT=4014 \
SYNAPSEDNS_DATA_FILE=:memory: \
SYNAPSEDNS_ALLOW_INSECURE=true \
npm start
```

Without `SYNAPSEDNS_ALLOW_INSECURE=true`, a token is required even outside production. If a token is configured, it is always enforced; insecure mode only permits startup without one.

For a persistent local run, set a token instead:

```bash
export SYNAPSEDNS_ADMIN_TOKEN="$(openssl rand -hex 32)"
SYNAPSEDNS_DNS_HOST=127.0.0.1 SYNAPSEDNS_DNS_PORT=1053 \
SYNAPSEDNS_DATA_FILE=./data/synapsedns.json npm start
```

Defaults are DNS `0.0.0.0:53` (UDP and TCP) and API `0.0.0.0:4014`. Binding port 53 needs root or `CAP_NET_BIND_SERVICE`; use a higher port for ordinary local development.

## Docker

Build from the **repository root** so the license/notice copy paths and service paths resolve:

```bash
docker build -f apps/dns-service/Dockerfile -t synapsedns .
docker run --rm --name synapsedns \
  -p 53:53/udp -p 53:53/tcp -p 127.0.0.1:4014:4014 \
  -v synapsedns-data:/app/data \
  -e SYNAPSEDNS_ADMIN_TOKEN="$SYNAPSEDNS_ADMIN_TOKEN" \
  synapsedns
```

The image runs as `node`, grants that binary only `CAP_NET_BIND_SERVICE`, stores data in `/app/data/synapsedns.json`, and health-checks `/ready`. A runtime that strips file capabilities must use `SYNAPSEDNS_DNS_PORT` above 1024 or explicitly retain the bind capability. The image sets `NODE_ENV=production`, so a token of at least 32 characters and persistent storage are mandatory.

## Management API

All `/v1/*` routes require `Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN` unless explicit non-production insecure mode is active. `/health` and `/ready` are public. The API is direct HTTP, not TLS; terminate TLS at a trusted gateway or private network boundary.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness and version |
| `GET` | `/ready` | Readiness; 503 until DNS is listening or if the store becomes unhealthy |
| `GET` | `/v1/zones` | Zone summaries |
| `POST` | `/v1/zones` | Create a zone and its SOA/NS records |
| `GET` | `/v1/zones/:zone` | Get a zone and all records |
| `DELETE` | `/v1/zones/:zone` | Delete a zone |
| `GET` | `/v1/zones/:zone/records` | List records |
| `POST` | `/v1/zones/:zone/records` | Create a record |
| `PATCH` | `/v1/zones/:zone/records/:recordId` | Partially update a record; its type is immutable |
| `DELETE` | `/v1/zones/:zone/records/:recordId` | Delete a record |

Zone paths accept names with or without a trailing dot. JSON request bodies are limited to 32 KiB. Successful creates return `201`; deletes return `204`. Errors use `{ "error": "code", "message": "...", "requestId": "..." }`; validation errors may include field details.

### Create a zone

```bash
curl -sS -X POST http://127.0.0.1:4014/v1/zones \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"example.test","nameservers":["ns1.example.test","ns2.example.test"],"ttl":300}'
```

Creation installs one apex SOA and one apex NS per requested name server. Defaults are `ns1.<zone>.`, `ns2.<zone>.`, SOA primary `ns1.<zone>.`, admin `hostmaster.<zone>.`, refresh 3600, retry 900, expiration 604800, and minimum/default TTL 300. Add A/AAAA glue separately. Non-SOA mutations advance the SOA serial. The apex SOA and last apex NS cannot be deleted.

### Record payloads

Owner `name` values must be absolute names inside the zone (a trailing dot is optional). Wildcards use `*.`. RDATA target names are also absolute but may point outside the zone, which is required for normal CNAME/MX/NS use. TTL is `0..2147483647`; priority/weight/port are `0..65535`.

```json
{"type":"A","name":"www.example.test","ttl":300,"address":"192.0.2.10"}
{"type":"AAAA","name":"www.example.test","address":"2001:db8::10"}
{"type":"CNAME","name":"alias.example.test","target":"www.example.test"}
{"type":"MX","name":"example.test","priority":10,"target":"mail.example.test"}
{"type":"TXT","name":"txt.example.test","data":["v=spf1 -all","second-string"]}
{"type":"NS","name":"sub.example.test","target":"ns.sub.example.test"}
{"type":"SOA","name":"example.test","primary":"ns1.example.test","admin":"hostmaster.example.test","serial":1,"refresh":3600,"retry":900,"expiration":604800,"minimum":300}
{"type":"SRV","name":"_sip._tcp.example.test","priority":1,"weight":2,"port":5060,"target":"sip.example.test"}
{"type":"CAA","name":"example.test","flags":0,"tag":"issue","value":"letsencrypt.org"}
{"type":"PTR","name":"10.2.0.192.in-addr.arpa","target":"www.example.test"}
```

TXT `data` may be a string or an array of character strings; each string is at most 255 UTF-8 bytes. PTR owners must be inside the configured reverse zone. CAA tags are alphanumeric, at most 15 characters, and normalized to lower case. Duplicate owner/type/RDATA is rejected even when TTL differs. A CNAME cannot coexist with other records at the same owner or form a loop.

```bash
# Create, patch, list, and delete
curl -sS -X POST http://127.0.0.1:4014/v1/zones/example.test/records \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"www.example.test","address":"192.0.2.10"}'

curl -sS -X PATCH http://127.0.0.1:4014/v1/zones/example.test/records/RECORD_ID \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"address":"192.0.2.11","ttl":60}'

curl -sS http://127.0.0.1:4014/v1/zones/example.test/records \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN"

curl -sS -X DELETE http://127.0.0.1:4014/v1/zones/example.test/records/RECORD_ID \
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN"
```

## Query with `dig`

Against the loopback development port:

```bash
dig @127.0.0.1 -p 1053 www.example.test A +norecurse
dig @127.0.0.1 -p 1053 www.example.test AAAA +tcp +norecurse
dig @127.0.0.1 -p 1053 example.test SOA +norecurse
dig @127.0.0.1 -p 1053 example.test NS +norecurse
dig @127.0.0.1 -p 1053 missing.example.test A +norecurse       # NXDOMAIN + SOA
dig @127.0.0.1 -p 1053 www.example.test MX +norecurse          # NODATA + SOA
dig @127.0.0.1 -p 1053 www.unknown.test A +norecurse           # REFUSED
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SYNAPSEDNS_DNS_HOST` | `0.0.0.0` | UDP/TCP bind address |
| `SYNAPSEDNS_DNS_PORT` | `53` | Integer `0..65535`; `0` is useful in tests |
| `SYNAPSEDNS_API_HOST` | `0.0.0.0` | Management bind address |
| `SYNAPSEDNS_API_PORT` | `4014` | Integer `0..65535` |
| `SYNAPSEDNS_DATA_FILE` | `./data/synapsedns.json` | Persistent JSON path; `:memory:` is forbidden in production |
| `SYNAPSEDNS_ADMIN_TOKEN` | unset | Required in production (minimum 32 characters) and whenever insecure mode is off |
| `SYNAPSEDNS_ALLOW_INSECURE` | `false` | Only exact `true`; permits no-token startup outside production; rejected in production |
| `SYNAPSEDNS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `SYNAPSEDNS_SHUTDOWN_TIMEOUT_MS` | `15000` | Clamped to `1000..60000` |

`NODE_ENV=production`, `SYNAPSEONE_ENV`, `SYNAPSEDX_ENV`, `APP_ENV`, or `ENVIRONMENT` set to `production`/`prod` enables fail-closed production checks.

The store writes mode-0600 JSON through a fsynced temporary file and atomic rename. It creates the parent directory when needed and aborts startup on corrupt state. A write failure marks the store unhealthy and `/ready` returns 503. Run exactly **one instance per data file**: there is no inter-process lock or database transaction log. Back up the JSON file and retain normal operational monitoring.

## Security and operational notes

- Keep port 4014 private. Put a TLS-capable, authenticating reverse proxy in front of it; this MVP does not implement TLS or gateway/internal-secret integration.
- Use a high-entropy token from a secret manager. Authorization headers and request bodies are never logged. HTTP logs are JSON lines with sanitized request IDs, method, path, status, and duration.
- Never enable insecure mode on a reachable interface. It exists only for local tests.
- Authoritative UDP services can be used for amplification. Restrict ingress to expected resolvers/clients where practical and add network/DNS-level rate limiting before public exposure.
- No DNSSEC, zone transfer, secondary/notify, incremental transfer, latency steering, or multi-process storage is included. CNAME chasing stops at the configured zone boundary.
- SIGTERM/SIGINT stop API acceptance, close DNS listeners, drain the store queue, and exit. Existing DNS TCP clients may remain until their protocol idle timeout during shutdown.
