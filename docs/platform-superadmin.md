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
  (`x-platform-step-up`, TTL 5 minutes). A proof is **single-use**, bound to the
  issuing platform session (`sid`) and to one action such as `org:create`,
  `org:suspend`, `org:role:create`, `user:reset-mfa`, `user:enable` or
  `admin:grant`.
- The reserved platform slug cannot be created as a tenant. `bootstrap` refuses
  to reuse a tenant organization with that slug, and `currentPlatformAdmin`
  verifies the administrator's organization is `kind=platform`.
- Invited accounts (first tenant admin, additional platform admins, tenant
  users) are activated with a one-time code; email+org alone cannot claim an
  existing membership. Codes expire after 7 days by default.
- A user with rows in several organizations can list those contexts only after
  proving ownership of the email (`email_verified`); the caller's own context is
  always visible. Password login does not imply verification, so a self-
  registered row using a victim's email cannot enumerate the victim's other
  organizations, user ids or platform-admin status. Tenant → tenant switching
  additionally requires the target row's own password (and its MFA, when
  enrolled). Tenant → platform never mints a session and requires the platform-
  org login plus MFA. Even when the same email also has a platform admin row,
  the platform session is bound to the platform-org user row: a tenant row's
  password/TOTP never becomes platform proof. There is no email-only or
  impersonation path.
- Tenant organizations support `active`/`suspended` lifecycle. Suspension
  requires a reason and step-up, revokes sessions and API keys, and is enforced
  by IAM and the gateway. The reserved platform organization is protected from
  suspension; reactivation also requires step-up and a fresh tenant sign-in.
- The control plane is metadata-first: no tenant document, object or secret
  content is exposed through the dashboard modules.

## Modules

| Module | Main API |
|---|---|
| Overview | `GET /v1/platform/overview`, `/v1/platform/usage/summary` |
| Organizations | `GET/POST /v1/platform/orgs`, `GET /v1/platform/orgs/:id`, `/resources`, `/audit`, suspend/reactivate |
| Accounts | `GET /v1/platform/accounts` |
| Users & Access | `GET /v1/platform/users`, `GET /v1/platform/users/:id`, user action routes |
| Organization detail | Overview, Accounts, Members, Administrators, Roles, Policies, API Keys, Service Accounts, Audit tabs under `/admin/orgs/:id` |
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
| `PLATFORM_STEP_UP_TTL_SECONDS` | `300` | step-up proof TTL (60–900s) |
| `IAM_INVITE_TOKEN_TTL_SECONDS` | `604800` | invited-account activation code TTL (5 min–30 days) |
| `PLATFORM_BOOTSTRAP_SECRET` | empty | one-time first-owner bootstrap; empty disables it; production requires 32+ chars |
| `PLATFORM_RECOVERY_SECRET` | empty | break-glass reset for a platform admin who lost MFA; production requires 32+ chars |
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
PLATFORM_STEP_UP_TTL_SECONDS=300
PLATFORM_BOOTSTRAP_SECRET=<random 32+ chars>
PLATFORM_RECOVERY_SECRET=<random 32+ chars>
```

If the admin console is served from a separate host, add that exact origin to
`CORS_ORIGIN` and to the edge allowlist. Do not expose the internal bootstrap or
recovery endpoints through the gateway; they have no `routes.yaml` entry.

## First Platform Owner

The bootstrap endpoint is internal-only (no gateway route) and only works while
`platform_admins` is empty. It requires both `PLATFORM_BOOTSTRAP_SECRET` and,
when configured, the internal service header. It refuses a tenant organization
that already owns the reserved slug.

### Docker Compose

```bash
# 1. Start the stack and apply the IAM migration on boot
docker compose up -d --build

