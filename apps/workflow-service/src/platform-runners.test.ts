// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Owner-scoped (platform) runner tests.
 *
 * A platform runner is managed by any platform `owner`, holds a system key
 * instead of a user token, and may claim only `system`-mode executions. The
 * runner protocol returns a per-execution delegated token for the queued user.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createApp, runnerCommand } from './index';
import { __clearMem, createInferenceJobRec, getInferenceJobRec } from './store';
import type { StoredWorkflowRunner } from './store';

const INTERNAL = 'platform-runner-test-secret';
const OWNER_TOKEN = 'platform-owner-token';
const OPERATOR_TOKEN = 'platform-operator-token';

const USER = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'tenant-user-1',
  'x-synapseone-org': 'org-tenant-a',
  'x-synapseone-account': 'acc-tenant-a',
  'x-synapseone-kind': 'user',
  'x-synapseone-scopes': '*',
};
const OWNER = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  Authorization: `Bearer ${OWNER_TOKEN}`,
};
const OPERATOR = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  Authorization: `Bearer ${OPERATOR_TOKEN}`,
};

function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` });
    });
  });
}

function mockIam() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const keys = new Map<string, { runnerId: string; scopes: string[]; revoked: boolean }>();
  let seq = 0;
  app.get('/v1/platform/me', (req, res) => {
    const auth = String(req.headers.authorization || '');
    if (auth === `Bearer ${OWNER_TOKEN}`) {
      return res.json({
        role: 'owner',
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          org_id: '00000000-0000-4000-8000-000000000010',
          email: 'platform-owner@test.local',
          display_name: 'Platform Owner',
        },
      });
    }
    if (auth === `Bearer ${OPERATOR_TOKEN}`) {
      return res.json({ role: 'operator', user: { id: '00000000-0000-4000-8000-000000000002' } });
    }
    res.status(403).json({ error: 'platform_admin_required' });
  });
  app.post('/internal/platform-runners/keys', (req, res) => {
    if (req.headers['x-synapseone-internal'] !== INTERNAL) return res.status(401).json({ error: 'unauthorized' });
    const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    const apiKey = `synapseone_pr_test_${seq}`;
    keys.set(id, { runnerId: String(req.body.runnerId), scopes: req.body.scopes || [], revoked: false });
    res.status(201).json({ id, apiKey, prefix: apiKey.slice(0, 16), runnerId: req.body.runnerId, scopes: req.body.scopes || [] });
  });
  app.delete('/internal/platform-runners/keys/runner/:runnerId', (req, res) => {
    if (req.headers['x-synapseone-internal'] !== INTERNAL) return res.status(401).json({ error: 'unauthorized' });
    let revoked = 0;
    for (const k of keys.values()) {
      if (k.runnerId === req.params.runnerId && !k.revoked) { k.revoked = true; revoked += 1; }
    }
    res.json({ ok: true, revoked });
  });
  app.delete('/internal/platform-runners/keys/:id', (req, res) => {
    if (req.headers['x-synapseone-internal'] !== INTERNAL) return res.status(401).json({ error: 'unauthorized' });
    const k = keys.get(req.params.id);
    if (k) k.revoked = true;
    res.json({ ok: true, id: req.params.id, revoked: !!k });
  });
  app.post('/internal/platform-runners/delegate', (req, res) => {
    if (req.headers['x-synapseone-internal'] !== INTERNAL) return res.status(401).json({ error: 'unauthorized' });
    if (!req.body?.userId || !req.body?.executionId) return res.status(400).json({ error: 'invalid_body' });
    res.json({
      accessToken: `delegated-${req.body.executionId}`,
      expiresIn: Math.min(Math.max(Number(req.body.ttlSeconds) || 900, 1), 900),
      tokenType: 'Bearer',
      delegated: true,
      userId: req.body.userId,
      runnerId: req.body.runnerId,
      executionId: req.body.executionId,
      scopes: req.body.scopes || ['*'],
    });
  });
  return { app, keys };
}

function mockQueue() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const published: Array<{ queue: string; tenant: string; body: any }> = [];
  app.put('/v1/queue/queues/:queue', (req, res) => res.status(201).json({ name: req.params.queue }));
  app.post('/v1/queue/queues/:queue/messages', (req, res) => {
    published.push({
      queue: req.params.queue,
      tenant: String(req.headers['x-synapseone-tenant'] || req.headers['x-synapseone-org'] || ''),
      body: req.body,
    });
    res.status(201).json({ ok: true, id: `msg-${published.length}`, duplicate: false });
  });
  app.post('/v1/queue/queues/:queue/consume', (_req, res) => res.json({ messages: [] }));
  app.post('/v1/queue/queues/:queue/ack', (_req, res) => res.json({ ok: true }));
  app.post('/v1/queue/queues/:queue/nack', (_req, res) => res.json({ ok: true }));
  app.post('/v1/queue/queues/:queue/heartbeat', (_req, res) => res.json({ ok: true }));
  return { app, published };
}

describe('owner-scoped platform runners', () => {
  let server: Server | null = null;
  let iamServer: Server | null = null;
  let queueServer: Server | null = null;
  let base = '';
  let systemRunnerId = '';
  let iam: ReturnType<typeof mockIam>;
  let queue: ReturnType<typeof mockQueue>;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ['SYNAPSEONE_INTERNAL_SECRET', 'QUEUE_SERVICE_URL', 'WORKFLOW_EXECUTION_MODE', 'IAM_SERVICE_URL', 'NODE_ENV', 'DATABASE_URL']) {
      saved[k] = process.env[k];
    }
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    process.env.WORKFLOW_EXECUTION_MODE = 'queue';
    iam = mockIam();
    const iamList = await listen(iam.app);
    iamServer = iamList.server;
    process.env.IAM_SERVICE_URL = iamList.base;
    queue = mockQueue();
    const queueList = await listen(queue.app);
    queueServer = queueList.server;
    process.env.QUEUE_SERVICE_URL = queueList.base;
    __clearMem();
    const app = createApp();
    const list = await listen(app);
    server = list.server;
    base = list.base;
  });

  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await Promise.all([
      server ? new Promise<void>((resolve) => server!.close(() => resolve())) : Promise.resolve(),
      iamServer ? new Promise<void>((resolve) => iamServer!.close(() => resolve())) : Promise.resolve(),
      queueServer ? new Promise<void>((resolve) => queueServer!.close(() => resolve())) : Promise.resolve(),
    ]);
  });

  async function call(method: string, path: string, body: any, headers: Record<string, string>) {
    const r = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: r.status, json };
  }

  async function createWorkflow(mode: 'system' | 'custom', name: string, headers: Record<string, string> = USER): Promise<any> {
    const out = await call('POST', '/v1/workflows', {
      name,
      settings: { execution: { mode } },
      definition: {
        nodes: [
          { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
          { id: 'set', name: 'Echo', type: 'n8n-nodes-base.set', parameters: { values: { value: '={{ $json.value }}' } } },
          { id: 'base', name: 'Base read', type: 'synapseone.base', parameters: { operation: 'list-collections' } },
        ],
        connections: { Start: { main: [[{ node: 'Echo' }]] }, Echo: { main: [[{ node: 'Base read' }]] } },
      },
    }, headers);
    assert.equal(out.status, 201, JSON.stringify(out.json));
    return out.json;
  }

  it('lets a platform owner create a system runner and mints a system key once', async () => {
    const out = await call('POST', '/v1/platform/runners', { name: 'system-eu', kind: 'hybrid' }, OWNER);
    assert.equal(out.status, 201, JSON.stringify(out.json));
    systemRunnerId = out.json.runner.id;
    assert.equal(out.json.runner.scope, 'platform');
    assert.equal(out.json.runner.mode, 'system');
    assert.equal(out.json.runner.queue, 'synapseone-wf-system');
    assert.match(out.json.apiKey, /^synapseone_pr_/);
    assert.match(out.json.command, /WORKFLOW_RUNNER_ID=/);
    assert.match(out.json.command, /SYNAPSEONE_API_KEY=synapseone_pr_/);
    assert.equal(out.json.runner.orgId, undefined);
    assert.equal(out.json.runner.accountId, undefined);
    // Any owner may see/manage it; no user ownership field is involved.
    const listed = await call('GET', '/v1/platform/runners', undefined, OWNER);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.data.some((r: any) => r.id === out.json.runner.id && r.scope === 'platform'));
  });

  it('refuses non-owner platform administrators', async () => {
    const out = await call('POST', '/v1/platform/runners', { name: 'operator-runner' }, OPERATOR);
    assert.equal(out.status, 403);
    assert.equal(out.json.error, 'platform_role_required');
  });

  it('routes system-mode executions to the shared platform namespace', async () => {
    const wf = await createWorkflow('system', 'system-flow');
    const queued = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 7 }, USER);
    assert.equal(queued.status, 202, JSON.stringify(queued.json));
    assert.equal(queued.json.queue, 'synapseone-wf-system');
    assert.equal(queued.json.runner, 'system');
    const published = queue.published.find((p) => p.queue === 'synapseone-wf-system' && p.body?.payload?.executionId === queued.json.executionId);
    assert.ok(published, JSON.stringify(queue.published));
    // Null principal -> queue-service tenant:platform.
    assert.equal(published.tenant, 'platform');
  });

  it('lets the system runner claim another tenant job and returns a delegation', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const wf = await createWorkflow('system', 'cross-tenant-flow');
    const queued = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 21 }, USER);
    assert.equal(queued.status, 202);

    const runnerHeaders = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*,queue:consume,queue:ack,queue:nack,queue:heartbeat,inference:*',
    };
    const claim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
      runnerId: runner.id,
      instanceId: 'system-connector-1',
      leaseSeconds: 60,
    }, runnerHeaders);
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    assert.equal(claim.json.principal.org, 'org-tenant-a');
    assert.equal(claim.json.delegatedToken, `delegated-${queued.json.executionId}`);
    assert.deepEqual(claim.json.delegatedScopes, ['base:read']);
    assert.ok(claim.json.delegatedTokenExpiresIn > 0 && claim.json.delegatedTokenExpiresIn <= 60, JSON.stringify(claim.json));

    const heartbeat = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/heartbeat`, {
      runnerId: runner.id,
      instanceId: 'system-connector-1',
      attempt: claim.json.attempt,
      leaseSeconds: 60,
    }, runnerHeaders);
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));
    assert.ok(heartbeat.json.delegatedToken, JSON.stringify(heartbeat.json));
    assert.ok(heartbeat.json.delegatedTokenExpiresIn > 0 && heartbeat.json.delegatedTokenExpiresIn <= 60, JSON.stringify(heartbeat.json));

    const refreshed = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/delegate`, {
      runnerId: runner.id,
      instanceId: 'system-connector-1',
      attempt: claim.json.attempt,
    }, runnerHeaders);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    assert.ok(refreshed.json.accessToken);
    assert.ok(refreshed.json.expiresIn > 0 && refreshed.json.expiresIn <= 60, JSON.stringify(refreshed.json));

    const complete = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/complete`, {
      runnerId: runner.id,
      instanceId: 'system-connector-1',
      attempt: claim.json.attempt,
      status: 'success',
      output: { value: 21 },
      nodeRuns: [],
    }, runnerHeaders);
    assert.equal(complete.status, 200, JSON.stringify(complete.json));
  });

  it('only resolves credentials the claimed graph declares', async () => {
    const mk = async (name: string) => {
      const r = await call('POST', '/v1/credentials', {
        accountId: 'acc-tenant-a', name, kind: 'bearer', secret: `secret-${name}`,
      }, USER);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json;
    };
    const declared = await mk(`declared-${Date.now()}`);
    const unrelated = await mk(`unrelated-${Date.now()}`);
    const created = await call('POST', '/v1/workflows', {
      name: 'credential-scope-flow',
      settings: { execution: { mode: 'system' } },
      definition: {
        nodes: [
          { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
          {
            id: 'http', name: 'Fetch', type: 'n8n-nodes-base.httpRequest',
            parameters: { url: 'https://example.com', method: 'GET', auth: { credentialId: declared.id, allowedOrigins: ['https://example.com'] } },
          },
        ],
        connections: { Start: { main: [[{ node: 'Fetch' }]] } },
      },
    }, USER);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const queued = await call('POST', `/v1/workflows/${created.json.id}/execute`, {}, USER);
    assert.equal(queued.status, 202, JSON.stringify(queued.json));
    const runner = { id: systemRunnerId };
    assert.ok(runner.id, 'system runner from the first test must exist');
    const runnerHeaders = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*,queue:consume,queue:ack,queue:nack,queue:heartbeat,inference:*',
    };
    const claim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
      runnerId: runner.id, instanceId: 'credential-connector', leaseSeconds: 60,
    }, runnerHeaders);
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    const good = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/credentials`, { runnerId: runner.id, instanceId: 'credential-connector', attempt: claim.json.attempt, credentialId: declared.id }, runnerHeaders);
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.secret, declared.secret ?? `secret-${declared.name}`);
    const bad = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/credentials`, { runnerId: runner.id, instanceId: 'credential-connector', attempt: claim.json.attempt, credentialId: unrelated.id }, runnerHeaders);
    assert.equal(bad.status, 404, JSON.stringify(bad.json));
    await call('POST', `/v1/runner/jobs/${queued.json.executionId}/complete`, {
      runnerId: runner.id, instanceId: 'credential-connector', attempt: claim.json.attempt,
      status: 'success', output: {}, nodeRuns: [],
    }, runnerHeaders);
  });

  it('caps a tenant’s queued system-runner work at the configured admission limit', async () => {
    const quotaUser = { ...USER, 'x-synapseone-org': `org-quota-${Date.now().toString(36)}` };
    const prev = process.env.WORKFLOW_SYSTEM_QUEUE_TENANT_MAX;
    process.env.WORKFLOW_SYSTEM_QUEUE_TENANT_MAX = '1';
    try {
      const wf = await createWorkflow('system', 'quota-flow', quotaUser);
      const first = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 1 }, quotaUser);
      assert.equal(first.status, 202, JSON.stringify(first.json));
      const second = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 2 }, quotaUser);
      assert.equal(second.status, 429, JSON.stringify(second.json));
      assert.equal(second.json.error, 'tenant_queue_quota');
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_SYSTEM_QUEUE_TENANT_MAX;
      else process.env.WORKFLOW_SYSTEM_QUEUE_TENANT_MAX = prev;
    }
  });

  it('keeps the runner bootstrap available but management routes owner-only', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const runnerHeaders = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*',
    };
    const config = await call('GET', `/v1/workflow-runners/${runner.id}/config`, undefined, runnerHeaders);
    assert.equal(config.status, 200, JSON.stringify(config.json));
    assert.equal(config.json.scope, 'platform');
    assert.equal(config.json.mode, 'system');

    const heartbeat = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
      instanceId: 'system-connector-1',
      hostname: 'system-host',
      concurrency: 2,
      status: 'connected',
    }, runnerHeaders);
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));

    const management = await call('PATCH', `/v1/workflow-runners/${runner.id}`, { name: 'hijacked' }, runnerHeaders);
    assert.equal(management.status, 404);
  });

  it('does not let a system runner claim tenant-mode work', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const wf = await createWorkflow('custom', 'tenant-only-flow');
    const queued = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 1 }, USER);
    assert.equal(queued.status, 202);
    assert.equal(queued.json.queue, 'synapseone-wf-custom');
    const runnerHeaders = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
    };
    const claim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
      runnerId: runner.id,
      instanceId: 'tenant-connector-1',
      leaseSeconds: 60,
    }, runnerHeaders);
    assert.equal(claim.status, 403);
    assert.equal(claim.json.error, 'runner_mismatch');
  });

  it('only accepts system inference types that a live runner has loaded', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const headers = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*,inference:*',
    };
    const heartbeat = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
      instanceId: 'inference-connector-1',
      hostname: 'system-host',
      concurrency: 1,
      status: 'connected',
      metadata: {
        inferenceHealth: {
          ready: true,
          mode: 'local',
          capabilities: {
            embeddings: { ready: true, model: 'all-MiniLM-L6-v2' },
            decision: { ready: true, model: 'Decision-2.0' },
            route: { ready: true, model: 'Decision-2.0' },
            chat: { ready: false, state: 'unsupported' },
          },
          unsupportedTypes: ['chat', 'generic'],
        },
      },
    }, headers);
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));

    const okEmbeddings = await call('POST', '/v1/inference-jobs', {
      type: 'embeddings',
      queue: 'synapseone-inference-system',
      payload: { input: ['self-test'] },
    }, USER);
    assert.equal(okEmbeddings.status, 202, JSON.stringify(okEmbeddings.json));

    const chat = await call('POST', '/v1/inference-jobs', {
      type: 'chat',
      queue: 'synapseone-inference-system',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    }, USER);
    assert.equal(chat.status, 409, JSON.stringify(chat.json));
    assert.equal(chat.json.error, 'inference_unavailable');
    assert.equal(chat.json.capabilities.chat, undefined);

    const claimed = await call('POST', `/v1/runner/inference/jobs/${okEmbeddings.json.jobId}/claim`, {
      runnerId: runner.id, instanceId: 'inference-connector-1', leaseSeconds: 60,
    }, headers);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
    assert.equal(claimed.json.type, 'embeddings');

    const otherInstance = await call('POST', `/v1/runner/inference/jobs/${okEmbeddings.json.jobId}/complete`, {
      runnerId: runner.id,
      instanceId: 'inference-connector-2',
      attempt: claimed.json.attempt,
      status: 'success',
      result: { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [1, 0] }], model: 'm', usage: {} },
    }, headers);
    assert.equal(otherInstance.status, 409, JSON.stringify(otherInstance.json));

    const completed = await call('POST', `/v1/runner/inference/jobs/${okEmbeddings.json.jobId}/complete`, {
      runnerId: runner.id,
      instanceId: 'inference-connector-1',
      attempt: claimed.json.attempt,
      status: 'success',
      result: {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
        model: 'all-MiniLM-L6-v2',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    }, headers);
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    const job = await call('GET', `/v1/inference-jobs/${okEmbeddings.json.jobId}?includeData=true`, undefined, USER);
    assert.equal(job.status, 200);
    assert.equal(job.json.status, 'success');
    assert.equal(job.json.result.data[0].embedding.length, 3);
  });

  it('rejects a per-runner inference type that is not actually loaded', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const headers = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*,inference:*',
    };
    const heartbeat = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
      instanceId: 'inference-connector-1',
      hostname: 'system-host',
      concurrency: 1,
      status: 'connected',
      metadata: {
        inferenceHealth: {
          ready: true,
          mode: 'local',
          capabilities: {
            embeddings: { ready: true, model: 'all-MiniLM-L6-v2' },
            decision: { ready: false, state: 'failed', error: 'decision model not loaded' },
            route: { ready: false, state: 'failed' },
            chat: { ready: false, state: 'unsupported' },
          },
        },
      },
    }, headers);
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));

    const job = await createInferenceJobRec({
      type: 'decision',
      request: { state: 'x', questions: {} },
      org_id: null,
      account_id: null,
      queue_name: 'synapseone-inference-system',
      target_runner_id: runner.id,
    });
    const claim = await call('POST', `/v1/runner/inference/jobs/${job.id}/claim`, {
      runnerId: runner.id,
      instanceId: 'inference-connector-1',
      leaseSeconds: 60,
    }, headers);
    assert.equal(claim.status, 409, JSON.stringify(claim.json));
    assert.equal(claim.json.error, 'runner_capability_unavailable');
    const after = await getInferenceJobRec(job.id);
    assert.equal(after?.status, 'queued');
  });

  it('refuses platform claims without fresh or sufficient resources when admission is enforced', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const headers = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*',
    };
    const wf = await createWorkflow('system', 'resource-admission-flow');
    const queued = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 1 }, USER);
    assert.equal(queued.status, 202, JSON.stringify(queued.json));
    const saved = process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION;
    process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION = 'enforce';
    try {
      // No telemetry in the latest heartbeat -> 409.
      const noTelemetry = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
        instanceId: 'resource-connector-1',
        hostname: 'system-host',
        concurrency: 1,
        status: 'connected',
        metadata: { inferenceHealth: { ready: true, capabilities: {} } },
      }, headers);
      assert.equal(noTelemetry.status, 200);
      const unsupportedTest = await call('POST', `/v1/platform/runners/${runner.id}/test`, { type: 'workflow' }, OWNER);
      assert.equal(unsupportedTest.status, 409, JSON.stringify(unsupportedTest.json));
      assert.equal(unsupportedTest.json.error, 'runner_resources_unavailable');
      assert.match(unsupportedTest.json.message, /current Docker command/);
      const staleClaim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
        runnerId: runner.id, instanceId: 'resource-connector-1', leaseSeconds: 60,
      }, headers);
      assert.equal(staleClaim.status, 409, JSON.stringify(staleClaim.json));
      assert.equal(staleClaim.json.error, 'runner_resources_unavailable');

      // Fresh but insufficient CPU -> 409.
      const low = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
        instanceId: 'resource-connector-1',
        hostname: 'system-host',
        concurrency: 1,
        status: 'connected',
        metadata: {
          resources: {
            source: 'cgroup-v2', sampledAt: new Date().toISOString(),
            cpu: { limitCores: 1, usedCores: 0.9 },
            memory: { limitMb: 8192, usedMb: 1024 },
          },
        },
      }, headers);
      assert.equal(low.status, 200, JSON.stringify(low.json));
      const lowClaim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
        runnerId: runner.id, instanceId: 'resource-connector-1', leaseSeconds: 60,
      }, headers);
      assert.equal(lowClaim.status, 409, JSON.stringify(lowClaim.json));
      assert.equal(lowClaim.json.error, 'runner_capacity_unavailable');

      // Startup safety: the sampler reports availableCores=0 until a real
      // counter delta; the server must not derive full free capacity.
      const startup = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
        instanceId: 'resource-connector-1',
        hostname: 'system-host',
        concurrency: 1,
        status: 'connected',
        metadata: {
          resources: {
            source: 'cgroup-v2', sampledAt: new Date().toISOString(),
            cpu: { limitCores: 4, usedCores: 0, availableCores: 0 },
            memory: { limitMb: 8192, usedMb: 1024, availableMb: 7168 },
          },
        },
      }, headers);
      assert.equal(startup.status, 200, JSON.stringify(startup.json));
      const startupClaim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
        runnerId: runner.id, instanceId: 'resource-connector-1', leaseSeconds: 60,
      }, headers);
      assert.equal(startupClaim.status, 409, JSON.stringify(startupClaim.json));
      assert.equal(startupClaim.json.error, 'runner_capacity_unavailable');

      // Enough free CPU/RAM -> claim succeeds.
      const enough = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
        instanceId: 'resource-connector-1',
        hostname: 'system-host',
        concurrency: 1,
        status: 'connected',
        metadata: {
          resources: {
            source: 'cgroup-v2', sampledAt: new Date().toISOString(),
            cpu: { limitCores: 4, usedCores: 0, availableCores: 4 },
            memory: { limitMb: 8192, usedMb: 1024, availableMb: 7168 },
          },
        },
      }, headers);
      assert.equal(enough.status, 200, JSON.stringify(enough.json));
      const conn = await call('GET', `/v1/platform/runners/${runner.id}/connection`, undefined, OWNER);
      const inst = (conn.json.instances || []).find((item: any) => item.id === 'resource-connector-1');
      assert.ok(inst?.metadata?.resources, JSON.stringify(inst?.metadata || null));
      assert.equal(inst.metadata.resources.cpu.availableCores, 4);
      const claim = await call('POST', `/v1/runner/jobs/${queued.json.executionId}/claim`, {
        runnerId: runner.id, instanceId: 'resource-connector-1', leaseSeconds: 60,
      }, headers);
      assert.equal(claim.status, 200, JSON.stringify(claim.json));
      await call('POST', `/v1/runner/jobs/${queued.json.executionId}/complete`, {
        runnerId: runner.id,
        instanceId: 'resource-connector-1',
        attempt: claim.json.attempt,
        status: 'success',
        output: {},
        nodeRuns: [],
      }, headers);
    } finally {
      if (saved === undefined) delete process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION;
      else process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION = saved;
    }
  });

  it('fences connector instances and honours disable/enable/revoke controls', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const headers = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*',
    };
    const wf = await createWorkflow('system', 'instance-fence-flow');
    const queued = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 5 }, USER);
    assert.equal(queued.status, 202, JSON.stringify(queued.json));
    const execId = queued.json.executionId;

    const claimA = await call('POST', `/v1/runner/jobs/${execId}/claim`, {
      runnerId: runner.id, instanceId: 'connector-a', leaseSeconds: 60,
    }, headers);
    assert.equal(claimA.status, 200, JSON.stringify(claimA.json));

    // A second replica of the same registration must not execute the same run.
    const claimB = await call('POST', `/v1/runner/jobs/${execId}/claim`, {
      runnerId: runner.id, instanceId: 'connector-b', leaseSeconds: 60,
    }, headers);
    assert.equal(claimB.status, 409, JSON.stringify(claimB.json));
    assert.equal(claimB.json.error, 'not_claimable');

    const completeB = await call('POST', `/v1/runner/jobs/${execId}/complete`, {
      runnerId: runner.id, instanceId: 'connector-b', attempt: claimA.json.attempt,
      status: 'success', output: {}, nodeRuns: [],
    }, headers);
    assert.equal(completeB.status, 409, JSON.stringify(completeB.json));
    assert.equal(completeB.json.error, 'not_claimed');

    const completeA = await call('POST', `/v1/runner/jobs/${execId}/complete`, {
      runnerId: runner.id, instanceId: 'connector-a', attempt: claimA.json.attempt,
      status: 'success', output: { value: 5 }, nodeRuns: [],
    }, headers);
    assert.equal(completeA.status, 200, JSON.stringify(completeA.json));

    const disabled = await call('POST', `/v1/platform/runners/${runner.id}/disable`, {}, OWNER);
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
    assert.equal(disabled.json.runner.status, 'disabled');
    const queued2 = await call('POST', `/v1/workflows/${wf.id}/execute`, { value: 6 }, USER);
    assert.equal(queued2.status, 202);
    const disabledClaim = await call('POST', `/v1/runner/jobs/${queued2.json.executionId}/claim`, {
      runnerId: runner.id, instanceId: 'connector-a', leaseSeconds: 60,
    }, headers);
    assert.equal(disabledClaim.status, 409, JSON.stringify(disabledClaim.json));
    assert.equal(disabledClaim.json.error, 'runner_disabled');

    const enabled = await call('POST', `/v1/platform/runners/${runner.id}/enable`, {}, OWNER);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
    const enabledClaim = await call('POST', `/v1/runner/jobs/${queued2.json.executionId}/claim`, {
      runnerId: runner.id, instanceId: 'connector-a', leaseSeconds: 60,
    }, headers);
    assert.equal(enabledClaim.status, 200, JSON.stringify(enabledClaim.json));
    await call('POST', `/v1/runner/jobs/${queued2.json.executionId}/complete`, {
      runnerId: runner.id, instanceId: 'connector-a', attempt: enabledClaim.json.attempt,
      status: 'success', output: {}, nodeRuns: [],
    }, headers);

    const revoked = await call('POST', `/v1/platform/runners/${runner.id}/revoke-key`, {}, OWNER);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.runner.status, 'disabled');
    assert.equal(revoked.json.runner.apiKeyId, null);
    const enableWithoutKey = await call('POST', `/v1/platform/runners/${runner.id}/enable`, {}, OWNER);
    assert.equal(enableWithoutKey.status, 409);
    assert.equal(enableWithoutKey.json.error, 'runner_key_missing');
    const rekeyed = await call('POST', `/v1/platform/runners/${runner.id}/rotate-key`, {}, OWNER);
    assert.equal(rekeyed.status, 200, JSON.stringify(rekeyed.json));
    assert.match(rekeyed.json.apiKey, /^synapseone_pr_/);
  });

  it('targets self-tests at the selected registration with async poll results', async () => {
    const createA = await call('POST', '/v1/platform/runners', { name: 'target-a', kind: 'hybrid' }, OWNER);
    const createB = await call('POST', '/v1/platform/runners', { name: 'target-b', kind: 'hybrid' }, OWNER);
    assert.equal(createA.status, 201, JSON.stringify(createA.json));
    assert.equal(createB.status, 201, JSON.stringify(createB.json));
    const runnerA = createA.json.runner;
    const runnerB = createB.json.runner;
    const headersFor = (runner: any) => ({
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*,inference:*',
    });
    const health = {
      inferenceHealth: {
        ready: true,
        mode: 'local',
        capabilities: {
          embeddings: { ready: true, model: 'all-MiniLM-L6-v2' },
          decision: { ready: true, model: 'Decision-2.0' },
          route: { ready: true, model: 'Decision-2.0' },
          chat: { ready: false, state: 'unsupported' },
        },
      },
    };
    for (const runner of [runnerA, runnerB]) {
      const hb = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
        instanceId: `connector-${runner.name}`,
        hostname: 'system-host',
        concurrency: 1,
        status: 'connected',
        metadata: health,
      }, headersFor(runner));
      assert.equal(hb.status, 200, JSON.stringify(hb.json));
    }

    // Inference self-test targets A; B must not claim it.
    const inferenceTest = await call('POST', `/v1/platform/runners/${runnerA.id}/test`, { type: 'embeddings' }, OWNER);
    assert.equal(inferenceTest.status, 202, JSON.stringify(inferenceTest.json));
    assert.equal(inferenceTest.json.ok, false);
    assert.equal(inferenceTest.json.runnerId, null);
    assert.equal(inferenceTest.json.targetRunnerId, runnerA.id);
    assert.equal(inferenceTest.json.status, 'queued');
    assert.match(inferenceTest.json.pollUrl, new RegExp(`/v1/platform/runners/${runnerA.id}/test/`));

    const wrongInference = await call('POST', `/v1/runner/inference/jobs/${inferenceTest.json.jobId}/claim`, {
      runnerId: runnerB.id, instanceId: `connector-${runnerB.name}`, leaseSeconds: 60,
    }, headersFor(runnerB));
    assert.equal(wrongInference.status, 409, JSON.stringify(wrongInference.json));
    assert.equal(wrongInference.json.error, 'runner_not_target');

    const inferenceClaim = await call('POST', `/v1/runner/inference/jobs/${inferenceTest.json.jobId}/claim`, {
      runnerId: runnerA.id, instanceId: `connector-${runnerA.name}`, leaseSeconds: 60,
    }, headersFor(runnerA));
    assert.equal(inferenceClaim.status, 200, JSON.stringify(inferenceClaim.json));
    const inferenceComplete = await call('POST', `/v1/runner/inference/jobs/${inferenceTest.json.jobId}/complete`, {
      runnerId: runnerA.id,
      instanceId: `connector-${runnerA.name}`,
      attempt: inferenceClaim.json.attempt,
      status: 'success',
      result: {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: 'all-MiniLM-L6-v2',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    }, headersFor(runnerA));
    assert.equal(inferenceComplete.status, 200, JSON.stringify(inferenceComplete.json));
    const inferencePoll = await call('GET', inferenceTest.json.pollUrl, undefined, OWNER);
    assert.equal(inferencePoll.status, 200, JSON.stringify(inferencePoll.json));
    assert.equal(inferencePoll.json.ok, true);
    assert.equal(inferencePoll.json.status, 'success');
    assert.equal(inferencePoll.json.runnerId, runnerA.id);
    assert.equal(inferencePoll.json.targetRunnerId, runnerA.id);
    assert.equal(inferencePoll.json.vectorCount, 1);
    assert.equal(inferencePoll.json.dimensions, 3);

    // Workflow self-test targets A; B must not claim it.
    const workflowTest = await call('POST', `/v1/platform/runners/${runnerA.id}/test`, { type: 'workflow' }, OWNER);
    assert.equal(workflowTest.status, 202, JSON.stringify(workflowTest.json));
    assert.equal(workflowTest.json.ok, false);
    assert.equal(workflowTest.json.status, 'queued');
    assert.equal(workflowTest.json.runnerId, null);
    assert.equal(workflowTest.json.targetRunnerId, runnerA.id);
    const wrongWorkflow = await call('POST', `/v1/runner/jobs/${workflowTest.json.jobId}/claim`, {
      runnerId: runnerB.id, instanceId: `connector-${runnerB.name}`, leaseSeconds: 60,
    }, headersFor(runnerB));
    assert.equal(wrongWorkflow.status, 409, JSON.stringify(wrongWorkflow.json));
    assert.equal(wrongWorkflow.json.error, 'runner_not_target');

    const workflowClaim = await call('POST', `/v1/runner/jobs/${workflowTest.json.jobId}/claim`, {
      runnerId: runnerA.id, instanceId: `connector-${runnerA.name}`, leaseSeconds: 60,
    }, headersFor(runnerA));
    assert.equal(workflowClaim.status, 200, JSON.stringify(workflowClaim.json));
    const workflowComplete = await call('POST', `/v1/runner/jobs/${workflowTest.json.jobId}/complete`, {
      runnerId: runnerA.id,
      instanceId: `connector-${runnerA.name}`,
      attempt: workflowClaim.json.attempt,
      status: 'success',
      output: { selfTest: true },
      nodeRuns: [],
    }, headersFor(runnerA));
    assert.equal(workflowComplete.status, 200, JSON.stringify(workflowComplete.json));
    const workflowPoll = await call('GET', workflowTest.json.pollUrl, undefined, OWNER);
    assert.equal(workflowPoll.status, 200, JSON.stringify(workflowPoll.json));
    assert.equal(workflowPoll.json.ok, true);
    assert.equal(workflowPoll.json.status, 'success');
    assert.equal(workflowPoll.json.runnerId, runnerA.id);
    assert.equal(workflowPoll.json.targetRunnerId, runnerA.id);
    assert.equal(workflowPoll.json.output.selfTest, true);

    await call('DELETE', `/v1/platform/runners/${runnerA.id}`, undefined, OWNER);
    await call('DELETE', `/v1/platform/runners/${runnerB.id}`, undefined, OWNER);
  });

  it('maps cross-registration connector id collisions to 409 instance_conflict', async () => {
    const a = await call('POST', '/v1/platform/runners', { name: 'instance-owner-a', kind: 'workflow' }, OWNER);
    const b = await call('POST', '/v1/platform/runners', { name: 'instance-owner-b', kind: 'workflow' }, OWNER);
    assert.equal(a.status, 201, JSON.stringify(a.json));
    assert.equal(b.status, 201, JSON.stringify(b.json));
    const runnerA = a.json.runner;
    const runnerB = b.json.runner;
    const headersFor = (runner: any) => ({
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*',
    });
    const first = await call('POST', `/v1/workflow-runners/${runnerA.id}/heartbeat`, {
      instanceId: 'shared-connector-id',
      hostname: 'host-a',
      concurrency: 1,
      status: 'connected',
    }, headersFor(runnerA));
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const conflict = await call('POST', `/v1/workflow-runners/${runnerB.id}/heartbeat`, {
      instanceId: 'shared-connector-id',
      hostname: 'host-b',
      concurrency: 1,
      status: 'connected',
    }, headersFor(runnerB));
    assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
    assert.equal(conflict.json.error, 'instance_conflict');
    await call('DELETE', `/v1/platform/runners/${runnerA.id}`, undefined, OWNER);
    await call('DELETE', `/v1/platform/runners/${runnerB.id}`, undefined, OWNER);
  });

  it('rotates and revokes system keys on owner actions', async () => {
    const runner = (await call('GET', '/v1/platform/runners', undefined, OWNER)).json.data[0];
    const originalKeyId = runner.apiKeyId;
    const rotated = await call('POST', `/v1/platform/runners/${runner.id}/rotate-key`, {}, OWNER);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
    assert.match(rotated.json.apiKey, /^synapseone_pr_/);
    assert.notEqual(rotated.json.apiKey, runner.apiKeyId);
    assert.equal(iam.keys.get(originalKeyId)?.revoked, true);

    const removed = await call('DELETE', `/v1/platform/runners/${runner.id}`, undefined, OWNER);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.deleted, true);
    const live = [...iam.keys.values()].filter((k) => k.runnerId === runner.id && !k.revoked);
    assert.equal(live.length, 0);
  });

  it('rotation marks old instances offline and clears live readiness before a new heartbeat', async () => {
    const created = await call('POST', '/v1/platform/runners', { name: 'rotate-stale-guard', kind: 'hybrid' }, OWNER);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const runner = created.json.runner;
    const headers = {
      'Content-Type': 'application/json',
      'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner',
      'x-synapseone-runner': runner.id,
      'x-synapseone-scopes': 'workflow:*,inference:*',
    };
    const heartbeat = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
      instanceId: 'old-connector-host',
      hostname: 'old-connector-host',
      concurrency: 2,
      status: 'connected',
      metadata: {
        resources: {
          source: 'cgroup-v2', sampledAt: new Date().toISOString(),
          cpu: { limitCores: 4, usedCores: 1, availableCores: 3 },
          memory: { limitMb: 8192, usedMb: 2048, availableMb: 6144 },
        },
        inferenceHealth: {
          ready: true,
          mode: 'local',
          capabilities: {
            embeddings: { ready: true, model: 'sentence-transformers/all-MiniLM-L6-v2' },
            decision: { ready: true, model: 'vllm-sr/Decision-2.0-Eos-0.8B' },
            route: { ready: true, model: 'vllm-sr/Decision-2.0-Eos-0.8B' },
            chat: { ready: false, state: 'unsupported' },
          },
        },
      },
    }, headers);
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));

    const before = await call('GET', `/v1/platform/runners/${runner.id}/connection`, undefined, OWNER);
    assert.equal(before.status, 200, JSON.stringify(before.json));
    assert.equal(before.json.connected, true);
    assert.equal(before.json.instances[0].id, 'old-connector-host');
    assert.equal(before.json.runner.metadata.inferenceHealth.ready, true);
    assert.ok(Array.isArray(before.json.instances[0].metadata.resourceHistory));
    assert.equal(before.json.instances[0].metadata.resourceHistory.length, 1);

    const rotated = await call('POST', `/v1/platform/runners/${runner.id}/rotate-key`, {}, OWNER);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
    assert.equal(rotated.json.runner.connected, false);
    assert.equal(rotated.json.runner.connectedInstances, 0);
    assert.ok(['waiting', 'offline'].includes(rotated.json.runner.status), rotated.json.runner.status);
    assert.equal(rotated.json.runner.metadata.inferenceHealth.ready, false);
    assert.equal(rotated.json.runner.metadata.resources, undefined);
    const rotatedInstance = rotated.json.runner.instances.find((i: any) => i.id === 'old-connector-host');
    assert.equal(rotatedInstance.status, 'offline');
    assert.equal(rotatedInstance.metadata.resourceHistory.length, 1);

    const after = await call('GET', `/v1/platform/runners/${runner.id}/connection`, undefined, OWNER);
    assert.equal(after.status, 200);
    assert.equal(after.json.connected, false);
    assert.equal(after.json.instances[0].status, 'offline');

    // A genuinely new worker (new instance id) with fresh telemetry becomes
    // the only connected/ready state.
    const fresh = await call('POST', `/v1/workflow-runners/${runner.id}/heartbeat`, {
      instanceId: 'new-connector-host',
      hostname: 'new-connector-host',
      concurrency: 2,
      status: 'connected',
      metadata: {
        inferenceHealth: {
          ready: true,
          mode: 'local',
          capabilities: {
            embeddings: { ready: true, model: 'sentence-transformers/all-MiniLM-L6-v2' },
            decision: { ready: true, model: 'vllm-sr/Decision-2.0-Eos-0.8B' },
            route: { ready: true, model: 'vllm-sr/Decision-2.0-Eos-0.8B' },
            chat: { ready: false, state: 'unsupported' },
          },
        },
      },
    }, headers);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
    assert.equal(fresh.json.runner.connected, true);
    assert.equal(fresh.json.runner.connectedInstances, 1);
    assert.equal(fresh.json.runner.metadata.inferenceHealth.ready, true);

    await call('DELETE', `/v1/platform/runners/${runner.id}`, undefined, OWNER);
  });

  it('validates owner docker resource controls on create', async () => {
    const rejected: Array<[any, string]> = [
      [{ cpus: 0.1 }, 'cpus'],
      [{ cpus: 64.5 }, 'cpus'],
      [{ cpus: '2; rm -rf /' }, 'cpus'],
      [{ cpus: null }, 'cpus'],
      [{ memoryMb: 255 }, 'memoryMb'],
      [{ memoryMb: 262145 }, 'memoryMb'],
      [{ memoryMb: 1024.5 }, 'memoryMb'],
      [{ concurrency: 0 }, 'concurrency'],
      [{ concurrency: 33 }, 'concurrency'],
      [{ concurrency: 2.5 }, 'concurrency'],
      [{ cpuEnabled: 'yes' }, 'cpuEnabled'],
      [{ memoryEnabled: 1 }, 'memoryEnabled'],
      [{ privileged: true }, 'only contain'],
    ];
    for (const [dockerResources, expected] of rejected) {
      const out = await call('POST', '/v1/platform/runners', {
        name: 'invalid-docker',
        kind: 'workflow',
        dockerResources,
      }, OWNER);
      assert.equal(out.status, 400, `${JSON.stringify(dockerResources)} -> ${JSON.stringify(out.json)}`);
      assert.equal(out.json.error, 'invalid_docker_resources');
      assert.match(out.json.message, new RegExp(expected));
    }
    // Rejected bodies must not leave a runner behind.
    const listed = await call('GET', '/v1/platform/runners', undefined, OWNER);
    assert.equal(listed.json.data.filter((r: any) => r.name === 'invalid-docker').length, 0);

    // Inclusive boundaries are accepted.
    const max = await call('POST', '/v1/platform/runners', {
      name: 'docker-bounds-max',
      kind: 'workflow',
      dockerResources: { cpuEnabled: true, memoryEnabled: true, cpus: 64, memoryMb: 262144, concurrency: 32 },
    }, OWNER);
    assert.equal(max.status, 201, JSON.stringify(max.json));
    assert.equal(max.json.runner.dockerResources.cpus, 64);
    assert.equal(max.json.runner.dockerResources.memoryMb, 262144);
    assert.equal(max.json.runner.dockerResources.concurrency, 32);
    const min = await call('POST', '/v1/platform/runners', {
      name: 'docker-bounds-min',
      kind: 'workflow',
      dockerResources: { cpuEnabled: false, memoryEnabled: false, cpus: 0.25, memoryMb: 256, concurrency: 1 },
    }, OWNER);
    assert.equal(min.status, 201, JSON.stringify(min.json));
    assert.equal(min.json.runner.dockerResources.cpus, 0.25);
    assert.equal(min.json.runner.dockerResources.memoryMb, 256);
    assert.equal(min.json.runner.dockerResources.concurrency, 1);
    for (const runner of [max.json.runner, min.json.runner]) {
      await call('DELETE', `/v1/platform/runners/${runner.id}`, undefined, OWNER);
    }
  });

  it('persists dockerResources and renders enabled CPU/RAM limits + concurrency', async () => {
    const created = await call('POST', '/v1/platform/runners', {
      name: 'docker-enabled',
      kind: 'workflow',
      dockerResources: { cpuEnabled: true, memoryEnabled: true, cpus: 1.5, memoryMb: 768, concurrency: 3 },
    }, OWNER);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual(created.json.runner.dockerResources, {
      cpuEnabled: true,
      memoryEnabled: true,
      cpus: 1.5,
      memoryMb: 768,
      concurrency: 3,
    });
    assert.match(created.json.command, /docker run -d --cpus=1\.5 --memory=768m --memory-swap=768m /);
    assert.match(created.json.command, /WORKFLOW_RUNNER_CONCURRENCY=3 /);
    // Readback for the owner UI comes from the same effective config.
    const read = await call('GET', `/v1/platform/runners/${created.json.runner.id}`, undefined, OWNER);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.deepEqual(read.json.runner.dockerResources, created.json.runner.dockerResources);
    assert.match(read.json.command, /--cpus=1\.5 --memory=768m --memory-swap=768m/);
    await call('DELETE', `/v1/platform/runners/${created.json.runner.id}`, undefined, OWNER);
  });

  it('omits --cpus when CPU control is disabled and omits memory flags when RAM control is disabled', async () => {
    const noCpu = await call('POST', '/v1/platform/runners', {
      name: 'docker-no-cpu',
      kind: 'hybrid',
      dockerResources: { cpuEnabled: false, memoryEnabled: true, cpus: 8, memoryMb: 4096, concurrency: 2 },
    }, OWNER);
    assert.equal(noCpu.status, 201, JSON.stringify(noCpu.json));
    assert.doesNotMatch(noCpu.json.command, /--cpus=/);
    assert.match(noCpu.json.command, /--memory=4096m --memory-swap=4096m/);
    assert.match(noCpu.json.command, /WORKFLOW_RUNNER_CONCURRENCY=2 /);
    // The inference lane stays serial even when the workflow lane is wider.
    assert.match(noCpu.json.command, /WORKFLOW_RUNNER_INFERENCE_CONCURRENCY=1 /);

    const noRam = await call('POST', '/v1/platform/runners', {
      name: 'docker-no-ram',
      kind: 'inference',
      dockerResources: { cpuEnabled: true, memoryEnabled: false, cpus: 4, memoryMb: 8192, concurrency: 5 },
    }, OWNER);
    assert.equal(noRam.status, 201, JSON.stringify(noRam.json));
    assert.match(noRam.json.command, /--cpus=4 /);
    assert.doesNotMatch(noRam.json.command, /--memory=/);
    assert.doesNotMatch(noRam.json.command, /--memory-swap=/);

    const none = await call('POST', '/v1/platform/runners', {
      name: 'docker-no-limits',
      kind: 'workflow',
      dockerResources: { cpuEnabled: false, memoryEnabled: false, cpus: 64, memoryMb: 262144, concurrency: 1 },
    }, OWNER);
    assert.equal(none.status, 201, JSON.stringify(none.json));
    assert.match(none.json.command, /docker run -d --name synapseone-runner-/);
    assert.doesNotMatch(none.json.command, /--cpus=|--memory=/);
    assert.match(none.json.command, /WORKFLOW_RUNNER_CONCURRENCY=1 /);

    for (const runner of [noCpu.json.runner, noRam.json.runner, none.json.runner]) {
      await call('DELETE', `/v1/platform/runners/${runner.id}`, undefined, OWNER);
    }
  });

  it('keeps legacy docker defaults when dockerResources is missing', async () => {
    const workflow = await call('POST', '/v1/platform/runners', { name: 'legacy-docker-workflow', kind: 'workflow' }, OWNER);
    assert.equal(workflow.status, 201, JSON.stringify(workflow.json));
    assert.deepEqual(workflow.json.runner.dockerResources, {
      cpuEnabled: true, memoryEnabled: true, cpus: 2, memoryMb: 1024, concurrency: 8,
    });
    assert.match(workflow.json.command, /--cpus=2 --memory=1024m --memory-swap=1024m /);
    assert.match(workflow.json.command, /WORKFLOW_RUNNER_CONCURRENCY=8 /);

    const hybrid = await call('POST', '/v1/platform/runners', { name: 'legacy-docker-hybrid', kind: 'hybrid' }, OWNER);
    assert.equal(hybrid.status, 201, JSON.stringify(hybrid.json));
    assert.deepEqual(hybrid.json.runner.dockerResources, {
      cpuEnabled: true, memoryEnabled: true, cpus: 2, memoryMb: 6144, concurrency: 8,
    });
    assert.match(hybrid.json.command, /--cpus=2 --memory=6144m --memory-swap=6144m /);

    // Legacy inference-derived limits still shape the command until the owner
    // saves an explicit dockerResources block.
    const derived = await call('POST', '/v1/platform/runners', {
      name: 'legacy-docker-derived',
      kind: 'workflow',
      inference: { limits: { threads: 3, maxRssMb: 2048 } },
    }, OWNER);
    assert.equal(derived.status, 201, JSON.stringify(derived.json));
    assert.equal(derived.json.runner.dockerResources.cpus, 3);
    assert.equal(derived.json.runner.dockerResources.memoryMb, 2048);
    assert.match(derived.json.command, /--cpus=3 --memory=2048m --memory-swap=2048m /);

    for (const runner of [workflow.json.runner, hybrid.json.runner, derived.json.runner]) {
      await call('DELETE', `/v1/platform/runners/${runner.id}`, undefined, OWNER);
    }
  });

  it('patches docker resource toggles incrementally and resets to legacy defaults', async () => {
    const created = await call('POST', '/v1/platform/runners', { name: 'docker-patch', kind: 'workflow' }, OWNER);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.runner.id;

    const cpuOff = await call('PATCH', `/v1/platform/runners/${id}`, {
      dockerResources: { cpuEnabled: false },
    }, OWNER);
    assert.equal(cpuOff.status, 200, JSON.stringify(cpuOff.json));
    assert.deepEqual(cpuOff.json.runner.dockerResources, {
      cpuEnabled: false, memoryEnabled: true, cpus: 2, memoryMb: 1024, concurrency: 8,
    });

    const readOff = await call('GET', `/v1/platform/runners/${id}`, undefined, OWNER);
    assert.doesNotMatch(readOff.json.command, /--cpus=/);
    assert.match(readOff.json.command, /--memory=1024m --memory-swap=1024m/);

    const bothOff = await call('PATCH', `/v1/platform/runners/${id}`, {
      dockerResources: { memoryEnabled: false },
    }, OWNER);
    assert.equal(bothOff.status, 200, JSON.stringify(bothOff.json));
    assert.equal(bothOff.json.runner.dockerResources.cpuEnabled, false);
    assert.equal(bothOff.json.runner.dockerResources.memoryEnabled, false);
    const readBothOff = await call('GET', `/v1/platform/runners/${id}`, undefined, OWNER);
    assert.doesNotMatch(readBothOff.json.command, /--cpus=|--memory=/);

    const tuned = await call('PATCH', `/v1/platform/runners/${id}`, {
      dockerResources: { cpuEnabled: true, memoryEnabled: true, cpus: 6, memoryMb: 8192, concurrency: 12 },
    }, OWNER);
    assert.equal(tuned.status, 200, JSON.stringify(tuned.json));
    assert.equal(tuned.json.runner.dockerResources.cpus, 6);
    assert.equal(tuned.json.runner.dockerResources.memoryMb, 8192);
    assert.equal(tuned.json.runner.dockerResources.concurrency, 12);
    const readTuned = await call('GET', `/v1/platform/runners/${id}`, undefined, OWNER);
    assert.match(readTuned.json.command, /WORKFLOW_RUNNER_CONCURRENCY=12 /);

    // Inference model limits are a separate namespace: patching them does not
    // rewrite the explicit Docker memory control.
    const withInference = await call('PATCH', `/v1/platform/runners/${id}`, {
      inference: { limits: { maxRssMb: 2048 } },
    }, OWNER);
    assert.equal(withInference.status, 200, JSON.stringify(withInference.json));
    assert.equal(withInference.json.runner.metadata.inference.limits.maxRssMb, 2048);
    assert.equal(withInference.json.runner.dockerResources.memoryMb, 8192);
    const readInference = await call('GET', `/v1/platform/runners/${id}`, undefined, OWNER);
    assert.match(readInference.json.command, /--memory=8192m/);

    const invalidPatch = await call('PATCH', `/v1/platform/runners/${id}`, {
      dockerResources: { concurrency: 64 },
    }, OWNER);
    assert.equal(invalidPatch.status, 400, JSON.stringify(invalidPatch.json));
    assert.equal(invalidPatch.json.error, 'invalid_docker_resources');

    const reset = await call('PATCH', `/v1/platform/runners/${id}`, { dockerResources: null }, OWNER);
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    // Reset returns to the legacy derivation, which still honours an explicit
    // inference model limit (maxRssMb 2048) but drops the Docker overrides.
    assert.deepEqual(reset.json.runner.dockerResources, {
      cpuEnabled: true, memoryEnabled: true, cpus: 2, memoryMb: 2048, concurrency: 8,
    });
    const readReset = await call('GET', `/v1/platform/runners/${id}`, undefined, OWNER);
    assert.match(readReset.json.command, /--cpus=2 --memory=2048m --memory-swap=2048m /);

    await call('DELETE', `/v1/platform/runners/${id}`, undefined, OWNER);
  });

  it('cannot bypass docker resource validation through generic metadata', async () => {
    const out = await call('POST', '/v1/platform/runners', {
      name: 'docker-metadata-bypass',
      kind: 'workflow',
      metadata: { dockerResources: { cpus: '2; touch /tmp/synapseone-pwned', memoryMb: 1 } },
    }, OWNER);
    assert.equal(out.status, 201, JSON.stringify(out.json));
    // Generic metadata cannot set the typed field: legacy defaults apply.
    assert.deepEqual(out.json.runner.dockerResources, {
      cpuEnabled: true, memoryEnabled: true, cpus: 2, memoryMb: 1024, concurrency: 8,
    });
    assert.doesNotMatch(out.json.command, /pwned|touch /);
    await call('DELETE', `/v1/platform/runners/${out.json.runner.id}`, undefined, OWNER);
  });

  it('renders a shell-safe command even when persisted docker metadata is tampered with', () => {
    const tampered = {
      id: 'runner-tampered',
      name: 'tampered',
      kind: 'workflow',
      scope: 'platform',
      mode: 'system',
      queue: 'synapseone-wf-system',
      status: 'waiting',
      metadata: {
        dockerResources: {
          cpuEnabled: true,
          memoryEnabled: true,
          cpus: '2; touch /tmp/synapseone-pwned',
          memoryMb: 1024,
          concurrency: '8; id',
        },
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as StoredWorkflowRunner;
    const command = runnerCommand(tampered, 'key with spaces');
    // Invalid persisted config falls back to validated legacy defaults …
    assert.match(command, /--cpus=2 --memory=1024m --memory-swap=1024m /);
    assert.match(command, /WORKFLOW_RUNNER_CONCURRENCY=8 /);
    // … and the malicious fragments never reach the rendered command.
    assert.doesNotMatch(command, /synapseone-pwned/);
    assert.doesNotMatch(command, /--cpus=2;/);
    assert.match(command, /-e SYNAPSEONE_API_KEY='key with spaces' /);
  });

  it('supports explicit docker controls on tenant runners without changing their legacy default shape', async () => {
    const legacy = await call('POST', '/v1/workflow-runners', { name: 'tenant-legacy-docker', kind: 'workflow' }, USER);
    assert.equal(legacy.status, 201, JSON.stringify(legacy.json));
    assert.equal(legacy.json.runner.dockerResources, null);
    assert.doesNotMatch(legacy.json.command, /--cpus=|--memory=/);
    assert.match(legacy.json.command, /WORKFLOW_RUNNER_CONCURRENCY=1 /);

    const tuned = await call('POST', '/v1/workflow-runners', {
      name: 'tenant-tuned-docker',
      kind: 'workflow',
      dockerResources: { cpuEnabled: false, memoryEnabled: true, cpus: 4, memoryMb: 2048, concurrency: 6 },
    }, USER);
    assert.equal(tuned.status, 201, JSON.stringify(tuned.json));
    assert.deepEqual(tuned.json.runner.dockerResources, {
      cpuEnabled: false, memoryEnabled: true, cpus: 4, memoryMb: 2048, concurrency: 6,
    });
    assert.doesNotMatch(tuned.json.command, /--cpus=/);
    assert.match(tuned.json.command, /--memory=2048m --memory-swap=2048m /);
    assert.match(tuned.json.command, /WORKFLOW_RUNNER_CONCURRENCY=6 /);

    const patched = await call('PATCH', `/v1/workflow-runners/${tuned.json.runner.id}`, {
      dockerResources: { memoryEnabled: false },
    }, USER);
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.runner.dockerResources.memoryEnabled, false);
    assert.equal(patched.json.runner.dockerResources.cpus, 4);
    const read = await call('GET', `/v1/workflow-runners/${tuned.json.runner.id}`, undefined, USER);
    assert.doesNotMatch(read.json.command, /--cpus=|--memory=/);

    for (const runner of [legacy.json.runner, tuned.json.runner]) {
      await call('DELETE', `/v1/workflow-runners/${runner.id}`, undefined, USER);
    }
  });
  it('preserves resource observation age and protects owner Docker settings from agent heartbeats', async () => {
    const created = await call('POST', '/v1/platform/runners', {
      name: 'observed-resource-age', kind: 'workflow',
      dockerResources: {cpuEnabled: true, memoryEnabled: true, cpus: 1, memoryMb: 512, concurrency: 2},
    }, OWNER);
    assert.equal(created.status, 201);
    const id = created.json.runner.id;
    const headers = {'Content-Type': 'application/json', 'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner', 'x-synapseone-runner': id, 'x-synapseone-scopes': 'workflow:*'};
    const old = new Date(Date.now() - 60000).toISOString();
    const metadata = {resources: {sampledAt: old, source: 'cgroup-v2',
      cpu: {limitCores: 1, usedCores: 0, availableCores: 1},
      memory: {limitMb: 512, usedMb: 32, availableMb: 480}},
      dockerResources: {cpuEnabled: false, memoryEnabled: false, cpus: 64, memoryMb: 262144, concurrency: 32}};
    const beat = await call('POST', `/v1/workflow-runners/${id}/heartbeat`, {
      instanceId: 'observed-resource-instance', concurrency: 2, metadata,
    }, headers);
    assert.equal(beat.status, 200, JSON.stringify(beat.json));
    assert.equal(beat.json.instance.metadata.resources.sampledAt, old);
    const saved = process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION;
    process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION = 'enforce';
    try {
      const stale = await call('POST', `/v1/platform/runners/${id}/test`, {type: 'workflow'}, OWNER);
      assert.equal(stale.status, 409, JSON.stringify(stale.json));
      assert.equal(stale.json.error, 'runner_resources_unavailable');
      metadata.resources.sampledAt = new Date().toISOString();
      await call('POST', `/v1/workflow-runners/${id}/heartbeat`, {instanceId: 'observed-resource-instance', concurrency: 2, metadata}, headers);
      const detail = await call('GET', `/v1/platform/runners/${id}`, undefined, OWNER);
      assert.equal(detail.json.runner.dockerResources.cpuEnabled, true);
      assert.equal(detail.json.runner.dockerResources.memoryMb, 512);
      assert.equal(detail.json.runner.dockerResources.concurrency, 2);
      assert.ok(Date.parse(detail.json.runner.instances[0].metadata.resources.sampledAt) > Date.now() - 45000);
    } finally {
      if (saved === undefined) delete process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION;
      else process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION = saved;
      await call('DELETE', `/v1/platform/runners/${id}`, undefined, OWNER);
    }
  });

  it('serves hourly request/concurrency/CPU history for the runner', async () => {
    const created = await call('POST', '/v1/platform/runners', {
      name: 'usage-history', kind: 'workflow',
      dockerResources: {cpuEnabled: true, memoryEnabled: true, cpus: 2, memoryMb: 1024, concurrency: 2},
    }, OWNER);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.runner.id;
    const headers = {'Content-Type': 'application/json', 'x-synapseone-internal': INTERNAL,
      'x-synapseone-kind': 'platform-runner', 'x-synapseone-runner': id, 'x-synapseone-scopes': 'workflow:*'};
    const beat = await call('POST', `/v1/workflow-runners/${id}/heartbeat`, {
      instanceId: 'usage-instance', concurrency: 2, heartbeatIntervalSeconds: 15,
      metadata: {resources: {sampledAt: new Date().toISOString(), source: 'cgroup-v2',
        cpu: {limitCores: 2, usedCores: 0.5, availableCores: 1.5},
        memory: {limitMb: 1024, usedMb: 256, availableMb: 768}}},
    }, headers);
    assert.equal(beat.status, 200, JSON.stringify(beat.json));

    const usage = await call('GET', `/v1/platform/runners/${id}/usage?interval=hour&hours=24`, undefined, OWNER);
    assert.equal(usage.status, 200, JSON.stringify(usage.json));
    assert.equal(usage.json.interval, 'hour');
    assert.ok(Array.isArray(usage.json.buckets) && usage.json.buckets.length >= 24);
    const sampled = usage.json.buckets.filter((bucket: any) => bucket.samples > 0);
    assert.equal(sampled.length, 1);
    assert.equal(sampled[0].cpuPercent, 25);
    assert.equal(sampled[0].memoryUsedMb, 256);
    assert.equal(typeof usage.json.buckets[0].requests.total, 'number');
    assert.equal(typeof usage.json.totals.total, 'number');

    const daily = await call('GET', `/v1/platform/runners/${id}/usage?interval=day&hours=168`, undefined, OWNER);
    assert.equal(daily.status, 200, JSON.stringify(daily.json));
    assert.equal(daily.json.interval, 'day');
    const weekly = await call('GET', `/v1/platform/runners/${id}/usage?interval=week&hours=8760`, undefined, OWNER);
    assert.equal(weekly.status, 200, JSON.stringify(weekly.json));
    assert.equal(weekly.json.interval, 'week');
    const monthly = await call('GET', `/v1/platform/runners/${id}/usage?interval=month&hours=26280`, undefined, OWNER);
    assert.equal(monthly.status, 200, JSON.stringify(monthly.json));
    assert.equal(monthly.json.interval, 'month');
    const bad = await call('GET', `/v1/platform/runners/${id}/usage?hours=abc`, undefined, OWNER);
    assert.equal(bad.status, 400);
    const badInterval = await call('GET', `/v1/platform/runners/${id}/usage?interval=year`, undefined, OWNER);
    assert.equal(badInterval.status, 400);
    await call('DELETE', `/v1/platform/runners/${id}`, undefined, OWNER);
  });

});
