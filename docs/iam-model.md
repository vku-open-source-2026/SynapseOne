# IAM model — AWS-style

## Hierarchy

```
Organization (globally unique slug, e.g. `acme`)
 └─ Account (slug unique within the org, e.g. `prod`, `staging`)
     ├─ Role (e.g. `admin`, `viewer`, `etl-runner`)
     ├─ Policy (AWS-style JSON, attached to Roles via role_policies)
     ├─ User (belongs to an Org, granted Roles via user_roles — can span accounts)
     ├─ ApiKey (belongs to an Account, SHA-256 hash, prefix lookup)
     └─ ServiceAccount (machine identity)
Global: audit_log records authorize decisions, **every IAM mutation**
(org/account/user/role/policy/key/service-account/password/token-exchange) and
**data-plane mutations** from Base, Faststore, Queue, Stream, Workflow and LDS — see
`GET /v1/audit`.
```

### Audit trail (authorize + IAM + data plane)

- IAM writes its own rows. The data-plane services post one event per non-GET
  `/v1/*` write (`POST/PUT/PATCH/DELETE`) to the internal
  `POST /v1/audit/ingest` endpoint in batches; the shared
  `SYNAPSEONE_INTERNAL_SECRET` authenticates the producer and the gateway-stamped
  headers supply actor/org/account. Reads (`query`, `vector-search`, `read`,
  `contains`, `score`, `rank`, `search`) are not logged.
- Each event carries `actorType` (`user`/`service`/`apikey`/`anonymous`),
  `actorId`, `orgId`, `accountId`, `action` (`base:collections.documents:create`),
  `resource` (route template), `result` (`allowed`/`denied`/`error`),
  `statusCode` and `requestId`. `decision` stays the historical boolean
  (`result === "allowed"`); the precise result is in `context.result`.
- Privacy: request bodies, query strings, Authorization headers and secret-looking
  path params (`key`, `token`, `secret`, `session`, …) are never recorded.
- Events are buffered in memory (max 1000, flushed every 5 s, 100/batch) and a
  failed ingest never fails the data write. Set `AUDIT_TRAIL=false` to disable.
- `GET /v1/audit` is tenant-scoped: `from`, `to`, `action`, `resource`, `actor`,
  `allowed`, `limit` (1..200) and `offset` (0..100 000). Machine callers without
  an org see nothing. Set `AUDIT_RETENTION_DAYS` (e.g. `180`) for hourly purges;
  export by paging the same filters (no bulk download endpoint).

## Policy JSON

```json
{
  "Version": "2026-01-01",
  "Statement": [
    { "Effect": "Allow", "Action": ["workflow:Execute", "workflow:Read"], "Resource": "*" },
    { "Effect": "Deny", "Action": ["iam:*", "org:Delete"], "Resource": "*" }
  ]
}
```

- `Action`: `service:Verb`, supports `*` and `prefix:*` (e.g. `workflow:*`, `iam:*`).
- `Resource`: ARN-ish or `*` (e.g. `arn:synapseone:acme:prod:workflow:etl-nightly`).
- Evaluation: **explicit Deny wins → Allow → default Deny**.

## Condition (AWS subset)

Statements support `Condition` with `StringEquals`, `StringLike` (`*` wildcard) and
`...IfExists` variants (skip missing keys). Unknown operators → conservative deny.

```json
{ "Effect": "Allow", "Action": ["data:Read"], "Resource": "*",
  "Condition": { "StringEquals": { "team": "etl" } } }
```

`POST /v1/authorize` accepts extra `context` (e.g. `{"team":"etl"}`); the server always
forces `user/org/email` from the DB so callers can't spoof those keys. Dry-run takes
`context` directly.

## Tokens

| Type | Format | Default TTL | Storage |
|---|---|---|---|
| Access JWT | Bearer `eyJ...` (HS256) | 3600s | stateless, verified with `IAM_JWT_SECRET` |
| Refresh | `synapseone_rt_...` opaque, **rotating** | 30 days | HMAC-SHA256 hash (with `IAM_API_KEY_PEPPER`; legacy SHA-256 still verifies) in `refresh_tokens`; single-use, revoked on logout |
| API key | `synapseone_...` | optional/no expiry | HMAC-SHA256 hash (pepper, legacy fallback) in `api_keys` + prefix index, revoke with `DELETE /v1/keys/:id` |
| Service account | Bearer JWT `kind=service-account` | 3600s | stateless, carries the `account` scope |
| Delegated user token | Bearer JWT `kind=delegated` + `act` | 900s (60–3600) | short TTL, bound to one user/org/account with an audience and a scopes subset (`POST /v1/auth/exchange`) |

Notes: access JWTs are stateless so they **can't be individually revoked** — keep a short
TTL (1h) and revoke at the refresh layer (`/v1/auth/logout`, `/v1/auth/logout-all`). For
instant revocation: rotate `IAM_JWT_SECRET` (restart iam+gateway, all old JWTs die).

### Scope enforcement (implemented)

The gateway verifies API keys against IAM (`GATEWAY_VERIFY_APIKEY=true`, fail-closed)
and then enforces a per-route scope:

