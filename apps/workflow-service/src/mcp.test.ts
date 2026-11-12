// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * MCP trigger: active workflows exposed as MCP tools over JSON-RPC.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { buildTemplate, createApp, findMcpTrigger, validateDefinition } from './index';
import { __clearMem } from './store';

const INTERNAL = 'mcp-test-secret';
const H = {
  'Content-Type': 'application/json',
  'x-synapseone-internal': INTERNAL,
  'x-synapseone-user': 'mcp@example.com',
  'x-synapseone-org': 'org-mcp',
  'x-synapseone-account': 'acc-mcp',
  'x-synapseone-kind': 'user',
};

async function rpc(base: string, method: string, params: any = {}, headers: Record<string, string> = H) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('MCP trigger', () => {
  let server: Server;
  let base = '';
  let toolName = '';

  before(async () => {
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    __clearMem();
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  });

  after(() => new Promise<void>((resolve) => {
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    server.close(() => resolve());
  }));

  it('ships a valid mcp-docs-reader template and matching git JSON', () => {
    const tpl = buildTemplate('mcp-docs-reader');
    assert.ok(tpl);
    assert.equal(validateDefinition(tpl), null);
    const trig = findMcpTrigger(tpl);
    assert.ok(trig);
    assert.equal(trig.toolName, 'read_synapseone_docs');
    const file = path.join(__dirname, '..', '..', '..', 'workflows', 'mcp-docs-reader.json');
    assert.ok(fs.existsSync(file), `missing ${file}`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const strip = (nodes: any[]) => nodes.map(({ id, ...rest }: any) => rest);
    assert.deepEqual(strip(tpl.nodes), strip(doc.nodes));
    assert.deepEqual(tpl.connections, doc.connections);
    assert.deepEqual(tpl.settings, doc.settings);
  });

  it('initialize, tools/list and tools/call work over JSON-RPC', async () => {
    toolName = `echo_${Date.now().toString(36)}`;
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        name: 'mcp-echo',
        definition: {
          nodes: [
            {
              name: 'MCP Trigger', type: 'mcpTrigger',
              parameters: {
                toolName,
                description: 'Echo the input path',
                inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
              },
            },
            { name: 'Answer', type: 'code', parameters: { code: "return { content: 'read:' + String($input.path || '') };" } },
          ],
          connections: { 'MCP Trigger': { main: [[{ node: 'Answer' }]] } },
        },
      }),
    });
    assert.equal(created.status, 201);
    const wf: any = await created.json();
    const act = await fetch(`${base}/v1/workflows/${wf.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(act.status, 200);

    const init = await rpc(base, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.body.result.serverInfo.name, 'synapseone-synapseflow');
    assert.ok(init.body.result.capabilities.tools);

    const listed = await rpc(base, 'tools/list');
    assert.ok(Array.isArray(listed.body.result.tools));
    const tool = listed.body.result.tools.find((t: any) => t.name === toolName);
    assert.ok(tool, JSON.stringify(listed.body));
    assert.equal(tool.description, 'Echo the input path');
    assert.equal(tool.inputSchema.properties.path.type, 'string');

    const called = await rpc(base, 'tools/call', { name: toolName, arguments: { path: 'docs/api.md' } });
    assert.equal(called.body.result.isError, undefined);
    assert.equal(called.body.result.content[0].text, 'read:docs/api.md');

    const exec = await fetch(`${base}/v1/executions?workflowId=${encodeURIComponent(wf.id)}&triggeredBy=mcp`, { headers: H });
    const execBody: any = await exec.json();
    assert.equal(execBody.data.length, 1);
    assert.equal(execBody.data[0].status, 'success');
  });

  it('rejects MCP calls without a gateway identity', async () => {
    const res = await rpc(base, 'tools/list', {}, { 'Content-Type': 'application/json', 'x-synapseone-internal': INTERNAL });
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, -32001);
  });

  it('blocks a duplicate active MCP tool name', async () => {
    const created = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        name: 'mcp-duplicate',
        definition: {
          nodes: [
            { name: 'MCP Trigger', type: 'mcpTrigger', parameters: { toolName, description: 'dup' } },
            { name: 'Done', type: 'noOp', parameters: {} },
          ],
          connections: { 'MCP Trigger': { main: [[{ node: 'Done' }]] } },
        },
      }),
    });
    assert.equal(created.status, 201);
    const wf: any = await created.json();
    const act = await fetch(`${base}/v1/workflows/${wf.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(act.status, 409);
    assert.equal((await act.json()).error, 'mcp_tool_conflict');
  });
});
