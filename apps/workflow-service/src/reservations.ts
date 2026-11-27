// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Global active workflow trigger reservations and conflict checks.
 */
import { isMcpTriggerType, isWebhookType } from './engine';

export interface ReservationWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: any[];
  org_id?: string | null;
  account_id?: string | null;
}

export interface WorkflowReservation {
  kind: 'webhook' | 'mcp';
  key: string;
  value: string;
  public: boolean;
  tenantScope: string;
}

export class WorkflowReservationConflict extends Error {
  readonly status = 409;
  constructor(readonly code: 'webhook_path_conflict' | 'mcp_tool_conflict', message: string) {
    super(message);
    this.name = 'WorkflowReservationConflict';
  }
}

function tenantScope(workflow: ReservationWorkflow): string {
  if (workflow.org_id) return `org:${workflow.org_id}`;
  if (workflow.account_id) return `account:${workflow.account_id}`;
  return 'global';
}

/** Reserve every routable webhook path and the first exposed MCP tool. This
 *  mirrors the public lookup behavior in index.ts while remaining pure so the
 *  same check runs inside the persistence transaction. */
export function reservationsForWorkflow(workflow: ReservationWorkflow): WorkflowReservation[] {
  if (!workflow.active) return [];
  const out: WorkflowReservation[] = [];
  const scope = tenantScope(workflow);
  for (const node of workflow.nodes || []) {
    if (!isWebhookType((node as any)?.type)) continue;
    const path = String((node as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
    if (!path || path.length > 128 || !/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split('/').includes('..')) continue;
    out.push({ kind: 'webhook', key: `webhook:${path}`, value: path, public: true, tenantScope: 'global' });
  }
  for (const node of workflow.nodes || []) {
    if (!isMcpTriggerType((node as any)?.type)) continue;
    const toolName = String((node as any)?.parameters?.toolName || (node as any)?.name || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(toolName)) continue;
    const isPublic = (node as any)?.parameters?.public === true && (node as any)?.parameters?.readOnly !== false;
    out.push({
      kind: 'mcp',
      key: isPublic ? `mcp:public:${toolName}` : `mcp:tenant:${scope}:${toolName}`,
      value: toolName,
      public: isPublic,
      tenantScope: isPublic ? 'global' : scope,
    });
    break;
  }
  return out;
}

/** Check global webhook paths and public MCP names, plus the existing
 *  same-tenant private MCP-name rule. Public/private collisions conflict in
 *  either direction because anonymous lookup would otherwise be ambiguous. */
export function assertNoWorkflowReservationConflicts(
  candidate: ReservationWorkflow,
  activeWorkflows: ReservationWorkflow[],
): void {
  const wanted = reservationsForWorkflow(candidate);
  if (!wanted.length) return;
  for (const reservation of wanted) {
    for (const other of activeWorkflows) {
      if (!other.active || other.id === candidate.id) continue;
      for (const held of reservationsForWorkflow(other)) {
        if (reservation.kind !== held.kind || reservation.value !== held.value) continue;
        const conflicts = reservation.kind === 'webhook'
          || reservation.public
          || held.public
          || reservation.tenantScope === held.tenantScope;
        if (!conflicts) continue;
        if (reservation.kind === 'webhook') {
          throw new WorkflowReservationConflict(
            'webhook_path_conflict',
            `webhook path '${reservation.value}' already serves active workflow '${other.name}' (${other.id}) — change the path or deactivate it first`,
          );
        }
        throw new WorkflowReservationConflict(
          'mcp_tool_conflict',
          `MCP tool '${reservation.value}' already serves active workflow '${other.name}' (${other.id}) — change the tool name or deactivate it first`,
        );
      }
    }
  }
}
