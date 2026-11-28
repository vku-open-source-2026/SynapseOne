// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bell, Boxes, Brain, Cloud, Database, FileCode2, Gauge, GitBranch, Inbox, Network, Radio, ShieldCheck, Zap } from 'lucide-react';
import DocsShell, { CodeBlock, DocHeader, DocTable, MethodBadge, slugify } from '../components/DocsShell.jsx';
import { useI18n } from '../lib/i18n-context.js';
import { CLIENT_TABS, DOC_GROUPS, DOC_TABS, SERVICE_CATALOG } from '../lib/service-catalog.js';

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
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function EndpointTable({ rows, purposes, headers }) {
  return (
    <DocTable head={[headers.method, headers.endpoint, headers.purpose]}>
      {rows.map(([method, path, purpose]) => (
        <tr key={`${method}:${path}`} className="border-t border-s1-line align-top">
          <td className="whitespace-nowrap px-4 py-2.5"><MethodBadge method={method} /></td>
          <td className="min-w-[14rem] px-4 py-2.5"><code className="break-all font-mono text-xs text-s1-fg">{path}</code></td>
          <td className="px-4 py-2.5 text-xs">{purposes[purpose]}</td>
        </tr>
      ))}
    </DocTable>
  );
}

const OVERVIEW_RUN = `# From the repository root
cp .env.example .env
# Replace every *_change_me_* secret, then:
docker compose up -d --build
docker compose ps

# Gateway health and aggregate readiness
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
curl http://localhost:4011/health   # SynapseNotifications
curl http://localhost:4012/health   # Synapse Warehouse
curl http://localhost:4013/health   # Synapse Lakehouse`;

const REST_CODES = {
  gateway: `curl -s http://localhost:8080/health
curl -s http://localhost:8080/ready
curl -s http://localhost:8080/metrics`,
  dns: `# Direct SynapseDNS management API on 4014; this is not a gateway route.
export SYNAPSEDNS_ADMIN_TOKEN='<admin-token-at-least-32-characters>'
curl -sS http://127.0.0.1:4014/ready

curl -sS -XPOST http://127.0.0.1:4014/v1/zones \\
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"example.test","nameservers":["ns1.example.test","ns2.example.test"],"ttl":300}'

RECORD=$(curl -sS -XPOST http://127.0.0.1:4014/v1/zones/example.test/records \\
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"A","name":"www.example.test","ttl":300,"address":"192.0.2.10"}' | jq -r .id)

curl -sS http://127.0.0.1:4014/v1/zones/example.test/records \\
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN"
curl -sS -XPATCH "http://127.0.0.1:4014/v1/zones/example.test/records/$RECORD" \\
  -H "Authorization: Bearer $SYNAPSEDNS_ADMIN_TOKEN" \\
  -H 'Content-Type: application/json' -d '{"ttl":60}'

# Authoritative wire queries on UDP/TCP 53; never send these through HTTP.
dig @127.0.0.1 -p 53 www.example.test A +norecurse
dig @127.0.0.1 -p 53 www.example.test A +tcp +norecurse
dig @127.0.0.1 -p 53 missing.example.test A +norecurse`,
  tunnel: `# Direct Synapse Tunnel control plane on 4015; this is not a gateway route.
export SYNAPSETUNNEL_ADMIN_TOKEN='<admin-token-at-least-32-characters>'
curl -sS http://127.0.0.1:4015/health
curl -sS http://127.0.0.1:4016/ready

CREATED=$(curl -sS -XPOST http://127.0.0.1:4015/v1/connectors \\
  -H "Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"docs-app","upstreamUrl":"http://127.0.0.1:3000"}')
CONNECTOR_ID=$(printf '%s' "$CREATED" | jq -r .connector.id)
# Save this connector token once; later reads never return it.
printf '%s' "$CREATED" | jq -r .token

curl -sS -XPOST http://127.0.0.1:4015/v1/routes \\
  -H "Authorization: Bearer $SYNAPSETUNNEL_ADMIN_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d "$(jq -nc --arg id "$CONNECTOR_ID" '{name:"docs-app",hostname:"docs.example.com",pathPrefix:"/api",connectorId:$id,timeoutMs:30000}')"

# In another terminal in apps/tunnel-service, start the outbound-only connector:
# SYNAPSETUNNEL_CONNECTOR_TOKEN='<token-returned-once>' npm run start:connector

# Once the connector is online, call HTTP ingress on 4016 with the route Host.
# These paths assume the local upstream exposes /items and /events.
curl -i 'http://127.0.0.1:4016/api/items?limit=10' -H 'Host: docs.example.com'
curl -N 'http://127.0.0.1:4016/api/events' \\
  -H 'Host: docs.example.com' -H 'Accept: text/event-stream'`,
  iam: `# Development sign-in; use SSO or API keys in production
TOKEN=$(curl -s -XPOST http://localhost:8080/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

curl -s http://localhost:8080/v1/auth/me \\
  -H "Authorization: Bearer $TOKEN"`,
  iamPolicy: `ORG=$(curl -s -XPOST http://localhost:8080/v1/orgs \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"acme","displayName":"ACME Corp"}' | jq -r .id)
ACCOUNT=$(curl -s -XPOST "http://localhost:8080/v1/orgs/$ORG/accounts" \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"prod","displayName":"Production"}' | jq -r .id)

curl -s -XPOST "http://localhost:8080/v1/accounts/$ACCOUNT/roles" \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"slug":"runner","description":"Workflow runner"}'`,
  workflow: `curl -s http://localhost:8080/v1/templates \\
  -H "Authorization: Bearer $TOKEN"

WF=$(curl -s -XPOST http://localhost:8080/v1/workflows \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"demo","template":"webhook-to-log"}' | jq -r .id)

curl -s -XPOST "http://localhost:8080/v1/workflows/$WF/activate" \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST "http://localhost:8080/v1/workflows/$WF/execute" \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":21}'`,
  workflowWebhook: `# Activate a workflow whose webhook node declares path "transform"
curl -s -XPOST http://localhost:8080/webhook/transform \\
  -H 'Content-Type: application/json' -d '{"value":21}'

# MCP tools are exposed from active mcpTrigger workflows
curl -s -XPOST http://localhost:8080/mcp \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  workflowSecrets: `curl -s -XPOST http://localhost:8080/v1/secrets \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"smtp-password","value":"<secret>","description":"SMTP relay"}'

curl -s -XPOST http://localhost:8080/v1/human-tasks \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"title":"Approve flood alert","assignee":"alice@acme.local"}'`,
  runner: `# Register a self-hosted workflow runner
curl -s -XPOST http://localhost:8080/v1/workflow-runners \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"edge-runner","mode":"custom","queue":"synapseone-wf-custom"}'

# Inspect live connector state
curl -s http://localhost:8080/v1/workflow-runners \\
  -H "Authorization: Bearer $TOKEN"

# Queue an inference job for an inference/hybrid runner
curl -s -XPOST http://localhost:8080/v1/inference-jobs \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"type":"embeddings","payload":{"input":["flood alert"]}}'`,
  ai: `curl -s -XPOST http://localhost:8080/v1/ai/agent \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"question":"How do I create a SynapseBase collection?","history":[]}'`,
  inference: `curl -s -XPOST http://localhost:8080/v1/inference/chat/completions \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"messages":[{"role":"user","content":"Summarise NGSI-LD"}],"max_tokens":128}'

curl -s -XPOST http://localhost:8080/v1/inference/embeddings \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"input":["flood alert","traffic jam"]}'`,
  inferenceDecision: `curl -s -XPOST http://localhost:8080/v1/inference/decision/route \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"input":"water is rising at S1","choices":{"ops":"dispatch field crew","alert":"notify residents"}}'`,
  lds: `curl -s http://localhost:8080/v1/lds/licenses

DS=$(curl -s -XPOST http://localhost:8080/v1/lds/datasources \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"Business Registry","entityType":"Organization","license":"CC-BY-4.0"}' | jq -r .id)

curl -s -XPUT "http://localhost:8080/v1/lds/datasources/$DS/attributes" \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"attributes":[{"name":"name","ngsiLdType":"Property","visibility":"public"}]}'

curl -s -XPOST "http://localhost:8080/v1/lds/datasources/$DS/records" \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"55001","name":"ABC"}'`,
  base: `curl -s -XPOST http://localhost:8080/v1/base/collections \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"parks","mapping":{"name":"profile.name","capacity":"profile.capacity"}}'

curl -s -XPOST http://localhost:8080/v1/base/collections/parks/documents \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'

curl -s "http://localhost:8080/v1/base/collections/parks/documents/park-1?as=object" \\
  -H "Authorization: Bearer $TOKEN"`,
  baseMapping: `{
  "fields": {
    "name": { "path": "profile.name", "type": "string", "required": true },
    "capacity": { "path": "profile.capacity", "type": "number" }
  },
  "additional": false
}

// Shorthand accepted by collection creation:
{ "name": "profile.name", "capacity": "profile.capacity" }`,
  baseQuery: `curl -s -XPOST http://localhost:8080/v1/base/collections/parks/query \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "where": { "capacity": { "gte": 100 } },
    "orderBy": [{ "field": "name", "direction": "asc" }],
    "limit": 20,
    "as": "object"
  }'

# Atomic update with optimistic concurrency
curl -s -XPUT http://localhost:8080/v1/base/collections/parks/documents/park-1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"object":{"name":"Central Park","capacity":150},"ifVersion":1}'`,
  search: `curl -s -XPOST http://localhost:8080/v1/search \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"query":"central park","mode":"hybrid","collections":["parks"],"limit":10}'

curl -s http://localhost:8080/v1/search/status \\
  -H "Authorization: Bearer $TOKEN"`,
  faststore: `curl -s -XPUT http://localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'

curl -s -XPOST http://localhost:8080/v1/faststore/keys/visits/incr \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"by":1}'`,
  faststoreLock: `curl -s -XPOST http://localhost:8080/v1/faststore/locks/cron:nightly/acquire \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"ttlSeconds":60,"waitMs":5000}'

# Release with the token returned by acquire
curl -s -XPOST http://localhost:8080/v1/faststore/locks/cron:nightly/release \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"token":"<owner-token>"}'`,
  queue: `curl -s -XPUT http://localhost:8080/v1/queue/queues/emails \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxAttempts":5,"visibilityTimeoutSeconds":30}'

curl -s -XPOST http://localhost:8080/v1/queue/queues/emails/messages \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"to":"alice@acme.test"},"dedupeKey":"welcome:alice"}'

curl -s -XPOST http://localhost:8080/v1/queue/queues/emails/consume \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxMessages":10,"consumer":"mailer-1"}'`,
  queueRetry: `# Requeue for a later attempt
curl -s -XPOST http://localhost:8080/v1/queue/queues/emails/nack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","requeue":true,"delaySeconds":60}'

# Inspect and replay dead letters
curl -s "http://localhost:8080/v1/queue/queues/emails/dead?limit=50" \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST http://localhost:8080/v1/queue/queues/emails/dead/<id>/replay \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"delaySeconds":0,"resetAttempts":true}'`,
  stream: `curl -s -XPUT http://localhost:8080/v1/stream/topics/telemetry \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxLen":100000,"retentionMs":86400000}'

curl -s -XPOST http://localhost:8080/v1/stream/topics/telemetry/events \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"sensor":"temp-1","value":25.4},"key":"sensor-1"}'`,
  ocs: `curl -s -XPOST http://localhost:8080/v1/ocs/buckets \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"city-assets","quotaBytes":1073741824}'

curl -s -XPUT http://localhost:8080/v1/ocs/buckets/city-assets/objects/hello.txt \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' \\
  --data-binary 'hello'

curl -s -XPOST http://localhost:8080/v1/ocs/buckets/city-assets/presign \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"key":"hello.txt","method":"GET","expiresIn":900}'`,
  ocsMultipart: `# Start, upload a part, then complete
curl -s -XPOST http://localhost:8080/v1/ocs/buckets/city-assets/uploads \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"key":"video.mp4","contentType":"video/mp4"}'

curl -s -XPUT "http://localhost:8080/v1/ocs/buckets/city-assets/uploads/<id>/parts/1?key=video.mp4" \\
  -H "Authorization: Bearer $TOKEN" --data-binary @part1.bin

curl -s -XPOST http://localhost:8080/v1/ocs/buckets/city-assets/uploads/<id>/complete \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"key":"video.mp4","parts":[{"partNumber":1,"etag":"<etag>"}]}'`,
  notifications: `curl -s -XPOST http://localhost:8080/v1/notifications \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "channels":["email","webhook"],
    "recipient":{"email":"ops@example.com","url":"https://hooks.example.com/x"},
    "subject":"Flood alert in {{city}}",
    "body":"Level {{level}}m",
    "data":{"city":"Hanoi","level":2.5},
    "idempotencyKey":"alert:s1"
  }'

curl -s "http://localhost:8080/v1/notifications?status=dead&limit=50" \\
  -H "Authorization: Bearer $TOKEN"`,
  warehouse: `curl -s -XPOST http://localhost:8080/v1/warehouse/datasets \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"parks","name":"Parks","columns":[{"name":"document_id","type":"string"},{"name":"capacity","type":"number"}]}'

curl -s -XPOST http://localhost:8080/v1/warehouse/datasets/parks/rows \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"rows":[{"document_id":"park-1","capacity":120}]}'

curl -s -XPOST http://localhost:8080/v1/warehouse/query \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"sql":"SELECT * FROM parks LIMIT 20","limit":20}'`,
  lakehouse: `curl -s -XPOST http://localhost:8080/v1/lakehouse/namespaces \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"analytics"}'

curl -s -XPOST http://localhost:8080/v1/lakehouse/namespaces/analytics/tables \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"events","schema":[{"name":"id","type":"string"},{"name":"value","type":"long"}]}'

curl -s -XPOST http://localhost:8080/v1/lakehouse/namespaces/analytics/tables/events/rows \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"rows":[{"id":"a","value":1}],"idempotencyKey":"batch-1"}'`,
};

