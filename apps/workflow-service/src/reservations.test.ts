// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { __clearMem, findActiveWebhookWorkflow, getWorkflowRec } from './store';

const INTERNAL = 'workflow-reservation-test';
const A = { 'content-type': 'application/json', 'x-synapseone-internal': INTERNAL, 'x-synapseone-user': 'user-a', 'x-synapseone-kind': 'user', 'x-synapseone-org': 'org-a', 'x-synapseone-account': 'acc-a' };
const B = { 'content-type': 'application/json', 'x-synapseone-internal': INTERNAL, 'x-synapseone-user': 'user-b', 'x-synapseone-kind': 'user', 'x-synapseone-org': 'org-b', 'x-synapseone-account': 'acc-b' };

function definition(kind: 'webhook' | 'mcp', name: string, isPublic = true) {
  return {
    nodes: [
      kind === 'webhook'
        ? { name: 'Hook', type: 'webhook', parameters: { path: name, httpMethod: 'POST' } }
        : { name: 'Tool', type: 'mcpTrigger', parameters: { toolName: name, public: isPublic, readOnly: true } },
      { name: 'Done', type: 'noOp', parameters: {} },
    ],
    connections: kind === 'webhook'
      ? { Hook: { main: [[{ node: 'Done' }]] } }
      : { Tool: { main: [[{ node: 'Done' }]] } },
  };
}

describe('global active workflow reservations', () => {
  let server: Server;
  let base = '';
  const saved = process.env.SYNAPSEONE_INTERNAL_SECRET;
  before(async () => {
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });
  beforeEach(() => __clearMem());
  after(async () => {
    if (saved === undefined) delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    else process.env.SYNAPSEONE_INTERNAL_SECRET = saved;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(path: string, headers: Record<string, string>, method = 'POST', body?: unknown) {
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
    return { status: response.status, json };
  }
  async function create(headers: Record<string, string>, def: any, name: string) {
    const out = await call('/v1/workflows', headers, 'POST', { name, definition: def });
    assert.equal(out.status, 201, JSON.stringify(out.json));
    return out.json;
  }
  async function activate(id: string, headers: Record<string, string>) {
    return call(`/v1/workflows/${id}/activate`, headers, 'POST', {});
  }

  it('re-checks global webhook paths when an active cross-tenant definition is updated', async () => {
    const victim = await create(A, definition('webhook', 'victim-hook'), 'victim');
    const attacker = await create(B, definition('webhook', 'attacker-hook'), 'attacker');
    assert.equal((await activate(victim.id, A)).status, 200);
    assert.equal((await activate(attacker.id, B)).status, 200);
    const hijack = await call(`/v1/workflows/${attacker.id}`, B, 'PUT', { definition: definition('webhook', 'victim-hook') });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.json.error, 'webhook_path_conflict');
    assert.equal((await getWorkflowRec(attacker.id))?.nodes[0].parameters.path, 'attacker-hook');
    assert.equal((await findActiveWebhookWorkflow('victim-hook'))?.id, victim.id);
  });

  it('re-checks public MCP names when an active cross-tenant definition is updated', async () => {
    const victim = await create(A, definition('mcp', 'victim_tool'), 'victim');
    const attacker = await create(B, definition('mcp', 'attacker_tool'), 'attacker');
    assert.equal((await activate(victim.id, A)).status, 200);
    assert.equal((await activate(attacker.id, B)).status, 200);
    const hijack = await call(`/v1/workflows/${attacker.id}`, B, 'PUT', { definition: definition('mcp', 'victim_tool') });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.json.error, 'mcp_tool_conflict');
    assert.equal((await getWorkflowRec(attacker.id))?.nodes[0].parameters.toolName, 'attacker_tool');
  });

  it('allows only one winner for concurrent cross-tenant webhook activations', async () => {
    const a = await create(A, definition('webhook', 'raced-hook'), 'a');
    const b = await create(B, definition('webhook', 'raced-hook'), 'b');
    const results = await Promise.all([activate(a.id, A), activate(b.id, B)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const active = await findActiveWebhookWorkflow('raced-hook');
    assert.ok(active && [a.id, b.id].includes(active.id));
  });

  it('allows only one winner for concurrent cross-tenant public MCP activations', async () => {
    const a = await create(A, definition('mcp', 'raced_tool'), 'a');
    const b = await create(B, definition('mcp', 'raced_tool'), 'b');
    const results = await Promise.all([activate(a.id, A), activate(b.id, B)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409)?.json.error, 'mcp_tool_conflict');
  });

  it('releases reservations on deactivation and keeps private MCP names tenant-scoped', async () => {
    const a = await create(A, definition('mcp', 'private_tool', false), 'a');
    const b = await create(B, definition('mcp', 'private_tool', false), 'b');
    assert.equal((await activate(a.id, A)).status, 200);
    assert.equal((await activate(b.id, B)).status, 200);
    assert.equal((await call(`/v1/workflows/${a.id}/deactivate`, A)).status, 200);
    assert.equal((await call(`/v1/workflows/${b.id}/deactivate`, B)).status, 200);
    const c = await create(B, definition('mcp', 'private_tool', true), 'c');
    assert.equal((await activate(c.id, B)).status, 200, 'deactivation must release the old reservation');
  });
});
