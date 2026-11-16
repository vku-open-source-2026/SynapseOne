// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/* Copyright 2026 SynapseOne Contributors. Licensed under Apache-2.0. */
import type { Principal, StoredWorkflow } from './store';

/** Explicit protection for workflows invoked through a capability service.
 * Ownership comes from the gateway principal stored at creation, never JSON.
 * Missing access settings preserve the existing tenant-shared contract. */
export function workflowVisibleTo(w: StoredWorkflow, p: Principal | null | undefined): boolean {
  const access = w.settings?.access;
  if (access !== undefined) {
    if (!access || typeof access !== 'object' || Array.isArray(access)) return false;
    if (access.mode !== 'tenant' && access.mode !== 'owner-only') return false;
    if (access.mode === 'owner-only' && (!p || !w.owner_sub || p.sub !== w.owner_sub)) return false;
  }
  if (!p) return true; // legacy direct dev/test calls only
  if (w.org_id && p.org) return w.org_id === p.org;
  return !!p.account && w.account_id === p.account;
}

/** Validate policy before storing it. Only a workflow's actual owner can
 * change its access policy; sharing a tenant does not prove ownership. */
export function validateWorkflowAccess(
  settings: Record<string, any>,
  p: Principal | null | undefined,
  current?: StoredWorkflow,
): string | null {
  const access = settings?.access;
  if (access !== undefined) {
    if (!access || typeof access !== 'object' || Array.isArray(access)
      || !['tenant', 'owner-only'].includes(access.mode)
      || Object.keys(access).some((key) => key !== 'mode')) {
      return 'settings.access must contain only mode: tenant|owner-only';
    }
    if (access.mode === 'owner-only' && (!p || !p.sub)) {
      return 'owner-only workflows require an authenticated owner';
    }
  }
  const previous = current?.settings?.access?.mode ?? 'tenant';
  const next = access?.mode ?? 'tenant';
  if (current && previous !== next && (!p || !current.owner_sub || p.sub !== current.owner_sub)) {
    return 'only the workflow owner may change settings.access';
  }
  return null;
}
