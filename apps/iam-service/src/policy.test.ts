// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Unit tests for AWS-style policy evaluation (pure, no DB).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { evaluatePolicies, matchPattern, matchCondition, adminPolicy, workflowRunnerPolicy, validatePolicyDocument, MAX_GLOB_WILDCARDS } from './policy';

describe('matchPattern', () => {
  it('star matches all', () => {
    assert.equal(matchPattern('*', 'workflow:Execute'), true);
  });
  it('prefix:* matches service actions', () => {
    assert.equal(matchPattern('workflow:*', 'workflow:Execute'), true);
    assert.equal(matchPattern('workflow:*', 'iam:Delete'), false);
    // No over-match: prefix:* must not match a longer service name without ':'.
    assert.equal(matchPattern('workflow:*', 'workflowEvil:Execute'), false);
    assert.equal(matchPattern('workflow:*', 'workflow'), true);
    assert.equal(matchPattern('workflow:**', 'workflow'), true);
  });
  it('exact matches only itself', () => {
    assert.equal(matchPattern('iam:Create', 'iam:Create'), true);
    assert.equal(matchPattern('iam:Create', 'iam:Delete'), false);
  });
  it('arn-style resources', () => {
    const doc = { Version: '1', Statement: [{ Effect: 'Allow' as const, Action: 'workflow:Execute', Resource: 'arn:synapseone:acme:prod:workflow:*' }] };
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: 'arn:synapseone:acme:prod:workflow:etl' }).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: 'arn:synapseone:acme:staging:workflow:etl' }).allowed, false);
  });
  it('treats regex metacharacters as literals', () => {
    assert.equal(matchPattern('a.b*[x]', 'a.bZZ[x]'), true);
    assert.equal(matchPattern('a.b*[x]', 'axbZZx'), false);
  });
  it('collapses consecutive wildcards before applying the cap', () => {
    const pattern = `a${'*'.repeat(200)}b*c`;
    assert.equal(matchPattern(pattern, 'a---b---c'), true);
    assert.equal(matchPattern(pattern, 'a---c'), false);
    assert.equal(validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: pattern, Resource: '*' }] }), null);
  });
  it('fails closed above the wildcard-count cap', () => {
    const atCap = '*a'.repeat(MAX_GLOB_WILDCARDS);
    const overCap = `${atCap}*`;
    assert.equal(matchPattern(atCap, 'a'.repeat(MAX_GLOB_WILDCARDS)), true);
    assert.equal(matchPattern(overCap, 'a'.repeat(MAX_GLOB_WILDCARDS)), false);
    assert.ok(validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: overCap, Resource: '*' }] }));
  });
  it('evaluates catastrophic regex shapes within a strict linear-time budget', () => {
    const cases = [10, 12, 14, 16, 126].map((n) => ({
      pattern: `${'*a'.repeat(n)}*c*`,
      value: 'a'.repeat(n),
    }));
    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      for (const { pattern, value } of cases) assert.equal(matchPattern(pattern, value), false);
    }
    assert.ok(performance.now() - started < 500, `glob regression took ${performance.now() - started}ms`);
  });
});

describe('evaluatePolicies', () => {
  it('default deny with no policies', () => {
    assert.equal(evaluatePolicies([], { action: 'workflow:Execute', resource: '*' }).allowed, false);
  });
  it('allow works', () => {
    const r = evaluatePolicies([adminPolicy()], { action: 'anything:Do', resource: '*' });
    assert.equal(r.allowed, true);
  });
  it('explicit deny beats allow', () => {
    const r = evaluatePolicies([workflowRunnerPolicy('prod')], { action: 'iam:Delete', resource: '*' });
    assert.equal(r.allowed, false);
    const r2 = evaluatePolicies([workflowRunnerPolicy('prod')], { action: 'workflow:Execute', resource: 'arn:synapseone:acme:prod:workflow:etl' });
    assert.equal(r2.allowed, true);
    // Cross-account scope: prod policy must not match staging resources.
    const r3 = evaluatePolicies([workflowRunnerPolicy('prod')], { action: 'workflow:Execute', resource: 'arn:synapseone:acme:staging:workflow:etl' });
    assert.equal(r3.allowed, false);
  });
  it('deny in one doc overrides allow in another', () => {
    const allow = { Version: '1', Statement: [{ Effect: 'Allow' as const, Action: '*', Resource: '*' }] };
    const deny = { Version: '1', Statement: [{ Effect: 'Deny' as const, Action: 'org:Delete', Resource: '*' }] };
    assert.equal(evaluatePolicies([allow, deny], { action: 'org:Delete', resource: '*' }).allowed, false);
    assert.equal(evaluatePolicies([allow, deny], { action: 'org:Read', resource: '*' }).allowed, true);
  });
});

