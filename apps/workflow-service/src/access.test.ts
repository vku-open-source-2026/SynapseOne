// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/* Copyright 2026 SynapseOne Contributors. Licensed under Apache-2.0. */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp, synapseoneCall, makeCredentialResolver, workflowRunPrincipal } from './index';
import { __clearMem, createHumanTaskRec, createCredentialRec } from './store';

const INTERNAL = 'workflow-access-regression';
// These are gateway-stamped principals, not headers a public client can set.
const OWNER = { 'content-type': 'application/json', 'x-synapseone-internal': INTERNAL,
  'x-synapseone-kind': 'apikey', 'x-synapseone-org': 'org-a', 'x-synapseone-account': 'technical-a' };
const MEMBER = { ...OWNER, 'x-synapseone-kind': 'user', 'x-synapseone-user': 'volunteer-a', 'x-synapseone-account': 'member-a' };
const USER_KEY = { ...MEMBER, 'x-synapseone-kind': 'apikey', 'x-synapseone-account': 'technical-a' };
const FOREIGN = { ...OWNER, 'x-synapseone-org': 'org-b' };
const ANON = { 'content-type': 'application/json', 'x-synapseone-internal': INTERNAL };
const DEFINITION = { nodes: [{ name: 'Start', type: 'manualTrigger', parameters: {} }], connections: {} };

