// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bell, Boxes, Brain, Cloud, Database, FileCode2, Gauge, GitBranch, Inbox, Network, Radio, ShieldCheck, Zap } from 'lucide-react';
import DocsShell, { CodeBlock, DocHeader, DocTable, MethodBadge, slugify } from '../components/DocsShell.jsx';
import { useI18n } from '../lib/i18n-context.js';

// Sidebar order; `group` keys map to m.docsPage.groups.
const TABS = [
  { id: 'overview', group: 'start' },
  { id: 'iam', group: 'platform' },
  { id: 'workflow', group: 'platform' },
  { id: 'ai', group: 'platform' },
  { id: 'lds', group: 'data', label: 'SynapseLDS' },
  { id: 'base', group: 'data', label: 'SynapseBase' },
  { id: 'faststore', group: 'data', label: 'Faststore' },
  { id: 'queue', group: 'data', label: 'SynapseQueue' },
  { id: 'stream', group: 'data', label: 'SynapseStream' },
  { id: 'ocs', group: 'data', label: 'SynapseOCS' },
  { id: 'notifications', group: 'data', label: 'SynapseNotifications' },
  { id: 'javascript', group: 'clients', label: 'JavaScript' },
  { id: 'python', group: 'clients', label: 'Python' },
  { id: 'go', group: 'clients', label: 'Go' },
  { id: 'cli', group: 'clients', label: 'CLI' },
];

/** One documentation section; its title feeds the "On this page" list. */
function DocSection({ title, kicker, children }) {
  const id = slugify(title);
  return (
    <section className="border-t border-s1-line pt-10 first:border-t-0 first:pt-0">
      {kicker && <p className="font-mono text-xs text-s1-muted">{kicker}</p>}
      <h2 id={id} data-toc={title} className="mt-1 scroll-mt-24 text-xl font-semibold tracking-tight text-s1-fg">
        <a href={`#${id}`} className="group inline-flex items-center gap-2">
          {title}
          <span aria-hidden="true" className="text-s1-muted opacity-0 transition group-hover:opacity-100">#</span>
        </a>
      </h2>
      <div className="s1-prose mt-4 space-y-4 text-[15px] leading-7 text-s1-muted">{children}</div>
    </section>
  );
}

function DocCode({ data }) {
  return <CodeBlock code={data} />;
}

function Text({ children }) {
  return <p>{children}</p>;
}

function Bullets({ items }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-s1-accent">
      {items.map((item) => (
        <li key={typeof item === 'string' ? item : item.join(' ')}>{item}</li>
      ))}
    </ul>
  );
}

function EndpointTable({ rows, columns = ['Method', 'Endpoint', 'Purpose'] }) {
  return (
    <DocTable head={columns}>
      {rows.map(([method, path, desc]) => (
        <tr key={`${method}:${path}`} className="border-t border-s1-line align-top">
          <td className="whitespace-nowrap px-4 py-2.5">
            <MethodBadge method={method} />
          </td>
          <td className="min-w-[14rem] px-4 py-2.5">
            <code className="break-all font-mono text-xs text-s1-fg">{path}</code>
          </td>
          <td className="px-4 py-2.5 text-xs">{desc}</td>
        </tr>
      ))}
    </DocTable>
  );
}

function OperatorTable({ rows }) {
  return (
    <DocTable head={['Operator', 'Meaning']}>
      {rows.map(([op, meaning]) => (
        <tr key={op} className="border-t border-s1-line">
          <td className="px-4 py-2.5">
            <code className="font-mono text-xs text-s1-fg">{op}</code>
          </td>
          <td className="px-4 py-2.5 text-xs">{meaning}</td>
        </tr>
      ))}
    </DocTable>
  );
}

const OVERVIEW_RUN = `# From the repository root
cp .env.example .env
# Replace every *_change_me_* secret in .env, then:
docker compose up -d --build
docker compose ps

# Gateway health + aggregate readiness (iam, workflow, ai, lds, base, faststore,
# queue, stream, inference, ocs, notifications)
curl http://localhost:8080/health
curl http://localhost:8080/ready

# Individual services
curl http://localhost:4001/health   # IAM
curl http://localhost:4002/health   # Workflow
curl http://localhost:4003/health   # AI assistant
curl http://localhost:4004/health   # SynapseLDS
curl http://localhost:4005/health   # SynapseBase
curl http://localhost:4006/health   # Faststore
curl http://localhost:4007/health   # SynapseQueue
curl http://localhost:4008/health   # Inference
curl http://localhost:4009/health   # SynapseStream
curl http://localhost:4010/health   # SynapseOCS
curl http://localhost:4011/health   # SynapseNotifications`;

const OVERVIEW_FLOW = `# 1. Sign in (dev login; use SSO/API keys in production)
TOKEN=$(curl -s -XPOST http://localhost:8080/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

# 2. SynapseBase: create a mapped collection and write a logical object
curl -s -XPOST http://localhost:8080/v1/base/collections \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"parks","mapping":{"name":"profile.name","capacity":"profile.capacity"}}'
curl -s -XPOST http://localhost:8080/v1/base/collections/parks/documents \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'

# 3. Faststore: cache a value and bump a counter
curl -s -XPUT http://localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'
curl -s -XPOST http://localhost:8080/v1/faststore/keys/visits/incr \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"by":1}'

# 4. SynapseQueue: publish a message
curl -s -XPOST http://localhost:8080/v1/queue/queues/emails/messages \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"to":"alice@acme.test"},"dedupeKey":"welcome:alice"}'

# 5. SynapseLDS: publish a licensed NGSI-LD record
DS=$(curl -s -XPOST http://localhost:8080/v1/lds/datasources \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"Business Registry","entityType":"Organization","license":"CC-BY-4.0"}' | jq -r .id)
curl -s -XPOST http://localhost:8080/v1/lds/datasources/$DS/records \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"55001","name":"ABC"}'

# 6. SynapseStream: create a topic and publish an event
curl -s -XPUT http://localhost:8080/v1/stream/topics/telemetry \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"maxLen":100000}'
curl -s -XPOST http://localhost:8080/v1/stream/topics/telemetry/events \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"sensor":"temp-1","value":25.4},"key":"sensor-1"}'

# 7. SynapseOCS: create a bucket and upload an object
curl -s -XPOST http://localhost:8080/v1/ocs/buckets \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"city-assets"}'
curl -s -XPUT http://localhost:8080/v1/ocs/buckets/city-assets/objects/hello.txt \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' --data-binary 'hello'

# 8. SynapseNotifications: queue an email
curl -s -XPOST http://localhost:8080/v1/notifications \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"channel":"email","recipient":{"email":"alice@acme.test"},"subject":"Welcome","body":"Hi {{name}}","data":{"name":"Alice"}}'`;

const BASE_MAPPING = `{
  "fields": {
    "name":     { "path": "profile.name",     "type": "string",  "required": true },
    "capacity": { "path": "profile.capacity", "type": "number" },
    "tags":     { "path": "profile.tags",     "type": "array" }
  },
  "additional": false
}

// Shorthand accepted everywhere (no type/required metadata):
{ "name": "profile.name", "capacity": "profile.capacity" }`;

const BASE_QUICKSTART = `# Create the collection and its mapping
curl -s -XPOST localhost:8080/v1/base/collections \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "name": "parks",
    "mapping": {
      "name": { "path": "profile.name", "type": "string", "required": true },
      "capacity": { "path": "profile.capacity", "type": "number" }
    }
  }'

# Write object -> the service stores { "profile": { "name": ..., "capacity": ... } }
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'

# Read object <- data
curl -s "localhost:8080/v1/base/collections/parks/documents/park-1?as=object" \\
  -H "Authorization: Bearer $TOKEN"`;

const BASE_QUERY = `curl -s -XPOST localhost:8080/v1/base/collections/parks/query \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "where": {
      "or": [
        { "field": "capacity", "op": "gte", "value": 100 },
        { "and": [
          { "field": "profile.tags", "op": "contains", "value": "family" },
          { "field": "$updatedAt", "op": "gt", "value": "2026-10-01T00:00:00Z" }
        ] }
      ]
    },
    "orderBy": [{ "field": "name", "direction": "asc" }],
    "limit": 20,
    "select": ["name", "capacity"],
    "as": "object"
  }'`;

const BASE_WRITES = `# Full replace with optimistic concurrency (If-Match also works)
curl -s -XPUT localhost:8080/v1/base/collections/parks/documents/park-1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"object":{"name":"Central Park","capacity":150},"ifVersion":2}'

# Partial merge + dot-path removals
curl -s -XPATCH localhost:8080/v1/base/collections/parks/documents/park-1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"object":{"capacity":160},"unset":["profile.obsolete"],"ifVersion":3}'

# Atomic counter; field is a raw dot path. Missing doc is created at version 1.
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents/park-1/increment \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"field":"profile.capacity","by":10,"ifVersion":4}'

# Batch (1..100 ordered ops; ifVersion is honored only by delete)
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents:batch \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"operations":[
    {"op":"create","id":"park-2","object":{"name":"Riverside"}},
    {"op":"increment","id":"park-1","field":"profile.capacity","by":5},
    {"op":"delete","id":"park-3","ifVersion":4}
  ]}'`;

const BASE_SEARCH_ENDPOINTS = [
  ['POST', '/v1/search', 'Full-text, semantic or hybrid search across collections'],
  ['GET', '/v1/search?q=…', 'Convenience query form for the same search'],
  ['POST', '/v1/search/reindex', 'Idempotently rebuild the tenant-visible index'],
  ['GET', '/v1/search/status', 'Indexed documents, collection count and freshness'],
];

const BASE_SEARCH = `curl -s -XPOST http://localhost:8080/v1/search \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "query": "central park",
    "mode": "hybrid",
    "collections": ["parks"],
    "filters": { "capacity": { "gte": 100 } },
    "limit": 10
  }'

# Results include score, highlighted snippets, ACL metadata, facets and nextCursor.
# Semantic mode uses deterministic local embeddings; hybrid blends both scores.`;

const BASE_LIMITS = `BASE_MAX_DOCUMENT_BYTES=262144   # default 256 KiB, clamped 1 KiB..4 MiB
BASE_QUERY_SCAN_LIMIT=10000       # default 10k, clamped 100..100k
# nesting depth 32 | arrays 10,000 | filters 50 | filter nesting 8
# orderBy 3 | query limit 1..1000 | select 100 | batch 100 | changes limit 1..1000`;

const FASTSTORE_QUICKSTART = `# String with TTL (0 clears TTL; 1..2592000 seconds)
curl -s -XPUT localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'

curl -s localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN"

# Atomic counter
curl -s -XPOST localhost:8080/v1/faststore/keys/visits/incr \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"by":1}'

# Hash, list, set and sorted set
curl -s -XPUT localhost:8080/v1/faststore/hashes/user:42 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"values":{"name":"Alice","plan":"pro"},"ttlSeconds":600}'
curl -s -XPOST localhost:8080/v1/faststore/lists/events/push \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"values":["login","checkout"],"side":"right"}'
curl -s -XPOST localhost:8080/v1/faststore/sets/roles/add \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"members":["admin","editor"]}'
curl -s -XPOST localhost:8080/v1/faststore/zsets/leaderboard/add \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"members":[{"member":"alice","score":100}]}'`;

const FASTSTORE_LOCK = `# Acquire with a 60s lease, waiting up to 5s; unique token per acquisition
curl -s -XPOST localhost:8080/v1/faststore/locks/cron:nightly/acquire \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"ttlSeconds":60,"waitMs":5000}'

# -> {"acquired":true,"token":"...","expiresAt":"..."}
# Only the owner may release/extend; acquire failure is HTTP 200 {acquired:false}

curl -s -XPOST localhost:8080/v1/faststore/locks/cron:nightly/release \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"token":"<token>"}'`;

const FASTSTORE_LIMITS = `# Keys 1..512 chars, no "/" or "\\".
# TTL 1..2592000s; 0 clears an existing TTL; reads return ttlSeconds:null when none.
# Scan limit 1..500 | batch <=100 operations
# Hash <=500 fields | list/set/sorted-set <=1000 members
# Batch operations: set, get, delete, incr, expire
# Read /ttl returns -1 when the key has no expiry and 404 when it does not exist.`;

const QUEUE_QUICKSTART = `# Optional: tune retries / lease default (idempotent create-or-update)
curl -s -XPUT localhost:8080/v1/queue/queues/emails \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxAttempts":5,"visibilityTimeoutSeconds":30}'

# Publish (201); a duplicate dedupeKey returns the original message with 200
curl -s -XPOST localhost:8080/v1/queue/queues/emails/messages \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"to":"alice@acme.test"},"dedupeKey":"welcome:alice"}'

# Consume a lease (attempts increments on every consume)
curl -s -XPOST localhost:8080/v1/queue/queues/emails/consume \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxMessages":10,"visibilityTimeoutSeconds":30,"consumer":"mailer-1"}'

# Ack with the returned receipt (or send {"receipts":[...]} for a batch)
curl -s -XPOST localhost:8080/v1/queue/queues/emails/ack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>"}'`;

const QUEUE_RETRY = `# Requeue for a later attempt
curl -s -XPOST localhost:8080/v1/queue/queues/emails/nack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","requeue":true,"delaySeconds":60,"error":"smtp timeout"}'

# Dead-letter immediately (requeue:false), or automatically at attempts >= maxAttempts
curl -s -XPOST localhost:8080/v1/queue/queues/emails/nack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","requeue":false,"error":"invalid address"}'

# Extend a long-running lease
curl -s -XPOST localhost:8080/v1/queue/queues/emails/heartbeat \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","visibilityTimeoutSeconds":120}'

# Inspect and replay dead letters
curl -s "localhost:8080/v1/queue/queues/emails/dead?limit=50" \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST localhost:8080/v1/queue/queues/emails/dead/<id>/replay \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"delaySeconds":0,"resetAttempts":true}'`;

