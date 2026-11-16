# Platform Super Admin — completion checkpoint

Status: **implemented, deployed to the current production host, and browser
verified**. No secrets are stored in this document.

## Verified scope

| Area | Evidence |
|---|---|
| Production Platform Owner | `platform_admins=1`, role `owner`, active TOTP MFA |
| Shared login | `https://cloud.synapseone.space/login` (same IAM/Console as tenants) |
| Platform session | TOTP exchange → `kind=platform-admin`, audience `synapseone-platform-admin`; tenant/platform tokens isolated |
| Overview | real counts, usage series, security signals, service health |
| Organizations | search, pagination, detail, creation, first-admin invite, account creation |
| Users & Access | cross-tenant search, detail, roles/policies, MFA/session state, org-admin/MFA/session/disable/enable actions |
| Service Health | gateway `/ready` probes real upstreams |
| Usage | summary, series, features, routes, models/tokens, event pagination |
| Audit & Security | platform-wide filters, pagination, detail viewer, denied events |
| Platform Admins | owner/operator/auditor grant/revoke, invite activation, last-owner protection |
| Tenant `/audit` | permission-aware notice when the account is not an org admin |

## Security fixes in the final branch

- Step-up proofs are one-time, session-bound and action-bound (`platform_step_ups`).
- Last owner cannot be demoted or revoked; owner counts exclude inactive users.
- Reserved platform slug cannot be squatted by registration/OIDC/direct org creation.
- Platform administrators must belong to a `kind=platform` organization.
- Invited accounts require one-time activation codes; email+org cannot claim a membership.
- MFA TOTP and recovery codes are consumed atomically under concurrent requests.
- Privileged platform audit writes retry and fail closed with `503 audit_write_failed`; denial audits never block the denial but log loudly.
- Revoking/disabling/MFA-reset clears refresh sessions and API keys.
- Step-up JWTs are rejected as tenant access tokens.
- Platform session is bound to the current tenant identity in the browser.
- Wrong TOTP no longer destroys the platform session.

## Verification evidence

### Local

- IAM: 159/159 tests passed after the final security changes.
- Gateway: 51/51 tests passed.
- Console SSR: all routes rendered.
- Postgres migration test: `0000`–`0008` applied on a disposable database.
- Atomic MFA race test passed against both memory and PostgreSQL.
- Migration/catalog/license gates passed.
- Isolated full-stack E2E: API 51/51, JS SDK, services, runner, MCP, OCS, workflow showcase.

### Production browser (Playwright + Chromium)

10/10 checks passed against `https://cloud.synapseone.space`:

- password + TOTP login;
- platform session with owner role;
- `/admin/overview`, `/admin/orgs`, `/admin/users`, `/admin/usage`,
  `/admin/audit`, `/admin/health`, `/admin/access`;
- tenant `/audit` shows the friendly “Cần quyền quản trị tổ chức” notice;
- no unexpected browser errors.

Screenshots: `.local/browser-verification/18-production-overview.png`,
`19-production-audit-notice.png`.

## Production deployment notes

- IAM, Gateway and Console were rebuilt from the committed branch and recreated
  individually with rollback tags. Database migrations `0007`/`0008` are present.
- The production IAM needs `IAM_ALLOW_INTERNAL_OIDC_ISSUER=true` while Authentik
  is only reachable at its internal Docker host; this is an explicit boot
  escape hatch and logs a warning. Configure a public `auth.synapseone.space`
  issuer later to remove it.
- The production gateway remains in `AUTHZ_MODE=audit` while existing API keys
  are policy-backfilled. Platform routes use independent strict kind/role/step-up
  checks; tenant IAM mutations use `IAM_SENSITIVE_MUTATION_MODE=enforce`.
- Production bootstrap secret was removed after the owner was created; the
  recovery secret remains in `.env` and the local-only 600 secrets file.
- Production owner credentials are in
  `.local/platform-superadmin-production-credentials.txt` (mode 600, ignored).
- Production owner `email_verified` is false because the production lifecycle
  token is not exposed and no mailer is wired; it does not block password + MFA
  login. Configure the mailer and verification flow before treating it as a
  verified business identity.

## Remaining limitations

- Admin page copy is still mostly English; the global VI/EN switch works in the
  admin chrome, but full admin-page localization is a follow-up.
- `AUTHZ_MODE=enforce` rollout for tenant API keys requires policy backfill and
  a monitored canary; do not flip it blindly on production.
- The local working tree contains unrelated in-progress usage-rollup/warehouse
  work. It was intentionally not committed by the Super Admin changes.
- A genuine public OIDC issuer is required to remove the internal-issuer
  override.

## CI

All required `Security` and `cd` jobs must be green on the final pushed SHA; see
the final delivery report for the exact run URLs and commit.
