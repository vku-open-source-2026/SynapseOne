# Self-hosted workflow runners

SynapseFlow executes DAGs on **workers that consume a SynapseQueue queue**.
You can use SynapseOne's built-in worker, deploy your own runner from the
published image, or run both against the same queue (hybrid).

```text
trigger (manual/webhook/cron/human task)
        │  create queued execution (Postgres)
        ▼
SynapseQueue  ──►  platform worker (workflow-service)
        │      └─►  self-hosted runner (your infra)
        ▼
claim → execute DAG → complete → ack
```

The queue message contains only the execution id. Workflow input and the DAG
definition stay in Postgres and are returned by the authenticated claim.
Delivery is at-least-once; `claim` is the exactly-one-runner guard, so a
duplicate delivery is acknowledged without running twice.

A runner registration is like a Cloudflare tunnel: you create it once, copy an
install command containing its scoped API key, and every running replica
registers as a **connector instance** with its own id, hostname, version,
concurrency and heartbeat. The Console lists connectors and their live status;
a registration with no live connector shows `waiting`/`offline`.

## Choose a mode

Set it per workflow with `settings.execution.mode` (Console: workflow detail →
**Execution runner**):

| Mode | Queue | Workers |
| --- | --- | --- |
| `platform` (default) | `synapseone-wf-platform` | SynapseOne's built-in worker |
| `custom` | `synapseone-wf-custom` | Your runner only |
| `hybrid` | `synapseone-wf-shared` | Built-in worker **and** your runner |
| `inline` | — | Runs inside the API request (dev/test, nested calls) |

A dedicated queue is also supported:
`settings.execution.queue: "acme-edge"` plus a runner created with the same
`queue`. This is useful when you want a specific machine to own a workflow.

## 1. Create a runner and API key

Console: **Workflow Runners → New runner**. Pick `custom` or `hybrid`, choose
the key scopes (default `workflow:*,queue:*,*:read,base:query,base:vector-search,inference:*`),
and create it. The dialog shows a `docker run` command that **already contains
the API key** — copy it then; the key is not stored by workflow-service.

API equivalent (two steps, so the plaintext key is only returned once by IAM):

```bash
# 1) Mint a scoped key for the runner (returns apiKey once)
curl -sX POST "$SYNAPSEONE_URL/v1/accounts/$ACCOUNT_ID/keys" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"workflow-runner-edge","scopes":["workflow:*","queue:*","*:read"]}'

# 2) Register the runner and render the command with that key
curl -sX POST "$SYNAPSEONE_URL/v1/workflow-runners" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"edge-runner","mode":"custom","apiKeyId":"<key id>","keyPrefix":"<prefix>","apiKey":"<apiKey>"}'
```

The response includes `runner` and a `command` like:

```bash
docker run -d --name synapseone-runner-1a2b3c4d --restart unless-stopped \
  -e SYNAPSEONE_URL=https://api.synapseone.space \
  -e SYNAPSEONE_API_KEY=sk-... \
  -e WORKFLOW_RUNNER_ID=1a2b3c4d-... \
  -e WORKFLOW_RUNNER_QUEUE=synapseone-wf-custom \
  -e WORKFLOW_RUNNER_MODE=custom \
  -e WORKFLOW_RUNNER_CONCURRENCY=1 \
  -e WORKFLOW_RUNNER_HEARTBEAT_SECONDS=15 \
  ghcr.io/vku-open-source-2026/synapseone-workflow-runner:latest
```

## 2. Run it

The image makes **outbound HTTPS only**; it needs no database, no internal
secret and no service-network access. It uses the API key against the public
gateway.

| Env | Required | Default | Meaning |
| --- | --- | --- | --- |
| `SYNAPSEONE_URL` | yes | — | Public gateway base URL |
| `SYNAPSEONE_API_KEY` | yes | — | Scoped runner key |
| `WORKFLOW_RUNNER_ID` | yes | — | Runner id from registration |
| `WORKFLOW_RUNNER_QUEUE` | no | server config | Informational; server queue wins |
| `WORKFLOW_RUNNER_MODE` | no | server config | `custom` or `hybrid` |
| `WORKFLOW_RUNNER_CONCURRENCY` | no | `1` | Parallel jobs (1..32) |
| `WORKFLOW_RUNNER_POLL_MS` | no | `1000` | Queue poll interval |
| `WORKFLOW_RUNNER_LEASE_SECONDS` | no | `300` | Claim/visibility lease |
| `WORKFLOW_RUNNER_HEARTBEAT_SECONDS` | no | `15` | Connector heartbeat + lease refresh |
| `WORKFLOW_RUNNER_INSTANCE_ID` | no | host-pid-random | Stable connector id for this process |
| `WORKFLOW_RUNNER_ONCE` | no | — | Drain one poll then exit (smoke test) |

Run with Docker, Compose, Kubernetes or a systemd unit. The runner sends a
heartbeat immediately on boot, so **Workflow Runners** switches to
`connected` within ~2.5s. `GET /v1/workflow-runners/:id/connection` is the
programmatic check.

### Connection states and connectors

The Console auto-refreshes the runner list every 5s and the selected runner
every 4s:

