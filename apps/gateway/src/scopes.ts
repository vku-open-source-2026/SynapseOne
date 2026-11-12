// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Per-route scope enforcement (issue #23).
 *
 * Scope grammar:
 *   `*`              full authority (org-member JWT default)
 *   `<service>:*`    every action in one service
 *   `*:read`         read every service
 *   `*:write`        write every service
 *   `<service>:<action>` exact HTTP action (`get`, `list`, `publish`, ...)
 *
 * The gateway authenticates, then requires the principal's scopes to cover the
 * route. User JWTs carry `*` (org membership), while API keys and delegated
 * tokens are narrow by construction — so a leaked read-only key cannot write.
 */

const SERVICE_BY_PREFIX: Array<[string, string]> = [
  ['/v1/orgs', 'iam'],
  ['/v1/accounts', 'iam'],
  ['/v1/roles', 'iam'],
  ['/v1/users', 'iam'],
  ['/v1/service-accounts', 'iam'],
  ['/v1/policies', 'iam'],
  ['/v1/keys', 'iam'],
  ['/v1/authorize', 'iam'],
  ['/v1/audit', 'iam'],
  ['/v1/usage', 'iam'],
  ['/v1/workflows', 'workflow'],
  ['/v1/workflow-runners', 'workflow'],
  ['/v1/runner', 'workflow'],
  ['/v1/templates', 'workflow'],
  ['/v1/executions', 'workflow'],
  ['/v1/credentials', 'workflow'],
  ['/webhook', 'workflow'],
  ['/v1/ai', 'ai'],
  ['/v1/inference', 'inference'],
  ['/v1/lds', 'lds'],
  ['/v1/base', 'base'],
  ['/v1/faststore', 'faststore'],
  ['/v1/queue', 'queue'],
  ['/v1/stream', 'stream'],
];

const READ_ACTIONS = new Set(['get', 'head', 'list', 'read', 'query', 'peek', 'stats', 'consume', 'search', 'health']);
const WRITE_ACTIONS = new Set([
  'write', 'create', 'update', 'delete', 'put', 'post', 'patch', 'publish', 'ack', 'nack',
  'heartbeat', 'execute', 'send', 'rotate', 'attach', 'detach', 'assign', 'unassign',
  'activate', 'deactivate', 'ingest', 'batch', 'incr', 'set', 'del', 'admin',
]);

export interface ScopeRequirement {
  service: string;
  action: string;
  read: boolean;
}

/** Resolve the service + action a request needs. Null for unenforced paths. */
export function scopeRequirement(pathname: string, method: string): ScopeRequirement | null {
  const p = String(pathname || '/');
  if (p === '/' || p === '/health' || p === '/ready' || p === '/metrics') return null;
  if (p === '/v1/auth' || p.startsWith('/v1/auth/')) return null;
  let service: string | null = null;
  for (const [prefix, name] of SERVICE_BY_PREFIX) {
    if (p === prefix || p.startsWith(prefix + '/')) { service = name; break; }
  }
  if (!service) return null; // unmatched routes are 404'd later
  const m = String(method || 'GET').toUpperCase();
  const read = m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  return { service, action: read ? 'read' : 'write', read };
}

/** Accept either the generic read/write scope or a concrete action verb. */
export function scopeAllows(scopes: string[], pathname: string, method: string): boolean {
  const req = scopeRequirement(pathname, method);
  if (!req) return true;
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes('*')) return true;
  const m = String(method || 'GET').toUpperCase();
  const concrete = m.toLowerCase();
  const alternatives = new Set<string>([
    `${req.service}:${req.action}`,
    `${req.service}:${concrete}`,
    `${req.service}:*`,
    `*:${req.action}`,
    ...(req.read ? [] : ['*:write']),
  ]);
  // Legacy verb-style scopes (`faststore:get`) only cover their own verb.
  if (READ_ACTIONS.has(concrete)) alternatives.add(`${req.service}:read`);
  if (WRITE_ACTIONS.has(concrete)) alternatives.add(`${req.service}:write`);
  // Resource-action scopes: `/v1/workflows/:id/execute` → `workflow:execute`,
  // `/v1/queue/.../ack` → `queue:ack`.
  const last = String(pathname || '').split('/').filter(Boolean).pop() || '';
  if (/^[a-z][a-z0-9-]{0,32}$/.test(last)) alternatives.add(`${req.service}:${last}`);
  return list.some((s) => alternatives.has(s));
}