const SERVICE_DOCS = {
  gateway: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.gateway },
    endpoints: [['GET', '/health', 'health'], ['GET', '/ready', 'ready'], ['GET', '/metrics', 'metrics'], ['GET', '/', 'index']],
  },
  dns: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.dns },
    endpoints: [
      ['GET', '/health', 'health'], ['GET', '/ready', 'ready'], ['UDP · TCP', ':53', 'dnsWire'],
      ['GET · POST', '/v1/zones', 'zones'], ['GET · DELETE', '/v1/zones/:zone', 'zone'],
      ['GET · POST', '/v1/zones/:zone/records', 'records'], ['PATCH · DELETE', '/v1/zones/:zone/records/:recordId', 'record'],
    ],
  },
  tunnel: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.tunnel },
    endpoints: [
      ['GET', '/health', 'health'], ['GET', '/ready', 'ready'],
      ['GET · POST', '/v1/connectors', 'connectors'], ['GET · PATCH · DELETE', '/v1/connectors/:id', 'connector'],
      ['GET · POST', '/v1/routes', 'routes'], ['GET · PATCH · DELETE', '/v1/routes/:id', 'route'],
      ['ANY', '/<matched path>/*', 'ingress'], ['WS', '/_synapse/tunnel/connect', 'connectorTransport'],
    ],
  },
  iam: {
    sections: ['quickstart', 'policy', 'api', 'semantics'], codes: { quickstart: REST_CODES.iam, policy: REST_CODES.iamPolicy },
    endpoints: [
      ['POST', '/v1/auth/login', 'login'], ['POST', '/v1/auth/refresh', 'refresh'], ['GET', '/v1/auth/me', 'me'],
      ['GET · POST', '/v1/orgs', 'orgs'], ['GET · POST', '/v1/orgs/:orgId/accounts', 'accounts'],
      ['GET · POST', '/v1/accounts/:accountId/roles', 'roles'], ['POST', '/v1/authorize', 'authorize'],
      ['GET · POST', '/v1/accounts/:accountId/keys', 'keys'], ['GET', '/v1/audit', 'audit'],
      ['GET', '/v1/usage/summary', 'usage'], ['GET · POST', '/v1/scim/tokens', 'scim'],
    ],
  },
  workflow: {
    sections: ['quickstart', 'webhook', 'api', 'secrets', 'semantics'], codes: { quickstart: REST_CODES.workflow, webhook: REST_CODES.workflowWebhook, secrets: REST_CODES.workflowSecrets },
    endpoints: [
      ['GET', '/v1/templates', 'templates'], ['GET · POST', '/v1/workflows', 'workflows'], ['GET · PUT · DELETE', '/v1/workflows/:id', 'workflowDetail'],
      ['POST', '/v1/workflows/:id/execute', 'execute'], ['POST', '/v1/workflows/test-run', 'testRun'], ['GET', '/v1/executions', 'executions'],
      ['GET · POST', '/v1/credentials', 'credentials'], ['GET · POST · DELETE', '/v1/credentials/:id', 'credentialDetail'], ['GET · POST', '/v1/human-tasks', 'humanTasks'], ['GET · POST', '/v1/secrets', 'secrets'],
      ['POST', '/mcp', 'mcp'], ['ANY', '/webhook/:path', 'webhook'],
    ],
  },
  runner: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.runner },
    endpoints: [
      ['GET', '/v1/workflow-runners/options', 'runnerOptions'], ['GET · POST', '/v1/workflow-runners', 'runnerList'],
      ['GET · PATCH · DELETE', '/v1/workflow-runners/:id', 'runnerDetail'], ['GET', '/v1/workflow-runners/:id/connection', 'runnerConnection'],
      ['POST', '/v1/workflow-runners/:id/command', 'runnerCommand'], ['POST', '/v1/runner/jobs/:id/claim', 'jobClaim'],
      ['POST', '/v1/runner/jobs/:id/heartbeat', 'jobHeartbeat'], ['POST', '/v1/runner/jobs/:id/complete', 'jobComplete'],
      ['GET · POST', '/v1/inference-jobs', 'inferenceJobs'],
    ],
  },
  ai: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.ai },
    endpoints: [['POST', '/v1/ai/agent', 'agent']],
  },
  inference: {
    sections: ['quickstart', 'decision', 'api', 'semantics'], codes: { quickstart: REST_CODES.inference, decision: REST_CODES.inferenceDecision },
    endpoints: [['GET', '/v1/inference/health', 'health'], ['POST', '/v1/inference/chat/completions', 'chat'], ['POST', '/v1/inference/embeddings', 'embeddings'], ['POST', '/v1/inference/decision', 'decision'], ['POST', '/v1/inference/decision/route', 'route']],
  },
  lds: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.lds },
    endpoints: [['GET', '/v1/lds/licenses', 'licenses'], ['GET · POST', '/v1/lds/datasources', 'datasources'], ['GET · PATCH · DELETE', '/v1/lds/datasources/:id', 'datasourceDetail'], ['GET · PUT', '/v1/lds/datasources/:id/attributes', 'attributes'], ['POST', '/v1/lds/datasources/:id/records', 'records'], ['GET', '/v1/lds/datasources/:id/entities', 'entities'], ['GET', '/v1/lds/datasources/:id/stats', 'stats']],
  },
  base: {
    sections: ['mapping', 'quickstart', 'query', 'api', 'semantics'], codes: { mapping: REST_CODES.baseMapping, quickstart: REST_CODES.base, query: REST_CODES.baseQuery },
    endpoints: [
      ['GET · POST', '/v1/base/databases', 'databases'], ['GET · POST', '/v1/base/collections', 'collections'], ['GET · POST', '/v1/base/collections/:collection/documents', 'documents'],
      ['POST', '/v1/base/collections/:collection/query', 'query'], ['POST', '/v1/base/collections/:collection/vector-search', 'vector'],
      ['GET · POST', '/v1/base/collections/:collection/graph/*', 'graph'], ['GET · POST', '/v1/base/collections/:collection/geo/*', 'geo'],
      ['POST', '/v1/base/collections/:collection/documents/:id/increment', 'increment'], ['POST', '/v1/base/collections/:collection/documents:batch', 'batch'],
      ['GET', '/v1/base/collections/:collection/changes', 'changes'], ['GET', '/v1/base/outbox', 'outbox'],
    ],
  },
  search: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.search },
    endpoints: [['POST', '/v1/search', 'search'], ['GET', '/v1/search?q=…', 'searchGet'], ['POST', '/v1/search/reindex', 'reindex'], ['GET', '/v1/search/status', 'status']],
  },
  faststore: {
    sections: ['quickstart', 'lock', 'api', 'semantics'], codes: { quickstart: REST_CODES.faststore, lock: REST_CODES.faststoreLock },
    endpoints: [['GET', '/v1/faststore/stats', 'stats'], ['GET', '/v1/faststore/keys', 'keys'], ['GET · PUT · DELETE', '/v1/faststore/keys/:key', 'key'], ['GET', '/v1/faststore/keys/:key/ttl', 'ttl'], ['POST', '/v1/faststore/keys/:key/expire', 'expire'], ['POST', '/v1/faststore/keys/:key/incr', 'incr'], ['POST', '/v1/faststore/batch', 'batch'], ['GET · PUT · POST · DELETE', '/v1/faststore/{hashes,lists,sets,zsets}/:key', 'structures'], ['POST', '/v1/faststore/locks/:name/{acquire,release,extend}', 'locks']],
  },
  queue: {
    sections: ['quickstart', 'retry', 'api', 'semantics'], codes: { quickstart: REST_CODES.queue, retry: REST_CODES.queueRetry },
    endpoints: [['GET · PUT', '/v1/queue/queues', 'queues'], ['GET · DELETE', '/v1/queue/queues/:queue', 'queueConfig'], ['POST', '/v1/queue/queues/:queue/messages', 'publish'], ['POST', '/v1/queue/queues/:queue/consume', 'consume'], ['POST', '/v1/queue/queues/:queue/ack', 'ack'], ['POST', '/v1/queue/queues/:queue/nack', 'nack'], ['POST', '/v1/queue/queues/:queue/heartbeat', 'heartbeat'], ['GET', '/v1/queue/queues/:queue/dead', 'dead'], ['POST · DELETE', '/v1/queue/queues/:queue/dead/:id', 'replay']],
  },
  stream: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.stream },
    endpoints: [['GET · PUT', '/v1/stream/topics', 'topics'], ['GET · DELETE', '/v1/stream/topics/:topic', 'topic'], ['POST', '/v1/stream/topics/:topic/events', 'events'], ['POST', '/v1/stream/topics/:topic/events:batch', 'batch'], ['POST', '/v1/stream/topics/:topic/read', 'read'], ['GET', '/v1/stream/topics/:topic/range', 'range'], ['PUT · DELETE', '/v1/stream/topics/:topic/groups/:group', 'groups'], ['POST', '/v1/stream/topics/:topic/groups/:group/read', 'groupRead'], ['POST', '/v1/stream/topics/:topic/groups/:group/ack', 'groupAck']],
  },
  ocs: {
    sections: ['quickstart', 'multipart', 'api', 'semantics'], codes: { quickstart: REST_CODES.ocs, multipart: REST_CODES.ocsMultipart },
    endpoints: [['GET · POST', '/v1/ocs/buckets', 'buckets'], ['GET · HEAD · DELETE', '/v1/ocs/buckets/:bucket', 'bucket'], ['PUT · GET · HEAD · DELETE', '/v1/ocs/buckets/:bucket/objects/*', 'objects'], ['GET', '/v1/ocs/buckets/:bucket/objects', 'list'], ['POST', '/v1/ocs/buckets/:bucket/objects/copy', 'copy'], ['POST', '/v1/ocs/buckets/:bucket/presign', 'presign'], ['POST · PUT · DELETE', '/v1/ocs/buckets/:bucket/uploads/*', 'multipart'], ['GET · PUT · DELETE', '/v1/ocs/signed/*', 'signed'], ['*', '/v1/storage/*', 'legacy']],
  },
  notifications: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.notifications },
    endpoints: [['POST', '/v1/notifications', 'send'], ['GET', '/v1/notifications', 'list'], ['GET', '/v1/notifications/:id', 'detail'], ['POST', '/v1/notifications/:id/cancel', 'cancel'], ['POST', '/v1/notifications/:id/retry', 'retry'], ['GET · POST · PATCH · DELETE', '/v1/notifications/templates', 'templates'], ['GET · PUT', '/v1/notifications/preferences/:recipient', 'preferences'], ['POST', '/v1/notifications/unsubscribe', 'unsubscribe']],
  },
  warehouse: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.warehouse },
    endpoints: [['GET · POST', '/v1/warehouse/datasets', 'datasets'], ['GET · PATCH · DELETE', '/v1/warehouse/datasets/:id', 'dataset'], ['POST', '/v1/warehouse/datasets/:id/rows', 'rows'], ['POST', '/v1/warehouse/query', 'query'], ['GET', '/v1/warehouse/templates', 'templates'], ['GET · POST', '/v1/warehouse/jobs', 'jobs'], ['GET · PATCH · DELETE', '/v1/warehouse/jobs/:id', 'job'], ['POST', '/v1/warehouse/jobs/:id/run', 'run'], ['POST', '/v1/warehouse/jobs/:id/pause', 'pause'], ['POST', '/v1/warehouse/jobs/:id/resume', 'resume'], ['POST', '/v1/warehouse/etl/batch', 'etlBatch'], ['POST', '/v1/warehouse/etl/stream', 'etlStream'], ['POST', '/v1/warehouse/etl/base', 'etlBase'], ['POST', '/v1/warehouse/etl/lakehouse', 'etlLakehouse']],
  },
  lakehouse: {
    sections: ['quickstart', 'api', 'semantics'], codes: { quickstart: REST_CODES.lakehouse },
    endpoints: [['GET · POST', '/v1/lakehouse/namespaces', 'namespaces'], ['GET · POST', '/v1/lakehouse/namespaces/:namespace/tables', 'tables'], ['GET · DELETE', '/v1/lakehouse/namespaces/:namespace/tables/:table', 'table'], ['POST', '/v1/lakehouse/namespaces/:namespace/tables/:table/rows', 'rows'], ['POST', '/v1/lakehouse/namespaces/:namespace/tables/:table/query', 'query'], ['GET', '/v1/lakehouse/namespaces/:namespace/tables/:table/snapshots', 'snapshots'], ['POST', '/v1/lakehouse/namespaces/:namespace/tables/:table/schema', 'schema'], ['GET', '/v1/lakehouse/namespaces/:namespace/tables/:table/maintenance', 'maintenance'], ['GET', '/v1/lakehouse/usage', 'usage']],
  },
};

