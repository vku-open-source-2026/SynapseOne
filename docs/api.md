# API reference (via Gateway :8080, or services directly)

Base: `http://localhost:8080` (gateway) — every `/v1/*` route needs
`Authorization: Bearer <JWT>` or `X-API-Key`, except `/v1/auth/*` and the public
LDS export routes.
Calling any service **directly** (bypassing the gateway) additionally requires
`x-synapseone-internal: <SYNAPSEONE_INTERNAL_SECRET>` once the secret is configured
(production), otherwise 401 — see `SECURITY.md`.

Service ports: IAM **4001**, workflow **4002**, AI **4003**, LDS **4004**,
Base **4005**, Faststore **4006**, Queue **4007**, gateway **8080**.

## Principal propagation (gateway → upstream)

The gateway **strips** every client-sent `x-synapseone-*` header (anti-spoofing), then
**re-stamps** them from the verified principal: `x-synapseone-kind: user|apikey`,
`x-synapseone-user: <sub>`, `x-synapseone-org`, `x-synapseone-account`,
`x-synapseone-scopes`, plus `x-synapseone-internal` (service-to-service credential when
configured). Upstreams trust these directly without re-verifying the JWT.

One header is intentionally forwarded rather than stripped:
`x-synapseone-tenant`. Principal callers are always scoped to their own
org/account/user; **platform** callers (no principal) use `x-synapseone-tenant`
(or `?tenant=` for Faststore/Queue, `?orgId=`/`?accountId=` for Base) to select a
tenant. Platform calls without a tenant fail with `400 tenant_required`.

## Input validation (400 on bad input)

- `email`: RFC email, ≤320 chars, auto lowercased/trimmed. `slug` (org/account/policy/role):
  `^[a-z0-9-]{1,64}$`. `displayName`: 2–200 chars.
- Policy `document`: `Statement[]` with 1–100 entries, `Effect` Allow|Deny, each
  Action/Resource pattern ≤512 chars, `Condition` ≤8KB (stored-ReDoS/DoS guard). Dry-run
  limited to 20 documents per call.
- attach/assign return 404 when the role/policy/user doesn't exist (instead of 500).
- `scopes`: 1–100 strings ≤200 chars; key `name` 1–100 chars; `expiresInSeconds`
  1–315360000; `action` ≤512, `resource` ≤2048 chars.

## Auth

- `POST /v1/auth/login {email, password, orgSlug?}` → `{accessToken, refreshToken, user}`
  (first-party email+password; works in production). Omitting `password` uses the
  passwordless dev path, which is disabled when `IAM_ALLOW_DEV_LOGIN=false`.
- `POST /v1/auth/register {email, password, orgSlug?, displayName?}` → token set (201).
  A brand-new org is self-service; joining an existing org requires an invitation
  (`403 org_membership_required` otherwise). Password policy: 12–128 chars.
- `POST /v1/auth/invite/accept {token, password, displayName?}` → activate a one-time invited account and return a session
- `POST /v1/auth/password/change {currentPassword, newPassword}` → `{ok, revokedSessions}`
- `POST /v1/auth/password/forgot {email, orgSlug?}` → `202 {ok}` (no account enumeration;
  responses include `resetToken` only when the deployment opts in with
  `IAM_EXPOSE_LIFECYCLE_TOKENS=true` outside production)
- `POST /v1/auth/password/reset {token, newPassword}` → `{ok, revokedSessions}`
- `POST /v1/auth/email/verify {token}` → `{ok, emailVerified}`
- `POST /v1/auth/email/verify/request` (Bearer) → `{ok, emailVerificationToken?}`
- `GET /v1/auth/sessions` (Bearer) → refresh-token sessions
- `DELETE /v1/auth/sessions/:id` (Bearer) → revoke one session
- `POST /v1/auth/exchange {userId, accountId?, orgId?, scopes?, audience?, ttlSeconds?}`
  (service-account Bearer or API key) → `{accessToken (kind=delegated), expiresIn, ...}`.
  Refuses cross-tenant targets (`403 cross_tenant`) and scope escalation; audited.
- `POST /v1/auth/refresh {refreshToken}` → `{accessToken, refreshToken}` (rotation: the old token is revoked)
- `POST /v1/auth/logout {refreshToken}` → `{ok}`
- `POST /v1/auth/logout-all {refreshToken}` → `{ok, revoked}` (revokes all of your own sessions)
- `GET /v1/auth/verify` (Bearer or X-API-Key) → `{valid, ...}`
- `GET /v1/auth/me` (Bearer) → `{user, kind}` (`user.is_org_admin` tells whether the caller administers its org)
- `GET /v1/auth/sessions` (user Bearer) → `[{id, created_at, expires_at}]` — your active sessions (one per live refresh token), newest first
- `DELETE /v1/auth/sessions/:id` (user Bearer) → `{ok}` — revoke one session (its refresh token stops working); other users' ids → `404`
- `GET /v1/auth/oidc/config` → `{issuer, clientId, redirectUri, codeExchange, ...}`
- `GET /v1/auth/oidc/start?org=acme` → `{authorizeUrl, state}` (state is HMAC-signed, 10-minute expiry)
- `POST /v1/auth/oidc/callback {code, state}` → token set (**real** Authorization Code
  exchange: the code is redeemed at the IdP, the ID token is signature-verified against
  the IdP JWKS — asymmetric algs only, issuer + audience checked — then a shadow user
  is upserted from the verified `email`/`sub` claims)
- `POST /v1/auth/oidc/callback {email, orgSlug}` → token set (**demo** mode: trusts the
  caller-supplied email — dev only; set `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` in
  production, which then requires a real IdP `code`)

### Multi-factor authentication (TOTP) and lockout

When a user has MFA enabled, `POST /v1/auth/login` (password or dev login) never
returns a session. It answers `401 {error: "mfa_required", mfaToken, expiresIn: 300,
methods: ["totp","recovery"]}` and the client finishes with:

- `POST /v1/auth/mfa/verify {mfaToken, code}` or `{mfaToken, recoveryCode}` → token set
  plus `mfa: {method, recoveryCodesRemaining}`. A TOTP code is accepted once (replay
  protection); each recovery code is single-use. `mfaToken` is not an access token.

Self-service (user Bearer; API keys, service accounts and delegated tokens get `403`):

- `GET /v1/auth/mfa` → `{enabled, pending, methods, recoveryCodesRemaining, enabledAt}`
- `POST /v1/auth/mfa/totp/setup` → `{secret, otpauthUrl, period: 30, digits: 6, algorithm: "SHA1"}`
  (`409 mfa_already_enabled` while a factor is active)
- `POST /v1/auth/mfa/totp/enable {code}` → `{enabled: true, recoveryCodes: [10 codes, shown once]}`
- `POST /v1/auth/mfa/recovery-codes {code}` → `{recoveryCodes}` (old codes stop working)
- `POST /v1/auth/mfa/disable {code | recoveryCode}` → `{enabled: false}`

Administration (org admins of the same org; `403 org_admin_required` otherwise):

- `DELETE /v1/users/:userId/mfa` → `{ok, removed}` — lost device: removes the factor and clears the lockout
- `POST /v1/users/:userId/unlock` → `{ok}` — clears a sign-in lockout

Lockout: `IAM_LOGIN_MAX_FAILURES` (default 5) consecutive wrong passwords or second-factor
codes lock the user for `IAM_LOGIN_LOCKOUT_SECONDS` (default 900): `429 account_locked`
with `Retry-After`. Unknown emails are never locked or reported. TOTP secrets are sealed
with AES-256-GCM using `IAM_MFA_ENCRYPTION_KEY` (32 bytes, hex/base64; derived from
`IAM_JWT_SECRET` when unset). OIDC sign-ins rely on the identity provider's own MFA.

## Orgs / Accounts

- `GET /v1/orgs` → `[{id, slug, display_name}]`
- `POST /v1/orgs {slug, displayName}` → org
- `GET /v1/orgs/:orgId/accounts`
- `POST /v1/orgs/:orgId/accounts {slug, displayName}`
- `GET /v1/orgs/:orgId/users` → users in the org
- `POST /v1/orgs/:orgId/users {email, displayName}`

## Roles / Policies / Authorize

Organization administrators: the **first user of an organization** (the one whose
login creates it, or the first login into an org without admins) becomes its
administrator — AWS "root"-like, full access inside its own org unless a policy
explicitly denies. Every later user starts with **no permissions** and is granted
roles. Existing users are backfilled as admins by IAM migration `0005`.