- scope grammar: `*`, `<service>:*`, `*:read`, `*:write`, `<service>:read|write`, or a
  concrete verb (`faststore:get`, `workflow:execute`).
- user JWTs carry `*` (org-member authority); API keys and delegated tokens are
  narrow by construction and can only do what their scopes allow. A denied call is
  `403 scope_denied` before the upstream sees it.
- minting an API key or service-account token can never widen the caller's scopes:
  a credential without `*` requesting an outside scope gets `403 scope_escalation`.
  Omitting key scopes yields least-privilege `["*:read"]`, not `["*"]`.
- `/v1/authorize` only evaluates users in the caller's org (`403 cross_tenant`
  otherwise) and writes audit rows into the caller's org, never the target's.
- `/v1/audit` supports `from/to`, `action`, `resource`, `actor`, `allowed`, `org`
  (implicit), `limit` and `offset`.

### First-party credential lifecycle (implemented)

`POST /v1/auth/register`, `POST /v1/auth/login` (email+password), `POST /v1/auth/password/change`,
`POST /v1/auth/password/forgot`, `POST /v1/auth/password/reset`,
`POST /v1/auth/email/verify`, `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`.
Passwords are scrypt-hashed; reset/verification tokens are single-use and hashed at
rest; changing/resetting a password revokes all refresh sessions. Registering into an
**existing** org requires an invitation (an existing user row); a brand-new org is
self-service unless `IAM_REGISTRATION_ALLOW_NEW_ORGS=false`.

### Delegated identity for Tier 2 (implemented)

`POST /v1/auth/exchange` takes a service-account token or API key plus
`{userId, accountId?, orgId?, scopes?, audience?, ttlSeconds?}` and returns a
short-lived token for that user. It refuses cross-tenant targets and scope
escalation and audits every exchange. Tier 2 must use this instead of forwarding a
Tier-3 HMAC token plus one shared service key.
API keys: `scopes` are action patterns (`*`, `storage:*`, `workflow:Execute`). A key
created with `userId` is **owner-bound** and inherits that user's permissions; without
an owner it is an account-level key bounded by its scopes alone. Keys record
`last_used_at` and can be rotated (`POST /v1/keys/:id/rotate {graceSeconds}` — the old
secret stays valid for the grace window, 0 = revoked immediately). Users can list and
revoke their own sessions (`GET/DELETE /v1/auth/sessions[/:id]`).

## Multi-factor authentication and sign-in lockout (implemented)

Users can add a TOTP authenticator (RFC 6238: SHA-1, 6 digits, 30 s; Google
Authenticator, Microsoft Authenticator, 2FAS…):

1. `POST /v1/auth/mfa/totp/setup` → `{secret, otpauthUrl}` (show it as a QR code).
2. `POST /v1/auth/mfa/totp/enable {code}` → 10 single-use recovery codes, shown once.
3. From then on, password or dev login answers `401 mfa_required` with a 5-minute
   `mfaToken`; `POST /v1/auth/mfa/verify {mfaToken, code | recoveryCode}` returns the
   session. The challenge token is signed with a separate key and issuer, so it is
   never accepted as an access token.

| Property | Behaviour |
|---|---|
| Secret at rest | AES-256-GCM, key `IAM_MFA_ENCRYPTION_KEY` (or HKDF of `IAM_JWT_SECRET`) |
| Replay | each TOTP time step is accepted once (`user_mfa.last_step`) |
| Recovery codes | 10 × `xxxx-xxxx`, SHA-256 hashed, single use, regenerate with a TOTP code |
| Lockout | `IAM_LOGIN_MAX_FAILURES` (5) wrong passwords **or** MFA codes → `429 account_locked` for `IAM_LOGIN_LOCKOUT_SECONDS` (900); unknown emails are never locked |
| Rate limit | per IP on login and MFA routes (`IAM_LOGIN_RATE_LIMIT_PER_MIN`, `IAM_MFA_RATE_LIMIT_PER_MIN`, 60) |
| Lost device | an org admin calls `DELETE /v1/users/:id/mfa`; `POST /v1/users/:id/unlock` clears a lockout |
| SSO | OIDC sign-ins rely on the identity provider's own MFA |

Tables: `user_mfa` and the `users.failed_login_count` / `users.locked_until` columns
(migration `0006_mfa_lockout`). Every enable, disable, reset, failed second factor and
lockout is written to the audit log.

## Organization administrators

The first user of an organization becomes its administrator (`is_org_admin`, AWS
"root"-like): full access inside its own org unless a policy explicitly denies. Later
users start with **no permissions**. Admins manage admins with
`PUT /v1/users/:userId/org-admin {isOrgAdmin}`; the last admin cannot be demoted.

## Platform administrators

`platform_admins` is a separate, cross-tenant control plane. It is **not**
`is_org_admin` and does not grant tenant data access. A platform administrator:

- must be a member of the reserved `PLATFORM_ORG_SLUG` organization;
- must have TOTP MFA enabled and provide a fresh code at
  `POST /v1/platform/session`;
