# Business flows — SynapseOne 0.9.0

This is the canonical business specification for the supported product scope.
It is intentionally compact: API details live in [`api.md`](api.md), runtime
ownership in [`architecture.md`](architecture.md), and operational steps in
[`production.md`](production.md).

## 1. Actors

| Actor | Authority |
|---|---|
| Platform owner | Platform organization, platform admins, tenant creation, owner-only mutations |
| Platform operator | Tenant/org administration, user/security actions; no platform-admin grant |
| Platform auditor | Read-only platform overview, organizations, usage, audit |
| Organization administrator | Accounts, members, roles/policies, credentials, org audit |
| Account administrator | Account-scoped resources where an account role is assigned |
| Tenant member | Resources granted by role/policy; no implicit account-admin rights |
| Developer / data engineer | Persona using scoped keys, SDK/CLI, Workflow and ETL; not a separate IAM role |
| Service account | Account-bound machine identity with explicit scopes/roles |
| Runner | Account- or platform-scoped execution worker |
| External API consumer | Bearer JWT, API key, signed URL, or public LDS/webhook surface |

A user may be both a tenant administrator and a platform administrator
(dual-role). Platform privileges bind to the platform-organization user row;
tenant contexts never upgrade into platform authority.

## 2. Master lifecycle

```
Bootstrap platform
  -> onboard organization + first admin
  -> create accounts and members
  -> grant roles/policies and credentials
  -> provision data/application resources
  -> run workflows and ETL
  -> observe usage, quotas and audit
  -> suspend/reactivate or offboard
  -> back up and restore
```

Organization is the primary tenant boundary; account is a subordinate scope.
Background work is tenant-scoped by the same org/account identity as the
request that created it.

## 3. Flow catalog

### BF-01 — Platform bootstrap and initial administration

- **Actor:** operator with `PLATFORM_BOOTSTRAP_SECRET`.
- **Trigger:** one-time `POST /internal/platform/bootstrap` on the internal IAM network.
- **Preconditions:** empty platform organization; secret configured; database available.
- **Success:** platform org + first active owner + audited bootstrap; owner signs in and exchanges a platform session.
- **Exceptions:** disabled (`503`), wrong secret (`401`), already bootstrapped (`409`).
- **Rules:** endpoint has no gateway route; platform org cannot be suspended; at least one active owner must remain.
- **Audit:** `platform:bootstrap`.
- **Acceptance:** bootstrap only once; owner can open Super Admin; non-owner cannot grant owners.

### BF-02 — Organization onboarding

- **Actor:** self-service registrant (new org) or platform owner (tenant org).
- **Trigger:** `POST /v1/auth/register` or `POST /v1/platform/orgs`.
- **Preconditions:** registration policy allows new orgs, or platform owner + step-up.
- **Success:** org created, first user is org admin, one-time activation code issued.
- **Exceptions:** duplicate slug `409`; reserved platform slug `403`; direct create disabled `403 platform_org_create_required`.
- **Idempotency:** unique slug; repeat create conflicts rather than duplicating.
- **Audit:** organization + admin creation.
- **Acceptance:** invited admin can set a password with `POST /v1/auth/invite/accept`; production responses carry the activation code only to the authorized tenant org admin or platform owner (an operator must ask an owner; no mailer is assumed).

### BF-03 — Account creation and lifecycle

- **Actor:** organization administrator.
- **Trigger:** `POST /v1/orgs/:orgId/accounts`, `POST /v1/accounts/:id/retire`,
  `POST /v1/accounts/:id/reactivate`.
- **Preconditions:** caller is an org admin of the owning organization.
- **Success:** account exists under the org; roles/policies can be assigned.
- **Retirement:** `retire` requires a reason, sets `status=retired`, revokes all
  account API keys and service accounts, removes the account from context/scope
  selection, blocks account-bound credential verification, preserves data, and
  writes an audit row. Other accounts in the org remain active.
- **Reactivation:** sets `status=active`; previously revoked keys/service
  accounts are **not** restored and must be reissued.
- **Rules:** account is a subordinate scope, not a second tenant. Organization
  membership grants tenant access; sensitive IAM mutations (keys, roles,
  policies, service accounts) require an org admin in enforce mode.
- **Exceptions:** cross-org request `403`; duplicate slug `409`; non-admin
  retirement `403 org_admin_required`; missing reason `400`.
- **Limitation:** hard account deletion is intentionally unsupported.

### BF-04 — User onboarding, membership and offboarding

