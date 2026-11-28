# Synapse Tunnel Service

A standalone, self-hosted HTTP reverse tunnel for SynapseOne Tier-2/Tier-3
applications. It has three roles in one Node 20 + TypeScript package:

- **Control plane / management API** on `4015`.
- **Public HTTP ingress** on `4016`, including the authenticated connector
  WebSocket endpoint.
- **Outbound-only connector CLI**, which makes one outbound WebSocket connection
  and forwards requests to a local HTTP upstream.

The default server command runs the API and ingress in one process. Management is
available through the SynapseOne gateway only under the MFA-protected
`/v1/platform/edge/tunnel/*` namespace; public ingress and connector WebSockets
remain separate from the management gateway.

## Architecture

```text
Admin ──Bearer admin token──> Control API :4015 ──> Atomic JSON store
                                                        │
Client ──Host + HTTP───────> Public ingress :4016 ───────┤
                                   │                    │ route lookup
                                   │ versioned WebSocket multiplex
                                   ▼
                         Outbound-only connector
                                   │
                                   ▼
                         Local app behind NAT/firewall
```

The connector authenticates with its bearer token at
`/_synapse/tunnel/connect` (path configurable). The server sends the connector's
ID, validated `upstreamUrl`, and limits in a `welcome` message. Many HTTP
requests then share that socket; each has a unique request ID. Request bodies
are chunked, and response headers/body chunks are streamed back independently,
so one slow SSE response does not block other requests.

Routes match a normalized `Host` (an optional port is ignored) and the longest
enabled path prefix. A prefix is removed before forwarding: route `/api` maps
`/api/items?x=1` to upstream `/items?x=1`, while an exact `/api` maps to `/`. A
configured upstream URL may include a base path, which is prepended.

## Quick start

Requires Node 20 and npm.

```bash
cd apps/tunnel-service
npm install
export SYNAPSETUNNEL_ADMIN_TOKEN='replace-with-a-long-random-admin-secret'
export SYNAPSETUNNEL_DATA_FILE='./data/synapse-tunnel.json'
npm start
```

The admin token is mandatory unless
`SYNAPSETUNNEL_ALLOW_INSECURE=true` is explicitly set outside production. The
insecure switch is intended only for disposable local tests.

Create a connector (the bearer token is returned **exactly once**):

```bash
curl -sS http://127.0.0.1:4015/v1/connectors \
  -H "Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"docs-app","upstreamUrl":"http://127.0.0.1:3000"}'
```

Example response:

```json
{
  "connector": {
    "id": "2d5539ce-7f77-4ec4-a0eb-4b0d8d32dd0f",
    "name": "docs-app",
    "upstreamUrl": "http://127.0.0.1:3000/",
    "enabled": true,
    "connected": false
  },
  "token": "st_<43-url-safe-characters>"
}
```

Save the token securely. Subsequent reads never return it or its hash. Create a
route using the returned connector ID:

```bash
curl -sS http://127.0.0.1:4015/v1/routes \
  -H "Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"docs-app",
    "hostname":"docs.example.com",
    "pathPrefix":"/api",
    "connectorId":"2d5539ce-7f77-4ec4-a0eb-4b0d8d32dd0f",
    "timeoutMs":30000,
    "maxResponseBytes":16777216,
    "rateLimitPerMinute":600
  }'
```

Run the connector beside the local application:

```bash
export SYNAPSETUNNEL_CONNECTOR_TOKEN='st_<token-from-create-response>'
export SYNAPSETUNNEL_SERVER_URL='http://127.0.0.1:4016'
npm run start:connector
```

The connector opens **no inbound listener**. Point DNS for `docs.example.com` at
the ingress, or test locally with an explicit Host header:

```bash
curl -i http://127.0.0.1:4016/api/items?limit=10 \
  -H 'Host: docs.example.com'
```

Changing a connector's `upstreamUrl`, or disabling it, disconnects the active
session. Re-enable it and the connector reconnects to receive the new config.

## Management API

All `/v1` endpoints require `Authorization: Bearer <admin-token>` unless the
explicit non-production insecure mode is active. Request bodies are JSON and
limited to 64 KiB. Errors use
`{"error":"code","message":"human-readable message"}`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness; no authentication |
| `GET` | `/ready` | Readiness and storage mode; no authentication |
| `GET` | `/v1/config` | Advertised public ingress origin, connector path and protocol version; admin authentication required |
| `GET` | `/v1/connectors` | List connectors and live connection status |
| `POST` | `/v1/connectors` | Create `{name, upstreamUrl}`; returns token once |
| `GET` | `/v1/connectors/:id` | Read one connector |
| `PATCH` | `/v1/connectors/:id` | Update `{name?, upstreamUrl?, enabled?}` |
| `DELETE` | `/v1/connectors/:id` | Delete; returns 409 while routes reference it |
| `GET` | `/v1/routes` | List routes |
| `POST` | `/v1/routes` | Create a hostname/path mapping |
| `GET` | `/v1/routes/:id` | Read one route |
| `PATCH` | `/v1/routes/:id` | Update route settings |
| `DELETE` | `/v1/routes/:id` | Delete a route |