describe('owner-only capability workflow isolation', () => {
  let base: string;
  let server: Server;
  const oldInternal = process.env.SYNAPSEONE_INTERNAL_SECRET;
  const oldMode = process.env.WORKFLOW_EXECUTION_MODE;
  before(async () => {
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    process.env.WORKFLOW_EXECUTION_MODE = 'inline';
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });
  beforeEach(() => __clearMem());
  after(async () => {
    if (oldInternal === undefined) delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    else process.env.SYNAPSEONE_INTERNAL_SECRET = oldInternal;
    if (oldMode === undefined) delete process.env.WORKFLOW_EXECUTION_MODE;
    else process.env.WORKFLOW_EXECUTION_MODE = oldMode;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function request(path: string, headers: Record<string, string> = OWNER, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, { headers, method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  async function create(definition: any = DEFINITION, settings: any = { access: { mode: 'owner-only' } }) {
    const result = await request('/v1/workflows', OWNER, 'POST', { name: 'protected', definition, settings, owner: 'volunteer-a' });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.owner, 'apikey:technical-a');
    return result.data;
  }

  it('hides protected workflows and blocks all management/execute routes from same-org users and their keys', async () => {
    const workflow = await create();
    for (const headers of [MEMBER, USER_KEY, FOREIGN, ANON]) {
      const list = await request('/v1/workflows', headers);
      assert.equal(list.status, 200);
      assert.equal(list.data.some((w: any) => w.id === workflow.id), false);
      const routes: Array<[string, string, unknown?]> = [
        [`/v1/workflows/${workflow.id}`, 'GET'],
        [`/v1/workflows/${workflow.id}`, 'PUT', { settings: { access: { mode: 'tenant' } } }],
        [`/v1/workflows/${workflow.id}/execute`, 'POST', { privileged: true }],
        [`/v1/workflows/${workflow.id}/activate`, 'POST', {}],
        [`/v1/workflows/${workflow.id}/deactivate`, 'POST', {}],
        [`/v1/workflows/${workflow.id}`, 'DELETE'],
      ];
      for (const [path, method, body] of routes) assert.equal((await request(path, headers, method, body)).status, 404, `${method} ${path}`);
    }
    assert.equal((await request(`/v1/workflows/${workflow.id}`, OWNER)).status, 200);
    assert.equal((await request(`/v1/workflows/${workflow.id}/execute`, OWNER, 'POST', {})).status, 200);
  });

  it('denies same-org nested workflow access and execution reads, while owner can run and inspect', async () => {
    const workflow = await create();
    const principal = { sub: 'volunteer-a', org: 'org-a', account: 'member-a', kind: 'user' };
    await assert.rejects(() => synapseoneCall('workflows', 'get', { id: workflow.id }, principal), /404/);
    await assert.rejects(() => synapseoneCall('workflows', 'execute', { id: workflow.id, input: {} }, principal), /404/);
    const run = await request(`/v1/workflows/${workflow.id}/execute`, OWNER, 'POST', { privateValue: 'sensitive' });
    assert.equal(run.status, 200);
    const executionId = run.data.executionId;
    assert.equal((await request(`/v1/executions/${executionId}?includeData=true`, OWNER)).status, 200);
    for (const headers of [MEMBER, USER_KEY, FOREIGN]) {
      assert.equal((await request(`/v1/executions/${executionId}?includeData=true`, headers)).status, 404);
      assert.deepEqual((await request(`/v1/executions?workflowId=${workflow.id}`, headers)).data.data, []);
    }
    assert.deepEqual((await synapseoneCall('executions', 'list', { workflowId: workflow.id }, principal) as any).data, []);
    await assert.rejects(() => synapseoneCall('executions', 'get', { id: executionId }, principal), /404/);
  });

  it('does not permit anonymous webhook or public MCP to bypass an owner-only policy', async () => {
    const hook = await create({ nodes: [{ name: 'Hook', type: 'webhook', parameters: { path: 'private-hook', auth: { mode: 'none' } } }], connections: {} });
    assert.equal((await request(`/v1/workflows/${hook.id}/activate`, OWNER, 'POST', {})).status, 200);
    assert.equal((await request('/webhook/private-hook', ANON, 'POST', {})).status, 404);
    const mcp = await create({ nodes: [{ name: 'Tool', type: 'mcpTrigger', parameters: { toolName: 'private_tool', public: true, readOnly: true } }], connections: {} });
    assert.equal((await request(`/v1/workflows/${mcp.id}/activate`, OWNER, 'POST', {})).status, 200);
    for (const headers of [MEMBER, ANON]) {
      const list = await request('/mcp', headers, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(list.data.result.tools.some((t: any) => t.name === 'private_tool'), false);
      const call = await request('/mcp', headers, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'private_tool', arguments: {} } });
      assert.ok(call.data.error || call.data.result?.isError);
    }
    const ownList = await request('/mcp', OWNER, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(ownList.data.result.tools.some((t: any) => t.name === 'private_tool'), true);
  });

  it('protects task visibility, decisions and fabricated execution attachments', async () => {
    const workflow = await create();
    const run = await request(`/v1/workflows/${workflow.id}/execute`, OWNER, 'POST', {});
    const task = await createHumanTaskRec({ execution_id: run.data.executionId, workflow_id: workflow.id,
      node_name: 'Review', title: 'Private review', org_id: 'org-a', account_id: 'technical-a' });
    assert.equal((await request(`/v1/human-tasks/${task.id}`, OWNER)).status, 200);
    assert.deepEqual((await request('/v1/human-tasks', MEMBER)).data.items, []);
    for (const suffix of ['', '/claim', '/complete', '/reject', '/expire']) {
      assert.equal((await request(`/v1/human-tasks/${task.id}${suffix}`, MEMBER, suffix ? 'POST' : 'GET', suffix ? { force: true, note: 'bypass' } : undefined)).status, 404);
    }
    assert.equal((await request('/v1/human-tasks', MEMBER, 'POST', { title: 'Forged', executionId: run.data.executionId })).status, 404);
    assert.equal((await request('/v1/human-tasks', MEMBER, 'POST', { title: 'Forged', workflowId: workflow.id })).status, 404);
  });

  it('validates policy and keeps legacy tenant workflows usable without permitting ownership capture', async () => {
    for (const access of [null, [], { mode: 'unknown' }, { mode: 'owner-only', owner: 'volunteer-a' }]) {
      assert.equal((await request('/v1/workflows', OWNER, 'POST', { definition: DEFINITION, settings: { access } })).status, 400);
    }
    assert.equal((await request('/v1/workflows', ANON, 'POST', { definition: DEFINITION, settings: { access: { mode: 'owner-only' } } })).status, 400);
    const legacy = await create(DEFINITION, {});
    assert.equal((await request(`/v1/workflows/${legacy.id}`, MEMBER)).status, 200);
    assert.equal((await request(`/v1/workflows/${legacy.id}`, MEMBER, 'PUT', { settings: { access: { mode: 'owner-only' } } })).status, 400);
    assert.equal((await request(`/v1/workflows/${legacy.id}`, OWNER, 'PUT', { settings: { access: { mode: 'owner-only' } } })).status, 200);
    assert.equal((await request(`/v1/workflows/${legacy.id}`, MEMBER)).status, 404);
  });

  it('binds new encrypted credentials to the creator and rejects same-account user keys on every access path', async () => {
    const created = await request('/v1/credentials', OWNER, 'POST', { accountId: 'technical-a',
      name: 'DX organization connector', kind: 'api-key', secret: 'test-only-connector-value', owner: 'volunteer-a' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.owner, 'apikey:technical-a');
    assert.equal(created.data.secret, undefined);
    const id = created.data.id;
    const ownPrincipal = { sub: 'apikey:technical-a', org: 'org-a', account: 'technical-a', kind: 'apikey' };
    const userPrincipal = { sub: 'volunteer-a', org: 'org-a', account: 'technical-a', kind: 'apikey' };
    assert.ok(await makeCredentialResolver(ownPrincipal)(id));
    assert.equal(await makeCredentialResolver(userPrincipal)(id), null);
    assert.equal(await makeCredentialResolver(null)(id), null);
    assert.deepEqual((await request('/v1/credentials?accountId=technical-a', USER_KEY)).data.data, []);
    for (const [suffix, method, body] of [
      ['', 'GET', undefined], ['/rotate', 'POST', { secret: 'hijack-test-value' }], ['', 'DELETE', undefined],
    ] as const) {
      assert.equal((await request(`/v1/credentials/${id}${suffix}`, USER_KEY, method, body)).status, 404);
    }
    const rotated = await request(`/v1/credentials/${id}/rotate`, OWNER, 'POST', { secret: 'rotated-test-value' });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.data.owner, 'apikey:technical-a');
    assert.equal((await makeCredentialResolver(ownPrincipal)(id))?.secret, 'rotated-test-value');
    assert.equal((await request(`/v1/credentials/${id}`, OWNER, 'DELETE')).status, 200);
  });

  it('preserves intentionally shared legacy credentials without granting access to new private ones', async () => {
    const legacy = await createCredentialRec({ account_id: 'technical-a', org_id: 'org-a', name: 'legacy shared',
      kind: 'bearer', secret: 'legacy-test-only-value' });
    const principal = { sub: 'volunteer-a', org: 'org-a', account: 'technical-a', kind: 'apikey' };
    assert.equal((await makeCredentialResolver(principal)(legacy.id))?.secret, 'legacy-test-only-value');
    assert.equal((await request(`/v1/credentials/${legacy.id}`, USER_KEY)).status, 200);
  });

  it('rejects caller-selected runAs impersonation and ignores legacy runAs on owned workflows', async () => {
    const result = await request('/v1/workflows', MEMBER, 'POST', { definition: DEFINITION, runAs: 'apikey:technical-a' });
    assert.equal(result.status, 403);
    assert.equal(result.data.error, 'invalid_run_as');
    assert.equal(workflowRunPrincipal({ owner_sub: 'volunteer-a', run_as: 'apikey:technical-a', org_id: 'org-a' })?.sub, 'volunteer-a');
  });
});
