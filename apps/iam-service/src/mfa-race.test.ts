// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Concurrent second-factor replay regression: one TOTP step and one recovery
 * code must each succeed exactly once even when two requests race.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beginTotpEnrolment, checkSecondFactor, enableTotp, totp, base32Decode } from './mfa';

describe('MFA concurrent replay protection', () => {
  it('accepts a TOTP step exactly once under concurrency', async () => {
    delete process.env.DATABASE_URL;
    const userId = randomUUID();
    const started = await beginTotpEnrolment(userId);
    assert.ok(started);
    await enableTotp(userId);
    const code = totp(base32Decode(started!.secret));
    const results = await Promise.all([
      checkSecondFactor(userId, { code }),
      checkSecondFactor(userId, { code }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
  });

  it('accepts a recovery code exactly once under concurrency', async () => {
    delete process.env.DATABASE_URL;
    const userId = randomUUID();
    const started = await beginTotpEnrolment(userId);
    assert.ok(started);
    const codes = await enableTotp(userId);
    const results = await Promise.all([
      checkSecondFactor(userId, { recoveryCode: codes[0] }),
      checkSecondFactor(userId, { recoveryCode: codes[0] }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
  });
});