| Status | Meaning |
| --- | --- |
| `waiting` | Registration exists, no connector has ever heartbeated |
| `connected` | At least one connector is fresh; all connectors fresh |
| `degraded` | Some connectors fresh, some offline |
| `offline` | Connectors exist but none has heartbeated within `WORKFLOW_RUNNER_STALE_SECONDS` (default 60) |

Each connector shows `id`, `hostname`, `version`, `concurrency`, `lastSeenAt`
and `status`; stale connector rows can be removed from the Console or with
`DELETE /v1/workflow-runners/:id/instances/:instanceId`. A graceful
`SIGTERM` sends an `offline` heartbeat immediately instead of waiting for the
stale timeout. The API surface is:

- `GET /v1/workflow-runners/options` — public URL, image, queues, heartbeat/stale
  windows, max concurrency and built-in platform-worker config.
- `GET /v1/workflow-runners` — registrations with `instances`, `connected`,
  `connectedInstances`, `instanceCount` and aggregate `status`.
- `GET /v1/workflow-runners/:id` / `:id/connection` — registration + live
  connector details (`checkedAt`, `staleAfterSeconds`, …).
- `PATCH /v1/workflow-runners/:id` — rename/retarget; queue/mode changes are
  refused with `409 runner_connected` while a connector is online.
- `DELETE /v1/workflow-runners/:id/instances/:instanceId` — remove a stale
  connector row.

## 3. Execute

- Manual: `POST /v1/workflows/:id/execute` → `202 {queued:true, executionId}`.
  Add `?wait=1&timeoutMs=60000` for the old blocking response.
- Webhook: returns `202` immediately; use `?wait=1` for synchronous tests.
- Cron: the scheduler enqueues each due run.
- Human task approval: the paused execution is re-queued with a resume
  checkpoint and runs on the same queue.

If a worker dies mid-run, the queue redelivers after the visibility timeout and
the execution lease expires; the next worker can claim it (`attempt`
increments). A run that fails inside the engine is completed as `error` and
acked (workflows are not automatically retried to avoid duplicate side
effects). Unexpected transport/DB errors release the execution and nack with a
10s delay.

## Security model

- The runner key is scoped. Default scopes cover workflow + queue plus
  read-only access to other services. Add write scopes only if DAGs need them.
- `POST /v1/runner/jobs/:id/credentials` returns a credential only for an
  execution claimed by that runner id in the same tenant; secrets are never in
  the queue message or the job snapshot.
- Workflow-service never stores the plaintext API key. IAM stores only its
  hash; revoke the key in **API Keys** when decommissioning a runner.
- Deleting a runner registration does **not** revoke its API key
  automatically (the Console warns); revoke it separately.
- The runner executes untrusted workflow code in the same sandbox as the
  platform (`vm` + Node permission model + child process isolation).

## Operations

- Health: `GET /health` reports `transport: queue|inline` and `worker:
  platform|off`; `GET /metrics` counts runs by trigger/status.
- Queue stats: `GET /v1/queue/queues/synapseone-wf-platform/stats` (and
  `-custom`, `-shared`).
- Dead letters: `GET /v1/queue/queues/<queue>/dead`, replay with
  `POST .../dead/:id/replay`.
- Scaling: the built-in worker runs with `WORKFLOW_WORKER_CONCURRENCY` (default
  4). Multiple workflow-service replicas are safe for job execution because
  `claim` is atomic, but the in-process cron scheduler has no distributed lock —
  run one cron owner (or set `WORKFLOW_WORKER_ENABLED=false` on extra replicas
  and give them a separate scheduler).
- Turning queue mode off: `WORKFLOW_EXECUTION_MODE=inline` (dev/tests only).
  Production compose sets `queue` by default.

## Verification

`tests/e2e/workflow-runner-e2e.mjs` runs against a real gateway + IAM +
workflow-service + SynapseQueue stack and **fails if the platform falls back to
inline execution**. It asserts `transport=queue`, `worker=platform`, creates a
custom runner key/registration, starts the runner process, waits for a
connected connector instance, runs a custom-mode workflow on that runner, runs
a platform-mode workflow on the built-in worker, and verifies a graceful
`offline` heartbeat.

```bash
SYNAPSEONE_BASE_URL=http://localhost:8080 \
WORKFLOW_HEALTH_URL=http://localhost:4002/health \
node tests/e2e/workflow-runner-e2e.mjs
```

## Building/releasing the image

```bash
# from the repository root
docker build -f apps/workflow-runner/Dockerfile -t synapseone-workflow-runner .
```

`.github/workflows/release.yml` publishes and signs
`ghcr.io/<owner>/synapseone-workflow-runner:<tag>` (also `latest`, `sha-*`);
`cd.yml` publishes `:main` and `:main-<sha>` from the main branch.
`publish-runner.yml` is the standalone runner channel: run it manually or push
a `runner-v*` tag (for example `git tag runner-v0.9.1 && git push origin
runner-v0.9.1`) to refresh `:latest` without a full platform release.

GHCR packages start **private**, and GitHub does not expose a REST/GraphQL API
to change package visibility. An organization owner must make the package
public once: **Organization → Packages → synapseone-workflow-runner → Package
settings → Danger Zone → Change visibility → Public**. The
`packages-visibility` workflow only audits current visibility. Once the
package is public, every tag (including `:main`) is public; future releases do
not need another click.
