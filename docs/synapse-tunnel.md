<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

# Synapse Tunnel

Synapse Tunnel is a standalone Tier-1 edge capability for publishing HTTP
applications that run behind NAT, firewalls, or private networks. It is not wired
to Tier-2/3 applications yet.

## Cloudflare-style connection flow

1. Open **Synapse Tunnel** in the organization Console at `/tunnel` and choose
   **Create tunnel**.
2. Enter the local application URL, for example `http://localhost:3000`.
3. Add the public hostname. Choose SynapseDNS to create an A/AAAA/CNAME record in
   an existing zone, or External DNS to create the record at your provider.
4. Save the one-time connector token and run the displayed `synapseone` command
   on the machine that runs the application.
5. Watch the connector change from **Disconnected** to **Connected** in Console.
   Live status refreshes every five seconds.

```bash
npm install -g @synapseone/cli@latest
read -rsp "Connector token: " SYNAPSETUNNEL_CONNECTOR_TOKEN; echo
export SYNAPSETUNNEL_CONNECTOR_TOKEN
synapseone tunnel run <connector-id> --server-url https://tunnel.example.com
```

The CLI opens only an outbound WebSocket. No inbound listener is required on the
application machine. `--token-file` is also available for a root-only token file.
The connector ID is a label; the secret token authenticates the connection.

Console calls `/v1/tunnel/*` through the gateway with the signed-in organization
credential. Scoped API keys need `tunnel:read` or `tunnel:write`. The gateway
enforces scopes and stamps verified organization identity plus the internal
shared secret; Tunnel validates that secret and stores `orgId` on every connector.
Routes inherit ownership from their connector, and cross-organization access
returns `404`. Admin/connector tokens are never stored in browser storage.

Platform operators retain direct admin-token access and the separate
`/v1/platform/edge/tunnel/*` namespace for global operations. Existing version-1
connectors migrate to version 2 as platform-owned (`orgId=null`); new connectors
always belong to the authenticated organization. DNS management uses the
organization-scoped `/v1/dns/*` namespace.

Set `SYNAPSETUNNEL_PUBLIC_ORIGIN=https://tunnel.example.com` on the server so
Console can render the correct CLI command. This must be an HTTP(S) origin without
a path, query, credentials or fragment. Public HTTPS/WSS termination and per-host
TLS certificates are still operator responsibilities; the service does not issue
certificates.

## Components

| Component | Default port | Responsibility |
| --- | ---: | --- |
| Control plane | `4015` | Connector/route CRUD, admin authentication, persistent JSON store |
| Public ingress | `4016` | Host/path routing, HTTP forwarding, connector WebSocket endpoint |
| Connector | none | Outbound-only WebSocket to the ingress; forwards to a local HTTP upstream |

The default container runs the control plane and ingress together. The same image
runs the connector with `node dist/connector.js`.

## Request path

```text
Client
  -> Synapse Tunnel ingress
  -> authenticated connector WebSocket
  -> local application upstream
```

The connector opens no inbound listener. Management endpoints require
`Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN`. Connector bearer tokens are
returned once and only their SHA-256 hashes are stored.

## Standalone deployment

```bash
export SYNAPSETUNNEL_ADMIN_TOKEN="$(openssl rand -hex 32)"
docker compose -f docker-compose.tunnel.yml up -d --build
```

The Compose file binds the management API and ingress to loopback by default. For
a deliberately public HTTP demo, set `SYNAPSETUNNEL_INGRESS_BIND_IP` to the server
IP and advertise the same origin with `SYNAPSETUNNEL_PUBLIC_ORIGIN`, for example
`http://139.162.16.140:18082`. Prefer a trusted TLS reverse proxy and HTTPS/WSS for
production; plain HTTP exposes application traffic and connector tokens to the
network.

Create a connector:

```bash
curl -fsS http://127.0.0.1:4015/v1/connectors \
  -H "Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"city-app","upstreamUrl":"http://127.0.0.1:3000"}'
```

Save the returned `token` securely, then create a route using the returned
connector `id`:

```bash
curl -fsS http://127.0.0.1:4015/v1/routes \
  -H "Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"city-app","hostname":"city.example.com","connectorId":"<id>"}'
```

Run the connector beside the application:

```bash
export SYNAPSETUNNEL_CONNECTOR_TOKEN='st_<token>'
export SYNAPSETUNNEL_SERVER_URL='http://127.0.0.1:18082'
docker run --rm --network host \
  -e SYNAPSETUNNEL_CONNECTOR_TOKEN \
  -e SYNAPSETUNNEL_SERVER_URL \
  synapse-migration/synapse-tunnel:latest node dist/connector.js
```

Test with an explicit Host header:

```bash
curl -fsS -H 'Host: city.example.com' http://127.0.0.1:18082/
```

## Security and limits

- HTTP/SSE streaming is supported; raw WebSocket, TCP, and UDP passthrough are not.
- Tenant management uses `/v1/tunnel` with organization ownership; platform
  operators retain separate `/v1/platform/edge/tunnel` admin routes. Public
  application traffic and connector WebSockets bypass the management gateway and
  use a dedicated HTTPS/WSS reverse proxy.
- The MVP supports one JSON writer and one service instance; it is not HA.
- Request bodies are buffered up to the configured limit. Responses stream with a
  cumulative size cap.
- Public applications must still enforce end-user authentication and authorization.
- Keep the management API private and rotate connector tokens by recreating the
  connector after deleting its routes.

See [`apps/tunnel-service/README.md`](../apps/tunnel-service/README.md) for the
complete API, environment variables, protocol behavior, and test instructions.
