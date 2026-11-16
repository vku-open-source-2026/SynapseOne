// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * TOTP MFA + login lockout. In-memory IAM, ephemeral HTTP server.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { verifyAccess } from './tokens';
import {
  base32Decode, base32Encode, hotp, openSecret, sealSecret, totp, verifyTotp, verifyMfaChallenge, signMfaChallenge,
} from './mfa';

let base = '';
let server: Server;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: any, token?: string) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}

const PASSWORD = 'correct horse battery staple';

async function register(orgSlug: string, email: string) {
  const r = await call('POST', '/v1/auth/register', { email, password: PASSWORD, orgSlug });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

/** Code for the step after the current one (accepted by the ±1 window, not yet used). */
function nextCode(secretB32: string, stepsAhead = 1): string {
  return totp(base32Decode(secretB32), Date.now() + stepsAhead * 30_000);
}

async function enrol(token: string) {
  const setup = await call('POST', '/v1/auth/mfa/totp/setup', {}, token);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const enable = await call('POST', '/v1/auth/mfa/totp/enable', { code: totp(base32Decode(setup.data.secret)) }, token);
  assert.equal(enable.status, 200, JSON.stringify(enable.data));
  return { secret: setup.data.secret as string, recoveryCodes: enable.data.recoveryCodes as string[] };
}

describe('TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = Buffer.from('12345678901234567890');
    assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
    assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  });

  it('round-trips base32 and sealed secrets', () => {
    const raw = Buffer.from('0123456789abcdefghij');
    assert.deepEqual(base32Decode(base32Encode(raw)), raw);
    const sealed = sealSecret(raw);
    assert.ok(!sealed.includes(base32Encode(raw)));
    assert.deepEqual(openSecret(sealed), raw);
  });

  it('rejects replayed and out-of-window codes', () => {
    const secret = Buffer.from('12345678901234567890');
    const now = 1_800_000_000_000;
    const step = verifyTotp(secret, totp(secret, now), null, now);
    assert.ok(step);
    assert.equal(verifyTotp(secret, totp(secret, now), step, now), null, 'same step twice');
    assert.equal(verifyTotp(secret, totp(secret, now - 5 * 30_000), null, now), null, 'too old');
    assert.equal(verifyTotp(secret, 'abc123', null, now), null);
  });

  it('challenge tokens are never access tokens', () => {
    const { mfaToken } = signMfaChallenge('00000000-0000-0000-0000-000000000001', 'pwd');
    assert.throws(() => verifyAccess(mfaToken));
    assert.equal(verifyMfaChallenge(mfaToken)?.sub, '00000000-0000-0000-0000-000000000001');
    assert.equal(verifyMfaChallenge(mfaToken + 'x'), null);
  });
});

