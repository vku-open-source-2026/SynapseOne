# Production checklist (Tier-1 PaaS)

Use when taking SynapseOne off your laptop. Every item already has a mechanism — just switch it on.

## 1. Secrets & auth

- [ ] Replace **every** `*_change_me_*` in `.env` (`IAM_JWT_SECRET` ≥ 32 random chars,
      identical on gateway + IAM; production boot fails on defaults).
- [ ] Same `SYNAPSEONE_INTERNAL_SECRET` on gateway + iam + workflow, then remove the
      `ports:` of IAM/workflow from host/internet (gateway only is public).
- [ ] Workflow execution is queue-backed: keep `QUEUE_SERVICE_URL` reachable,
      `WORKFLOW_EXECUTION_MODE=queue` (or `auto`) and at least one worker
      (`WORKFLOW_WORKER_ENABLED=true` or a self-hosted runner). See
      [workflow-runners.md](workflow-runners.md). A queue-down deployment fails
      closed instead of silently running inline.
- [ ] `IAM_ALLOW_DEV_LOGIN=false` (password login, SSO and API keys only — passwordless dev login is off).
- [ ] `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` (the demo callback accepts any caller-supplied email).
- [ ] Random `IAM_API_KEY_PEPPER` (HMAC for at-rest key hashes).
- [ ] `GATEWAY_VERIFY_APIKEY=true` when clients use API keys (centralized verification, fail-closed).
- [ ] Set `AUTHZ_MODE=audit` first, inspect `GET /v1/audit?allowed=false`, then
      `AUTHZ_MODE=enforce`; keep `AUTHZ_MODE_REQUIRED=true` so a missing config
      cannot boot with policy enforcement disabled.
- [ ] Set `IAM_SENSITIVE_MUTATION_MODE=enforce` (after an `audit` observation
      window) so privileged IAM mutations require an organization administrator.
- [ ] Set `IAM_ALLOW_DIRECT_ORG_CREATE=false`; create tenants through the
      Platform Super Admin API or self-service registration.
- [ ] Provision `PLATFORM_BOOTSTRAP_SECRET` (32+ random chars), run the one-time
      bootstrap from `docs/platform-superadmin.md`, then remove/rotate the secret.
      Keep `PLATFORM_RECOVERY_SECRET` in a break-glass store.
- [ ] Authentik/Keycloak behind **public TLS**: `OIDC_ISSUER` must be a public
      HTTPS URL a browser can reach (e.g. `https://auth.example.com/application/o/synapseone/`).
      The old internal `http://authentik-server:9000` value is rejected at boot in
      production, and discovery endpoints must be HTTPS on the issuer origin.
- [ ] `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` set to the real IdP client
      credentials (empty/`change_me` values abort boot).
- [ ] If you prefer OIDC-only, disable `IAM_REGISTRATION_ENABLED`; otherwise password
      lifecycle endpoints are available (`/v1/auth/register|login|password/*|email/verify`).
- [ ] Point `OIDC_REDIRECT_URI` at the public Console `/oidc/callback` page
      (public HTTPS host, not localhost/internal) so the real Authorization Code
      flow completes in the browser.
- [ ] Optional: pin federation with `OIDC_ALLOWED_ORGS` (comma-separated slugs).
      Without it a new slug is self-service; joining an **existing** org always
      requires a membership (invited via `POST /v1/orgs/:orgId/users`).
- [ ] K8s secrets via SealedSecrets/External Secrets — **never** commit filled-in files
      (see `infra/k8s/base/secrets.example.yaml`).

## 2. Network & TLS

- [ ] Gateway is the single entry point (Ingress + TLS); IAM/workflow/AI/LDS/base/
      faststore/queue/stream/inference/storage/notifications/postgres/valkey are not
      internet-exposed (ClusterIP / internal compose network).
- [ ] Lock down the gateway CORS to the real frontend origins (MVP default is wide open).
- [ ] Rate limiting at the outer layer (Ingress NGINX `limit_req`, Cloudflare/AWS WAF):
      the gateway's built-in limiter was removed — outer rate limiting is mandatory, especially
      `/v1/auth/*` (brute-force login/refresh). Never expose IAM/workflow directly.
- [ ] `PROXY_TIMEOUT_MS` per upstream SLA (default 30s).
- [ ] `TRUST_PROXY=1` (one nginx/Ingress hop) or a CIDR list, so per-client
      rate limits use `X-Forwarded-For` rather than the edge container IP.
      `TRUST_PROXY=true` is rejected (spoofable). The edge must strip inbound XFF.
- [ ] `INFERENCE_RATE_LIMIT_PER_MIN` sets the per-tenant AI quota (default 60,
      returns `429` + `Retry-After`).
- [ ] `HSTS_ENABLED=true` once TLS exists; `CORS_ORIGIN` set to the real frontend origins.

