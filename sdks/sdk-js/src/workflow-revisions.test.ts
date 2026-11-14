// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SynapseOneClient } from './index';

test('workflow revision precondition travels separately from user payload and composes with wait', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ url: req.url!, body: JSON.parse(text) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ executionId: 'run-1' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const client = new SynapseOneClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test-session' });
    const payload = { values: { count: 3 }, expectedRevision: 999 };
    await client.workflow.executeWorkflow('wf-1', payload, { expectedRevision: 7 });
    assert.equal(requests[0].url, '/v1/workflows/wf-1/execute?expectedRevision=7');
    assert.deepEqual(requests[0].body, payload);
    await client.workflow.executeWorkflow('wf-1', {}, { wait: true, timeoutMs: 2000, expectedRevision: 8 });
    assert.equal(requests[1].url, '/v1/workflows/wf-1/execute?wait=1&timeoutMs=2000&expectedRevision=8');
    await client.workflow.executeWorkflow('wf-1');
    assert.equal(requests[2].url, '/v1/workflows/wf-1/execute');
    for (const expectedRevision of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
      assert.throws(() => client.workflow.executeWorkflow('wf-1', {}, { expectedRevision }), RangeError);
    }
    assert.equal(requests.length, 3, 'invalid revision never reaches transport');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