# 2. Create the first platform owner (run inside the IAM container)
docker compose exec -T iam node -e '
const secret = process.env.PLATFORM_BOOTSTRAP_SECRET;
fetch("http://localhost:4001/internal/platform/bootstrap", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-synapseone-internal": process.env.SYNAPSEONE_INTERNAL_SECRET,
    "x-platform-bootstrap-secret": secret
  },
  body: JSON.stringify({ email: "platform-owner@example.com", displayName: "Platform Owner" })
}).then(async r => { console.log(r.status, await r.text()); });
'
```

The endpoint returns `201` once and `409 bootstrap_completed` afterwards. The
response includes a one-time `inviteToken` (unless the account already has a
password).

### Activate the account

The bootstrap creates the user row without a password and returns a one-time
`inviteToken`. Activate it (or open `/register` in the Console and paste the
code):

```bash
curl -sX POST http://localhost:8080/v1/auth/invite/accept \
  -H 'Content-Type: application/json' \
  -d '{"token":"<inviteToken>","password":"<strong-password>"}'
```

The code is single-use, expires after 7 days by default, and does not require
the email+org pair. OIDC works too if the IdP identity is mapped to the same
email in the platform organization.

### Open the dashboard

1. Sign in at `/login` with the organization slug, email and password. The
   Console login form supports first-party password sign-in; OIDC is also
   available when configured.
2. Open `/security` and enable TOTP MFA (10 recovery codes are shown once).
3. After sign-in, platform administrators are routed to `/admin/overview`
   automatically, including dual-role users who typed a tenant slug. If the
   current row is a tenant row, the guard asks for the platform-organization
   sign-in; it does not upgrade the tenant identity. Complete the platform-org
   MFA, then enter a fresh authenticator code for the separate platform session.
4. The Overview page loads platform-wide metadata. Platform-only accounts do
   not see tenant navigation; dual-role accounts can switch to a tenant context
   they genuinely belong to.

A fully provisioned local account with passwords/TOTP stored outside Git is
documented in [`platform-superadmin-login.md`](platform-superadmin-login.md).

### Recovery when the only owner loses MFA

`PLATFORM_RECOVERY_SECRET` enables an internal-only break-glass endpoint:

```bash
docker compose exec -T iam node -e '
const secret = process.env.PLATFORM_RECOVERY_SECRET;
fetch("http://localhost:4001/internal/platform/recovery", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-synapseone-internal": process.env.SYNAPSEONE_INTERNAL_SECRET,
    "x-platform-recovery-secret": secret
  },
  body: JSON.stringify({ userId: "<platform-user-id>", action: "reset-mfa" })
}).then(async r => { console.log(r.status, await r.text()); });
'
```

Use `action: "revoke-sessions"` to clear refresh sessions. `reset-mfa` also
revokes refresh sessions and API keys. Every bootstrap and recovery event is
written to `audit_log`.

## Adding a second administrator

Use `/admin/access` (owner only), or:

```bash
# Owner platform token is required. Mint a one-time proof for this action:
# POST /v1/platform/step-up {"code":"123456","action":"admin:grant"}
curl -sX POST http://localhost:8080/v1/platform/admins \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "x-platform-step-up: $STEP_UP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops@example.com","role":"operator","reason":"on-call rotation"}'
```

The response includes `inviteToken` for a new account. Send it out-of-band; the
person activates it at `/register` and enrols TOTP before their first platform
session. The only owner cannot be demoted or revoked (`409 last_owner`).

## Database

IAM migrations add:

- `0007_fluffy_scarecrow.sql`: `platform_admins` (user, role, grant metadata,
  revocation, reason), `organizations.kind` (`tenant` or `platform`),
  `audit_log.org_id` + `idx_audit_org_time`, `idx_users_email_lower`,
  `idx_users_created_at`.
- `0008_shocking_grandmaster.sql`: `platform_step_ups` (one-time `jti`,
  user/session/action binding, expiry, used_at).
- `0010_wonderful_alex_wilder.sql`: `organizations.status`,
  `suspended_at`, `suspended_by`, `suspend_reason`; `service_accounts.revoked_at`.
  Additive and backwards-compatible (existing rows default to `active`).

The migrations are additive and idempotent. Backfill existing audit rows with:

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
4. Keep the additive migrations. Old code ignores `platform_admins`,
   `platform_step_ups`, `organizations.kind` and `audit_log.org_id`; do not drop
   them during an incident rollback.
5. If a security rollout must be relaxed, set
   `IAM_SENSITIVE_MUTATION_MODE=audit` and keep monitoring; do not leave it off.

See `docs/iam-model.md` and `docs/api.md` for the underlying IAM behavior.