- **Actor:** org admin (tenant), platform operator (platform users).
- **Trigger:** create user/invite, role assignment, disable/enable, lock/unlock, MFA reset, session revoke.
- **Success:** invited user accepts the one-time code; roles determine access; disabling bumps `auth_version` and revokes refresh/API keys.
- **Exceptions:** existing email `409`; weak password `400`; last org admin protection.
- **Audit:** user create/role/security mutations.
- **Limitation:** membership removal is role removal plus disable, not hard deletion; owned resources are retained.

### BF-05 — Authentication, MFA and session lifecycle

- **Actors:** user, service account, API-key client.
- **Triggers:** password/OIDC login, refresh, logout, MFA setup/verify, context switch.
- **Success:** short access JWT + rotating refresh token; MFA challenge completed before session; gateway revalidates the session against IAM within the cache TTL.
- **Exceptions:** invalid credentials `401`; inactive `403`; suspended org `403 org_suspended`; lockout `429`; refresh reuse revokes the family.
- **Idempotency:** consumed refresh tokens cannot be replayed; explicit logout does not revoke sibling sessions.
- **Acceptance:** suspension/deactivation/revocation takes effect for new requests; a wrong password does not reveal suspension.

### BF-06 — Role, policy and permission lifecycle

- **Actor:** org admin; platform owner for platform roles.
- **Triggers:** role create/assign/remove, policy create/attach/detach/delete, managed-policy selection.
- **Rules:** explicit `Deny` wins; default deny; malformed conditions fail closed; platform actions are never grantable by tenant policy; credential scopes cap identity permissions.
- **Success:** gateway and IAM agree on the effective action; removal takes effect on the next authorization decision.
- **Exceptions:** unknown role/policy `404`; last org/platform owner protection `409`.
- **Acceptance:** member cannot self-escalate in production; account API keys cannot exceed caller scopes.

### BF-07 — API key and service account lifecycle

- **Actor:** org/account administrator or service owner.
- **Triggers:** create/rotate/revoke key; create service account, assign roles, mint token, revoke.
- **Success:** secret shown once; stored hash only; scope ceiling enforced; owner/user disable and org suspension invalidate use.
- **Rules:** API keys are account-bound; user-bound keys act for their owner but keep machine `kind`; no wildcard service-account scope outside explicit grants.
- **Acceptance:** read-only key can read but not write representative services; cross-tenant use returns `404`/`403`.

### BF-08 — Resource provisioning and deletion

- **Owners:** IAM (identity), Base/Faststore/Queue/Stream/OCS/LDS/Notifications (operational), Warehouse/Lakehouse (analytical).
- **Rules:** tenant-scoped names; cross-tenant existence hidden; quotas enforced at the owning service; deletion is service-specific.
- **Dependencies:** deleting a Base collection emits document tombstones; deleting a workflow with queued/running/paused executions is rejected; Lakehouse drops retain data files; OCS rejects unsafe bucket deletion.
- **Limitation:** no cross-service cascading delete; operators must stop dependent ETL jobs before deleting sources/destinations.

### BF-09 — Transactional application data lifecycle

- **Actor:** tenant member/developer with Base scope.
- **Triggers:** collection/document CRUD, batch write, increment, query, change feed.
- **Transaction:** document mutation + outbox row commit atomically; optimistic concurrency via `If-Match`/version.
- **Success:** reads see committed state; change feed/outbox receives create/update/delete with stable event identity.
- **Exceptions:** version conflict `409`; invalid mapping `400`; cross-tenant `404`.
- **Deletion:** collection delete emits a delete tombstone per document before removing data and search entries.

### BF-10 — Messaging, queues and event processing

- **Actors:** producers, consumers, operators.
- **Queue:** publish/dedupe/delay, lease, heartbeat, ack/nack, retry, dead-letter, replay.
- **Stream:** topic/group lifecycle, read, ack, range replay, retention.
- **Rules:** delivery is at-least-once; consumers must be idempotent; unacked stream entries are reclaimed after `claimIdleMs` (default 30s); dedupe is bounded by message retention.
- **Acceptance:** a crashed consumer re-receives its batch; ack after destination commit prevents loss.

### BF-11 — Workflow definition and execution lifecycle

