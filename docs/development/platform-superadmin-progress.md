# Platform Super Admin — implementation progress

Branch: `feature/platform-superadmin`

## Completed

- [x] Phase 0 security verification and regression tests
  - Gateway scope bypass: route-derived service + action overrides, new tests.
  - API key owner binding: self-only for members; admin/platform admin for others.
  - SCIM token creation/revocation follows `IAM_SENSITIVE_MUTATION_MODE`.
  - Privileged IAM mutations (account/user/role/policy/key/SA/assign) use the same
    policy; audit mode logs would-deny, enforce returns 403.
  - Org-admin grant/revoke audit (actor, target, old/new, reason).
  - Audit reads org-admin only.
  - Direct org creation can be disabled; platform org API creates first admin.
  - `AUTHZ_MODE_REQUIRED` gateway boot guard.
- [x] IAM migration `0007_fluffy_scarecrow.sql` (platform_admins, org kind,
  audit org_id/index, user indexes) — idempotent SQL.
- [x] Platform identity/session/step-up, owner/operator/auditor roles.
- [x] Platform APIs: session, step-up, me, overview, orgs, users/actions,
  usage, audit, platform admins; internal bootstrap/recovery.
- [x] Gateway `/v1/platform` route, JWT-only, platform token isolation,
  scope/action enforcement, platform kind propagation.
- [x] Console admin area: AdminLayout/Sidebar/Topbar, PlatformGuard,
  PlatformAuthProvider, AdminActionDialog, six modules + Platform Admins.
- [x] Tests: IAM platform/security, gateway scope/platform, console SSR.
- [x] Docs: `docs/platform-superadmin.md`, IAM/API/console docs, CHANGELOG,
  env templates, Compose/K8s flags.
- [x] Real Platform Owner provisioning + verification on an isolated local stack
  (PostgreSQL container, IAM on 4405, gateway on 48082, static Console on 3001):
  - `platform.owner@synapseone.local`, org `synapseone-platform`, role `owner`.
  - Email verified, TOTP MFA enabled, 10 recovery codes (6 unused).
  - Platform session, six modules, tenant isolation, step-up and audit verified.
  - Playwright/Chromium browser pass: password login, MFA, all `/admin` modules,
    a step-up `Reset MFA` action, audit row, and a blocked tenant user.
  - Credentials only in `.local/platform-superadmin-credentials.txt` (600).
  - Docs: `docs/platform-superadmin-login.md`.
- [x] Console login supports first-party email + password (the previous UI only
  exposed dev login and API keys).
- [x] Gateway fix: `/v1/platform/session` reaches IAM instead of being denied by
  tenant policy enforcement; IAM audits denied exchanges. Regression test:
  `apps/gateway/src/platform-session.test.ts`.
- [x] Step-up replay fix: `platform_step_ups` (migration 0008), one-time `jti`,
  bound to the issuing platform session and one action. Replay/cross-action
  reuse rejected.
- [x] Last-owner protection extended to `POST /v1/platform/admins` demotion;
  active-owner count excludes inactive users.
- [x] Reserved platform slug protected from registration/OIDC/direct creation;
  bootstrap refuses a tenant org with the reserved slug.
- [x] Secure invite onboarding: bootstrap/org create/platform admin grant/tenant
  invite issue one-time activation codes; `POST /v1/auth/invite/accept` +
  Console `/register`. Direct email+org claim of an existing org is rejected.
- [x] Platform admin requests require membership in a `kind=platform` org.
  Step-up JWTs are rejected as access tokens by Gateway/IAM.
- [x] Revocation now clears refresh sessions and API keys for MFA reset,
  session revoke, disable and platform-admin revoke.
- [x] Console: step-up actions no longer auto-attach; wrong TOTP does not drop
  the platform session; identity binding on user switch/logout; role-aware
  actions; audit pagination/resource filter; usage event pagination/feature
  filter/model tokens; org creation + account creation + admin grant UI;
  mobile nav/dark theme fixes; admin 404; registration page.
- [x] Product-data compatibility: verified against a `pg_dump` clone of the
  normal product database (46 users, 2 orgs, 44 org admins). Production was
  not modified or redeployed.

## Open items / limits

- Platform session requires a local TOTP code even for OIDC sign-ins (intentional
  for the MVP; OIDC MFA is not treated as local proof).
- Tenant suspension/deletion, quotas, platform settings and module summary
  endpoints are outside this MVP.
- `AUTHZ_MODE` remains `off` by default in Compose dev; production overlay uses
  `audit` and `AUTHZ_MODE_REQUIRED=true` (set `AUTHZ_MODE=enforce` after audit).
- The admin console copy is English-only; the global VI/EN toggle and theme
  switch work in the admin chrome. Full admin-page localization is a follow-up.
- The normal product database is the production database on this host; it was
  not migrated or redeployed in this task. Use the documented backup + deployment
  procedure for production rollout.
- The migration file was generated with Drizzle but manually made idempotent
  because the snapshot includes 0005/0006 tables.

## Verification

- `npm run build --workspace=apps/iam-service --workspace=apps/gateway --workspace=apps/console`
- `npm run test --workspace=apps/iam-service`
- `npm run test --workspace=apps/gateway`
- `npm run test --workspace=apps/console`
