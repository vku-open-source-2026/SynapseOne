// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mfaStatusAvailable, platformMfaFormRequired } from './mfa.js';

test('platform MFA form follows runtime config unless the server challenges', () => {
  assert.equal(platformMfaFormRequired(true, null), true);
  assert.equal(platformMfaFormRequired(false, null), false);
  assert.equal(platformMfaFormRequired(false, { code: 'platform_mfa_required' }), true);
  assert.equal(platformMfaFormRequired(false, { code: 'invalid_mfa_code' }), true);
  assert.equal(platformMfaFormRequired(false, { code: 'platform_admin_required' }), false);
});

test('IAM availability overrides runtime MFA hints', () => {
  assert.equal(mfaStatusAvailable(null), true);
  assert.equal(mfaStatusAvailable({ enabled: false }), true);
  assert.equal(mfaStatusAvailable({ available: true, enabled: false }), true);
  assert.equal(mfaStatusAvailable({ available: false, enabled: false }), false);
  assert.equal(mfaStatusAvailable({ available: false, enabled: true }), false);
});
