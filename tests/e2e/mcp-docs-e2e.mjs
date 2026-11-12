#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * End-to-end MCP docs-reader: create the built-in template, activate it, then
 * read docs through POST /mcp as an AI client would.
 */
import assert from 'node:assert/strict';

const BASE = (process.env.SYNAPSEONE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || 'ci@acme.local';
const ORG = process.env.E2E_ORG || 'acme';
let TOKEN = '';
let workflowId = '';
let keyId = '';

async function api(pathname, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${pathname} -> ${res.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function rpc(method, params = {}) {
  const body = await api('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return body;
}

async function rpcNoAuth(method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function main() {
  const login = await api('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, orgSlug: ORG }),
  });
  TOKEN = login.accessToken;
  assert.ok(TOKEN, 'login did not return accessToken');

  const created = await api('/v1/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: `mcp-docs-${Date.now().toString(36)}`, template: 'mcp-docs-reader' }),
  });
  workflowId = created.id;
  assert.ok(workflowId, 'template did not create a workflow');
  const activated = await api(`/v1/workflows/${encodeURIComponent(workflowId)}/activate`, { method: 'POST', body: '{}' });
  assert.equal(activated.active, true);

  // The docs-reader tool is public read-only: no credential required.
  const anonList = await rpcNoAuth('tools/list');
  assert.ok((anonList.result?.tools || []).some((t) => t.name === 'read_synapseone_docs'), 'public MCP tool missing');
  const anonCall = await rpcNoAuth('tools/call', { name: 'read_synapseone_docs', arguments: { path: 'docs/README.md' } });
  assert.equal(anonCall.result.isError, undefined, JSON.stringify(anonCall.result));
  assert.match(anonCall.result.content?.[0]?.text || '', /SynapseOne docs/);
  console.log('MCP anonymous docs OK');

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'synapseone-synapseflow');

  const listed = await rpc('tools/list');
  const tool = (listed.result.tools || []).find((t) => t.name === 'read_synapseone_docs');
  assert.ok(tool, 'mcp-docs-reader tool missing from tools/list');
  assert.equal(tool.inputSchema.properties.path.type, 'string');

  const called = await rpc('tools/call', {
    name: 'read_synapseone_docs',
    arguments: { path: 'docs/README.md' },
  });
  assert.equal(called.result.isError, undefined, JSON.stringify(called.result));
  const text = called.result.content?.[0]?.text || '';
  assert.ok(text.length > 100, 'docs content is empty');
  assert.match(text, /SynapseOne docs/);
  console.log(`MCP docs OK: tool=${tool.name} chars=${text.length}`);

  // MCP clients that only support Authorization: Bearer <API key>.
  const me = await api('/v1/auth/me');
  const accounts = await api(`/v1/orgs/${encodeURIComponent(me.user.org_id)}/accounts`);
  assert.ok(accounts.length, 'no account for API key');
  const key = await api(`/v1/accounts/${encodeURIComponent(accounts[0].id)}/keys`, {
    method: 'POST',
    body: JSON.stringify({ name: `mcp-e2e-${Date.now().toString(36)}`, scopes: ['workflow:*'] }),
  });
  keyId = key.id;
  const keyRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  });
  const keyBody = await keyRes.json();
  assert.ok((keyBody.result?.tools || []).some((t) => t.name === 'read_synapseone_docs'), 'Bearer API key MCP auth failed');
  console.log('MCP Bearer API-key auth OK');

  await api(`/v1/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
  await api(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  console.log('E2E MCP docs: PASS');
}

main().catch(async (e) => {
  console.error('E2E MCP docs FAILED:', e?.stack || e);
  try {
    if (workflowId) await api(`/v1/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
  } catch { /* best effort */ }
  try {
    if (keyId) await api(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  } catch { /* best effort */ }
  process.exit(1);
});