Route creation accepts `hostname`, optional `pathPrefix`, `connectorId`, and
optional `name`, `enabled`, `timeoutMs`, `maxResponseBytes`, and
`rateLimitPerMinute`. Duplicate hostname/prefix pairs return 409. Hostnames and
HTTP(S) upstream URLs are validated; URL credentials, fragments, and query
strings are rejected. Loopback/private upstreams are allowed deliberately,
because the connector normally reaches an app on its private network.

Ingress behavior:

| Condition | Status |
| --- | --- |
| Unknown/disabled host route | `404 unknown_host` |
| Connector offline or disabled | `502 connector_offline` |
| No upstream response headers before timeout | `504 request_timeout` |
| Route/client rate limit exceeded | `429 rate_limited` |
| Request/management body too large | `413 request_too_large` |
| Connector at concurrent-request capacity | `503 connector_busy` |

`/health` and `/ready` are reserved on both HTTP listeners. The timeout applies
until upstream response headers arrive; a valid streaming response or SSE stream
may continue beyond it.

## Entrypoints

From this directory, after `npm run build`:

```bash
npm start                 # API + ingress (default, dist/index.js)
npm run start:api         # control plane only (dist/control-plane.js)
npm run start:ingress     # ingress + connector WebSocket only
npm run start:connector   # outbound-only connector CLI
```

For split API/ingress processes, point both at the same JSON file and retain a
single writer (the API). Standalone readers reload the atomically replaced file
before lookups, so route/token changes do not require an ingress restart. The
combined process remains the recommended and tested deployment because it
avoids filesystem coordination entirely.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNAPSETUNNEL_ADMIN_TOKEN` | required | Management bearer token; minimum 32 characters in production |
| `SYNAPSETUNNEL_ALLOW_INSECURE` | `false` | Permit unauthenticated management only outside production; forbidden in production |
| `SYNAPSETUNNEL_API_PORT` | `4015` | Control-plane port (`PORT` fallback) |
| `SYNAPSETUNNEL_INGRESS_PORT` | `4016` | Ingress/WebSocket port (`INGRESS_PORT` fallback) |
| `SYNAPSETUNNEL_HOST` | `0.0.0.0` | Server bind address |
| `SYNAPSETUNNEL_DATA_FILE` | `./data/synapse-tunnel.json` | JSON file; `memory` is allowed only outside production |
| `SYNAPSETUNNEL_WS_PATH` | `/_synapse/tunnel/connect` | Connector WebSocket path |
| `SYNAPSETUNNEL_WS_MAX_PAYLOAD_BYTES` | `1048576` | Maximum WebSocket message size |
| `SYNAPSETUNNEL_MAX_REQUEST_BYTES` | `10485760` | Maximum buffered HTTP request body |
| `SYNAPSETUNNEL_MAX_RESPONSE_BYTES` | `16777216` | Maximum cumulative streamed response body |
| `SYNAPSETUNNEL_REQUEST_TIMEOUT_MS` | `30000` | Time until upstream response headers |
| `SYNAPSETUNNEL_MAX_CONCURRENT_REQUESTS` | `100` | Per-connector in-flight request limit |
| `SYNAPSETUNNEL_RATE_LIMIT_PER_MINUTE` | `600` | Default per-route/client fixed-window limit; `0` disables |
| `SYNAPSETUNNEL_HEARTBEAT_INTERVAL_MS` | `30000` | WebSocket ping/pong health interval |
| `SYNAPSETUNNEL_MAX_BUFFERED_BYTES` | `4194304` | Server WebSocket send high-water mark |
| `SYNAPSETUNNEL_TRUST_PROXY` | `false` | Trust proxy-derived client IP for rate limits/forwarding; enable only behind a sanitizing trusted proxy |
| `SYNAPSETUNNEL_PUBLIC_SCHEME` | `http` | Scheme stamped into `X-Forwarded-Proto` (`http` or `https`) |
| `SYNAPSETUNNEL_PUBLIC_ORIGIN` | unset | Public HTTP(S) origin advertised by `/v1/config` to Console/CLI; no path, query, credentials, or fragment |
| `SYNAPSETUNNEL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `SYNAPSETUNNEL_CONNECTOR_TOKEN` | required for connector | Connector bearer token (`SYNAPSETUNNEL_TOKEN` alias) |
| `SYNAPSETUNNEL_SERVER_URL` | `http://127.0.0.1:4016` | Connector's outbound server base URL |
| `SYNAPSETUNNEL_RECONNECT_DELAY_MS` | `1000` | Connector reconnect base delay with exponential backoff/jitter |