const SDK_SETUP = {
  javascript: `import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient({
  baseUrl: 'http://localhost:8080',
  token: '<access-token>',
});`,
  python: `from synapseone_sdk import SynapseOneClient

c = SynapseOneClient(
    "http://localhost:8080",
    token="<access-token>",
)`,
  go: `import synapseone "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"

c := synapseone.New("http://localhost:8080")
c.SetToken("<access-token>")`,
  rust: `use serde_json::json;
use synapseone::{Credentials, SynapseOneClient};

// Inside an async fn returning synapseone::Result<()>.
let c = SynapseOneClient::new(
    "http://localhost:8080",
    Credentials::token("<access-token>"),
)?;`,
};

const SDK_EXAMPLES = {
  dns: {
    setup: {
      javascript: `// Node 20+ built-in fetch; direct SynapseDNS HTTP API, not the gateway SDK.
const DNS_API = 'http://127.0.0.1:4014';
const DNS_HEADERS = {
  Authorization: 'Bearer ' + process.env.SYNAPSEDNS_ADMIN_TOKEN,
  'Content-Type': 'application/json',
};

async function dnsRequest(path, method = 'GET', body) {
  const response = await fetch(DNS_API + path, {
    method,
    headers: DNS_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(response.status + ': ' + await response.text());
  return response.status === 204 ? null : response.json();
}`,
      python: `# Direct SynapseDNS HTTP API with the Python standard library.
import json
import os
import urllib.request

DNS_API = "http://127.0.0.1:4014"
DNS_HEADERS = {
    "Authorization": f"Bearer {os.environ['SYNAPSEDNS_ADMIN_TOKEN']}",
    "Content-Type": "application/json",
}

def dns_request(path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        DNS_API + path, data=data, headers=DNS_HEADERS, method=method
    )
    with urllib.request.urlopen(request) as response:
        return None if response.status == 204 else json.load(response)`,
      go: `package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
)

func dnsAPI(method, path string, body []byte) map[string]any {
    req, err := http.NewRequest(method, "http://127.0.0.1:4014"+path, bytes.NewReader(body))
    if err != nil { log.Fatal(err) }
    req.Header.Set("Authorization", "Bearer "+os.Getenv("SYNAPSEDNS_ADMIN_TOKEN"))
    req.Header.Set("Content-Type", "application/json")
    resp, err := http.DefaultClient.Do(req)
    if err != nil { log.Fatal(err) }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 { log.Fatal(resp.Status) }
    var result map[string]any
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil { log.Fatal(err) }
    return result
}

// Inside func main(); standard net/http, not the gateway SDK.`,
      rust: `use reqwest::{Client, Method};
use serde_json::{json, Value};

// Cargo.toml: reqwest = { version = "0.12", features = ["json"] }, serde_json = "1"
// Inside async fn main() -> Result<(), Box<dyn std::error::Error>>.
let dns = Client::new();
let dns_token = std::env::var("SYNAPSEDNS_ADMIN_TOKEN")?;

async fn dns_request(
    client: &Client,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, reqwest::Error> {
    let mut request = client
        .request(method, format!("http://127.0.0.1:4014{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request.send().await?.error_for_status()?.json().await
}`,
    },
    javascript: `await dnsRequest('/v1/zones', 'POST', {
  name: 'example.test',
  nameservers: ['ns1.example.test', 'ns2.example.test'],
  ttl: 300,
});
const record = await dnsRequest('/v1/zones/example.test/records', 'POST', {
  type: 'A', name: 'www.example.test', ttl: 300, address: '192.0.2.10',
});
const records = await dnsRequest('/v1/zones/example.test/records');
console.log(record.id, records.records.length);`,
    python: `dns_request("/v1/zones", "POST", {
    "name": "example.test",
    "nameservers": ["ns1.example.test", "ns2.example.test"],
    "ttl": 300,
})
record = dns_request("/v1/zones/example.test/records", "POST", {
    "type": "A", "name": "www.example.test", "ttl": 300, "address": "192.0.2.10",
})
records = dns_request("/v1/zones/example.test/records")
print(record["id"], len(records["records"]))`,
    go: `dnsAPI("POST", "/v1/zones", []byte(\`{"name":"example.test","nameservers":["ns1.example.test","ns2.example.test"],"ttl":300}\`))
dnsAPI("POST", "/v1/zones/example.test/records", []byte(\`{"type":"A","name":"www.example.test","ttl":300,"address":"192.0.2.10"}\`))
records := dnsAPI("GET", "/v1/zones/example.test/records", nil)
fmt.Println(records)`,
    rust: `dns_request(&dns, &dns_token, Method::POST, "/v1/zones", Some(json!({
    "name": "example.test",
    "nameservers": ["ns1.example.test", "ns2.example.test"],
    "ttl": 300,
}))).await?;
let record = dns_request(&dns, &dns_token, Method::POST, "/v1/zones/example.test/records", Some(json!({
    "type": "A", "name": "www.example.test", "ttl": 300, "address": "192.0.2.10",
}))).await?;
let records = dns_request(&dns, &dns_token, Method::GET, "/v1/zones/example.test/records", None).await?;
println!("{} {}", record["id"], records["records"].as_array().map_or(0, Vec::len));`,
  },
  tunnel: {
    setup: {
      javascript: `// Node 20+ built-in HTTP clients; direct Synapse Tunnel APIs, not the gateway SDK.
import { request } from 'node:http';

const TUNNEL_API = 'http://127.0.0.1:4015';
const TUNNEL_HEADERS = {
  Authorization: 'Bearer ' + process.env.SYNAPSETUNNEL_ADMIN_TOKEN,
  'Content-Type': 'application/json',
};

async function tunnelApi(path, method = 'GET', body) {
  const response = await fetch(TUNNEL_API + path, {
    method,
    headers: TUNNEL_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(response.status + ': ' + await response.text());
  return response.status === 204 ? null : response.json();
}

function ingressRequest(path) {
  return new Promise((resolve, reject) => {
    const req = request('http://127.0.0.1:4016' + path, {
      headers: { Host: 'docs.example.com' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}`,
      python: `# Direct Synapse Tunnel HTTP APIs with the Python standard library.
import json
import os
import urllib.request

TUNNEL_API = "http://127.0.0.1:4015"
TUNNEL_HEADERS = {
    "Authorization": f"Bearer {os.environ['SYNAPSETUNNEL_ADMIN_TOKEN']}",
    "Content-Type": "application/json",
}

def tunnel_api(path, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        TUNNEL_API + path, data=data, headers=TUNNEL_HEADERS, method=method
    )
    with urllib.request.urlopen(request) as response:
        return None if response.status == 204 else json.load(response)`,
      go: `package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
)

func tunnelAPI(method, path string, body []byte) map[string]any {
    req, err := http.NewRequest(method, "http://127.0.0.1:4015"+path, bytes.NewReader(body))
    if err != nil { log.Fatal(err) }
    req.Header.Set("Authorization", "Bearer "+os.Getenv("SYNAPSETUNNEL_ADMIN_TOKEN"))
    req.Header.Set("Content-Type", "application/json")
    resp, err := http.DefaultClient.Do(req)
    if err != nil { log.Fatal(err) }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 { log.Fatal(resp.Status) }
    var result map[string]any
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil { log.Fatal(err) }
    return result
}

// Inside func main(); standard net/http, not the gateway SDK.`,
      rust: `use reqwest::{Client, Method};
use serde_json::{json, Value};

// Cargo.toml: reqwest = { version = "0.12", features = ["json"] }, serde_json = "1"
// Inside async fn main() -> Result<(), Box<dyn std::error::Error>>.
let tunnel = Client::new();
let tunnel_token = std::env::var("SYNAPSETUNNEL_ADMIN_TOKEN")?;

async fn tunnel_api(
    client: &Client,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, reqwest::Error> {
    let mut request = client
        .request(method, format!("http://127.0.0.1:4015{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request.send().await?.error_for_status()?.json().await
}`,
    },
    javascript: `const created = await tunnelApi('/v1/connectors', 'POST', {
  name: 'docs-app', upstreamUrl: 'http://127.0.0.1:3000',
});
const connectorId = created.connector.id;
// Save this token once and configure the outbound-only connector with it.
console.log('Connector token:', created.token);
await tunnelApi('/v1/routes', 'POST', {
  name: 'docs-app', hostname: 'docs.example.com', pathPrefix: '/api',
  connectorId, timeoutMs: 30000,
});

// After the outbound connector is online, call ingress without the admin token.
const response = await ingressRequest('/api/items?limit=10');
if (response.status >= 400) throw new Error(response.status + ': ' + response.body);
console.log(response.status, response.body);`,
    python: `created = tunnel_api("/v1/connectors", "POST", {
    "name": "docs-app", "upstreamUrl": "http://127.0.0.1:3000",
})
connector_id = created["connector"]["id"]
# Save this token once and configure the outbound-only connector with it.
print("Connector token:", created["token"])
tunnel_api("/v1/routes", "POST", {
    "name": "docs-app", "hostname": "docs.example.com", "pathPrefix": "/api",
    "connectorId": connector_id, "timeoutMs": 30000,
})

# After the outbound connector is online, call ingress without the admin token.
request = urllib.request.Request(
    "http://127.0.0.1:4016/api/items?limit=10",
    headers={"Host": "docs.example.com"},
)
with urllib.request.urlopen(request) as response:
    print(response.status, response.read().decode())`,
    go: `created := tunnelAPI("POST", "/v1/connectors", []byte(\`{"name":"docs-app","upstreamUrl":"http://127.0.0.1:3000"}\`))
connector := created["connector"].(map[string]any)
connectorID := connector["id"].(string)
// Save this token once and configure the outbound-only connector with it.
fmt.Println("Connector token:", created["token"])
routeBody, err := json.Marshal(map[string]any{
    "name": "docs-app", "hostname": "docs.example.com", "pathPrefix": "/api",
    "connectorId": connectorID, "timeoutMs": 30000,
})
if err != nil { log.Fatal(err) }
tunnelAPI("POST", "/v1/routes", routeBody)

// After the outbound connector is online, call ingress without the admin token.
req, err := http.NewRequest("GET", "http://127.0.0.1:4016/api/items?limit=10", nil)
if err != nil { log.Fatal(err) }
req.Host = "docs.example.com"
resp, err := http.DefaultClient.Do(req)
if err != nil { log.Fatal(err) }
defer resp.Body.Close()
fmt.Println(resp.Status)`,
    rust: `let created = tunnel_api(&tunnel, &tunnel_token, Method::POST, "/v1/connectors", Some(json!({
    "name": "docs-app", "upstreamUrl": "http://127.0.0.1:3000",
}))).await?;
let connector_id = created["connector"]["id"].as_str().ok_or("missing connector id")?;
// Save this token once and configure the outbound-only connector with it.
println!("Connector token: {}", created["token"]);
tunnel_api(&tunnel, &tunnel_token, Method::POST, "/v1/routes", Some(json!({
    "name": "docs-app", "hostname": "docs.example.com", "pathPrefix": "/api",
    "connectorId": connector_id, "timeoutMs": 30000,
}))).await?;

// After the outbound connector is online, call ingress without the admin token.
let response = tunnel
    .get("http://127.0.0.1:4016/api/items?limit=10")
    .header("Host", "docs.example.com")
    .send()
    .await?;
println!("{}", response.status());`,
  },
  gateway: {
    javascript: `const health = await c.health.health();
const ready = await c.health.ready();`,
    python: `health = c.health.health()
ready = c.health.ready()`,
    go: `health, err := c.Health()
if err != nil { log.Fatal(err) }
ready, err := c.Ready()
if err != nil { log.Fatal(err) }`,
    rust: `let health = c.health().health().await?;
let ready = c.health().ready(false).await?;`,
  },
  iam: {
    javascript: `const me = await c.iam.me();
const orgs = await c.iam.listOrgs();`,
    python: `me = c.iam.me()
orgs = c.iam.list_orgs()`,
    go: `me, err := c.Me()
if err != nil { log.Fatal(err) }
orgs, err := c.ListOrgs()
if err != nil { log.Fatal(err) }`,
    rust: `let me = c.iam().me().await?;
let orgs = c.iam().list_orgs().await?;`,
  },
  workflow: {
    javascript: `const templates = await c.workflow.listTemplates();
const wf = await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
await c.workflow.activateWorkflow(wf.id);`,
    python: `templates = c.workflow.list_templates()
wf = c.workflow.create_workflow_from_template("webhook-to-log", "demo")
c.workflow.activate_workflow(wf["id"])`,
    go: `_, err := c.ListTemplates()
if err != nil { log.Fatal(err) }
wf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
if err != nil { log.Fatal(err) }
if err := c.ActivateWorkflow(wf["id"].(string)); err != nil { log.Fatal(err) }`,
    rust: `let templates = c.workflow().list_templates().await?;
let wf = c.workflow()
    .create_workflow_from_template("webhook-to-log", Some("demo"))
    .await?;`,
  },
  runner: {
    javascript: `const runner = await c.workflow.createWorkflowRunner({
  name: 'edge-runner',
  mode: 'custom',
  queue: 'synapseone-wf-custom',
});
const runners = await c.workflow.listWorkflowRunners();`,
    python: `runner = c.workflow.create_workflow_runner(
    "edge-runner",
    mode="custom",
    queue="synapseone-wf-custom",
)
runners = c.workflow.list_workflow_runners()`,
    go: `// No dedicated Go runner wrapper: use the generic gateway escape hatch.
created, err := c.Call("POST", "/v1/workflow-runners", map[string]any{
    "name": "edge-runner",
    "mode": "custom",
    "queue": "synapseone-wf-custom",
})
if err != nil { log.Fatal(err) }
runners, err := c.Call("GET", "/v1/workflow-runners", nil)
if err != nil { log.Fatal(err) }`,
    rust: `let runner = c.workflow()
    .create_workflow_runner(
        "edge-runner", "custom", Some("synapseone-wf-custom"),
        None, None, None, None,
    )
    .await?;
let runners = c.workflow().list_workflow_runners().await?;`,
    generic: ['go'],
  },
  ai: {
    javascript: `const draft = await c.ai.agent('How do I create a Base collection?');`,
    python: `draft = c.ai.agent("How do I create a Base collection?")`,
    go: `draft, err := c.AIAgent("How do I create a Base collection?")
if err != nil { log.Fatal(err) }`,
    rust: `let draft = c.ai()
    .agent("How do I create a Base collection?", None)
    .await?;`,
  },
  inference: {
    javascript: `const chat = await c.inference.chat([{ role: 'user', content: 'Hello' }]);
const vectors = await c.inference.embeddings(['flood alert']);
const route = await c.inference.route('water rising', { ops: 'dispatch', alert: 'notify' });`,
    python: `chat = c.inference.chat([{"role": "user", "content": "Hello"}])
vectors = c.inference.embeddings(["flood alert"])
route = c.inference.route("water rising", {"ops": "dispatch", "alert": "notify"})`,
    go: `chat, err := c.InferenceChat([]synapseone.ChatMessage{{Role: "user", Content: "Hello"}})
if err != nil { log.Fatal(err) }
vectors, err := c.InferenceEmbeddings([]string{"flood alert"})
if err != nil { log.Fatal(err) }
route, err := c.InferenceRoute("water rising", map[string]string{"ops": "dispatch", "alert": "notify"})
if err != nil { log.Fatal(err) }`,
    rust: `let chat = c.inference()
    .chat(json!([{"role":"user","content":"Hello"}]), None, None, None, None)
    .await?;
let vectors = c.inference().embeddings(json!(["flood alert"]), None).await?;
let route = c.inference()
    .route("water rising", json!({"ops":"dispatch","alert":"notify"}), "")
    .await?;`,
  },
  lds: {
    javascript: `const licenses = await c.lds.licenses();
const ds = await c.lds.createDatasource({
  name: 'Business Registry',
  entityType: 'Organization',
  license: 'CC-BY-4.0',
});`,
    python: `licenses = c.lds.list_licenses()
ds = c.lds.create_datasource(
    "Business Registry",
    entity_type="Organization",
    license="CC-BY-4.0",
)`,
    go: `licenses, err := c.ListLDSLicenses()
if err != nil { log.Fatal(err) }
ds, err := c.CreateLDSDatasource(map[string]any{
    "name": "Business Registry",
    "entityType": "Organization",
    "license": "CC-BY-4.0",
})
if err != nil { log.Fatal(err) }`,
    rust: `let licenses = c.lds().list_licenses().await?;
let ds = c.lds()
    .create_datasource(
        "Business Registry", "Organization", "CC-BY-4.0",
        None, None, None, None, None, None, None,
    )
    .await?;`,
  },
  base: {
    javascript: `const collection = await c.base.createCollection({
  name: 'parks',
  mapping: { name: 'profile.name', capacity: 'profile.capacity' },
});
const doc = await c.base.createDocument('parks', {
  id: 'park-1',
  object: { name: 'Central', capacity: 120 },
});`,
    python: `collection = c.base.create_collection(
    "parks",
    mapping={"name": "profile.name", "capacity": "profile.capacity"},
)
doc = c.base.create_document(
    "parks",
    object={"name": "Central", "capacity": 120},
    id="park-1",
)`,
    go: `_, err := c.CreateBaseCollection(map[string]any{
    "name": "parks",
    "mapping": map[string]string{"name": "profile.name", "capacity": "profile.capacity"},
})
if err != nil { log.Fatal(err) }
_, err = c.CreateBaseDocument("parks", synapseone.BaseDocumentInput{
    ID: "park-1",
    Object: map[string]any{"name": "Central", "capacity": 120},
})
if err != nil { log.Fatal(err) }`,
    rust: `let collection = c.base()
    .create_collection(
        "parks", None,
        Some(json!({"name":"profile.name","capacity":"profile.capacity"})),
        None, None,
    )
    .await?;
let doc = c.base()
    .create_document("parks", json!({"name":"Central","capacity":120}), Some("park-1"))
    .await?;`,
  },
  search: {
    javascript: `const results = await c.search.hybrid('central park', { collections: ['parks'], limit: 10 });
const status = await c.search.status();`,
    python: `results = c.base.search_hybrid("central park", collections=["parks"], limit=10)
status = c.base.search_status()`,
    go: `results, err := c.Search(synapseone.SearchQuery{
    Query: "central park",
    Mode: "hybrid",
    Collections: []string{"parks"},
    Limit: 10,
})
if err != nil { log.Fatal(err) }
status, err := c.SearchStatus()
if err != nil { log.Fatal(err) }`,
    rust: `let results = c.base().search_hybrid("central park").await?;
let status = c.base().search_status().await?;`,
  },
  faststore: {
    javascript: `await c.faststore.set('session:42', { userId: 42 }, { ttlSeconds: 900 });
const item = await c.faststore.get('session:42');`,
    python: `c.faststore.set("session:42", {"userId": 42}, ttl_seconds=900)
item = c.faststore.get("session:42")`,
    go: `_, err := c.FaststoreSet("session:42", map[string]any{"userId": 42},
    synapseone.FaststoreSetOptions{TTLSeconds: 900})
if err != nil { log.Fatal(err) }
item, err := c.FaststoreGet("session:42")
if err != nil { log.Fatal(err) }`,
    rust: `c.faststore()
    .set("session:42", json!({"userId":42}), Some(900), false, false)
    .await?;
let item = c.faststore().get("session:42").await?;`,
  },
  queue: {
    javascript: `await c.queue.createQueue('emails', { maxAttempts: 5, visibilityTimeoutSeconds: 30 });
const message = await c.queue.publish('emails', { to: 'alice@acme.test' }, { dedupeKey: 'welcome:alice' });`,
    python: `c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=30)
message = c.queue.publish(
    "emails",
    {"to": "alice@acme.test"},
    dedupe_key="welcome:alice",
)`,
    go: `_, err := c.CreateQueue("emails", synapseone.QueueConfig{
    MaxAttempts: 5, VisibilityTimeoutSeconds: 30,
})
if err != nil { log.Fatal(err) }
message, err := c.PublishMessage("emails", map[string]any{"to":"alice@acme.test"},
    synapseone.QueuePublishOptions{DedupeKey: "welcome:alice"})
if err != nil { log.Fatal(err) }`,
    rust: `c.queue().create_queue("emails", Some(5), Some(30)).await?;
let message = c.queue()
    .publish(
        "emails", json!({"to":"alice@acme.test"}),
        None, None, None, None, Some("welcome:alice"),
    )
    .await?;`,
  },
  stream: {
    javascript: `await c.stream.createTopic('telemetry', { maxLen: 100000, retentionMs: 86400000 });
const event = await c.stream.publish('telemetry', { sensor: 'temp-1', value: 25.4 }, { key: 'sensor-1' });`,
    python: `c.stream.create_topic("telemetry", max_len=100000, retention_ms=86400000)
event = c.stream.publish(
    "telemetry",
    {"sensor": "temp-1", "value": 25.4},
    key="sensor-1",
)`,
    go: `_, err := c.CreateStreamTopic("telemetry", 100000, "", 86400000)
if err != nil { log.Fatal(err) }
event, err := c.PublishStreamEvent("telemetry", map[string]any{"sensor":"temp-1","value":25.4},
    synapseone.StreamPublishOptions{Key: "sensor-1"})
if err != nil { log.Fatal(err) }`,
    rust: `c.stream()
    .create_topic("telemetry", Some(100000), None, Some(86400000))
    .await?;
let event = c.stream()
    .publish("telemetry", json!({"sensor":"temp-1","value":25.4}), Some("sensor-1"), None, None)
    .await?;`,
  },
  ocs: {
    javascript: `await c.ocs.createBucket('city-assets', { quotaBytes: 1024 ** 3 });
const object = await c.ocs.putObject('city-assets', 'hello.txt', 'hello', { contentType: 'text/plain' });
const signed = await c.ocs.presign('city-assets', 'hello.txt', { method: 'GET', expiresIn: 900 });`,
    python: `c.ocs.create_bucket("city-assets", quota_bytes=1024 ** 3)
obj = c.ocs.put_object("city-assets", "hello.txt", b"hello", content_type="text/plain")
signed = c.ocs.presign("city-assets", "hello.txt", method="GET", expires_in=900)`,
    go: `_, err := c.CreateOcsBucket("city-assets", 1<<30)
if err != nil { log.Fatal(err) }
_, err = c.PutOcsObject("city-assets", "hello.txt", []byte("hello"), "text/plain", "")
if err != nil { log.Fatal(err) }
signed, err := c.PresignOcs("city-assets", "hello.txt", "GET", 900)
if err != nil { log.Fatal(err) }`,
    rust: `c.ocs().create_bucket("city-assets", Some(1 << 30)).await?;
let object = c.ocs()
    .put_object("city-assets", "hello.txt", "hello".into(), "text/plain", None)
    .await?;
let signed = c.ocs()
    .presign("city-assets", "hello.txt", "GET", 900)
    .await?;`,
  },
  notifications: {
    javascript: `const result = await c.notifications.send({
  channels: ['email'],
  recipient: { email: 'ops@example.com' },
  subject: 'Flood alert',
  body: 'Level {{level}}m',
  data: { level: 2.5 },
  idempotencyKey: 'alert:s1',
});`,
    python: `result = c.notifications.send(
    channels=["email"],
    recipient={"email": "ops@example.com"},
    subject="Flood alert",
    body="Level {{level}}m",
    data={"level": 2.5},
    idempotency_key="alert:s1",
)`,
    go: `result, err := c.SendNotification(synapseone.SendNotificationInput{
    Channels: []string{"email"},
    Recipient: synapseone.NotificationRecipient{Email: "ops@example.com"},
    Subject: "Flood alert",
    Body: "Level {{level}}m",
    Data: map[string]any{"level": 2.5},
    IdempotencyKey: "alert:s1",
})
if err != nil { log.Fatal(err) }`,
    rust: `let result = c.notifications()
    .send(
        json!({"email":"ops@example.com"}),
        "Level {{level}}m",
        None,
        Some(vec!["email".to_string()]),
        "Flood alert",
        Some(json!({"level":2.5})),
        Some("alert:s1"),
    )
    .await?;`,
  },
  warehouse: {
    javascript: `const dataset = await c.warehouse.createDataset({
  id: 'parks',
  name: 'Parks',
  columns: [{ name: 'document_id', type: 'string' }, { name: 'capacity', type: 'number' }],
});
await c.warehouse.ingest('parks', [{ document_id: 'park-1', capacity: 120 }]);
const rows = await c.warehouse.query('SELECT * FROM parks LIMIT 20', { limit: 20 });`,
    python: `dataset = c.warehouse.create_dataset({
    "id": "parks",
    "name": "Parks",
    "columns": [
        {"name": "document_id", "type": "string"},
        {"name": "capacity", "type": "number"},
    ],
})
c.warehouse.ingest("parks", [{"document_id": "park-1", "capacity": 120}])
rows = c.warehouse.query("SELECT * FROM parks LIMIT 20", limit=20)`,
    go: `_, err := c.CreateWarehouseDataset(map[string]any{
    "id": "parks", "name": "Parks",
    "columns": []map[string]any{
        {"name":"document_id","type":"string"},
        {"name":"capacity","type":"number"},
    },
})
if err != nil { log.Fatal(err) }
_, err = c.IngestWarehouseRows("parks", []map[string]any{{"document_id":"park-1","capacity":120}})
if err != nil { log.Fatal(err) }
rows, err := c.QueryWarehouse("SELECT * FROM parks LIMIT 20", 20)
if err != nil { log.Fatal(err) }`,
    rust: `let dataset = c.warehouse()
    .create_dataset(json!({
        "id":"parks", "name":"Parks",
        "columns":[
            {"name":"document_id","type":"string"},
            {"name":"capacity","type":"number"}
        ]
    }))
    .await?;
c.warehouse()
    .ingest("parks", json!([{"document_id":"park-1","capacity":120}]))
    .await?;
let rows = c.warehouse()
    .query("SELECT * FROM parks LIMIT 20", Some(20))
    .await?;`,
  },
  lakehouse: {
    javascript: `await c.lakehouse.createNamespace('analytics');
await c.lakehouse.createTable('analytics', {
  name: 'events',
  schema: [{ name: 'id', type: 'string' }, { name: 'value', type: 'long' }],
});
const snapshot = await c.lakehouse.append('analytics', 'events', [{ id: 'a', value: 1 }], 'batch-1');
const rows = await c.lakehouse.query('analytics', 'events', { limit: 100 });`,
    python: `c.lakehouse.create_namespace("analytics")
c.lakehouse.create_table(
    "analytics",
    "events",
    [{"name":"id","type":"string"},{"name":"value","type":"long"}],
)
snapshot = c.lakehouse.append(
    "analytics", "events", [{"id":"a","value":1}], idempotency_key="batch-1"
)
rows = c.lakehouse.query("analytics", "events", limit=100)`,
    go: `_, err := c.LakehouseCreateNamespace("analytics")
if err != nil { log.Fatal(err) }
_, err = c.LakehouseCreateTable("analytics", map[string]any{
    "name": "events",
    "schema": []map[string]any{{"name":"id","type":"string"},{"name":"value","type":"long"}},
})
if err != nil { log.Fatal(err) }
snapshot, err := c.LakehouseAppend("analytics", "events", []map[string]any{{"id":"a","value":1}}, "batch-1")
if err != nil { log.Fatal(err) }
rows, err := c.LakehouseQuery("analytics", "events", 100, "")
if err != nil { log.Fatal(err) }`,
    rust: `c.lakehouse().create_namespace("analytics").await?;
c.lakehouse()
    .create_table("analytics", json!({
        "name":"events",
        "schema":[{"name":"id","type":"string"},{"name":"value","type":"long"}]
    }))
    .await?;
let snapshot = c.lakehouse()
    .append("analytics", "events", json!([{"id":"a","value":1}]), Some("batch-1"))
    .await?;
let rows = c.lakehouse()
    .query("analytics", "events", Some(100), None)
    .await?;`,
    generic: [],
  },
};

