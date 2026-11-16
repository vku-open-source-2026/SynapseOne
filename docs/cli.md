# `synapseone` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [SynapseOne](../README.md) Tier-1 PaaS. No `npm install` needed — single file, only Node's built-in `fetch`.

## Install

### One-line installer (recommended)

```bash
curl -fsSL https://synapseone.space/install.sh | sh
```

### From npm registry

```bash
npm install -g @synapseone/cli@latest
```

### Run without installing

```bash
npx -y @synapseone/cli@latest --help
```

### From source

```bash
# Run directly
node tools/cli/bin/synapseone.js --help

# Or link globally
npm link ./tools/cli
# then call `synapseone ...` anywhere
```

## Quick start

```bash
# Defaults to https://api.synapseone.space (or pass --base http://localhost:8080 for local dev)
synapseone login --email demo@acme.local
synapseone orgs
synapseone accounts create prod Production
synapseone authz <user-id> workflow:Execute "*" --context team=etl
synapseone workflows create --template webhook-to-log --name demo
synapseone audit --limit 20
```

For local container development: add `--base http://localhost:8080` (or `export SYNAPSEONE_BASE_URL=http://localhost:8080`).

## Configuration

### Base URL resolution

The CLI resolves the base URL in this order (first match wins):

1. `--base <URL>` flag
2. `$SYNAPSEONE_BASE_URL` environment variable
3. `baseUrl` in `~/.synapseone/config.json`
4. `https://api.synapseone.space` (default — the API gateway, not the console host)

### Auth resolution

The CLI resolves credentials in this order (first match wins):

1. `--token <jwt>` / `--apikey <key>` flags
2. `$SYNAPSEONE_TOKEN` / `$SYNAPSEONE_API_KEY` environment variables
3. `token` / `apiKey` in `~/.synapseone/config.json`

> **Security note:** Prefer env vars or config file over `--token`/`--apikey` flags, since flags are visible via `ps` and shell history.

### Config file

`synapseone login` and `synapseone use-key` save credentials to `~/.synapseone/config.json` (file permissions `0600`, owner-only). The refresh token is also stored for `refresh` / `logout-all` reuse.

```bash
# Show saved config (secrets are redacted)
synapseone config
```

### Global flags

| Flag | Description |
|---|---|
| `--base <URL>` | Override base URL |
| `--token <jwt>` | Bearer token |
| `--apikey <key>` | API key |
| `--json` | Output raw JSON (script-friendly) |
| `--context k=v` | Add context key-value (repeatable) |
| `--file <path>` | Read a JSON body (or binary object for `ocs put`) from a file |
| `--data <json\|path>` | Inline JSON or JSON file for workflow input / payloads (alias: `--input`) |
| `--input <json\|path>` | Same as `--data` |
| `--value <json\|text>` | Value for faststore/queue/stream/set operations (JSON when parseable) |
| `--value-file <path>` | Read a literal string value from a file (secrets, credentials) |
| `--ttl <seconds>` | TTL for faststore keys, queue locks/visibility |
| `--payload <json\|text>` | Queue/stream event payload (alias: `--data`) |
| `--output <path>` | Write binary `ocs get` output to a file |
| `--channel <name>` | Notification channel (`email`\|`sms`\|`webhook`\|`push`\|`log`) |
| `--to <recipient>` | Notification recipient (email, phone, or webhook URL) |
| `--subject <s>` / `--body <s>` | Notification subject/body |
| `--scope <s>` | Secret scope (`tenant`\|`account`\|`workflow`) |
| `--from <ISO>` / `--to <ISO>` | Usage analytics time window |
| `--column name:type` | Warehouse dataset column (repeatable) |
| `--sql <query>` | Read-only warehouse SQL |
| `--collection <name>` | Search/reindex collection filter (repeatable) |
| `--filter k=v` | Search filter (repeatable) |
| `--secret-version <N>` | Secret version for `secrets read`/`revoke` |
| `--limit <N>` | Limit results (`0..9999`) |
| `--offset <N>` | Skip N executions (`0..9999`, `0` = first page) |
| `--workflow-id <ID>` | Filter executions by workflow (alias: `--workflow`, `--workflowId`) |
| `--status <s>` | Filter executions (`success`\|`error`\|`running`) |
| `--include-data` | Include per-node I/O (`includeData=true`) |
| `--path <p>` | Webhook path for `webhook <path>` |
| `--method <m>` | Webhook HTTP method (`GET`\|`POST`\|`PUT`\|`PATCH`\|`DELETE`\|`HEAD`); also `call <METHOD>` |
| `--type <t>` | Credential type (`bearer`\|`basic`\|`apiKey`\|`oauth2`) |
| `--secret <S>` | Credential secret (prefer `--secret-file`/env — flags leak via `ps`) |
| `--secret-file <path>` | Read credential secret from file (preferred) |
| `--expires-at <ISO>` | Credential expiry timestamp |
| `--actor <id>` | Filter by actor |
| `--name <name>` | Name for create operations |
| `--template <name>` | Template name |
| `--email <email>` | Email for login |
| `--org <slug>` | Org slug |
| `--label <label>` | Label/name |

