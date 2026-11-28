# `synapseone` CLI — Node 18+

Apache-2.0. Part of [SynapseOne](../../README.md) Tier-1 PaaS. API commands use
Node's built-in `fetch`. The tunnel connector uses the small, pinned `ws` runtime
dependency, installed automatically with the CLI; no separate connector binary
is needed.

## Install

```bash
# one-line installer (installs @synapseone/cli@latest globally)
curl -fsSL https://synapseone.space/install.sh | sh

# ..or from the registry directly:
npm install -g @synapseone/cli@latest

# ..or run without installing anything:
npx -y @synapseone/cli@latest --help

# ..or from source:
node tools/cli/bin/synapseone.js --help
# or link globally:
npm link ./tools/cli   # then call `synapseone ...` anywhere
```

## Quick start

```bash
# Defaults to https://synapseone.space (or pass --base http://localhost:8080 for local dev)
synapseone login --email demo@acme.local
synapseone orgs
synapseone accounts create prod Production
synapseone authz <user-id> workflow:Execute "*" --context team=etl
synapseone workflows create --template webhook-to-log --name demo
synapseone audit --limit 20

# Data plane
synapseone faststore set cache:demo --value '{"ok":true}' --ttl 300
synapseone queue send emails --payload '{"to":"a@b.c"}'
synapseone stream publish telemetry --payload '{"value":25.4}'
synapseone ocs put city-assets map.png --file ./map.png
synapseone notifications send a@b.c --channel email --subject Hi --body Hello
```

For local container development: add `--base http://localhost:8080` (or `export SYNAPSEONE_BASE_URL=http://localhost:8080`).

MFA is disabled by default in the current deployment. If an operator sets
`SYNAPSEONE_MFA_ENABLED=true`, enrolled accounts can use
`synapseone login --email … --password … --code 123456`.
Manage it with `synapseone mfa status|setup|enable|recovery-codes|disable`
(org admins: `mfa reset|unlock <user-id>`).

## Redirects, timeouts and response limits

- Redirects are handled manually. Same-origin redirects keep the
  `Authorization`/`X-API-Key` headers. Cross-origin redirects are refused
  unless the target origin is passed with `--trusted-redirect-origin` (or
  listed in `SYNAPSEONE_TRUSTED_REDIRECT_ORIGINS`); trusted hops are followed
  **without** credentials. Other cross-origin redirects fail before contacting
  the target.
- `--timeout MS` (or `SYNAPSEONE_TIMEOUT_MS`, default 30000) covers
  connection, headers and body reads, so a stalled body exits non-zero instead
  of hanging. `--max-redirects N` / `SYNAPSEONE_MAX_REDIRECTS` defaults to 10.
- JSON responses are capped at 8 MiB and binary downloads at 128 MiB. Override
  with `SYNAPSEONE_MAX_JSON_BYTES` / `SYNAPSEONE_MAX_BINARY_BYTES`; `0` disables
  a cap. Overflow is an explicit error, never a silently truncated file.
- The gateway does not redirect normal API routes; use the canonical HTTPS
  base URL instead of relying on an HTTP→HTTPS redirect (cross-origin, so it
  is unauthenticated even when trusted).

## Synapse Tunnel connector

Run an outbound-only tunnel from a machine that can reach both the local upstream
and the tunnel ingress. The connector opens one authenticated WebSocket to the
ingress and forwards HTTP/HTTPS requests to the upstream configured on the
server. It does **not** open an inbound listening port. Response bodies, including
SSE, stream back without waiting for the upstream response to finish.

```bash
# Store the connector's st_... bearer token with owner-only permissions.
umask 077
printf '%s\n' "$SYNAPSETUNNEL_CONNECTOR_TOKEN" > ./connector.token

# The same installed synapseone command is the connector process.
synapseone tunnel run \
  --token-file ./connector.token \
  --server-url https://tunnel.example.com \
  --reconnect-delay-ms 1000
```

`[connector-id]` is an optional display-only UUID; it never selects or authenticates
a connector. The bearer token selects the server-side connector. Prefer a
`0600` token file or `SYNAPSETUNNEL_CONNECTOR_TOKEN`; `--token` is supported but
discouraged because argv is visible in process listings and shell history.
Tokens are sent only in the WebSocket `Authorization: Bearer ...` handshake and
are never logged.

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Connector token | `--token-file F` (preferred), `--token T` | `SYNAPSETUNNEL_CONNECTOR_TOKEN`, then `SYNAPSETUNNEL_TOKEN` | required |
| Ingress URL | `--server-url URL` | `SYNAPSETUNNEL_SERVER_URL` | `http://127.0.0.1:4016` |
| WebSocket path | — | `SYNAPSETUNNEL_WS_PATH` | `/_synapse/tunnel/connect` |
| Initial reconnect delay | `--reconnect-delay-ms MS` | `SYNAPSETUNNEL_RECONNECT_DELAY_MS` | `1000` ms |
| Log level | — | `SYNAPSETUNNEL_LOG_LEVEL` | `info` |

Explicit flags override environment settings, and `--token-file` takes precedence
over `--token`. Server URLs must be HTTP(S) without embedded credentials, query
strings, or fragments. Reconnects use exponential backoff with jitter. Request
body/response limits, timeouts, and maximum concurrency come from the v1
`welcome` message; oversized bodies, aborted requests, and busy connectors are
reported using the tunnel protocol. Hop-by-hop headers are stripped and redirects
are not followed.

Logs are JSON lines on stderr. Stop with Ctrl-C (`SIGINT`) or `SIGTERM`; the
connector aborts active upstream work and closes the WebSocket cleanly.

```bash
synapseone tunnel run --help
```

## Stable releases

Stable CLI packages are published from `cli-v<version>` tags (for example
`cli-v0.11.1`). The tag must match this package's version. The release workflow
runs the CLI tests, publishes `@synapseone/cli` to npm and verifies the registry
version before the release is considered complete.

## Full documentation

See **[docs/cli.md](../../docs/cli.md)** for the complete CLI reference —
configuration, global flags, all commands with usage, parameters, and examples.