const SDK_NAMESPACES = [
  ['gateway', 'c.health', 'c.health', 'Client.Health / Ready', 'c.health()'],
  ['dns', 'fetch', 'urllib.request', 'net/http', 'reqwest'],
  ['tunnel', 'fetch + node:http', 'urllib.request', 'net/http', 'reqwest'],
  ['iam', 'c.iam', 'c.iam', 'Client.*', 'c.iam()'],
  ['workflow', 'c.workflow', 'c.workflow', 'Client.*Workflow*', 'c.workflow()'],
  ['runner', 'c.workflow', 'c.workflow', 'Client.Call', 'c.workflow()'],
  ['ai', 'c.ai', 'c.ai', 'Client.AIAgent', 'c.ai()'],
  ['inference', 'c.inference', 'c.inference', 'Client.Inference*', 'c.inference()'],
  ['lds', 'c.lds', 'c.lds', 'Client.*LDS*', 'c.lds()'],
  ['base', 'c.base', 'c.base', 'Client.*Base*', 'c.base()'],
  ['search', 'c.search', 'c.base.search_*', 'Client.Search*', 'c.base().search_*'],
  ['faststore', 'c.faststore', 'c.faststore', 'Client.Faststore*', 'c.faststore()'],
  ['queue', 'c.queue', 'c.queue', 'Client.*Queue*', 'c.queue()'],
  ['stream', 'c.stream', 'c.stream', 'Client.*Stream*', 'c.stream()'],
  ['ocs', 'c.ocs', 'c.ocs', 'Client.*Ocs*', 'c.ocs()'],
  ['notifications', 'c.notifications', 'c.notifications', 'Client.*Notification*', 'c.notifications()'],
  ['warehouse', 'c.warehouse', 'c.warehouse', 'Client.*Warehouse*', 'c.warehouse()'],
  ['lakehouse', 'c.lakehouse', 'c.lakehouse', 'Client.Lakehouse*', 'c.lakehouse()'],
];