## Commands

### Auth

#### `login`
```bash
synapseone login --email <email> [--org <slug>] [--base <url>]
```
Dev login. Saves token + refresh token to config.

```bash
synapseone login --email demo@acme.local
synapseone login --email alice@acme.local --org acme
```
#### `login`
```bash
synapseone login --email <email> [--org <slug>] [--password <pw>] [--code <123456> | --recovery-code <code>] [--base <url>]
```
Signs in and saves token + refresh token to config. Without `--password` it uses the
dev login (disabled when `IAM_ALLOW_DEV_LOGIN=false`). When the account has MFA, pass
the authenticator code (or a recovery code); otherwise the command explains that MFA
is required.

```bash
synapseone login --email demo@acme.local
synapseone login --email alice@acme.local --org acme --password '...' --code 492039
```

#### `mfa`
```bash
synapseone mfa [status]                      # enabled? recovery codes left
synapseone mfa setup                         # prints the secret + otpauth:// URL
synapseone mfa enable <code>                 # turns MFA on, prints 10 recovery codes once
synapseone mfa recovery-codes <code>         # replaces the recovery codes
synapseone mfa disable --code <code>         # or --recovery-code <code>
synapseone mfa reset <user-id>               # org admins: lost device
synapseone mfa unlock <user-id>              # org admins: clear a sign-in lockout
```
One-time secrets (TOTP secret, recovery codes, new API keys) are written once to
stdout, never to a log.

#### `refresh`
```bash
synapseone refresh [refresh-token]
```
Rotates the access token (atomic server-side). Uses `$SYNAPSEONE_REFRESH_TOKEN` or config if no argument given.

```bash
synapseone refresh
synapseone refresh eyJhbGciOi...
```

#### `logout-all`
```bash
synapseone logout-all [refresh-token]
```
Revokes ALL sessions of the token owner.

```bash
synapseone logout-all
```

#### `logout`
```bash
synapseone logout
```
Clears saved credentials from config.

#### `verify`
```bash
synapseone verify
```
Checks the current Bearer token or API key.

#### `use-key`
```bash
synapseone use-key <api-key>
```
Saves an API key to config (instead of a token).

```bash
synapseone use-key sk_live_abc123...
```

#### `health`

```bash
synapseone health            # GET /health
synapseone health --ready    # GET /ready: per-upstream table; exit 3 when degraded
synapseone health --ready --json
```

A 2xx HTML response (wrong `--base`, e.g. the console host) is rejected with a
clear error instead of printing the SPA.

#### `whoami`
```bash
synapseone whoami
```
Shows the current user (`/v1/auth/me`).

#### `config`
```bash
synapseone config
```
Shows saved config with secrets redacted.

### Organizations

#### `orgs`
```bash
synapseone orgs
synapseone orgs list
```
Lists all organizations.

#### `orgs create`
```bash
synapseone orgs create <slug> [name]
```
Creates an organization.

```bash
synapseone orgs create acme2 "ACME 2"
```

### Accounts

#### `accounts`
```bash
synapseone accounts [org]
synapseone accounts list [org]
```
Lists accounts in an organization. If no org is given, uses the first available org.

#### `accounts create`
```bash
synapseone accounts create [org] <slug> [name]
```
Creates an account under an organization.

```bash
synapseone accounts create prod Production
synapseone accounts create my-org prod Production
```

### Users

#### `users`
```bash
synapseone users [org]
synapseone users list [org]
```
Lists users in an organization.

#### `users create`
```bash
synapseone users create <org> <email> [name]
```
Creates a user in an organization.

```bash
synapseone users create my-org alice@acme.local "Alice"
```

#### `users policies`
```bash
synapseone users policies <user-id>
```
Shows the effective policy documents of a user.

```bash
synapseone users policies usr_abc123
```

### Roles

#### `roles`
```bash
synapseone roles <account>
synapseone roles list <account>
```
Lists roles in an account.

