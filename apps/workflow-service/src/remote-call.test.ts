// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Self-hosted runner: public-API mapping tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteCredentialResolver, createRemoteSynapseOneCall } from './remote-call';

function fakeApi(handler?: (method: string, path: string, body?: any, headers?: any) => any) {
  const calls: Array<{ method: string; path: string; body?: any; headers?: any }> = [];
  return {
    calls,
    api: {
      base: 'https://api.example.test',
      request: async (method: string, path: string, body?: any, headers?: any) => {
        calls.push({ method, path, body, headers });
        return handler ? handler(method, path, body, headers) : { ok: true };
      },
    } as any,
  };
}

describe('self-hosted runner public API mapping', () => {
  it('maps documents, queue and inference calls onto /v1 routes', async () => {
    const { api, calls } = fakeApi(() => ({ ok: true }));
    const call = createRemoteSynapseOneCall(api);
    await call('base', 'query-documents', { collection: 'incidents', where: { status: 'open' }, limit: 5 });
    await call('base', 'create-document', { collection: 'incidents', data: { id: 'i1' } });
    await call('queue', 'publish', { queue: 'jobs', payload: { n: 1 } });
    await call('inference', 'embeddings', { input: 'hello', model: 'm' });
    await call('lds', 'publish-record', { datasourceId: 'ds', record: { id: 'e1' } });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
      'POST /v1/base/collections/incidents/query',
      'POST /v1/base/collections/incidents/documents',
      'POST /v1/queue/queues/jobs/messages',
      'POST /v1/inference/embeddings',
      'POST /v1/lds/datasources/ds/records',
    ]);
    assert.deepEqual(calls[0].body, { where: { status: 'open' }, limit: 5, offset: undefined });
  });

  it('runs nested workflows inline with a depth header and normalizes the result', async () => {
    const { api, calls } = fakeApi((_m, _p, _b, headers) => {
      assert.equal(headers['X-Workflow-Depth'], '2');
      return { status: 'success', executionId: 'exec-2', output: { doubled: 8 } };
    });
    const call = createRemoteSynapseOneCall(api, 1);
    const res: any = await call('workflows', 'execute', { id: 'child-1', input: { value: 4 } });
    assert.equal(calls[0].path, '/v1/workflows/child-1/execute?wait=1&inline=1&timeoutMs=60000');
    assert.deepEqual(calls[0].body, { value: 4 });
    assert.deepEqual(res, { ok: true, executionId: 'exec-2', workflow: undefined, output: { doubled: 8 } });
  });

  it('rejects nesting beyond the limit without calling the API', async () => {
    const { api, calls } = fakeApi();
    const call = createRemoteSynapseOneCall(api, 3);
    await assert.rejects(() => call('workflows', 'execute', { id: 'w' }), /nesting limit/);
    assert.equal(calls.length, 0);
  });

  it('resolves a credential only through the claimed job endpoint', async () => {
    const { api, calls } = fakeApi(() => ({ credentialId: 'cred-1', kind: 'bearer', secret: 'shhh' }));
    const resolver = createRemoteCredentialResolver(api, 'exec-1', 'runner-1');
    assert.deepEqual(await resolver('cred-1'), { kind: 'bearer', secret: 'shhh' });
    assert.equal(calls[0].path, '/v1/runner/jobs/exec-1/credentials');
    assert.deepEqual(calls[0].body, { runnerId: 'runner-1', credentialId: 'cred-1' });
  });
});