const QUEUE_SEMANTICS = `# Delivery contract
# - at-least-once: consume leases a message; ack deletes it.
# - visibility timeout expiry returns the message to pending regardless of attempts.
# - nack requeues or dead-letters (requeue:false / attempts >= maxAttempts).
# - attempts increments on EVERY consume, including redeliveries.
# - dedupe suppresses duplicates only while the original message still exists.
# - purge clears ready + delayed + in-flight + dead messages and counters,
#   but keeps the queue configuration.
# - consume/ack/publish batch <=100 | payload <= QUEUE_MAX_PAYLOAD_BYTES (256 KiB)
# - delay <=7 days | maxAttempts 1..100 (default 5) | visibility 1..3600s (default 30)`;

const JS_QUICKSTART = `import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient({ baseUrl: 'http://localhost:8080' });

const { accessToken } = await c.iam.login('demo@acme.local', 'acme');
c.setToken(accessToken);

// One client, one namespace per service:
await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
await c.base.createCollection({ name: 'parks', mapping: { name: 'profile.name' } });
await c.faststore.set('cache:demo', { ok: true }, { ttlSeconds: 300 });
await c.queue.publish('emails', { to: 'demo@acme.local' });

// Legacy flat methods still work, but emit a DeprecationWarning:
//   c.listOrgs() -> c.iam.listOrgs()`;

const JS_AUTH = `const c = new SynapseOneClient({
  baseUrl: 'http://localhost:8080',
  token: jwt,                 // Bearer JWT
  apiKey: key,                // or X-API-Key (use one auth mode)
  tenant: 'org:acme',         // x-synapseone-tenant (platform callers)
  timeoutMs: 15000,
});

c.setToken(jwt);
c.setApiKey(key);
c.setTenant('org:acme');      // pass undefined to clear

const me = await c.iam.me();
const verified = await c.iam.verify();
const { refreshToken } = await c.iam.login('demo@acme.local', 'acme');
await c.iam.refresh(refreshToken);
await c.iam.logout(refreshToken);`;

const JS_IAM = `const org = await c.iam.createOrg('acme', 'ACME Corp');
const account = await c.iam.createAccount(org.id, 'prod', 'Production');
const user = await c.iam.createUser(org.id, 'alice@acme.local', 'Alice');

const role = await c.iam.createRole(account.id, 'runner', 'Workflow runner');
const policy = await c.iam.createPolicy(account.id, 'exec', {
  Version: '2026-01-01',
  Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*' }],
});
await c.iam.attachPolicy(role.id, policy.id);
await c.iam.assignRole(user.id, role.id);

const { allowed } = await c.iam.authorize(user.id, 'workflow:Execute', '*');
const key = await c.iam.createApiKey(account.id, 'ci', ['workflow:Execute']);
const accounts = await c.iam.listAccounts(org.id);
const audit = await c.iam.listAudit(20);`;

const JS_WORKFLOWS = `const templates = await c.workflow.listTemplates();
const wf = await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
await c.workflow.activateWorkflow(wf.id);

const run = await c.workflow.executeWorkflow(wf.id, { value: 21 });
const test = await c.workflow.testRun(definition, { value: 21 });
const executions = await c.workflow.listExecutions({ limit: 10 });
const detail = await c.workflow.getExecution(run.executionId, true);

await c.workflow.updateWorkflow(wf.id, { name: 'renamed' });
await c.workflow.deactivateWorkflow(wf.id);`;

const JS_LDS = `const licenses = await c.lds.licenses();
const ds = await c.lds.createDatasource({
  name: 'Business Registry',
  entityType: 'Organization',
  license: 'CC-BY-4.0',
});
await c.lds.setAttributes(ds.id, [
  { name: 'name', ngsiLdType: 'Property', visibility: 'public' },
]);
const result = await c.lds.ingest(ds.id, [{ id: '55001', name: 'ABC' }]);
const entities = await c.lds.entities(ds.id, { visibility: 'public' });
const stats = await c.lds.stats(ds.id);`;

const JS_BASE = `// Dynamic API (raw objects / data)
const doc = await c.base.createDocument('parks', {
  id: 'park-1',
  object: { name: 'Central', capacity: 120 },
});
const page = await c.base.queryDocuments('parks', {
  where: { capacity: { gte: 100 } },
  orderBy: [{ field: 'name', direction: 'asc' }],
  as: 'object',
});

// Typed collection: model keys must equal logical mapping names
const parks = c.base.collection('parks', {
  mapping: { name: 'profile.name', capacity: 'profile.capacity' },
});
await parks.create({ name: 'Riverside', capacity: 80 }, { id: 'park-2' });
const park = await parks.get('park-1');
await parks.update('park-1', { capacity: 200 }, { ifVersion: doc.version });
await parks.increment('park-1', { field: 'profile.capacity', by: 10 });
const changes = await parks.changes({ since: '2026-10-01T00:00:00Z' });`;

const JS_FASTSTORE = `await c.faststore.set('session:42', { userId: 42 }, { ttlSeconds: 900 });
const item = await c.faststore.get('session:42');   // { key, type, value, ttlSeconds }
await c.faststore.incr('visits', { by: 1 });
await c.faststore.expire('visits', 3600);

await c.faststore.hashSet('user:42', { name: 'Alice' }, { ttlSeconds: 600 });
await c.faststore.listPush('events', ['login'], { side: 'right' });
await c.faststore.setAdd('roles', ['admin', 'editor']);
await c.faststore.zsetAdd('leaderboard', [{ member: 'alice', score: 100 }]);

const lock = await c.faststore.lockAcquire('cron:nightly', { ttlSeconds: 60, waitMs: 5000 });
if (lock.acquired) {
  try {
    // critical section
  } finally {
    await c.faststore.lockRelease('cron:nightly', lock.token);
  }
}`;

const JS_QUEUE = `await c.queue.createQueue('emails', { maxAttempts: 5, visibilityTimeoutSeconds: 30 });
const message = await c.queue.publish('emails', { to: 'alice@acme.test' }, {
  dedupeKey: 'welcome:alice',
});

const { messages } = await c.queue.consume('emails', {
  maxMessages: 10,
  visibilityTimeoutSeconds: 30,
  consumer: 'mailer-1',
});
for (const m of messages) {
  try {
    await handle(m.payload);                        // your processor
    await c.queue.ack('emails', m.receipt);
  } catch (e) {
    await c.queue.nack('emails', m.receipt, { error: String(e) });
  }
}

const dead = await c.queue.deadLetters('emails', { limit: 50 });
await c.queue.replayDead('emails', dead.messages[0].id, { resetAttempts: true });`;

const JS_EXTRA = `// SynapseStream
await c.stream.createTopic('telemetry', { maxLen: 100000, retentionMs: 86400000 });
await c.stream.publish('telemetry', { sensor: 'temp-1', value: 25.4 }, { key: 'sensor-1' });
await c.stream.createGroup('telemetry', 'analytics', { startId: '$' });
const { events } = await c.stream.readGroup('telemetry', 'analytics', { consumer: 'worker-1', count: 10 });
await c.stream.ack('telemetry', 'analytics', events.map((e) => e.id));

// SynapseOCS
await c.ocs.createBucket('city-assets', { quotaBytes: 1024 ** 3 });
await c.ocs.putObject('city-assets', 'docs/a.txt', 'hello', { contentType: 'text/plain' });
const list = await c.ocs.listObjects('city-assets', { prefix: 'docs/' });
const { url } = await c.ocs.presign('city-assets', 'docs/a.txt', { method: 'GET', expiresIn: 900 });

// SynapseNotifications
await c.notifications.send({
  channels: ['email'],
  recipient: { email: 'ops@example.com' },
  subject: 'Flood alert in {{city}}',
  body: 'Level {{level}}m',
  data: { city: 'Hanoi', level: 2.5 },
  idempotencyKey: 'alert:s1',
});

// AI assistant and inference
const draft = await c.ai.agent('How do I create a Base collection?');
const chat = await c.inference.chat([{ role: 'user', content: 'Hello' }]);
const embeddings = await c.inference.embeddings('flood alert');
const route = await c.inference.route('water rising at S1', {
  ops: 'dispatch a field crew',
  alert: 'notify residents',
});`;

const JS_ERRORS = `import { SynapseOneError } from '@synapseone/sdk';

try {
  await c.base.getDocument('parks', 'missing');
} catch (e) {
  if (e instanceof SynapseOneError) {
    console.error(e.status, e.body);   // status is undefined for network errors
  }
}

// c.call(method, path, body) is the forward-compat escape hatch.
await c.call('GET', '/v1/base/collections');`;

const PYTHON_QUICKSTART = `from synapseone_sdk import SynapseOneClient

c = SynapseOneClient("http://localhost:8080")
login = c.iam.login("demo@acme.local", "acme")
c.set_token(login["accessToken"])

c.workflow.create_workflow_from_template("webhook-to-log", "demo")
c.base.create_collection("parks", mapping={"name": "profile.name"})
c.faststore.set("cache:demo", {"ok": True}, ttl_seconds=300)
c.queue.publish("emails", {"to": "demo@acme.local"})

# Legacy flat methods still work but emit DeprecationWarning:
#   c.list_orgs() -> c.iam.list_orgs()`;

const PYTHON_AUTH = `c = SynapseOneClient(
    "http://localhost:8080",
    token=jwt,                 # Bearer JWT
    api_key=key,               # or X-API-Key (use one auth mode)
    tenant="org:acme",         # x-synapseone-tenant (platform callers)
    timeout=15,
)
c.set_token(jwt)
c.set_api_key(key)
c.tenant = "org:acme"          # None clears it

me = c.iam.me()
verified = c.iam.verify()
login = c.iam.login("demo@acme.local", "acme")
c.iam.refresh(login["refreshToken"])
c.iam.logout(login["refreshToken"])`;

const PYTHON_IAM = `org = c.iam.create_org("acme", "ACME Corp")
account = c.iam.create_account(org["id"], "prod", "Production")
user = c.iam.create_user(org["id"], "alice@acme.local", "Alice")

role = c.iam.create_role(account["id"], "runner", "Workflow runner")
policy = c.iam.create_policy(account["id"], "exec", {
    "Version": "2026-01-01",
    "Statement": [{"Effect": "Allow", "Action": ["workflow:Execute"], "Resource": "*"}],
})
c.iam.attach_policy(role["id"], policy["id"])
c.iam.assign_role(user["id"], role["id"])

allowed = c.iam.authorize(user["id"], "workflow:Execute", "*")["allowed"]
key = c.iam.create_api_key(account["id"], "ci", ["workflow:Execute"])
audit = c.iam.list_audit(20)`;

const PYTHON_WORKFLOWS = `templates = c.workflow.list_templates()
wf = c.workflow.create_workflow_from_template("webhook-to-log", "demo")
c.workflow.activate_workflow(wf["id"])

run = c.workflow.execute_workflow(wf["id"], {"value": 21})
test = c.workflow.test_run(definition, {"value": 21})
executions = c.workflow.list_executions({"limit": 10})
detail = c.workflow.get_execution(run["executionId"], include_data=True)

c.workflow.update_workflow(wf["id"], name="renamed")
c.workflow.deactivate_workflow(wf["id"])`;

const PYTHON_LDS = `licenses = c.lds.list_licenses()
ds = c.lds.create_datasource(
    name="Business Registry",
    entity_type="Organization",
    license="CC-BY-4.0",
)
c.lds.set_datasource_attributes(ds["id"], [
    {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
])
result = c.lds.ingest_records(ds["id"], [{"id": "55001", "name": "ABC"}])
entities = c.lds.list_entities(ds["id"], visibility="public")
stats = c.lds.get_datasource_stats(ds["id"])`;

const PYTHON_BASE = `# Dynamic API
doc = c.base.create_document("parks", object={"name": "Central", "capacity": 120}, id="park-1")
page = c.base.query_documents(
    "parks",
    {"capacity": {"gte": 100}},
    order_by=[{"field": "name", "direction": "asc"}],
    as_view="object",
)
print(page.total, page.next_cursor)

# Typed collection: dataclass attribute names == logical mapping names
from dataclasses import dataclass

@dataclass
class Park:
    name: str
    capacity: int | None = None

parks = c.base.collection("parks", model=Park, mapping={"name": "profile.name", "capacity": "profile.capacity"})
parks.create(Park("Riverside", 80), id="park-2")
park = parks.get("park-1")
parks.update("park-1", Park("Central Park", 200), if_version=doc["version"])
parks.increment("park-1", "profile.capacity", by=10)
changes = parks.changes("2026-10-01T00:00:00Z")`;

const PYTHON_FASTSTORE = `c.faststore.set("session:42", {"userId": 42}, ttl_seconds=900)
item = c.faststore.get("session:42")
c.faststore.incr("visits", by=1)
c.faststore.expire("visits", 3600)

c.faststore.hash_set("user:42", {"name": "Alice"}, ttl_seconds=600)
c.faststore.list_push("events", ["login"], side="right")
c.faststore.set_add("roles", ["admin", "editor"])
c.faststore.zset_add("leaderboard", [{"member": "alice", "score": 100}])

lock = c.faststore.lock_acquire("cron:nightly", ttl_seconds=60, wait_ms=5000)
if lock["acquired"]:
    try:
        pass  # critical section
    finally:
        c.faststore.lock_release("cron:nightly", lock["token"])`;

const PYTHON_QUEUE = `c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=30)
message = c.queue.publish("emails", {"to": "alice@acme.test"}, dedupe_key="welcome:alice")

result = c.queue.consume("emails", max_messages=10, consumer="mailer-1")
for m in result["messages"]:
    try:
        handle(m["payload"])                       # your processor
        c.queue.ack("emails", m["receipt"])
    except Exception as exc:
        c.queue.nack("emails", m["receipt"], error=str(exc))

dead = c.queue.dead_letters("emails", limit=50)
c.queue.replay_dead("emails", dead["messages"][0]["id"], reset_attempts=True)`;

