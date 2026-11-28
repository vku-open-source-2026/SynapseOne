# synapseone SDK for Python

Apache-2.0. See root LICENSE. Part of [SynapseOne](../../README.md) Tier-1 PaaS.

Requires Python 3.9+. Single runtime dependency: `requests>=2.28`.

## Install

```bash
pip install synapseone-sdk
```

## Quick start

```python
from synapseone_sdk import SynapseOneClient

# Defaults to https://api.synapseone.space (or $SYNAPSEONE_BASE_URL).
c = SynapseOneClient()
login = c.iam.login("demo@acme.local")
c.set_token(login["accessToken"])

c.iam.create_org("acme-2", "ACME 2")
c.iam.authorize(login["user"]["id"], "workflow:Execute", "*")
c.workflow.create_workflow_from_template("webhook-to-log", "demo")
```

## Services

The SDK is split per service. Use the namespace that matches the service:

| Namespace | Service | Highlights |
| --- | --- | --- |
| `c.iam` | Synapse IAM | auth/OIDC, orgs, accounts, users, roles, policies, API keys, credentials, service accounts |
| `c.workflow` | Workflow | templates, workflow CRUD + activate/deactivate, executions, credentials, `test_run`, `trigger_webhook` |
| `c.ai` | AI Assistant | API documentation assistant (natural language -> endpoint guidance) |
| `c.lds` | LDS | datasources, attributes, records ingestion, NGSI-LD entities, licenses |
| `c.base` | SynapseBase | collections, documents, queries, batch, increment, change feed, typed object<->data mapping |
| `c.faststore` | Synapse Faststore | KV with TTL/NX/XX, incr, hashes, lists, sets, sorted sets, scans, batches, distributed locks |
| `c.queue` | SynapseQueue | queues, publish (delay/dedupe), consume leases, ack/nack/heartbeat, dead letters, replay |
| `c.stream` | SynapseStream | topics, publish/read, consumer groups, acknowledgements, retention |
| `c.storage` / `c.ocs` | SynapseOCS | buckets, binary objects, presign, multipart, quotas |
| `c.notifications` | SynapseNotifications | outbox, templates, preferences, unsubscribe, delivery |
| `c.warehouse` | Synapse Warehouse | datasets, read-only SQL, batch/stream ETL, jobs |
| `c.lakehouse` | Synapse Lakehouse | Iceberg namespaces/tables, snapshots, schema evolution |
| `c.health` | Gateway health | health, readiness and projected status |
| `c.inference` | Inference Engine | LLM proxy, local embeddings, Decision-2.0-Eos-0.8B structured decision & routing |

### SynapseBase with typed objects

```python
from dataclasses import dataclass


@dataclass
class Park:
    name: str
    capacity: int


parks = c.base.collection(
    "parks",
    model=Park,
    mapping={"name": "profile.name", "capacity": "profile.capacity"},
)
parks.create(Park("Central", 120), id="park-1")
page = parks.query(
    {"capacity": {"gte": 100}}, order_by=[{"field": "name", "direction": "asc"}]
)
for park in page:  # page.items are Park instances
    print(park.name)
```

Writes accept raw `data` or logical `object`; reads accept `as_view="object"`.
Queries return a `QueryResult` (`items`, `total`, `limit`, `offset`,
`next_cursor`). `increment` is atomic and `changes(since)` polls the change feed.

### Faststore + Queue

```python
c.faststore.set("cache:park:1", {"name": "Central"}, ttl_seconds=300)
c.faststore.list_push("jobs", [{"id": 1}])
lock = c.faststore.lock_acquire("report", ttl_seconds=60)
c.faststore.lock_release("report", lock["token"])

c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=30)
c.queue.publish("emails", {"to": "a@b.c"}, dedupe_key="welcome:a@b.c")
batch = c.queue.consume("emails", max_messages=10, consumer="worker-1")
for msg in batch["messages"]:
    try:
        handle(msg["payload"])
        c.queue.ack("emails", msg["receipt"])
    except Exception as exc:
        c.queue.nack("emails", msg["receipt"], delay_seconds=30, error=str(exc))
```

## Auth and tenants

`SynapseOneClient(base_url, token=..., api_key=..., tenant=...)`, or
`set_token(jwt)` / `set_api_key(key)` after login. `timeout` configurable
(default 15s). `tenant` is sent as `x-synapseone-tenant` and is only required by
platform callers of the tenant-scoped services (faststore/queue).

## Sign-in with MFA

MFA is optional and disabled by default in the current deployment
(`SYNAPSEONE_MFA_ENABLED=false`). The following applies only when enabled.

```python
from synapseone_sdk import SynapseOneError

try:
    s = c.iam.login_with_password(email, password, "acme")
except SynapseOneError as e:
    if e.status != 401 or e.body.get("error") != "mfa_required":
        raise
    s = c.iam.verify_mfa(e.body["mfaToken"], code="492039")  # or recovery_code=
c.set_token(s["accessToken"])
```

Enrol with `c.iam.setup_totp()` + `c.iam.enable_totp(code)`; also `mfa_status`,
`regenerate_recovery_codes`, `disable_mfa`, and for org admins `reset_user_mfa` /
`unlock_user`.

## Redirects, timeouts and response limits

- Redirects are handled manually. Same-origin redirects keep `Authorization`,
  `X-API-Key`, cookies and tenant headers. Cross-origin redirects are followed
  only when the target origin is in `trusted_redirect_origins` (constructor
  argument or `SYNAPSEONE_TRUSTED_REDIRECT_ORIGINS`, comma separated), and are
  always sent **without** credentials. Other cross-origin redirects raise
  `SynapseOneError(code="redirect_not_allowed")` without contacting the target.
- `timeout` covers connection, headers and body reads. A stalled body raises
  `SynapseOneError(code="timeout")` instead of hanging.
- JSON/text responses are capped at `max_json_bytes` (default 8 MiB) and binary
  downloads at `max_binary_bytes` (default 128 MiB, matching OCS). Limits are
  enforced while streaming and raise `code="response_too_large"`; bodies are
  never silently truncated. Set a limit to `0` to disable it.
- `max_redirects` defaults to 10. The gateway does not redirect normal API
  routes; use the canonical HTTPS base URL rather than relying on an
  HTTP→HTTPS cross-origin redirect (which would be unauthenticated even when
  trusted).

## Deprecated flat API

The old flat methods (`c.login(...)`, `c.list_templates()`,
`c.list_lds_datasources(...)`, ...) still work but emit a `DeprecationWarning`
that points at the namespaced replacement (e.g.
`client.workflow.list_templates()`). Migrate call sites and silence the
warnings. `c.call(method, path, body)` remains the generic escape hatch.

## Tests

```bash
python -m pytest tests -q
```

The offline test harness lives in `tests/` (stdlib echo servers, no
platform needed) and is not shipped in the wheel — only the `synapseone_sdk`
and `synapsedx_sdk` packages are packaged.

## Full documentation

See **[docs/sdk-python.md](../../docs/sdk-python.md)** for the language guide —
constructor, auth, method signatures, parameters, return types, and examples. For copyable per-service examples in all four SDK languages,
see [`docs/services/`](../../docs/services/).
