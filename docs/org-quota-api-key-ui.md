# Organization quotas and API-key control plane

[Tiếng Việt](vi/org-quota-api-key-ui.md) · English

This feature adds tenant-safe organization visibility, metadata-only API-key
management for platform operators, and shared request quotas for `ai`,
`inference` and `workflow`. The English documents under `docs/` are canonical.

## User workflows

### Platform administrator

1. Open **Rate Limits** (`/admin/quotas`) to see global defaults and paged/searchable
   per-organization overrides.
2. Open an organization and use **API Keys**:
   - inspect account, prefix, scopes, owner, created/last-used/expiry timestamps
     and status;
   - choose **New key** or **Rotate**, complete step-up, and copy the secret
     immediately;
   - use **Revoke** for immediate permanent revocation.
3. Open **Quotas** to edit Requests/min, Requests/5h, Requests/day and the
   service-specific token/execution/concurrency fields. Empty means inherit the
   global default. **Reset to default** deletes the service override.

The plaintext key is returned only by create/rotate. It is never stored or
returned by list/detail/resource endpoints; only a hash is persisted. Rotation
uses a conditional `api_keys.rotated_at` transition (0020), so
concurrent rotations have exactly one winner. Grace retirement is capped at
`min(now + graceSeconds, originalExpiresAt)`, while the successor always keeps
the original key's expiry (including no expiry). Creation and rotation responses use
`Cache-Control: noStore`; platform key and quota mutations require single-use
step-up proofs and audit records.

### Tenant user

Open **Quotas** (`/quotas`) for a read-only view of your organization and its
effective limits. The page identifies field-level default/override sources and
shows non-applicable or unlimited dimensions explicitly. It uses:

- `GET /v1/orgs/:orgId`
- `GET /v1/orgs/:orgId/quotas`

IAM applies `canActForOrg`; another tenant receives `403`. Platform and internal
endpoints are not available to tenant credentials. API-key sessions can also use
these reads when their scopes allow IAM reads.

## Quota contract

`org_quotas` has one row per `(org_id, service)` and nullable fields:

- `requests_per_min`, `requests_per_5h`, `requests_per_day`;
- existing `tokens_per_day`, `executions_per_hour`, `concurrent_executions`.

NULL inherits the global default. Effective API responses use camelCase and add
`overridden` plus an `overrides` map for field-level source information.

Request windows are **fixed**:

| Window | Bucket | Reset |
|---|---|---|
| `minute` | `floor(epoch_seconds / 60) * 60` | next epoch minute |
| `fiveHour` | `floor(epoch_seconds / 18000) * 18000` | next epoch five-hour boundary |
| `day` | UTC `YYYY-MM-DD` | next `00:00:00Z` |

They are not sliding windows. Defaults derive `requestsPer5h = requestsPerMin *
300` and `requestsPerDay = requestsPerMin * 1440` when the corresponding env var
is unset. Canonical minute names are `AI_QUOTA_REQUESTS_PER_MIN`,
`INFERENCE_QUOTA_REQUESTS_PER_MIN` and `WORKFLOW_QUOTA_REQUESTS_PER_MIN`.
`AI_RATE_LIMIT` and `INFERENCE_RATE_LIMIT_PER_MIN` remain legacy fallbacks.
Workflow concurrency defaults to 10.

## Admission and outage behavior

The gateway resolves the verified owning org, including service-account JWTs via
IAM's principal verification `org_id`. This is kept in a separate
`attributionOrg`/`attribution_org`: service-account authorization remains
account-bound and does not stamp `x-synapseone-org`. Only the trusted
`x-synapseone-quota-org` header carries attribution to workflow-service. The
gateway fetches IAM effective limits and sends `POST /internal/quota/check` with
`{subject, service, limits:{minute,fiveHour,day}}`. The endpoint is guarded by
`SYNAPSEONE_INTERNAL_SECRET` and has no gateway route.

Central authorization runs before shared org quota is charged. Policy-denied and
authz-unavailable requests consume no request or execution budget. For normal
execute/test-run/inference-job routes, the gateway calls
`POST /internal/workflow/execution/check` before request admission and holds the
returned lease until the proxy request finishes. `/mcp` still participates in
workflow request admission at the edge. Because one JSON-RPC batch can contain up
to 20 `tools/call` messages and the gateway must not buffer bodies,
workflow-service calls the **same** IAM execution endpoint for each actual tool
call and holds that lease for the run.