const PYTHON_EXTRA = `# SynapseStream
c.stream.create_topic("telemetry", max_len=100000, retention_ms=86400000)
c.stream.publish("telemetry", {"sensor": "temp-1", "value": 25.4}, key="sensor-1")
c.stream.create_group("telemetry", "analytics", start_id="$")
result = c.stream.read_group("telemetry", "analytics", consumer="worker-1", count=10)
c.stream.ack("telemetry", "analytics", [e["id"] for e in result["events"]])

# SynapseOCS
c.ocs.create_bucket("city-assets", quota_bytes=1024 ** 3)
c.ocs.put_object("city-assets", "docs/a.txt", b"hello", content_type="text/plain")
listing = c.ocs.list_objects("city-assets", prefix="docs/")
url = c.ocs.presign("city-assets", "docs/a.txt", method="GET", expires_in=900)["url"]

# SynapseNotifications
c.notifications.send(
    recipient={"email": "ops@example.com"},
    channels=["email"],
    subject="Flood alert in {{city}}",
    body="Level {{level}}m",
    data={"city": "Hanoi", "level": 2.5},
    idempotency_key="alert:s1",
)

# AI assistant and inference
draft = c.ai.agent("How do I create a Base collection?")
chat = c.inference.chat([{"role": "user", "content": "Hello"}])
embeddings = c.inference.embeddings("flood alert")
route = c.inference.route("water rising at S1", {"ops": "dispatch", "alert": "notify"})`;

const PYTHON_ERRORS = `from synapseone_sdk import SynapseOneError

try:
    c.base.get_document("parks", "missing")
except SynapseOneError as e:
    print(e.status, e.body)   # status is None for network errors

# Forward-compat escape hatch:
c.call("GET", "/v1/base/collections")`;

const GO_QUICKSTART = `import synapseone "github.com/synapseone/synapseone-sdk-go"

c := synapseone.New("http://localhost:8080")

login, err := c.Login("demo@acme.local", "acme")
if err != nil { log.Fatal(err) }
c.SetToken(login["accessToken"].(string))

_, err = c.ListOrgs()
_, err = c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
_, err = c.CreateBaseCollection(map[string]any{"name": "parks"})
_, err = c.FaststoreSet("cache:demo", map[string]any{"ok": true},
    synapseone.FaststoreSetOptions{TTLSeconds: 300})
_, err = c.PublishMessage("emails", map[string]any{"to": "demo@acme.local"},
    synapseone.QueuePublishOptions{})
if err != nil { log.Fatal(err) }`;

const GO_AUTH = `c := synapseone.New("http://localhost:8080")
c.SetToken(jwt)        // Bearer JWT
c.SetAPIKey(key)       // or X-API-Key (use one auth mode)
c.SetTenant("org:acme") // x-synapseone-tenant (platform callers; "" clears)

login, err := c.Login("demo@acme.local", "acme")
refreshed, err := c.Refresh(login["refreshToken"].(string))
_, err = c.LogoutAll(refreshed["refreshToken"].(string))
_, err = c.Me()
_, err = c.Verify()
if err != nil { log.Fatal(err) }`;

const GO_IAM = `org, err := c.CreateOrg("acme", "ACME Corp")
acct, err := c.CreateAccount(org["id"].(string), "prod", "Production")
user, err := c.CreateUser(org["id"].(string), "alice@acme.local", "Alice")

role, err := c.CreateRole(acct["id"].(string), "runner", "Workflow runner")
policy, err := c.CreatePolicy(acct["id"].(string), "exec", map[string]any{
    "Version": "2026-01-01",
    "Statement": []any{
        map[string]any{"Effect": "Allow", "Action": []string{"workflow:Execute"}, "Resource": "*"},
    },
}, "")
err = c.AttachPolicy(role["id"].(string), policy["id"].(string))
err = c.AssignRole(user["id"].(string), role["id"].(string))

result, err := c.Authorize(user["id"].(string), "workflow:Execute", "*", nil)
fmt.Println(result["allowed"])
_, err = c.ListAPIKeys(acct["id"].(string))
_, err = c.ListAudit(20, "")
if err != nil { log.Fatal(err) }`;

const GO_WORKFLOWS = `_, err := c.ListTemplates()
wf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
err = c.ActivateWorkflow(wf["id"].(string))

run, err := c.ExecuteWorkflow(wf["id"].(string), map[string]any{"value": 21})
_, err = c.TestRun(definition, map[string]any{"value": 21}, "")
_, err = c.ListExecutions("limit=10")
_, err = c.GetExecutionWithData(run["executionId"].(string), true)

_, err = c.UpdateWorkflow(wf["id"].(string), map[string]any{"name": "renamed"})
err = c.DeactivateWorkflow(wf["id"].(string))
if err != nil { log.Fatal(err) }`;

const GO_LDS = `_, err := c.ListLDSLicenses()
ds, err := c.CreateLDSDatasource(map[string]any{
    "name": "Business Registry", "entityType": "Organization", "license": "CC-BY-4.0",
})
_, err = c.SetLDSAttributes(ds["id"].(string), []any{
    map[string]any{"name": "name", "ngsiLdType": "Property", "visibility": "public"},
})
_, err = c.IngestLDSRecords(ds["id"].(string), []any{map[string]any{"id": "55001", "name": "ABC"}})
_, err = c.ListLDSEntities(ds["id"].(string),
    map[string]string{"visibility": "public", "limit": "100"})
_, err = c.GetLDSStats(ds["id"].(string))
if err != nil { log.Fatal(err) }`;

const GO_BASE = `type Park struct {
    Name     string \`json:"name"\`
    Capacity int    \`json:"capacity"\`
}

mapping := synapseone.NewBaseMapping(map[string]string{
    "name": "profile.name", "capacity": "profile.capacity",
})
parks := synapseone.NewBaseCollection[Park](c, "parks", mapping)

park, err := parks.Create(Park{Name: "Central", Capacity: 120}, "park-1")
page, err := parks.Query(synapseone.BaseQuery{
    Where:   map[string]any{"capacity": map[string]any{"gte": 100}},
    OrderBy: []synapseone.BaseOrderBy{{Field: "name", Direction: "asc"}},
    Limit:   20,
})
park, err = parks.Set("park-1", Park{Name: "Central Park", Capacity: 200}, 1, false)
park, err = parks.Increment("park-1", "profile.capacity", 10, 0)
changes, err := parks.Changes("2026-10-01T00:00:00Z", 100)
fmt.Println(park.Name, page.Total, changes["nextSince"])
if err != nil { log.Fatal(err) }`;

const GO_FASTSTORE = `_, err := c.FaststoreSet("session:42", map[string]any{"userId": 42},
    synapseone.FaststoreSetOptions{TTLSeconds: 900})
item, err := c.FaststoreGet("session:42")
fmt.Println(item["value"])
_, err = c.FaststoreIncr("visits", 1, 0)
_, err = c.FaststoreExpire("visits", 3600)

_, err = c.FaststoreHashSet("user:42", map[string]any{"name": "Alice"}, 600)
_, err = c.FaststoreListPush("events", []any{"login"},
    synapseone.FaststoreListPushOptions{Side: "right"})
_, err = c.FaststoreSetAdd("roles", []any{"admin", "editor"}, 0)
_, err = c.FaststoreZSetAdd("leaderboard",
    []synapseone.FaststoreZSetMember{{Member: "alice", Score: 100}}, 0)

lock, err := c.FaststoreLockAcquire("cron:nightly",
    synapseone.FaststoreLockOptions{TTLSeconds: 60, WaitMS: 5000})
if acquired, _ := lock["acquired"].(bool); acquired {
    defer c.FaststoreLockRelease("cron:nightly", lock["token"].(string))
    // critical section
}
if err != nil { log.Fatal(err) }`;

const GO_QUEUE = `_, err := c.CreateQueue("emails", synapseone.QueueConfig{
    MaxAttempts: 5, VisibilityTimeoutSeconds: 30,
})
msg, err := c.PublishMessage("emails", map[string]any{"to": "alice@acme.test"},
    synapseone.QueuePublishOptions{DedupeKey: "welcome:alice"})
fmt.Println(msg["id"])

out, err := c.ConsumeMessages("emails", synapseone.QueueConsumeOptions{
    MaxMessages: 10, VisibilityTimeoutSeconds: 30, Consumer: "mailer-1",
})
// handle is your message processor: func handle(payload any) error
for _, raw := range out["messages"].([]any) {
    m := raw.(map[string]any)
    if err := handle(m["payload"]); err != nil {
        _, _ = c.NackMessage("emails", m["receipt"].(string),
            synapseone.QueueNackOptions{Error: err.Error()})
        continue
    }
    _, _ = c.AckMessage("emails", m["receipt"].(string))
}

dead, err := c.DeadMessages("emails", 50)
first := dead["messages"].([]any)[0].(map[string]any)
_, err = c.ReplayDeadMessage("emails", first["id"].(string), 0, true)
if err != nil { log.Fatal(err) }`;

const GO_EXTRA = `// SynapseStream
_, err = c.CreateStreamTopic("telemetry", 100000, "", 86400000)
_, err = c.PublishStreamEvent("telemetry", map[string]any{"sensor": "temp-1"},
    synapseone.StreamPublishOptions{Key: "sensor-1"})
_, err = c.CreateStreamGroup("telemetry", "analytics", "$")
out, err := c.ReadStreamGroup("telemetry", "analytics",
    synapseone.StreamGroupReadOptions{Consumer: "worker-1", Count: 10})
var ids []string
for _, raw := range out["events"].([]any) {
    ids = append(ids, raw.(map[string]any)["id"].(string))
}
_, err = c.AckStreamEvents("telemetry", "analytics", ids)

// SynapseOCS
_, err = c.CreateOcsBucket("city-assets", 1<<30)
_, err = c.PutOcsObject("city-assets", "docs/a.txt", []byte("hello"), "text/plain", "")
listing, err := c.ListOcsObjects("city-assets", "docs/", "", 100, "")
signed, err := c.PresignOcs("city-assets", "docs/a.txt", "GET", 900)

// SynapseNotifications
_, err = c.SendNotification(synapseone.SendNotificationInput{
    Channels:  []string{"email"},
    Recipient: synapseone.NotificationRecipient{Email: "ops@example.com"},
    Subject:   "Flood alert in {{city}}",
    Body:      "Level {{level}}m",
    Data:      map[string]any{"city": "Hanoi", "level": 2.5},
    IdempotencyKey: "alert:s1",
})

// AI assistant and inference
draft, err := c.AIAgent("How do I create a Base collection?")
chat, err := c.InferenceChat([]synapseone.ChatMessage{{Role: "user", Content: "Hello"}})
embeddings, err := c.InferenceEmbeddings("flood alert")
route, err := c.InferenceRoute("water rising at S1",
    map[string]string{"ops": "dispatch", "alert": "notify"})
if err != nil { log.Fatal(err) }`;

const GO_ERRORS = `// Every call returns (result, error). HTTP failures carry status + body text.
result, err := c.GetBaseDocument("parks", "missing", "object")
if err != nil {
    log.Printf("base call failed: %v", err)
}

// Forward-compat escape hatch:
result, err = c.Call("GET", "/v1/base/collections", nil)
fmt.Println(result)`;

const CLI_INSTALL = `# one-line installer (recommended)
curl -fsSL https://synapseone.space/install.sh | sh

# the Docker Console serves the same installer locally
curl -fsSL http://localhost:3000/install.sh | sh

# npm registry
npm install -g @synapseone/cli@latest

# run without installing
npx -y @synapseone/cli@latest --help

# from source
node tools/cli/bin/synapseone.js --help`;

const CLI_CONFIG = `# Base URL resolution (first match wins):
#   --base <URL> > $SYNAPSEONE_BASE_URL > ~/.synapseone/config.json > http://localhost:8080
#
# Auth resolution (first match wins):
#   --token/--apikey > $SYNAPSEONE_TOKEN/$SYNAPSEONE_API_KEY > config file
#
# Global flags:
#   --base URL   --token T   --apikey K   --json
#   --context k=v (repeatable)   --file path
#   --limit N   --actor ID   --name N   --template T
#   --email E   --org SLUG   --label L`;

const CLI_AUTH = `synapseone login --email demo@acme.local [--org acme]
synapseone refresh [refresh-token]
synapseone logout-all [refresh-token]
synapseone logout
synapseone verify
synapseone use-key <api-key>
synapseone whoami
synapseone config`;

const CLI_IAM = `synapseone orgs
synapseone orgs create <slug> [name]
synapseone accounts [org]
synapseone accounts create [org] <slug> [name]
synapseone users [org]
synapseone users create <org> <email> [name]

synapseone roles <account>
synapseone roles create <account> <slug>
synapseone policies <account>
synapseone policies create <account> <slug> --file policy.json
synapseone attach <role-id> <policy-id>
synapseone detach <role-id> <policy-id>
synapseone assign <user-id> <role-id>
synapseone unassign <user-id> <role-id>
synapseone roles delete <id>
synapseone policies delete <id>
synapseone authz <user-id> <action> <resource> [--context k=v]
synapseone sim --file policy.json <action> <resource> [--context k=v]
synapseone audit [--limit N] [--actor ID]`;

const CLI_ACCESS = `synapseone keys create <account> [--name N]
synapseone keys list <account>
synapseone keys revoke <key-id>
synapseone keys verify <api-key>

synapseone sa <account>
synapseone sa create <account> <slug>
synapseone sa token <sa-id>

# Account credentials are secret-write-only.
synapseone credentials create <account> --name N --type bearer|basic|apiKey|oauth2 \\
  (--secret S | --secret-file F) [--expires-at ISO]
synapseone credentials list <account>
synapseone credentials get|delete <id>
synapseone credentials rotate <id> (--secret S | --secret-file F)`;

