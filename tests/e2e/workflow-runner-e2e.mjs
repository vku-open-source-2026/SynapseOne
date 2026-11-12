#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * End-to-end runner test — no inline fallback.
 *
 * Requires a real gateway + IAM + workflow-service + SynapseQueue stack.
 * Proves:
 *   - workflow-service reports transport=queue and a running platform worker
 *   - a self-hosted runner registers, heartbeats a connector instance and shows
 *     up in the Console/API list with a connected status
 *   - a custom-mode workflow is consumed from SynapseQueue by that runner
 *   - a platform-mode workflow is consumed by the built-in worker
 *   - both executions finish with the expected worker identity
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.SYNAPSEONE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const WORKFLOW_HEALTH_URL = (process.env.WORKFLOW_HEALTH_URL || 'http://localhost:4002/health').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || 'ci@acme.local';
const ORG = process.env.E2E_ORG || 'acme';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ENTRY = path.resolve(SCRIPT_DIR, '../../apps/workflow-service/dist/runner.js');
const RUNNER_ID_SUFFIX = Date.now().toString(36);

let TOKEN = '';
let accountId = '';
let runnerId = '';
let keyId = '';
let child = null;
let childLogs = '';
const workflowIds = [];
let fakeBackend = null;

async function api(pathname, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    throw new Error(`${options.method || 'GET'} ${pathname} -> ${res.status}: ${msg}`);
  }
  return body;
}

async function waitFor(fn, timeoutMs, label, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (last=${JSON.stringify(last).slice(0, 300)})` : ''}`);
}

async function waitExecution(id, timeoutMs = 60000) {
  return waitFor(async () => {
    const e = await api(`/v1/executions/${encodeURIComponent(id)}?includeData=true`);
    return e && !['queued', 'running'].includes(e.status) ? e : null;
  }, timeoutMs, `execution ${id}`);
}

async function waitConnection(timeoutMs = 20000) {
  return waitFor(async () => {
    const c = await api(`/v1/workflow-runners/${encodeURIComponent(runnerId)}/connection`);
    return c?.connected ? c : null;
  }, timeoutMs, 'runner connector heartbeat');
}

async function startFakeInferenceBackend() {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/embeddings')) {
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: 'fake-embed' }));
        return;
      }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
      res.end(JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        model: body.model || 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong-from-local-backend' }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}` };
}

function stopChild(signal = 'SIGTERM') {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(signal); } catch { clearTimeout(timer); resolve(); }
  });
}