Both paths use `{subject:"org:<id>",limits:{hour,concurrent}}`; IAM atomically
checks one epoch-hour counter plus one sorted-set concurrency lease set. Accepted
normal executions and actual MCP calls therefore share both budgets. Every lease
is released on completion, error or cancellation. In production,
`WORKFLOW_MCP_QUOTA_ENFORCEMENT` defaults to true for MCP; normal execution routes
always use the shared admission. Execution-quota store failure fails closed on
both paths instead of bypassing the configured limits.

IAM's `ioredis` client captures one timestamp per admission for keys, TTLs,
reset metadata and Lua ARGV. It executes one Lua script over the three keys
`quota:v1:<service>:<subject>:<window>:<bucket>`. The script checks all three
counters before any increment, then increments accepted requests and sets TTLs
atomically. Rejected requests consume no budget. The response contains
`{allowed,window,count,limit,retryAfterSeconds,resetAt}`. Reconnect backoff is
capped at two seconds and retries indefinitely; `/health` exposes quota status,
check/denial/unavailable counters and the last error time.

Gateway 429 responses include `service`, binding `window`, `limit`,
`retryAfter`, `retryAfterSeconds`, optional `resetAt`, and `Retry-After`.
`fiveHour` and `day` denials therefore remain distinguishable from minute limits.

If effective lookup or Valkey **request** admission fails, IAM returns 503 and the
gateway fails open to its existing in-memory minute limiter. Anonymous/IP traffic
always uses that local limiter. This is deliberate availability behavior, but the
fallback is per gateway replica and does not enforce 5h/day budgets; monitor and
alert on quota-unavailable responses. Shared **execution** admission is different:
normal execution routes return 503 and enforced MCP calls return a quota error
when IAM/Valkey cannot admit or release the execution budget.

## Existing dimensions and limitations

- `tokensPerDay` remains metered from eventually consistent usage telemetry.
  Provider responses without usage can undercount tokens; this patch does not
  redesign token propagation.
- `executionsPerHour` counts accepted execute, test-run and inference-job create
  requests plus each admitted MCP `tools/call`; denied requests, reads and status
  mutations do not consume the shared hourly budget.
- `concurrentExecutions` is one shared IAM sorted-set lease budget. The gateway
  holds a normal execution lease through its proxy request; workflow-service holds
  an MCP lease through the tool run. Queued backend execution completion is still
  not a precise real-time concurrency signal.
- Quota/meter configuration is cached for about 30 seconds by default.

## Migration and deployment

1. Apply IAM migrations before starting new IAM/gateway images.
2. `0018_org_quotas.sql` creates `org_quotas`. The original live-worktree 0015
   timestamp predated 0014 and would be skipped; production never applied it and
   has no table. Quota migrations start at 0018, above hackathon 0017 (merged on
   main at `9d744d0`), so runtime ordering and filenames do not collide.
3. `0019_org_quota_request_windows.sql` adds nullable `requests_per_5h` and
   `requests_per_day`. Journal timestamps are strictly increasing and snapshots
   chain `0017 → 0018 → 0019 → 0020`; every quota snapshot includes
   `hackathon_registrations`, so future schema generation cannot drop it.
4. `0020_api_key_rotation_marker.sql` adds nullable `api_keys.rotated_at` for
   exactly-one-winner rotation. These SQL files are additive but **not rerunnable
   or idempotent**; supported inputs are fresh databases or a 0014 database with
   no `org_quotas` table (the upgrade then applies hackathon 0017 before quota).
   Never rerun them manually.
5. Configure canonical quota env values identically on IAM and gateway. Point
   `IAM_QUOTA_VALKEY_URL` at Valkey or let it fall back to `VALKEY_URL` /
   `REDIS_URL`. Compose and K8s base manifests include the defaults.
6. Validate fresh, 0014-upgrade and hackathon-first merged-tree paths, then run
   catalog, migration, snapshot no-change generation and version checks. Valkey
   tests delete only their randomly prefixed keys (never `FLUSHDB`). PostgreSQL
   tests require `DATABASE_URL` and `IAM_TEST_DATABASE_URL=1`.

## Rollback

Restore previous IAM/gateway/Console images and canonical env values first. Keep
`org_quotas`, `api_keys.rotated_at`, indexes and the migration journal; old
images ignore the new columns. Do not drop tables during an incident. Valkey
quota keys expire by fixed-window TTL (execution leases after five minutes); do
not flush unrelated data. To force request-minute fallback, make the quota Valkey
endpoint unavailable to IAM; shared 5h/day request enforcement then stops and
normal/MCP execution admission fails closed.