- **States:** `queued | running | paused | success | error | cancelled`; terminal states never return to active.
- **Trigger:** manual, webhook, cron, template, API.
- **Rules:** executable graph revision is recorded on the execution; queue/runner/inline resume reject a changed revision; a paused run has one engine-created human checkpoint; cancel closes pending tasks; workflow delete is rejected while active executions exist. A decision reserved as `resuming` whose dispatcher dies is reconciled by the reclaimer: a still-paused execution returns the task to pending/claimed, while an accepted or terminal execution completes the task.
- **Audit:** execution actor, trigger, status, node runs.
- **Acceptance:** human approval resumes once; late/expired approval terminates the run; double approval `409`.

### BF-12 — Runner registration, execution and recovery

- **Actor:** org/account admin or platform owner.
- **Triggers:** register runner, rotate key, heartbeat, claim, complete, disable/delete.
- **Rules:** account runner sees account work; org runner requires admin; platform runner sees only system queues and gets a per-execution delegated grant. Lease fencing prevents stale completion; revocation takes effect on the next call.
- **Recovery:** expired leases are reclaimable; already-acknowledged work is not re-run by the same lease.
- **Limitations:** node-level side-effect replay is not exactly-once, so workflows
  should use idempotent external operations. Drain a custom runner's queue before
  deleting it; a runner deleted with queued work can strand those executions
  until an operator requeues or cancels them.

### BF-13 — Batch and streaming ETL

- **Path A:** Base snapshot → Warehouse current-state dataset; Base outbox → Stream → Warehouse upsert/delete.
- **Path B:** Base snapshot + outbox → Stream → Lakehouse append-only change log.
- **Path C:** Lakehouse authorized snapshot/table → Warehouse materialization.
- **OCS file source:** authorized CSV/JSONL/Parquet object → trusted Warehouse
  parser → dataset; preview is bounded and replace/append is transactional or
  explicitly at-least-once.
- **Rules:** snapshot backfill pages through every cursor; destination identity uses collection/document incarnation/version; older events cannot overwrite newer current state or resurrect a delete; ACK follows durable destination write; replay is idempotent.
- **Job states:** `running | paused | error` as exposed; pause stops reading but retains the consumer group; resume only for stream jobs.
- **Limitations:** no separate ETL scheduler; Path B commits each change
  separately, so very large initial backfills are commit-bound and should be
  sized accordingly. OCS ingestion supports CSV/JSONL/Parquet only, not
  arbitrary connector formats.

### BF-14 — Lakehouse and analytical processing

- **Actor:** data engineer with Lakehouse scope.
- **Triggers:** namespace/table create, append, query, snapshot, schema evolution, drop, maintenance report.
- **Rules:** Iceberg v2, Parquet on S3-compatible storage, PostgreSQL SQL catalog; tenant namespace isolation; max append/query 5000 rows; byte quota from current snapshot + incoming estimate; one active writer via advisory lock; physical cleanup disabled.
- **Failure:** commit conflict `409`; quota `409`; lock loss fails writes/readiness closed; catalog drop retains files.
- **Acceptance:** historical snapshot read; duplicate append suppressed by idempotency key; maintenance report is non-destructive.

### BF-15 — Search indexing and retrieval

- **Actor:** tenant member.
- **Triggers:** document writes, search query, reindex, status.
- **Rules:** Base owns the index; tenant/org/account ACL filtering occurs before content return; 50k-row scan bound; deleted documents excluded; index eventually consistent with Base.
- **Acceptance:** cross-tenant search returns no document metadata or content.

### BF-16 — AI and inference consumption

- **Actor:** tenant member/service.
- **Triggers:** AI guidance, inference chat/embedding/decision, queued inference job.
- **Rules:** gateway scope + per-tenant rate limit; provider credentials stay server-side; inference is not an authorization authority; no real provider is configured in QA.
- **Limitation:** provider uptime/cost is an operator responsibility.

### BF-17 — Usage, quotas and resource governance

- **Rules:** gateway emits request/feature telemetry to IAM; IAM aggregates tenant usage; service quotas are hard where implemented (Lakehouse namespaces/tables/rows/bytes, OCS bytes, Base/Queue limits). Usage is not billing.
- **Acceptance:** tenant cannot read another tenant's usage; quota rejection is `409`/`429` with an actionable error.
- **Limitation:** some limits are per-process or per-request estimates; deployment sizing remains an operator decision.

### BF-18 — Organization suspension and reactivation

- **Suspend actor:** platform operator/owner with step-up.
- **Effects:** login `403`; refresh/API keys revoked; `auth_version` bumped; existing JWTs fail session validation; service-account and execution-grant checks reject suspended orgs; platform org protected; data retained.
- **In-flight policy:** finite already-authorized work may finish; new
  authenticated requests and new execution delegations are rejected. Continuous
  Warehouse stream/ETL workers check tenant status at each batch boundary and
  pause themselves for operator resume after reactivation. Base outbox data is
  retained; Lakehouse historical data is retained.