Production is detected by `NODE_ENV=production` or a production value in
`SYNAPSEONE_ENV`, `SYNAPSEDX_ENV`, `APP_ENV`, or `ENVIRONMENT`.

## Docker

Build with the **repository root** as context so the root license/notice bundle
is available:

```bash
docker build \
  -f apps/tunnel-service/Dockerfile \
  -t synapseone/tunnel-service:0.9.0 .
```

Run API and ingress together with a durable volume:

```bash
docker run --rm --name synapse-tunnel \
  -p 4015:4015 -p 4016:4016 \
  -e SYNAPSETUNNEL_ADMIN_TOKEN='replace-with-a-long-random-admin-secret' \
  -v synapse-tunnel-data:/app/data \
  synapseone/tunnel-service:0.9.0
```

Run the connector from the same image beside the app (example uses host
networking so `127.0.0.1:3000` reaches an app on the host):

```bash
docker run --rm --network host \
  -e SYNAPSETUNNEL_CONNECTOR_TOKEN='st_<token>' \
  -e SYNAPSETUNNEL_SERVER_URL='http://127.0.0.1:4016' \
  synapseone/tunnel-service:0.9.0 node dist/connector.js
```

The image's default healthcheck probes both HTTP listeners. A connector-only
container has no listener and must disable that healthcheck. Separate API-only
or ingress-only deployments should similarly use a role-appropriate probe.

## Security model

- Admin authentication fails closed. Production also requires a persistent data
  file and rejects the insecure switch and short admin tokens.
- Connector tokens are 256 random bits. Only SHA-256 hashes are persisted; the
  JSON file is written with mode `0600` using write/fsync/rename. There is no
  pepper or external secret manager in this MVP.
- A connector token grants access to its configured upstream. Protect it like
  any other machine credential and rotate it by deleting/recreating the
  connector after deleting its routes.
- Browser WebSocket upgrades with an `Origin` header are rejected. Messages are
  strictly validated and size-limited; protocol violations close only that
  connector socket.
- Hop-by-hop headers and headers nominated by `Connection` are stripped in both
  directions. Spoofable SynapseOne and forwarding headers are removed at the
  public edge and re-stamped by the trusted server path.
- Logs are structured JSON and contain operational IDs/status only. Tokens,
  authorization/cookie headers, query strings, and raw upstream errors are not
  logged.
- The service does not terminate TLS. Put HTTPS/WSS termination and network
  access controls in front of it. Keep the management port private.

## MVP limitations

- **Raw WebSocket, TCP, and UDP passthrough are not included.** Only HTTP
  request/response tunneling is supported; HTTP `CONNECT` and protocol upgrades
  are rejected/not forwarded.
- One JSON writer and one service instance are supported. There is no database,
  HA, distributed rate limiting, or cross-instance session migration. The file
  is capped at 8 MiB and each collection at 10,000 records.
- Request bodies are buffered up to the configured limit. Responses stream and
  support SSE, but have a cumulative byte cap. `Content-Length` and
  `Content-Encoding` are normalized away because transfer is re-chunked and
  Node fetch decodes compressed upstream bodies; `Set-Cookie` is preserved.
- Reconnects are automatic, but in-flight requests are not retried. Clients
  should handle 502/504 and must not assume exactly-once delivery.
- Public tunneled applications receive ordinary forwarded HTTP headers and must
  enforce their own end-user authentication and authorization.
- The existing SynapseOne gateway, IAM, Compose, and Kubernetes are not wired to
  this service yet.

## Build and test

Build before test; tests execute compiled JavaScript and use real local HTTP and
WebSocket servers:

```bash
npm install
npm run build
npm test
```

The suite covers management auth/CRUD, one-time token return and hashed storage,
atomic persistence and standalone refresh, corrupt-store failure, real connector
WebSocket auth, request forwarding, binary bodies, concurrent multiplexing,
streaming/SSE, response headers, unknown hosts, offline connectors, timeouts,
rate/size limits, protocol message limits, and scheme-relative path isolation.