#### `roles create`
```bash
synapseone roles create <account> <slug>
```
Creates a role in an account.

```bash
synapseone roles create acc_abc123 etl-runner
```

#### `roles delete`
```bash
synapseone roles delete <role-id>
```
Deletes a role.

```bash
synapseone roles delete rol_abc123
```

### Policies

#### `policies`
```bash
synapseone policies <account>
synapseone policies list <account>
```
Lists policies in an account.

#### `policies create`
```bash
synapseone policies create <account> <slug> --file <policy.json>
```
Creates an IAM policy from a JSON file.

```bash
synapseone policies create acc_abc123 wf-exec --file policy.json
```

Example `policy.json`:
```json
{
  "Version": "2012-17-10",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["workflow:Execute"],
    "Resource": ["*"]
  }]
}
```

#### `policies delete`
```bash
synapseone policies delete <policy-id>
```
Deletes a policy.

```bash
synapseone policies delete pol_abc123
```

### Role-policy attachment

#### `attach`
```bash
synapseone attach <role-id> <policy-id>
```
Attaches a policy to a role.

```bash
synapseone attach rol_abc123 pol_abc123
```

#### `assign`
```bash
synapseone assign <user-id> <role-id>
```
Assigns a role to a user.

```bash
synapseone assign usr_abc123 rol_abc123
```

### Authorization

#### `authz`
```bash
synapseone authz <user-id> <action> <resource> [--context k=v]
```
Checks whether a user is authorized to perform an action on a resource.

```bash
synapseone authz usr_abc123 workflow:Execute "*"
synapseone authz usr_abc123 workflow:Execute "wf_123" --context team=etl
```

#### `sim`
```bash
synapseone sim --file <policy.json> <action> <resource> [--context k=v]
```
Dry-runs policy documents without a user (like AWS IAM Policy Simulator).

```bash
synapseone sim --file policy.json workflow:Execute "*"
synapseone sim --file policies.json workflow:Execute "wf_123" --context env=prod
```

The `--file` can contain a single policy object or an array of policies.

### Audit

#### `audit`
```bash
synapseone audit [--limit <N>] [--actor <id>]
```
Reads the audit log.

```bash
synapseone audit
synapseone audit --limit 20
synapseone audit --limit 50 --actor usr_abc123
```

### API keys

#### `keys create`
```bash
synapseone keys create <account> [--name <name>]
```
Creates an API key. The key is shown once — save it immediately.

```bash
synapseone keys create acc_abc123 --name ci-deploy
```

#### `keys revoke`
```bash
synapseone keys revoke <key-id>
```
Revokes an API key.

```bash
synapseone keys revoke key_abc123
```

#### `keys list`
```bash
synapseone keys list <account>
```
Lists key metadata (id/prefix only — never secret values).

```bash
synapseone keys list acc_abc123
```

#### `keys verify`
```bash
synapseone keys verify <api-key>
```
Checks a raw API key via the internal verify endpoint.

```bash
synapseone keys verify sk_live_abc123...
```

### Service accounts

#### `sa`
```bash
synapseone sa <account>
synapseone sa list <account>
```
Lists service accounts in an account.

#### `sa create`
```bash
synapseone sa create <account> <slug>
```
Creates a service account.

```bash
synapseone sa create acc_abc123 etl-bot
```

#### `sa token`
```bash
synapseone sa token <sa-id>
```
Mints a short-lived JWT for a service account. The token is shown once — save it immediately.

```bash
synapseone sa token sa_abc123
```

### Credentials (PROPOSED — backend in progress)

Account-scoped secrets for workflow nodes. Secrets are encrypted at rest and
**never returned**: `create`/`rotate` take a secret once; `list`/`get` return
metadata only (`{id, name, type, accountId, expiresAt, version}`).
Prefer `--secret-file` (or `$SYNAPSEONE_CREDENTIAL_SECRET`) over `--secret` —
flags leak via `ps` and shell history.

#### `credentials create`
```bash
synapseone credentials create <account> --name <name> --type bearer|basic|apiKey|oauth2 (--secret <S> | --secret-file <path>) [--expires-at <ISO>]
```

```bash
# Copy-paste: store a bearer token, then verify only metadata comes back.
echo -n 'tok_live_abc' > /tmp/stripe-secret
synapseone credentials create acc_abc123 --name stripe-live --type bearer --secret-file /tmp/stripe-secret --expires-at 2027-01-01T00:00:00Z
synapseone credentials list acc_abc123
```

#### `credentials list` / `credentials get`
```bash
synapseone credentials [list] <account>
synapseone credentials get <credential-id>
```

