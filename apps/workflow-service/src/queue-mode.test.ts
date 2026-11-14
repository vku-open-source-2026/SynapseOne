// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Queue transport + self-hosted runner protocol tests.
 * A tiny in-memory SynapseQueue stand-in keeps the test dependency-free while
 * exercising the real publish/consume/claim/complete flow.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp, makeCredentialResolver, synapseoneCall } from './index';
import { __clearMem, createExecutionRec, updateWorkflowRec } from './store';
import { startPlatformWorker } from './worker';

const INTERNAL = 'test-internal-secret';
const USER = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'operator@example.com',
  'x-synapseone-org': 'org-1',
  'x-synapseone-account': 'acc-1',
  'x-synapseone-kind': 'user',
};
const RUNNER_AUTH = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-kind': 'apikey',
  'x-synapseone-org': 'org-1',
  'x-synapseone-account': 'acc-1',
};

interface MockMessage {
  id: string;
  payload: any;
  availableAt: number;
  attempts: number;
  receipt?: string;
  leaseUntil?: number;
}

function createMockQueue() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const queues = new Map<string, Map<string, MockMessage>>();
  const receipts = new Map<string, { queue: string; id: string }>();
  const dedupe = new Map<string, string>();
  const published: any[] = [];

  const queue = (name: string) => {
    if (!queues.has(name)) queues.set(name, new Map());
    return queues.get(name)!;
  };
  let seq = 0;
  const id = () => `msg-${++seq}`;

  app.put('/v1/queue/queues/:queue', (req, res) => res.status(201).json({ name: req.params.queue }));
  app.post('/v1/queue/queues/:queue/messages', (req, res) => {
    const q = queue(req.params.queue);
    const dedupeKey = req.body?.dedupeKey;
    if (dedupeKey && dedupe.has(`${req.params.queue}:${dedupeKey}`)) {
      const existing = dedupe.get(`${req.params.queue}:${dedupeKey}`)!;
      return res.status(200).json({ id: existing, duplicate: true });
    }
    const mid = id();
    q.set(mid, {
      id: mid,
      payload: req.body.payload,
      availableAt: Date.now() + (Number(req.body.delaySeconds) || 0) * 1000,
      attempts: 0,
    });
    if (dedupeKey) dedupe.set(`${req.params.queue}:${dedupeKey}`, mid);
    published.push({ queue: req.params.queue, payload: req.body.payload });
    res.status(201).json({ ok: true, id: mid, duplicate: false });
  });
  app.post('/v1/queue/queues/:queue/consume', (req, res) => {
    const q = queue(req.params.queue);
    const now = Date.now();
    const wanted = Math.min(Math.max(Number(req.body?.maxMessages) || 1, 1), 100);
    const out: any[] = [];
    for (const m of q.values()) {
      if (out.length >= wanted) break;
      if (m.availableAt > now) continue;
      if (m.leaseUntil && m.leaseUntil > now) continue;
      m.attempts += 1;
      m.receipt = `r-${m.id}-${m.attempts}`;
      m.leaseUntil = now + (Number(req.body?.visibilityTimeoutSeconds) || 30) * 1000;
      receipts.set(m.receipt, { queue: req.params.queue, id: m.id });
      out.push({ ...m, receipt: m.receipt, leaseExpiresAt: new Date(m.leaseUntil).toISOString() });
    }
    res.json({ queue: req.params.queue, count: out.length, messages: out });
  });
  app.post('/v1/queue/queues/:queue/ack', (req, res) => {
    const r = receipts.get(String(req.body?.receipt || ''));
    if (!r) return res.status(404).json({ error: 'receipt_not_found' });
    queue(r.queue).delete(r.id);
    receipts.delete(String(req.body.receipt));
    res.json({ ok: true });
  });
  app.post('/v1/queue/queues/:queue/nack', (req, res) => {
    const r = receipts.get(String(req.body?.receipt || ''));
    if (!r) return res.status(404).json({ error: 'receipt_not_found' });
    const m = queue(r.queue).get(r.id);
    if (m) {
      m.leaseUntil = undefined;
      m.receipt = undefined;
      m.availableAt = Date.now() + (Number(req.body?.delaySeconds) || 0) * 1000;
    }
    receipts.delete(String(req.body.receipt));
    res.json({ ok: true });
  });
  app.post('/v1/queue/queues/:queue/heartbeat', (req, res) => {
    const r = receipts.get(String(req.body?.receipt || ''));
    if (!r) return res.status(404).json({ error: 'receipt_not_found' });
    const m = queue(r.queue).get(r.id);
    if (m) m.leaseUntil = Date.now() + (Number(req.body?.visibilityTimeoutSeconds) || 30) * 1000;
    res.json({ ok: true, leaseExpiresAt: new Date(m?.leaseUntil || Date.now()).toISOString() });
  });
  app.get('/v1/queue/queues/:queue/stats', (req, res) => {
    res.json({ queue: req.params.queue, ready: queue(req.params.queue).size });
  });

  return { app, published, queues };
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` });
    });
  });
}

async function waitFor(fn: () => Promise<any>, timeoutMs = 6000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe('queue-backed workflow execution + self-hosted runners', () => {
  let mock: ReturnType<typeof createMockQueue>;
  let mockServer: Server;
  let shimServer: Server;
  let shimBase = '';
  let server: Server;
  let base = '';
  let worker: ReturnType<typeof startPlatformWorker> | null = null;

  before(async () => {
    mock = createMockQueue();
    const mockList = await listen(mock.app);
    mockServer = mockList.server;
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    process.env.QUEUE_SERVICE_URL = mockList.base;
    process.env.WORKFLOW_EXECUTION_MODE = 'queue';
    process.env.WORKFLOW_WORKER_POLL_MS = '50';
    process.env.WORKFLOW_QUEUE_VISIBILITY_SECONDS = '60';
    __clearMem();
    const app = createApp();
    const list = await listen(app);
    server = list.server;
    base = list.base;
    worker = startPlatformWorker({ synapseoneCall, makeCredentialResolver });

    // Public-gateway stand-in: verifies the runner API key and stamps the
    // tenant headers the real gateway would set after IAM verification.
    const shim = express();
    shim.use(express.json({ limit: '2mb' }));
    shim.all('*', async (req: any, res: any) => {
      if (String(req.headers['x-api-key'] || '') !== 'sk-runner-e2e') {
        return res.status(401).json({ error: 'invalid_api_key' });
      }
      if (req.path === '/v1/auth/verify') {
        return res.json({
          valid: true,
          type: 'apikey',
          scopes: ['workflow:*', 'queue:*', '*:read', 'base:query', 'base:vector-search', 'inference:*'],
        });
      }
      const target = req.path.startsWith('/v1/queue/') ? mockList.base : list.base;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-synapseone-internal': INTERNAL,
        'x-synapseone-kind': 'apikey',
        'x-synapseone-org': 'org-1',
        'x-synapseone-account': 'acc-1',
      };
      if (req.headers['x-workflow-runner-id']) headers['x-workflow-runner-id'] = String(req.headers['x-workflow-runner-id']);
      const r = await fetch(`${target}${req.originalUrl}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {}),
      });
      const text = await r.text();
      res.status(r.status).type('application/json').send(text);
    });
    const shimList = await listen(shim);
    shimServer = shimList.server;
    shimBase = shimList.base;
  });

  after(async () => {
    worker?.stop();
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    delete process.env.QUEUE_SERVICE_URL;
    delete process.env.WORKFLOW_EXECUTION_MODE;
    delete process.env.WORKFLOW_WORKER_POLL_MS;
    delete process.env.WORKFLOW_QUEUE_VISIBILITY_SECONDS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => shimServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  async function createWorkflow(mode: 'platform' | 'custom' | 'hybrid', name: string): Promise<any> {
    const res = await fetch(`${base}/v1/workflows`, {
      method: 'POST',
      headers: USER,
      body: JSON.stringify({
        name,
        settings: { execution: { mode } },
        definition: {
          nodes: [
            { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
            { id: 'set', name: 'Echo', type: 'n8n-nodes-base.set', parameters: { values: { doubled: '={{ $json.value * 2 }}' } } },
          ],
          connections: { Start: { main: [[{ node: 'Echo' }]] } },
        },
      }),
    });
    assert.equal(res.status, 201, 'create workflow failed');
    const text = await res.text();
    assert.ok(text, 'create workflow returned an empty body');
    return JSON.parse(text);
  }

  it('queues a manual run and the platform worker completes it', async () => {
    const wf = await createWorkflow('platform', 'queue-platform');
    const res = await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ value: 21 }),
    });
    assert.equal(res.status, 202);
    const queued: any = await res.json();
    assert.equal(queued.queued, true);
    assert.equal(queued.queue, 'synapseone-wf-platform');
    assert.ok(queued.executionId);
    // The message must not carry workflow input or the definition.
    const msg = mock.published.find((m) => m.payload?.executionId === queued.executionId);
    assert.deepEqual(Object.keys(msg.payload).sort(), ['executionId', 'kind', 'v']);

    const exec: any = await waitFor(async () => {
      const r = await fetch(`${base}/v1/executions/${queued.executionId}?includeData=true`, { headers: USER });
      const body: any = await r.json();
      return body.status === 'success' ? body : null;
    });
    assert.equal(exec.status, 'success');
    assert.equal(exec.output.doubled, 42);
    assert.equal(exec.runner, 'platform');
    assert.equal(exec.queue, 'synapseone-wf-platform');
    assert.ok(exec.workerId);
  });

  it('rejects stale and malformed execution revisions without publishing jobs', async () => {
    const wf = await createWorkflow('custom', 'revision-guard');
    const before = mock.published.length;
    for (const revision of ['0', '-1', '1.5', 'bogus', '1&expectedRevision=2']) {
      const response = await fetch(`${base}/v1/workflows/${wf.id}/execute?expectedRevision=${revision}`, {
        method: 'POST', headers: USER, body: '{}',
      });
      assert.equal(response.status, 400, revision);
    }
    const updated = await updateWorkflowRec(wf.id, { name: 'edited since approval' });
    const stale = await fetch(`${base}/v1/workflows/${wf.id}/execute?expectedRevision=${wf.revision}`, {
      method: 'POST', headers: USER, body: '{}',
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'workflow_revision_conflict');
    assert.equal(mock.published.length, before);
    const accepted = await fetch(`${base}/v1/workflows/${wf.id}/execute?expectedRevision=${updated!.revision}`, {
      method: 'POST', headers: USER, body: JSON.stringify({ value: 7 }),
    });
    assert.equal(accepted.status, 202);
    assert.equal(mock.published.length, before + 1);
  });

  it('custom runner never receives a graph changed after enqueue', async () => {
    const wf = await createWorkflow('custom', 'custom-revision-drift');
    const created = await fetch(`${base}/v1/workflow-runners`, {
      method: 'POST', headers: USER, body: JSON.stringify({ name: 'revision-runner', mode: 'custom' }),
    });
    assert.equal(created.status, 201);
    const { runner } = await created.json();
    const queued = await (await fetch(`${base}/v1/workflows/${wf.id}/execute?expectedRevision=${wf.revision}`, {
      method: 'POST', headers: USER, body: '{}',
    })).json();
    await updateWorkflowRec(wf.id, { name: 'unreviewed change' });
    const claim = await fetch(`${base}/v1/runner/jobs/${queued.executionId}/claim`, {
      method: 'POST', headers: RUNNER_AUTH, body: JSON.stringify({ runnerId: runner.id }),
    });
    assert.equal(claim.status, 409);
    const rejected = await claim.json();
    assert.equal(rejected.error, 'workflow_revision_conflict');
    assert.equal(rejected.workflow, undefined);
    const result = await (await fetch(`${base}/v1/executions/${queued.executionId}?includeData=true`, { headers: USER })).json();
    assert.equal(result.status, 'error');
    assert.equal(result.nodeRuns.length, 0);
  });

  it('platform worker rejects an edited graph before executing any node', async () => {
    const wf = await createWorkflow('platform', 'platform-revision-drift');
    const execution = await createExecutionRec({
      workflow_id: wf.id, workflow_name: wf.name, workflow_revision: wf.revision,
      status: 'queued', input: { value: 20 }, output: null, node_runs: [],
      triggered_by: 'manual', startedAt: new Date().toISOString(),
      principal: { sub: 'operator@example.com', org: 'org-1', account: 'acc-1', kind: 'user' },
      queue_name: 'synapseone-wf-platform', runner: 'platform',
    });
    await updateWorkflowRec(wf.id, { name: 'unreviewed platform edit' });
    const messages = mock.queues.get('synapseone-wf-platform') || new Map();
    messages.set(execution.id, {
      id: execution.id, payload: { kind: 'workflow.run', executionId: execution.id, v: 1 },
      availableAt: Date.now(), attempts: 0,
    });
    mock.queues.set('synapseone-wf-platform', messages);
    const result = await waitFor(async () => {
      const response = await fetch(`${base}/v1/executions/${execution.id}?includeData=true`, { headers: USER });
      const body = await response.json();
      return body.status === 'error' || body.status === 'success' ? body : null;
    });
    assert.ok(result, 'worker must finish the stale job');
    assert.equal(result.status, 'error');
    assert.match(result.error, /revision changed/);
    assert.equal(result.nodeRuns.length, 0);
  });

  it('webhooks queue instead of blocking the caller', async () => {
    const res = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({
        name: 'queue-webhook',
        settings: { execution: { mode: 'platform' } },
        definition: {
          nodes: [
            { id: 'w', name: 'Hook', type: 'n8n-nodes-base.webhook', parameters: { path: 'q-hook', httpMethod: 'POST' } },
            { id: 's', name: 'Echo', type: 'n8n-nodes-base.set', parameters: { values: { ok: true } } },
          ],
          connections: { Hook: { main: [[{ node: 'Echo' }]] } },
        },
      }),
    });
    assert.equal(res.status, 201);
    const wf: any = await res.json();
    await fetch(`${base}/v1/workflows/${wf.id}/activate`, { method: 'POST', headers: USER, body: '{}' });
    const hook = await fetch(`${base}/webhook/q-hook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ping: 1 }),
    });
    assert.equal(hook.status, 202);
    const body: any = await hook.json();
    assert.equal(body.queued, true);
  });

  it('creates a custom runner with a copy-paste command containing the API key', async () => {
    const optsRes = await fetch(`${base}/v1/workflow-runners/options`, { headers: USER });
    assert.equal(optsRes.status, 200);
    const opts: any = await optsRes.json();
    assert.equal(opts.queues.custom, 'synapseone-wf-custom');
    assert.equal(opts.platformWorker.enabled, true);
    assert.equal(opts.engineCapabilities.httpCredentialAllowedOrigins, true);
    assert.equal(opts.engineCapabilities.httpCredentialDestinationProtection, 1);

    const res = await fetch(`${base}/v1/workflow-runners`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: 'edge-runner', mode: 'custom', apiKey: 'sk-runner-secret-123' }),
    });
    assert.equal(res.status, 201);
    const body: any = await res.json();
    assert.equal(body.runner.queue, 'synapseone-wf-custom');
    assert.match(body.command, /docker run/);
    assert.match(body.command, /SYNAPSEONE_API_KEY=sk-runner-secret-123/);
    assert.match(body.command, /WORKFLOW_RUNNER_ID=/);
    assert.match(body.command, /WORKFLOW_RUNNER_HEARTBEAT_SECONDS=/);
    assert.equal(body.runner.connected, false);
    assert.equal(body.options.queues.shared, 'synapseone-wf-shared');

    const waiting = await fetch(`${base}/v1/workflow-runners/${body.runner.id}/connection`, { headers: USER });
    const waitingBody: any = await waiting.json();
    assert.equal(waitingBody.connected, false);
    assert.equal(waitingBody.status, 'waiting');
    assert.equal(waitingBody.instanceCount, 0);

    const hb = await fetch(`${base}/v1/workflow-runners/${body.runner.id}/heartbeat`, {
      method: 'POST', headers: RUNNER_AUTH,
      body: JSON.stringify({
        instanceId: 'connector-a', hostname: 'edge-1', version: 'test',
        concurrency: 3, queue: 'synapseone-wf-custom', startedAt: new Date().toISOString(),
      }),
    });
    assert.equal(hb.status, 200);
    const hbBody: any = await hb.json();
    assert.equal(hbBody.instance.id, 'connector-a');
    assert.equal(hbBody.instance.hostname, 'edge-1');
    assert.equal(hbBody.instance.concurrency, 3);

    const connected = await fetch(`${base}/v1/workflow-runners/${body.runner.id}/connection`, { headers: USER });
    const c: any = await connected.json();
    assert.equal(c.connected, true);
    assert.equal(c.status, 'connected');
    assert.equal(c.instanceCount, 1);
    assert.equal(c.connectedInstances, 1);
    assert.equal(c.instances[0].hostname, 'edge-1');

    const list = await (await fetch(`${base}/v1/workflow-runners`, { headers: USER })).json();
    const listed: any = (list.data || []).find((r: any) => r.id === body.runner.id);
    assert.equal(listed.connectedInstances, 1);
    assert.equal(listed.instances[0].id, 'connector-a');

    const offline = await fetch(`${base}/v1/workflow-runners/${body.runner.id}/heartbeat`, {
      method: 'POST', headers: RUNNER_AUTH,
      body: JSON.stringify({ instanceId: 'connector-a', status: 'offline', version: 'test' }),
    });
    assert.equal(offline.status, 200);
    const offlineConn = await (await fetch(`${base}/v1/workflow-runners/${body.runner.id}/connection`, { headers: USER })).json();
    assert.equal(offlineConn.connected, false);
    assert.equal(offlineConn.status, 'offline');

    const removed = await fetch(`${base}/v1/workflow-runners/${body.runner.id}/instances/connector-a`, { method: 'DELETE', headers: USER });
    assert.equal(removed.status, 200);
    const emptyConn = await (await fetch(`${base}/v1/workflow-runners/${body.runner.id}/connection`, { headers: USER })).json();
    assert.equal(emptyConn.instanceCount, 0);
    assert.equal(emptyConn.status, 'waiting');
  });

  it('lets a custom runner claim and complete a custom-mode execution', async () => {
    const created = await fetch(`${base}/v1/workflow-runners`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: 'worker-b', mode: 'custom' }),
    });
    const runner: any = (await created.json()).runner;

    const wf = await createWorkflow('custom', 'queue-custom');
    const res = await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ value: 5 }),
    });
    assert.equal(res.status, 202);
    const queued: any = await res.json();
    assert.equal(queued.queue, 'synapseone-wf-custom');

    // The platform worker must not have consumed the custom queue.
    await new Promise((r) => setTimeout(r, 300));
    const still: any = await (await fetch(`${base}/v1/executions/${queued.executionId}`, { headers: USER })).json();
    assert.equal(still.status, 'queued');

    const claim = await fetch(`${base}/v1/runner/jobs/${queued.executionId}/claim`, {
      method: 'POST', headers: RUNNER_AUTH,
      body: JSON.stringify({ runnerId: runner.id, leaseSeconds: 60 }),
    });
    const claimText = await claim.text();
    assert.equal(claim.status, 200, claimText);
    const job: any = JSON.parse(claimText);
    assert.equal(job.workflow.id, wf.id);
    assert.deepEqual(job.input, { value: 5 });

    const done = await fetch(`${base}/v1/runner/jobs/${queued.executionId}/complete`, {
      method: 'POST', headers: RUNNER_AUTH,
      body: JSON.stringify({ runnerId: runner.id, status: 'success', output: { doubled: 10 }, nodeRuns: [] }),
    });
    const doneText = await done.text();
    assert.equal(done.status, 200, doneText);
    const exec: any = await (await fetch(`${base}/v1/executions/${queued.executionId}`, { headers: USER })).json();
    assert.equal(exec.status, 'success');
    assert.equal(exec.runner, 'custom');
  });

  it('rejects a runner from another tenant without leaking the job', async () => {
    const other = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'apikey',
      'x-synapseone-org': 'org-2',
      'x-synapseone-account': 'acc-2',
    };
    const created = await fetch(`${base}/v1/workflow-runners`, {
      method: 'POST', headers: { ...USER, 'x-synapseone-org': 'org-2', 'x-synapseone-account': 'acc-2' },
      body: JSON.stringify({ name: 'other-worker', mode: 'custom' }),
    });
    const runner: any = (await created.json()).runner;
    const wf = await createWorkflow('custom', 'queue-foreign');
    const queued: any = await (await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: '{}',
    })).json();
    const claim = await fetch(`${base}/v1/runner/jobs/${queued.executionId}/claim`, {
      method: 'POST', headers: other,
      body: JSON.stringify({ runnerId: runner.id }),
    });
    assert.equal(claim.status, 404);
  });

  it('pauses and resumes a queued execution through a human task', async () => {
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({
        name: 'queue-human',
        settings: { execution: { mode: 'platform' } },
        definition: {
          nodes: [
            { name: 'Start', type: 'manualTrigger', parameters: {} },
            {
              name: 'Approve dispatch', type: 'humanTask',
              parameters: { title: 'Approve dispatch', candidateRoles: ['duty-manager'] },
            },
            { name: 'Apply', type: 'set', parameters: { values: { dispatched: '={{ $json.approved }}' } } },
          ],
          connections: {
            Start: { main: [[{ node: 'Approve dispatch' }]] },
            'Approve dispatch': { main: [[{ node: 'Apply' }]] },
          },
        },
      }),
    });
    const wf: any = await created.json();
    const queued: any = await (await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ incident: 'INC-Q' }),
    })).json();
    const paused: any = await waitFor(async () => {
      const body: any = await (await fetch(`${base}/v1/executions/${queued.executionId}?includeData=true`, { headers: USER })).json();
      return body.status === 'paused' ? body : null;
    });
    assert.equal(paused.status, 'paused');
    assert.ok(paused.output?.humanTask?.id, JSON.stringify(paused.output));

    const approved = await fetch(`${base}/v1/human-tasks/${paused.output.humanTask.id}/complete`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ decision: { approved: true }, note: 'ok' }),
    });
    assert.equal(approved.status, 200, await approved.text());
    const done: any = await waitFor(async () => {
      const body: any = await (await fetch(`${base}/v1/executions/${queued.executionId}?includeData=true`, { headers: USER })).json();
      return body.status === 'success' ? body : null;
    });
    if (!done) {
      const last: any = await (await fetch(`${base}/v1/executions/${queued.executionId}?includeData=true`, { headers: USER })).json();
      console.error('[test] resume stuck:', JSON.stringify({ status: last.status, error: last.error, queue: last.queue, runner: last.runner, nodeRuns: (last.nodeRuns || []).map((n: any) => n.node), qsize: mock.queues.get('synapseone-wf-platform')?.size, published: mock.published.slice(-3) }));
    }
    assert.equal(done.status, 'success');
    assert.equal(done.output.dispatched, true);
    assert.equal(done.nodeRuns.filter((n: any) => n.node === 'Apply').length, 1);
  });

  it('queues and completes an inference job for a hybrid runner', async () => {
    const created = await fetch(`${base}/v1/workflow-runners`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: 'hybrid-inference', kind: 'hybrid', mode: 'custom', inferenceQueue: 'synapseone-inference' }),
    });
    const runner: any = (await created.json()).runner;
    assert.equal(runner.kind, 'hybrid');
    assert.deepEqual(runner.capabilities, ['workflow', 'inference']);

    const submitted = await fetch(`${base}/v1/inference-jobs`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ type: 'chat', payload: { messages: [{ role: 'user', content: 'ping' }] } }),
    });
    const queued: any = await submitted.json();
    assert.equal(submitted.status, 202);
    assert.equal(queued.queue, 'synapseone-inference');
    assert.ok(queued.jobId);

    const claim = await fetch(`${base}/v1/runner/inference/jobs/${queued.jobId}/claim`, {
      method: 'POST', headers: RUNNER_AUTH,
      body: JSON.stringify({ runnerId: runner.id, instanceId: 'connector-inf', leaseSeconds: 60 }),
    });
    assert.equal(claim.status, 200);
    const job: any = await claim.json();
    assert.equal(job.type, 'chat');
    assert.equal(job.request.messages[0].content, 'ping');

    const complete = await fetch(`${base}/v1/runner/inference/jobs/${queued.jobId}/complete`, {
      method: 'POST', headers: RUNNER_AUTH,
      body: JSON.stringify({ runnerId: runner.id, status: 'success', result: { choices: [{ message: { content: 'pong' } }] } }),
    });
    assert.equal(complete.status, 200);

    const done: any = await (await fetch(`${base}/v1/inference-jobs/${queued.jobId}?includeData=true`, { headers: USER })).json();
    assert.equal(done.status, 'success');
    assert.equal(done.result.choices[0].message.content, 'pong');
    assert.equal(done.runnerId, runner.id);
  });

  it('drains a custom queue with the published runner entrypoint', async () => {
    // Earlier tests completed a custom job through the HTTP protocol without a
    // queue consumer; clear those stale messages so ONCE picks our job.
    mock.queues.get('synapseone-wf-custom')?.clear();
    const created = await fetch(`${base}/v1/workflow-runners`, {
      method: 'POST', headers: USER,
      body: JSON.stringify({ name: 'e2e-runner', mode: 'custom' }),
    });
    const runner: any = (await created.json()).runner;
    const wf = await createWorkflow('custom', 'runner-e2e');
    const queued: any = await (await fetch(`${base}/v1/workflows/${wf.id}/execute`, {
      method: 'POST', headers: USER, body: JSON.stringify({ value: 7 }),
    })).json();
    assert.equal(queued.queued, true);

    const child = spawn(process.execPath, [path.join(__dirname, 'runner.js')], {
      env: {
        ...process.env,
        SYNAPSEONE_URL: shimBase,
        SYNAPSEONE_API_KEY: 'sk-runner-e2e',
        WORKFLOW_RUNNER_ID: runner.id,
        WORKFLOW_RUNNER_ONCE: '1',
        WORKFLOW_RUNNER_LEASE_SECONDS: '30',
        WORKFLOW_RUNNER_HEARTBEAT_SECONDS: '5',
        WORKFLOW_RUNNER_POLL_MS: '100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', (d) => { logs += String(d); });
    child.stderr?.on('data', (d) => { logs += String(d); });
    const exitCode = await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
    assert.equal(exitCode, 0, logs);

    const exec: any = await waitFor(async () => {
      const r = await fetch(`${base}/v1/executions/${queued.executionId}?includeData=true`, { headers: USER });
      const body: any = await r.json();
      return body.status === 'success' ? body : null;
    });
    assert.equal(exec.output.doubled, 14);
    assert.equal(exec.runner, 'custom');
    assert.ok(logs.includes(`run workflow execution=${queued.executionId}`), logs);
    // The runner acked the message, so the mock queue is empty.
    const remaining = mock.queues.get('synapseone-wf-custom')?.size || 0;
    assert.equal(remaining, 0, `queue still has ${remaining} message(s)`);
  });
});