describe('MFA sign-in flow', () => {
  it('enrols, then requires the second factor at login', async () => {
    const reg = await register('mfa-flow', 'alice@mfa.local');
    const status0 = await call('GET', '/v1/auth/mfa', undefined, reg.accessToken);
    assert.equal(status0.data.enabled, false);

    const { secret, recoveryCodes } = await enrol(reg.accessToken);
    assert.equal(recoveryCodes.length, 10);
    const status1 = await call('GET', '/v1/auth/mfa', undefined, reg.accessToken);
    assert.equal(status1.data.enabled, true);
    assert.equal(status1.data.recoveryCodesRemaining, 10);

    const again = await call('POST', '/v1/auth/mfa/totp/setup', {}, reg.accessToken);
    assert.equal(again.status, 409, 'cannot silently replace an active factor');

    const login = await call('POST', '/v1/auth/login', { email: 'alice@mfa.local', password: PASSWORD, orgSlug: 'mfa-flow' });
    assert.equal(login.status, 401);
    assert.equal(login.data.error, 'mfa_required');
    assert.ok(login.data.mfaToken);
    assert.equal(login.data.accessToken, undefined, 'no session before the second factor');

    const bad = await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, code: '000000' });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, 'invalid_mfa_code');

    const ok = await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, code: nextCode(secret) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(ok.data.accessToken);
    assert.equal(ok.data.mfa.method, 'totp');

    const replay = await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, code: nextCode(secret) });
    assert.equal(replay.status, 401, 'a TOTP code works once');
  });

  it('accepts each recovery code once and can disable MFA', async () => {
    const reg = await register('mfa-recovery', 'bob@mfa.local');
    const { recoveryCodes } = await enrol(reg.accessToken);
    const login = await call('POST', '/v1/auth/login', { email: 'bob@mfa.local', password: PASSWORD, orgSlug: 'mfa-recovery' });
    const used = await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, recoveryCode: recoveryCodes[0].toUpperCase() });
    assert.equal(used.status, 200, JSON.stringify(used.data));
    assert.equal(used.data.mfa.recoveryCodesRemaining, 9);
    const reused = await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, recoveryCode: recoveryCodes[0] });
    assert.equal(reused.status, 401);

    const noCode = await call('POST', '/v1/auth/mfa/disable', {}, used.data.accessToken);
    assert.equal(noCode.status, 400);
    const off = await call('POST', '/v1/auth/mfa/disable', { recoveryCode: recoveryCodes[1] }, used.data.accessToken);
    assert.equal(off.status, 200);
    const plain = await call('POST', '/v1/auth/login', { email: 'bob@mfa.local', password: PASSWORD, orgSlug: 'mfa-recovery' });
    assert.equal(plain.status, 200);
    assert.ok(plain.data.accessToken);
  });

  it('regenerates recovery codes with a valid TOTP code', async () => {
    const reg = await register('mfa-regen', 'carol@mfa.local');
    const { secret, recoveryCodes } = await enrol(reg.accessToken);
    const regen = await call('POST', '/v1/auth/mfa/recovery-codes', { code: nextCode(secret) }, reg.accessToken);
    assert.equal(regen.status, 200);
    assert.equal(regen.data.recoveryCodes.length, 10);
    assert.notDeepEqual(regen.data.recoveryCodes, recoveryCodes);
  });

  it('refuses MFA management without a user session', async () => {
    const r = await call('POST', '/v1/auth/mfa/totp/setup', {});
    assert.equal(r.status, 401);
  });
});

describe('login lockout', () => {
  it('locks after repeated wrong passwords and an org admin can unlock', async () => {
    const reg = await register('lockout', 'dave@lock.local');
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/v1/auth/login', { email: 'dave@lock.local', password: 'wrong password 123', orgSlug: 'lockout' });
      assert.equal(r.status, 401);
    }
    const locked = await call('POST', '/v1/auth/login', { email: 'dave@lock.local', password: PASSWORD, orgSlug: 'lockout' });
    assert.equal(locked.status, 429);
    assert.equal(locked.data.error, 'account_locked');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);

    const userId = verifyAccess(reg.accessToken).sub as string;
    const unlock = await call('POST', `/v1/users/${userId}/unlock`, {}, reg.accessToken);
    assert.equal(unlock.status, 200, JSON.stringify(unlock.data));
    const login = await call('POST', '/v1/auth/login', { email: 'dave@lock.local', password: PASSWORD, orgSlug: 'lockout' });
    assert.equal(login.status, 200);
  });

  it('counts wrong second-factor codes towards the lockout', async () => {
    const reg = await register('lockout-mfa', 'erin@lock.local');
    const { secret } = await enrol(reg.accessToken);
    const login = await call('POST', '/v1/auth/login', { email: 'erin@lock.local', password: PASSWORD, orgSlug: 'lockout-mfa' });
    for (let i = 0; i < 5; i++) {
      await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, code: '000000' });
    }
    const blocked = await call('POST', '/v1/auth/mfa/verify', { mfaToken: login.data.mfaToken, code: nextCode(secret) });
    assert.equal(blocked.status, 429);

    const userId = verifyAccess(reg.accessToken).sub as string;
    const reset = await call('DELETE', `/v1/users/${userId}/mfa`, undefined, reg.accessToken);
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    assert.equal(reset.data.removed, true);
    const plain = await call('POST', '/v1/auth/login', { email: 'erin@lock.local', password: PASSWORD, orgSlug: 'lockout-mfa' });
    assert.equal(plain.status, 200);
  });
});
