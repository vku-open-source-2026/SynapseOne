// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingPath } from './auth-routing.js';

const tenant = { type: 'tenant', id: 'tenant:1' };
const platform = { type: 'platform', id: 'platform:1' };

test('platform context lands in the platform console', () => {
  assert.equal(landingPath(platform), '/admin/overview');
});

test('server-preferred platform context wins over a tenant sign-in row', () => {
  assert.equal(landingPath(tenant, undefined, platform), '/admin/overview');
});

test('tenant-only users still land on the tenant dashboard', () => {
  assert.equal(landingPath(tenant), '/dashboard');
  assert.equal(landingPath(null), '/dashboard');
});

test('deep links survive only for the matching area', () => {
  assert.equal(landingPath(platform, '/admin/audit'), '/admin/audit');
  assert.equal(landingPath(platform, '/admin/overview?range=7d'), '/admin/overview?range=7d');
  assert.equal(landingPath(platform, '/dashboard'), '/admin/overview');
  assert.equal(landingPath(tenant, '/workflows?tab=1'), '/workflows?tab=1');
  assert.equal(landingPath(tenant, '/admin/overview'), '/dashboard');
});

test('protocol-relative and external deep links are rejected', () => {
  assert.equal(landingPath(platform, '//evil.example'), '/admin/overview');
  assert.equal(landingPath(tenant, '//evil.example'), '/dashboard');
  assert.equal(landingPath(platform, 'https://evil.example/admin'), '/admin/overview');
  assert.equal(landingPath(tenant, 'javascript:alert(1)'), '/dashboard');
  assert.equal(landingPath(tenant, '/\\evil.example'), '/dashboard');
});

test('auth pages never become a redirect loop', () => {
  assert.equal(landingPath(tenant, '/login'), '/dashboard');
  assert.equal(landingPath(platform, '/login?next=/admin/audit'), '/admin/overview');
  assert.equal(landingPath(tenant, '/register'), '/dashboard');
  assert.equal(landingPath(platform, '/oidc/callback'), '/admin/overview');
});

test('/administer is not inside /admin', () => {
  assert.equal(landingPath(platform, '/administer'), '/admin/overview');
  assert.equal(landingPath(tenant, '/administer'), '/administer');
});

test('path traversal is normalized before the admin check', () => {
  assert.equal(landingPath(platform, '/admin/../dashboard'), '/admin/overview');
  assert.equal(landingPath(platform, '/admin/../../login'), '/admin/overview');
  assert.equal(landingPath(tenant, '/admin/../workflows'), '/workflows');
});

test('preferred platform ignores a tenant deep link', () => {
  assert.equal(landingPath(tenant, '/dashboard', platform), '/admin/overview');
});
