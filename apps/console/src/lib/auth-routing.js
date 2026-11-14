// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const BASE = 'http://synapseone.local';
const AUTH_PATHS = new Set(['/login', '/register', '/oidc/callback']);

/** Return a normalized same-origin internal path, or null. Rejects
 *  protocol-relative (`//evil`), backslashes, control chars, external URLs and
 *  auth pages that would loop back to the login screen. */
function safeInternalPath(from) {
  if (typeof from !== 'string' || from.length === 0 || from.length > 2048) return null;
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(from)) return null;
  let url;
  try {
    url = new URL(from, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  if (AUTH_PATHS.has(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Admin area is exactly `/admin` or a `/admin/...` child, never
 *  `/administer` or another prefix. */
function isAdminPath(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

/** Choose the landing route from authoritative context metadata.
 *
 *  `preferred` comes from the server (`/v1/auth/contexts` or the login
 *  response). A dual-role Platform Administrator is routed to the platform
 *  console even when the sign-in row itself is a tenant identity; the platform
 *  guard then requires the actual platform-org login. A deep link survives only
 *  when it is a safe internal path for the effective context.
 */
export function landingPath(context, from, preferred) {
  const effective = preferred?.type === 'platform' ? preferred : context;
  const platform = effective?.type === 'platform';
  const target = safeInternalPath(from);
  if (target) {
    if (platform && isAdminPath(target)) return target;
    if (!platform && !isAdminPath(target)) return target;
  }
  return platform ? '/admin/overview' : '/dashboard';
}