const CLIENT_DOCS = {
  javascript: {
    package: '@synapseone/sdk',
    install: `npm install @synapseone/sdk
# or: yarn add @synapseone/sdk
# or: pnpm add @synapseone/sdk`,
    auth: SDK_SETUP.javascript,
    errors: `import { SynapseOneError } from '@synapseone/sdk';

try {
  await c.base.getDocument('parks', 'missing');
} catch (error) {
  if (error instanceof SynapseOneError) {
    console.error(error.status, error.code, error.body);
  }
}

// Forward-compatible escape hatch:
await c.call('GET', '/v1/base/collections');`,
  },
  python: {
    package: 'synapseone-sdk',
    install: `pip install synapseone-sdk
# or: python -m venv .venv && source .venv/bin/activate
#     pip install synapseone-sdk`,
    auth: SDK_SETUP.python,
    errors: `from synapseone_sdk import SynapseOneError

try:
    c.base.get_document("parks", "missing")
except SynapseOneError as error:
    print(error.status, error.code, error.body)

# Forward-compatible escape hatch:
c.call("GET", "/v1/base/collections")`,
  },
  go: {
    package: 'github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go',
    install: `go get github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go@latest
// Go 1.22+; the client uses the standard library.`,
    auth: SDK_SETUP.go,
    errors: `// Inside func main(); imports: "errors", "log", and synapseone.
result, err := c.GetBaseDocument("parks", "missing", "object")
if err != nil {
    var apiErr *synapseone.APIError
    if errors.As(err, &apiErr) {
        log.Printf("status=%d code=%s path=%s", apiErr.StatusCode, apiErr.Code, apiErr.Path)
    }
}

// Forward-compatible escape hatch:
result, err = c.Call("GET", "/v1/base/collections", nil)`,
  },
  rust: {
    package: 'synapseone',
    install: `cargo add synapseone
# Cargo.toml: synapseone = "0.10.2"
# Rust 1.82+; async client built on reqwest and tokio.`,
    auth: SDK_SETUP.rust,
    errors: `match c.base().get_collection("missing").await {
    Ok(collection) => println!("{collection}"),
    Err(error) => eprintln!("{} {:?}", error, error.code()),
}

// Raw gateway request escape hatch:
let value = c.client()
    .post("/v1/base/collections", json!({"name":"parks"}))
    .await?;`,
  },
};

