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

## Open items / limits

- Platform session requires a local TOTP code even for OIDC sign-ins (intentional
  for the MVP; OIDC MFA is not treated as local proof).
- Tenant suspension/deletion, quotas, platform settings and module summary
  endpoints are outside this MVP.
- `AUTHZ_MODE` remains `off` by default in Compose dev; production overlay uses
  `audit` and `AUTHZ_MODE_REQUIRED=true` (set `AUTHZ_MODE=enforce` after audit).
- The migration file was generated with Drizzle but manually made idempotent
  because the snapshot includes 0005/0006 tables.

## Verification

- `npm run build --workspace=apps/iam-service --workspace=apps/gateway --workspace=apps/console`
- `npm run test --workspace=apps/iam-service`
- `npm run test --workspace=apps/gateway`
- `npm run test --workspace=apps/console`
