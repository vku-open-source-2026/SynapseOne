// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTenantKeyScopes,
  normalizeTenantKeyScopes,
  selectAllTenantKeyScopes,
  tenantKeyScopeDescription,
  toggleTenantKeyScope,
} from './api-key-scopes.js';

test('tenant key scope normalization removes platform permissions and duplicates', () => {
  assert.deepEqual(
    normalizeTenantKeyScopes(['base:read', ' platform:Admin ', 'base:read', '', 'workflow:Execute', null]),
    ['base:read', 'workflow:Execute'],
  );
});

test('tenant key scopes are grouped in catalog order with friendly labels', () => {
  const groups = groupTenantKeyScopes(['*', 'base:read', 'base:write', 'workflow:Execute', 'platform:Admin']);
  assert.deepEqual(groups.map((group) => [group.prefix, group.label, group.scopes]), [
    ['*', 'All tenant services', ['*']],
    ['base', 'SynapseBase', ['base:read', 'base:write']],
    ['workflow', 'Workflow', ['workflow:Execute']],
  ]);
});

test('scope toggles preserve server catalog order and reject unavailable options', () => {
  const options = ['base:read', 'base:write', 'workflow:Execute'];
  assert.deepEqual(toggleTenantKeyScope(['workflow:Execute'], 'base:read', options), ['base:read', 'workflow:Execute']);
  assert.deepEqual(toggleTenantKeyScope(['base:read', 'workflow:Execute'], 'base:read', options), ['workflow:Execute']);
  assert.deepEqual(toggleTenantKeyScope(['base:read'], 'platform:Admin', options), ['base:read']);
});

test('Select all returns every tenant option and never platform scope', () => {
  const options = ['*', 'base:read', 'workflow:Execute', 'platform:Admin'];
  assert.deepEqual(selectAllTenantKeyScopes(options), ['*', 'base:read', 'workflow:Execute']);
});

test('special tenant actions have distinct management copy', () => {
  assert.equal(tenantKeyScopeDescription('*'), 'Full tenant access; platform administration is excluded');
  assert.equal(tenantKeyScopeDescription('workflow:Execute'), 'Execute workflows');
  assert.equal(tenantKeyScopeDescription('inference:Invoke'), 'Invoke inference');
  assert.equal(tenantKeyScopeDescription('base:write'), 'Read and write access');
});