- `PUT /v1/users/:userId/org-admin {isOrgAdmin}` → user — only an admin of the same
  org may call it (`403 org_admin_required`); demoting the last admin → `409 last_admin`
- `GET /v1/managed-policies` → `[{name, description, document}]` — AWS-style managed
  policies: `AdministratorAccess`, `PowerUserAccess` (everything except `iam:*`),
  `ReadOnlyAccess`, `StorageFullAccess`, `StorageReadOnlyAccess`, `DataFullAccess`
- `POST /v1/accounts/:accountId/policies {slug, managed: "ReadOnlyAccess"}` — instantiate
  a managed policy in an account (send `managed` **or** `document`, not both)

### Central enforcement (gateway, `AUTHZ_MODE`)

With `AUTHZ_MODE=audit|enforce` the gateway authorizes **every authenticated request**
on a route that declares a `service` in `apps/gateway/routes.yaml`:

| Request | Action | Resource |
|---|---|---|
| `GET` / `HEAD` | `<service>:Read` | `arn:synapseone:<org>:<account>:<service>:<path after /v1/<service>/>` |
| `DELETE` | `<service>:Delete` | same (`-` when the principal has no org/account) |
| other methods | `<service>:Write` | same |
| RPC-style overrides | `POST …/query` → `base:Read`, `POST /v1/workflows/:id/execute` → `workflow:Execute`, `POST /v1/ai/*` → `ai:Invoke`, … | same |

Services: `iam`, `workflow`, `ai`, `inference`, `lds`, `base`, `faststore`, `queue`,
`stream`, `storage`, `notifications`. The decision combines three layers, all of which must allow:

1. **Credential scopes** — API-key / service-account token scopes are action patterns
   (`*`, `storage:*`, `workflow:Execute`) that cap the credential (like an AWS session policy).
2. **Identity policies** — policies on the roles of the owning user / service account
   (explicit `Deny` > `Allow` > default deny). An API key created with `userId`
   inherits that user's permissions; a key without an owner, and a service account
   without roles, are bounded by their scopes alone (backward compatible).
3. **Org administrators** — allowed unless explicitly denied.

`enforce` returns `403 {error:"access_denied", action, resource, reason}` and fails
closed (`503 authz_unavailable`) when IAM is unreachable; `audit` lets the request
through and adds `x-synapseone-authz: would-deny; action=…; reason=…`. Both modes write
denials to `GET /v1/audit` (`actor_type` = `user|service-account|apikey`,
`context.enforcement = "gateway"`). Decisions are cached per principal/action/resource
for `AUTHZ_CACHE_TTL_MS` (default 30 s). `reason` is one of `org-admin`,
`policy-allow`, `scope-only`, `explicit-deny`, `implicit-deny`, `scope-deny`,
`unknown-principal`.

