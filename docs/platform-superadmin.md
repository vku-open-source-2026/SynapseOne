# Platform Super Admin

The Platform Super Admin is a **human-operated, cross-tenant control plane** for
SynapseOne. It is deliberately separate from `users.is_org_admin` (tenant-scoped)
and from the internal `SYNAPSEONE_INTERNAL_SECRET` platform caller.

## Security model

- A platform administrator is a user in the reserved platform organization
  (`PLATFORM_ORG_SLUG`, default `synapseone-platform`).
- Access is granted by a row in `platform_admins` (`owner`, `operator`,
  `auditor`). Removing/revoking the row takes effect on the next request.
- The platform console exchanges the normal user JWT **plus a fresh TOTP code**
  for a short-lived platform token:
  - `kind=platform-admin`
  - `aud=synapseone-platform-admin`
  - no tenant org/account claims
  - TTL 15 minutes
- The gateway only accepts that token on `/v1/platform/*`; a platform token is
  rejected on tenant APIs. Normal user JWTs are accepted only on
  `/v1/platform/session` for the exchange.
- API keys and service-account tokens cannot become platform sessions.
- Destructive actions require a second, short-lived step-up token
  (`x-platform-step-up`, TTL 5 minutes).
- The MVP is metadata-first: no tenant document, object or secret content is
  exposed through the six dashboard modules.

## Modules