const CLI_WORKFLOWS = `synapseone workflows
synapseone workflows create --template <name> [--name N]
synapseone workflows create --file definition.json [--name N]
synapseone workflows get <id>
synapseone workflows activate <id>
synapseone workflows deactivate <id>
synapseone workflows exec <id> [--data '{...}']
synapseone workflows test-run --file def.json --input input.json

synapseone templates
synapseone templates <name>
synapseone executions list [--limit N] [--workflow-id ID] [--status success|error]
synapseone executions <id> [--include-data]`;

const CLI_LDS = `synapseone lds licenses
synapseone lds datasources [list] [--org <orgId>] [--account <accountId>]
synapseone lds datasources create --name N --entity-type T --license SPDX
synapseone lds datasources get|delete <id>
synapseone lds attributes list <id>
synapseone lds attributes set <id> --file attrs.json
synapseone lds ingest <id> --file record.json
synapseone lds entities <id> [--limit N] [--visibility public|restricted]
synapseone lds entity <id> <entity-id>
synapseone lds stats <id>`;

const CLI_CALL = `# Base, Faststore and Queue are available through the generic gateway call:
synapseone call POST /v1/base/collections --data '{"name":"parks"}'
synapseone call GET /v1/base/collections
synapseone call PUT /v1/faststore/keys/cache:demo --data '{"value":{"ok":true},"ttlSeconds":300}'
synapseone call POST /v1/queue/queues/emails/messages --data '{"payload":{"to":"a@b.c"}}'

# The same escape hatch covers LDS, Stream, OCS and Notifications:
synapseone call GET /v1/lds/licenses
synapseone call PUT /v1/stream/topics/telemetry --data '{"maxLen":100000}'
synapseone call POST /v1/stream/topics/telemetry/events --data '{"payload":{"value":25.4}}'
synapseone call POST /v1/ocs/buckets --data '{"name":"city-assets"}'
synapseone call POST /v1/notifications --data '{"channel":"email","recipient":{"email":"a@b.c"},"subject":"Hi","body":"Hello"}'

# Raw paths include gateway prefixes; use --file for larger JSON payloads.`;

const JS_INSTALL = `npm install @synapseone/sdk
# or: yarn add @synapseone/sdk
# or: pnpm add @synapseone/sdk

# The package exposes per-service subpaths:
#   @synapseone/sdk/base, /faststore, /queue, /iam, /workflow, /lds`;

const JS_SECTIONS = [
  { title: 'Install', code: JS_INSTALL },
  { title: 'Quick start', code: JS_QUICKSTART },
  { title: 'Auth, client options & tenancy', code: JS_AUTH },
  { title: 'IAM: orgs, roles, policies, keys', code: JS_IAM },
  { title: 'Workflows & executions', code: JS_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: JS_LDS },
  { title: 'SynapseBase', code: JS_BASE },
  { title: 'Synapse Faststore', code: JS_FASTSTORE },
  { title: 'SynapseQueue', code: JS_QUEUE },
  { title: 'Stream, OCS, notifications, AI & inference', code: JS_EXTRA },
  { title: 'Errors, escape hatch & deprecations', code: JS_ERRORS },
];

const PYTHON_INSTALL = `pip install synapseone-sdk

# or with a virtualenv
python -m venv .venv
source .venv/bin/activate
pip install synapseone-sdk

# Optional per-service imports:
from synapseone_sdk.base import BaseService, BaseCollection
from synapseone_sdk.faststore import FaststoreService
from synapseone_sdk.queue import QueueService`;

const PYTHON_SECTIONS = [
  { title: 'Install', code: PYTHON_INSTALL },
  { title: 'Quick start', code: PYTHON_QUICKSTART },
  { title: 'Auth, client options & tenancy', code: PYTHON_AUTH },
  { title: 'IAM: orgs, roles, policies, keys', code: PYTHON_IAM },
  { title: 'Workflows & executions', code: PYTHON_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: PYTHON_LDS },
  { title: 'SynapseBase', code: PYTHON_BASE },
  { title: 'Synapse Faststore', code: PYTHON_FASTSTORE },
  { title: 'SynapseQueue', code: PYTHON_QUEUE },
  { title: 'Stream, OCS, notifications, AI & inference', code: PYTHON_EXTRA },
  { title: 'Errors, escape hatch & deprecations', code: PYTHON_ERRORS },
];

const GO_INSTALL = `go get github.com/synapseone/synapseone-sdk-go@latest

# then import it:
#   import synapseone "github.com/synapseone/synapseone-sdk-go"

# Go 1.22+; the client is a thin wrapper over net/http.`;

const GO_SECTIONS = [
  { title: 'Install', code: GO_INSTALL },
  { title: 'Quick start', code: GO_QUICKSTART },
  { title: 'Auth, client options & tenancy', code: GO_AUTH },
  { title: 'IAM: orgs, roles, policies, keys', code: GO_IAM },
  { title: 'Workflows & executions', code: GO_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: GO_LDS },
  { title: 'SynapseBase', code: GO_BASE },
  { title: 'Synapse Faststore', code: GO_FASTSTORE },
  { title: 'SynapseQueue', code: GO_QUEUE },
  { title: 'Stream, OCS, notifications, AI & inference', code: GO_EXTRA },
  { title: 'Errors, escape hatch & deprecations', code: GO_ERRORS },
];

const CLI_SECTIONS = [
  { title: 'Install', code: CLI_INSTALL },
  { title: 'Configuration', code: CLI_CONFIG },
  { title: 'Auth commands', code: CLI_AUTH },
  { title: 'Orgs, accounts, users, roles & policies', code: CLI_IAM },
  { title: 'API keys, service accounts & credentials', code: CLI_ACCESS },
  { title: 'Workflows, templates & executions', code: CLI_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: CLI_LDS },
  { title: 'Base, Faststore & Queue (generic call)', code: CLI_CALL },
];

const BASE_COLLECTION_ENDPOINTS = [
  ['GET', '/v1/base/collections', 'List collections (?orgId / ?accountId narrows)'],
  ['POST', '/v1/base/collections', 'Create a collection and optional mapping'],
  ['GET', '/v1/base/collections/:collection', 'Collection details + stats'],
  ['PATCH', '/v1/base/collections/:collection', 'Rename / description / replace mapping'],
  ['DELETE', '/v1/base/collections/:collection', 'Delete collection and every document'],
  ['GET', '/v1/base/collections/:collection/stats', '{documents, bytes, lastUpdatedAt}'],
];

const BASE_DOCUMENT_ENDPOINTS = [
  ['POST', '/v1/base/collections/:collection/documents', 'Create (exactly one of data / object)'],
  ['GET', '/v1/base/collections/:collection/documents/:id', 'Read (?as=data|object)'],
  ['PUT', '/v1/base/collections/:collection/documents/:id', 'Upsert / replace / merge (ifVersion)'],
  ['PATCH', '/v1/base/collections/:collection/documents/:id', 'Deep merge + unset dot paths'],
  ['DELETE', '/v1/base/collections/:collection/documents/:id', 'Delete (ifVersion / If-Match)'],
  ['GET', '/v1/base/collections/:collection/documents', 'List raw data view (limit/offset)'],
];

const BASE_ADVANCED_ENDPOINTS = [
  ['POST', '/v1/base/collections/:collection/query', 'Filters, groups, orderBy, cursor, projection'],
  ['POST', '/v1/base/collections/:collection/documents/:id/increment', 'Atomic counter on a raw dot path'],
  ['POST', '/v1/base/collections/:collection/documents:batch', '1..100 ordered create/set/update/delete/increment'],
  ['GET', '/v1/base/collections/:collection/changes', 'Change feed (upserts only; use nextSince)'],
];

const BASE_OPERATORS = [
  ['eq / ne', 'Deep JSON equality / inequality (missing counts as not equal)'],
  ['gt / gte / lt / lte', 'Number/string/boolean comparison; incomparable values never match'],
  ['in / nin', 'Value is / is not in a non-empty array (<=1000 items)'],
  ['contains', 'Substring for strings, membership for arrays'],
  ['startsWith / endsWith', 'String prefix / suffix'],
  ['exists', 'Presence check (true when the path exists, including null)'],
];

const FASTSTORE_KEY_ENDPOINTS = [
  ['GET', '/v1/faststore/stats', 'Backend, tenant, key count and type breakdown'],
  ['GET', '/v1/faststore/keys', 'Scan keys (?prefix&limit&cursor)'],
  ['GET', '/v1/faststore/keys/:key', 'Read value + type + ttlSeconds'],
  ['PUT/POST', '/v1/faststore/keys/:key', 'Set value (ttlSeconds, ifNotExists, ifExists)'],
  ['DELETE', '/v1/faststore/keys/:key', 'Delete a key'],
  ['GET', '/v1/faststore/keys/:key/ttl', 'Remaining TTL (-1 = no expiry)'],
  ['POST', '/v1/faststore/keys/:key/expire', 'Set/clear TTL (0 clears)'],
  ['POST', '/v1/faststore/keys/:key/incr', 'Atomic counter (by, ttlSeconds)'],
  ['POST', '/v1/faststore/batch', '1..100 set/get/delete/incr/expire operations'],
];

const FASTSTORE_STRUCTURE_ENDPOINTS = [
  ['GET · PUT · DELETE', '/v1/faststore/hashes/:key', 'Hash value; /length, /:field and /incr sub-routes'],
  ['GET · POST · DELETE', '/v1/faststore/lists/:key', 'Range, push, pop, trim, length'],
  ['GET · POST · DELETE', '/v1/faststore/sets/:key', 'Members, add, remove, contains, card'],
  ['GET · POST · DELETE', '/v1/faststore/zsets/:key', 'Range, add, incr, remove, score, rank, card'],
  ['POST', '/v1/faststore/locks/:name/acquire', 'Acquire a distributed lock (ttlSeconds, waitMs, token)'],
  ['POST', '/v1/faststore/locks/:name/release', 'Release only with the owner token'],
  ['POST', '/v1/faststore/locks/:name/extend', 'Extend the lease with the owner token'],
];

const QUEUE_CONFIG_ENDPOINTS = [
  ['GET', '/v1/queue/queues', 'List queue configurations for the tenant'],
  ['PUT', '/v1/queue/queues/:queue', 'Idempotent create/update (maxAttempts, visibility)'],
  ['GET', '/v1/queue/queues/:queue', 'Configuration + stats'],
  ['DELETE', '/v1/queue/queues/:queue', 'Delete the queue and all messages'],
  ['POST', '/v1/queue/queues/:queue/purge', 'Clear ready + delayed + in-flight + dead messages'],
  ['GET', '/v1/queue/queues/:queue/stats', 'pending, inflight, dead and counters'],
];

const QUEUE_MESSAGE_ENDPOINTS = [
  ['POST', '/v1/queue/queues/:queue/messages', 'Publish (payload, delay, headers, id, dedupeKey)'],
  ['POST', '/v1/queue/queues/:queue/messages:batch', 'Publish 1..100 messages'],
  ['POST', '/v1/queue/queues/:queue/consume', 'Lease up to 100 messages (returns receipts)'],
  ['POST', '/v1/queue/queues/:queue/ack', 'Ack one receipt or a receipts batch'],
  ['POST', '/v1/queue/queues/:queue/nack', 'Requeue or dead-letter, with optional delay/error'],
  ['POST', '/v1/queue/queues/:queue/heartbeat', 'Extend an active visibility lease'],
];

const QUEUE_INSPECT_ENDPOINTS = [
  ['GET', '/v1/queue/queues/:queue/messages', 'Peek pending (ready + delayed; excludes in-flight)'],
  ['GET', '/v1/queue/queues/:queue/dead', 'Dead letters, newest first'],
  ['POST', '/v1/queue/queues/:queue/dead/:id/replay', 'Replay to pending (delaySeconds, resetAttempts)'],
  ['DELETE', '/v1/queue/queues/:queue/dead/:id', 'Delete a dead letter permanently'],
];

const IAM_QUICKSTART = `# Password sign-in (SSO/OIDC and API keys are the other paths)
TOKEN=$(curl -s -XPOST http://localhost:8080/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

curl -s http://localhost:8080/v1/auth/me \\
  -H "Authorization: Bearer $TOKEN"

# Refresh tokens are single-use; logout-all revokes every session of the user
curl -s -XPOST http://localhost:8080/v1/auth/refresh \\
  -H 'Content-Type: application/json' -d '{"refreshToken":"<rt>"}'
curl -s -XPOST http://localhost:8080/v1/auth/logout-all \\
  -H 'Content-Type: application/json' -d '{"refreshToken":"<rt>"}'`;

const IAM_POLICY = `# An org owns accounts; accounts own roles, policies, keys and service accounts
ORG=$(curl -s -XPOST http://localhost:8080/v1/orgs \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"acme","displayName":"ACME Corp"}' | jq -r .id)
ACCOUNT=$(curl -s -XPOST http://localhost:8080/v1/orgs/$ORG/accounts \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"prod","displayName":"Production"}' | jq -r .id)
USER=$(curl -s -XPOST http://localhost:8080/v1/orgs/$ORG/users \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"email":"alice@acme.local","displayName":"Alice"}' | jq -r .id)

ROLE=$(curl -s -XPOST http://localhost:8080/v1/accounts/$ACCOUNT/roles \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"runner","description":"Workflow runner"}' | jq -r .id)
POLICY=$(curl -s -XPOST http://localhost:8080/v1/accounts/$ACCOUNT/policies \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"exec","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"}]}}' | jq -r .id)

curl -s -XPOST http://localhost:8080/v1/roles/$ROLE/attach \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\\"policyId\\":\\"$POLICY\\"}"
curl -s -XPOST http://localhost:8080/v1/users/$USER/assign \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\\"roleId\\":\\"$ROLE\\"}"

curl -s -XPOST http://localhost:8080/v1/authorize \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d "{\\"userId\\":\\"$USER\\",\\"action\\":\\"workflow:Execute\\",\\"resource\\":\\"*\\"}"

# Scoped machine credential; the secret is shown once
curl -s -XPOST http://localhost:8080/v1/accounts/$ACCOUNT/keys \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"ci","scopes":["workflow:Execute"]}'`;