## 3. Data

- [ ] Backups run from `docker-compose.yml`, so every deploy path starts them:
      `pg-backup` (pg_dump custom format of `synapseone` and `authentik`, daily, each
      dump with a `.sha256`, volume `pgbackups`) and `s3-backup` (incremental object
      snapshots, volume `s3backups`, `docs/object-storage.md`). Both keep
      `BACKUP_RETENTION_DAYS`=7. Run them now with
      `docker compose -f docker-compose.yml run --rm --no-deps pg-backup --once` and
      `... run --rm --no-deps s3-backup once`, and rehearse `tools/backup/pg-restore.sh <file.dump>`
      and `s3-backup restore latest --dry-run` (`pg-restore.sh` asks you to type the database
      name, verifies the `.sha256` and restores in one transaction; stop the services
      using that database first). Both volumes live on the same host:
      copying them elsewhere is the operator's choice.
- [ ] Object storage: set `STORAGE_BACKEND=s3` plus `STORAGE_S3_*` credentials (they are
      also the SeaweedFS identity, `docs/object-storage.md`). Set
- [ ] IAM: set `IAM_MFA_ENCRYPTION_KEY` (`openssl rand -hex 32`) before users enrol MFA;
      keep `IAM_LOGIN_MAX_FAILURES`/`IAM_LOGIN_LOCKOUT_SECONDS` at their defaults or stricter.
- [ ] Notifications: set `DATABASE_URL`, `NOTIFICATIONS_QUEUE_URL`,
      `NOTIFICATIONS_EMAIL_RELAY_URL`/`_SMS_`/`_PUSH_` as needed; the service
      refuses to boot without the DB, internal secret and CORS origin
      (`docs/notifications.md`).
- [ ] Valkey AOF already on in compose; on K8s use a Valkey/Redis-protocol chart with persistence (Valkey loads Redis RDB/AOF in place).
- [ ] **Upgrading a running Redis deployment to Valkey** (in place, no data loss):
      the compose service is now `valkey` (`valkey/valkey:8-alpine`) but it keeps
      the `redisdata` volume and the `redis://` URL scheme, so Valkey loads the
      existing AOF on boot. Sequence: `docker compose stop valkey` (or `redis` on
      the old file) → `docker compose up -d valkey` → verify
      `docker compose exec valkey valkey-cli dbsize` and
      `GET /health` on queue/faststore/stream (`backend` stays `"redis"` because
      that names the wire protocol). Keep `REDIS_URL`/`*_REDIS_URL` in `.env`
      during a rolling deploy: images built before this release only read the
      legacy names, and both point at the same instance.
- [ ] Database schema is managed by Drizzle migrations in `apps/*/drizzle/`.
      Services apply their own migrations at startup under a per-service
      advisory lock and migration journal (`drizzle.__drizzle_migrations_*`).
      `infra/postgres/init.sql` is bootstrap-only (extensions + the migration
      journal schema); table/index DDL and the demo seed live in migrations.
      Back up the database before the
      first deploy of a schema-changing release, and review generated SQL.
- [ ] Migration journals are service-specific because all services share one
      database. Do not point multiple services at the same journal, and do not
      edit migrations that have already been applied.
- [ ] The service DB role can create/alter tables, indexes and the `drizzle`
      schema (startup migrations need DDL rights), or migrations are pre-applied
      once with a privileged role before the service rollout.

## 4. Operations

- [ ] Stream/inference/storage/notifications are included in
      `docker-compose.prod.yml` and `infra/k8s/base/all.yaml`, and `/ready` probes
      them when their URLs are configured.
- [ ] `restart: unless-stopped` is already set for every long-lived compose service;
      K8s has liveness/readiness (see `infra/k8s/base/all.yaml`). Alert when `/ready` → 503.
- [ ] Pin image digests for releases (`synapseone/*:0.1.0` → digest), never `latest` for external engines.
- [ ] Centralized logs (default json-file driver; move to Loki/ELK when needed) + keep `x-request-id`.
- [ ] `audit_log` Postgres retention under heavy authorize traffic: set
      `AUDIT_RETENTION_DAYS` (e.g. `180`) — the IAM service purges hourly by
      itself (see `docs/configuration.md`). External cron `DELETE` only needed
      for custom windows.
- [ ] Monitoring: confirm Prometheus scrapes gateway/PG/Valkey (`/targets` all up)
      and the `GatewayDown`/`PostgresDown`/`ValkeyDown` alerts are visible
      (see `docs/monitoring.md`). The Prometheus port stays internal in prod
      (port-forward only).
- [ ] Periodic `npm audit`; track advisories recorded in `SECURITY.md`.

## 5. Upgrades

- [ ] Read `CHANGELOG.md` + `ROADMAP.md` before moving to a new tag; run
      `tests/e2e/api-check.sh` after every upgrade.