| Module | Main API |
|---|---|
| Overview | `GET /v1/platform/overview`, `/v1/platform/usage/summary` |
| Organizations | `GET/POST /v1/platform/orgs`, `GET /v1/platform/orgs/:id` |
| Users & Access | `GET /v1/platform/users`, `GET /v1/platform/users/:id`, user action routes |
| Service Health | gateway `GET /ready` |
| Usage | `GET /v1/platform/usage/summary`, `/v1/platform/usage/events` |
| Audit & Security | `GET /v1/platform/audit` |
| Platform Admins | `GET/POST /v1/platform/admins`, `DELETE /v1/platform/admins/:id` |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PLATFORM_ADMIN_ENABLED` | `true` in dev, `false` in prod unless set | enables `/v1/platform/*` |
| `PLATFORM_ADMIN_REQUIRE_MFA` | `true` | requires an enrolled TOTP factor and a fresh code at session exchange |
| `PLATFORM_ADMIN_REQUIRE_STEP_UP` | `true` | requires step-up for destructive actions |
| `PLATFORM_ORG_SLUG` | `synapseone-platform` | reserved platform staff organization |
| `PLATFORM_BOOTSTRAP_SECRET` | empty | one-time first-owner bootstrap; empty disables it |
| `PLATFORM_RECOVERY_SECRET` | empty | break-glass reset for a platform admin who lost MFA |
| `IAM_SENSITIVE_MUTATION_MODE` | `audit` | `enforce` requires an org administrator for privileged IAM mutations |
| `IAM_ALLOW_DIRECT_ORG_CREATE` | `true` dev / `false` prod | direct `POST /v1/orgs` |
| `AUTHZ_MODE_REQUIRED` | `false` dev / `true` prod | gateway fails boot if `AUTHZ_MODE=off` |

Production recommendation:

```dotenv
AUTHZ_MODE=enforce
AUTHZ_MODE_REQUIRED=true
IAM_SENSITIVE_MUTATION_MODE=enforce
IAM_ALLOW_DIRECT_ORG_CREATE=false
PLATFORM_ADMIN_ENABLED=true
PLATFORM_ADMIN_REQUIRE_MFA=true
PLATFORM_ADMIN_REQUIRE_STEP_UP=true
PLATFORM_BOOTSTRAP_SECRET=<random 32+ chars>
PLATFORM_RECOVERY_SECRET=<random 32+ chars>
```

If the admin console is served from a separate host, add that exact origin to
`CORS_ORIGIN` and to the edge allowlist. Do not expose the internal bootstrap or
recovery endpoints through the gateway; they have no `routes.yaml` entry.

## First Platform Owner

The bootstrap endpoint is internal-only (no gateway route) and only works while
`platform_admins` is empty. It requires `PLATFORM_BOOTSTRAP_SECRET`.

### Docker Compose

```bash
# 1. Start the stack and apply the IAM migration on boot
docker compose up -d --build

# 2. Create the first platform owner (run inside the IAM container)
docker compose exec -T iam node -e '
const secret = process.env.PLATFORM_BOOTSTRAP_SECRET;
fetch("http://localhost:4001/internal/platform/bootstrap", {
  method: "POST",
  headers: { "content-type": "application/json", "x-platform-bootstrap-secret": secret },
  body: JSON.stringify({ email: "platform-owner@example.com", displayName: "Platform Owner" })
}).then(async r => { console.log(r.status, await r.text()); });
'
```

The endpoint returns `201` once and `409 bootstrap_completed` afterwards.

### Set a password (first-party login)

The bootstrap creates the user row without a password. Complete registration
with the usual endpoint (the existing membership rule allows it because the
user row already exists):

```bash
curl -sX POST http://localhost:8080/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"platform-owner@example.com","password":"<strong-password>","orgSlug":"synapseone-platform"}'
```

OIDC works too if the IdP identity is mapped to the same email in the platform
organization.

### Open the dashboard

1. Sign in at `/login` with the platform user.
2. Open `/security` and enable TOTP MFA (10 recovery codes are shown once).
3. Open `/admin`; enter a fresh authenticator code.
4. The Overview page loads platform-wide metadata.

### Recovery when the only owner loses MFA

`PLATFORM_RECOVERY_SECRET` enables an internal-only break-glass endpoint:

```bash
docker compose exec -T iam node -e '
const secret = process.env.PLATFORM_RECOVERY_SECRET;
fetch("http://localhost:4001/internal/platform/recovery", {
  method: "POST",
  headers: { "content-type": "application/json", "x-platform-recovery-secret": secret },
  body: JSON.stringify({ userId: "<platform-user-id>", action: "reset-mfa" })
}).then(async r => { console.log(r.status, await r.text()); });
'
```

Use `action: "revoke-sessions"` to clear refresh sessions. Every bootstrap and
recovery event is written to `audit_log`.

## Adding a second administrator

Use `/admin/access` (owner only), or:

```bash
# Owner platform token is required; step-up token is required by the API.
curl -sX POST http://localhost:8080/v1/platform/admins \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "x-platform-step-up: $STEP_UP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops@example.com","role":"operator","reason":"on-call rotation"}'
```

The account is created in the platform organization if needed. The person must
enrol TOTP before their first platform session.

## Database

IAM migration `0007_fluffy_scarecrow.sql` adds:

- `platform_admins` (user, role, grant metadata, revocation, reason)
- `organizations.kind` (`tenant` or `platform`)
- `audit_log.org_id` + `idx_audit_org_time`
- `idx_users_email_lower`, `idx_users_created_at`

The migration is additive and idempotent. Backfill existing audit rows with:

```bash
node tools/backfill-audit-org.mjs
```

The script batches updates and can be rerun safely.

## Rollback

1. Set `PLATFORM_ADMIN_ENABLED=false` (platform routes return 404; UI is inaccessible).
2. Revoke platform sessions:
   - set `platform_admins.revoked_at`, or
   - call `revokeAllRefresh` for the platform users.
3. Revert the gateway/console/IAM images if needed.
4. Keep the additive migration. Old code ignores `platform_admins`,
   `organizations.kind` and `audit_log.org_id`; do not drop them during an
   incident rollback.
5. If a security rollout must be relaxed, set
   `IAM_SENSITIVE_MUTATION_MODE=audit` and keep monitoring; do not leave it off.

See `docs/iam-model.md` and `docs/api.md` for the underlying IAM behavior.