const IAM_ENDPOINTS = [
  ['POST', '/v1/auth/login', 'Password sign-in → access + refresh token (MFA may answer 401 mfa_required)'],
  ['POST', '/v1/auth/refresh · /logout · /logout-all', 'Rotate a single-use refresh token or revoke sessions'],
  ['GET', '/v1/auth/me · /v1/auth/verify', 'Current principal, or verify any Bearer/API key'],
  ['GET · POST', '/v1/auth/oidc/*', 'OIDC issuer discovery, start and callback (Authentik/Keycloak)'],
  ['GET · POST', '/v1/auth/mfa/*', 'TOTP enrolment, recovery codes, verify and disable'],
  ['GET · POST', '/v1/orgs, /v1/orgs/:id/accounts, /v1/orgs/:id/users', 'Orgs, accounts and users'],
  ['GET · POST', '/v1/accounts/:id/roles, /v1/accounts/:id/policies', 'Roles and AWS-style policies'],
  ['GET', '/v1/managed-policies', 'AWS-style managed policy catalog'],
  ['POST', '/v1/roles/:id/attach, /v1/users/:id/assign', 'Bind policies to roles and roles to users'],
  ['POST', '/v1/authorize · /v1/authorize/*', 'Evaluate Allow/Deny (+Condition) for a principal'],
  ['GET · POST · DELETE', '/v1/accounts/:id/keys, /v1/keys/*', 'API keys; secrets are shown once, rotation has a grace window'],
  ['GET · POST', '/v1/accounts/:id/service-accounts', 'Machine identities and per-account tokens'],
  ['GET', '/v1/audit, /v1/usage/summary, /v1/usage/events', 'Audit trail and request/feature telemetry'],
];

const WORKFLOW_QUICKSTART = `# Templates ship with the engine
curl -s http://localhost:8080/v1/templates -H "Authorization: Bearer $TOKEN"

# Create from a template (or a raw definition), then activate it
curl -s -XPOST http://localhost:8080/v1/workflows \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"demo","template":"webhook-to-log"}'
WF=<workflow-id>
curl -s -XPOST http://localhost:8080/v1/workflows/$WF/activate \\
  -H "Authorization: Bearer $TOKEN"

# Manual run: the request body IS the input
curl -s -XPOST http://localhost:8080/v1/workflows/$WF/execute \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"value":21}'

# Try an unsaved definition, then read execution history with per-node I/O
curl -s -XPOST http://localhost:8080/v1/workflows/test-run \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"definition":{"nodes":[],"connections":{}},"input":{"value":21}}'
curl -s "http://localhost:8080/v1/executions?limit=10&includeData=true" \\
  -H "Authorization: Bearer $TOKEN"`;

const WORKFLOW_WEBHOOK = `# Any active workflow whose webhook node declares path "transform"
curl -s -XPOST http://localhost:8080/webhook/transform \\
  -H 'Content-Type: application/json' -d '{"value":21}'
# -> {"ok":true,"output":...,"executionId":"..."}

# Per-workflow hardening lives on the webhook node parameters:
#   auth: none | secret-header | hmac-sha256 | jwt (credentialId, optional header)
#   rateLimit: {rpm} (default 600)
#   idempotency: {header, ttlSeconds} -> 409 duplicate_delivery on replay
# GitHub: Payload URL https://<host>/webhook/<path>,
#   header x-hub-signature-256, store the secret as an hmac credential.`;

const WORKFLOW_MCP = `# MCP server: active workflows with an mcpTrigger node become tools
curl -s -XPOST http://localhost:8080/mcp \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

# Discover tools, then call one with JSON arguments
curl -s -XPOST http://localhost:8080/mcp \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s -XPOST http://localhost:8080/mcp \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_synapseone_docs","arguments":{"path":"docs/api.md"}}}'

# Public read-only tools (mcp-docs-reader) need no credential.
# Private/write tools require: Authorization: Bearer $TOKEN or X-API-Key: <key>
# Built-in template: mcp-docs-reader -> AI reads the public docs repository.`;

const WORKFLOW_ENDPOINTS = [
  ['GET', '/v1/templates · /v1/templates/:name', 'Built-in templates (webhook-to-log, cron-etl, mcp-docs-reader, …)'],
  ['GET · POST', '/v1/workflows', 'List or create from {name, template} or {name, definition}'],
  ['GET · PUT · DELETE', '/v1/workflows/:id', 'Read, update (bumps revision) or delete a workflow'],
  ['POST', '/v1/workflows/:id/activate · /deactivate', 'Gate cron, webhook and MCP triggers; webhook paths/tool names must be unique'],
  ['POST', '/v1/workflows/:id/execute', 'Manual run for any trigger type, active or not'],
  ['POST', '/v1/workflows/test-run', 'Validate and run an unsaved definition in the sandbox'],
  ['GET', '/v1/executions · /v1/executions/:id', 'History; ?includeData=true adds per-node input/output'],
  ['GET · POST · DELETE', '/v1/credentials', 'Account-scoped node credentials, encrypted at rest'],
  ['GET · POST · PUT', '/v1/human-tasks, /v1/human-tasks/:id/*', 'Durable human waits: claim, complete, reject, expire'],
  ['GET · POST · DELETE', '/v1/secrets, /v1/secrets/:name/*', 'Versioned secret vault with audited reads and rotation'],
  ['ANY', '/webhook/:path', 'Public inbound trigger with per-node auth, rate limit and idempotency'],
  ['POST', '/mcp', 'MCP JSON-RPC server: active mcpTrigger workflows become AI tools'],
];

const WORKFLOW_NODES = [
  ['webhook', 'Trigger on ANY /webhook/:path; path, httpMethod, auth, rateLimit, idempotency'],
  ['cron', 'Schedules from 10s: interval fields, 5-field cron, @hourly/@daily, timezone'],
  ['manualTrigger', 'Run from the Console, CLI or /execute with any JSON input'],
  ['mcpTrigger', 'Expose the workflow as an MCP tool (toolName, description, inputSchema) at POST /mcp'],
  ['httpRequest', 'Public HTTP(S) with SSRF guard, credentials, retry and timeout'],
  ['code', 'Sandboxed JavaScript (≤50 KB, 5 s default) with $input/$json/$now'],
  ['set', 'Merge or assign values with {{ $json.x }} templating'],
  ['if', 'JS condition or value1/operation/value2; branch 0 = true, 1 = false'],
  ['synapseone.api', 'First-party IAM/LDS/Workflow operations under the run principal'],
  ['humanTask', 'Durable wait; resumes exactly once on complete/reject'],
  ['decision · aiAgent', 'Decision routing and AI agent nodes used by the AI templates'],
];

const WORKFLOW_SECRETS = `# Versioned secret vault: values are encrypted, list returns metadata only
curl -s -XPOST http://localhost:8080/v1/secrets \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"smtp-password","value":"<secret>","description":"SMTP relay"}'
curl -s -XPOST http://localhost:8080/v1/secrets/smtp-password/read \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
curl -s -XPOST http://localhost:8080/v1/secrets/smtp-password/rotate \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":"<new-secret>","graceSeconds":86400}'

# Durable human tasks: create, claim, then complete (resumes the run once)
curl -s -XPOST http://localhost:8080/v1/human-tasks \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"title":"Approve flood alert","assignee":"alice@acme.local","decisionSchema":{"type":"object"}}'
TASK=<task-id>
curl -s -XPOST http://localhost:8080/v1/human-tasks/$TASK/claim \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST http://localhost:8080/v1/human-tasks/$TASK/complete \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"decision":{"approved":true},"note":"go ahead"}'`;

const LDS_QUICKSTART = `# Public license catalog (no token needed)
curl -s http://localhost:8080/v1/lds/licenses

# Datasource + attribute registry (unregistered fields are default-deny)
curl -s -XPOST http://localhost:8080/v1/lds/datasources \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"Business Registry","entityType":"Organization","license":"CC-BY-4.0"}'
DS=<datasource-id>
curl -s -XPUT http://localhost:8080/v1/lds/datasources/$DS/attributes \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"attributes":[{"name":"name","ngsiLdType":"Property","visibility":"public"}]}'

# Ingest; the export URL also serves anonymous open-data consumers
curl -s -XPOST http://localhost:8080/v1/lds/datasources/$DS/records \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"55001","name":"Công ty ABC"}'
curl -s "http://localhost:8080/v1/lds/datasources/$DS/entities?visibility=public" \\
  -H "Authorization: Bearer $TOKEN"`;

const LDS_ENDPOINTS = [
  ['GET', '/v1/lds/licenses', 'Built-in SPDX license catalog (public)'],
  ['GET · POST', '/v1/lds/datasources', 'List (?orgId&accountId) or create a datasource'],
  ['GET · PATCH · DELETE', '/v1/lds/datasources/:id', 'Details + registry + stats, update or cascade delete'],
  ['GET · PUT', '/v1/lds/datasources/:id/attributes', 'Read or atomically replace the attribute registry'],
  ['POST', '/v1/lds/datasources/:id/records', 'Ingest one record, {record} or {records} (≤1000)'],
  ['GET', '/v1/lds/datasources/:id/entities', 'NGSI-LD export; ?limit 1..500, ?offset, ?visibility'],
  ['GET', '/v1/lds/datasources/:id/entities/:entityId', 'Single NGSI-LD entity (404 outside the tenant)'],
  ['GET', '/v1/lds/datasources/:id/stats', 'Record count and public/restricted/internal attribute buckets'],
];

const STREAM_QUICKSTART = `# Topic: cap length and/or retention window
curl -s -XPUT http://localhost:8080/v1/stream/topics/telemetry \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxLen":100000,"retentionMs":86400000}'

# Publish one event (or up to 100 with events:batch)
curl -s -XPOST http://localhost:8080/v1/stream/topics/telemetry/events \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"sensor":"temp-1","value":25.4},"key":"sensor-1"}'

# Non-destructive tail from an event id
curl -s -XPOST http://localhost:8080/v1/stream/topics/telemetry/read \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"fromId":"0-0","count":50}'`;

const STREAM_GROUPS = `# Consumer group: create, read as a consumer, ack processed ids
curl -s -XPUT http://localhost:8080/v1/stream/topics/telemetry/groups/analytics \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"startId":"$"}'

curl -s -XPOST http://localhost:8080/v1/stream/topics/telemetry/groups/analytics/read \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"consumer":"worker-1","count":10,"autoAck":false}'

curl -s -XPOST http://localhost:8080/v1/stream/topics/telemetry/groups/analytics/ack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"ids":["1730000000000-0"]}'

# Replay a time window without moving group offsets
curl -s "http://localhost:8080/v1/stream/topics/telemetry/range?start=2026-11-01T00:00:00Z&end=2026-11-02T00:00:00Z&count=100" \\
  -H "Authorization: Bearer $TOKEN"`;

const STREAM_ENDPOINTS = [
  ['GET · PUT', '/v1/stream/topics, /v1/stream/topics/:topic', 'List, create or update a topic (maxLen, minId, retentionMs)'],
  ['GET · DELETE', '/v1/stream/topics/:topic', 'Topic configuration, stats, or delete topic + events'],
  ['POST', '/v1/stream/topics/:topic/events', 'Publish one event (payload, key, headers, id)'],
  ['POST', '/v1/stream/topics/:topic/events:batch', 'Publish up to 100 events with per-event results'],
  ['POST', '/v1/stream/topics/:topic/read', 'Non-destructive raw read / tail (fromId, count, blockMs)'],
  ['GET', '/v1/stream/topics/:topic/range', 'Historical replay by time range (?start&end&count)'],
  ['PUT · DELETE', '/v1/stream/topics/:topic/groups/:group', 'Create or destroy a consumer group'],
  ['POST', '/v1/stream/topics/:topic/groups/:group/read', 'Read through a group (consumer, count, autoAck)'],
  ['POST', '/v1/stream/topics/:topic/groups/:group/ack', 'Acknowledge processed event ids'],
];

const OCS_QUICKSTART = `# Bucket (S3-style lowercase name, 3..63 chars)
curl -s -XPOST http://localhost:8080/v1/ocs/buckets \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"city-assets","quotaBytes":1073741824}'

# Raw upload; checksum, range and conditional headers are supported
curl -s -XPUT "http://localhost:8080/v1/ocs/buckets/city-assets/objects/2026/11/report.pdf" \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/pdf' \\
  -H "x-object-checksum-sha256: <sha256>" --data-binary @report.pdf

# List with common prefixes, then mint a short-lived URL
curl -s "http://localhost:8080/v1/ocs/buckets/city-assets/objects?prefix=2026/&delimiter=/" \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST http://localhost:8080/v1/ocs/buckets/city-assets/presign \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"key":"2026/11/report.pdf","method":"GET","expiresIn":900}'`;

const OCS_MULTIPART = `# 1. Start, 2. upload parts, 3. complete (or DELETE to abort)
curl -s -XPOST http://localhost:8080/v1/ocs/buckets/city-assets/uploads \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"key":"video.mp4","contentType":"video/mp4"}'
UPLOAD=<upload-id>
curl -s -XPUT "http://localhost:8080/v1/ocs/buckets/city-assets/uploads/$UPLOAD/parts/1?key=video.mp4" \\
  -H "Authorization: Bearer $TOKEN" --data-binary @part1.bin
curl -s -XPOST http://localhost:8080/v1/ocs/buckets/city-assets/uploads/$UPLOAD/complete \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"key":"video.mp4","parts":[{"partNumber":1,"etag":"<etag>"}]}'`;