- receives a short-lived token (`kind=platform-admin`,
  `aud=synapseone-platform-admin`, no tenant org claim);
- only reaches `/v1/platform/*`; tenant APIs reject that token;
- has `owner`, `operator` or `auditor` role, checked server-side.

Destructive actions require a second TOTP step-up
(`POST /v1/platform/step-up`, header `x-platform-step-up`). The first owner is
created through the internal one-time bootstrap endpoint (see
[`platform-superadmin.md`](platform-superadmin.md)).

## Privileged IAM mutations

`IAM_SENSITIVE_MUTATION_MODE` controls whether account/user/role/policy/key/SA
mutations require an organization administrator:

- `audit` (default): evaluate, write a would-deny audit row, allow;
- `enforce`: return `403 org_admin_required` for members.

Production should use `enforce`. API-key owner binding is stricter: a member can
only bind a key to themselves; binding another user requires an org admin.

## Managed policies

`GET /v1/managed-policies` lists ready-made documents — `AdministratorAccess`,
`PowerUserAccess` (all but `iam:*`), `ReadOnlyAccess` (`*:Read|Get|List|Describe`),
`StorageFullAccess`, `StorageReadOnlyAccess`, `DataFullAccess` (Base, Faststore, Queue,
Stream, Storage). Instantiate one in an account with
`POST /v1/accounts/:accountId/policies {slug, managed: "ReadOnlyAccess"}` and attach it
to a role like any other policy. Service accounts can hold roles too
(`POST /v1/service-accounts/:id/roles {roleId}`).

## Central enforcement at the gateway

With `AUTHZ_MODE=audit|enforce`, every authenticated request on a route that declares
a `service` is mapped to an action and an ARN and decided by IAM for the verified
principal:

```
GET /v1/storage/objects/reports/q3.pdf   (user in org O)
  → action   storage:Read
  → resource arn:synapseone:O:-:storage:objects/reports/q3.pdf
  → allowed = scopes(credential) ∧ (org admin ∨ identity policies Allow) ∧ ¬explicit Deny
```

`GET`/`HEAD` → `Read`, `DELETE` → `Delete`, other methods → `Write`; routes override
RPC-style POSTs (`…/query` → `base:Read`, `…/execute` → `workflow:Execute`,
`/v1/ai/*` → `ai:Invoke`). `audit` only logs
(response header `x-synapseone-authz: would-deny; …`), `enforce` answers
`403 {error:"access_denied", action, resource, reason}`. Denials are written to the
audit log (`GET /v1/audit?allowed=false`). Decisions are cached for
`AUTHZ_CACHE_TTL_MS` (30 s).

## OIDC (Authentik / Keycloak)

- `GET /v1/auth/oidc/config` — issuer/client (+ `codeExchange` capability flag).
- `GET /v1/auth/oidc/start?org=<slug>` — resolves the authorize endpoint from the
  IdP discovery document and appends an HMAC-signed, 10-minute `state`.
- `POST /v1/auth/oidc/callback {code, state}` — **real** Authorization Code exchange:
  the code is redeemed at the IdP token endpoint and the ID token is verified against
  the IdP JWKS (asymmetric signature required, issuer + audience checked); a shadow
  user is created/updated from the verified `email`/`sub` claims and platform tokens
  are minted.
- `POST /v1/auth/oidc/callback {email, orgSlug}` — **demo** mode (dev only): trusts the
  caller-supplied email. Disable in production (`IAM_ALLOW_OIDC_DEMO_CALLBACK=false`).
- `OIDC_ISSUER` must be a **public HTTPS** URL in production (internal Docker hosts
  are rejected at boot and discovery endpoints must be HTTPS on the issuer origin).
- Switching to Keycloak only needs `OIDC_ISSUER=https://keycloak.example.com/realms/<realm>`
  + the matching client — no code changes.

## End-to-end authorization example (via gateway — direct :4001 needs auth, see SECURITY.md)

```bash
GW=localhost:8080
TOK=$(curl -s -XPOST $GW/v1/auth/login -H'Content-Type: application/json' -d'{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)
H="Authorization: Bearer $TOK"
ORG=$(curl -s $GW/v1/orgs -H"$H" | jq -r '.[0].id')
ACC=$(curl -s $GW/v1/orgs/$ORG/accounts -H"$H" | jq -r '.[0].id // empty')
# if there is no account yet:
ACC=$(curl -s -XPOST $GW/v1/orgs/$ORG/accounts -H'Content-Type: application/json' -H"$H" -d'{"slug":"prod","displayName":"Production"}' | jq -r .id)
ROLE=$(curl -s -XPOST $GW/v1/accounts/$ACC/roles -H'Content-Type: application/json' -H"$H" -d'{"slug":"etl-runner"}' | jq -r .id)
POL=$(curl -s -XPOST $GW/v1/accounts/$ACC/policies -H'Content-Type: application/json' -H"$H" -d'{"slug":"run-only","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}' | jq -r .id)
curl -XPOST $GW/v1/roles/$ROLE/attach -H'Content-Type: application/json' -H"$H" -d"{\"policyId\":\"$POL\"}"
```