- **Reactivation:** access restored for still-valid credentials/login; previously revoked keys/tokens are **not** silently restored.
- **Audit:** suspend/reactivate with reason and actor.

### BF-19 — Incident management and administrative recovery

- **Triggers:** queue dead letter, outbox quarantine, failed ETL job, runner offline, service readiness failure.
- **Actions:** inspect dead letters/outbox, replay after fix, pause/resume job, rotate runner key, restart service, restore backup.
- **Rules:** replay preserves event identity; no destructive global cleanup; operator actions audited.
- **Acceptance:** failed event does not block unrelated events; replay does not duplicate already-applied state.

### BF-20 — Backup, restore and disaster recovery

- **Durable state inventory:** Postgres (IAM/Workflow/Base/LDS/Notifications and
  Iceberg catalog), S3-compatible objects (OCS and Iceberg Parquet/metadata),
  Warehouse DuckDB volumes (datasets + ETL job/checkpoint metadata), Valkey AOF
  (Queue/Stream topics, groups, pending entries, leases and dedupe state), and
  configuration/encryption keys.
- **Authoritative vs derived:** Postgres and object storage are authoritative;
  Warehouse datasets are authoritative for tenant query state and rebuildable
  from Base/Lakehouse/OCS; Valkey contains durable operational state and must
  be captured when queued/stream work matters. Cache-only Faststore keys may be
  treated as ephemeral by operator policy.
- **Backup:** `pg-backup --once` writes a dump + SHA256 + status; `s3-backup
  once` writes an object manifest/snapshot. The Valkey volume uses AOF
  persistence (`--appendonly yes`); an operator snapshot must copy the AOF/RDB
  after `BGREWRITEAOF`/`SAVE` or use `valkey-cli --rdb`. Warehouse DuckDB uses
  a single-writer file; stop or quiesce the service, run a supported DuckDB
  checkpoint/export or copy the closed file, and preserve `_jobs` state.
- **Consistency:** capture Postgres, object storage, Warehouse and Valkey in a
  coordinated maintenance/quiesce window. They are not atomically transactional
  across systems; record the recovery point for each family.
- **Restore drill:** restore Postgres into a separate database, S3/catalog
  together, and verify current/historical Iceberg snapshots, Base documents,
  Warehouse datasets/ETL jobs, and stream/queue replay. Do not claim atomic
  cross-system restore.
- **Acceptance:** identity/permissions, Base documents, workflow state,
  Warehouse datasets, ETL checkpoints, current and historical Iceberg snapshots,
  referenced objects, and post-restore replay are readable.
- **Limitation:** on-host backup is not disaster recovery; off-host copy,
  Valkey/Warehouse backup automation, and a production drill remain operator
  actions. RPO/RTO must be set by the operator from the measured backup window.

### BF-21 — Audit and compliance

- **Rules:** privileged mutations write actor, org/account, action, resource, decision, timestamp; secrets/tokens are never logged; tenant audit reads require org admin; platform audit requires platform role.
- **Acceptance:** suspend/reactivate, key revocation, role changes, workflow decisions and platform grants are visible; audit retention is explicit and bounded.

### BF-22 — Organization offboarding and data retention

- **Supported:** suspend access, revoke credentials, export/back up data, retain resources, reactivate.
- **Unsupported:** hard organization deletion and automatic cascading data destruction. This is intentional: tenant data removal requires an operator-reviewed retention procedure.
- **Rules:** never reuse a suspended organization's identity; never silently restore revoked credentials.

## 4. Traceability matrix