const CLI_CODES = {
  install: `# One-line installer
curl -fsSL https://synapseone.space/install.sh | sh

# npm registry
npm install -g @synapseone/cli@latest

# Configuration precedence:
# --base > $SYNAPSEONE_BASE_URL > ~/.synapseone/config.json > localhost:8080
synapseone config`,
  auth: `synapseone login --email demo@acme.local --org acme
synapseone whoami
synapseone orgs
synapseone accounts create prod Production
synapseone keys create <account> --name ci
synapseone audit --limit 20`,
  data: `# Base and Search
synapseone base collections create parks
synapseone base documents insert parks --id park-1 --data '{"name":"Central"}'
synapseone search "central park" --mode hybrid --collection parks

# Faststore, Queue and Stream
synapseone faststore set cache:demo --value '{"ok":true}' --ttl 300
synapseone queue send emails --payload '{"to":"a@b.c"}'
synapseone stream publish telemetry --payload '{"value":25.4}'

# OCS and Notifications
synapseone ocs put city-assets hello.txt --file ./hello.txt
synapseone notifications send a@b.c --channel email --subject Hi --body Hello`,
  analytics: `# Warehouse
synapseone warehouse dataset create parks --column id:string --column capacity:number
synapseone warehouse query --sql 'SELECT * FROM parks LIMIT 20'

# Lakehouse
synapseone lakehouse namespaces create analytics
synapseone lakehouse create analytics events --schema '[{"name":"id","type":"string"}]'
synapseone lakehouse append analytics events --rows '[{"id":"a"}]' --idempotency-key batch-1
synapseone lakehouse query analytics events --limit 100

# Runner Engine
synapseone runners create --name edge-runner --account <account-id> --mode custom
synapseone runners list`,
};

