// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * httpRequest includeInput option.
 *
 * Engine-level tests with a fake fetch: no network, no credentials.
 * Covers default backward compatibility, opt-in input preservation,
 * input immutability and the combined output limit.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from './engine';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
}

const definition = (parameters: Record<string, unknown>) => ({
  nodes: [
    { name: 'Start', type: 'manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} },
    {
      name: 'Call',
      type: 'httpRequest',
      typeVersion: 4,
      position: [200, 0] as [number, number],
      parameters: { url: 'https://example.test/data', method: 'GET', ...parameters },
    },
  ],
  connections: { Start: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
});

describe('httpRequest includeInput', () => {
  it('default keeps the historical {statusCode, body} shape', async () => {
    fakeFetch({ ok: true });
    const result = await runWorkflow(definition({}), { alpha: 1 });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.output, { statusCode: 200, body: { ok: true } });
    assert.equal(Object.prototype.hasOwnProperty.call(result.output, 'input'), false);
  });

  it('includeInput:true returns a cloned copy of the incoming node value', async () => {
    fakeFetch({ ok: true });
    const input = { alpha: 1, nested: { deep: true }, list: [1, 2, 3] };
    const result = await runWorkflow(definition({ includeInput: true }), input);
    assert.equal(result.status, 'success');
    assert.equal(result.output.statusCode, 200);
    assert.deepEqual(result.output.body, { ok: true });
    assert.deepEqual(result.output.input, input);
    assert.notEqual(result.output.input, input);
    result.output.input.nested.deep = false;
    assert.equal(input.nested.deep, true, 'the incoming value must not be mutated');
  });

  it('counts input and body together against the output limit', async () => {
    const big = 'x'.repeat(300_000);
    fakeFetch({ big });
    const result = await runWorkflow(definition({ includeInput: true }), { big });
    assert.equal(result.status, 'error');
    assert.match(String(result.error || ''), /exceeds 500KB/);
  });

  it('a body-only response within the limit still passes with includeInput', async () => {
    const big = 'x'.repeat(300_000);
    fakeFetch({ big });
    const result = await runWorkflow(definition({ includeInput: true }), { small: true });
    assert.equal(result.status, 'success');
    assert.equal(result.output.body.big.length, 300_000);
    assert.deepEqual(result.output.input, { small: true });
  });
});
