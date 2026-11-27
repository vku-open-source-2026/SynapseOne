# `synapseone-sdk-go` — SynapseOne SDK for Go (full API coverage)

Apache-2.0. Part of [SynapseOne](../../README.md) Tier-1 PaaS.

Zero external dependencies (standard library only). Requires Go >= 1.22.

## Install

```bash
# install the tagged module from the public Go proxy
go get github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go@latest
```

For local development, run this from a checkout and then tidy your application:

```bash
go mod edit -replace github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go=./sdks/sdk-go
go mod tidy
```

## Quick start

```go
import synapseone "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"

c := synapseone.New("") // defaults to https://api.synapseone.space (or $SYNAPSEONE_BASE_URL)
out, err := c.Login("demo@acme.local", "acme")
if err != nil { panic(err) }
c.SetToken(out["accessToken"].(string))
orgs, err := c.ListOrgs()
```

Full coverage: auth (login/refresh/logout/logout-all/verify/me), orgs, accounts,
users, roles, policies, authorize + dry-run, audit, API keys (+verify), service
accounts (+token), workflows (list/get/create from template or raw/activate/
deactivate/execute), templates, executions, LDS.

Data services & AI:

- **SynapseBase** — `Client.*Base*` methods plus the generic
  `NewBaseCollection[T]` typed collection with object↔data mapping.
- **Synapse Faststore** — `Client.Faststore*` for KV, counters, hashes, lists,
  sets, sorted sets, scans, batches and distributed locks.
- **SynapseQueue** — `Client.*Queue*` for publish (delay/dedupe), consume,
  ack/nack/heartbeat, dead letters and replay.
- **Synapse AI Assistant** — `Client.AIAgent` for natural language API endpoint guidance.
- **Synapse Inference Engine** — `Client.Inference*` for LLM chat proxy,
  self-hosted embeddings, Decision-2.0-Eos-0.8B structured questions and semantic routing.
- **SynapseStream** — `Client.*Stream*` for topics, publish/read, consumer groups,
  acknowledgements and retention.
- **SynapseOCS** — `Client.*Ocs*` and `Client.*Storage*` for buckets, binary
  objects, presign and multipart upload.
- **SynapseNotifications** — `Client.*Notification*` for outbox, templates,
  preferences, unsubscribe and delivery status.
- **Synapse Warehouse** — `Client.*Warehouse*` for datasets, read-only SQL, ETL
  jobs and pipeline status.
- **Synapse Lakehouse** — `Client.*Lakehouse*` for namespaces, tables, append/query,
  snapshots and additive schema evolution.
- **Search and gateway health** — `Client.Search*` and `Client.*Health*`.
- **Runner Engine** — use `Client.Call` against `/v1/workflow-runners` until the
  Go namespace reaches parity with JavaScript, Python and Rust.

Platform callers of Faststore/Queue set the tenant explicitly:

```go
c.SetTenant("acme") // x-synapseone-tenant
```

MFA: `SetupTOTP`, `EnableTOTP`, `VerifyMFA` (after a `401 mfa_required` login),
`MFAStatus`, `RegenerateRecoveryCodes`, `DisableMFA`, and for org admins
`ResetUserMFA` / `UnlockUser`.

## Redirects, timeouts and response limits

- Redirects are handled manually by the SDK. Same-origin redirects keep
  `Authorization`, `X-API-Key`, cookies and tenant headers. Cross-origin
  redirects are refused unless the target origin is listed in
  `Client.TrustedRedirectOrigins` (or `SYNAPSEONE_TRUSTED_REDIRECT_ORIGINS`),
  and are then sent **without** credentials. Refusals return `*APIError` with
  `Code == "redirect_not_allowed"` before contacting the target.
- `Client.Timeout` (default 15s) covers redirects, headers and body reads; a
  per-call timeout override wins. The timeout is enforced with a request
  context, so a server that stalls after sending headers cannot hang a caller.
- `MaxJSONBytes` (default 8 MiB) and `MaxBinaryBytes` (default 128 MiB, aligned
  with OCS) are enforced while reading. Overflow returns
  `*ResponseTooLargeError`; it is never silently truncated. A short body with a
  larger `Content-Length` returns a read error. Set a limit to `0` to disable it.
- `MaxRedirects` defaults to 10. The gateway does not redirect normal API
  routes; prefer the canonical HTTPS base URL over relying on HTTP→HTTPS
  redirects (cross-origin and therefore unauthenticated).

## Full documentation

See **[docs/sdk-go.md](../../docs/sdk-go.md)** for the language guide — client
construction, auth, method families, parameters, return types, and examples.
For copyable per-service examples in all four SDK languages, see
[`docs/services/`](../../docs/services/).

Forks: change the `github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go` module path in `go.mod` to your repo
(Go resolves packages via git tags, no separate registry publish needed).