- `POST /v1/accounts/:accountId/roles {slug, description}`
- `GET /v1/accounts/:accountId/roles`
- `DELETE /v1/roles/:roleId`
- `POST /v1/accounts/:accountId/policies {slug, description, document}`
- `GET /v1/accounts/:accountId/policies`
- `DELETE /v1/policies/:policyId`
- `POST /v1/roles/:roleId/attach {policyId}`
- `POST /v1/users/:userId/assign {roleId}`
- `GET /v1/users/:userId/policies`
- `POST /v1/authorize {userId, action, resource, context?}` → `{allowed, matchedBy}` (context is merged with DB-backed user/org/email; unknown userId → `200 {allowed:false}` by contract, not 404)
- `POST /v1/roles/:roleId/attach {policyId}` (policy must live in the role's account — `403 cross_account` otherwise);
- `DELETE /v1/roles/:roleId/policies/:policyId` → detach (idempotent `{ok:true}`);
- `GET /v1/roles/:roleId/policies` → attached policies;
- `POST /v1/users/:userId/assign {roleId}` (role's account must be in the user's org — `403 cross_org` otherwise);
- `DELETE /v1/users/:userId/roles/:roleId` → unassign (idempotent);
- `GET /v1/users/:userId/roles` → assigned roles
- Tenant isolation on every write: creating/attaching/assigning/deleting roles,
  policies, keys, service accounts, accounts and users requires caller membership
  in the target tenant (role-based, or same-org fallback; service-account tokens stay
  strictly account-bound) — otherwise `403 forbidden`. Reads stay open; org creation
  stays open (bootstrap).
- `POST /v1/authorize/dry-run {documents[], action, resource, context?}` → `{allowed}` (simulator, no user needed)
- `GET /v1/audit?limit=50&offset=0&actor=&allowed=&action=&resource=&from=&to=` → tenant-scoped audit log (authorize decisions, IAM mutations **and** Base/Faststore/Queue/Stream/Workflow/LDS writes; newest first, limit clamped 1..200, offset ≤100000). Data-plane services post batched events to the internal `POST /v1/audit/ingest` (internal secret required; not a public route).

## Keys

- `POST /v1/accounts/:accountId/keys {name, scopes?, userId?, expiresInSeconds?}` → `{apiKey (shown once), id, prefix}`. `scopes` defaults to least-privilege `["*:read"]`; pass `["*"]` explicitly for an admin key. Scopes outside the caller's authority → `403 scope_escalation`.
- `GET /v1/accounts/:accountId/keys` → key metadata list (id/name/prefix/scopes/expiry/revoked — never secret values)
- `POST /v1/keys/verify {apiKey}` → `{valid, id, account_id, org_id, user_id, scopes}`
- `DELETE /v1/keys/:id` → revokes the key
- `POST /v1/keys/:id/rotate {graceSeconds?}` → `{id, apiKey (shown once), prefix, rotatedFrom, oldKeyExpiresAt}` (201) —
  the new key keeps the owner, name, scopes and expiry; the old key is revoked immediately
  (`graceSeconds` 0, default) or stays valid for up to 7 days for a zero-downtime switch;
  revoked/expired keys → `409 key_inactive`
- Key listings include `user_id` (owner, null for account-level keys) and `last_used_at`
  (stamped on verification, at most once per minute)

## Service accounts (machine identity)

- `POST /v1/accounts/:accountId/service-accounts {slug, description}` → service account
- `GET /v1/accounts/:accountId/service-accounts` → list
- `POST /v1/service-accounts/:id/token {scopes?}` → `{accessToken (kind=service-account), expiresIn}`
- `GET /v1/service-accounts/:id/roles` → roles granted to the service account
- `POST /v1/service-accounts/:id/roles {roleId}` → `{ok}` (role must be in the SA's account — `403 cross_account`)
- `DELETE /v1/service-accounts/:id/roles/:roleId` → `{ok}` (`404 assignment_not_found` when not granted)

## Credentials (workflow node secrets — implemented)

Account-scoped secrets for workflow nodes. Secrets are AES-256-GCM encrypted at
rest and NEVER returned: create/rotate accept a `secret` once; list/get return
metadata only (`{id, name, kind, accountId, createdAt, updatedAt}`). Implemented
`kind` values: `bearer|api-key|basic|hmac` (legacy alias `type` accepted).

- `POST /v1/accounts/:accountId/credentials {name, kind|type, secret}` → metadata (201)
- `GET /v1/accounts/:accountId/credentials` → `[metadata]`
- `GET /v1/credentials/:id` → metadata
- `DELETE /v1/credentials/:id` → `{ok}`
- `POST /v1/credentials/:id/rotate {secret}` → metadata

## Human tasks — durable waits (`workflow-service`, gateway `/v1/human-tasks`)
A `humanTask` / `waitForSignal` workflow node pauses an execution and creates a
tenant-scoped task. Completing or rejecting the task resumes the run exactly
once from the node's outgoing edges; earlier nodes are never replayed.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/v1/human-tasks` | Create a standalone task (`title`, `assignee?`, `candidateRoles?`, `deadline?`, `decisionSchema?`). |
| GET | `/v1/human-tasks` | Tenant-scoped list (`status`, `executionId`, `workflowId`, `assignee`). |
| GET | `/v1/human-tasks/:id` | Read one task. |
| POST | `/v1/human-tasks/:id/claim` | Claim an open task (assignee-bound tasks require the assignee). |
| POST | `/v1/human-tasks/:id/complete` | `{decision?, note?}`; resumes the paused execution. |
| POST | `/v1/human-tasks/:id/reject` | Requires `note`; resumes the paused execution with `approved:false`. |
| POST | `/v1/human-tasks/:id/expire` | Expire an overdue task (`force:true` for operators). |

Node parameters: `title`, `description`, `assignee`, `candidateRoles`,
`deadlineMinutes`/`deadlineAt`, `decisionSchema`. Completion is guarded by a
conditional status transition, so duplicate decisions and double resumes return
`409`. Task state lives in Postgres (`synapseone_human_tasks`) and survives
restarts. All mutations flow through the audit trail.

## Search (`base-service`, gateway `/v1/search`)
| Method | Route | Description |
| --- | --- | --- |
| POST | `/v1/search` | `{query, mode:"fulltext"\|"semantic"\|"hybrid", collection?, collections?, filters?, limit?, cursor?}`. |
| GET | `/v1/search?q=…` | Convenience query form. |
| POST | `/v1/search/reindex` | Idempotently rebuild the tenant-visible index (`collections?`). |
| GET | `/v1/search/status` | Indexed documents, collection count and freshness. |

Results include `score`, highlighted snippets, ACL metadata, facets (`collection`,
`type`, `status`) and an opaque `nextCursor`. Tenant and document ACLs are
re-checked on every query; a reindex removes deleted documents. Semantic mode
uses deterministic local embeddings (no network); hybrid blends both scores.

## Secrets (`workflow-service`, gateway `/v1/secrets`)
| Method | Route | Description |
| --- | --- | --- |
| POST | `/v1/secrets` | `{name, value, description?, scope?, accountId?}`. |
| GET | `/v1/secrets` | Metadata only — values are never returned. |
| GET | `/v1/secrets/:name` | Metadata plus version history. |
| POST | `/v1/secrets/:name/read` | `{version?}`; decrypts one version and audits the access. |
| POST | `/v1/secrets/:name/rotate` | `{value, graceSeconds?}` (default 24h, max 30d). |
| POST | `/v1/secrets/:name/revoke` | Revoke one version or all versions. |
| DELETE | `/v1/secrets/:name` | Soft-delete the secret and revoke all versions. |
| POST | `/v1/secrets/rotation-webhook` | External scheduler/HKM rotation (`x-rotation-token`). |

Values are AES-256-GCM encrypted with `SYNAPSEONE_CREDENTIAL_KEY` (32-byte hex,
required in production); list responses and audit details never include them.
Cross-tenant and account-mismatched reads return `404`.

## SCIM 2.0 (`iam-service`, gateway `/scim/v2`)
| Method | Route | Description |
| --- | --- | --- |
| POST/GET | `/v1/scim/tokens` | Issue/list scoped SCIM bearer tokens (`scim:read`, `scim:write`). |
| DELETE | `/v1/scim/tokens/:id` | Revoke a token. |
| GET/POST | `/scim/v2/Users` | List (filter `userName`, `externalId`, `active`) / create. |
| GET/PUT/PATCH/DELETE | `/scim/v2/Users/:id` | Read, replace, patch (`active`, `displayName`, `externalId`) or deactivate. |
| GET/POST | `/scim/v2/Groups` | List / create groups with `members` and explicit `roles`. |
| GET/PATCH/DELETE | `/scim/v2/Groups/:id` | Read, add/remove members, delete. |

SCIM requests authenticate with a scoped `scim_*` bearer token only — user JWTs
are rejected. Group membership maps to IAM roles server-side and is audited.
Deactivation sets `active:false`, revokes refresh tokens and API keys.

## Workflows (local built-in engine)

- `GET /v1/templates` / `GET /v1/templates/:name`
- `GET /v1/workflows` (list: `[{id,name,active,nodes,connections,settings,orgId?,accountId?,owner?,runAs?,revision,createdAt,updatedAt}]`;
  gateway-authenticated callers see their org slice + legacy-global rows; `?orgId=` / `?accountId=` filter exactly)
- `GET /v1/workflows/:id` (tenant-bound rows 404 outside their org)
- `DELETE /v1/workflows/:id`
- `POST /v1/workflows/:id/activate` / `POST /v1/workflows/:id/deactivate`
  (activate re-validates the stored definition and returns `409 webhook_path_conflict`
  when another active workflow already serves the same webhook path)
- `POST /v1/workflows {name, template} | {name, definition, settings?, orgId?, accountId?, runAs?}`
  (template webhook paths are auto-suffixed `-2, -3, …` so double-creates never collide;
  explicit org/account must stay inside the caller's own org, else `403 cross_tenant`;
  every create stamps `owner` from the caller)
- `PUT /v1/workflows/:id {name?, definition?, settings?, orgId?, accountId?, runAs?}` (structural/SSRF/size/cycle-validated, ≤200KB, ≤50 nodes, every node needs a 1..128 char `name`; every update bumps `revision`)
- `POST /v1/workflows/:id/execute {input}` (manual run — works for ANY trigger type, active or not; the body IS the input). With queue transport enabled (default when `QUEUE_SERVICE_URL` is set) this returns `202 {ok, queued:true, executionId, queue, runner}` after publishing a SynapseQueue job; add `?wait=1&timeoutMs=60000` for the old blocking shape `{ok, output, executionId, status}`. `500 {ok:false, error}` when a node fails. Records the caller principal + `actor: "workflow:<id> principal:<sub>"`.)
- `POST /v1/workflows/test-run {definition, input, workflowId?}` (try a definition without saving; validates + executes inline in the sandbox; persisted as a `triggered_by=test` execution — pass `workflowId` to attach it to that workflow's history; returns `{ok, output, nodeRuns, executionId}`)
- `GET /v1/executions` (`limit,offset,workflowId,status,triggeredBy,includeData`; `limit/offset` 0..9999, `offset=0` = first page; `status` is `queued|running|paused|success|error|cancelled`; `triggeredBy` is `manual|webhook|cron|test|human-task|workflow|mcp`; secret-looking keys in payloads are masked to `***`; always returns the envelope `{data: [...]}` — SDKs/Console/CLI unwrap `.data` and also accept a bare array) / `GET /v1/executions/:id` (`?includeData=true` for per-node input/output; also carries `principal`, `actor`, `queue`, `runner`, `workerId`, `attempt`, `leaseExpiresAt`, `workflowRevision`)
- `GET/POST/DELETE /v1/credentials[?accountId=]` (account-scoped secrets, AES-256-GCM at rest via `SYNAPSEONE_CREDENTIAL_KEY`; list/create return metadata only, never secrets; duplicate names per account are `409`)
- Public inbound webhooks: `ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares that `path` (also proxied at the gateway as `/webhook`, auth none — per-workflow auth below still applies):  ```bash
  curl -X POST http://localhost:4002/webhook/transform \
    -H 'Content-Type: application/json' \
    -d '{"value":21}'
  # → {ok, queued:true, executionId, queue}   (queue mode)
  # → {ok, output, executionId}               (inline mode / ?wait=1)
  ```
  Per-workflow hardening from the webhook node's params: `auth` (`none` |
  `secret-header` | `hmac-sha256` over the raw body | `jwt` HS256 with exp/nbf +
  optional iss/aud — all referencing a `credentialId`, optional custom `header`),
  `rateLimit: {rpm}` (default 600, `429` over budget), `idempotency: {header, ttlSeconds}`
  (`409 duplicate_delivery` on replay). Failures surface as `401 unauthorized`,
  `409`, `429` and feed `/metrics`.
- GitHub push in 3 clicks: template `github-push-to-log`, or set a webhook node's
  auth to `hmac-sha256` + header `x-hub-signature-256` (the editor has a
  "GitHub push preset" button) and store the repo's webhook secret as an `hmac`
  credential. GitHub: Payload URL `https://<host>/webhook/<path>`, Content-Type
  `application/json`, Secret = the same secret; `X-Hub-Signature-256`
  (`sha256=`-prefixed hex over the raw body) is verified, events `push`,
  `issues`, `pull_request` all land as the run input. Replying back (comment,
  dispatch) is a plain `httpRequest` to `https://api.github.com/...` with a PAT
  stored as a `bearer` credential (never in the URL).
- **MCP trigger** (`mcpTrigger`, alias `synapseone.mcpTrigger`): an ACTIVE
  workflow that declares `parameters.toolName` is exposed as an MCP tool.
  `POST /mcp` is a public JSON-RPC 2.0 server (`initialize`, `tools/list`,
  `tools/call`, `ping`). Tools marked `public: true` **and** `readOnly: true`
  are callable anonymously (docs/read-only use). Private or write-capable
  tools require a gateway Bearer JWT or `X-API-Key`; anonymous `tools/list`
  only returns public read-only tools. Calls run the workflow inline with
  `triggered_by=mcp` and return
  `{content:[{type:"text",text}], structuredContent?}`. Public tool names are
  globally unique and all tool names are unique per tenant
  (`409 mcp_tool_conflict` on activate). Built-in template `mcp-docs-reader`
  exposes public read-only `read_synapseone_docs` and fetches the requested
  public docs file. MCP clients can use `Authorization: Bearer <api-key>` on
  authenticated routes as a fallback.
- `GET /metrics` (Prometheus: `synapseone_workflow_runs_total{triggered_by,status}`,
  `synapseone_workflow_webhook_rejected_total{reason}`)

Calling SynapseOne from a workflow: the SSRF guard blocks first-party hosts by
default. Operators who need it set `SYNAPSEONE_SELF_BASE_URLS` (comma-separated
exact origins, e.g. `"http://gateway:8080,http://iam:4001"`). Calls to those
origins bypass the block AND forward the run principal as `x-synapseone-*`
headers so downstream services can authorize. Redirects are followed manually
with every hop re-checked (max 5).

Node types: `webhook` (trigger, `parameters.path/httpMethod`), `cron` (trigger, `rule.interval` or `cronExpression`), `manualTrigger`, `mcpTrigger` (trigger; `parameters.toolName/description/inputSchema` exposes the workflow as an MCP tool at `POST /mcp`), `httpRequest` (`url/method/headers/body`, SSRF-blocked, 15s timeout), `code` (sandboxed JS, `parameters.code`, 5s timeout, `$input/$json/input/$now` + `console` capture), `set` (`values/assignments`, supports `={{ $json.x }}` templating), `if` (`condition` JS or `value1/operation/value2` or n8n `conditions[]`; `main[0]`=true, `main[1]`=false), `noOp` (passthrough). `synapseone.api` (first-party SynapseOne block: `parameters.resource/operation/input` — resources `orgs/users/roles/policies/authorize/audit/keys/service-accounts/workflows/executions/templates/lds`; runs as your login, values support `={{ $json.x }}`; `lds` = `list-datasources` | `publish-record`). Unknown types pass data through but are recorded as `skipped` (visible in `nodeRuns`), not silent success.

| Node | Key `parameters` | Notes |
| --- | --- | --- |
| `webhook` | `path` (1..128, `[A-Za-z0-9_./-]`, no `..`), `httpMethod` (`GET\|POST\|PUT\|PATCH\|DELETE\|HEAD`, default `POST`), `auth` (`{mode: none\|secret-header\|hmac-sha256\|jwt, header?, credentialId?}`), `rateLimit: {rpm}` (default 600), `idempotency: {header, ttlSeconds}` | `ANY /webhook/:path` routes to the ACTIVE workflow with that path; activating with a taken path is `409`; auth/rate/idempotency enforced per node config |
| `cron` | `rule.interval[]` (`{field: seconds\|minutes\|hours\|days, <field>Interval: N}`), or `cronExpression` (`"*/N * * * *"`, `"M H * * *"` wall-clock, `@hourly`, `@daily`), or `intervalMs`, plus optional `timezone` (wall-clock only) | Minimum 10s — faster schedules and other cron formats are rejected at save/activate; the editor shows the next run |
| `manualTrigger` | — | Run from Console/CLI with any JSON input |
| `mcpTrigger` | `toolName` (`[A-Za-z0-9_.-]{1,64}`), `description` (≤500), `inputSchema` (JSON Schema, ≤8KB), `public` (bool), `readOnly` (bool, default true; `public` requires readOnly) | Active workflow becomes an MCP tool; names unique among active workflows; `POST /mcp` JSON-RPC |
| `httpRequest` | `url` (public `http(s)` or allowlisted self origin), `method`, `headers` (object), `body`/`jsonBody` (sent only when configured — the input is NOT auto-forwarded), `auth: {credentialId, header?}` (secret resolved server-side), `retry: {attempts 1–5, delayMs}`, `timeoutMs` (1–30s) | Redirects followed manually, max 5 hops, every hop re-checked against the SSRF blocklist; default 15s timeout; ≤200KB body, ≤500KB response |
| `code` | `code` (JS, ≤50KB, default 5s timeout), `timeoutMs` (1–15s), `retry` | `$input`/`$json`/`input` in scope, `$now` ISO time, `console.*` captured; bare expressions get an implicit `return (…)`; result `_logs` key is yours — console output then lands in `_consoleLogs` |
| `set` | `values` (object), `assignments` (`[{name, value}]`), legacy `values.assignments`/`fields` | Values support `={{ $json.x }}` / `{{ … }}` / `=expr` templating against the incoming item; merged over the input |
| `if` | `condition` (JS), or `value1` + `operation` + `value2` (`equals|notEquals|contains|notContains|startsWith|endsWith|larger|largerEqual|smaller|smallerEqual|isEmpty|isNotEmpty`), or n8n `conditions[]` | Output branch 0 = true, 1 = false; an unwired side stops the run there (the editor warns) |
| `noOp` | — | Passthrough log point |

Any node accepts `disabled: true` (skipped at run time, data flows through —
a disabled `if` takes its true branch) and `httpRequest`/`code` accept
`retry`/`timeoutMs`. Workflow `settings.onError: "continue"` absorbs node
failures into `partialErrors` instead of failing the run. Every workflow
update bumps `revision`. Export/import via the Console (portable
`{name, nodes, connections, settings}` JSON) or the raw API payloads.

Execution semantics: non-`if` nodes fan out to every branch; a diamond (`A→B, A→C, B→D, C→D`) runs `D` once per incoming edge with that edge's data. With several terminal nodes the final `output` is keyed by terminal node name (`{Left: …, Right: …}`); with one terminal it is that node's output directly. Per-node `nodeRuns[]` carry `status` (`success|error|skipped`), `input`, `output`, `error`, `durationMs`, `attempts?`.

### Queue transport and self-hosted runners

Triggers (manual, webhook, cron, human-task resume) create a `queued`
execution row and publish a tiny `{v,kind:"workflow.run",executionId}` message
to SynapseQueue. Inputs and definitions stay in Postgres; workers fetch them
after an authenticated claim. Queue delivery is at-least-once and
`POST /v1/runner/jobs/:id/claim` is the exactly-one-runner guard.

Per-workflow mode (`settings.execution.mode`, also accepted as
`settings.runner`):

| Mode | Queue | Who runs it |
| --- | --- | --- |
| `platform` (default) | `synapseone-wf-platform` (`WORKFLOW_QUEUE_PLATFORM`) | Built-in worker in workflow-service (`WORKFLOW_WORKER_ENABLED=true`) |
| `custom` | `synapseone-wf-custom` (`WORKFLOW_QUEUE_CUSTOM`) | A tenant-deployed runner |
| `hybrid` | `synapseone-wf-shared` (`WORKFLOW_QUEUE_SHARED`) | Platform worker + tenant runners compete |
| `inline` | — | Runs in the request (dev/test, nested calls) |

`settings.execution.queue` overrides the queue name (1..64 chars,
`[A-Za-z][A-Za-z0-9_-]*`) to dedicate a runner. `maxAttempts` and
`visibilityTimeoutSeconds` are also read from `settings.execution`.

Runner management (JWT or a runner-scoped API key):

- `POST /v1/workflow-runners {name, kind?, mode?, queue?, inferenceQueue?, apiKeyId?, keyPrefix?, scopes?, apiKey?}`
  → `{runner, kind, queue, inferenceQueue, scopes, command, options}`.
  `kind` is `workflow|inference|hybrid`; default key scopes:
  `workflow:*,queue:*,*:read,base:query,base:vector-search,inference:*`.
  `command` is a copy-paste `docker run` with the API key **when the caller
  passes `apiKey`**; the key is echoed only in this response and never stored.
  Inference/hybrid commands include `INFERENCE_RUNNER_URL` placeholder.
- `GET /v1/workflow-runners/options` → public URL, image, queues, heartbeat /
  stale windows, max concurrency and built-in platform-worker config.
- `GET /v1/workflow-runners` → `{data: [{...runner, instances, connected,
  connectedInstances, instanceCount, status}], options}`.
  `GET /v1/workflow-runners/:id` also returns `command` + `config`;
  `PATCH /v1/workflow-runners/:id {name?, mode?, queue?, metadata?}` (queue/mode
  changes are `409 runner_connected` while a connector is online);
  `DELETE /v1/workflow-runners/:id`.
- `GET /v1/workflow-runners/:id/config` (runner bootstrap: queue/mode/base URL,
  heartbeat/stale/max-concurrency, image)
- `POST /v1/workflow-runners/:id/heartbeat {instanceId, hostname?, version?,
  queue?, concurrency?, startedAt?, status?: connected|offline, metadata?}`
  upserts a **connector instance**; `offline` is sent on graceful shutdown.
- `GET /v1/workflow-runners/:id/connection`
  → `{connected, status: waiting|connected|degraded|offline, checkedAt,
  instances[], connectedInstances, instanceCount, lastSeenAt, queue, mode,
  version, heartbeatIntervalSeconds, staleAfterSeconds}`.
  A connector is fresh for `WORKFLOW_RUNNER_STALE_SECONDS` (default 60s).
- `DELETE /v1/workflow-runners/:id/instances/:instanceId` (remove a stale connector)
- `POST /v1/workflow-runners/:id/command {apiKey?}` (render the command later)

Runner job protocol (API key + `X-Workflow-Runner-Id`):

- `POST /v1/runner/jobs/:id/claim {runnerId, leaseSeconds}` → job snapshot
  `{executionId, workflow, input, principal, triggeredBy, attempt, leaseExpiresAt, resumeFrom}`;
  `409 not_claimable` when another worker owns it.
- `POST /v1/runner/jobs/:id/heartbeat {runnerId, leaseSeconds}` (extends the DB lease)
- `POST /v1/runner/jobs/:id/complete {runnerId, status: success|error|paused, output, nodeRuns, error?, pause?}`
- `POST /v1/runner/jobs/:id/release {runnerId, error?}` (retryable failure; nack the queue message)
- `POST /v1/runner/jobs/:id/credentials {runnerId, credentialId}`
  → `{kind, secret}` for exactly this claimed execution. Custom runners hold
  plaintext credentials only in memory for that run.

### Inference jobs (inference / hybrid runners)

- `POST /v1/inference-jobs {type, payload, queue?, wait?, timeoutMs?}` →
  `202 {ok, jobId, status: queued, queue, type}`. Types:
  `chat|embeddings|decision|route|generic`. `wait: true` blocks and returns
  `{ok, jobId, status, result}`. Gateway action `inference:Invoke`.
- `GET /v1/inference-jobs[?status=&limit=]` and
  `GET /v1/inference-jobs/:id[?includeData=true]` (tenant-scoped).
- Runner protocol:
  - `POST /v1/runner/inference/jobs/:id/claim {runnerId, instanceId?, leaseSeconds}`
    → `{jobId, type, request, attempt, leaseExpiresAt}`; idempotent for the
    same runner after a lost response.
  - `POST .../heartbeat` and `POST .../release`.
  - `POST .../complete {runnerId, instanceId?, status: success|error, result?, error?}`.

Runner types: `workflow` (workflow lane only), `inference` (inference lane
only), `hybrid` (both). The inference lane calls a local OpenAI-compatible
backend configured by `INFERENCE_RUNNER_URL`; the SynapseOne API key is only
used for the queue/claim/report path (and any workflow nodes, for hybrid).

The published image is `ghcr.io/<owner>/synapseone-workflow-runner:<tag>`
(also built as `:main` on CD). See [`workflow-runners.md`](workflow-runners.md)
for the operational guide.

## Linked Data (SynapseLDS — `lds-service:4004`, gateway `/v1/lds`)

Publish licensed open data as NGSI-LD. Records are stored split into three
regions — `_core` (private platform metadata: internal id, tenant, source id,
version, actor), `entity` (`id`/`type`, public identity) and `attributes`
(dynamic business fields). The projector is a **structural allowlist**: it
reads only `entity` + registry-approved `attributes`, so `_core` (and any
future metadata field) can never leak. Unregistered attributes are stored but
default-deny (never exported) until a steward marks them, and reserved names
(`id`, `type`, `@context`, `internalId`, `tenantId`, …) are rejected at
registration. Every export carries `X-LDS-License: <SPDX>`,
`Link: <licenseUrl>; rel="license"` and the license URL inside `@context`.

- `GET /v1/lds/licenses` → built-in catalog (`CC0-1.0`, `PDDL-1.0`,
  `CC-BY-4.0`, `CC-BY-SA-4.0`, `ODbL-1.0`, `LicenseRef-Proprietary`) —
  **public**: readable without a token
- `GET /v1/lds/datasources` (`?orgId&accountId` — filters can only NARROW
  within your principal: org rows to that org, account rows to that account,
  foreign rows are never enumerated; the platform service-side context sees
  everything, anonymous callers get `401 auth_required`)
- `POST /v1/lds/datasources {name, entityType, license, slug?, licenseUrl?, contexts?, defaultVisibility?, description?}`
  (custom licenses need a `LicenseRef-*` id + `licenseUrl`; `defaultVisibility`
  is `internal` unless you say otherwise)
- `GET /v1/lds/datasources/:id` → datasource + `attributes[]` + `stats`
- `PATCH /v1/lds/datasources/:id {name?, slug?, entityType?, license?, licenseUrl?, contexts?, defaultVisibility?, description?}`
- `DELETE /v1/lds/datasources/:id` → `{ok}` (registry + records cascade)
- `GET /v1/lds/datasources/:id/attributes` → registry
- `PUT /v1/lds/datasources/:id/attributes {attributes: [{name, ngsiLdType?: Property|Relationship|GeoProperty, visibility?: public|restricted|internal, description?, sourceField?}]}`
  (atomic replace; `400 reserved_attribute` lists the offenders; unstated
  visibility defaults to the datasource's `defaultVisibility`, itself
  `internal` unless changed)
- `POST /v1/lds/datasources/:id/records` (one record, `{records:[…]}` or
  `{record:{…}}`, ≤1000/call) → `{ingested, created, updated, quarantined:[{field,reason}], entities:[{entityId, sourceRecordId, version}]}`.
  `id` becomes `_core.sourceRecordId`; the public IRI is
  `urn:ngsi-ld:<entityType>:<id>` unless an explicit `ngsiLdId`/`@id` IRI is
  given. Reserved fields are quarantined, never promoted; the ingest summary
  reports public identity only (no internal ids). Re-ingesting the same
  source id bumps `version`.
- `GET /v1/lds/datasources/:id/entities` (`?limit` 1..500, `?offset` ≥ 0 —
  invalid values are a `400`, never a silent clamp; `?visibility=public|restricted`)
  → NGSI-LD (JSON-LD) array. **Public channel**: this route (and the single-
  entity route below) is also served anonymously through the gateway public
  routes — spec rule "public = anyone reaching the API": an anonymous consumer
  always gets the public-projection slice and can never ask for `restricted`
  (→ `401 auth_required`). A Bearer token that verifies is honoured as optional
  auth on the public route. Authenticated callers inside the datasource tenant
  may request `?visibility=restricted` (served `private, no-store`); an
  authenticated caller from a *different* tenant gets `404` (tenant data
  existence is not enumerated — the anonymous public route is the sharing
  channel). `internal` never leaves the API.
- `GET /v1/lds/datasources/:id/entities/:entityId` → single entity (404 when unknown)
- `GET /v1/lds/datasources/:id/stats` → `{records, attributes:{public,restricted,internal}, lastIngestAt}`

```bash
# publish → export in two calls (public attributes only)
curl -s -X POST http://localhost:8080/v1/lds/datasources/$DS/records \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"55001","name":"Công ty ABC","locatedIn":"urn:ngsi-ld:AdministrativeArea:danang"}'
curl -s http://localhost:8080/v1/lds/datasources/$DS/entities
# → [{"id":"urn:ngsi-ld:Organization:55001","type":"Organization","name":{…},"@context":[…]}]
# the same export URL works with NO token at all (anonymous open-data consumers)
curl -s http://localhost:8080/v1/lds/datasources/$DS/entities   # 200 public slice
```

From workflows: the `synapseone.api` node gains resource `lds` with operations
`list-datasources` (no args) and `publish-record` (`datasourceId` required —
validated at save time, `record` object — `={{ $json }}` passes the whole
payload). Template `webhook-to-lds`: webhook → publish → done (webhook/cron
runs act as the workflow's tenant principal, so tenant-bound datasources stay
publishable). See `docs/specs/synapseone-lds.md`.

## Base — documents with object ↔ data mapping (`base-service:4005`, gateway `/v1/base`)

Collections of JSON documents with server-side validation, a logical
object↔data mapping, queries, optimistic concurrency, atomic counters, batch
writes and a change feed. Full guide: [synapsebase.md](synapsebase.md).

- `GET /v1/base/collections` (`?orgId` / `?accountId` narrow the list)
- `POST /v1/base/collections {name, description?, mapping?, orgId?, accountId?}`
  (201; name `[A-Za-z][A-Za-z0-9_-]{0,63}`, unique per tenant scope)
- `GET /v1/base/collections/:collection` → collection + `stats`
- `PATCH /v1/base/collections/:collection {name?, description?, mapping?}`
  (mapping replace is a view/validation change, not a data migration)
- `DELETE /v1/base/collections/:collection` → collection + documents
- `GET /v1/base/collections/:collection/stats` → `{documents, bytes, lastUpdatedAt}`
- `POST /v1/base/collections/:collection/documents {id?, data|object}` — exactly
  one of `data`/`object`; response is the data view
- `GET /v1/base/collections/:collection/documents/:id?as=data|object`
- `PUT /v1/base/collections/:collection/documents/:id {data|object, merge?, ifVersion?}`
  — upsert (`201` created / `200` replaced); `If-Match: "<version>"` also accepted
- `PATCH /v1/base/collections/:collection/documents/:id {data|object?, unset?, ifVersion?}`
  — deep merge + dot-path removals, re-validated against the mapping
- `DELETE /v1/base/collections/:collection/documents/:id?ifVersion=` (`?ifVersion`
  or `If-Match`; unknown id `404`, stale version `409 version_conflict`)
- `GET /v1/base/collections/:collection/documents?limit=100&offset=0` — raw data
  view, id order
- `POST /v1/base/collections/:collection/query {where, orderBy?, limit?, offset?|cursor?,
  select?, as?}` — `where` accepts logical names or dot paths, leaf
  `{field, op, value}`, groups `and`/`or`/`not`, shorthand
  `{"capacity":{"gte":100}}`, and metadata `$id/$version/$createdAt/$updatedAt`.
  Ops: `eq, ne, gt, gte, lt, lte, in, nin, contains, startsWith, endsWith, exists`.
  Returns `{items, total, limit, offset, nextCursor}`.
- `POST /v1/base/collections/:collection/vector-search {vector, limit?, field?, metric?, where?, as?}`
  — vector similarity search (`cosine`, `l2`, `ip`) with metadata filtering; returns `{items:[{id, similarity, distance, data|object}], total, limit, metric}`
- `POST /v1/base/collections/:collection/documents/:id/increment {field, by?, ifVersion?}`
  — `field` is a **raw dot path**; missing document is created at version 1
  (`ifVersion: 0` is the explicit create form)
- `POST /v1/base/collections/:collection/documents:batch {operations[]}` — 1..100
  ordered ops `create|set|update|delete|increment`; per-op results, `ok` only when
  everything succeeded; `ifVersion` is honored only by `delete`
- `GET /v1/base/collections/:collection/changes?since=&limit=100&as=` — upserts
  only (`deleted` is always false); reuse `nextSince`

### SynapseBase Graph (Tier-1 property graph)

Nodes and typed edges live beside the collection in Postgres; traversal is a
bounded recursive CTE (depth <= 5, limit <= 1000), so a query cannot walk the
whole graph. JS/Python SDK: `base.graphUpsertNodes`, `graphUpsertEdges`,
`graphNode`, `graphQuery`, `graphStats`, `graphDeleteNode` / snake_case
equivalents.

- `POST /v1/base/collections/:collection/graph/nodes {nodes:[{id, labels[], properties}]}`
  — upsert up to 1000 nodes
- `POST /v1/base/collections/:collection/graph/edges {edges:[{id?, from, to, type, properties?}]}`
  — upsert up to 2000 edges; endpoints must already exist
- `GET /v1/base/collections/:collection/graph/nodes/:id?depth=2&limit=200`
  — node + bounded BFS subgraph (`next` when truncated)
- `POST /v1/base/collections/:collection/graph/query {start[], depth?, edgeTypes?, limit?}`
  — multi-start traversal
- `GET /v1/base/collections/:collection/graph/stats` → `{nodes, edges}`
- `DELETE /v1/base/collections/:collection/graph/nodes/:id` — cascade incident edges

### SynapseBase GIS (PostGIS)

Features are stored as `geometry(Geometry,4326)` with a GiST index; property
payloads stay in `jsonb`. JS/Python SDK: `base.geoUpsert`, `geoList`, `geoNear`,
`geoWithin`, `geoStats`, `geoDelete` / snake_case equivalents.

- `POST /v1/base/collections/:collection/geo/features {features:[{id, properties, geometry}]}`
  — upsert up to 1000 GeoJSON features (Point/LineString/Polygon/Multi*/Collection)
- `GET /v1/base/collections/:collection/geo/features?bbox=minLng,minLat,maxLng,maxLat&limit=200`
  — bbox query (`&&` on the GiST index)
- `POST /v1/base/collections/:collection/geo/near {lat, lng, radiusMeters, limit?}`
  — metres via `geography`, returns `distanceMeters`
- `POST /v1/base/collections/:collection/geo/within {geometry, limit?}`
  — polygon/multipolygon containment
- `GET /v1/base/collections/:collection/geo/stats` → `{features, extent}`
- `DELETE /v1/base/collections/:collection/geo/features/:id`

Vector: `/v1/search` stores real 384-d inference embeddings in
`embedding_vec vector(384)` with an HNSW cosine index; `semantic` and `hybrid`
modes use it and fall back to the local hashed embedding when inference is
unavailable.

Mapping shape: `{fields: {logical: {path, type?, required?}}, additional?}` or the
shorthand `{logical: "dot.path"}`. Types `string|number|boolean|date|array|object|any`;
`additional:false` rejects undeclared keys on object writes. Write `object` to store
at mapped paths, read `?as=object` to get logical keys.

Tenancy: org principal → org-bound collections; account-only → `org_id=null,
account_id=<acct>`; platform callers see only unbound collections unless they pass
`?orgId=`/`?accountId=` (ambiguous name → `409 ambiguous_collection`).

## Faststore — cache, key/value and data structures (`faststore-service:4006`, gateway `/v1/faststore`)

Redis-backed, tenant-scoped strings, counters, hashes, lists, sets, sorted sets,
bulk operations and distributed locks. Full guide: [faststore.md](faststore.md).

- `GET /v1/faststore/stats` → `{backend, tenant, keys, byType}`
- `GET /v1/faststore/keys?prefix=&limit=100&cursor=` → `{keys, cursor, truncated}`
- `GET /v1/faststore/keys/:key` → `{key, type, value, ttlSeconds}`
- `PUT /v1/faststore/keys/:key {value, ttlSeconds?, ifNotExists?, ifExists?}` — `POST` is an alias
- `DELETE /v1/faststore/keys/:key` → `{key, deleted}`
- `GET /v1/faststore/keys/:key/ttl` → `{key, ttlSeconds}` (`-1` = no expiry)
- `POST /v1/faststore/keys/:key/expire {ttlSeconds}` (`0` clears)
- `POST /v1/faststore/keys/:key/incr {by?, ttlSeconds?}`
- `POST /v1/faststore/batch {operations[]}` — 1..100 ops `set|get|delete|incr|expire`

Hashes:

- `GET /v1/faststore/hashes/:key` → all fields
- `GET /v1/faststore/hashes/:key/length` → field count
- `PUT /v1/faststore/hashes/:key {values, ttlSeconds?}`
- `DELETE /v1/faststore/hashes/:key`
- `GET /v1/faststore/hashes/:key/:field`
- `PUT /v1/faststore/hashes/:key/:field {value, ttlSeconds?}`
- `DELETE /v1/faststore/hashes/:key/:field`
- `POST /v1/faststore/hashes/:key/incr {field, by?, ttlSeconds?}`

Lists:

- `GET /v1/faststore/lists/:key?start=0&stop=-1` → range
- `DELETE /v1/faststore/lists/:key`
- `GET /v1/faststore/lists/:key/length`
- `POST /v1/faststore/lists/:key/push {values, side?, ttlSeconds?}`
- `POST /v1/faststore/lists/:key/pop {side?, count?}`
- `POST /v1/faststore/lists/:key/trim {start, stop}`

Sets:

- `GET /v1/faststore/sets/:key` → members
- `DELETE /v1/faststore/sets/:key`
- `POST /v1/faststore/sets/:key/add {members, ttlSeconds?}`
- `POST /v1/faststore/sets/:key/remove {members}`
- `POST /v1/faststore/sets/:key/contains {member}`
- `GET /v1/faststore/sets/:key/card` → cardinality

Sorted sets:

- `GET /v1/faststore/zsets/:key?start=0&stop=-1&rev=&withScores=` → range
- `DELETE /v1/faststore/zsets/:key`
- `GET /v1/faststore/zsets/:key/card` → cardinality
- `POST /v1/faststore/zsets/:key/add {members:[{member,score}], ttlSeconds?}`
- `POST /v1/faststore/zsets/:key/incr {member, by?}`
- `POST /v1/faststore/zsets/:key/remove {members}`
- `POST /v1/faststore/zsets/:key/score {member}`
- `POST /v1/faststore/zsets/:key/rank {member, rev?}`

Distributed locks:

- `POST /v1/faststore/locks/:name/acquire {ttlSeconds?, waitMs?, token?}`
- `POST /v1/faststore/locks/:name/release {token}`
- `POST /v1/faststore/locks/:name/extend {token, ttlSeconds}`
  Acquire success/failure is HTTP 200 with `acquired:true|false`

TTL: 1..2,592,000 seconds; `0` clears it. Read responses use `ttlSeconds: null`
when a key has no expiry. Platform callers select a tenant with
`x-synapseone-tenant` (SDK `tenant` option) or `?tenant=`; principal callers are
always scoped to their own org/account/user.

## Queue — messaging (`queue-service:4007`, gateway `/v1/queue`)

At-least-once queues with delayed and deduplicated publishing,
visibility-timeout leases, ack/nack/heartbeat, retries, dead letters and replay.
Full guide: [queue.md](queue.md).

- `GET /v1/queue/queues` → queue configs
- `PUT /v1/queue/queues/:queue {maxAttempts?, visibilityTimeoutSeconds?}` —
  idempotent create/update (`201` created, `200` existing)
- `GET /v1/queue/queues/:queue` → config + `stats`
- `DELETE /v1/queue/queues/:queue` → queue and all its messages
- `POST /v1/queue/queues/:queue/purge` → clear **all** messages (pending, delayed,
  in-flight, dead) and counters; keeps the queue config
- `GET /v1/queue/queues/:queue/stats` → `{pending, inflight, dead, published,
  acked, retried, replayed, maxAttempts, visibilityTimeoutSeconds}`; `pending`
  includes delayed messages
- `POST /v1/queue/queues/:queue/messages {payload, delaySeconds?, maxAttempts?,
  headers?, id?, dedupeKey?}` — `201` published, `200` deduplicated (returns the
  original id/message); `409 conflict` on a live custom id
- `POST /v1/queue/queues/:queue/messages:batch {messages[]}` — 1..100 entries,
  per-item results, always `200`
- `POST /v1/queue/queues/:queue/consume {maxMessages?, visibilityTimeoutSeconds?,
  consumer?}` → `{queue, count, visibilityTimeoutSeconds, messages:[{...,receipt,
  leaseExpiresAt}]}`; up to 100 per call
- `POST /v1/queue/queues/:queue/ack {receipt}` or `{receipts:[1..100]}` —
  unknown/used receipt → `404 receipt_not_found`
- `POST /v1/queue/queues/:queue/nack {receipt, requeue?, delaySeconds?, error?}` →
  `{state:"retry"|"dead", attempts, availableAt|deadAt}`
- `POST /v1/queue/queues/:queue/heartbeat {receipt, visibilityTimeoutSeconds?}`
- `GET /v1/queue/queues/:queue/messages?limit=100&ready=` — peek pending (ready
  and delayed); in-flight messages are not listed
- `GET /v1/queue/queues/:queue/dead?limit=100` — dead letters, newest first
- `POST /v1/queue/queues/:queue/dead/:id/replay {delaySeconds?, resetAttempts?}`
- `DELETE /v1/queue/queues/:queue/dead/:id`

## Stream — distributed event streaming (`stream-service:4009`, gateway `/v1/stream`)

Tenant-scoped distributed event streaming log (pluggable Redis Streams / Kafka backend) with consumer groups, time-range replay and retention trimming.

- `GET /v1/stream/topics` → list topics for tenant
- `PUT /v1/stream/topics/:topic {maxLen?, minId?, retentionMs?}` — create or update stream topic
- `GET /v1/stream/topics/:topic` → get topic configuration
- `DELETE /v1/stream/topics/:topic` → delete topic and all events
- `GET /v1/stream/topics/:topic/stats` → `{topic, length, firstId, lastId, groupsCount, groups}`
- `POST /v1/stream/topics/:topic/events {payload, key?, headers?, id?}` — publish one event
- `POST /v1/stream/topics/:topic/events:batch {events[]}` — batch publish up to 100 events
- `POST /v1/stream/topics/:topic/read {fromId?, count?, blockMs?}` — raw stream read / non-destructive fanout
- `GET /v1/stream/topics/:topic/range?start=&end=&count=` — historical time-range query / replay
- `PUT /v1/stream/topics/:topic/groups/:group {startId?}` — create a consumer group
- `DELETE /v1/stream/topics/:topic/groups/:group` — destroy a consumer group
- `POST /v1/stream/topics/:topic/groups/:group/read {consumer, count?, blockMs?, autoAck?}` — read via consumer group
- `POST /v1/stream/topics/:topic/groups/:group/ack {ids:[]}` — acknowledge processed event IDs


Delivery semantics: consuming leases a message and increments `attempts`. Ack
deletes it. Nack requeues it, or dead-letters it when `requeue:false` or
`attempts >= maxAttempts`. Expired leases are reclaimed to pending regardless of
attempts, so consumers must be idempotent. `maxAttempts` 1..100 (default 5),
visibility 1..3600s (default 30), delay ≤7 days, consume/ack/publish batch ≤100,
payload ≤ `QUEUE_MAX_PAYLOAD_BYTES` (default 256 KiB). Dedupe suppresses duplicates
only while the original message still exists.

## SynapseOCS object storage (`ocs:4010`, gateway `/v1/ocs`)

SynapseOCS adds bucket-aware APIs while keeping the legacy default-bucket
`/v1/storage` routes. Buckets and objects are tenant-scoped; cross-tenant
access returns `404`.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/v1/ocs/buckets` | List buckets (`withStats=1` adds object/byte counts). |
| POST | `/v1/ocs/buckets` | Create `{name, quotaBytes?}`. |
| GET/HEAD | `/v1/ocs/buckets/:bucket` | Bucket metadata/usage. |
| GET | `/v1/ocs/buckets/:bucket/stats` | `{objects, bytes, quotaBytes}`. |
| DELETE | `/v1/ocs/buckets/:bucket?force=true` | Delete an empty bucket, or all objects with `force`. |
| PUT/GET/HEAD/DELETE | `/v1/ocs/buckets/:bucket/objects/*` | Raw object body; checksum, range and conditional headers supported. |
| GET | `/v1/ocs/buckets/:bucket/objects?prefix=&delimiter=&limit=&cursor=` | List with common prefixes. |
| POST | `/v1/ocs/buckets/:bucket/objects/copy` | Copy `{sourceBucket?,sourceKey,destinationKey,contentType?}`. |
| POST | `/v1/ocs/buckets/:bucket/presign` | `{key,method?,expiresIn?}` → HMAC-signed `{url}` (both backends). |
| POST | `/v1/ocs/buckets/:bucket/uploads` | Start multipart `{key,contentType}`. |
| PUT | `/v1/ocs/buckets/:bucket/uploads/:id/parts/:n?key=...` | Upload a raw part. |
| POST | `/v1/ocs/buckets/:bucket/uploads/:id/complete` | Complete `{key,parts}`. |
| DELETE | `/v1/ocs/buckets/:bucket/uploads/:id?key=...` | Abort an upload. |

## Legacy object storage (`/v1/storage`)

Tenant-scoped object/file storage. See `docs/object-storage.md` for the backend
configuration and SDK examples.

- `PUT /v1/storage/objects/*` — raw binary upload/upsert (`x-object-checksum-sha256` optional)
- `GET /v1/storage/objects/*` — raw binary download
- `HEAD /v1/storage/objects/*` — metadata (`ETag`, `x-object-checksum-sha256`, size)
- `DELETE /v1/storage/objects/*` → `{ok, key}`
- `GET /v1/storage/objects?prefix=&limit=&cursor=` → `{objects, nextCursor}`
- `POST /v1/storage/presign {key, method?, expiresIn?}` → `{url}` (S3 backend; `501` on fs)
- `POST /v1/storage/uploads {key, contentType}` → `{uploadId}`
- `PUT /v1/storage/uploads/:id/parts/:n?key=...` — raw part body → `{partNumber, etag}`
- `POST /v1/storage/uploads/:id/complete {key, parts}` → `{object}`
- `DELETE /v1/storage/uploads/:id?key=...` → `{ok}`

## Notifications (`notifications-service:4011`, gateway `/v1/notifications`)

See `docs/notifications.md`.

- `POST /v1/notifications {channels|channel, recipient, subject?, body, data?, idempotencyKey?}` → `202 {notifications}`
- `GET /v1/notifications?status=&limit=` → `[notification]`
- `GET /v1/notifications/:id` → status + attempt history
- `POST /v1/notifications/:id/cancel` → cancelled notification (`409` when not cancellable)
- `GET/PUT /v1/notifications/preferences/:recipient` → `{tenant, recipient, channels, unsubscribed}`
- `POST /v1/notifications/unsubscribe {recipient}` → preference

## Usage analytics & request telemetry (`iam-service`, gateway `/v1/usage`)

The gateway records one event per matched route at response `finish` (buffered
and flushed in batches to `POST /v1/usage/ingest` with the internal secret —
`USAGE_TELEMETRY=false` disables it). IAM persists events in Postgres
(`usage_events`, migration `0001_true_zodiak`; in-memory fallback in dev) and
only ever serves the caller's own org slice. `/v1/usage` itself is excluded
from telemetry.

- `GET /v1/usage/summary?from&to&feature&statusClass&method&q&accountId` →
  `{range:{from,to}, totals:{requests,success,clientErrors,serverErrors,errorRate,avgMs,p95Ms,uniqueUsers,uniqueAccounts,lastRequestAt}, features:[{feature,requests,share,clientErrors,serverErrors,errorRate,avgMs,p95Ms,lastRequestAt}], series:[{ts,requests,success,errors,avgMs}], topRoutes:[{route,requests,errors,avgMs}]}`
- `GET /v1/usage/events?from&to&limit&offset&feature&statusClass&method&q&accountId`
  → `{total, limit, offset, items:[{id,createdAt,requestId,feature,route,method,path,status,durationMs,authKind,orgId,accountId,userId,userEmail,error}]}`
  (newest first) — the drill-down source for the console request log.
- `POST /v1/usage/ingest {events:[…]}` → `202 {ok, accepted}` — service-to-service
  only (`X-SynapseOne-Internal`); requires `SYNAPSEONE_INTERNAL_SECRET` in prod.
- Filters: `feature` (`iam|workflows|ai|lds|base|faststore|queue|auth|…`),
  `statusClass` (`2xx|3xx|4xx|5xx`), `method`, `q` (matches path / request id),
  `accountId` (optional — omit for org-wide telemetry; login JWTs carry only an
  `org` claim, so account-filtered queries only see API-key/service-account
  traffic). `from`/`to` are ISO timestamps (defaults: last 24 h, max 366 days);
  `limit` 1..200 (default 20), `offset` ≤ 10 000.
- Retention: sweep every hour, `USAGE_RETENTION_DAYS` (default 30, `0` keeps
  events forever).

## AI assistant and inference (`ai-service:4003`, `inference-service:4008`)

The assistant is guidance-only: it suggests an endpoint and drafts a request,
but never executes it. Inference is an OpenAI-compatible LLM proxy plus local
embeddings and Decision-2.0 routing used by the workflow AI nodes.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/v1/ai/agent` | Docs assistant: `{question (1..2000), history?}` → endpoint suggestion, path values, body and explanation. Requires `AI_API_KEY`; `503 ai_not_configured` otherwise. |
| GET | `/v1/inference/health` | LLM/embedding/decision subsystem health. |
| POST | `/v1/inference/chat/completions` | OpenAI-compatible chat completion; SSE when `stream:true`; supports `tools`, `tool_choice` and `response_format`. |
| POST | `/v1/inference/embeddings` | Self-hosted embeddings: `{input: string|string[], model?}` → OpenAI-shaped vectors. |
| POST | `/v1/inference/decision` | Structured evaluation: `{state, questions:{id:{type:"choice"|"noul"|"score", instructions, criteria?}}}`. |
| POST | `/v1/inference/decision/route` | Semantic router: `{input, choices:{id:description}, instruction?}` → `{best_choice, confidence, probabilities}`. |

The chat proxy is also mounted at `/v1/chat/completions`; the other inference
handlers accept the `/v1/embeddings` and `/v1/decision*` aliases. The public
gateway only exposes `/v1/ai` and `/v1/inference` (the aliases stay internal).

## Platform Super Admin (`/v1/platform`)

These routes are **not** part of the tenant API catalog and are not exposed to
the AI assistant. They require a platform-administrator token
(`kind=platform-admin`, audience `synapseone-platform-admin`) obtained from
`POST /v1/platform/session` with a normal user JWT **and a fresh TOTP code**.
Tenant JWTs, API keys and service-account tokens are rejected.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/v1/platform/session` | Exchange a normal user JWT + TOTP for a 15-minute platform token. |
| POST | `/v1/platform/step-up` | `{code|recoveryCode, action}` → one-time step-up proof bound to this platform session and action (`x-platform-step-up`). |
| GET | `/v1/platform/me` | Current platform role, user and MFA state. |
| GET | `/v1/platform/overview?from&to` | Cross-tenant counts, usage totals and audit signals. |
| GET | `/v1/platform/orgs?q&limit&offset` | Tenant organizations with counts. |
| POST | `/v1/platform/orgs` | Create an organization and its first org admin. |
| GET | `/v1/platform/orgs/:orgId` | Organization detail, accounts and admins. |
| POST | `/v1/platform/orgs/:orgId/accounts` | Create a tenant account (step-up `org:account:create`). |
| GET | `/v1/platform/users?q&orgId&active&isOrgAdmin&limit&offset` | Cross-tenant users. |
| GET | `/v1/platform/users/:userId` | User, roles, policies, MFA and sessions. |
| PUT | `/v1/platform/users/:userId/org-admin` | Grant/revoke org admin (step-up). |
| POST | `/v1/platform/users/:userId/reset-mfa` | Reset MFA and revoke sessions/API keys (step-up). |
| POST | `/v1/platform/users/:userId/invite` | Re-issue a one-time activation code for a passwordless tenant user (step-up). |
| POST | `/v1/platform/users/:userId/unlock` | Clear a sign-in lockout. |
| POST | `/v1/platform/users/:userId/revoke-sessions` | Revoke refresh sessions (step-up). |
| POST | `/v1/platform/users/:userId/disable` | Deactivate a user (step-up). |
| POST | `/v1/platform/users/:userId/enable` | Reactivate a user. |
| GET | `/v1/platform/usage/summary` | Platform-wide usage summary (optional `orgId`). |
| GET | `/v1/platform/usage/events` | Platform-wide request log (optional `orgId`). |
| GET | `/v1/platform/audit` | Platform-wide audit (optional `orgId`). |
| GET/POST/DELETE | `/v1/platform/admins[/:userId]` | Owner-only platform administrator management. |

Internal bootstrap/recovery endpoints (`/internal/platform/bootstrap`,
`/internal/platform/recovery`) are reachable only over the service network and
require the internal service header plus their separate bootstrap/recovery
secret. They issue/consume one-time activation codes; see
[`platform-superadmin.md`](platform-superadmin.md).

## Health / Metrics

- `GET /health` (each service + gateway)
- `GET /ready` (gateway: aggregates iam, workflow, ai, lds, base, faststore and
  queue; 503 when any upstream is degraded)
- `GET /metrics` (gateway, Prometheus); each service also exposes `/metrics` with
  its own `synapseone_<service>_*` metrics

## Tracing

- The gateway assigns `x-request-id` (keeps a client-sent one), returns it in the
  response and forwards it upstream.
