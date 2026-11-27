// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { __clearMem, createCredentialRec, createExecutionRec, getExecutionRec } from './store';

const INTERNAL = 'runner-bound-key-test';
const OWNER = {
  'content-type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'owner',
  'x-synapseone-kind': 'user',
  'x-synapseone-org': 'org-a',
  'x-synapseone-account': 'acc-a',
  'x-synapseone-scopes': '*',
};
const ATTACKER = { ...OWNER, 'x-synapseone-user': 'attacker' };
const boundKey = (keyId: string) => ({
  'content-type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'owner',
  'x-synapseone-kind': 'apikey',
  'x-synapseone-org': 'org-a',
  'x-synapseone-account': 'acc-a',
  'x-synapseone-key-id': keyId,
  'x-synapseone-scopes': 'workflow:*',
});

describe('runner job credential binding', () => {
  let server: Server;
  let base = '';
  const savedInternal = process.env.SYNAPSEONE_INTERNAL_SECRET;
  const savedKey = process.env.SYNAPSEONE_CREDENTIAL_KEY;
  before(async () => {
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    process.env.SYNAPSEONE_CREDENTIAL_KEY = '11'.repeat(32);
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });
  beforeEach(() => __clearMem());
  after(async () => {
    if (savedInternal === undefined) delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    else process.env.SYNAPSEONE_INTERNAL_SECRET = savedInternal;
    if (savedKey === undefined) delete process.env.SYNAPSEONE_CREDENTIAL_KEY;
    else process.env.SYNAPSEONE_CREDENTIAL_KEY = savedKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(path: string, headers: Record<string, string>, body: any) {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
    return { status: response.status, json };
  }

  it('rejects same-tenant JWTs on every job operation and accepts the registered runner key', async () => {
    const runnerResponse = await fetch(base + '/v1/workflow-runners', {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({ name: 'bound-runner', mode: 'custom', apiKeyId: 'key-bound', keyPrefix: 'syn_test_' }),
    });
    assert.equal(runnerResponse.status, 201);
    const { runner } = await runnerResponse.json() as any;
    assert.equal(runner.apiKeyId, 'key-bound');

    const credential = await createCredentialRec({
      account_id: 'acc-a', org_id: 'org-a', owner_sub: 'owner', name: 'runner-secret', kind: 'bearer', secret: 'test-only-secret',
    });
    const workflowResponse = await fetch(base + '/v1/workflows', {
      method: 'POST', headers: OWNER,
      body: JSON.stringify({
        name: 'credentialed',
        settings: { execution: { mode: 'custom' } },
        definition: {
          nodes: [
            { name: 'Start', type: 'manualTrigger', parameters: {} },
            { name: 'HTTP', type: 'httpRequest', parameters: { url: 'https://example.com', auth: { credentialId: credential.id, allowedOrigins: ['https://example.com'] } } },
          ],
          connections: { Start: { main: [[{ node: 'HTTP' }]] } },
        },
      }),
    });
    assert.equal(workflowResponse.status, 201);
    const workflow = await workflowResponse.json() as any;
    const execution = await createExecutionRec({
      workflow_id: workflow.id, workflow_name: workflow.name, workflow_revision: workflow.revision,
      status: 'queued', input: { value: 1 }, output: null, node_runs: [], triggered_by: 'manual',
      principal: { sub: 'owner', org: 'org-a', account: 'acc-a', kind: 'user' },
      queue_name: runner.queue, runner: 'custom', startedAt: new Date().toISOString(),
    });
    const claimBody = { runnerId: runner.id, instanceId: 'connector-1', leaseSeconds: 60 };
    const path = `/v1/runner/jobs/${execution.id}`;

    for (const headers of [ATTACKER, boundKey('key-unrelated'), { ...boundKey('key-bound'), 'x-synapseone-kind': 'user' }]) {
      const denied = await call(`${path}/claim`, headers, claimBody);
      assert.equal(denied.status, 404);
      assert.equal(denied.json.secret, undefined);
      assert.equal((await getExecutionRec(execution.id))?.status, 'queued');
    }

    const claimed = await call(`${path}/claim`, boundKey('key-bound'), claimBody);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
    assert.equal(claimed.json.executionId, execution.id);
    const running = { ...claimBody, attempt: claimed.json.attempt };
    const credentialBody = { ...running, credentialId: credential.id };

    const noRead = await call(`${path}/credentials`, ATTACKER, credentialBody);
    assert.equal(noRead.status, 404);
    assert.equal(noRead.json.secret, undefined);
    const noHeartbeat = await call(`${path}/heartbeat`, ATTACKER, running);
    assert.equal(noHeartbeat.status, 404);
    const noComplete = await call(`${path}/complete`, ATTACKER, { ...running, status: 'success', output: { stolen: true } });
    assert.equal(noComplete.status, 404);
    assert.equal((await getExecutionRec(execution.id))?.status, 'running');

    const secret = await call(`${path}/credentials`, boundKey('key-bound'), credentialBody);
    assert.equal(secret.status, 200, JSON.stringify(secret.json));
    assert.equal(secret.json.secret, 'test-only-secret');
    assert.equal((await call(`${path}/heartbeat`, boundKey('key-bound'), running)).status, 200);
    const complete = await call(`${path}/complete`, boundKey('key-bound'), { ...running, status: 'success', output: { ok: true } });
    assert.equal(complete.status, 200, JSON.stringify(complete.json));
    assert.equal((await getExecutionRec(execution.id))?.status, 'success');
  });
});
