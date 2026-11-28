// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export const TENANT_KEY_SCOPE_GROUP_LABELS = {
  '*': 'All tenant services',
  iam: 'Identity & access',
  base: 'SynapseBase',
  search: 'SynapseSearch',
  lds: 'SynapseLDS',
  faststore: 'SynapseFaststore',
  queue: 'SynapseQueue',
  stream: 'SynapseStream',
  storage: 'Storage',
  dns: 'SynapseDNS',
  tunnel: 'Synapse Tunnel',
  ocs: 'SynapseOCS',
  warehouse: 'SynapseWarehouse',
  lakehouse: 'SynapseLakehouse',
  workflow: 'Workflow',
  inference: 'Inference',
  ai: 'AI',
  secrets: 'Secrets',
  notifications: 'Notifications',
};

export function normalizeTenantKeyScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  const seen = new Set();
  const result = [];
  for (const value of scopes) {
    if (typeof value !== 'string') continue;
    const scope = value.trim();
    if (!scope || scope.toLowerCase().startsWith('platform:') || seen.has(scope)) continue;
    seen.add(scope);
    result.push(scope);
  }
  return result;
}

export function groupTenantKeyScopes(scopes) {
  const groups = new Map();
  for (const scope of normalizeTenantKeyScopes(scopes)) {
    const prefix = scope === '*' || scope.startsWith('*:') ? '*' : scope.split(':')[0];
    if (!groups.has(prefix)) {
      groups.set(prefix, {
        prefix,
        label: TENANT_KEY_SCOPE_GROUP_LABELS[prefix] || prefix,
        scopes: [],
      });
    }
    groups.get(prefix).scopes.push(scope);
  }
  return [...groups.values()];
}

export function toggleTenantKeyScope(selected, scope, options) {
  const available = normalizeTenantKeyScopes(options);
  const target = typeof scope === 'string' ? scope.trim() : '';
  if (!available.includes(target)) return available.filter((item) => selected.includes(item));
  const next = new Set(selected);
  if (next.has(target)) next.delete(target);
  else next.add(target);
  return available.filter((item) => next.has(item));
}

export function selectAllTenantKeyScopes(options) {
  return normalizeTenantKeyScopes(options);
}

export function tenantKeyScopeDescription(scope) {
  if (scope === '*') return 'Full tenant access; platform administration is excluded';
  if (scope === '*:read') return 'Read access across tenant services';
  if (scope === '*:write') return 'Read and write access across tenant services';
  if (scope === 'workflow:Execute') return 'Execute workflows';
  if (scope === 'inference:Invoke') return 'Invoke inference';
  if (scope === 'ai:Invoke') return 'Invoke AI';
  const action = scope.split(':')[1];
  if (action === 'read') return 'Read-only access';
  if (action === 'write') return 'Read and write access';
  if (action === '*') return 'Full service access';
  return 'Tenant service permission';
}