describe('conditions', () => {
  const docWith = (cond: any) => ({
    Version: '1',
    Statement: [{ Effect: 'Allow' as const, Action: 'workflow:Execute', Resource: '*', Condition: cond }],
  });
  it('StringEquals gate on org', () => {
    const doc = docWith({ StringEquals: { org: 'acme' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { org: 'acme' }).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { org: 'other' }).allowed, false);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, {}).allowed, false);
  });
  it('StringLike wildcard on email', () => {
    const doc = docWith({ StringLike: { email: '*@acme.local' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { email: 'a@acme.local' }).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { email: 'a@evil.com' }).allowed, false);
  });
  it('IfExists skips missing keys', () => {
    const doc = docWith({ StringEqualsIfExists: { team: 'etl' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, {}).allowed, true);
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { team: 'nope' }).allowed, false);
  });
  it('unknown operator is conservative (deny)', () => {
    const doc = docWith({ IpAddress: { sourceIp: '10.0.0.0/8' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { sourceIp: '10.1.2.3' }).allowed, false);
  });
  it('malformed conditions fail closed instead of becoming unconditional', () => {
    const doc = docWith('StringEquals');
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }).allowed, false);
    const nullCond = docWith(null);
    assert.equal(evaluatePolicies([nullCond], { action: 'workflow:Execute', resource: '*' }).allowed, false);
    assert.equal(matchCondition({ StringEquals: 'org' }, { org: 'acme' }), false);
  });
  it('overlong StringLike pattern never matches (ReDoS guard)', () => {
    const evil = 'a*'.repeat(200); // 400 chars > 256 cap
    assert.equal(matchCondition({ StringLike: { email: evil } }, { email: 'a@acme.local' }), false);
  });
  it('caps StringLike wildcards after collapsing runs and stays linear', () => {
    const collapsed = { StringLike: { email: `*${'*'.repeat(200)}@acme.local` } };
    assert.equal(matchCondition(collapsed, { email: 'a@acme.local' }), true);
    const evil = `${'*a'.repeat(126)}*c*`;
    const value = 'a'.repeat(126);
    const started = performance.now();
    for (let i = 0; i < 500; i++) assert.equal(matchCondition({ StringLike: { email: evil } }, { email: value }), false);
    assert.ok(performance.now() - started < 500, `StringLike regression took ${performance.now() - started}ms`);
    assert.ok(validatePolicyDocument(docWith({ StringLike: { email: evil } })));
  });
  it('oversized context value never matches', () => {
    const doc = docWith({ StringLike: { note: '*' } });
    assert.equal(evaluatePolicies([doc], { action: 'workflow:Execute', resource: '*' }, { note: 'x'.repeat(5000) }).allowed, false);
  });
});

describe('validatePolicyDocument', () => {
  it('accepts the admin policy', () => {
    assert.equal(validatePolicyDocument(adminPolicy()), null);
  });
  it('rejects missing/empty Statement', () => {
    assert.ok(validatePolicyDocument({}));
    assert.ok(validatePolicyDocument({ Statement: [] }));
  });
  it('rejects bad Effect + overlong patterns', () => {
    assert.ok(validatePolicyDocument({ Statement: [{ Effect: 'Maybe', Action: '*', Resource: '*' }] }));
    assert.ok(validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: 'x'.repeat(600), Resource: '*' }] }));
  });
  it('rejects statement floods + oversized conditions', () => {
    const many = Array.from({ length: 101 }, () => ({ Effect: 'Allow', Action: '*', Resource: '*' }));
    assert.ok(validatePolicyDocument({ Statement: many }));
    assert.ok(validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*', Condition: { StringEquals: { k: 'x'.repeat(9000) } } }] }));
  });
  it('rejects malformed/unsupported condition shapes', () => {
    for (const Condition of [
      'StringEquals',
      null,
      [],
      {},
      { IpAddress: { sourceIp: '10.0.0.0/8' } },
      { StringEquals: 'org' },
      { StringEquals: {} },
      { StringEquals: { org: { nested: true } } },
    ]) {
      assert.ok(validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*', Condition }] }), JSON.stringify(Condition));
    }
  });
});
