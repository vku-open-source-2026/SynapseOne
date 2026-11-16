// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Credential destination protection: auth.allowedOrigins must be checked on
 * the evaluated URL before credential resolution, never follow an unlisted
 * redirect, and never leak the resolved secret into node output/errors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HTTP_CREDENTIAL_DESTINATION_PROTECTION,
  runWorkflow,
} from './engine';

const GOOD = 'https://api.example.com';
const EVIL = 'https://evil.example.com';

const N = (name: string, parameters: Record<string, unknown>) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  parameters,
});

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function installFetch(handler: (call: FetchCall) => any) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers || {};
    for (const [key, value] of Object.entries(raw)) headers[String(key).toLowerCase()] = String(value);
    const call = { url: String(url), headers };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      (globalThis as any).fetch = original;
    },
  };
}

function response(status: number, body: unknown, location?: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location || null : null) },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

async function runHttp(
  parameters: Record<string, unknown>,
  input: Record<string, unknown> = {},
  credential?: { kind: string; secret: string },
) {
  let resolves = 0;
  const result = await runWorkflow(
    {
      nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, N('Request', parameters)],
      connections: { Start: { main: [[{ node: 'Request' }]] } } as any,
    },
    input,
    {
      credentialResolver: async () => {
        resolves += 1;
        return credential || { kind: 'api-key', secret: 'credential-secret-value' };
      },
    },
  );
  return { result, resolves };
}

describe('http credential destination protection', () => {
  it('advertises the engine capability marker', () => {
    assert.equal(HTTP_CREDENTIAL_DESTINATION_PROTECTION, 1);
  });

  it('rejects a static external URL before resolving or fetching the credential', async () => {
    const fetch = installFetch(() => response(200, { ok: true }));
    try {
      const { result, resolves } = await runHttp({
        url: EVIL,
        method: 'GET',
        auth: { credentialId: 'cred-1', header: 'X-API-Key', allowedOrigins: [GOOD] },
      });
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /allowedOrigins/);
      assert.equal(resolves, 0);
      assert.equal(fetch.calls.length, 0);
      assert.equal(JSON.stringify(result.nodeRuns).includes('credential-secret-value'), false);
    } finally {
      fetch.restore();
    }
  });

  it('rejects a dynamically evaluated external URL before credential resolution', async () => {
    const fetch = installFetch(() => response(200, { ok: true }));
    try {
      const { result, resolves } = await runHttp({
        url: '={{ $json.target }}',
        method: 'GET',
        auth: { credentialId: 'cred-1', header: 'X-API-Key', allowedOrigins: [GOOD] },
      }, { target: EVIL });
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /allowedOrigins/);
      assert.equal(resolves, 0);
      assert.equal(fetch.calls.length, 0);
    } finally {
      fetch.restore();
    }
  });

  it('rejects a same-origin-prefix spoof', async () => {
    const fetch = installFetch(() => response(200, { ok: true }));
    try {
      const { result, resolves } = await runHttp({
        url: 'https://api.example.com.evil.example/steal',
        method: 'GET',
        auth: { credentialId: 'cred-1', header: 'X-API-Key', allowedOrigins: [GOOD] },
      });
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /allowedOrigins/);
      assert.equal(resolves, 0);
      assert.equal(fetch.calls.length, 0);
    } finally {
      fetch.restore();
    }
  });

  it('rechecks redirects and never sends the credential to an unlisted hop', async () => {
    const fetch = installFetch((call) => {
      if (call.url === `${GOOD}/start`) return response(302, {}, `${EVIL}/steal`);
      return response(200, { leaked: true });
    });
    try {
      const { result, resolves } = await runHttp({
        url: `${GOOD}/start`,
        method: 'GET',
        auth: { credentialId: 'cred-1', header: 'X-API-Key', allowedOrigins: [GOOD] },
      });
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /redirect/);
      assert.equal(fetch.calls.length, 1, 'redirect target must not be fetched');
      assert.equal(fetch.calls[0].headers['x-api-key'], 'credential-secret-value');
      assert.equal(resolves, 1);
      assert.equal(JSON.stringify(result.nodeRuns).includes('credential-secret-value'), false);
      assert.equal(JSON.stringify(result.output || {}).includes('credential-secret-value'), false);
    } finally {
      fetch.restore();
    }
  });

  it('allows the configured Tier-2 origin and keeps the secret out of results', async () => {
    const fetch = installFetch(() => response(200, { ok: true }));
    try {
      const { result, resolves } = await runHttp({
        url: `${GOOD}/v1/capabilities/datasets/x/records`,
        method: 'POST',
        body: { value: 1 },
        auth: { credentialId: 'cred-1', header: 'X-API-Key', allowedOrigins: [GOOD] },
      });
      assert.equal(result.status, 'success');
      assert.equal(resolves, 1);
      assert.equal(fetch.calls.length, 1);
      assert.equal(fetch.calls[0].headers['x-api-key'], 'credential-secret-value');
      assert.equal(JSON.stringify(result.nodeRuns).includes('credential-secret-value'), false);
    } finally {
      fetch.restore();
    }
  });

  it('rejects missing, empty, wildcard, path, malformed and non-origin restrictions', async () => {
    const badRestrictions: unknown[] = [
      undefined,
      [],
      ['*'],
      [`${GOOD}/`],
      [`${GOOD}/v1`],
      ['https://'],
      [42],
      ['ftp://api.example.com'],
    ];
    for (const allowedOrigins of badRestrictions) {
      const fetch = installFetch(() => response(200, { ok: true }));
      try {
        const auth: Record<string, unknown> = { credentialId: 'cred-1', header: 'X-API-Key' };
        if (allowedOrigins !== undefined) auth.allowedOrigins = allowedOrigins;
        const { result, resolves } = await runHttp({ url: `${GOOD}/x`, method: 'GET', auth });
        assert.equal(result.status, 'error', JSON.stringify(allowedOrigins));
        assert.equal(resolves, 0, JSON.stringify(allowedOrigins));
        assert.equal(fetch.calls.length, 0, JSON.stringify(allowedOrigins));
      } finally {
        fetch.restore();
      }
    }
  });

  it('rejects the top-level credentialId alias without an origin restriction', async () => {
    const fetch = installFetch(() => response(200, { ok: true }));
    try {
      const { result, resolves } = await runHttp({
        url: `${GOOD}/x`,
        method: 'GET',
        credentialId: 'cred-1',
      });
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /allowedOrigins/);
      assert.equal(resolves, 0);
      assert.equal(fetch.calls.length, 0);
    } finally {
      fetch.restore();
    }
  });
});
