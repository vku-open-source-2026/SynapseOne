<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

# Synapse Tunnel

Synapse Tunnel is a standalone Tier-1 edge capability for publishing HTTP
applications that run behind NAT, firewalls, or private networks. It is not wired
to Tier-2/3 applications yet.

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

The Compose file binds the management API and ingress to loopback. Put a trusted
TLS reverse proxy in front before exposing the ingress publicly.

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
- TLS termination, WAF policy, and integration with the existing SynapseOne API
  Gateway are external/future work.
- The MVP supports one JSON writer and one service instance; it is not HA.
- Request bodies are buffered up to the configured limit. Responses stream with a
  cumulative size cap.
- Public applications must still enforce end-user authentication and authorization.
- Keep the management API private and rotate connector tokens by recreating the
  connector after deleting its routes.

See [`apps/tunnel-service/README.md`](../apps/tunnel-service/README.md) for the
complete API, environment variables, protocol behavior, and test instructions.