const GUIDE_ICONS = {
  gateway: Cloud, dns: Cloud, tunnel: Network, iam: ShieldCheck, workflow: GitBranch, runner: Boxes, ai: Brain, inference: Brain,
  lds: Network, base: Database, search: Zap, faststore: Gauge, queue: Inbox, stream: Radio,
  ocs: Cloud, notifications: Bell, warehouse: Boxes, lakehouse: Boxes,
  javascript: FileCode2, python: FileCode2, go: Boxes, rust: FileCode2, cli: FileCode2,
};
const GUIDE_CARD = 'group flex w-full items-center gap-3 rounded-xl border border-s1-line bg-s1-surface px-4 py-3 text-left text-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md hover:shadow-sky-500/10 dark:hover:border-sky-700';
const GUIDE_ICON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-white';

function Overview({ setTab }) {
  const { m } = useI18n();
  const d = m.docsPage;
  const guides = [...SERVICE_CATALOG, ...CLIENT_TABS];
  return (
    <div className="space-y-10">
      <DocHeader kicker={d.overviewKicker} title={d.overviewTitle}><p>{d.overviewLead}</p></DocHeader>
      <section aria-label={d.startHere}>
        <p className="text-sm font-semibold text-s1-fg">{d.startHere}</p>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {guides.map(({ id }) => {
            const Icon = GUIDE_ICONS[id];
            return (
              <li key={id}>
                <button type="button" onClick={() => setTab(id)} className={GUIDE_CARD}>
                  <span className={GUIDE_ICON}><Icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1 font-medium text-s1-fg">{d.guides[id]}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-s1-muted transition group-hover:translate-x-0.5 group-hover:text-s1-accent" />
                </button>
              </li>
            );
          })}
          <li>
            <Link to="/api-docs" className={GUIDE_CARD}>
              <span className={GUIDE_ICON}><Zap className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1 font-medium text-s1-fg">{d.tryApi}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-s1-muted" />
            </Link>
          </li>
        </ul>
      </section>

      <DocSection title={d.overview.serviceMapTitle} kicker={d.overview.serviceMapKicker}>
        <DocTable head={[d.tableHeaders.service, d.tableHeaders.port, d.tableHeaders.prefix, d.tableHeaders.responsibility]}>
          {SERVICE_CATALOG.map((svc) => (
            <tr key={svc.id} className="border-t border-s1-line align-top">
              <td className="px-4 py-2.5 text-xs font-medium text-s1-fg whitespace-nowrap">{m.services[svc.id].label}</td>
              <td className="px-4 py-2.5 text-xs tabular-nums">{svc.port}</td>
              <td className="px-4 py-2.5 text-xs"><code className="break-all font-mono text-[11px] text-s1-fg">{svc.prefix}</code></td>
              <td className="px-4 py-2.5 text-xs">{m.services[svc.id].desc}</td>
            </tr>
          ))}
        </DocTable>
      </DocSection>

      <DocSection title={d.overview.runStackTitle} kicker={d.overview.runStackKicker}>
        <Text>{d.overview.runStackLead}</Text>
        <DocCode data={OVERVIEW_RUN} />
      </DocSection>

      <DocSection title={d.overview.authTitle} kicker={d.overview.authKicker}>
        <Bullets items={d.overview.authItems} />
      </DocSection>

      <DocSection title={d.overview.namespaceTitle} kicker={d.overview.namespaceKicker}>
        <Text>{d.overview.namespaceLead}</Text>
        <DocTable head={[d.tableHeaders.namespace, d.tableHeaders.javascript, d.tableHeaders.python, d.tableHeaders.go, d.tableHeaders.rust]}>
          {SDK_NAMESPACES.map(([id, javascript, python, go, rust]) => (
            <tr key={id} className="border-t border-s1-line align-top">
              <td className="px-4 py-2.5 text-xs font-medium text-s1-fg whitespace-nowrap">{m.services[id].label}</td>
              {[javascript, python, go, rust].map((value) => <td key={value} className="px-4 py-2.5"><code className="font-mono text-[11px] text-s1-fg">{value}</code></td>)}
            </tr>
          ))}
        </DocTable>
      </DocSection>
    </div>
  );
}

