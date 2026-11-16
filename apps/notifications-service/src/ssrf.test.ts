// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWebhookUrlAllowed, isBlockedHost, isBlockedUrl } from './ssrf';

test('webhook SSRF guard blocks private, loopback and metadata targets', () => {
  for (const url of [
    'http://localhost:4001/v1/orgs',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://iam:4001/v1/keys/verify',
    'http://notifications:4011/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'ftp://example.com/',
  ]) {
    assert.equal(isBlockedUrl(url), true, `expected blocked: ${url}`);
  }
  assert.equal(isBlockedUrl('https://hooks.example.com/abc'), false);
  assert.equal(isBlockedHost('gateway'), true);
});

test('webhook SSRF guard resolves DNS and blocks rebinding to internal IPs', async () => {
  await assert.rejects(
    assertWebhookUrlAllowed('https://rebind.example/', async () => ['93.184.216.34', '169.254.169.254']),
    /blocked internal webhook URL/,
  );
  await assert.doesNotReject(
    assertWebhookUrlAllowed('https://hooks.example.com/', async () => ['93.184.216.34']),
  );
});
