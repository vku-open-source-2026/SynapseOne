// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * PostgreSQL-only OIDC state binding/consumption test. Run against a disposable
 * database with IAM_TEST_DATABASE_URL=1 and DATABASE_URL set.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ensureTables } from './db';
import { consumeOidcLoginState, hashOidcBrowserToken, storeOidcLoginState } from './oidc-state';

const enabled = process.env.IAM_TEST_DATABASE_URL === '1' && !!process.env.DATABASE_URL;

describe('OIDC login-state persistence on PostgreSQL', { skip: !enabled }, () => {
  before(async () => {
    await ensureTables();
  });

  it('binds consumption to the browser and allows exactly one concurrent consumer', async () => {
    const id = randomUUID();
    const browserToken = randomBytes(32).toString('base64url');
    await storeOidcLoginState({
      id,
      orgSlug: 'oidc-pg-test',
      nonce: randomBytes(16).toString('hex'),
      verifierEnc: 'encrypted-test-verifier',
      browserHash: hashOidcBrowserToken(browserToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await consumeOidcLoginState(id, randomBytes(32).toString('base64url')), null);
    const results = await Promise.all([
      consumeOidcLoginState(id, browserToken),
      consumeOidcLoginState(id, browserToken),
    ]);
    assert.equal(results.filter((result) => result !== null).length, 1);
    assert.equal(await consumeOidcLoginState(id, browserToken), null);
  });

  it('refuses expired server-side state', async () => {
    const id = randomUUID();
    const browserToken = randomBytes(32).toString('base64url');
    await storeOidcLoginState({
      id,
      orgSlug: 'oidc-pg-test',
      nonce: randomBytes(16).toString('hex'),
      verifierEnc: 'encrypted-test-verifier',
      browserHash: hashOidcBrowserToken(browserToken),
      expiresAt: new Date(Date.now() - 1_000),
    });
    assert.equal(await consumeOidcLoginState(id, browserToken), null);
  });
});