const OCS_ENDPOINTS = [
  ['GET · POST', '/v1/ocs/buckets', 'List buckets (?withStats=1) or create {name, quotaBytes}'],
  ['GET · HEAD · DELETE', '/v1/ocs/buckets/:bucket', 'Metadata/usage, or delete (force=true removes objects)'],
  ['GET', '/v1/ocs/buckets/:bucket/stats', '{objects, bytes, quotaBytes}'],
  ['PUT · GET · HEAD · DELETE', '/v1/ocs/buckets/:bucket/objects/*', 'Raw object body; checksum, range and conditional headers'],
  ['GET', '/v1/ocs/buckets/:bucket/objects', 'List with prefix, delimiter, limit and cursor'],
  ['POST', '/v1/ocs/buckets/:bucket/objects/copy', 'Copy an object within or across buckets'],
  ['POST', '/v1/ocs/buckets/:bucket/presign', 'HMAC-signed URL for GET/PUT with an expiry'],
  ['POST · PUT · DELETE', '/v1/ocs/buckets/:bucket/uploads/*', 'Multipart upload: start, part, complete or abort'],
  ['*', '/v1/storage/*', 'Legacy default-bucket compatibility API (unchanged)'],
];

const NOTIFICATIONS_QUICKSTART = `# One record per channel; placeholders use {{var}} from data
curl -s -XPOST http://localhost:8080/v1/notifications \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "channels":["email","webhook"],
    "recipient":{"email":"ops@example.com","url":"https://hooks.example.com/x"},
    "subject":"Flood alert in {{city}}",
    "body":"Level {{level}}m at {{station}}",
    "data":{"city":"Hanoi","level":2.5,"station":"S1"},
    "idempotencyKey":"alert-2026-11-04-s1"
  }'

# Status, attempt history and cancellation
curl -s "http://localhost:8080/v1/notifications?status=dead&limit=50" \\
  -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:8080/v1/notifications/<id> \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST http://localhost:8080/v1/notifications/<id>/cancel \\
  -H "Authorization: Bearer $TOKEN"

# Preferences and unsubscribe
curl -s http://localhost:8080/v1/notifications/preferences/ops@example.com \\
  -H "Authorization: Bearer $TOKEN"`;

const NOTIFICATIONS_ENDPOINTS = [
  ['POST', '/v1/notifications', 'Queue one notification per channel (202 {notifications})'],
  ['GET', '/v1/notifications', 'Recent notifications (?status&limit)'],
  ['GET', '/v1/notifications/:id', 'Status and the full attempt history'],
  ['POST', '/v1/notifications/:id/cancel', 'Cancel a queued/failed delivery (409 when not cancellable)'],
  ['GET · PUT', '/v1/notifications/preferences/:recipient', 'Allowed channels and unsubscribed flag'],
  ['POST', '/v1/notifications/unsubscribe', 'Unsubscribe a recipient and cancel pending sends'],
];

const NOTIFICATION_CHANNELS = [
  ['webhook', 'Direct HTTPS POST to recipient.url / recipient.webhookUrl'],
  ['email', 'HTTPS relay configured with NOTIFICATIONS_EMAIL_RELAY_URL'],
  ['sms', 'HTTPS relay configured with NOTIFICATIONS_SMS_RELAY_URL'],
  ['push', 'HTTPS relay configured with NOTIFICATIONS_PUSH_RELAY_URL'],
  ['log', 'Dev-only console sink; rejected in production'],
];

const AI_QUICKSTART = `# Console assistant: guidance only, never executes a call
curl -s -XPOST http://localhost:8080/v1/ai/agent \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"question":"How do I create a SynapseBase collection?","history":[]}'

# OpenAI-compatible LLM proxy (stream:true returns SSE)
curl -s -XPOST http://localhost:8080/v1/inference/chat/completions \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"messages":[{"role":"user","content":"Summarise NGSI-LD in one line"}],"max_tokens":128}'

# Local embeddings, structured decision and the workflow semantic router
curl -s -XPOST http://localhost:8080/v1/inference/embeddings \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"input":["flood alert","traffic jam"]}'
curl -s -XPOST http://localhost:8080/v1/inference/decision/route \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"input":"water is rising at station S1","choices":{"ops":"dispatch field crew","alert":"notify residents","ignore":"no action"}}'`;

const AI_ENDPOINTS = [
  ['POST', '/v1/ai/agent', 'Docs assistant: picks an endpoint and drafts a try-it request (no execution)'],
  ['GET', '/v1/inference/health', 'Model/provider health for LLM, embeddings and decision'],
  ['POST', '/v1/inference/chat/completions', 'OpenAI-compatible chat proxy (OpenRouter); SSE with stream:true'],
  ['POST', '/v1/inference/embeddings', 'Self-hosted embeddings (str/clause inputs, OpenAI-shaped response)'],
  ['POST', '/v1/inference/decision', 'Structured evaluation: choice, yes/no or score questions'],
  ['POST', '/v1/inference/decision/route', 'Semantic router: pick the best branch from {id: description}'],
];

const SERVICE_MAP = [
  ['Gateway', '8080', '/v1/*, /webhook/*', 'JWT/API-key auth, principal stamping, scopes, rate limits, routing, /metrics'],
  ['IAM', '4001', '/v1/auth, /v1/orgs, …', 'Orgs, accounts, users, roles, policies, keys, OIDC, MFA, audit, usage'],
  ['Workflow', '4002', '/v1/workflows, /v1/templates', 'DAG engine, executions, webhooks, credentials, human tasks, secrets'],
  ['AI', '4003', '/v1/ai', 'Documentation assistant and model gateway (guidance only)'],
  ['LDS', '4004', '/v1/lds', 'NGSI-LD datasources, attribute registry, licensed exports'],
  ['SynapseBase', '4005', '/v1/base, /v1/search', 'Documents, object ↔ data mapping, queries, change feed, search'],
  ['Faststore', '4006', '/v1/faststore', 'Redis-backed cache/KV, structures, distributed locks'],
  ['SynapseQueue', '4007', '/v1/queue', 'At-least-once messaging, retries, dead letters, replay'],
  ['Inference', '4008', '/v1/inference', 'LLM proxy, local embeddings and Decision-2.0 semantic routing'],
  ['SynapseStream', '4009', '/v1/stream', 'Event log, consumer groups, time-range replay, retention'],
  ['SynapseOCS', '4010', '/v1/ocs, /v1/storage', 'Buckets, objects, presigned URLs, multipart, tenant quotas'],
  ['SynapseNotifications', '4011', '/v1/notifications', 'Outbox, templates, preferences, retries and delivery status'],
];

const GUIDES = [
  ['iam', ShieldCheck],
  ['workflow', GitBranch],
  ['ai', Brain],
  ['lds', Network],
  ['base', Database],
  ['faststore', Gauge],
  ['queue', Inbox],
  ['stream', Radio],
  ['ocs', Cloud],
  ['notifications', Bell],
  ['javascript', FileCode2],
  ['python', FileCode2],
  ['go', Boxes],
];
const GUIDE_CARD =
  'group flex w-full items-center gap-3 rounded-xl border border-s1-line bg-s1-surface px-4 py-3 text-left text-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md hover:shadow-sky-500/10 dark:hover:border-sky-700';
const GUIDE_ICON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-white';

function Overview({ setTab }) {
  const { m } = useI18n();
  const d = m.docsPage;
  return (
    <div className="space-y-10">
      <DocHeader kicker={d.overviewKicker} title={d.overviewTitle}>
        <p>{d.overviewLead}</p>
      </DocHeader>

      <section aria-label={d.startHere}>
        <p className="text-sm font-semibold text-s1-fg">{d.startHere}</p>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GUIDES.map(([id, Icon]) => (
            <li key={id}>
              <button type="button" onClick={() => setTab(id)} className={GUIDE_CARD}>
                <span className={GUIDE_ICON}><Icon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1 font-medium text-s1-fg">{d.guides[id]}</span>
                <ArrowRight className="h-4 w-4 shrink-0 text-s1-muted transition group-hover:translate-x-0.5 group-hover:text-s1-accent" />
              </button>
            </li>
          ))}
          <li>
            <Link to="/api-docs" className={GUIDE_CARD}>
              <span className={GUIDE_ICON}><Zap className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1 font-medium text-s1-fg">{d.tryApi}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-s1-muted transition group-hover:translate-x-0.5 group-hover:text-s1-accent" />
            </Link>
          </li>
        </ul>
      </section>

      <DocSection title="Service map" kicker="Architecture">
        <DocTable head={['Service', 'Port', 'Gateway prefix', 'Responsibility']}>
          {SERVICE_MAP.map(([service, port, prefix, desc]) => (
            <tr key={service} className="border-t border-s1-line align-top">
              <td className="px-4 py-2.5 text-xs font-medium text-s1-fg whitespace-nowrap">{service}</td>
              <td className="px-4 py-2.5 text-xs tabular-nums">{port}</td>
              <td className="px-4 py-2.5 text-xs">
                <code className="text-s1-fg break-all">{prefix}</code>
              </td>
              <td className="px-4 py-2.5 text-xs">{desc}</td>
            </tr>
          ))}
        </DocTable>
        <Text>
          Only the gateway is public in production. Direct service calls additionally require
          <code className="mx-1 text-s1-fg">x-synapseone-internal</code>
          when <code className="text-s1-fg">SYNAPSEONE_INTERNAL_SECRET</code> is configured.
          SynapseBase also serves <code className="mx-1 text-s1-fg">/v1/search</code>; the workflow
          service owns <code className="mx-1 text-s1-fg">/v1/secrets</code> and
          <code className="mx-1 text-s1-fg">/v1/human-tasks</code>.
        </Text>
      </DocSection>

      <DocSection title="Run the stack with Docker" kicker="Getting started">
        <Text>
          The repository ships a complete Compose stack. SynapseBase, Notifications, IAM and the
          workflow service persist to Postgres; Faststore, SynapseQueue and SynapseStream use Redis;
          SynapseOCS writes to S3-compatible storage. Each service falls back to in-memory storage
          only when its backend URL is absent (dev/tests).
        </Text>
        <DocCode data={OVERVIEW_RUN} />
        <Bullets
          items={[
            'Replace every *_change_me_* secret in .env before exposing the stack.',
            'docker compose up -d --build rebuilds the Console, gateway and services after source changes.',
            'Production: use docker-compose.prod.yml with the infra/prod TLS overlay; see docs/production.md in the repository.',
            'Console: http://localhost:3000; sign in with demo@acme.local / org acme, or an API key.',
          ]}
        />
      </DocSection>

      <DocSection title="One request per data service" kicker="First flow">
        <DocCode data={OVERVIEW_FLOW} />
        <Text>
          All snippets use the gateway at <code className="text-s1-fg">:8080</code>. Swap in your own
          token (or an API key) and the examples work unchanged against a Docker deployment.
        </Text>
      </DocSection>

      <DocSection title="Authentication and tenancy" kicker="Security model">
        <Bullets
          items={[
            'Call the gateway with Authorization: Bearer <JWT> or X-API-Key. Public routes are /v1/auth/*, /v1/lds/licenses, public LDS entity exports, /v1/ocs/signed, /webhook/* and the SCIM token plane; everything else needs a credential.',
            'The gateway strips client-sent x-synapseone-* headers and re-stamps them from the verified principal, so services never re-verify the JWT.',
            'Principal callers are scoped automatically: org → org:<id>, otherwise account → account:<id>, otherwise user → user:<sub>.',
            'Platform callers (no principal) select a tenant with x-synapseone-tenant or ?tenant=. Missing tenant is 400 tenant_required.',
            'SDKs expose the same switch: tenant in the constructor (JavaScript/Python) or SetTenant (Go).',
            'Never send the internal secret from a browser; it is for service-to-service calls only.',
          ]}
        />
      </DocSection>

      <DocSection title="SDK namespaces at a glance" kicker="Clients">
        <DocTable head={['Namespace', 'Covers']}>
          {[
            ['client.iam', 'Auth/OIDC/MFA, orgs, accounts, users, roles, policies, keys, service accounts, credentials'],
            ['client.workflow', 'Templates, workflow CRUD/lifecycle, executions, test runs'],
            ['client.ai', 'Documentation assistant guidance (never executes the drafted call)'],
            ['client.inference', 'Chat completions, embeddings, decision and semantic routing'],
            ['client.lds', 'Datasources, attribute registry, ingest, NGSI-LD entities, licenses'],
            ['client.base', 'Collections, documents, mapped objects, queries, counters, batch, changes'],
            ['client.search', 'Full-text, semantic and hybrid search over Base documents'],
            ['client.faststore', 'Strings/counters, hashes, lists, sets, sorted sets, scans, locks'],
            ['client.queue', 'Queues, publish/consume, ack/nack/heartbeat, dead letters, replay'],
            ['client.stream', 'Topics, publish/batch, raw reads, consumer groups, time-range replay'],
            ['client.ocs', 'Buckets, objects, listing, copy, presign, multipart (client.storage = legacy alias)'],
            ['client.notifications', 'Send/fan-out, status, cancel, preferences, unsubscribe'],
          ].map(([name, covers]) => (
            <tr key={name} className="border-t border-s1-line">
              <td className="px-4 py-2.5"><code className="text-xs text-s1-fg">{name}</code></td>
              <td className="px-4 py-2.5 text-xs">{covers}</td>
            </tr>
          ))}
        </DocTable>
        <Text>
          Python and JavaScript use the namespaces above. Go exposes flat methods on one
          <code className="mx-1 text-s1-fg">Client</code>
          (for example <code className="text-s1-fg">CreateBaseCollection</code>,
          <code className="mx-1 text-s1-fg">FaststoreSet</code>,
          <code className="mx-1 text-s1-fg">PublishStreamEvent</code>
          and <code className="text-s1-fg">SendNotification</code>) plus generic typed
          <code className="mx-1 text-s1-fg">BaseCollection[T]</code>.
        </Text>
      </DocSection>
    </div>
  );
}

function IamDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="IAM & Auth" kicker="Identity · port 4001 · /v1/auth, /v1/orgs, …">
        <Text>
          SynapseOne IAM is the first-party identity plane: password and OIDC sign-in, TOTP MFA,
          the tenant hierarchy, AWS-style roles and policies, API keys, service accounts, audit
          and request telemetry. The gateway verifies every credential and stamps the verified
          principal onto each upstream request.
        </Text>
        <Bullets
          items={[
            'Tenant scope is org-first: org:<id> > account:<id> > user:<sub>; cross-tenant reads return 404/403.',
            'The gateway strips client-sent x-synapseone-* headers and re-stamps them from the verified principal.',
            'Scopes are enforced per <service>:read|write|*; minting a key or service-account token never widens the caller scopes.',
            'Password login, TOTP MFA with recovery codes, lockout, OIDC (public HTTPS issuer) and SCIM 2.0 provisioning are built in.',
            'Org admins manage members, MFA resets, unlocks and usage; every allow/deny decision is auditable.',
            'API keys, refresh tokens and credential values are never returned after creation.',
          ]}
        />
      </DocHeader>

      <DocSection title="Sign-in and sessions" kicker="Quick start">
        <DocCode data={IAM_QUICKSTART} />
      </DocSection>

      <DocSection title="Orgs, roles and policies" kicker="Quick start">
        <DocCode data={IAM_POLICY} />
        <Text>
          Actions follow the AWS shape (<code className="text-s1-fg">workflow:Execute</code>,
          <code className="mx-1 text-s1-fg">base:Read</code>,
          <code className="mx-1 text-s1-fg">queue:*</code>). Policies support
          <code className="mx-1 text-s1-fg">Condition</code> blocks and the simulator at
          <code className="mx-1 text-s1-fg">POST /v1/authorize/dry-run</code> evaluates a document
          without a user.
        </Text>
      </DocSection>

      <DocSection title="API reference" kicker="Identity">
        <EndpointTable rows={IAM_ENDPOINTS} />
      </DocSection>

      <DocSection title="Credentials and machine identity" kicker="Operations">
        <Bullets
          items={[
            'API keys are account-scoped and shown once; list responses return metadata/prefix only. Rotation keeps the old key valid for graceSeconds.',
            'Service accounts are machine principals inside an account: create, grant roles, then mint a kind=service-account JWT at /v1/service-accounts/:id/token.',
            'Workflow node credentials (bearer/basic/apiKey/oauth2/hmac) live under /v1/accounts/:id/credentials and /v1/credentials; values are encrypted at rest and write-only.',
            'The versioned vault at /v1/secrets adds rotation, revocation and audited reads for platform secrets.',
            'Usage telemetry (?from&to&feature&statusClass&method&q&accountId) is tenant-scoped and retained for USAGE_RETENTION_DAYS.',
          ]}
        />
      </DocSection>
    </div>
  );
}

function WorkflowDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="Workflow engine" kicker="Automation · port 4002 · /v1/workflows">
        <Text>
          A built-in DAG engine with n8n-compatible node types, durable human tasks, per-node
          credentials, public webhooks and full execution history. Workflows are tenant-scoped
          and authenticated runs carry the caller principal into every node.
        </Text>
        <Bullets
          items={[
            'Create from a template or a raw {nodes, connections} definition; every update bumps revision.',
            'Triggers: manual, cron (10 s minimum), webhook (ANY /webhook/:path) and first-party API calls.',
            'Executions record per-node status (success|error|skipped), input/output, duration and attempts.',
            'Credentials are encrypted at rest with SYNAPSEONE_CREDENTIAL_KEY and never returned.',
          ]}
        />
      </DocHeader>

      <DocSection title="Create, run and inspect" kicker="Quick start">
        <DocCode data={WORKFLOW_QUICKSTART} />
      </DocSection>

      <DocSection title="Public webhooks" kicker="Triggers">
        <DocCode data={WORKFLOW_WEBHOOK} />
        <DocCode data={WORKFLOW_MCP} />
      </DocSection>

      <DocSection title="API reference" kicker="Automation">
        <EndpointTable rows={WORKFLOW_ENDPOINTS} />
      </DocSection>

      <DocSection title="Secrets and human tasks" kicker="Operations">
        <DocCode data={WORKFLOW_SECRETS} />
        <Bullets
          items={[
            'Secret reads are audited, values are AES-256-GCM encrypted with SYNAPSEONE_CREDENTIAL_KEY, and rotation keeps the previous version for graceSeconds (default 24 h, max 30 d).',
            'Human tasks survive restarts in Postgres; completing or rejecting resumes the paused execution exactly once, and duplicate decisions return 409.',
          ]}
        />
      </DocSection>

      <DocSection title="Node types" kicker="Reference">
        <DocTable head={['Node', 'Behaviour']}>
          {WORKFLOW_NODES.map(([node, desc]) => (
            <tr key={node} className="border-t border-s1-line align-top">
              <td className="px-4 py-2.5 whitespace-nowrap"><code className="text-xs text-s1-fg">{node}</code></td>
              <td className="px-4 py-2.5 text-xs">{desc}</td>
            </tr>
          ))}
        </DocTable>
      </DocSection>

      <DocSection title="Execution semantics and limits" kicker="Operations">
        <Bullets
          items={[
            'Definitions are validated for structure, SSRF URLs, size and cycles: ≤200 KB and ≤50 nodes, every node has a 1..128 char name.',
            'Non-if nodes fan out to every branch; a diamond runs the join node once per incoming edge with that edge data.',
            'With several terminal nodes the output is keyed by terminal name; nodeRuns always carry the per-node detail.',
            'settings.onError:"continue" absorbs node failures into partialErrors instead of failing the run.',
            'The httpRequest node blocks first-party hosts unless SYNAPSEONE_SELF_BASE_URLS allowlists the exact origin.',
            'Human tasks pause an execution and resume it exactly once via /v1/human-tasks/:id/complete|reject; duplicate decisions return 409.',
          ]}
        />
      </DocSection>
    </div>
  );
}

function LdsDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="SynapseLDS" kicker="Linked data · port 4004 · /v1/lds">
        <Text>
          Publish licensed open data as NGSI-LD. Records are stored split into private platform
          metadata, public entity identity and registered attributes, and the projector is a
          structural allowlist so internal metadata can never leak.
        </Text>
        <Bullets
          items={[
            'Only entity + registered attributes are serialized; the _core metadata region never leaves the service.',
            'Unregistered fields are stored but default-deny, and reserved names (id, type, @context, internalId, tenantId, …) are rejected.',
            'Every export carries X-LDS-License, Link rel="license" and the license URL in @context.',
            'Public entity routes also serve anonymous consumers the public slice; restricted requires a tenant token; internal never leaves the API.',
          ]}
        />
      </DocHeader>

      <DocSection title="Publish and export" kicker="Quick start">
        <DocCode data={LDS_QUICKSTART} />
      </DocSection>

      <DocSection title="API reference" kicker="Linked data">
        <EndpointTable rows={LDS_ENDPOINTS} />
      </DocSection>

      <DocSection title="Projection, visibility and licenses" kicker="Semantics">
        <Bullets
          items={[
            'Records accept {record}, {records:[…]} or one object (≤1000/call); re-ingesting the same source id bumps version.',
            'The source id becomes _core.sourceRecordId; the public IRI is urn:ngsi-ld:<entityType>:<id> unless ngsiLdId/@id is supplied.',
            'Visibility is public | restricted | internal; unstated attributes inherit the datasource defaultVisibility (internal unless changed).',
            'Built-in licenses: CC0-1.0, PDDL-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODbL-1.0, LicenseRef-Proprietary; custom LicenseRef-* ids require licenseUrl.',
            'The webhook-to-lds workflow template publishes the incoming payload with the run tenant principal.',
          ]}
        />
      </DocSection>
    </div>
  );
}

function StreamDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="SynapseStream" kicker="Event streaming · port 4009 · /v1/stream">
        <Text>
          A tenant-scoped distributed event log with consumer groups, non-destructive reads,
          time-range replay and retention trimming. Redis Streams is the default durable engine;
          the driver is pluggable (for example Kafka) and production refuses the in-memory engine.
        </Text>
        <Bullets
          items={[
            'Topics cap length (maxLen), trim by id (minId) and/or expire events by retentionMs.',
            'Raw reads never consume: they return events from an id without moving any group offset.',
            'Consumer groups track delivered-but-unacked ids per consumer; ack removes them from the pending list.',
            'Payloads are capped by STREAM_MAX_PAYLOAD_BYTES (default 256 KiB); batch publish accepts up to 100 events.',
          ]}
        />
      </DocHeader>

      <DocSection title="Topics, publish and tail" kicker="Quick start">
        <DocCode data={STREAM_QUICKSTART} />
      </DocSection>

      <DocSection title="Consumer groups and replay" kicker="Consume">
        <DocCode data={STREAM_GROUPS} />
      </DocSection>

      <DocSection title="API reference" kicker="Event streaming">
        <EndpointTable rows={STREAM_ENDPOINTS} />
      </DocSection>

      <DocSection title="Delivery notes" kicker="Operations">
        <Bullets
          items={[
            'Event ids are time-ordered ("<ms>-<seq>"); use the last returned id as the next fromId or start cursor.',
            'autoAck:true acknowledges on read; with autoAck:false call the ack route after your processor succeeds.',
            'range?start&end accepts ISO timestamps (or ids) and is the replay path when a consumer must rebuild state.',
            'Topic stats report length, first/last id and every group, which makes lag visible without scanning the log.',
            'Streams are tenant-scoped; platform callers must send x-synapseone-tenant or ?tenant=.',
          ]}
        />
      </DocSection>
    </div>
  );
}

function OcsDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="SynapseOCS" kicker="Object storage · port 4010 · /v1/ocs">
        <Text>
          Bucket-aware object cloud storage with presigned URLs, multipart uploads, quotas and
          S3-compatible backends (SeaweedFS in Compose; MinIO, AWS S3 and R2 are drop-in
          alternatives). The legacy /v1/storage routes remain as the default-bucket API.
        </Text>
        <Bullets
          items={[
            'Buckets and objects are tenant-scoped; cross-tenant reads return 404 and never leak existence.',
            'Bucket names follow S3 rules (3..63 lowercase characters); the virtual "default" bucket backs legacy /v1/storage.',
            'Deleting a non-empty bucket requires ?force=true; quotas are enforced per bucket (quotaBytes).',
            'Object PUT/GET support checksums, Range and conditional If-Match/If-None-Match headers.',
            'Presigned URLs are verified by the public /v1/ocs/signed route, so the token is the credential.',
          ]}
        />
      </DocHeader>

      <DocSection title="Buckets, objects and presigning" kicker="Quick start">
        <DocCode data={OCS_QUICKSTART} />
      </DocSection>

      <DocSection title="Multipart uploads" kicker="Large objects">
        <DocCode data={OCS_MULTIPART} />
      </DocSection>

      <DocSection title="API reference" kicker="Object storage">
        <EndpointTable rows={OCS_ENDPOINTS} />
      </DocSection>

      <DocSection title="Backends and production" kicker="Operations">
        <Bullets
          items={[
            'Production requires STORAGE_BACKEND explicitly: s3 with real STORAGE_S3_* keys, or fs with a durable volume.',
            'OCS fails closed when STORAGE_S3_ENDPOINT is missing and warns if the endpoint is a test double.',
            'Listing supports prefix + delimiter for folder-style navigation and returns an opaque nextCursor.',
            'Use HEAD for size/ETag/checksum metadata without downloading the body.',
          ]}
        />
      </DocSection>
    </div>
  );
}

function NotificationsDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="SynapseNotifications" kicker="Delivery · port 4011 · /v1/notifications">
        <Text>
          A durable notification outbox: products store a notification, Tier 1 owns templates,
          preferences, retries and delivery status. Fan-out creates one record per channel and
          every transition is observable through the status and attempt history.
        </Text>
        <Bullets
          items={[
            'Send one channel or several; the response is 202 with one notification record per channel.',
            '{{var}} placeholders are filled from data; missing keys are left intact.',
            'idempotencyKey is scoped per tenant and channel: a retry returns the existing record instead of sending twice.',
            'Preferences can allow specific channels; unsubscribed:true cancels pending sends and blocks future ones.',
          ]}
        />
      </DocHeader>

      <DocSection title="Send, inspect and cancel" kicker="Quick start">
        <DocCode data={NOTIFICATIONS_QUICKSTART} />
      </DocSection>

      <DocSection title="API reference" kicker="Delivery">
        <EndpointTable rows={NOTIFICATIONS_ENDPOINTS} />
      </DocSection>

      <DocSection title="Channels" kicker="Reference">
        <DocTable head={['Channel', 'Adapter']}>
          {NOTIFICATION_CHANNELS.map(([channel, adapter]) => (
            <tr key={channel} className="border-t border-s1-line">
              <td className="px-4 py-2.5"><code className="text-xs text-s1-fg">{channel}</code></td>
              <td className="px-4 py-2.5 text-xs">{adapter}</td>
            </tr>
          ))}
        </DocTable>
      </DocSection>

      <DocSection title="Delivery guarantees and limits" kicker="Operations">
        <Bullets
          items={[
            'The outbox row is durable; production requires DATABASE_URL.',
            'With NOTIFICATIONS_QUEUE_URL set, jobs travel through SynapseQueue and consumers ack/nack, giving at-least-once delivery across replicas.',
            'Without a queue (dev/tests) an in-process worker claims due rows.',
            'Failures retry with exponential backoff up to NOTIFICATIONS_MAX_ATTEMPTS (default 5), then move to dead with deadReason.',
            'NOTIFICATIONS_RATE_LIMIT_PER_MIN (default 120) caps sends per tenant and returns 429 + Retry-After.',
            'Health reports the store (postgres/memory) and delivery mode (queue/local).',
          ]}
        />
      </DocSection>
    </div>
  );
}

function AiDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="AI & Inference" kicker="AI · ports 4003/4008 · /v1/ai, /v1/inference">
        <Text>
          Two cooperating services: the AI service answers documentation questions and drafts API
          calls (guidance only — it never executes them), while the Python inference service owns
          the LLM proxy, self-hosted embeddings and the Decision-2.0 semantic router used by
          workflow nodes.
        </Text>
        <Bullets
          items={[
            'AI_API_KEY enables /v1/ai/agent; without it the route answers 503 ai_not_configured.',
            'The agent returns an endpoint suggestion and a ready-to-edit request; the Console shows a Try it action instead of calling on your behalf.',
            'Inference chat is OpenAI-compatible (tools, tool_choice, response_format and SSE streaming all pass through).',
            'Embeddings and decision run locally; chat requires OPENROUTER_API_KEY (or an OpenRouter-compatible base URL).',
            'Workflow nodes decision / aiAgent / inference.* call these routes with the run principal.',
          ]}
        />
      </DocHeader>

      <DocSection title="Assistant and inference calls" kicker="Quick start">
        <DocCode data={AI_QUICKSTART} />
      </DocSection>

      <DocSection title="API reference" kicker="AI & inference">
        <EndpointTable rows={AI_ENDPOINTS} />
      </DocSection>

      <DocSection title="Decision shapes" kicker="Reference">
        <DocCode
          data={`# Structured evaluation: each question is choice | noul (yes/no) | score
curl -s -XPOST http://localhost:8080/v1/inference/decision \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "state": "Water is rising 30cm/h at station S1",
    "questions": {
      "severity": {
        "type": "choice",
        "instructions": "Classify the situation",
        "criteria": {"low": "no action", "high": "dispatch a crew"}
      }
    }
  }'

# Semantic router: choices map id -> semantic description
curl -s -XPOST http://localhost:8080/v1/inference/decision/route \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"input":"water is rising at S1","choices":{"ops":"dispatch field crew","alert":"notify residents"}}'`}
        />
        <Text>
          Responses include the chosen route/confidence and the full probability map, so workflow
          branches stay explainable.
        </Text>
      </DocSection>
    </div>
  );
}

function BaseDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="SynapseBase" kicker="Documents · port 4005 · /v1/base">
        <Text>
          A self-managed document database with server-side validation and a first-class
          object ↔ data mapping. Write logical objects, store raw JSON, and query either view.
        </Text>
        <Bullets
          items={[
            'Collections are scoped to the caller tenant; names are unique within that scope.',
            'Documents carry id, version, createdAt and updatedAt; writes bump version.',
            'Postgres is the production store; tests and local runs use an in-memory fallback.',
            'Full endpoint reference with try-it forms: open the API Docs page.',
          ]}
        />
      </DocHeader>

      <DocSection title="Mapping objects to stored data" kicker="Core concept">
        <DocCode data={BASE_MAPPING} />
        <Bullets
          items={[
            'Send exactly one of data or object on writes. object keys are logical names; the service stores each one at its mapped dot path.',
            'Read with ?as=object (or "as": "object" in a query) to project the stored data back onto logical names.',
            'The mapping is a validation/view contract, not a migration: changing it never rewrites stored documents.',
            'Types are string | number | boolean | date | array | object | any. required is enforced on POST/PUT and object writes, not on PATCH.',
            'additional:false rejects undeclared object keys; additional:true stores them at their own path. Raw data writes keep unmapped keys either way.',
          ]}
        />
      </DocSection>

      <DocSection title="Quick start" kicker="Write and read">
        <DocCode data={BASE_QUICKSTART} />
      </DocSection>

      <DocSection title="Collections" kicker="API reference">
        <EndpointTable rows={BASE_COLLECTION_ENDPOINTS} />
      </DocSection>

      <DocSection title="Documents" kicker="API reference">
        <EndpointTable rows={BASE_DOCUMENT_ENDPOINTS} />
        <Text>
          Document ids allow <code className="text-s1-fg">[A-Za-z0-9_@.:+-]</code> up to 256
          characters; <code className="text-s1-fg">/</code>, <code className="text-s1-fg">\\</code>,
          <code className="mx-1 text-s1-fg">.</code> and <code className="text-s1-fg">..</code> are rejected.
          A duplicate create is <code className="text-s1-fg">409 document_exists</code>.
        </Text>
      </DocSection>

      <DocSection title="Queries, counters, batch and change feed" kicker="API reference">
        <EndpointTable rows={BASE_ADVANCED_ENDPOINTS} />
        <DocCode data={BASE_QUERY} />
        <OperatorTable rows={BASE_OPERATORS} />
        <Text>
          <code className="text-s1-fg">where</code> accepts logical mapping names or dot paths,
          shorthand <code className="text-s1-fg">{'{"capacity":{"gte":100}}'}</code>, and groups
          <code className="mx-1 text-s1-fg">and/or/not</code>. Document metadata is addressable as
          <code className="mx-1 text-s1-fg">$id/$version/$createdAt/$updatedAt</code>.
          Query responses return <code className="text-s1-fg">{'{items,total,limit,offset,nextCursor}'}</code>.
        </Text>
        <DocCode data={BASE_WRITES} />
        <Bullets
          items={[
            'ifVersion gives compare-and-set semantics; ifVersion:0 means create-only. If-Match: "<version>" is also accepted.',
            'Increment uses a raw dot path (not a logical name), creates a missing document at version 1, and accepts ifVersion:0 for that create.',
            'Batch operations run in order; the response reports per-op results and ok only when every operation succeeded.',
            'The change feed emits upserts only; deleted is always false. Poll with the returned nextSince and follow hasMore.',
          ]}
        />
      </DocSection>

      <DocSection title="Search across collections" kicker="API reference">
        <DocCode data={BASE_SEARCH} />
        <EndpointTable rows={BASE_SEARCH_ENDPOINTS} />
        <Text>
          Tenant and document ACLs are re-checked on every query; a reindex removes deleted
          documents. Facets cover collection, type and status.
        </Text>
      </DocSection>

      <DocSection title="Limits and errors" kicker="Operations">
        <DocCode data={BASE_LIMITS} />
        <Text>
          Common errors: <code className="text-s1-fg">400 mapping_error</code> (missing/typed/unknown field),
          <code className="mx-1 text-s1-fg">409 version_conflict</code>,
          <code className="mx-1 text-s1-fg">409 ambiguous_collection</code> (platform caller must pass ?orgId/?accountId),
          <code className="mx-1 text-s1-fg">413 collection_too_large</code> (narrow the query or raise BASE_QUERY_SCAN_LIMIT).
        </Text>
      </DocSection>
    </div>
  );
}

function FaststoreDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="Synapse Faststore" kicker="Cache · port 4006 · /v1/faststore">
        <Text>
          A tenant-scoped Redis-backed cache and key/value service: TTL strings, counters,
          hashes, lists, sets, sorted sets, scans, batches and distributed locks. Without a
          Redis URL the service falls back to in-memory storage for local development.
        </Text>
        <Bullets
          items={[
            'Keys are strings of 1..512 characters and may not contain "/" or "\\".',
            'Tenant scoping comes from the principal; platform callers pass x-synapseone-tenant or ?tenant=.',
            'Reads return ttlSeconds:null when the key has no expiry; /ttl returns -1 for no expiry and 404 when absent.',
            '0 TTL clears an existing expiry; valid TTLs are 1..2,592,000 seconds (30 days).',
          ]}
        />
      </DocHeader>

      <DocSection title="Keys, TTL and counters" kicker="Quick start">
        <DocCode data={FASTSTORE_QUICKSTART} />
      </DocSection>

      <DocSection title="Key/value API" kicker="API reference">
        <EndpointTable rows={FASTSTORE_KEY_ENDPOINTS} />
      </DocSection>

      <DocSection title="Hashes, collections and locks" kicker="API reference">
        <EndpointTable rows={FASTSTORE_STRUCTURE_ENDPOINTS} />
        <DocCode data={FASTSTORE_LOCK} />
        <Bullets
          items={[
            'Lock acquire always returns 200: acquired:true with a token, or acquired:false when the wait budget expires.',
            'Release and extend require the owner token; a stolen/expired lock can never be released by a stale owner.',
            'Scans return {keys, cursor, truncated}; pass cursor back to continue. Batch supports set/get/delete/incr/expire.',
          ]}
        />
      </DocSection>

      <DocSection title="Limits" kicker="Operations">
        <DocCode data={FASTSTORE_LIMITS} />
      </DocSection>
    </div>
  );
}

function QueueDoc() {
  return (
    <div className="space-y-10">
      <DocHeader title="SynapseQueue" kicker="Messaging · port 4007 · /v1/queue">
        <Text>
          At-least-once queues with delayed and deduplicated publishing, visibility-timeout
          leases, explicit ack/nack/heartbeat, retries, dead letters and replay. Redis is the
          production backend; the in-memory fallback is for local development and tests.
        </Text>
        <Bullets
          items={[
            'publish → ready or delayed → consume creates a lease and increments attempts.',
            'ack deletes the message; nack requeues it or moves it to the dead-letter set.',
            'Expired leases are reclaimed to pending regardless of attempts, so consumers must be idempotent.',
            'Queues are tenant-scoped; platform callers pass x-synapseone-tenant or ?tenant=.',
          ]}
        />
      </DocHeader>

      <DocSection title="Publish, consume and ack" kicker="Quick start">
        <DocCode data={QUEUE_QUICKSTART} />
      </DocSection>

      <DocSection title="Queues" kicker="API reference">
        <EndpointTable rows={QUEUE_CONFIG_ENDPOINTS} />
      </DocSection>

      <DocSection title="Messages and leases" kicker="API reference">
        <EndpointTable rows={QUEUE_MESSAGE_ENDPOINTS} />
        <DocCode data={QUEUE_RETRY} />
      </DocSection>

      <DocSection title="Inspection and dead letters" kicker="API reference">
        <EndpointTable rows={QUEUE_INSPECT_ENDPOINTS} />
      </DocSection>

      <DocSection title="Delivery semantics and limits" kicker="Operations">
        <DocCode data={QUEUE_SEMANTICS} />
        <Text>
          Nack returns <code className="text-s1-fg">{'{state:"retry"|"dead", attempts, availableAt|deadAt}'}</code>.
          Replay moves a dead letter back to ready (or delayed) and optionally resets attempts.
          Purge is destructive: it also clears in-flight and dead messages, while preserving the queue config.
        </Text>
      </DocSection>
    </div>
  );
}

function SdkDoc({ title, kicker, sections }) {
  return (
    <div className="space-y-10">
      <DocHeader kicker={kicker} title={title} />
      {sections.map((sec) => (
        <DocSection key={sec.title} title={sec.title}>
          <DocCode data={sec.code} />
        </DocSection>
      ))}
    </div>
  );
}

export default function Docs() {
  const { m } = useI18n();
  const d = m.docsPage;
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = TABS.some((t) => t.id === requested) ? requested : 'overview';
  const setTab = (id) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };
  // A new tab starts at its top.
  useEffect(() => {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }, [tab]);

  const label = (t) => t.label || d.tabs[t.id];
  let content;
  if (tab === 'overview') content = <Overview setTab={setTab} />;
  else if (tab === 'iam') content = <IamDoc />;
  else if (tab === 'workflow') content = <WorkflowDoc />;
  else if (tab === 'ai') content = <AiDoc />;
  else if (tab === 'lds') content = <LdsDoc />;
  else if (tab === 'base') content = <BaseDoc />;
  else if (tab === 'faststore') content = <FaststoreDoc />;
  else if (tab === 'queue') content = <QueueDoc />;
  else if (tab === 'stream') content = <StreamDoc />;
  else if (tab === 'ocs') content = <OcsDoc />;
  else if (tab === 'notifications') content = <NotificationsDoc />;
  else if (tab === 'javascript') content = <SdkDoc title="JavaScript SDK" kicker={`${d.sdkKicker} · @synapseone/sdk`} sections={JS_SECTIONS} />;
  else if (tab === 'python') content = <SdkDoc title="Python SDK" kicker={`${d.sdkKicker} · synapseone-sdk`} sections={PYTHON_SECTIONS} />;
  else if (tab === 'go') content = <SdkDoc title="Go SDK" kicker={`${d.sdkKicker} · synapseone-sdk-go`} sections={GO_SECTIONS} />;
  else content = <SdkDoc title="SynapseOne CLI" kicker={`${d.cliKicker} · synapseone`} sections={CLI_SECTIONS} />;

  const nav = ['start', 'platform', 'data', 'clients'].map((g) => ({
    title: d.groups[g],
    items: TABS.filter((t) => t.group === g).map((t) => ({
      id: t.id,
      label: label(t),
      active: t.id === tab,
      onClick: () => setTab(t.id),
    })),
  }));
  nav.push({ title: d.groups.more, items: [{ id: 'api', label: m.nav.apiDocs, to: '/api-docs' }] });

  const index = TABS.findIndex((t) => t.id === tab);
  const prev = TABS[index - 1];
  const next = TABS[index + 1];

  return (
    <DocsShell navLabel={d.navLabel} nav={nav} toc tocKey={`${tab}:${m.meta.title}`}>
      <div role="region" aria-label={label(TABS[index])}>
        {content}
      </div>
      <nav className="mt-14 grid gap-3 border-t border-s1-line pt-6 sm:grid-cols-2" aria-label={`${d.prev} / ${d.next}`}>
        {prev ? (
          <button type="button" onClick={() => setTab(prev.id)} className={PAGER}>
            <span className="text-xs text-s1-muted">{d.prev}</span>
            <span className="mt-1 flex items-center gap-2 font-medium text-s1-fg group-hover:text-s1-accent">
              <ArrowLeft className="h-4 w-4" />
              {label(prev)}
            </span>
          </button>
        ) : (
          <span className="hidden sm:block" />
        )}
        {next && (
          <button type="button" onClick={() => setTab(next.id)} className={`${PAGER} sm:items-end sm:text-right`}>
            <span className="text-xs text-s1-muted">{d.next}</span>
            <span className="mt-1 flex items-center gap-2 font-medium text-s1-fg group-hover:text-s1-accent">
              {label(next)}
              <ArrowRight className="h-4 w-4" />
            </span>
          </button>
        )}
      </nav>
    </DocsShell>
  );
}

const PAGER =
  'group flex flex-col items-start rounded-xl border border-s1-line bg-s1-surface px-4 py-3 text-left transition hover:border-s1-accent';
