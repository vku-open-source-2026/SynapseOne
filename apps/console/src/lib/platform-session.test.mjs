// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPlatform,
  isInvalidPlatformSession,
  mergePlatformSession,
  needsPlatformSessionRevalidation,
  PlatformError,
} from './platform-session.js';

test('platform /me replaces stale MFA, role and user flags without rotating the token', () => {
  const current = {
    token: 'platform-token',
    expiresAt: 123456,
    mfaRequired: true,
    stepUpRequired: true,
    mfa: { enabled: true },
    role: 'owner',
    user: { id: 'old-user' },
  };
  const next = mergePlatformSession(current, {
    mfaRequired: false,
    stepUpRequired: false,
    mfa: null,
    role: 'operator',
    user: { id: 'current-user' },
  });
  assert.deepEqual(next, {
    token: 'platform-token',
    expiresAt: 123456,
    mfaRequired: false,
    stepUpRequired: false,
    mfa: null,
    role: 'operator',
    user: { id: 'current-user' },
  });
});

test('platform session revalidation runs once for a restored token', () => {
  assert.equal(needsPlatformSessionRevalidation('restored', 'restored', null), true);
  assert.equal(needsPlatformSessionRevalidation('restored', 'restored', 'restored'), false);
  assert.equal(needsPlatformSessionRevalidation('restored', 'new', 'restored'), false);
  assert.equal(needsPlatformSessionRevalidation(null, null, null), false);
});

test('invalid platform session responses retain existing clearing semantics', () => {
  assert.equal(isInvalidPlatformSession(new PlatformError(401, '/v1/platform/me', { error: 'invalid_token' })), true);
  assert.equal(isInvalidPlatformSession(new PlatformError(403, '/v1/platform/me', { error: 'platform_admin_inactive' })), true);
  assert.equal(isInvalidPlatformSession(new PlatformError(401, '/v1/platform/me', { error: 'invalid_mfa_code' })), false);
  assert.equal(isInvalidPlatformSession(new PlatformError(500, '/v1/platform/me', { error: 'invalid_token' })), false);
});

test('platform revalidation performs one GET /v1/platform/me with the platform token', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ mfaRequired: false, stepUpRequired: false, mfa: null, role: 'operator', user: { id: 'u1' } }),
    };
  };
  const profile = await fetchPlatform('platform-token', '/v1/platform/me');
  assert.equal(profile.mfaRequired, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/platform\/me$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer platform-token');
});