| Flow | Owner | Primary API | Enforcement | State/data | UI / SDK | Status |
|---|---|---|---|---|---|---|
| BF-01 | IAM | `POST /internal/platform/bootstrap` | bootstrap secret | `organizations`, `platform_admins` | Super Admin login | IMPLEMENTED AND VERIFIED |
| BF-02 | IAM | `/v1/auth/register`, `/v1/platform/orgs` | registration policy / platform owner + step-up | org + first admin + invite | Register / Admin → Organizations | IMPLEMENTED AND VERIFIED |
| BF-03 | IAM | `/v1/orgs/:id/accounts`, `/v1/accounts/:id/retire` / `reactivate` | org admin | accounts (`active` or `retired`) | Console Accounts | IMPLEMENTED AND VERIFIED |
| BF-04 | IAM | `/v1/orgs/:id/users`, invite/disable/unlock | org admin | users, roles, invites | Console Users | IMPLEMENTED; hard removal unsupported |
| BF-05 | IAM + Gateway | `/v1/auth/*` | JWT/refresh/MFA + IAM session check | sessions, MFA, `auth_version` | Login / contexts | IMPLEMENTED AND VERIFIED |
| BF-06 | IAM + Gateway | roles/policies/authorize | explicit deny, scope ceiling | roles, policies, assignments | Console Roles/Policies | IMPLEMENTED AND VERIFIED |
| BF-07 | IAM | keys, service accounts | scope subset, owner/org checks | keys, SAs, tokens | Console Keys/Service accounts | IMPLEMENTED AND VERIFIED |
| BF-08 | services | per-service CRUD | tenant headers + internal secret | service-owned resources | per-service pages | IMPLEMENTED AND VERIFIED |
| BF-09 | Base | `/v1/base/*` | tenant + scopes | documents, outbox, search | Console Base | IMPLEMENTED AND VERIFIED |
| BF-10 | Queue/Stream | `/v1/queue/*`, `/v1/stream/*` | tenant + scopes | messages, topics, groups | Console Queue/Stream/CLI | IMPLEMENTED AND VERIFIED |
| BF-11 | Workflow | `/v1/workflows/*`, executions, human tasks | principal/tenant + checkpoint | definitions, executions, tasks | Console Workflows | IMPLEMENTED AND VERIFIED |
| BF-12 | Workflow + IAM | runners/runner protocol | audience + runner key + lease | registrations, instances, leases | Console Runners | IMPLEMENTED; fleet rollout operator |
| BF-13 | Warehouse/Base/Stream/Lakehouse | `/v1/warehouse/etl/*` | tenant + internal trusted calls | jobs, markers, checkpoints | Console Warehouse | IMPLEMENTED AND VERIFIED |
| BF-14 | Lakehouse | `/v1/lakehouse/*` | tenant + single writer + quota | Iceberg catalog/snapshots | Console Lakehouse / SDK | IMPLEMENTED AND VERIFIED |
| BF-15 | Base | `/v1/search` | tenant/RBAC filter | search index | Console Search | IMPLEMENTED AND VERIFIED |
| BF-16 | AI/Inference | `/v1/ai/*`, `/v1/inference/*` | scopes + tenant rate limit | provider calls/jobs | Docs assistant / SDK | IMPLEMENTED; provider operator |
| BF-17 | Gateway/IAM/services | `/v1/usage/*`, quota errors | tenant scope + service limits | telemetry, counters | Super Admin Usage | IMPLEMENTED |
| BF-18 | IAM + Gateway | `/v1/platform/orgs/:id/suspend|reactivate` | owner/operator + step-up | org status, credential epoch | Admin → Organizations | IMPLEMENTED AND VERIFIED |
| BF-19 | all | outbox/dead-letter/replay, job controls | operator/tenant admin | quarantine, jobs, runners | Console Outbox/Queue/Warehouse | IMPLEMENTED AND VERIFIED |
| BF-20 | IAM/DB/S3 tooling | backup scripts, restore runbook | operator filesystem/DB | dumps, S3 manifests | CLI/ops | IMPLEMENTED; off-host operator |
| BF-21 | IAM/services | `/v1/audit`, platform audit | org admin/platform role | audit rows | Console Audit | IMPLEMENTED AND VERIFIED |
| BF-22 | IAM/operator | suspend + backup/export | platform owner/operator | retained tenant data | Admin → Organizations | INTENTIONALLY LIMITED |

## 5. Cross-flow invariants

1. Organization is the tenant boundary; account is subordinate. Missing account
   context never widens access.
2. A suspended org cannot authenticate, mint new delegations, or start new
   authenticated work; data is retained and revoked credentials stay revoked.
3. Gateway strips client `x-synapseone-*` headers and stamps the verified
   principal; services also enforce tenant scope from that principal.
4. Credential scopes cap identity permissions; explicit policy `Deny` wins.
5. Destructive actions require confirmation and correct ownership; cross-tenant
   reads return `404`.
6. Background delivery is at-least-once; destinations are idempotent and ACK
   follows the durable write.
7. Current-state consumers never regress to an older document version and never
   resurrect a deleted incarnation.
8. Physical Lakehouse cleanup and hard organization deletion are intentionally
   disabled until an operator-reviewed policy exists.
