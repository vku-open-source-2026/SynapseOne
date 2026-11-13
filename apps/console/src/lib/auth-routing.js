// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Choose the landing route from authoritative context metadata. Platform
 *  administration wins by default; a deep link survives only when the current
 *  context is allowed to open it. */
export function landingPath(context, from) {
  const platform = context?.type === 'platform';
  if (typeof from === 'string' && from.startsWith('/')) {
    if (platform && from.startsWith('/admin')) return from;
    if (!platform && !from.startsWith('/admin')) return from;
  }
  return platform ? '/admin/overview' : '/dashboard';
}
