# Platform Super Admin — account and login

This page documents the **real Platform Owner account** created on the isolated
local development stack. It contains no secrets. The password, TOTP secret and
recovery codes are stored only in the Git-ignored file:

```text
.local/platform-superadmin-credentials.txt   (mode 600)
```

> This account is a local development account. It is **not** a production
> account and must never be copied to a production deployment. The stack binds
> to `127.0.0.1` only.

## Login information

| Field | Value |
|---|---|
| Console login URL | <http://127.0.0.1:3001/login> |
| Super Admin Dashboard | <http://127.0.0.1:3001/admin/overview> |
| Email / username | `platform.owner@synapseone.local` |
| Organization slug | `synapseone-platform` |
| Platform role | `owner` |
| Account type | Platform Super Admin (human) |
| Account status | **Active**, email verified, TOTP MFA enabled |
| Credential file | `/home/phamngoclananh30032009/OLP_OSS_2026/SynapseOne/.local/platform-superadmin-credentials.txt` |

The account is a member of the reserved platform organization. It is **not**
a tenant `is_org_admin`; platform privileges come from an active
`platform_admins` row with role `owner`.

## Stack endpoints

| Component | URL | Notes |
|---|---|---|
| Console (static build) | `http://127.0.0.1:3001` | isolated local copy |
| Gateway | `http://127.0.0.1:48082` | API entry point, `AUTHZ_MODE=enforce` |
| IAM | `http://127.0.0.1:4405` | internal, not exposed publicly |
| PostgreSQL | `127.0.0.1:55436` | disposable container `synapseone-sa-db` |

The existing production-like stack on ports `3000` / `8080` / `4001` was not
used or modified.

## Sign-in procedure

1. Open <http://127.0.0.1:3001/login>.
2. Enter the email, organization slug and initial password from
   `.local/platform-superadmin-credentials.txt`.
3. The Console asks for an authenticator code because MFA is enabled.
4. Open the TOTP secret from the credentials file in Google Authenticator,
   1Password, Authy or any RFC 6238 client and enter the current 6-digit code.
5. You land on the tenant Dashboard. Open `/admin` (or
   `/admin/overview`) to start the platform session.
6. Enter a **fresh** authenticator code (or a recovery code) when the platform
   guard asks. This exchanges the normal user JWT for a short-lived
   `kind=platform-admin` token.
7. The Overview page opens. The top bar shows the `owner` role.

The platform session token is kept in `sessionStorage`, not `localStorage`, and
is only sent to `/v1/platform/*`. Closing the tab ends the platform session.

## Administrative modules

| Module | Route | What it does |
|---|---|---|
| Overview | `/admin/overview` | Cross-tenant KPIs, request chart, service health summary, recent platform activity, security signals |
| Organizations | `/admin/orgs` | Search/paginate tenant organizations, view details, create an organization with its first org admin |
| Users & Access | `/admin/users` | Cross-tenant user search, org filters, MFA/session state, grant/revoke org admin, reset MFA, unlock, disable/enable, revoke sessions |
| Service Health | `/admin/health` | Gateway `/ready` upstream probes, manual and 30-second auto-refresh |
| Usage | `/admin/usage` | Platform-wide request volume, errors, latency, tokens, feature/route breakdown, recent usage events |
| Audit & Security | `/admin/audit` | Platform-wide audit search by org, actor, action, decision and time; event detail viewer |
| Platform Admins | `/admin/access` | Owner-only list/grant/revoke of `owner`, `operator`, `auditor`; last-owner protection |

Visiting `/admin` without a platform session shows the MFA exchange screen. A
tenant user who is not a platform administrator is denied and sees
"This account is not an active platform administrator."

## Step-up authentication

These actions require a second fresh TOTP/recovery code in the confirmation
dialog (`x-platform-step-up`, 5-minute token):

- Grant or revoke organization administrator.
- Reset a user's MFA.
- Disable a user or revoke their sessions.
- Grant or revoke a Platform Administrator.
- Revoke a platform administrator.

A successful action is written to the platform audit trail. If the step-up
token is missing or invalid, the API returns
`403 platform_step_up_required` and the action is not performed.

## Password rotation

First-login forced password change is not implemented in this IAM version.
Rotate the initial password immediately after the first sign-in.

### Option A — API (recommended for this stack)

```bash
# 1. Sign in (password + MFA) and keep the user access token.
#    The token is returned by POST /v1/auth/mfa/verify.
# 2. Change the password.
curl -sX POST http://127.0.0.1:48082/v1/auth/password/change \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"currentPassword":"<current>","newPassword":"<new-strong-password>"}'
```

Password policy: at least 12 characters, not equal to the email, and not one of
the common password prefixes. Changing the password revokes all refresh
sessions; the current access token remains valid until its short TTL expires.

### Option B — password reset token

```bash
curl -sX POST http://127.0.0.1:48082/v1/auth/password/forgot \
  -H 'Content-Type: application/json' \
  -d '{"email":"platform.owner@synapseone.local","orgSlug":"synapseone-platform"}'
```

On this isolated stack `IAM_EXPOSE_LIFECYCLE_TOKENS=true`, so the response
contains `resetToken` (the real deployment should send it by email instead).
Use it with `POST /v1/auth/password/reset`.

After rotation, update `.local/platform-superadmin-credentials.txt` (the
credentials file is the single local source of truth).

## Account recovery

### Recovery codes

A fresh set of **10 unused recovery codes** is stored in the credentials file
after the final verification pass. Each code is single-use and works at:

- the login MFA challenge ("Use a recovery code"), and
- the platform step-up dialog (a proof is bound to the current platform session
  and to one action).

### MFA lost, recovery codes lost

