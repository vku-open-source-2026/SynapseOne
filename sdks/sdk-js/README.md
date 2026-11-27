# `@synapseone/sdk` — SynapseOne SDK for JavaScript/TypeScript

Apache-2.0. Part of [SynapseOne](../../README.md) Tier-1 PaaS.

Zero runtime dependencies. Works in Node 18+ and browsers (fetch-based).

## Install

```bash
npm install @synapseone/sdk
```

## Quick start

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient(); // defaults to https://api.synapseone.space (or $SYNAPSEONE_BASE_URL)
const { accessToken, user } = await c.iam.login('demo@acme.local');
c.setToken(accessToken);

await c.iam.createOrg('acme-2', 'ACME 2');
await c.iam.authorize(user.id, 'workflow:Execute', '*');
await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
```

Auth: `setToken(jwt)` (Bearer) or `setApiKey(key)` (`X-API-Key`).
Optional `timeoutMs` (default 15000) and `tenant` (platform callers of
Faststore/Queue, sent as `x-synapseone-tenant`; change with `setTenant()`).

## Redirects, timeouts and response limits

- Redirects are handled manually. Same-origin redirects (same scheme, host and
  port) are followed with credentials intact, up to `maxRedirects` (default 10).
- Cross-origin redirects are refused unless the target origin is listed in
  `trustedRedirectOrigins` (or `SYNAPSEONE_TRUSTED_REDIRECT_ORIGINS`, comma
  separated). A trusted cross-origin hop is followed **without**
  `Authorization`, `X-API-Key`, cookies or platform tenant headers. A redirect
  to any other origin is reported as `SynapseOneError` with
  `code: 'redirect_not_allowed'`; no request is sent to that origin.
- The timeout covers connection, headers **and body consumption**. A server
  that sends headers and then stalls the body still times out. `timeoutMs: 0`
  disables the timeout (not recommended).
- JSON/text bodies are capped at `maxJsonBytes` (default 8 MiB) and binary
  downloads at `maxBinaryBytes` (default 128 MiB, matching the OCS limit).
  Limits are enforced while streaming; an oversized body raises
  `code: 'response_too_large'` and is never silently truncated. Set either
  limit to `0` to disable it.
- The gateway itself does not redirect normal API routes. Edge HTTP→HTTPS
  redirects are cross-origin (scheme change): use the canonical HTTPS base URL,
  or explicitly trust the HTTPS origin knowing the redirected request is
  unauthenticated.
- Browser note: `fetch(..., {redirect: 'manual'})` exposes redirects as opaque
  responses. The SDK fails closed with `redirect_not_allowed` when it cannot
  inspect a redirect; use the canonical API origin in browsers. Node.js
  follows same-origin redirects normally.

## Services

The SDK is split per service, with matching subpath exports:

| Namespace | Service | Subpath |
| --- | --- | --- |
| `c.iam` | Synapse IAM | `@synapseone/sdk/iam` |
| `c.workflow` | Workflow | `@synapseone/sdk/workflow` |
| `c.ai` | AI Assistant | `@synapseone/sdk/ai` |
| `c.lds` | SynapseLDS | `@synapseone/sdk/lds` |
| `c.base` | SynapseBase | `@synapseone/sdk/base` |
| `c.faststore` | Synapse Faststore | `@synapseone/sdk/faststore` |
| `c.queue` | SynapseQueue | `@synapseone/sdk/queue` |
| `c.stream` | SynapseStream | `@synapseone/sdk/stream` |
| `c.storage` / `c.ocs` | SynapseOCS | `@synapseone/sdk/storage`, `@synapseone/sdk/ocs` |
| `c.notifications` | SynapseNotifications | `@synapseone/sdk/notifications` |
| `c.search` | Base search | `@synapseone/sdk/search` |
| `c.warehouse` | Synapse Warehouse | `@synapseone/sdk/warehouse` |
| `c.lakehouse` | Synapse Lakehouse | `@synapseone/sdk/lakehouse` |
| `c.inference` | Inference Engine | `@synapseone/sdk/inference` |
| `c.health` | Gateway health/readiness | `@synapseone/sdk/health` |

```ts
await c.base.createCollection({ name: 'parks', mapping: { name: 'profile.name' } });
await c.base.createDocument('parks', { id: 'park-1', object: { name: 'Central' } });

await c.faststore.set('cache:park:1', { name: 'Central' }, { ttlSeconds: 300 });
const lock = await c.faststore.lockAcquire('report', { ttlSeconds: 60 });
if (lock.acquired) await c.faststore.lockRelease('report', lock.token);

await c.queue.publish('emails', { to: 'alice@acme.test' }, { dedupeKey: 'welcome:alice' });
const batch = await c.queue.consume('emails', { maxMessages: 10 });
for (const msg of batch.messages) await c.queue.ack('emails', msg.receipt);
```

Legacy flat methods (`c.login(...)`, `c.listTemplates(...)`, ...) still work but
emit a `DeprecationWarning` pointing at the namespaced replacement.

## Sign-in with MFA

```ts
import { SynapseOneError } from '@synapseone/sdk';

try {
  await c.iam.loginWithPassword({ email, password, orgSlug: 'acme' });
} catch (e) {
  const body = e instanceof SynapseOneError ? (e.body as { error?: string; mfaToken?: string }) : undefined;
  if (body?.error !== 'mfa_required') throw e;
  const s = await c.iam.verifyMfa({ mfaToken: body.mfaToken!, code: '492039' });
  c.setToken(s.accessToken);
}
```

Enrol with `c.iam.setupTotp()` + `c.iam.enableTotp(code)`; also `mfaStatus`,
`regenerateRecoveryCodes`, `disableMfa`, and for org admins `resetUserMfa` /
`unlockUser`.

## Full documentation

See **[docs/sdk-js.md](../../docs/sdk-js.md)** for the language guide —
constructor, auth, method signatures, parameters, return types, and examples.
For copyable per-service examples in all four SDK languages, see
[`docs/services/`](../../docs/services/).