```bash
synapseone credentials list acc_abc123
synapseone credentials get cred_abc123
```

#### `credentials rotate`
```bash
synapseone credentials rotate <credential-id> (--secret <S> | --secret-file <path>)
```
Replaces the secret and bumps `version` (the old secret stops working).

```bash
echo -n 'tok_live_xyz' > /tmp/stripe-secret-v2
synapseone credentials rotate cred_abc123 --secret-file /tmp/stripe-secret-v2
```

#### `credentials delete`
```bash
synapseone credentials delete <credential-id>
```

```bash
synapseone credentials delete cred_abc123
```

### Generic call (escape hatch)

Every supported service has a first-class command group (see
[Synapse Faststore](#synapse-faststore), [SynapseQueue](#synapsequeue),
[SynapseStream](#synapsestream), [SynapseOCS](#synapseocs),
[SynapseNotifications](#synapsenotifications), and
[Inference](#inference-chat-embeddings-decision-routing)).
Use `call` only for new endpoints that do not have a command yet.

#### `call`
```bash
synapseone call <METHOD> <path> [--data '{...}'|body.json] [--file body.json]
```
Calls any gateway endpoint directly.

```bash
synapseone call GET /v1/accounts/acc_abc123/credentials
synapseone call POST /v1/workflows/test-run --data '{"definition":{"nodes":[],"connections":{}},"input":{}}'
```

### Workflows

#### `workflows`
```bash
synapseone workflows
synapseone workflows list
```
Lists all workflows.

#### `workflows create` (from template)
```bash
synapseone workflows create --template <name> [--name <name>]
```
Instantiates a built-in template.

```bash
synapseone workflows create --template webhook-to-log --name my-webhook
```

#### `workflows create` (from file)
```bash
synapseone workflows create --file <definition.json> [--name <name>]
```
Creates a workflow from a raw workflow definition JSON file. The file can contain either a full body (`{"template": ..., "name": ...}` or `{"definition": ..., "name": ...}`) or a bare definition.

```bash
synapseone workflows create --file my-workflow.json --name my-wf
```

#### `workflows get`
```bash
synapseone workflows get <workflow-id>
```
Gets a single workflow by ID.

```bash
synapseone workflows get wf_abc123
```

#### `workflows activate`
```bash
synapseone workflows activate <workflow-id>
```
Activates a workflow.

```bash
synapseone workflows activate wf_abc123
```

#### `workflows deactivate`
```bash
synapseone workflows deactivate <workflow-id>
```
Deactivates a workflow.

```bash
synapseone workflows deactivate wf_abc123
```

#### `workflows exec`
```bash
synapseone workflows exec <workflow-id> [--data '{"k":v}'|input.json] [--file payload.json] [--wait] [--timeout MS]
synapseone workflows execute <workflow-id> [--data ...] [--file ...] [--wait]
```
Triggers a manual execution (the request body IS the workflow input).
`--data` takes inline JSON or a path to a JSON file; `--file` reads the
payload from a file (a bare input object, or `{input: {...}}`).

Queue mode returns `{queued:true, executionId}`; add `--wait` to block for the
result (default timeout 60s, override with `--timeout MS`).

```bash
synapseone workflows exec wf_abc123
synapseone workflows exec wf_abc123 --data '{"value":21}' --wait
echo '{"value":21}' > input.json
synapseone workflows exec wf_abc123 --data input.json
```

#### `runners`
```bash
synapseone runners [list]
synapseone runners create --name <name> --account <account-id> [--mode custom|hybrid] [--queue Q] [--scopes S]
synapseone runners get|connection|command|delete <runner-id>
```
Creates a self-hosted workflow runner: mints a scoped API key, registers the
runner, and prints a copy-paste `docker run` command **including the API key**
(shown once). `runners connection <id>` returns `connected: true` once the
runner heartbeat arrives.

```bash
synapseone runners create --name edge-eu --account "$ACCOUNT_ID"
synapseone runners connection <runner-id>
```

#### `workflows test-run`
```bash
synapseone workflows test-run --file <definition.json> [--input '{"k":v}'|input.json]
```
Tries a definition without saving (`POST /v1/workflows/test-run {definition, input}`).
`--file` (required) holds a bare `{nodes, connections}` definition or
`{definition, input}`; `--input` (inline JSON or JSON file) overrides the input.

```bash
# Copy-paste: try the code-transform template without saving.
synapseone templates code-transform --json > def.json
echo '{"value":21}' > input.json
synapseone workflows test-run --file def.json --input input.json
synapseone workflows test-run --file def.json --input '{"value":42}'
```

#### `workflows update`
```bash
synapseone workflows update <workflow-id> [--name <name>] [--file <definition.json>]
```
Updates a workflow's name and/or definition (at least one of `--name`/`--file`).

```bash
synapseone workflows update wf_abc123 --name renamed
```

#### `workflows delete`
```bash
synapseone workflows delete <workflow-id>
```
Deletes a workflow on the engine (`rm` is an alias).

```bash
synapseone workflows delete wf_abc123
```

### Templates

#### `templates`
```bash
synapseone templates
synapseone templates list
```
Lists all built-in workflow templates.

#### `templates <name>`
```bash
synapseone templates <name>
```
Fetches a single built-in template definition by name.

```bash
synapseone templates webhook-to-log
```

### Executions

> The engine always returns the envelope `{data: [...]}` for `GET /v1/executions`.
> The CLI unwraps it — list output is the plain execution array.

#### `executions`
```bash
synapseone executions
synapseone executions list [--limit <N>] [--offset <N>] [--workflow-id <ID>] [--status success|error|running] [--include-data]
```
Lists workflow executions. Allowed filters mirror the server allowlist
(`limit`/`offset` `0..9999`, `offset=0` = first page).

```bash
synapseone executions
synapseone executions list --limit 10
synapseone executions list --workflow-id wf_abc123 --status success --limit 20 --offset 20
synapseone executions list --limit 5 --include-data  # per-node I/O
```

#### `executions <id>`
```bash
synapseone executions <execution-id> [--include-data]
```
Gets a single execution by ID (`--include-data` adds per-node input/output).

```bash
synapseone executions exe_abc123
synapseone executions exe_abc123 --include-data
```

### Linked Data (SynapseLDS)

Publish licensed NGSI-LD open data. Reserved attribute names (id, type, @context,
internalId, tenantId, …) are rejected with `400 reserved_attribute`; unregistered
fields are stored but never exported (default deny — register them with `public`
visibility first). `_core` metadata never appears in any response.

```bash
synapseone lds licenses
synapseone lds datasources list [--org <orgId>] [--account <accountId>]
synapseone lds datasources create --name "Business Registry" --entity-type Organization \
  --license CC-BY-4.0 [--slug business-registry] \
  [--context https://data.example.vn/context/organization.jsonld]... [--visibility internal|public]
synapseone lds datasources get <id> | update <id> [--license ODbL-1.0] | delete <id>
synapseone lds attributes list <id>
synapseone lds attributes set <id> --file attributes.json   # [{name, ngsiLdType, visibility}]
synapseone lds ingest <id> --file record.json               # {"id":"55001","name":"ACME"}
synapseone lds entities <id> [--limit 20] [--offset 0] [--visibility public|restricted]
synapseone lds entity <id> <entityId>
synapseone lds stats <id>
```

`entities`/`entity` print pretty NGSI-LD JSON (each entity carries `@context`,
and responses come back with `X-LDS-License` + `Link rel="license"`). The
export read surface (`lds licenses`, `lds entities`, `lds entity`) is **public
open data**: without any login it serves the public projection — that is the
endpoint open-data consumers use. `--visibility restricted` needs a same-tenant
session (other tenants only get `404`; no token + restricted → `401`).

### Document DB & Vector Search (SynapseBase)

Manage collections, document JSON storage, vector similarity search, and hybrid queries.

```bash
# Collections CRUD
synapseone base collections list
synapseone base collections create <name> [--description <desc>] [--mapping '<json>'|--file <json>]
synapseone base collections get <name>
synapseone base collections delete <name>

# Documents CRUD
synapseone base documents list <col> [--limit 20] [--offset 0] [--as data|object]
synapseone base documents insert <col> [--id <id>] (--file doc.json | --data '{"k":"v"}')
synapseone base documents get <col> <id> [--as data|object]
synapseone base documents delete <col> <id>

# Vector Similarity & Hybrid Search
# Search by raw float vector:
synapseone base vector-search <col> --vector '[0.1, 0.2, 0.3]' [--limit 10] [--metric cosine|l2|ip] [--where '{"category":"tech"}']
# Search by natural language query (auto-embedded via inference service):
synapseone base vector-search <col> --query "authentication guide" [--limit 5] [--metric cosine]

# Structured Queries
synapseone base query <col> (--file query.json | --data '{"where":{"type":{"eq":"guide"}},"limit":10}')
```

### Synapse Faststore

Tenant-scoped cache with Redis-compatible primitives. Values are JSON when
`--value` parses as JSON, otherwise the literal string. TTLs are seconds.

```bash
# Key/value
synapseone faststore stats
synapseone faststore keys [--prefix cache:] [--limit 100] [--cursor 0]
synapseone faststore get cache:demo
synapseone faststore set cache:demo --value '{"ok":true}' --ttl 300 \
  [--if-not-exists | --if-exists]
synapseone faststore del cache:demo
synapseone faststore ttl cache:demo
synapseone faststore expire cache:demo --ttl 60
synapseone faststore incr page:views --by 1 --ttl 3600
synapseone faststore batch --file batch.json

# Hashes
synapseone faststore hashes set session --data '{"u1":"alice","u2":"bob"}'
synapseone faststore hashes set session u1 --value alice
synapseone faststore hashes get session [u1]
synapseone faststore hashes del session [u1]
synapseone faststore hashes incr session u1 --by 1
synapseone faststore hashes len session

# Lists
synapseone faststore lists range jobs [--start 0] [--stop -1]
synapseone faststore lists push jobs --values a,b [--side left|right] [--ttl 300]
synapseone faststore lists pop jobs [--side left|right] [--count 1]
synapseone faststore lists trim jobs --start 0 --stop 99
synapseone faststore lists len jobs
synapseone faststore lists del jobs

# Sets
synapseone faststore sets members tags
synapseone faststore sets add tags --members a,b [--ttl 300]
synapseone faststore sets remove tags --members a
synapseone faststore sets contains tags --value a
synapseone faststore sets card tags
synapseone faststore sets del tags

# Sorted sets
synapseone faststore zsets add leaderboard --members alice,bob --score 10
synapseone faststore zsets add leaderboard --data '[{"member":"alice","score":10}]'
synapseone faststore zsets range leaderboard [--start 0] [--stop -1] [--with-scores] [--rev]
synapseone faststore zsets score leaderboard alice
synapseone faststore zsets rank leaderboard alice [--rev]
synapseone faststore zsets incr leaderboard alice --by 5
synapseone faststore zsets remove leaderboard --members alice
synapseone faststore zsets card leaderboard

# Distributed locks
synapseone faststore locks acquire deploy:prod --ttl 30 --wait-ms 5000
synapseone faststore locks extend deploy:prod <token> --ttl 30
synapseone faststore locks release deploy:prod <token>
```

### SynapseQueue

Queues with delayed/deduplicated publish, visibility timeouts, receipts,
dead letters and replay.

```bash
synapseone queue [list]
synapseone queue create emails --max-attempts 5 --visibility-timeout 30
synapseone queue get emails
synapseone queue stats emails
synapseone queue purge emails
synapseone queue delete emails

# Publish
synapseone queue send emails --payload '{"to":"a@b.c"}' \
  [--delay 60] [--dedupe-key K] [--max-attempts 3] [--header k=v] [--id ID]
synapseone queue send-batch emails --file messages.json

# Consume → receipt → ack/nack/heartbeat
synapseone queue consume emails [--count 10] [--wait-seconds 20] \
  [--visibility-timeout 30] [--consumer worker-1]
synapseone queue ack emails <receipt> [<receipt>...]
synapseone queue nack emails <receipt> [--no-requeue] [--delay 30] [--error "boom"]
synapseone queue heartbeat emails <receipt> [--visibility-timeout 60]

# Inspect and repair
synapseone queue peek emails [--limit 20] [--ready]
synapseone queue dead emails [--limit 20]
synapseone queue replay emails <message-id> [--delay 0] [--reset-attempts]
synapseone queue rm-dead emails <message-id>
```

`queue consume` prints the `receipt` verbatim (not truncated) so it can be
passed straight to `ack`/`nack`.

### SynapseStream

Append-only event topics with consumer groups.

```bash
synapseone stream [topics]
synapseone stream create telemetry [--max-len 100000] [--retention-ms 86400000]
synapseone stream get telemetry
synapseone stream stats telemetry
synapseone stream delete telemetry

synapseone stream publish telemetry --payload '{"value":25.4}' \
  [--key sensor-1] [--header k=v] [--id event-1]
synapseone stream publish-batch telemetry --file events.json
synapseone stream read telemetry [--from-id 0-0] [--count 100] [--block-ms 5000]
synapseone stream range telemetry [--start -] [--end +] [--count 100]

synapseone stream group create telemetry workers [--start-id '$']
synapseone stream group read telemetry workers [--consumer w1] [--count 10] \
  [--block-ms 5000] [--auto-ack]
synapseone stream group ack telemetry workers <event-id>...
synapseone stream group delete telemetry workers
```

### SynapseOCS

Object storage with buckets, binary upload/download, presigned URLs and
multipart uploads.

```bash
synapseone ocs buckets [--stats]
synapseone ocs bucket create city-assets [--quota-bytes 1073741824]
synapseone ocs bucket get city-assets
synapseone ocs bucket stats city-assets
synapseone ocs bucket delete city-assets

synapseone ocs ls city-assets [--prefix maps/] [--delimiter /] [--limit 100] [--cursor C]
synapseone ocs put city-assets maps/a.png --file ./a.png [--content-type image/png]
synapseone ocs put city-assets notes/readme.txt --data 'hello'
synapseone ocs get city-assets maps/a.png [--output ./a.png]
synapseone ocs head city-assets maps/a.png
synapseone ocs rm city-assets maps/a.png
synapseone ocs copy city-assets src.txt dst.txt [source-bucket]
synapseone ocs presign city-assets maps/a.png [--method GET] [--expires 3600]

# Multipart
synapseone ocs uploads create city-assets big.bin
synapseone ocs part city-assets 1 big.bin --upload-id <id> --file part1.bin
synapseone ocs uploads complete city-assets <id> big.bin --file parts.json
synapseone ocs uploads abort city-assets <id> big.bin
```

Without `--output`, `ocs get` writes the object bytes to stdout (safe for
pipes: `synapseone ocs get b key | jq .`).

### SynapseNotifications

Outbox-backed email/SMS/push/webhook notifications with retries and
preferences.

```bash
synapseone notifications [list] [--status queued] [--limit 50]
synapseone notifications get <id>
synapseone notifications cancel <id>

synapseone notifications send a@b.c --channel email --subject Hi --body Hello \
  [--data '{"name":"Lan"}'] [--idempotency-key K]
synapseone notifications send --to +84901234567 --channel sms --body '...'
synapseone notifications send --to https://example.com/hook --channel webhook --body '...'

synapseone notifications prefs get a@b.c
synapseone notifications prefs set a@b.c --channels email,sms [--unsubscribed]
synapseone notifications unsubscribe a@b.c
```

### Search

Tenant-scoped search over SynapseBase documents.

```bash
synapseone search "authentication guide" [--mode fulltext|semantic|hybrid] \
  [--collection kb] [--limit 20] [--cursor C] [--filter status=published]
synapseone search reindex [--collection kb]... [--max-per-collection 50000]
synapseone search status
```

`--filter k=v` is repeatable; `--filters '{"status":"published"}'` accepts a
JSON object or file.

### Secrets

Versioned tenant secret vault. Values are never returned by `list`/`get`;
`read` is an explicit, audited operation.

```bash
synapseone secrets [list]
synapseone secrets create stripe --value-file ./secret.txt \
  [--description 'Stripe live key'] [--scope tenant|account|workflow] [--account <id>]
synapseone secrets get stripe
synapseone secrets read stripe [--secret-version 2]
synapseone secrets rotate stripe --value-file ./new.txt [--grace 86400]
synapseone secrets revoke stripe [--secret-version 2]
synapseone secrets delete stripe
```

### Inference: chat, embeddings, decision routing

```bash
synapseone inference health
synapseone inference chat "summarize the incident" \
  [--system "You are a terse SRE"] [--model <model>] [--temperature 0.7] [--max-tokens 1024]
synapseone inference chat --file request.json
synapseone inference embeddings "authentication guide" [--model <model>] [--dimensions 384]
synapseone inference decision --state "..." --questions '{"intent":{"type":"choice","instructions":"Pick one","criteria":{"billing":"billing issue","tech":"technical issue"}}}'
synapseone inference route --input "payment failed" \
  --choice billing="billing question" --choice tech="technical issue"

synapseone inference jobs [list] [--status success] [--limit 20]
synapseone inference jobs get <id>
synapseone inference jobs submit --job-type chat --file payload.json \
  [--queue inference] [--wait] [--timeout-ms 120000]

synapseone ai agent "What changed in the last deploy?" [--history '[...]']
```

`inference chat` prints only the assistant message by default; `--json` prints
the full OpenAI-compatible response.

### Synapse Warehouse

```bash
synapseone warehouse datasets
synapseone warehouse dataset create incidents \
  --column id:string --column severity:string --column opened_at:timestamp \
  [--description D] [--mode batch|stream] [--stream-topic telemetry]
synapseone warehouse dataset get <id>
synapseone warehouse dataset rows <id> --file rows.json
synapseone warehouse dataset delete <id>

synapseone warehouse query --sql 'SELECT severity, count(*) FROM incidents GROUP BY 1' [--limit 200]
synapseone warehouse templates

synapseone warehouse jobs
synapseone warehouse job create nightly --dataset incidents --mode batch \
  --sql 'SELECT * FROM incidents' [--write-mode append|replace]
synapseone warehouse job create ingest --dataset incidents --mode stream \
  --stream-topic telemetry [--stream-group g] [--batch-size 100] [--interval-ms 1000]
synapseone warehouse job get|run|pause|resume|delete <id>
synapseone warehouse etl-batch --dataset incidents --sql '...' [--name N] [--write-mode replace]
```

### Human tasks

```bash
synapseone human-tasks [list] [--status pending] [--assignee u1] \
  [--workflow-id wf] [--execution-id exe] [--limit 50]
synapseone human-tasks get <id>
synapseone human-tasks create "Approve deploy" [--description D] [--assignee u1] \
  [--role approver]... [--deadline 2026-12-01T00:00:00Z] \
  [--workflow-id wf] [--execution-id exe] [--node approve] [--data '{"k":"v"}']
synapseone human-tasks claim <id>
synapseone human-tasks approve <id> [--note "LGTM"] [--decision '{"k":"v"}']
synapseone human-tasks reject <id> --note "missing rollback plan"
synapseone human-tasks expire <id> [--force]
```

### Usage analytics

```bash
synapseone usage summary [--from ISO] [--to ISO] [--feature base] \
  [--account UUID] [--actor UUID] [--method GET] [--status 200] [--status-class 4xx] [--q TEXT]
synapseone usage events [--from ISO] [--to ISO] [--limit 200] [--offset 0]
```

### SCIM provisioning tokens

```bash
synapseone scim tokens
synapseone scim token create [--description okta] [--scopes scim:read,scim:write] [--ttl 86400]
synapseone scim token revoke <id>
```

### Webhooks (public, no auth)

`ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares
that `path`. No token needed. NOTE: the gateway does **not** proxy `/webhook/*` —
point `--base` at the workflow-service origin (default `http://localhost:4002`
for local dev), not the gateway.

#### `webhook`
```bash
synapseone webhook <path> [--data '{"k":v}'|payload.json] [--file payload.json] [--method POST] [--base http://localhost:4002]
```
Fires a public inbound webhook.

```bash
# Copy-paste: activate the code-transform template, then fire its webhook.
synapseone workflows create --template code-transform --name demo-transform
synapseone workflows activate <wf-id>
synapseone webhook transform --data '{"value":21}' --base http://localhost:4002
```

Raw curl equivalent:

```bash
curl -X POST http://localhost:4002/webhook/transform \
  -H 'Content-Type: application/json' \
  -d '{"value":21}'
```

## Output format

By default, the CLI prints a compact table (arrays) or key-value pairs (objects). Use `--json` for raw JSON output:

```bash
synapseone --json orgs
synapseone --json workflows list
```

## Environment variables

| Variable | Description |
|---|---|
| `SYNAPSEONE_BASE_URL` | Gateway URL |
| `SYNAPSEONE_TOKEN` | Bearer JWT |
| `SYNAPSEONE_API_KEY` | API key |
| `SYNAPSEONE_REFRESH_TOKEN` | Refresh token (for `refresh` / `logout-all`) |
| `SYNAPSEONE_CREDENTIAL_SECRET` | Credential secret (for `credentials create` / `rotate`, avoids `--secret` in `ps`) |
| `DEMO_ORG_SLUG` | Default org slug when auto-resolving org ID (defaults to `acme`) |

## Full workflow example

```bash
# 1. Login
synapseone login --email demo@acme.local

# 2. Create org + account
synapseone orgs create acme "ACME Corp"
synapseone accounts create prod Production

# 3. Create role + policy
synapseone roles create acc_abc123 wf-runner
synapseone policies create acc_abc123 wf-exec --file policy.json
synapseone attach rol_abc123 pol_abc123
synapseone assign usr_abc123 rol_abc123

# 4. Deploy + execute workflow
synapseone workflows create --template webhook-to-log --name demo
synapseone workflows activate wf_abc123
synapseone workflows exec wf_abc123 --data '{"value":21}'

# 5. Try a definition without saving + check history
synapseone workflows test-run --file def.json --input input.json
synapseone executions list --workflow-id wf_abc123 --limit 20

# 5. Check audit log
synapseone audit --limit 20
```