function SdkExamples({ service }) {
  const { m } = useI18n();
  const d = m.docsPage;
  const [language, setLanguage] = useState('javascript');
  const examples = SDK_EXAMPLES[service];
  const languages = Object.keys(d.languages);
  return (
    <DocSection title={d.sdkUsage} kicker={d.sdkKicker}>
      <Text>{d.sdkIntro}</Text>
      {examples.generic?.length > 0 && <Text>{d.sdkGenericCall}</Text>}
      <div role="tablist" aria-label={d.sdkUsage} className="flex flex-wrap gap-2">
        {languages.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={language === id}
            aria-controls={`sdk-${service}-${id}`}
            onClick={() => setLanguage(id)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${language === id ? 'border-s1-accent bg-s1-accent-soft font-medium text-s1-accent' : 'border-s1-line bg-s1-surface text-s1-muted hover:text-s1-fg'}`}
          >
            {d.languages[id]}
          </button>
        ))}
      </div>
      {languages.map((id) => (
        <div
          key={id}
          id={`sdk-${service}-${id}`}
          role="tabpanel"
          data-sdk-panel={id}
          hidden={language !== id}
        >
          <DocCode data={`${examples.setup?.[id] ?? SDK_SETUP[id]}\n\n${examples[id]}`} label={d.languages[id]} />
        </div>
      ))}
    </DocSection>
  );
}

function ServiceDoc({ service }) {
  const { m } = useI18n();
  const d = m.docsPage;
  const meta = SERVICE_DOCS[service];
  const copy = d.serviceDocs[service];
  return (
    <div className="space-y-10">
      <DocHeader title={copy.title} kicker={copy.kicker}>
        <Text>{copy.lead}</Text>
        <Bullets items={copy.highlights} />
      </DocHeader>
      {meta.sections.map((key) => {
        const title = key === 'api' ? d.sectionTitles.api : key === 'semantics' ? d.sectionTitles.semantics : d.sectionTitles[key];
        const kicker = key === 'api' ? d.sectionKickers.api : key === 'semantics' ? d.sectionKickers.semantics : d.sectionKickers[key];
        return (
          <DocSection key={key} title={title} kicker={kicker}>
            {key === 'api' ? <EndpointTable rows={meta.endpoints} purposes={copy.purposes} headers={d.tableHeaders} /> : key === 'semantics' ? <Bullets items={copy.semantics} /> : <DocCode data={meta.codes[key]} />}
          </DocSection>
        );
      })}
      <SdkExamples service={service} />
    </div>
  );
}

function ClientDoc({ language }) {
  const { m } = useI18n();
  const d = m.docsPage;
  const doc = CLIENT_DOCS[language];
  return (
    <div className="space-y-10">
      <DocHeader title={d.clientTitles[language]} kicker={`${d.sdkKicker} · ${doc.package}`} />
      <DocSection title={d.clientSections.install}><DocCode data={doc.install} /></DocSection>
      <DocSection title={d.clientSections.auth}><DocCode data={doc.auth} /></DocSection>
      <DocSection title={d.clientSections.services}>
        <Text>{d.clientServicesLead}</Text>
        <ul className="grid gap-2 sm:grid-cols-2">
          {SERVICE_CATALOG.map((svc) => (
            <li key={svc.id}>
              <Link to={`/docs?tab=${svc.docsTab}`} className="inline-flex items-center gap-2 text-s1-accent hover:underline">
                {m.services[svc.id].label}<ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </li>
          ))}
        </ul>
      </DocSection>
      <DocSection title={d.clientSections.errors}><DocCode data={doc.errors} /></DocSection>
    </div>
  );
}

function CliDoc() {
  const { m } = useI18n();
  const d = m.docsPage;
  return (
    <div className="space-y-10">
      <DocHeader title={d.clientTitles.cli} kicker={`${d.cliKicker} · synapseone`} />
      {['install', 'auth', 'data', 'analytics'].map((key) => (
        <DocSection key={key} title={d.cliSections[key]}><DocCode data={CLI_CODES[key]} /></DocSection>
      ))}
    </div>
  );
}

export default function Docs() {
  const { m } = useI18n();
  const d = m.docsPage;
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = DOC_TABS.some((item) => item.id === requested) ? requested : 'overview';
  const setTab = (id) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };
  useEffect(() => {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }, [tab]);

  const label = (id) => d.tabs[id];
  let content;
  if (tab === 'overview') content = <Overview setTab={setTab} />;
  else if (SERVICE_DOCS[tab]) content = <ServiceDoc service={tab} />;
  else if (CLIENT_DOCS[tab]) content = <ClientDoc language={tab} />;
  else content = <CliDoc />;

  const nav = DOC_GROUPS.map((group) => ({
    title: d.groups[group],
    items: DOC_TABS.filter((item) => item.group === group).map((item) => ({
      id: item.id,
      label: label(item.id),
      active: item.id === tab,
      to: `/docs?tab=${item.id}`,
    })),
  }));
  nav.push({ title: d.groups.more, items: [{ id: 'api', label: m.nav.apiDocs, to: '/api-docs' }] });

  const index = DOC_TABS.findIndex((item) => item.id === tab);
  const prev = DOC_TABS[index - 1];
  const next = DOC_TABS[index + 1];
  return (
    <DocsShell navLabel={d.navLabel} nav={nav} toc tocKey={`${tab}:${m.meta.title}`}>
      <div role="region" aria-label={label(tab)}>{content}</div>
      <nav className="mt-14 grid gap-3 border-t border-s1-line pt-6 sm:grid-cols-2" aria-label={`${d.prev} / ${d.next}`}>
        {prev ? (
          <button type="button" onClick={() => setTab(prev.id)} className={PAGER}>
            <span className="text-xs text-s1-muted">{d.prev}</span>
            <span className="mt-1 flex items-center gap-2 font-medium text-s1-fg group-hover:text-s1-accent"><ArrowLeft className="h-4 w-4" />{label(prev.id)}</span>
          </button>
        ) : <span className="hidden sm:block" />}
        {next && (
          <button type="button" onClick={() => setTab(next.id)} className={`${PAGER} sm:items-end sm:text-right`}>
            <span className="text-xs text-s1-muted">{d.next}</span>
            <span className="mt-1 flex items-center gap-2 font-medium text-s1-fg group-hover:text-s1-accent">{label(next.id)}<ArrowRight className="h-4 w-4" /></span>
          </button>
        )}
      </nav>
    </DocsShell>
  );
}

const PAGER = 'group flex flex-col items-start rounded-xl border border-s1-line bg-s1-surface px-4 py-3 text-left transition hover:border-s1-accent';
