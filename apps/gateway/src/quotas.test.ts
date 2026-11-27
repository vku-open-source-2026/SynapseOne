// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  QuotaManager, consumesWorkflowExecution, gatewayQuotaDefaults, quotaServiceForRoute,
} from './quotas';

const saved: Record<string, string | undefined> = {};
for (const key of ['AI_QUOTA_REQUESTS_PER_MIN', 'AI_QUOTA_REQUESTS_PER_5H', 'AI_QUOTA_REQUESTS_PER_DAY', 'WORKFLOW_QUOTA_CONCURRENT']) saved[key] = process.env[key];
beforeEach(() => {
  for (const key of Object.keys(saved)) delete process.env[key];
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('TypeScript/Rust quota parity helpers', () => {
  it('maps the same routes and execution-creating methods as Rust', () => {
    assert.equal(quotaServiceForRoute('/v1/ai/agent'), 'ai');
    assert.equal(quotaServiceForRoute('/v1/inference/chat/completions'), 'inference');
    assert.equal(quotaServiceForRoute('/v1/workflows'), 'workflow');
    assert.equal(quotaServiceForRoute('/mcp'), 'workflow');
    assert.equal(consumesWorkflowExecution('POST', '/mcp'), false);
    assert.equal(quotaServiceForRoute('/v1/base/collections'), null);
    assert.equal(consumesWorkflowExecution('POST', '/v1/workflows/w1/execute'), true);
    assert.equal(consumesWorkflowExecution('POST', '/v1/workflows/w1/test-run'), true);
    assert.equal(consumesWorkflowExecution('POST', '/v1/workflows/test-run'), true);
    assert.equal(consumesWorkflowExecution('POST', '/v1/inference-jobs'), true);
    assert.equal(consumesWorkflowExecution('POST', '/v1/inference-jobs/j1/complete'), false);
    assert.equal(consumesWorkflowExecution('GET', '/v1/workflows/w1/execute'), false);
  });

  it('derives five-hour/day defaults and uses the workflow concurrency default', () => {
    process.env.AI_QUOTA_REQUESTS_PER_MIN = '7';
    const defaults = gatewayQuotaDefaults();
    assert.equal(defaults.ai.requestsPerMin, 7);
    assert.equal(defaults.ai.requestsPer5h, 2100);
    assert.equal(defaults.ai.requestsPerDay, 10080);
    assert.equal(defaults.workflow.concurrentExecutions, 10);
    process.env.WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR = '5000000';
    assert.equal(gatewayQuotaDefaults().workflow.executionsPerHour, 1_000_000);
    process.env.AI_QUOTA_REQUESTS_PER_5H = '999';
    process.env.AI_QUOTA_REQUESTS_PER_DAY = '8888';
    const overridden = gatewayQuotaDefaults();
    assert.equal(overridden.ai.requestsPer5h, 999);
    assert.equal(overridden.ai.requestsPerDay, 8888);
  });
});

describe('TypeScript IAM quota client', () => {
  let server: http.Server;
  let base = '';
  let mode: 'ok' | 'outage' = 'ok';
  let checkMode: 'allowed' | 'fiveHour' | 'outage' = 'allowed';
  let executionMode: 'allowed' | 'concurrent' | 'outage' = 'allowed';
  let seenCheck: any = null;
  let seenExecution: any = null;
  let seenRelease: any = null;
  let seenInternal: string | undefined;

  before(async () => {
    server = http.createServer((req, res) => {
      seenInternal = req.headers['x-synapseone-internal'] as string | undefined;
      const send = (status: number, body: any) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url?.startsWith('/internal/quotas?')) {
        if (mode === 'outage') return send(503, { error: 'down' });
        return send(200, {
          service: 'ai', orgId: 'o1', overridden: false,
          requestsPerMin: 3, requestsPer5h: 900, requestsPerDay: 4320,
          tokensPerDay: 1000, executionsPerHour: null, concurrentExecutions: null,
        });
      }
      if (req.url === '/internal/quota/check') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seenCheck = JSON.parse(body);
          if (checkMode === 'outage') return send(503, { error: 'quota_unavailable' });
          if (checkMode === 'fiveHour') return send(200, {
            allowed: false, window: 'fiveHour', count: 900, limit: 900,
            retryAfterSeconds: 1234, resetAt: '2026-11-26T18:00:00.000Z',
          });
          send(200, { allowed: true, window: 'minute', count: 1, limit: 3, retryAfterSeconds: 0, resetAt: '2026-11-26T12:35:00.000Z' });
        });
        return;
      }
      if (req.url === '/internal/workflow/execution/check') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seenExecution = JSON.parse(body);
          if (executionMode === 'outage') return send(503, { error: 'quota_unavailable' });
          if (executionMode === 'concurrent') return send(200, {
            allowed: false, window: 'concurrent', count: 1, limit: 1,
            retryAfterSeconds: 60, resetAt: null, token: null,
          });
          send(200, {
            allowed: true, window: 'hour', count: 1, limit: 100,
            retryAfterSeconds: 0, resetAt: '2026-11-27T13:00:00.000Z', token: 'lease-test-1',
          });
        });
        return;
      }
      if (req.url === '/internal/workflow/execution/release') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seenRelease = JSON.parse(body);
          send(200, { released: true });
        });
        return;
      }
      send(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    mode = 'ok'; checkMode = 'allowed'; executionMode = 'allowed';
    seenCheck = null; seenExecution = null; seenRelease = null; seenInternal = undefined;
  });

  it('uses IAM effective limits even when no org override exists', async () => {
    const manager = new QuotaManager(base, 'internal-test', 30_000, gatewayQuotaDefaults());
    const lookup = await manager.effective('o1', 'ai');
    assert.equal(lookup.authoritative, true);
    assert.equal(lookup.quota.requestsPerMin, 3);
    assert.equal(lookup.quota.requestsPer5h, 900);
    assert.equal(lookup.quota.requestsPerDay, 4320);
    const allowed = await manager.check('org:o1', lookup.quota);
    assert.equal(allowed?.allowed, true);
    assert.equal(seenInternal, 'internal-test');
    assert.deepEqual(seenCheck.limits, { minute: 3, fiveHour: 900, day: 4320 });
  });

  it('uses the shared IAM execution lease contract for normal and MCP admissions', async () => {
    const manager = new QuotaManager(base, 'internal-test', 30_000, gatewayQuotaDefaults());
    const admitted = await manager.admitExecution('org:o1', 100, 1);
    assert.equal(admitted?.allowed, true);
    assert.equal(admitted?.token, 'lease-test-1');
    assert.equal(seenInternal, 'internal-test');
    assert.deepEqual(seenExecution, { subject: 'org:o1', limits: { hour: 100, concurrent: 1 } });
    assert.equal(await manager.releaseExecution('org:o1', 'lease-test-1'), true);
    assert.deepEqual(seenRelease, { subject: 'org:o1', token: 'lease-test-1' });

    executionMode = 'concurrent';
    const denied = await manager.admitExecution('org:o1', 100, 1);
    assert.equal(denied?.allowed, false);
    assert.equal(denied?.window, 'concurrent');
    assert.equal(denied?.retryAfterSeconds, 60);
    executionMode = 'outage';
    assert.equal(await manager.admitExecution('org:o1', 100, 1), null);
  });

  it('falls back to local defaults on IAM outage and preserves five-hour denial metadata', async () => {
    const manager = new QuotaManager(base, '', 30_000, gatewayQuotaDefaults());
    mode = 'outage';
    const lookup = await manager.effective('o1', 'ai');
    assert.equal(lookup.authoritative, false);
    assert.equal(lookup.quota.requestsPerMin, 30);
    mode = 'ok';
    checkMode = 'fiveHour';
    const denied = await manager.check('org:o1', lookup.quota);
    assert.equal(denied?.allowed, false);
    assert.equal(denied?.window, 'fiveHour');
    assert.equal(denied?.retryAfterSeconds, 1234);
    checkMode = 'outage';
    assert.equal(await manager.check('org:o1', lookup.quota), null);
  });
});