async function main() {
  // 1. Service health: queue transport + platform worker must be live.
  const wfHealth = await fetch(WORKFLOW_HEALTH_URL).then((r) => r.json());
  assert.equal(wfHealth.transport, 'queue', `workflow is not using queue transport: ${JSON.stringify(wfHealth)}`);
  assert.equal(wfHealth.worker, 'platform', `platform worker is not enabled: ${JSON.stringify(wfHealth)}`);
  assert.equal(wfHealth.queue, 'ok', `SynapseQueue dependency is not healthy: ${JSON.stringify(wfHealth)}`);
  console.log(`health: transport=${wfHealth.transport} worker=${wfHealth.worker} queue=${wfHealth.queue}`);

  // 2. Login + account (runner API keys are account-scoped).
  const login = await api('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, orgSlug: ORG }),
  });
  TOKEN = login.accessToken;
  assert.ok(TOKEN, 'login did not return accessToken');
  const me = await api('/v1/auth/me');
  const orgId = me.user?.org_id;
  assert.ok(orgId, 'login user has no org_id');
  const accounts = await api(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`);
  assert.ok(Array.isArray(accounts) && accounts.length > 0, 'org has no accounts');
  accountId = accounts[0].id;

  const options = await api('/v1/workflow-runners/options');
  assert.ok(options.publicUrl, 'runner options missing publicUrl');
  assert.ok(options.image, 'runner options missing image');
  assert.equal(options.platformWorker.enabled, true, 'platform worker disabled');
  assert.ok(options.queues.custom, 'missing custom queue');
  assert.ok(options.queues.shared, 'missing shared queue');
  assert.ok(options.queues.inference, 'missing inference queue');
  assert.ok(Array.isArray(options.kinds) && options.kinds.includes('hybrid'), 'runner kinds missing hybrid');

  // 3. Create the runner key + hybrid registration (workflow + inference lanes).
  const scopes = ['workflow:*', 'queue:*', '*:read', 'base:query', 'base:vector-search', 'inference:*'];
  const key = await api(`/v1/accounts/${encodeURIComponent(accountId)}/keys`, {
    method: 'POST',
    body: JSON.stringify({ name: `e2e-runner-${RUNNER_ID_SUFFIX}`.slice(0, 100), scopes }),
  });
  keyId = key.id;
  assert.ok(key.apiKey, 'IAM did not return apiKey');

  fakeBackend = await startFakeInferenceBackend();
  const reg = await api('/v1/workflow-runners', {
    method: 'POST',
    body: JSON.stringify({
      name: `e2e-runner-${RUNNER_ID_SUFFIX}`,
      kind: 'hybrid',
      mode: 'custom',
      queue: options.queues.custom,
      inferenceQueue: options.queues.inference,
      apiKeyId: key.id,
      keyPrefix: key.prefix,
      scopes,
      apiKey: key.apiKey,
      metadata: { e2e: true, concurrency: 2, inferenceBackend: fakeBackend.url },
    }),
  });
  runnerId = reg.runner.id;
  assert.ok(runnerId, 'runner id missing');
  assert.equal(reg.runner.kind, 'hybrid');
  assert.deepEqual(reg.runner.capabilities, ['workflow', 'inference']);
  assert.match(reg.command, /SYNAPSEONE_API_KEY=/, 'install command does not include the API key');
  assert.match(reg.command, /WORKFLOW_RUNNER_ID=/, 'install command does not include the runner id');
  assert.match(reg.command, /WORKFLOW_RUNNER_KIND=hybrid/, 'install command does not include the runner kind');
  assert.match(reg.command, /WORKFLOW_RUNNER_INFERENCE_QUEUE=/, 'install command does not include the inference queue');
  assert.equal(reg.runner.status, 'waiting');
  console.log(`runner registered: ${runnerId} (hybrid)`);

  const waiting = await api(`/v1/workflow-runners/${encodeURIComponent(runnerId)}/connection`);
  assert.equal(waiting.connected, false);
  assert.equal(waiting.instanceCount, 0);

  // 4. Start the actual runner process against the public gateway.
  assert.ok(process.execPath, 'node executable missing');
  child = spawn(process.execPath, [RUNNER_ENTRY], {
    env: {
      ...process.env,
      SYNAPSEONE_URL: BASE,
      SYNAPSEONE_API_KEY: key.apiKey,
      WORKFLOW_RUNNER_ID: runnerId,
      WORKFLOW_RUNNER_CONCURRENCY: '2',
      WORKFLOW_RUNNER_POLL_MS: '200',
      WORKFLOW_RUNNER_LEASE_SECONDS: '60',
      WORKFLOW_RUNNER_HEARTBEAT_SECONDS: '5',
      WORKFLOW_RUNNER_INFERENCE_CONCURRENCY: '2',
      INFERENCE_RUNNER_URL: fakeBackend.url,
      INFERENCE_RUNNER_MODEL: 'fake-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { childLogs += String(d); });
  child.stderr.on('data', (d) => { childLogs += String(d); });
  child.on('exit', (code) => { childLogs += `\n[runner exited ${code}]\n`; });

  const connected = await waitConnection(20000);
  assert.equal(connected.connected, true);
  assert.equal(connected.instanceCount, 1);
  assert.equal(connected.connectedInstances, 1);
  const instance = connected.instances[0];
  assert.ok(instance.id, 'connector instance id missing');
  assert.ok(instance.hostname, 'connector hostname missing');
  assert.equal(instance.concurrency, 2, 'connector concurrency mismatch');
  assert.equal(instance.status, 'connected');
  assert.ok(instance.version, 'connector version missing');
  assert.deepEqual(connected.runner.capabilities, ['workflow', 'inference']);
  assert.equal(connected.runner.kind, 'hybrid');
  console.log(`connector connected: ${instance.id} host=${instance.hostname} v=${instance.version}`);

  const listed = await api('/v1/workflow-runners');
  const listedRunner = (listed.data || []).find((r) => r.id === runnerId);
  assert.ok(listedRunner, 'runner missing from list');
  assert.equal(listedRunner.connected, true);
  assert.equal(listedRunner.connectedInstances, 1);
  assert.equal(listedRunner.instances[0].id, instance.id);
  assert.equal(listedRunner.instances[0].concurrency, 2);

  // 5. Custom-mode workflow must be consumed by the runner (not inline).
  const customWf = await api('/v1/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `e2e-custom-${RUNNER_ID_SUFFIX}`,
      settings: { execution: { mode: 'custom', queue: options.queues.custom } },
      definition: {
        nodes: [
          { name: 'Start', type: 'manualTrigger', parameters: {} },
          { name: 'Set', type: 'set', parameters: { values: { lane: 'custom', value: '={{ $json.value }}' } } },
        ],
        connections: { Start: { main: [[{ node: 'Set' }]] } },
      },
    }),
  });
  workflowIds.push(customWf.id);
  const customRun = await api(`/v1/workflows/${encodeURIComponent(customWf.id)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ value: 42 }),
  });
  assert.equal(customRun.queued, true, 'custom execute did not queue');
  assert.equal(customRun.queue, options.queues.custom);
  const customExec = await waitExecution(customRun.executionId);
  assert.equal(customExec.status, 'success', `custom execution failed: ${customExec.error || ''}`);
  assert.equal(customExec.runner, 'custom');
  assert.equal(customExec.queue, options.queues.custom);
  assert.equal(customExec.workerId, runnerId, 'custom execution was not run by the registered runner');
  assert.equal(customExec.output.value, 42);
  assert.equal(customExec.output.lane, 'custom');
  console.log(`custom run OK: execution=${customExec.id} worker=${customExec.workerId}`);

  // 6. Inference job must be executed by the local backend through the hybrid runner.
  const inference = await api('/v1/inference-jobs', {
    method: 'POST',
    body: JSON.stringify({
      type: 'chat',
      payload: { model: 'request-model', messages: [{ role: 'user', content: 'ping' }] },
      queue: options.queues.inference,
    }),
  });
  assert.ok(inference.jobId, 'inference job id missing');
  assert.equal(inference.status, 'queued');
  const inferenceDone = await waitFor(async () => {
    const j = await api(`/v1/inference-jobs/${encodeURIComponent(inference.jobId)}?includeData=true`);
    return j && !['queued', 'running'].includes(j.status) ? j : null;
  }, 60000, 'inference job result');
  assert.equal(inferenceDone.status, 'success', `inference job failed: ${inferenceDone.error || ''}`);
  assert.equal(inferenceDone.runnerId, runnerId, 'inference job was not run by the hybrid runner');
  assert.equal(inferenceDone.result.choices[0].message.content, 'pong-from-local-backend');
  assert.equal(inferenceDone.result.model, 'fake-model');
  console.log(`inference job OK: id=${inference.jobId} runner=${inferenceDone.runnerId}`);

  // 7. Platform-mode workflow must be consumed by the built-in worker.
  const platformWf = await api('/v1/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `e2e-platform-${RUNNER_ID_SUFFIX}`,
      settings: { execution: { mode: 'platform' } },
      definition: {
        nodes: [
          { name: 'Start', type: 'manualTrigger', parameters: {} },
          { name: 'Set', type: 'set', parameters: { values: { lane: 'platform', value: '={{ $json.value }}' } } },
        ],
        connections: { Start: { main: [[{ node: 'Set' }]] } },
      },
    }),
  });
  workflowIds.push(platformWf.id);
  const platformRun = await api(`/v1/workflows/${encodeURIComponent(platformWf.id)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ value: 7 }),
  });
  assert.equal(platformRun.queued, true, 'platform execute did not queue');
  assert.equal(platformRun.queue, options.queues.platform);
  const platformExec = await waitExecution(platformRun.executionId);
  assert.equal(platformExec.status, 'success', `platform execution failed: ${platformExec.error || ''}`);
  assert.equal(platformExec.runner, 'platform');
  assert.ok(String(platformExec.workerId || '').startsWith('platform-'), `unexpected platform worker id: ${platformExec.workerId}`);
  assert.equal(platformExec.output.value, 7);
  console.log(`platform run OK: execution=${platformExec.id} worker=${platformExec.workerId}`);

  // 7. Graceful disconnect -> connector goes offline without waiting for stale timeout.
  await stopChild('SIGTERM');
  const offline = await waitFor(async () => {
    const c = await api(`/v1/workflow-runners/${encodeURIComponent(runnerId)}/connection`);
    return c.status === 'offline' || c.status === 'waiting' ? c : null;
  }, 15000, 'runner offline heartbeat');
  assert.equal(offline.connected, false);
  console.log(`runner disconnected: status=${offline.status}`);

  const edited = await api(`/v1/workflow-runners/${encodeURIComponent(runnerId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: `e2e-runner-${RUNNER_ID_SUFFIX}-edited` }),
  });
  assert.equal(edited.runner.name, `e2e-runner-${RUNNER_ID_SUFFIX}-edited`);
  const instanceId = offline.instances?.[0]?.id;
  if (instanceId) {
    const removed = await api(`/v1/workflow-runners/${encodeURIComponent(runnerId)}/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
    assert.equal(removed.deleted, true);
  }

  console.log('E2E runner: PASS');
  await cleanup();
}

async function cleanup() {
  await stopChild('SIGKILL');
  if (fakeBackend?.server) await new Promise((resolve) => fakeBackend.server.close(resolve));
  for (const id of workflowIds) {
    try { await api(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* best effort */ }
  }
  try {
    if (runnerId) await api(`/v1/workflow-runners/${encodeURIComponent(runnerId)}`, { method: 'DELETE' });
  } catch { /* best effort */ }
  try {
    if (keyId) await api(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  } catch { /* best effort */ }
}

main().catch(async (e) => {
  console.error('E2E runner FAILED:', e?.stack || e);
  if (childLogs) console.error('--- runner logs ---\n' + childLogs.slice(-4000));
  await cleanup();
  process.exit(1);
});