Use the internal break-glass endpoint (no gateway route). It requires
`PLATFORM_RECOVERY_SECRET` and writes a `platform:recovery:*` audit record:

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

`reset-mfa` and `revoke-sessions` also revoke refresh sessions and API keys.

For this isolated stack, use the IAM port `4405` and run the equivalent
`fetch("http://127.0.0.1:4405/internal/platform/recovery", ...)` from the host.
The platform user ID is in the credentials file.

### Password lost

Use `POST /v1/auth/password/forgot` + `POST /v1/auth/password/reset` as shown
above, or another platform owner can reset the account from `/admin/users`.

## Verification performed

### Backend provisioning

All checks passed:

- One-time bootstrap created the platform organization (`kind=platform`) and
  the first `owner`; a second bootstrap attempt returned `409`.
- One-time invite activation, email verification, TOTP enrolment (10 recovery
  codes), password login and the MFA login challenge succeeded.
- Step-up proofs are single-use, session-bound and action-bound; replay and
  cross-action reuse returned `403 platform_step_up_required`.
- The only owner could not be demoted through `POST /v1/platform/admins`
  (`409 last_owner`).
- Platform session exchange returned a platform token with role `owner`.
- `/v1/platform/me`, `/overview`, `/orgs`, `/users`, `/usage/summary`,
  `/audit` and `/admins` returned real database data.
- A disposable tenant (`sa-e2e-*`) was created with a first org admin.
- The tenant admin could sign in but saw only its own organization.
- The tenant admin was denied on `/v1/platform/users`
  (`403 platform_admin_required`).
- The platform token was denied on `/v1/orgs`
  (`403 platform_token_tenant_forbidden`).
- A destructive action without step-up returned
  `403 platform_step_up_required`; replaying the same proof was rejected.
- Audit rows `platform:org:create`, `platform:user:revoke-sessions` and
  `platform:admin:grant/revoke` were present.
- Deleting the only owner returned `409 last_owner`; demoting the only owner
  also returned `409 last_owner`.
- A one-time invite code worked once, was rejected on replay, and direct
  email+org registration without a code returned `403 invite_required`.

### Browser verification (Playwright + Chromium)

All checks passed:

- Password + TOTP login through the real Console UI.
- Fresh TOTP platform session exchange and `/admin/overview`.
- `owner` role displayed.
- Organizations listed the disposable tenant.
- Users & Access listed the cross-tenant tenant admin.
- Usage and Audit modules rendered real API data.
- Service Health rendered the gateway readiness probe.
- Platform Admins listed the owner.
- A UI "Revoke sessions" action required step-up and wrote an audit record.
- Organization creation through the UI required step-up and returned a one-time
  activation code.
- Platform administrator grant/revoke through the UI required owner + step-up
  and returned a one-time activation code.
- The mobile layout, dark theme, admin 404 route and registration route worked.
- An auditor/tenant user could sign in to the tenant console but was blocked
  from `/admin` with no platform data rendered.

Screenshots (local only, Git-ignored):

```text
.local/browser-verification/
```

### Database state

```text
users.email              platform.owner@synapseone.local
users.active             true
users.email_verified     true
organizations.slug       synapseone-platform
organizations.kind       platform
platform_admins.role     owner
platform_admins.revoked  NULL (active)
user_mfa.enabled         true
user_mfa.recovery_left   10
platform_step_ups        active one-time proof table
```

Service Health shows the other upstreams as down/degraded because this isolated
stack only runs IAM and the gateway. That is an accurate probe result, not a UI
failure.

## Product-database compatibility verification

This workspace's normally configured database is the live production database
(`synapseone-postgres-1`). To avoid altering or deploying production without a
separate deployment instruction, the same code was verified against a faithful
`pg_dump` clone of that database:

- Restored 46 users, 2 organizations and 44 organization administrators.
- Applied IAM migrations `0007` and `0008` to the clone.
- Bootstrapped a distinct Platform Owner
  (`platform.owner.product@synapseone.local`) on the clone.
- Verified invite activation, email verification, TOTP MFA, platform session,
  owner role, Overview, Organizations, Users, Audit and Platform Admins.
- Created a tenant on the clone and verified tenant isolation.
- Ran 16 API checks + 8 Playwright checks; all passed.

The clone database, its dump and its temporary credentials were deleted after
verification; no clone secrets are retained. The production database and
production containers were not modified. To apply this to the product database,
follow the deployment steps in `docs/platform-superadmin.md` with a backup and a
maintenance window.

## Stopping the isolated stack

The account disappears if the disposable database container is removed. Stop
the processes without deleting the data:

```bash
kill "$(cat /tmp/opencode/sa-gateway.pid)" "$(cat /tmp/opencode/sa-iam.pid)" "$(cat /tmp/opencode/console-e2e.pid)"
docker stop synapseone-sa-db
```

Restart them with the same environment files to keep the account:

```bash
docker start synapseone-sa-db
set -a; . /tmp/opencode/sa-iam.env; set +a
nohup node apps/iam-service/dist/index.js >/tmp/opencode/sa-iam.log 2>&1 & echo $! >/tmp/opencode/sa-iam.pid
set -a; . /tmp/opencode/sa-gateway.env; set +a
nohup node apps/gateway/dist/index.js >/tmp/opencode/sa-gateway.log 2>&1 & echo $! >/tmp/opencode/sa-gateway.pid
nohup node /tmp/opencode/serve-console-e2e.mjs >/tmp/opencode/console-e2e.log 2>&1 & echo $! >/tmp/opencode/console-e2e.pid
```

To destroy the disposable account and database completely:

```bash
docker rm -f synapseone-sa-db
```

The production platform-owner bootstrap procedure (new deployment) is in
[`platform-superadmin.md`](platform-superadmin.md).
