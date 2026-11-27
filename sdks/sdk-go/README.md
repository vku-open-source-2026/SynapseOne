# `synapseone-sdk-go` — SynapseOne SDK for Go (full API coverage)

Apache-2.0. Part of [SynapseOne](../../README.md) Tier-1 PaaS.

Zero external dependencies (standard library only). Requires Go >= 1.22.

## Install

```bash
# via the monorepo replace directive
go mod edit -replace github.com/synapseone/synapseone-sdk-go=./sdks/sdk-go
go mod tidy

# or from the registry
go get github.com/synapseone/synapseone-sdk-go@latest
```

## Quick start

```go
import synapseone "github.com/synapseone/synapseone-sdk-go"

c := synapseone.New("") // defaults to https://synapseone.space (or $SYNAPSEONE_BASE_URL)
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

See **[docs/sdk-go.md](../../docs/sdk-go.md)** for the complete API reference —
client construction, auth, all methods with signatures, parameters, return types, and examples.

Forks: change the `github.com/synapseone/synapseone-sdk-go` module path in `go.mod` to your repo
(Go resolves packages via git tags, no separate registry publish needed).
