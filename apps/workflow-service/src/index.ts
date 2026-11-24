// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow service: local built-in engine (Apache-2.0, no external engine).
 * Stores workflows + executions in Postgres (DATABASE_URL) with in-memory
 * fallback for dev/test. Triggers publish SynapseQueue jobs; the built-in
 * worker or a self-hosted runner executes webhook/cron/manual/httpRequest/
 * code/set/if/noOp DAGs via ./engine (sandboxed code).
 */
import './env-compat';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual, randomUUID } from 'crypto';
import { auditMiddleware, auditRequest } from './audit';
import { AsyncLocalStorage } from 'async_hooks';
import { workflowVisibleTo, validateWorkflowAccess } from './access';
import {
  createWorkflowRec, getWorkflowRec, listWorkflowRecs, updateWorkflowRec, deleteWorkflowRec,
  createExecutionRec, getExecutionRec, listExecutionRecs, findActiveWebhookWorkflow,
  listActiveCronWorkflows, ensureTables, useDb, StoredWorkflow, StoredCredential,
  claimWebhookDelivery, releaseWebhookDelivery, hitWebhookRate, claimCronSlot,
  createCredentialRec, getCredentialRec, listCredentialRecs, deleteCredentialRec, rotateCredentialRec,
  toPublicCredential, decryptSecret,
  createHumanTaskRec, getHumanTaskRec, listHumanTaskRecs, transitionHumanTaskRec, toPublicHumanTask,
  claimExecutionResume, finishExecutionRec,
  claimExecutionRec, heartbeatExecutionRec, releaseExecutionRec, pauseExecutionRec,
  queueExecutionResume, restoreExecutionPaused, savePausedExecutionRec, cancelExecutionRec,
  listExpiredRunningExecutions, reclaimExpiredExecution, listOverdueHumanTasks, listStaleResumingHumanTasks,
  countActiveExecutionsForTenant, activeExecutionCountsByTenant, pingDb,
  createRunnerRec, getRunnerRec, listRunnerRecs, heartbeatRunnerRec, deleteRunnerRec, countActiveExecutionsForRunner,
  upsertRunnerInstance, listRunnerInstances, listRunnerInstancesForRunners, deleteRunnerInstance,
  markRunnerInstancesOffline, updateRunnerRec,
  recordRunnerResourceUsage, listRunnerUsageHourly, listRunnerUsageRequests,
  createInferenceJobRec, getInferenceJobRec, listInferenceJobRecs, claimInferenceJobRec,
  heartbeatInferenceJobRec, finishInferenceJobRec, releaseInferenceJobRec, setInferenceJobError,
  createSecretRec, listSecretRecs, findSecretRec, readSecretValue, rotateSecretRec,
  listSecretVersionRecs, revokeSecretRec, deleteSecretRec, toPublicSecret, toPublicSecretVersion,
} from './store';
import type { Principal, StoredExecution, StoredWorkflowRunner, StoredRunnerInstance, StoredInferenceJob } from './store';
import {
  queueTransportEnabled, queueBackendConfigured, runnerModeForSettings, queueNameForSettings,
  queuePrincipalForMode, queuePrincipalForInferenceQueue,
  ensureWorkflowQueue, publishWorkflowRun, publishInferenceJob, isQueueName, queueVisibilitySeconds, queueMaxAttempts,
  pingWorkflowQueue, DEFAULT_INFERENCE_QUEUE,
  DEFAULT_CUSTOM_QUEUE, DEFAULT_SHARED_QUEUE, DEFAULT_SYSTEM_QUEUE, DEFAULT_SYSTEM_INFERENCE_QUEUE,
} from './queue';
import type { WorkflowRunnerMode } from './queue';
import {
  defaultDockerResources, dockerResourceConcurrency, dockerResourceFlags, dockerResourceOptions,
  effectiveDockerResources, normalizeDockerResources,
} from './resource-command';
import type { DockerResources } from './resource-command';
import { startPlatformWorker, platformWorkerId } from './worker';
import { aggregateRunnerUsage, usageBucketStart } from './runner-usage';
import type { RunnerUsageInterval } from './runner-usage';
import { runWorkflow, HumanTaskPause, detectCycle, workflowCronIntervalMs, workflowCronNextRunAt, validateCronParams, validateSynapseOneParams, validateIntegrationParams, validateAgentToolIds, extractEmbeddingVector, isBlockedUrl as engineIsBlockedUrl, isAllowedSelfUrl, selfAllowlist, actorFor, isWebhookType, isCronType, isTriggerType, isCodeType, isHttpRequestType, isIfType, isSetType, isNoOpType, isAiAgentType, isDecisionType, isModelType, isIntegrationType, isMcpTriggerType, normalizeNodeType, edgeTargetPort, auxiliaryEdges, HTTP_CREDENTIAL_DESTINATION_PROTECTION, referencedCredentialIds, executionDataPlaneScopes, isStructurallyReadOnlyDefinition } from './engine';
import type { CredentialResolver, RunPrincipal, SynapseOneCall, EngineNode, Connections } from './engine';

/** May this credential be resolved for this run principal? (P0-4/#5)
 *  - org-bound credentials: only inside their org, or by their owning account;
 *  - legacy unbound credentials (no org): only the owning account — org
 *    principals cannot reach secrets of unknown tenancy. */
export function credentialVisibleTo(rec: StoredCredential, p: Principal | null | undefined): boolean {
  if (rec.owner_sub && (!p || p.sub !== rec.owner_sub)) return false;
  if (!p) return true; // anonymous direct calls (dev/tests)
  const acctOk = !!p.account && rec.account_id === p.account;
  const orgOk = !!p.org && !!rec.org_id && rec.org_id === p.org;
  if (rec.org_id) return orgOk || acctOk;
  return acctOk;
}

/** Server-side credential resolver for node auth (P0-4): nodes reference
 *  credentialIds; secrets are decrypted only here, at run time, and only for
 *  the principal the run belongs to. */
export function makeCredentialResolver(p: Principal | null | undefined): CredentialResolver {
  return async (credentialId: string) => {
    if (!credentialId || typeof credentialId !== 'string' || credentialId.length > 128 || /[\r\n]/.test(credentialId)) return null;
    const rec = await getCredentialRec(credentialId);
    if (!rec || !credentialVisibleTo(rec, p)) return null;
    try {
      return { kind: rec.kind, secret: decryptSecret(rec.secret_enc) };
    } catch {
      return null;
    }
  };
}

/** Tenant read guard (P0-3): tenant-bound rows are invisible outside their
 *  tenant. Org-bound rows belong to the org; account-only rows to the
 *  account. Legacy global rows (no tenant at all) are dev/anonymous-only —
 *  authenticated callers never see pre-tenancy leftovers. Returns false →
 *  caller gets 404 (existence not leaked). */
function canAccessWorkflow(w: StoredWorkflow, p: Principal | null | undefined): boolean {
  return workflowVisibleTo(w, p);
}

/** Tenant filter for execution lists (P0-3/#6): match the principal snapshot
 *  stored at run time. Null = the caller has no tenant scope; callers must
 *  fail closed on it (anonymous direct calls return {} = unfiltered only for
 *  the dev/test fallback). */
function executionScope(p: Principal | null | undefined): { orgId?: string; accountId?: string } | null {
  if (!p) return {};
  if (p.org) return { orgId: p.org };
  if (p.account) return { accountId: p.account };
  return null;
}

/** Human-task tenant guard (#44). */
async function canAccessHumanTask(
  t: { org_id?: string | null; account_id?: string | null; workflow_id?: string | null },
  p: Principal | null | undefined,
): Promise<boolean> {
  if (p && !((p.account && t.account_id === p.account) || (p.org && t.org_id === p.org))) return false;
  if (!t.workflow_id) return true;
  const workflow = await getWorkflowRec(t.workflow_id);
  return !!workflow && canAccessWorkflow(workflow, p);
}

function humanTaskScope(p: Principal | null | undefined): { orgId?: string; accountId?: string } | null {
  if (!p) return {};
  if (p.org) return { orgId: p.org };
  if (p.account) return { accountId: p.account };
  return null;
}

/** May this principal act on the task? An explicit assignee/claim wins;
 *  otherwise the caller must hold one of the task's candidateRoles (stamped
 *  from the verified IAM session). Unassigned, role-less tasks are denied —
 *  they are not "open to every tenant member". */
function canActOnHumanTask(
  t: { assignee?: string | null; claimed_by?: string | null; candidate_roles?: string[] },
  p: Principal | null | undefined,
): boolean {
  if (!p) return false;
  if (t.assignee) return t.assignee === p.sub || t.claimed_by === p.sub;
  if (t.claimed_by && t.claimed_by !== p.sub) return false;
  if (t.claimed_by === p.sub) return true;
  const candidates = Array.isArray(t.candidate_roles) ? t.candidate_roles.filter(Boolean) : [];
  if (!candidates.length) return false;
  const held = new Set((p.roles || []).map((r) => String(r).toLowerCase()));
  return candidates.some((role) => held.has(String(role).toLowerCase()));
}

/** May this execution record be read by this principal? Same tenant rules as
 *  canAccessWorkflow, applied to the run-time principal snapshot. */
function canAccessExecution(e: { principal?: Principal | null }, p: Principal | null | undefined): boolean {
  if (!p) return true;
  if (p.account && e.principal?.account === p.account) return true;
  if (p.org && e.principal?.org === p.org) return true;
  return false;
}

/** Runner claim boundary. Account runners are the default and may only claim
 *  work whose principal is bound to the same account. Org runners are an
 *  explicit admin grant and may claim only their own organization's work. */
function runnerAudienceAllows(
  runner: { scope?: string | null; audience?: string | null; org_id?: string | null; account_id?: string | null },
  execution: { principal?: Principal | null } | null | undefined,
): boolean {
  if (runner.scope === 'platform') return true;
  const owner = execution?.principal;
  if (runner.audience === 'org') {
    return !!runner.org_id && !!owner?.org && owner.org === runner.org_id;
  }
  return !!runner.account_id && !!owner?.account && owner.account === runner.account_id;
}

/** Cancellation is stricter than read access: a tenant member may not cancel
 * another user's run merely because both share an organization. Account-level
 * machine credentials may cancel their account's runs; org admins may cancel
 * within their org. */
function canCancelExecution(e: StoredExecution, p: Principal | null | undefined): boolean {
  if (!p) return false;
  if (p.isOrgAdmin === true && p.org && e.principal?.org === p.org) return true;
  if (p.account && e.principal?.account === p.account) return true;
  return !!p.sub && e.principal?.sub === p.sub;
}

/** API viewers must also satisfy the workflow policy. Runner claims retain
 * their separately authenticated tenant/queue checks below. */
async function canReadExecution(e: StoredExecution, p: Principal | null | undefined): Promise<boolean> {
  if (!canAccessExecution(e, p)) return false;
  const workflow = await getWorkflowRec(e.workflow_id);
  // A deleted workflow cannot grant a new viewer access to its old payloads.
  if (!workflow) return !p || e.principal?.sub === p.sub;
  return canAccessWorkflow(workflow, p);
}

/** Nested workflow executions (agent `workflow_run` / SynapseFlow node).
 *  AsyncLocalStorage keeps the depth per async chain, so concurrent runs
 *  cannot corrupt each other's counters. */
const workflowRunContext = new AsyncLocalStorage<{ depth: number }>();
const MAX_WORKFLOW_NESTING = 3;

/** First-party SynapseOne caller for synapseone.api nodes: IAM resources go to
 *  IAM over the service network with the run principal stamped (IAM enforces
 *  its own canActFor tenant checks on it); workflow-local resources are read
 *  straight from the store, scoped by canAccessWorkflow. No arbitrary paths —
 *  only the engine's SYNAPSEONE_API_RESOURCES table can reach here. */
export const synapseoneCall: SynapseOneCall = async (resource, operation, args, principal) => {
  const cleanId = (v: unknown, field: string, max = 256): string => {
    const s = String(v ?? '');
    if (!s || s.length > max || /[\r\n]/.test(s)) throw new Error(`synapseone.api: '${resource}.${operation}' needs a valid '${field}'`);
    return s;
  };
  const a = args && typeof args === 'object' ? args : {};
  // Workflow-local resources (no HTTP hop, tenant-scoped by principal).
  if (resource === 'workflows') {
    if (operation === 'list') {
      const all = await listWorkflowRecs();
      return all.filter((w) => canAccessWorkflow(w, principal)).map(toApiWorkflow);
    }
    const w = await getWorkflowRec(cleanId(a.id, 'id', 128));
    if (!w || !canAccessWorkflow(w, principal)) throw new Error(`synapseone.api: workflows.${operation} -> 404 (not found)`);
    if (operation === 'get') return toApiWorkflow(w);
    if (operation === 'execute') {
      const depth = workflowRunContext.getStore()?.depth || 0;
      if (depth >= MAX_WORKFLOW_NESTING) {
        throw new Error(`synapseone.api: workflows.execute nesting limit (${MAX_WORKFLOW_NESTING}) reached`);
      }
      const input = a.input && typeof a.input === 'object' && !Array.isArray(a.input) ? a.input : {};
      if (JSON.stringify(input).length > 200 * 1024) throw new Error('synapseone.api: workflows.execute input exceeds 200KB');
      const runPrincipal = principal || workflowRunPrincipal(w);
      const startedAt = new Date().toISOString();
      const r = await workflowRunContext.run({ depth: depth + 1 }, () =>
        runWorkflow(
          { nodes: w.nodes as any, connections: w.connections as any, name: w.name, settings: w.settings as any },
          input,
          {
            triggeredBy: 'workflow',
            principal: runPrincipal,
            credentialResolver: makeCredentialResolver(runPrincipal),
            synapseoneCall,
          },
        ),
      );
      const finishedAt = new Date().toISOString();
      const exec = await createExecutionRec({
        workflow_id: w.id,
        workflow_name: w.name,
        status: r.status,
        input,
        output: r.output,
        node_runs: r.nodeRuns as any,
        error: (r as any).error ?? null,
        triggered_by: 'workflow',
        principal: runPrincipal,
        actor: actorFor(w.id, runPrincipal),
        startedAt,
        finishedAt,
        workflow_revision: w.revision,
        ...pauseBinding(r),
      });
      if (r.status !== 'success') {
        throw new Error(`synapseone.api: workflows.execute '${w.name}' failed: ${String((r as any).error || 'unknown error').slice(0, 300)}`);
      }
      return { ok: true, executionId: exec.id, workflow: { id: w.id, name: w.name }, output: r.output };
    }
    throw new Error(`synapseone.api: unsupported call 'workflows.${operation}'`);
  }
  if (resource === 'executions') {
    if (operation === 'list') {
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
      const offset = Math.max(Number(a.offset) || 0, 0);
      const status = typeof a.status === 'string' && ['success', 'error', 'running'].includes(a.status) ? a.status : undefined;
      const workflowId = typeof a.workflowId === 'string' && a.workflowId ? cleanId(a.workflowId, 'workflowId', 128) : undefined;
      const scope = executionScope(principal);
      if (!scope) return { data: [] };
      const { items } = await listExecutionRecs({ workflowId, status, limit, offset, ...scope });
      const visibility = await Promise.all(items.map((e) => canReadExecution(e, principal)));
      return { data: items.filter((_e, i) => visibility[i]).map((e) => toApiExecution(e, false)) };
    }
    const e = await getExecutionRec(cleanId(a.id, 'id', 128));
    if (!e || !await canReadExecution(e, principal)) throw new Error('synapseone.api: executions.get -> 404 (not found)');
    return toApiExecution(e, true);
  }
  if (resource === 'templates') {
    if (operation === 'list') return listTemplates();
    const t = buildTemplate(cleanId(a.name, 'name', 64), cleanId(a.name, 'name', 64));
    if (!t) throw new Error('synapseone.api: templates.get -> 404 (template_not_found)');
    return t;
  }
  // SynapseLDS (linked data) over the service network as the run principal.
  // Records published here go through the same structural-allowlist projector
  // as everything else: reserved/system fields are quarantined, unregistered
  // dynamic fields default-deny out of every NGSI-LD export.
  if (resource === 'lds') {
    const LDS_BASE = (process.env.LDS_SERVICE_URL || 'http://lds:4004').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list-datasources') {
        path = '/v1/lds/datasources';
      } else if (operation === 'publish-record') {
        method = 'POST';
        path = `/v1/lds/datasources/${encodeURIComponent(cleanId(a.datasourceId, 'datasourceId', 128))}/records`;
        const record = a.record !== undefined ? a.record : a.data;
        if (record === undefined || record === null) {
          throw new Error("synapseone.api: lds.publish-record needs 'record' (an object — put it in input, e.g. ={{ $json }})");
        }
        if (typeof record !== 'object' || Array.isArray(record)) {
          throw new Error("synapseone.api: lds.publish-record 'record' must be a JSON object");
        }
        body = { record };
      } else if (operation === 'get-entity') {
        method = 'GET';
        path = `/v1/lds/datasources/${encodeURIComponent(cleanId(a.datasourceId, 'datasourceId', 128))}/entities/${encodeURIComponent(cleanId(a.entityId, 'entityId', 256))}`;
      } else {
        throw new Error(`synapseone.api: unsupported call 'lds.${operation}'`);
      }
      const r = await fetch(`${LDS_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapseone.api: SynapseLDS timed out after 20000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Synapse Warehouse (OLAP + ETL)
  if (resource === 'warehouse') {
    const WAREHOUSE_BASE = (process.env.WAREHOUSE_SERVICE_URL || 'http://warehouse:4012').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 30000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list-datasets') {
        path = '/v1/warehouse/datasets';
      } else if (operation === 'list-jobs') {
        path = '/v1/warehouse/jobs';
      } else if (operation === 'create-dataset') {
        method = 'POST';
        path = '/v1/warehouse/datasets';
        body = {
          id: a.id,
          name: a.name,
          description: a.description,
          columns: a.columns,
          mode: a.mode,
          streamTopic: a.streamTopic,
        };
      } else if (operation === 'ingest') {
        method = 'POST';
        path = `/v1/warehouse/datasets/${encodeURIComponent(cleanId(a.datasetId, 'datasetId', 64))}/rows`;
        if (!Array.isArray(a.rows) || !a.rows.length) {
          // An empty micro-batch is a normal result; keep the flow moving so
          // the following stream.ack can complete with zero ids.
          return { ok: true, inserted: 0 };
        }
        body = { rows: a.rows };
      } else if (operation === 'query') {
        method = 'POST';
        path = '/v1/warehouse/query';
        body = { sql: a.sql, limit: a.limit };
      } else if (operation === 'run-batch') {
        method = 'POST';
        path = '/v1/warehouse/etl/batch';
        body = {
          targetDatasetId: a.targetDatasetId,
          sql: a.sql,
          writeMode: a.writeMode,
          name: a.name,
        };
      } else if (operation === 'ensure-stream') {
        method = 'POST';
        path = '/v1/warehouse/etl/stream';
        body = {
          targetDatasetId: a.targetDatasetId,
          streamTopic: a.streamTopic,
          streamGroup: a.streamGroup,
          name: a.name,
          batchSize: a.batchSize,
          intervalMs: a.intervalMs,
        };
      } else {
        throw new Error(`synapseone.api: unsupported call 'warehouse.${operation}'`);
      }
      const r = await fetch(`${WAREHOUSE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: warehouse.${operation} -> ${r.status}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapseone.api: Synapse Warehouse timed out after 30000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // SynapseStream (micro-batch ETL templates)
  if (resource === 'stream') {
    const STREAM_BASE = (process.env.STREAM_SERVICE_URL || 'http://stream:4009').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
    if (principal?.sub) {
      headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
      headers['X-SynapseOne-User'] = String(principal.sub);
      if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
      if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
    } else {
      headers['X-SynapseOne-Tenant'] = 'platform';
    }
    const callStream = async (method: string, path: string, body?: any, allowConflict = false): Promise<any> => {
      const r = await fetch(`${STREAM_BASE}${path}`, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok && !(allowConflict && r.status === 409)) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: stream.${operation} -> ${r.status}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
      }
      return parsed;
    };
    if (operation === 'list-topics') return callStream('GET', '/v1/stream/topics');
    const topic = cleanId(a.topic, 'topic', 64);
    if (operation === 'publish') {      return callStream('POST', `/v1/stream/topics/${encodeURIComponent(topic)}/events`, {
        payload: a.payload, key: a.key, headers: a.headers,
      });
    }
    const group = cleanId(a.group, 'group', 128);
    if (operation === 'ensure-group') {
      await callStream('PUT', `/v1/stream/topics/${encodeURIComponent(topic)}`, {}, true);
      const created = await callStream('PUT', `/v1/stream/topics/${encodeURIComponent(topic)}/groups/${encodeURIComponent(group)}`, {
        startId: a.startId !== undefined ? a.startId : '0',
      }, true);
      return created || { topic, group, startId: a.startId || '0' };
    }
    if (operation === 'consume') {
      return callStream('POST', `/v1/stream/topics/${encodeURIComponent(topic)}/groups/${encodeURIComponent(group)}/read`, {
        consumer: a.consumer || 'synapseflow',
        count: Math.min(Math.max(Number(a.count) || 50, 1), 100),
        blockMs: a.blockMs,
      });
    }
    if (operation === 'ack') {
      if (!Array.isArray(a.ids)) {
        throw new Error("synapseone.api: stream.ack needs an array 'ids'");
      }
      if (!a.ids.length) return { acked: 0 };
      return callStream('POST', `/v1/stream/topics/${encodeURIComponent(topic)}/groups/${encodeURIComponent(group)}/ack`, { ids: a.ids });
    }
    throw new Error(`synapseone.api: unsupported call 'stream.${operation}'`);
  }

  // Base service
  if (resource === 'base') {
    const BASE_BASE = (process.env.BASE_SERVICE_URL || 'http://base:4005').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list-collections') {
        path = '/v1/base/collections';
      } else if (operation === 'create-document') {
        method = 'POST';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/documents`;
        body = a.data !== undefined ? { id: a.id, data: a.data } : (a.document !== undefined ? { id: a.id, data: a.document } : a);
      } else if (operation === 'get-document') {
        method = 'GET';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/documents/${encodeURIComponent(cleanId(a.id, 'id', 256))}`;
      } else if (operation === 'query-documents') {
        method = 'POST';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/query`;
        // base-service expects `where` + `orderBy`; older workflows and the
        // AI tool use `filter`/`sort`, so accept both spellings. An empty
        // filter is invalid server-side, so omit it when the caller wants all.
        const where = a.where !== undefined ? a.where : a.filter;
        const orderBy = a.orderBy !== undefined ? a.orderBy : a.sort;
        const hasWhere = where !== undefined && where !== null && (
          Array.isArray(where)
            ? where.length > 0
            : typeof where === 'object'
              ? Object.keys(where).length > 0
              : String(where).trim().length > 0
        );
        body = {
          ...(hasWhere ? { where } : {}),
          ...(orderBy !== undefined ? { orderBy } : {}),
          limit: a.limit,
          offset: a.offset,
        };
      } else if (operation === 'delete-document') {
        method = 'DELETE';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/documents/${encodeURIComponent(cleanId(a.id, 'id', 256))}`;
      } else if (operation === 'vector-search') {
        let vector = a.vector ?? a.embedding;
        const queryText = a.query ?? a.text ?? a.prompt ?? (typeof a.input === 'string' ? a.input : undefined);
        if ((!Array.isArray(vector) || vector.length === 0) && queryText) {
          try {
            const embRes = await synapseoneCall('inference', 'embeddings', { input: String(queryText) }, principal);
            const rawVec = extractEmbeddingVector(embRes);
            if (rawVec && rawVec.length > 0) {
              vector = rawVec;
            }
          } catch (e: any) {
            throw new Error(`synapseone.api: base.vector-search embedding failed: ${e?.message || e}`);
          }
        }
        method = 'POST';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/vector-search`;
        body = {
          vector,
          limit: a.limit ?? a.k,
          field: a.field,
          metric: a.metric,
          where: a.where !== undefined ? a.where : a.filter,
          as: a.as,
        };
      } else {
        throw new Error(`synapseone.api: unsupported call 'base.${operation}'`);
      }
      const r = await fetch(`${BASE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapseone.api: Base service timed out after 20000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Faststore service
  if (resource === 'faststore') {
    const FASTSTORE_BASE = (process.env.FASTSTORE_SERVICE_URL || 'http://faststore:4006').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
        headers['X-SynapseOne-Tenant'] = String(principal.org || principal.account || principal.sub);
      } else {
        headers['X-SynapseOne-Tenant'] = 'platform';
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'get') {
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
      } else if (operation === 'set') {
        method = 'PUT';
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
        body = { value: a.value, ttlSeconds: a.ttlSeconds, nx: a.nx, xx: a.xx };
      } else if (operation === 'incr') {
        method = 'POST';
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}/incr`;
        body = { by: a.by !== undefined ? Number(a.by) : 1, ttlSeconds: a.ttlSeconds };
      } else if (operation === 'delete') {
        method = 'DELETE';
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
      } else if (operation === 'hash-get') {
        path = `/v1/faststore/hashes/${encodeURIComponent(cleanId(a.key, 'key', 256))}${a.field ? `/${encodeURIComponent(String(a.field))}` : ''}`;
      } else if (operation === 'hash-set') {
        method = 'PUT';
        path = `/v1/faststore/hashes/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
        body = { values: a.values || a.fields || (a.field && a.value !== undefined ? { [a.field]: a.value } : {}), ttlSeconds: a.ttlSeconds };
      } else {
        throw new Error(`synapseone.api: unsupported call 'faststore.${operation}'`);
      }
      const r = await fetch(`${FASTSTORE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      // Cache miss is a normal result for agents/if nodes, not a workflow
      // failure: return null instead of throwing on 404 for reads.
      if (r.status === 404 && (operation === 'get' || operation === 'hash-get')) {
        return operation === 'get' ? { key: a.key, value: null, hit: false } : { key: a.key, values: null, hit: false };
      }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapseone.api: Faststore service timed out after 15000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Queue service
  if (resource === 'queue') {
    const QUEUE_BASE = (process.env.QUEUE_SERVICE_URL || 'http://queue:4007').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
        headers['X-SynapseOne-Tenant'] = String(principal.org || principal.account || principal.sub);
      } else {
        headers['X-SynapseOne-Tenant'] = 'platform';
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list') {
        path = '/v1/queue/queues';
      } else if (operation === 'publish') {
        method = 'POST';
        path = `/v1/queue/queues/${encodeURIComponent(cleanId(a.queue, 'queue', 128))}/messages`;
        body = {
          payload: a.payload !== undefined ? a.payload : a.body !== undefined ? a.body : a.message,
          priority: a.priority,
          delaySeconds: a.delaySeconds,
        };
      } else if (operation === 'consume') {
        method = 'POST';
        path = `/v1/queue/queues/${encodeURIComponent(cleanId(a.queue, 'queue', 128))}/consume`;
        // queue-service uses maxMessages + consumer; keep `count` as a
        // backward-compatible alias for older workflows.
        body = {
          maxMessages: a.maxMessages !== undefined ? Number(a.maxMessages) : a.count !== undefined ? Number(a.count) : 1,
          consumer: a.consumer || 'workflow',
          visibilityTimeoutSeconds: a.visibilityTimeoutSeconds,
        };
      } else if (operation === 'ack') {
        method = 'POST';
        path = `/v1/queue/queues/${encodeURIComponent(cleanId(a.queue, 'queue', 128))}/ack`;
        body = { receipt: a.receipt || a.receiptHandle };
      } else {
        throw new Error(`synapseone.api: unsupported call 'queue.${operation}'`);
      }
      const r = await fetch(`${QUEUE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapseone.api: Queue service timed out after 15000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Inference service
  if (resource === 'inference') {
    const INF_BASE = (process.env.INFERENCE_SERVICE_URL || 'http://inference:4008').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
    const rawInferenceTimeout = Number(process.env.INFERENCE_TIMEOUT_MS || 120000);
    const inferenceTimeoutMs = Math.min(Math.max(Number.isFinite(rawInferenceTimeout) ? rawInferenceTimeout : 120000, 1000), 300000);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), inferenceTimeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
      }
      let method = 'POST';
      let path = '';
      let body: any;
      if (operation === 'chat') {
        path = '/v1/inference/chat/completions';
        body = {
          messages: a.messages,
          model: a.model,
          temperature: a.temperature,
          max_tokens: a.max_tokens,
          // Native tool calling must survive the workflow-service hop;
          // previously these fields were silently dropped.
          ...(a.tools !== undefined ? { tools: a.tools } : {}),
          ...(a.tool_choice !== undefined ? { tool_choice: a.tool_choice } : {}),
          ...(a.response_format !== undefined ? { response_format: a.response_format } : {}),
          ...(a.top_p !== undefined ? { top_p: a.top_p } : {}),
        };
      } else if (operation === 'embeddings') {
        path = '/v1/inference/embeddings';
        body = { input: a.input, model: a.model };
      } else if (operation === 'decision') {
        path = '/v1/inference/decision';
        body = { state: a.state, questions: a.questions, instruction: a.instruction };
      } else if (operation === 'route') {
        path = '/v1/inference/decision/route';
        body = { input: a.input, choices: a.choices, instruction: a.instruction };
      } else {
        throw new Error(`synapseone.api: unsupported call 'inference.${operation}'`);
      }
      const r = await fetch(`${INF_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`synapseone.api: Inference service timed out after ${inferenceTimeoutMs}ms`);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }
  // IAM resources over the service network as the run principal.
  const IAM_BASE = (process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
  const INTERNAL = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
  // #10: the IAM middleware requires a real caller credential even when the
  // internal secret is present (the secret proves gateway-origin, not identity).
  // Use a dedicated service API key — never the run user's JWT (workflow runs
  // outlive tokens and webhook/cron runs hold no user credential at all).
  const IAM_API_KEY = (process.env.SYNAPSEONE_IAM_API_KEY || '').trim();
  const iamFetch = async (method: string, path: string, body?: any): Promise<any> => {
    if (!IAM_API_KEY) {
      throw new Error('synapseone.api: IAM calls need SYNAPSEONE_IAM_API_KEY (service credential) — see docs/configuration.md');
    }
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': IAM_API_KEY };
      if (INTERNAL) headers['x-synapseone-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseOne-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseOne-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseOne-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseOne-Account'] = String(principal.account);
      }
      const r = await fetch(`${IAM_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapseone.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapseone.api: IAM timed out after 15000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  };
  const enc = encodeURIComponent;
  switch (`${resource}.${operation}`) {
    case 'orgs.list':
      return iamFetch('GET', '/v1/orgs');
    case 'users.list':
      return iamFetch('GET', `/v1/orgs/${enc(cleanId(a.orgId, 'orgId'))}/users`);
    case 'roles.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/roles`);
    case 'policies.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/policies`);
    case 'authorize.check':
      return iamFetch('POST', '/v1/authorize', {
        userId: cleanId(a.userId, 'userId'), action: cleanId(a.action, 'action', 512),
        resource: cleanId(a.resource, 'resource', 2048), ...(a.context !== undefined ? { context: a.context } : {}),
      });
    case 'audit.query': {
      const qs = new URLSearchParams();
      qs.set('limit', String(Math.min(Math.max(Number(a.limit) || 20, 1), 200)));
      if (a.actor !== undefined) qs.set('actor', cleanId(a.actor, 'actor'));
      if (a.allowed !== undefined) qs.set('allowed', String(!!a.allowed));
      return iamFetch('GET', `/v1/audit?${qs.toString()}`);
    }
    case 'keys.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/keys`);
    case 'service-accounts.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/service-accounts`);
    default:
      throw new Error(`synapseone.api: unsupported call '${resource}.${operation}'`);
  }
};



dotenv.config();
const PORT = Number(process.env.PORT || 4002);
const VERSION = (() => {
  const injected = String(process.env.SYNAPSEONE_BUILD_VERSION || '').trim();
  if (injected) return injected.slice(0, 128);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD_WF = process.env.NODE_ENV === 'production';

// In-process metrics (P2 /metrics): run counts by trigger+status, node
// error counts, webhook rejections by reason. Reset on restart.
// Module-level so both createApp routes and the cron loop can record.
const metricRuns = new Map<string, number>();
const metricWebhookRejected = new Map<string, number>();
function recordRun(triggeredBy: string, status: string, nodeRuns?: Array<{ status: string }>): void {
  const k = `${triggeredBy || 'manual'}|${status || 'success'}`;
  metricRuns.set(k, (metricRuns.get(k) || 0) + 1);
  if (nodeRuns) {
    const errs = nodeRuns.filter((r) => r.status === 'error').length;
    if (errs) metricRuns.set(`node-errors|total`, (metricRuns.get(`node-errors|total`) || 0) + errs);
  }
}
function recordWebhookReject(reason: string): void {
  metricWebhookRejected.set(reason, (metricWebhookRejected.get(reason) || 0) + 1);
}
export function __resetMetrics(): void {
  metricRuns.clear();
  metricWebhookRejected.clear();
}

/** SSRF guard: block workflow definitions that make the engine fetch internal targets.
 *  Single implementation lives in ./engine (isBlockedUrl honors the
 *  SYNAPSEONE_SELF_BASE_URLS allowlist); re-exported here for tests. */
const isBlockedUrl = engineIsBlockedUrl;
function findSsrfUrl(definition: any): string | null {
  // Recursive scan (depth-capped) so nested options (headers, bodyParameters,
  // assignments…) can't smuggle an internal URL past save-time validation.
  // Runtime execHttp re-checks the final URL + every redirect hop anyway.
  const seen = new Set<any>();
  const scan = (v: any, depth: number): string | null => {
    if (depth > 4 || v === null || v === undefined) return null;
    if (typeof v === 'string') {
      if (v.length < 2048 && /^https?:\/\//i.test(v) && isBlockedUrl(v)) return v;
      return null;
    }
    if (typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = scan(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const val of Object.values(v)) {
      const hit = scan(val, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  try {
    const nodes = definition?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      const hit = scan((n as any)?.parameters, 0);
      if (hit) return hit;
    }
  } catch { /* ignore */ }
  return null;
}
function validateDefinition(definition: any, opts: { requireTrigger?: boolean } = {}): string | null {
  if (!definition || typeof definition !== 'object') return 'definition must be an object';
  const nodes = (definition as any).nodes;
  if (nodes !== undefined) {
    if (!Array.isArray(nodes)) return 'definition.nodes must be an array';
    if (nodes.length > 50) return 'definition.nodes exceeds 50 nodes';
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const type = normalizeNodeType((n as any).type);
      if (type !== (n as any).type) (n as any).type = type;
    }
    const names = new Set<string>();
    for (const n of nodes) {
      if (!n || typeof n !== 'object') return 'definition.nodes[] must be objects';
      if (typeof (n as any).type !== 'string' || (n as any).type.length > 128) return 'definition.nodes[].type invalid';
      // m5: the engine keys everything off node names — nameless nodes
      // silently break routing, so require a name (same as console validateGraph).
      const nm = (n as any).name;
      if (typeof nm !== 'string' || !nm || nm.length > 128) {
        return `definition.nodes[].name must be a 1..128 char string (got '${String(nm).slice(0, 32)}')`;
      }
      if (names.has(nm)) return `duplicate node name '${nm}'`;
      names.add(nm);
      const params = (n as any).parameters;
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        return `definition.nodes['${nm}'].parameters must be an object`;
      }
      if (isCodeType((n as any).type)) {
        const src = params?.code ?? params?.jsCode ?? params?.js;
        if (typeof src === 'string' && Buffer.byteLength(src, 'utf8') > 50 * 1024) {
          return `definition.nodes['${nm}'].code exceeds 50KB`;
        }
      }
      // M7: webhook trigger contract — path charset + method enum.
      if (isWebhookType((n as any).type) && params && typeof params === 'object') {
        if (params.path !== undefined && params.path !== null && String(params.path) !== '') {
          const wp = String(params.path).replace(/^\/+|\/+$/g, '');
          if (!wp || wp.length > 128 || !/^[A-Za-z0-9_.\/-]+$/.test(wp) || wp.split('/').includes('..')) {
            return `definition.nodes['${nm}'].webhook path invalid (1..128 chars, [A-Za-z0-9_.\\/ -], no '..'])`;
          }
        }
        if (params.httpMethod !== undefined && params.httpMethod !== null && String(params.httpMethod) !== '') {
          const m = String(params.httpMethod).toUpperCase();
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) {
            return `definition.nodes['${nm}'].webhook httpMethod invalid (GET|POST|PUT|PATCH|DELETE|HEAD)`;
          }
        }
        // P0-5: inbound hardening contract.
        if (params.auth !== undefined && params.auth !== null) {
          if (typeof params.auth !== 'object' || Array.isArray(params.auth)) {
            return `definition.nodes['${nm}'].webhook auth must be an object`;
          }
          const mode = (params.auth as any).mode;
          if (mode !== undefined && !['none', 'secret-header', 'hmac-sha256', 'jwt'].includes(String(mode))) {
            return `definition.nodes['${nm}'].webhook auth.mode invalid (none|secret-header|hmac-sha256|jwt)`;
          }
          if (String(mode) !== 'none' && mode !== undefined) {
            if (typeof (params.auth as any).credentialId !== 'string' || !(params.auth as any).credentialId) {
              return `definition.nodes['${nm}'].webhook auth.credentialId required when mode is '${mode}'`;
            }
          }
          if ((params.auth as any).header !== undefined && (typeof (params.auth as any).header !== 'string' || !/^[A-Za-z0-9-]+$/.test((params.auth as any).header) || (params.auth as any).header.length > 128)) {
            return `definition.nodes['${nm}'].webhook auth.header invalid`;
          }
        }
        if (params.rateLimit !== undefined && params.rateLimit !== null) {
          const rpm = Number((params.rateLimit as any)?.rpm);
          if (!Number.isFinite(rpm) || rpm < 1 || rpm > 60000) {
            return `definition.nodes['${nm}'].webhook rateLimit.rpm must be 1..60000`;
          }
        }
        if (params.idempotency !== undefined && params.idempotency !== null) {
          if (typeof params.idempotency !== 'object' || Array.isArray(params.idempotency)) {
            return `definition.nodes['${nm}'].webhook idempotency must be an object`;
          }
          if (typeof (params.idempotency as any).header !== 'string' || !/^[A-Za-z0-9-]+$/.test((params.idempotency as any).header)) {
            return `definition.nodes['${nm}'].webhook idempotency.header invalid`;
          }
          const ttl = Number((params.idempotency as any).ttlSeconds ?? 3600);
          if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86400) {
            return `definition.nodes['${nm}'].webhook idempotency.ttlSeconds must be 60..86400`;
          }
        }
      }
      if (isMcpTriggerType((n as any).type) && params && typeof params === 'object') {
        const toolName = String((params as any).toolName || nm);
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(toolName)) {
          return `definition.nodes['${nm}'].mcpTrigger toolName must match [A-Za-z0-9_.-]{1,64}`;
        }
        if ((params as any).description !== undefined && String((params as any).description).length > 500) {
          return `definition.nodes['${nm}'].mcpTrigger description ≤500 chars`;
        }
        if ((params as any).public !== undefined && typeof (params as any).public !== 'boolean') {
          return `definition.nodes['${nm}'].mcpTrigger public must be boolean`;
        }
        if ((params as any).readOnly !== undefined && typeof (params as any).readOnly !== 'boolean') {
          return `definition.nodes['${nm}'].mcpTrigger readOnly must be boolean`;
        }
        if ((params as any).public === true && (params as any).readOnly === false) {
          return `definition.nodes['${nm}'].mcpTrigger cannot be public when readOnly is false`;
        }
        const schema = (params as any).inputSchema;
        if (schema !== undefined && schema !== null) {
          if (typeof schema !== 'object' || Array.isArray(schema)) {
            return `definition.nodes['${nm}'].mcpTrigger inputSchema must be a JSON Schema object`;
          }
          try {
            if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > 8 * 1024) {
              return `definition.nodes['${nm}'].mcpTrigger inputSchema ≤8KB`;
            }
          } catch { return `definition.nodes['${nm}'].mcpTrigger inputSchema must be JSON-serializable`; }
        }
      }
      // P1-16: httpRequest credential reference shape (secret itself lives
      // in /v1/credentials and is resolved server-side at run time).
      if (isHttpRequestType((n as any).type) && params && typeof params === 'object') {
        const auth = (params as any).auth;
        if (auth !== undefined && auth !== null) {
          if (typeof auth !== 'object' || Array.isArray(auth)) {
            return `definition.nodes['${nm}'].httpRequest auth must be an object`;
          }
          if (typeof (auth as any).credentialId !== 'string' || !(auth as any).credentialId) {
            return `definition.nodes['${nm}'].httpRequest auth.credentialId required`;
          }
        }
        if ((params as any).retry !== undefined && (params as any).retry !== null) {
          const rt = (params as any).retry;
          if (typeof rt !== 'object' || Array.isArray(rt)) {
            return `definition.nodes['${nm}'].retry must be an object`;
          }
          const a = Number((rt as any).attempts);
          if ((rt as any).attempts !== undefined && (!Number.isFinite(a) || a < 1 || a > 5)) {
            return `definition.nodes['${nm}'].retry.attempts must be 1..5`;
          }
        }
      }
      // First-party SynapseOne block: resource/operation must be known.
      if ((n as any).type === 'synapseone.api' && params && typeof params === 'object') {
        const perr = validateSynapseOneParams(params);
        if (perr) return `definition.nodes['${nm}']: ${perr}`;
      }
      // Split per-service integration nodes (IAM/Base/Faststore/Queue/LDS/
      // Inference/Flow) — validate their operation + required input fields.
      if (isIntegrationType((n as any).type) && (n as any).type !== 'synapseone.api' && params && typeof params === 'object') {
        const perr = validateIntegrationParams((n as any).type, params);
        if (perr) return `definition.nodes['${nm}']: ${perr}`;
      }
      // AI Agent: enabled tools + model parameters.
      if (isAiAgentType((n as any).type) && params && typeof params === 'object') {
        const terr = validateAgentToolIds((params as any).tools);
        if (terr) return `definition.nodes['${nm}']: ${terr}`;
        const maxSteps = Number((params as any).maxSteps);
        if ((params as any).maxSteps !== undefined && (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > 12)) {
          return `definition.nodes['${nm}']: maxSteps must be 1..12`;
        }
        const temp = Number((params as any).temperature);
        if ((params as any).temperature !== undefined && (!Number.isFinite(temp) || temp < 0 || temp > 2)) {
          return `definition.nodes['${nm}']: temperature must be 0..2`;
        }
      }
      // Decision Engine: at least one route, bounded fallback/threshold.
      if (isDecisionType((n as any).type) && params && typeof params === 'object') {
        const raw = (params as any).choices !== undefined ? (params as any).choices : (params as any).routes;
        let routes: string[] = [];
        if (Array.isArray(raw)) {
          routes = raw.map((r: any) => (r && typeof r === 'object' ? String(r.name ?? r.route ?? r.value ?? '') : String(r ?? ''))).filter(Boolean);
        } else if (raw && typeof raw === 'object') {
          routes = Object.keys(raw);
        }
        if (!routes.length) return `definition.nodes['${nm}']: decision needs at least one route (choices)`;
        if (routes.length > 20) return `definition.nodes['${nm}']: decision supports at most 20 routes`;
        if (new Set(routes).size !== routes.length) return `definition.nodes['${nm}']: decision route names must be unique`;
        const fb = Number((params as any).fallbackBranch);
        if ((params as any).fallbackBranch !== undefined && (!Number.isFinite(fb) || fb < 0 || fb >= routes.length)) {
          return `definition.nodes['${nm}']: fallbackBranch must be 0..${routes.length - 1}`;
        }
        const mc = Number((params as any).minConfidence);
        if ((params as any).minConfidence !== undefined && (!Number.isFinite(mc) || mc < 0 || mc > 1)) {
          return `definition.nodes['${nm}']: minConfidence must be 0..1`;
        }
      }
      // A human task with neither an assignee nor candidate roles can never be
      // decided under the default-deny rule.
      if (['humanTask', 'synapseone.humanTask'].includes(String(normalizeNodeType((n as any).type)))) {
        const hp = params && typeof params === 'object' ? params as any : {};
        const assignee = typeof hp.assignee === 'string' ? hp.assignee.trim() : '';
        const roles = Array.isArray(hp.candidateRoles) ? hp.candidateRoles.filter(Boolean) : [];
        if (!assignee && !roles.length) {
          return `definition.nodes['${nm}']: humanTask needs assignee or candidateRoles`;
        }
      }
      // M8: reject schedules that would silently never fire.
      if (isCronType((n as any).type)) {
        const ce = validateCronParams(params || {});
        if (ce) return `definition.nodes['${nm}']: ${ce}`;
      }
    }
    // Cycle check (DAG only).
    try {
      const conns = (definition as any).connections || {};
      const cyc = detectCycle(nodes as any, conns as any);
      if (cyc) return cyc;
    } catch { /* ignore */ }
  }
  try {
    if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 200 * 1024) return 'definition exceeds 200KB';
  } catch { return 'definition is not JSON-serializable'; }
  const bad = findSsrfUrl(definition);
  if (bad) return `definition contains blocked internal URL (${String(bad).slice(0, 80)}) — use an allowlisted public endpoint`;
  // Structural edge checks — messages synced with console validateGraph.
  try {
    const nodesArr: any[] = Array.isArray((definition as any).nodes) ? (definition as any).nodes : [];
    const names = new Set(nodesArr.map((n: any) => (n as any)?.name).filter((x: any) => typeof x === 'string' && x));
    const byName = new Map(nodesArr.map((n: any) => [n?.name, n]));
    const routesOf = (p: any): string[] => {
      const raw = p?.choices !== undefined ? p.choices : p?.routes;
      if (Array.isArray(raw)) {
        return raw.map((r: any) => (r && typeof r === 'object' ? String(r.name ?? r.route ?? r.value ?? '') : String(r ?? ''))).filter(Boolean);
      }
      if (raw && typeof raw === 'object') return Object.keys(raw);
      return [];
    };
    const conns: any = (definition as any).connections || {};
    const touched = new Set<string>();
    const auxSources = new Set<string>();
    const modelTargets = new Map<string, number>();
    for (const [from, groups] of Object.entries(conns)) {
      if (!names.has(from)) return `connection from unknown node '${from}'`;
      const mains: any = (groups as any)?.main;
      if (mains !== undefined && !Array.isArray(mains)) return `connections['${from}'].main must be an array`;
      for (let bi = 0; bi < (mains || []).length; bi++) {
        const branch = mains[bi];
        for (const e of Array.isArray(branch) ? branch : []) {
          if (!e || typeof e !== 'object' || !names.has((e as any).node)) {
            return `connection from '${from}' points at unknown node '${(e as any)?.node}'`;
          }
          if ((e as any).node === from) return `self-loop on '${from}' is not allowed`;
          const port = edgeTargetPort(e as any);
          if (port) {
            const target = byName.get((e as any).node);
            if (!isAiAgentType((target as any)?.type)) {
              return `connection '${from}' -> '${(e as any).node}': ${port} socket can only target an AI Agent`;
            }
            auxSources.add(from);
            if (port === 'model') {
              if (!isModelType((byName.get(from) as any)?.type)) {
                return `connection '${from}' -> '${(e as any).node}': Model socket needs a Model Core source`;
              }
              modelTargets.set((e as any).node, (modelTargets.get((e as any).node) || 0) + 1);
            }
          } else {
            touched.add(from);
            touched.add((e as any).node);
            const src = byName.get(from);
            if (isIfType((src as any)?.type) && bi > 1) {
              return `if node '${from}' has only true/false outputs (branch ${bi} is invalid)`;
            }
            if (isDecisionType((src as any)?.type)) {
              const nRoutes = routesOf((src as any)?.parameters || {}).length;
              if (nRoutes && bi >= nRoutes) {
                return `decision node '${from}' has ${nRoutes} route(s) but an edge is on branch ${bi}`;
              }
            }
          }
        }
      }
    }
    for (const [agent, count] of modelTargets) {
      if (count > 1) return `AI Agent '${agent}' has more than one model source connected`;
    }
    if (nodesArr.length > 1) {
      for (const n of nodesArr) {
        const nm = (n as any)?.name;
        if (typeof nm === 'string' && nm && !touched.has(nm) && !auxSources.has(nm)) {
          return `dangling node '${nm}' has no connections`;
        }
      }
    }
  } catch { /* ignore */ }
  // A public MCP tool is callable without a tenant principal. `readOnly` is a
  // label; prove it structurally before exposing it.
  const publicTool = findMcpTrigger(definition);
  if (publicTool?.public && !isStructurallyReadOnlyDefinition(definition)) {
    return `MCP tool '${publicTool.toolName}' is public but its graph is not structurally read-only (only read operations, GET/HEAD HTTP and no stored credentials are allowed)`;
  }
  // A definition without any recognized trigger can never run — reject save
  // instead of producing an "active but dead" workflow that fires nothing.
  // (test-run sandboxes run trigger-less fragments, so it opts out.)
  if (opts.requireTrigger !== false) {
    const triggerless: any[] = Array.isArray((definition as any).nodes) ? (definition as any).nodes : [];
    if (
      triggerless.length &&
      !triggerless.some((n: any) => isTriggerType(String(n?.type)))
    ) {
      return 'definition needs at least one trigger node (webhook, cron or manualTrigger)';
    }
  }
  return null;
}

function validateExecutionSettings(settings: any): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const execution = settings.execution;
  if (execution === undefined || execution === null) return null;
  if (typeof execution !== 'object' || Array.isArray(execution)) return 'settings.execution must be an object';
  if (execution.mode !== undefined) {
    const mode = String(execution.mode).toLowerCase();
    if (!['platform', 'custom', 'hybrid', 'system', 'inline'].includes(mode)) {
      return 'settings.execution.mode must be platform|custom|hybrid|system|inline';
    }
  }
  if (execution.queue !== undefined && execution.queue !== null && String(execution.queue) !== '' && !isQueueName(execution.queue)) {
    return 'settings.execution.queue must match [A-Za-z][A-Za-z0-9_-]{0,63}';
  }
  if (execution.maxAttempts !== undefined) {
    const n = Number(execution.maxAttempts);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'settings.execution.maxAttempts must be 1..100';
  }
  if (execution.visibilityTimeoutSeconds !== undefined) {
    const n = Number(execution.visibilityTimeoutSeconds);
    if (!Number.isInteger(n) || n < 30 || n > 3600) return 'settings.execution.visibilityTimeoutSeconds must be 30..3600';
  }
  if (execution.resources !== undefined) {
    const normalized = normalizeResourceRequirements(execution.resources, DEFAULT_WORKFLOW_RESOURCES);
    if (normalized.error) return `settings.execution.${normalized.error}`;
  }
  return null;
}

function toApiWorkflow(w: StoredWorkflow): any {
  return {
    id: w.id,
    name: w.name,
    active: w.active,
    nodes: w.nodes,
    connections: w.connections,
    settings: w.settings,
    orgId: w.org_id ?? undefined,
    accountId: w.account_id ?? undefined,
    owner: w.owner_sub ?? undefined,
    runAs: w.run_as ?? undefined,
    revision: w.revision ?? 1,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/** Mask secret-looking values in execution payloads (P0-4): keys matching
 *  authorization/api-key/password/secret/token/cookie are replaced with ***.
 *  Applied at the API boundary so stored node I/O never leaks credentials
 *  to log viewers. Depth-capped, cycle-safe. */
const SECRET_KEY_RE = /^(authorization|.*api[-_]?key.*|.*password.*|.*secret.*|.*token.*|cookie|set-cookie|x-signature)$/i;
export function maskSecrets(v: any, depth = 0, seen: Set<any> = new Set()): any {
  if (depth > 6 || v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (seen.has(v)) return '[circular]';
  if (Array.isArray(v)) {
    seen.add(v);
    const out = v.map((item) => maskSecrets(item, depth + 1, seen));
    seen.delete(v);
    return out;
  }
  seen.add(v);
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = SECRET_KEY_RE.test(k) ? '***' : maskSecrets(val, depth + 1, seen);
  }
  seen.delete(v);
  return out;
}

/** Persist the exact human-task checkpoint created by the engine. A paused
 *  execution without this binding cannot be resumed (fail closed). */
function pauseBinding(r: { pause?: { node?: string; task?: any } } | null | undefined): {
  pause_task_id: string | null;
  pause_node: string | null;
} {
  const taskId = r?.pause?.task?.id;
  return {
    pause_task_id: typeof taskId === 'string' && taskId ? taskId : null,
    pause_node: r?.pause?.node ? String(r.pause.node).slice(0, 128) : null,
  };
}

/** Create the real durable task for an inline trigger that has no worker.
 *  The execution row is created after the run, so the caller supplies the
 *  pre-generated id. */
function inlineHumanTaskSink(executionId: string, wf: StoredWorkflow, principal: Principal | null) {
  return {
    create: async (task: any) => {
      const rec = await createHumanTaskRec({
        id: randomUUID(),
        execution_id: executionId,
        workflow_id: wf.id,
        node_name: task.node,
        title: task.title,
        description: task.description,
        assignee: task.assignee,
        candidate_roles: task.candidateRoles,
        decision_schema: task.decisionSchema,
        payload: task.payload,
        deadline: task.deadline,
        org_id: principal?.org || wf.org_id || null,
        account_id: principal?.account || wf.account_id || null,
      });
      return toPublicHumanTask(rec);
    },
  };
}

function toApiExecution(e: any, includeData: boolean): any {
  const base: any = {
    id: e.id,
    workflowId: e.workflow_id,
    workflowName: e.workflow_name,
    status: e.status,
    mode: 'manual',
    triggeredBy: e.triggered_by,
    principal: e.principal ?? undefined,
    actor: e.actor ?? undefined,
    queue: e.queue_name ?? undefined,
    runner: e.runner ?? undefined,
    workerId: e.worker_id ?? undefined,
    runnerInstanceId: e.runner_instance_id ?? undefined,
    resourceRequirements: e.resource_requirements ?? undefined,
    targetRunnerId: e.target_runner_id ?? undefined,
    attempt: e.attempt ?? undefined,
    leaseExpiresAt: e.lease_expires_at ?? undefined,
    workflowRevision: e.workflow_revision ?? undefined,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    error: e.error,
    output: maskSecrets(e.output),
    input: includeData ? maskSecrets(e.input) : undefined,
  };
  if (includeData) {
    base.data = maskSecrets(e.node_runs);
    base.nodeRuns = maskSecrets(e.node_runs);
  }
  // Strip undefined for clean JSON.
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
}

/** Caller principal from gateway-stamped headers (P0-2). The gateway strips
 *  client-sent x-synapseone-* and re-stamps from the verified identity, so
 *  these are trusted here. Direct calls carry no principal → anonymous. */
export function principalFromHeaders(req: express.Request): import('./store').Principal | null {
  const h = (n: string): string => {
    // Accept the legacy x-synapsedx-* prefix during the rebrand window.
    const legacy = n.startsWith('x-synapseone-') ? n.replace('x-synapseone-', 'x-synapsedx-') : n;
    const v = req.headers[n] ?? req.headers[legacy];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  const scopes = (raw: string): string[] | undefined => {
    const list = raw.split(',').map((s) => s.trim()).filter((s) => s && s.length <= 200);
    return list.length ? list.slice(0, 100) : undefined;
  };
  const roles = (raw: string): string[] | undefined => {
    const list = raw.split(',').map((s) => s.trim()).filter((s) => s && s.length <= 64);
    return list.length ? list.slice(0, 50) : undefined;
  };
  const kindHeader = clean(h('x-synapseone-kind'));
  const runnerHeader = clean(h('x-synapseone-runner'));
  // A platform runner key has no user/tenant. It is a system compute identity
  // bound to exactly one runner registration; the gateway stamped the runner id
  // from the verified key (clients cannot supply it).
  if (kindHeader === 'platform-runner') {
    if (!runnerHeader) return null;
    return {
      sub: `platform-runner:${runnerHeader}`,
      kind: 'platform-runner',
      runnerId: runnerHeader,
      scopes: scopes(h('x-synapseone-scopes')),
    };
  }
  const user = h('x-synapseone-user');
  if (user) {
    if (user.length > 128) return null;
    return {
      sub: user,
      org: clean(h('x-synapseone-org')),
      account: clean(h('x-synapseone-account')),
      kind: kindHeader,
      scopes: scopes(h('x-synapseone-scopes')),
      isOrgAdmin: h('x-synapseone-org-admin') === 'true',
      roles: roles(h('x-synapseone-roles')),
    };
  }
  // Account-level API keys have kind=apikey + account without a user. The
  // gateway stamps a verified user for user-bound keys handled above. Without
  // this fallback, account-level keys would
  // look like an internal/direct call — workflow scoping would treat them as
  // tenant-free (global list, arbitrary tenant binding). Any tenant marker
  // means "authenticated principal"; synthesize a non-user subject.
  const kind = clean(h('x-synapseone-kind'));
  const account = clean(h('x-synapseone-account'));
  const org = clean(h('x-synapseone-org'));
  if (kind || account || org) {
    return {
      sub: account ? `apikey:${account}` : `${kind || 'principal'}:unknown`,
      org,
      account,
      kind: kind || 'apikey',
      scopes: scopes(h('x-synapseone-scopes')),
    };
  }
  return null;
}

/** Principal for automated runs (webhook/cron): the workflow's stored run_as
 *  (else owner) bound to its tenant. Webhooks do NOT run as anonymous, so
 *  tenant-scoped first-party calls (e.g. SynapseLDS publish-record) keep
 *  working without weakening tenancy. */
export function workflowRunPrincipal(wf: {
  org_id?: string | null; account_id?: string | null; owner_sub?: string | null; run_as?: string | null;
}): import('./store').Principal | null {
  // A caller-controlled runAs value is never proof of another identity.
  // Existing owned workflows must run as their stored creator, including
  // workflows saved before runAs validation was introduced.
  const sub = String(wf.owner_sub || '').trim() || String(wf.run_as || '').trim();
  if (!sub && !wf.org_id && !wf.account_id) return null;
  return { sub: sub || 'workflow', org: wf.org_id || undefined, account: wf.account_id || undefined, kind: 'workflow' };
}

// ---------- queue dispatch helpers ----------

function httpError(status: number, code: string, message: string): Error & { status: number; code: string } {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Create a queued execution row and publish its job. Inputs and definitions
 *  stay in Postgres; only `{executionId}` travels through SynapseQueue. */
const IAM_STATUS_BASE = (process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
const IAM_STATUS_SECRET = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
const orgStatusCache = new Map<string, { suspended: boolean; expires: number }>();

/** New asynchronous work must not start for a suspended tenant. The check is
 *  cached for five seconds because enqueue is on the webhook/cron hot path;
 *  IAM owns the authoritative status and fails soft only if unreachable. */
async function orgSuspended(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId || !IAM_STATUS_BASE) return false;
  const now = Date.now();
  const hit = orgStatusCache.get(orgId);
  if (hit && hit.expires > now) return hit.suspended;
  let suspended = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 500);
    const r = await fetch(`${IAM_STATUS_BASE}/internal/orgs/${encodeURIComponent(orgId)}/status`, {
      headers: { ...(IAM_STATUS_SECRET ? { 'x-synapseone-internal': IAM_STATUS_SECRET } : {}) },
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (r.status === 404) suspended = false;
    else if (r.ok) {
      const body: any = await r.json().catch(() => null);
      suspended = body?.status === 'suspended';
    }
  } catch {
    suspended = false;
  }
  if (orgStatusCache.size > 5000) orgStatusCache.clear();
  orgStatusCache.set(orgId, { suspended, expires: now + 5000 });
  return suspended;
}

async function enqueueExecution(args: {
  wf: StoredWorkflow;
  input: any;
  triggeredBy: string;
  principal: Principal | null;
  delaySeconds?: number;
}): Promise<{ execution: StoredExecution; queue: string; mode: WorkflowRunnerMode }> {
  const orgId = args.principal?.org || args.wf.org_id || null;
  if (orgId && await orgSuspended(orgId)) {
    throw httpError(403, 'org_suspended', 'this organization is suspended');
  }
  const mode = runnerModeForSettings(args.wf.settings);
  if (mode === 'inline') throw httpError(400, 'inline_mode', 'this workflow is configured for inline execution');
  if (!queueTransportEnabled()) {
    throw httpError(503, 'queue_unavailable', 'workflow execution requires SynapseQueue (QUEUE_SERVICE_URL / WORKFLOW_EXECUTION_MODE)');
  }
  const queue = queueNameForSettings(args.wf.settings, mode);
  if (!isQueueName(queue)) throw httpError(500, 'invalid_queue', `workflow runner queue '${queue}' is invalid`);
  const tenantKey = args.principal
    ? (args.principal.org ? `org:${args.principal.org}` : args.principal.account ? `account:${args.principal.account}` : `user:${args.principal.sub}`)
    : '';
  if (mode === 'system' && tenantKey) {
    // Shared system runner capacity is a finite emergency/City resource. Cap
    // each tenant's queued+running system work instead of letting one tenant
    // monopolise the FIFO lane. 0 disables the cap (explicit operator choice).
    const cap = Math.max(0, Number(process.env.WORKFLOW_SYSTEM_QUEUE_TENANT_MAX ?? 100) || 0);
    if (cap > 0 && (await countActiveExecutionsForTenant(tenantKey)) >= cap) {
      throw httpError(429, 'tenant_queue_quota', `tenant ${tenantKey} already has ${cap} active system-runner executions; wait for them to finish or raise WORKFLOW_SYSTEM_QUEUE_TENANT_MAX`);
    }
  }

  const settings = args.wf.settings && typeof args.wf.settings === 'object' ? args.wf.settings : {};
  const executionSettings = settings.execution && typeof settings.execution === 'object' ? settings.execution : {};
  const resourceRequirements = storedResourceRequirements(executionSettings.resources, DEFAULT_WORKFLOW_RESOURCES);
  const execution = await createExecutionRec({
    workflow_id: args.wf.id,
    workflow_name: args.wf.name,
    status: 'queued',
    input: args.input,
    output: null,
    node_runs: [],
    error: null,
    triggered_by: args.triggeredBy,
    principal: args.principal,
    actor: actorFor(args.wf.id, args.principal),
    startedAt: new Date().toISOString(),
    queue_name: queue,
    runner: mode,
    workflow_revision: args.wf.revision,
    resource_requirements: resourceRequirements,
  } as any);

  try {
    // system jobs live in the shared platform namespace so a platform runner
    // can serve every tenant; the execution row keeps the real tenant principal.
    const queuePrincipal = queuePrincipalForMode(mode, args.principal);
    await ensureWorkflowQueue(queue, queuePrincipal, {
      maxAttempts: Number(executionSettings.maxAttempts) || queueMaxAttempts(),
      visibilityTimeoutSeconds: Number(executionSettings.visibilityTimeoutSeconds) || queueVisibilitySeconds(),
    });
    await publishWorkflowRun(queue, execution.id, queuePrincipal, { delaySeconds: args.delaySeconds, tenant: tenantKey });
  } catch (e: any) {
    await finishExecutionRec(execution.id, {
      status: 'error',
      output: null,
      node_runs: [],
      error: `queue dispatch failed: ${String(e?.message || e).slice(0, 500)}`,
      finishedAt: new Date().toISOString(),
      allowedStatuses: ['queued'],
    }).catch(() => null);
    throw e;
  }
  return { execution, queue, mode };
}

async function publishExistingExecution(execution: StoredExecution, delaySeconds?: number, dedupeKey?: string): Promise<void> {
  if (!execution.queue_name) throw httpError(409, 'not_queued', 'execution has no runner queue');
  if (!queueTransportEnabled()) {
    throw httpError(503, 'queue_unavailable', 'workflow execution requires SynapseQueue');
  }
  const mode: WorkflowRunnerMode = execution.runner === 'system' ? 'system' : 'inline';
  const queuePrincipal = queuePrincipalForMode(mode, execution.principal || null);
  await ensureWorkflowQueue(execution.queue_name, queuePrincipal, {
    maxAttempts: queueMaxAttempts(),
    visibilityTimeoutSeconds: queueVisibilitySeconds(),
  });
  await publishWorkflowRun(execution.queue_name, execution.id, queuePrincipal, {
    delaySeconds,
    ...(dedupeKey ? { dedupeKey } : {}),
    tenant: execution.principal
      ? (execution.principal.org ? `org:${execution.principal.org}` : execution.principal.account ? `account:${execution.principal.account}` : `user:${execution.principal.sub}`)
      : undefined,
  });
}

async function waitForExecution(id: string, timeoutMs = 30000): Promise<StoredExecution | null> {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 300000);
  let current = await getExecutionRec(id);
  while (current && (current.status === 'queued' || current.status === 'running') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    current = await getExecutionRec(id);
  }
  return current;
}

function queuedResponse(execution: StoredExecution, queue: string, extra: Record<string, any> = {}): any {
  return {
    ok: true,
    queued: true,
    status: execution.status,
    executionId: execution.id,
    queue,
    runner: execution.runner,
    ...extra,
  };
}

function finishedResponse(execution: StoredExecution): { status: number; body: any } {
  if (execution.status === 'paused') {
    return {
      status: 202,
      body: {
        ok: true, paused: true, status: 'paused', output: execution.output,
        executionId: execution.id, task: execution.output?.humanTask,
        taskId: execution.output?.humanTask?.id,
      },
    };
  }
  if (execution.status === 'queued' || execution.status === 'running') {
    return { status: 202, body: queuedResponse(execution, execution.queue_name || '', { output: undefined }) };
  }
  return {
    status: execution.status === 'success' ? 200 : 500,
    body: {
      ok: execution.status === 'success',
      output: execution.output,
      executionId: execution.id,
      status: execution.status,
      ...(execution.status === 'error' ? { error: execution.error } : {}),
    },
  };
}

// ---------- self-hosted runner API helpers ----------

const RUNNER_KEY_SCOPES = [
  'workflow:*', 'queue:*', '*:read',
  // POST-based read routes (scopeAllows treats non-GET as write unless the
  // exact action verb is present): document queries, vector search, LLM calls.
  'base:query', 'base:vector-search', 'inference:*',
];

/** System compute keys never carry `*` or tenant data-plane scopes. They only
 *  need the runner protocol, the platform queue, and the inference lane. */
const PLATFORM_RUNNER_KEY_SCOPES = [
  'workflow:*',
  'queue:consume', 'queue:ack', 'queue:nack', 'queue:heartbeat',
  'inference:*',
];

const LOCAL_INFERENCE_TYPES = ['embeddings', 'chat', 'decision', 'route'] as const;
type LocalInferenceType = typeof LOCAL_INFERENCE_TYPES[number];

/** Owner-managed local inference configuration. The runner runtime is
 *  self-contained (`python3 /app/local-inference/worker.py` over JSONL); the
 *  legacy INFERENCE_RUNNER_URL path is not accepted for platform runners. */
function normalizeInferenceConfig(input: any): { value?: Record<string, any>; error?: string } {
  if (input === undefined || input === null) {
    return {
      value: {
        mode: 'local',
        capabilities: ['embeddings', 'decision', 'route'],
        models: { embeddings: 'sentence-transformers/all-MiniLM-L6-v2' },
        limits: { threads: 0, maxBatch: 8, maxTokens: 512, maxRssMb: 4096, timeoutMs: 120000 },
      },
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'inference must be an object' };
  const mode = String(input.mode || 'local').toLowerCase();
  if (mode !== 'local') {
    return { error: 'platform runners use self-contained local inference (mode=local); INFERENCE_RUNNER_URL is not supported' };
  }
  const rawCaps = input.capabilities === undefined ? ['embeddings', 'decision', 'route'] : input.capabilities;
  if (!Array.isArray(rawCaps) || !rawCaps.length) return { error: 'inference.capabilities must be a non-empty array' };
  const capabilities: LocalInferenceType[] = [];
  for (const raw of rawCaps) {
    const type = String(raw || '').toLowerCase() as LocalInferenceType;
    if (!LOCAL_INFERENCE_TYPES.includes(type)) {
      return { error: `inference.capabilities may only contain ${LOCAL_INFERENCE_TYPES.join('|')}` };
    }
    if (!capabilities.includes(type)) capabilities.push(type);
  }
  const modelsIn = input.models && typeof input.models === 'object' && !Array.isArray(input.models) ? input.models : {};
  const models: Record<string, string> = {};
  for (const [key, raw] of Object.entries(modelsIn)) {
    if (!LOCAL_INFERENCE_TYPES.includes(key as LocalInferenceType)) return { error: `inference.models.${key} is not a known capability` };
    const value = String(raw || '').trim();
    if (value.length > 160 || /[\r\n]/.test(value)) return { error: `inference.models.${key} must be ≤160 printable chars` };
    if (value) models[key] = value;
  }
  const limitsIn = input.limits && typeof input.limits === 'object' && !Array.isArray(input.limits) ? input.limits : {};
  const intLimit = (name: string, fallback: number, min: number, max: number): number | null => {
    const raw = limitsIn[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
  };
  const threads = intLimit('threads', 0, 0, 64);
  const maxBatch = intLimit('maxBatch', 8, 1, 64);
  const maxTokens = intLimit('maxTokens', 512, 1, 8192);
  const maxRssMb = intLimit('maxRssMb', 4096, 0, 32768);
  const timeoutMs = intLimit('timeoutMs', 120000, 1000, 300000);
  if ([threads, maxBatch, maxTokens, maxRssMb, timeoutMs].some((v) => v === null)) {
    return { error: 'inference.limits: threads 0..64, maxBatch 1..64, maxTokens 1..8192, maxRssMb 128..32768, timeoutMs 1000..300000' };
  }
  return {
    value: {
      mode: 'local',
      capabilities,
      models,
      limits: { threads, maxBatch, maxTokens, maxRssMb, timeoutMs },
    },
  };
}

const DEFAULT_WORKFLOW_RESOURCES = { cpu: 0.5, memoryMb: 128 };
const DEFAULT_INFERENCE_RESOURCES = { cpu: 1, memoryMb: 256 };
const RESOURCE_HISTORY_MAX = 120;

/** Validate an owner/workflow resource request. Unknown fields are rejected so
 *  the persisted admission shape stays small and predictable. */
function normalizeResourceRequirements(input: any, defaults: { cpu: number; memoryMb: number }): {
  value?: { cpu: number; memoryMb: number };
  error?: string;
} {
  if (input === undefined || input === null) return { value: { ...defaults } };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'resources must be an object' };
  for (const key of Object.keys(input)) {
    if (key !== 'cpu' && key !== 'memoryMb') return { error: 'resources may only contain cpu and memoryMb' };
  }
  const cpuRaw = input.cpu === undefined ? defaults.cpu : Number(input.cpu);
  const memRaw = input.memoryMb === undefined ? defaults.memoryMb : Number(input.memoryMb);
  if (!Number.isFinite(cpuRaw) || cpuRaw < 0.05 || cpuRaw > 64) return { error: 'resources.cpu must be 0.05..64' };
  if (!Number.isInteger(memRaw) || memRaw < 32 || memRaw > 262144) return { error: 'resources.memoryMb must be an integer 32..262144' };
  return { value: { cpu: Math.round(cpuRaw * 100) / 100, memoryMb: memRaw } };
}

function storedResourceRequirements(value: any, defaults: { cpu: number; memoryMb: number }): { cpu: number; memoryMb: number } {
  const normalized = normalizeResourceRequirements(value, defaults);
  return normalized.value || { ...defaults };
}

/** Platform admission freshness bound: three default heartbeats, never less
 *  than the historic 45 s. A connector that heartbeats less often gets a bound
 *  proportional to its declared interval instead of being silently unusable. */
function runnerHeartbeatMaxAgeMs(metadata: any): number {
  const raw = Number(metadata?.heartbeatIntervalSeconds);
  const interval = Number.isFinite(raw) && raw >= 5 && raw <= 300 ? Math.floor(raw) : 15;
  return Math.max(45_000, interval * 3000);
}

/** Sanitize the runner-reported sample. Preserve observation time so a cached
 *  sample cannot become fresh merely by repeating a heartbeat. Bound future
 *  clock skew and derive available/percent from the numeric measurements. */
function sanitizeRunnerResourceSample(input: any): any | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const observedRaw = input.observedAt === undefined || input.observedAt === null
    ? input.sampledAt
    : input.observedAt;
  const observedAt = typeof observedRaw === 'number' ? observedRaw : Date.parse(String(observedRaw || ''));
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 5000) return null;
  const cpuIn = input.cpu && typeof input.cpu === 'object' ? input.cpu : {};
  const memIn = input.memory && typeof input.memory === 'object' ? input.memory : {};
  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const limitCores = num(cpuIn.limitCores);
  const usedCores = num(cpuIn.usedCores);
  const providedCores = num(cpuIn.availableCores);
  const limitMb = num(memIn.limitMb);
  const usedMb = num(memIn.usedMb);
  const providedMb = num(memIn.availableMb);
  if (limitCores === null || usedCores === null || limitMb === null || usedMb === null) return null;
  const coresLimit = Math.min(Math.max(limitCores, 0), 4096);
  const coresUsed = Math.min(Math.max(usedCores, 0), coresLimit);
  const derivedCores = Math.max(0, coresLimit - coresUsed);
  const memLimit = Math.min(Math.max(Math.round(limitMb), 0), 10_000_000);
  const memUsed = Math.min(Math.max(Math.round(usedMb), 0), memLimit);
  const derivedMb = Math.max(0, memLimit - memUsed);
  // Preserve host/cgroup clamps reported by the sampler. In particular the
  // first CPU sample deliberately reports availableCores=0 until a real
  // counter delta exists; deriving full free would make startup look idle.
  const availableCores = Math.min(derivedCores, providedCores === null ? derivedCores : providedCores);
  const availableMb = Math.min(derivedMb, providedMb === null ? derivedMb : providedMb);
  const sourceRaw = typeof input.source === 'string' ? input.source : '';
  const source = ['cgroup-v2', 'cgroup-v1', 'cgroup-mixed', 'host'].includes(sourceRaw) ? sourceRaw : 'unknown';
  return {
    sampledAt: new Date(observedAt).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    receivedAt: new Date().toISOString(),
    source,
    cpu: {
      limitCores: Math.round(coresLimit * 100) / 100,
      usedCores: Math.round(coresUsed * 100) / 100,
      percent: coresLimit > 0 ? Math.round((coresUsed / coresLimit) * 1000) / 10 : 0,
      availableCores: Math.round(Math.max(0, availableCores) * 100) / 100,
    },
    memory: {
      limitMb: memLimit,
      usedMb: memUsed,
      availableMb: Math.max(0, Math.round(availableMb)),
    },
  };
}

/** Advisory pre-claim admission for platform runners. The scheduler agent's
 *  store claim is the atomic authority; this returns the user-visible 409
 *  before a mixed/telemetry-less runner can claim. */
function resourceAdmissionMode(): 'off' | 'enforce' {
  return String(process.env.WORKFLOW_RUNNER_RESOURCE_ADMISSION || 'off').toLowerCase() === 'enforce'
    ? 'enforce'
    : 'off';
}

function runnerResourceAdmission(
  runner: StoredWorkflowRunner,
  instanceResources: any,
  required: { cpu: number; memoryMb: number },
  maxAgeMs = 45_000,
): any | null {
  if (runner.scope !== 'platform') return null;
  // Rollout gate: the legacy final image has no telemetry. Keep admission off
  // until the telemetry-capable runner image is live, then set
  // WORKFLOW_RUNNER_RESOURCE_ADMISSION=enforce.
  if (resourceAdmissionMode() !== 'enforce') return null;
  // Use the requesting connector instance's latest sample, never another
  // replica's last heartbeat. The store's per-instance atomic admission is
  // still authoritative.
  const resources = instanceResources;
  const observedRaw = resources?.observedAt ?? resources?.sampledAt;
  const observedAt = observedRaw ? new Date(String(observedRaw)).getTime() : NaN;
  const now = Date.now();
  if (!resources || !Number.isFinite(observedAt) || now - observedAt > maxAgeMs || observedAt - now > 5000) {
    return {
      error: 'runner_resources_unavailable',
      message: 'the selected runner has no fresh CPU/RAM telemetry; retry after its next heartbeat',
      required,
      sampledAt: resources?.sampledAt || null,
    };
  }
  const source = String(resources?.source || '');
  if (!['cgroup-v2', 'cgroup-v1', 'cgroup-mixed', 'host'].includes(source)) {
    return {
      error: 'runner_resources_unavailable',
      message: 'the selected runner reported telemetry without a measured source; retry after its next heartbeat',
      required,
      sampledAt: resources?.sampledAt || null,
    };
  }
  const availableCores = Number(resources?.cpu?.availableCores);
  const availableMb = Number(resources?.memory?.availableMb);
  if (!Number.isFinite(availableCores) || !Number.isFinite(availableMb)) {
    return {
      error: 'runner_resources_unavailable',
      message: 'the selected runner reported an invalid resource sample',
      required,
    };
  }
  if (availableCores + 1e-9 < required.cpu || availableMb < required.memoryMb) {
    return {
      error: 'runner_capacity_unavailable',
      message: 'the selected runner does not have enough free CPU/RAM for this job',
      required,
      available: { cpu: availableCores, memoryMb: availableMb },
    };
  }
  return null;
}

/** Kind-aware cgroup defaults: workflow-only 2 CPU/1024 MiB; inference/
 *  hybrid 2 CPU/6144 MiB. Explicit positive owner limits are preserved. */
function applyInferenceResourceDefaults(config: Record<string, any> | null | undefined, kind: string, rawInput: any): void {
  if (!config || typeof config !== 'object') return;
  const rawLimits = rawInput && typeof rawInput === 'object' && rawInput.limits && typeof rawInput.limits === 'object'
    ? rawInput.limits
    : {};
  const explicitMemory = Number(rawLimits.maxRssMb) > 0;
  const explicitThreads = Number(rawLimits.threads) > 0;
  if (!config.limits || typeof config.limits !== 'object') config.limits = {};
  if (!explicitMemory) config.limits.maxRssMb = kind === 'workflow' ? 1024 : 6144;
  if (!explicitThreads) config.limits.threads = 0;
}

function runnerPublicUrl(): string {
  return String(process.env.SYNAPSEONE_PUBLIC_URL || 'https://api.synapseone.space').replace(/\/$/, '');
}

function runnerImage(): string {
  return String(process.env.WORKFLOW_RUNNER_IMAGE || 'ghcr.io/vku-open-source-2026/synapseone-workflow-runner:latest');
}

function shQuote(v: string): string {
  return /^[A-Za-z0-9._~:/@%+-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Owner metadata may carry free-form runtime notes, but the typed
 *  `dockerResources` field is the only way to change cgroup controls. Strip it
 *  from a generic metadata body so a request cannot bypass validation. */
function stripDockerResourcesMetadata(metadata: any): Record<string, any> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const copy = { ...metadata };
  delete copy.dockerResources;
  return copy;
}

/** Copy-paste docker run command for a runner. The API key is supplied by the
 *  caller and is never persisted by workflow-service. Owner-managed
 *  `metadata.dockerResources` drives the cgroup flags (`--cpus`,
 *  `--memory`/`--memory-swap`) and the workflow lane concurrency; disabling a
 *  limit omits its flags entirely. Runners without an owner config keep the
 *  legacy shape (platform defaults, or no flags for tenant runners). */
export function runnerCommand(runner: StoredWorkflowRunner, apiKey?: string | null): string {
  const raw = apiKey && apiKey.trim() && !/[\r\n\u0000]/.test(apiKey) ? apiKey.trim().slice(0, 512) : '';
  const key = raw || '<YOUR_SYNAPSEONE_API_KEY>';
  const container = `synapseone-runner-${runner.id.slice(0, 8)}`;
  // Resolved + validated exactly once: only numbers/booleans can reach the
  // shell string, even if the persisted metadata was tampered with.
  const dockerResources = effectiveDockerResources(runner);
  const resourceFlags = dockerResourceFlags(dockerResources);
  const lines = [
    `docker run -d ${resourceFlags.join(' ')}${resourceFlags.length ? ' ' : ''}--name ${shQuote(container)} --restart unless-stopped \\`,
    `  -e SYNAPSEONE_URL=${shQuote(runnerPublicUrl())} \\`,
    `  -e SYNAPSEONE_API_KEY=${shQuote(key)} \\`,
    `  -e WORKFLOW_RUNNER_ID=${shQuote(runner.id)} \\`,
    `  -e WORKFLOW_RUNNER_KIND=${shQuote(runner.kind)} \\`,
  ];
  if (runner.kind !== 'inference') {
    lines.push(`  -e WORKFLOW_RUNNER_QUEUE=${shQuote(runner.queue)} \\`);
    lines.push(`  -e WORKFLOW_RUNNER_MODE=${shQuote(runner.mode)} \\`);
  }
  if (runner.kind !== 'workflow') {
    lines.push(`  -e WORKFLOW_RUNNER_INFERENCE_QUEUE=${shQuote(runner.inference_queue || DEFAULT_INFERENCE_QUEUE)} \\`);
    if (runner.scope === 'platform') {
      const inference = runner.metadata?.inference && typeof runner.metadata.inference === 'object'
        ? runner.metadata.inference
        : {};
      const capabilities = Array.isArray(inference.capabilities) && inference.capabilities.length
        ? inference.capabilities
        : ['embeddings', 'decision', 'route'];
      const models = inference.models && typeof inference.models === 'object' ? inference.models : {};
      const limits = inference.limits && typeof inference.limits === 'object' ? inference.limits : {};
      lines.push('  -e INFERENCE_RUNNER_MODE=local \\');
      lines.push('  -e LOCAL_INFERENCE_WORKER=/app/local-inference/worker.py \\');
      lines.push(`  -e LOCAL_INFERENCE_CAPABILITIES=${shQuote(capabilities.join(','))} \\`);
      for (const [key, value] of Object.entries(models)) {
        if (!value || !/^(embeddings|chat|decision|route)$/.test(key)) continue;
        lines.push(`  -e LOCAL_INFERENCE_MODEL_${key.toUpperCase()}=${shQuote(String(value))} \\`);
      }
      const limitEnv: Array<[string, any]> = [
        ['LOCAL_INFERENCE_THREADS', limits.threads],
        ['LOCAL_INFERENCE_MAX_BATCH', limits.maxBatch],
        ['LOCAL_INFERENCE_MAX_TOKENS', limits.maxTokens],
        ['LOCAL_INFERENCE_MAX_RSS_MB', limits.maxRssMb],
        ['LOCAL_INFERENCE_TIMEOUT_MS', limits.timeoutMs],
      ];
      for (const [name, value] of limitEnv) {
        if (value === undefined || value === null || value === '') continue;
        lines.push(`  -e ${name}=${shQuote(String(value))} \\`);
      }
    } else {
      lines.push('  -e INFERENCE_RUNNER_URL=\'<YOUR_OPENAI_COMPATIBLE_BASE_URL>\' \\');
    }
  }
  // Workflow lane concurrency is owner-selectable (1..32); platform runners
  // default to the legacy 8. The server's atomic CPU/RAM admission still
  // decides actual parallel work. The local Python inference worker is
  // serial, so its lane stays at one job.
  lines.push(`  -e WORKFLOW_RUNNER_CONCURRENCY=${dockerResourceConcurrency(dockerResources)} \\`);
  if (runner.scope === 'platform' && runner.kind !== 'workflow') {
    lines.push('  -e WORKFLOW_RUNNER_INFERENCE_CONCURRENCY=1 \\');
  }
  lines.push(`  -e WORKFLOW_RUNNER_HEARTBEAT_SECONDS=${runnerHeartbeatSeconds()} \\`);
  lines.push(`  ${runnerImage()}`);
  return lines.join('\n');
}

function runnerHeartbeatSeconds(): number {
  const n = Number(process.env.WORKFLOW_RUNNER_HEARTBEAT_SECONDS || 15);
  return Math.min(Math.max(Number.isFinite(n) ? n : 15, 5), 300);
}

function runnerLongPollSeconds(): number {
  const n = Number(process.env.WORKFLOW_RUNNER_LONGPOLL_SECONDS || 20);
  return Math.min(Math.max(Number.isFinite(n) ? n : 20, 0), 20);
}

function runnerStaleAfterSeconds(): number {
  const n = Number(process.env.WORKFLOW_RUNNER_STALE_SECONDS || 60);
  return Math.min(Math.max(Number.isFinite(n) ? n : 60, 30), 3600);
}

function runnerMaxConcurrency(): number {
  const n = Number(process.env.WORKFLOW_RUNNER_MAX_CONCURRENCY || 32);
  return Math.min(Math.max(Number.isFinite(n) ? n : 32, 1), 64);
}

function runnerOptions(): any {
  return {
    publicUrl: runnerPublicUrl(),
    image: runnerImage(),
    modes: ['custom', 'hybrid'],
    scopes: {
      tenant: 'Account-owned runner managed inside its tenant.',
      platform: 'Owner-managed system compute pool shared by every tenant (platform owners only).',
    },
    queues: {
      custom: DEFAULT_CUSTOM_QUEUE,
      shared: DEFAULT_SHARED_QUEUE,
      platform: process.env.WORKFLOW_QUEUE_PLATFORM || 'synapseone-wf-platform',
      system: DEFAULT_SYSTEM_QUEUE,
      systemInference: DEFAULT_SYSTEM_INFERENCE_QUEUE,
      inference: DEFAULT_INFERENCE_QUEUE,
    },
    kinds: ['workflow', 'inference', 'hybrid'],
    localInference: {
      mode: 'local',
      worker: '/app/local-inference/worker.py',
      capabilities: LOCAL_INFERENCE_TYPES,
      defaults: {
        capabilities: ['embeddings', 'decision', 'route'],
        models: { embeddings: 'sentence-transformers/all-MiniLM-L6-v2' },
        limits: { threads: 0, maxBatch: 8, maxTokens: 512, maxRssMb: 4096, timeoutMs: 120000 },
      },
    },
    engineCapabilities: {
      httpCredentialAllowedOrigins: HTTP_CREDENTIAL_DESTINATION_PROTECTION === 1,
      httpCredentialDestinationProtection: HTTP_CREDENTIAL_DESTINATION_PROTECTION,
      httpIncludeInput: true,
    },
    heartbeatIntervalSeconds: runnerHeartbeatSeconds(),
    longPollSeconds: runnerLongPollSeconds(),
    staleAfterSeconds: runnerStaleAfterSeconds(),
    maxConcurrency: runnerMaxConcurrency(),
    dockerResources: dockerResourceOptions(),
    visibilityTimeoutSeconds: queueVisibilitySeconds(),
    platformWorker: {
      enabled: String(process.env.WORKFLOW_WORKER_ENABLED || 'true').toLowerCase() !== 'false',
      queue: process.env.WORKFLOW_QUEUE_PLATFORM || 'synapseone-wf-platform',
      concurrency: Math.min(Math.max(Number(process.env.WORKFLOW_WORKER_CONCURRENCY || 4) || 4, 1), 32),
      pollMs: Math.min(Math.max(Number(process.env.WORKFLOW_WORKER_POLL_MS || 500) || 500, 100), 10000),
    },
  };
}

// ---------- owner-scoped (platform) runner helpers ----------

function iamServiceUrl(): string {
  return String(process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
}

function serviceInternalSecret(): string {
  return process.env.SYNAPSEONE_INTERNAL_SECRET || '';
}

/** A platform runner may only be managed by an active platform administrator
 *  with the `owner` role. IAM remains the authority: we forward the platform
 *  token to /v1/platform/me (which re-checks the platform-admin row, org,
 *  MFA and revocation) instead of trusting JWT claims alone. */
async function requirePlatformOwner(
  req: express.Request,
  res: express.Response,
): Promise<{ sub: string; role: 'owner'; orgId: string | null } | null> {
  const raw = req.headers.authorization;
  const auth = Array.isArray(raw) ? (raw[0] || '') : String(raw || '');
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'platform administrator Bearer token required' });
    return null;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const headers: Record<string, string> = { Authorization: auth };
    const secret = serviceInternalSecret();
    if (secret) headers['x-synapseone-internal'] = secret;
    const r = await fetch(`${iamServiceUrl()}/v1/platform/me`, { headers, signal: ctl.signal });
    if (r.status === 404) {
      res.status(404).json({ error: 'not_found', message: 'platform administration is disabled' });
      return null;
    }
    if (!r.ok) {
      let error = 'platform_admin_required';
      try { const body: any = await r.json(); if (body?.error) error = String(body.error); } catch { /* default */ }
      res.status(403).json({ error, message: 'an active platform administrator session is required' });
      return null;
    }
    const me: any = await r.json();
    if (me?.role !== 'owner') {
      res.status(403).json({ error: 'platform_role_required', message: 'platform owner role required' });
      return null;
    }
    return {
      sub: String(me?.user?.id || ''),
      role: 'owner',
      orgId: me?.user?.org_id ? String(me.user.org_id) : null,
    };
  } catch {
    res.status(503).json({ error: 'iam_unavailable', message: 'cannot verify the platform administrator session' });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mintPlatformRunnerKey(args: {
  runnerId: string;
  name: string;
  scopes: string[];
  createdBy?: string | null;
}): Promise<{ id: string; value: string; prefix: string; scopes: string[] }> {
  const secret = serviceInternalSecret();
  if (!secret) throw httpError(503, 'internal_secret_required', 'SYNAPSEONE_INTERNAL_SECRET is required to mint platform runner keys');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${iamServiceUrl()}/internal/platform-runners/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapseone-internal': secret },
      body: JSON.stringify({
        runnerId: args.runnerId,
        name: args.name,
        scopes: args.scopes,
        createdBy: args.createdBy || undefined,
      }),
      signal: ctl.signal,
    });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!r.ok || !body?.apiKey) {
      throw httpError(503, 'runner_key_unavailable', `cannot mint a platform runner key (${r.status})`);
    }
    return { id: String(body.id), value: String(body.apiKey), prefix: String(body.prefix || ''), scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : args.scopes };
  } catch (e: any) {
    if (e?.status) throw e;
    throw httpError(503, 'runner_key_unavailable', `cannot reach IAM to mint a platform runner key: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function revokePlatformRunnerKeyViaIam(keyId: string | null | undefined): Promise<void> {
  if (!keyId) return;
  const secret = serviceInternalSecret();
  if (!secret) throw httpError(503, 'internal_secret_required', 'SYNAPSEONE_INTERNAL_SECRET is required to revoke platform runner keys');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${iamServiceUrl()}/internal/platform-runners/keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
      headers: { 'x-synapseone-internal': secret },
      signal: ctl.signal,
    });
    if (!r.ok) throw httpError(503, 'runner_key_unavailable', `cannot revoke the platform runner key (${r.status})`);
  } catch (e: any) {
    if (e?.status) throw e;
    throw httpError(503, 'runner_key_unavailable', `cannot reach IAM to revoke the platform runner key: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function revokeAllPlatformRunnerKeysViaIam(runnerId: string): Promise<void> {
  const secret = serviceInternalSecret();
  if (!secret) throw httpError(503, 'internal_secret_required', 'SYNAPSEONE_INTERNAL_SECRET is required to revoke platform runner keys');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${iamServiceUrl()}/internal/platform-runners/keys/runner/${encodeURIComponent(runnerId)}`, {
      method: 'DELETE',
      headers: { 'x-synapseone-internal': secret },
      signal: ctl.signal,
    });
    if (!r.ok) throw httpError(503, 'runner_key_unavailable', `cannot revoke platform runner keys (${r.status})`);
  } catch (e: any) {
    if (e?.status) throw e;
    throw httpError(503, 'runner_key_unavailable', `cannot reach IAM to revoke platform runner keys: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Never mint a data grant that outlives the persisted runner lease. */
function delegationTtlForLease(leaseExpiresAt: string | null | undefined): number {
  if (!leaseExpiresAt) return 1;
  const remaining = Math.floor((new Date(leaseExpiresAt).getTime() - Date.now()) / 1000);
  return Math.min(300, Math.max(1, remaining));
}

/** Restrict graph-derived scopes to the caller's own credential authority.
 *  `*` is never minted; an empty result means the execution grant cannot call
 *  any data plane (fail closed). */
function delegationScopesForPrincipal(principal: Principal, graphScopes: string[]): string[] {
  const held = Array.isArray(principal.scopes) ? principal.scopes : [];
  if (!held.length || held.includes('*')) return graphScopes;
  const allows = (scope: string): boolean => {
    const [family, action] = scope.split(':');
    if (!family || !action) return false;
    return held.some((raw) => {
      if (raw === '*' || raw === `${family}:*` || raw === `*:${action}`) return true;
      if (action === 'read' && raw === '*:read') return true;
      if (action === 'write' && raw === '*:write') return true;
      return raw === scope;
    });
  };
  return graphScopes.filter(allows);
}

/** Mint the per-execution delegated user token returned to a platform runner.
 *  The runner itself never stores a user token: it gets one short-lived token
 *  for exactly the execution it claimed. */
async function mintExecutionDelegation(args: {
  runnerId: string;
  instanceId: string;
  executionId: string;
  principal: Principal;
  scopes: string[];
  ttlSeconds?: number;
}): Promise<{ token: string; expiresIn: number; scopes: string[]; jti: string | null } | null> {
  if (!args.principal?.sub) return null;
  if (!Array.isArray(args.scopes) || args.scopes.length === 0) return null;
  const secret = serviceInternalSecret();
  if (!secret) throw httpError(503, 'internal_secret_required', 'SYNAPSEONE_INTERNAL_SECRET is required for platform runner delegation');
  const scopes = args.scopes;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${iamServiceUrl()}/internal/platform-runners/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapseone-internal': secret },
      body: JSON.stringify({
        userId: args.principal.sub,
        runnerId: args.runnerId,
        instanceId: args.instanceId,
        executionId: args.executionId,
        ...(args.principal.account ? { accountId: args.principal.account } : {}),
        scopes,
        ttlSeconds: Math.min(Math.max(Number(args.ttlSeconds) || 300, 60), 900),
      }),
      signal: ctl.signal,
    });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!r.ok || !body?.accessToken) {
      const detail = body && typeof body === 'object' ? (body.error || body.message || '') : '';
      throw httpError(503, 'delegation_unavailable', `cannot mint execution delegation${detail ? ` (${detail})` : ''}`);
    }
    return {
      token: String(body.accessToken),
      expiresIn: Number(body.expiresIn) || 300,
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : scopes,
      jti: typeof body.jti === 'string' ? body.jti : null,
    };
  } catch (e: any) {
    if (e?.status) throw e;
    throw httpError(503, 'delegation_unavailable', `cannot reach IAM for execution delegation: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function revokeExecutionDelegationsViaIam(args: { executionId?: string; runnerId?: string }): Promise<void> {
  if (!args.executionId && !args.runnerId) return;
  const secret = serviceInternalSecret();
  if (!secret) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    await fetch(`${iamServiceUrl()}/internal/platform-runners/delegations/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapseone-internal': secret },
      body: JSON.stringify(args),
      signal: ctl.signal,
    });
  } catch { /* revocation is best-effort; tokens are short-lived */ }
  finally { clearTimeout(timer); }
}

function runnerInstancePublic(i: StoredRunnerInstance): any {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(i.last_seen_at).getTime()) / 1000));
  const fresh = i.status === 'connected' && ageSeconds < runnerStaleAfterSeconds();
  return {
    id: i.id,
    hostname: i.hostname,
    version: i.version,
    queue: i.queue,
    concurrency: i.concurrency,
    status: fresh ? 'connected' : 'offline',
    lastSeenAt: i.last_seen_at,
    ageSeconds,
    startedAt: i.started_at,
    metadata: i.metadata,
  };
}

function runnerStatus(r: StoredWorkflowRunner, instances: StoredRunnerInstance[]): { status: string; connected: boolean; connectedInstances: number } {
  if (r.status === 'disabled') return { status: 'disabled', connected: false, connectedInstances: 0 };
  const shown = instances.map(runnerInstancePublic);
  const connectedInstances = shown.filter((i) => i.status === 'connected').length;
  if (connectedInstances > 0) {
    return { status: connectedInstances < shown.length ? 'degraded' : 'connected', connected: true, connectedInstances };
  }
  return { status: shown.length ? 'offline' : 'waiting', connected: false, connectedInstances: 0 };
}

function toApiRunner(r: StoredWorkflowRunner, instances: StoredRunnerInstance[] = []): any {
  const instancesOut = instances.map(runnerInstancePublic);
  const status = runnerStatus(r, instances);
  const lastSeenAt = instancesOut.length
    ? instancesOut.reduce((max, i) => (i.lastSeenAt > max ? i.lastSeenAt : max), instancesOut[0].lastSeenAt)
    : r.last_seen_at;
  const version = r.version || instancesOut.find((i) => i.version)?.version || null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    scope: r.scope || 'tenant',
    audience: r.audience || 'account',
    mode: r.mode,
    queue: r.queue,
    inferenceQueue: r.inference_queue || null,
    capabilities: r.kind === 'hybrid'
      ? ['workflow', 'inference']
      : r.kind === 'inference' ? ['inference'] : ['workflow'],
    status: status.status,
    connected: status.connected,
    connectedInstances: status.connectedInstances,
    instanceCount: instancesOut.length,
    instances: instancesOut,
    version,
    keyPrefix: r.key_prefix,
    apiKeyId: r.api_key_id,
    lastSeenAt,
    lastError: r.last_error,
    // Effective owner controls (persisted value or legacy defaults) so the
    // Console/monitor can render the current CPU/RAM toggles, sliders and
    // concurrency without guessing. Null only for tenant runners that never
    // configured Docker limits (they run uncapped with concurrency 1).
    dockerResources: effectiveDockerResources(r),
    metadata: r.metadata,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function canAccessInferenceJob(j: StoredInferenceJob, p: Principal | null | undefined): boolean {
  if (!p) return true;
  if (p.account && j.account_id === p.account) return true;
  if (p.org && j.org_id === p.org) return true;
  return false;
}

function toApiInferenceJob(j: StoredInferenceJob, includeRequest = false): any {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    ...(includeRequest ? { request: j.request } : {}),
    result: j.result,
    error: j.error ?? undefined,
    runnerId: j.runner_id ?? undefined,
    instanceId: j.instance_id ?? undefined,
    targetRunnerId: (j as any).target_runner_id ?? undefined,
    resourceRequirements: (j as any).resource_requirements ?? undefined,
    queue: j.queue_name ?? undefined,
    attempt: j.attempt,
    leaseExpiresAt: j.lease_expires_at ?? undefined,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    finishedAt: j.finished_at ?? undefined,
  };
}

function canAccessRunner(r: StoredWorkflowRunner, p: Principal | null | undefined): boolean {
  if (!p) return true;
  // System runner credentials never gain tenant management access. They are
  // handled by loadRunnerForAgent (bootstrap/heartbeat on their own row only).
  if (p.kind === 'platform-runner') return false;
  if (r.scope === 'platform') return false;
  if (p.account && r.account_id === p.account) return true;
  if (p.org && r.org_id === p.org) return true;
  return false;
}

/** A runner agent may read config / heartbeat only its own registration.
 *  Tenant runners keep the existing tenant-scoped access; platform runners must
 *  present the platform-runner key bound to this exact row. */
async function loadRunnerForAgent(req: express.Request, res: express.Response, id?: string): Promise<StoredWorkflowRunner | null> {
  const runnerId = runnerForRequest(req, res, id);
  if (!runnerId) return null;
  const runner = await getRunnerRec(runnerId);
  const principal = principalFromHeaders(req);
  if (!runner) {
    res.status(404).json({ error: 'not_found', message: 'runner not found' });
    return null;
  }
  if (runner.status === 'disabled') {
    res.status(409).json({ error: 'runner_disabled', message: 'runner is disabled by the platform owner' });
    return null;
  }
  if (principal?.kind === 'platform-runner') {
    if (runner.scope !== 'platform' || principal.runnerId !== runner.id) {
      res.status(404).json({ error: 'not_found', message: 'runner not found' });
      return null;
    }
    return runner;
  }
  if (!canAccessRunner(runner, principal)) {
    res.status(404).json({ error: 'not_found', message: 'runner not found' });
    return null;
  }
  return runner;
}

/** Runner mutations are fenced by connector instance + positive attempt. */
function positiveAttempt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function runnerForRequest(req: express.Request, res: express.Response, id?: string, useParams = true): string | null {
  const runnerId = String(id || (useParams ? (req.params as any)?.id : '') || (req.body && (req.body.runnerId || req.body.runner_id)) || req.headers['x-workflow-runner-id'] || '').trim();
  if (!runnerId || runnerId.length > 128 || /[\r\n]/.test(runnerId)) {
    res.status(400).json({ error: 'invalid_runner', message: 'runnerId is required' });
    return null;
  }
  return runnerId;
}

async function loadRunnerForRequest(req: express.Request, res: express.Response, id?: string, useParams = true): Promise<StoredWorkflowRunner | null> {
  const runnerId = runnerForRequest(req, res, id, useParams);
  if (!runnerId) return null;
  const runner = await getRunnerRec(runnerId);
  const principal = principalFromHeaders(req);
  if (!runner || !canAccessRunner(runner, principal)) {
    res.status(404).json({ error: 'not_found', message: 'runner not found' });
    return null;
  }
  return runner;
}


export function createApp(): express.Express {
  if (IS_PROD_WF) {
    if (!process.env.SYNAPSEONE_INTERNAL_SECRET) {
      throw new Error('[workflow] SYNAPSEONE_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[workflow] DATABASE_URL must be set in production (in-memory fallback would split-brain)');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(String(process.env.SYNAPSEONE_CREDENTIAL_KEY || '').trim())) {
      throw new Error('[workflow] SYNAPSEONE_CREDENTIAL_KEY must be a 32-byte hex string in production (credential nodes cannot work without it)');
    }
    if (!String(process.env.SYNAPSEONE_IAM_API_KEY || '').trim()) {
      throw new Error('[workflow] SYNAPSEONE_IAM_API_KEY must be set in production (first-party IAM integration nodes need a service credential)');
    }
    const mode = String(process.env.WORKFLOW_EXECUTION_MODE || 'auto').toLowerCase();
    if (mode !== 'inline' && mode !== 'local' && mode !== 'sync' && !queueBackendConfigured()) {
      throw new Error('[workflow] queue execution requires QUEUE_SERVICE_URL in production (set WORKFLOW_EXECUTION_MODE=inline only for an explicit dev override)');
    }
  }
  const app = express();
  app.disable('x-powered-by');
  // Baseline security headers (no extra dep; API-only service).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if ((process.env.HSTS_ENABLED || 'false') === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(cors((() => {
    const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      if (!IS_PROD_WF) console.warn('[workflow][security] CORS_ORIGIN not set — allowing all origins (dev default).');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Echo/propagate x-request-id (see iam-service for rationale).
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({
    limit: '2mb',
    // Keep the raw body for HMAC webhook verification (P0-5).
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));
  // Data-plane mutation audit (#32): actor/tenant/action/result per write.
  app.use(auditMiddleware('workflow'));

  // ---- inbound webhook hardening (P0-5): per-workflow auth, durable
  // rate limit + idempotency (persisted in Postgres so every replica shares
  // one budget; in-memory fallback without DATABASE_URL).
  // Node params contract (validated at save time):
  //   auth: { mode: none|secret-header|hmac-sha256|jwt, header?, credentialId? }
  //   rateLimit: { rpm } (default 600, 1..60000) · idempotency: { header, ttlSeconds }
  function webhookNodeFor(wf: StoredWorkflow, clean: string): any | null {
    for (const n of wf.nodes || []) {
      if (!isWebhookType((n as any)?.type)) continue;
      if (String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '') === clean) return n;
    }
    return null;
  }
  function webhookAuthOf(node: any): { mode: string; header: string; credentialId?: string } {
    const a = (node as any)?.parameters?.auth;
    const mode = a && typeof a === 'object' && typeof a.mode === 'string' ? a.mode : 'none';
    const defaults: Record<string, string> = { 'secret-header': 'x-webhook-secret', 'hmac-sha256': 'x-signature', jwt: 'authorization' };
    const header = a && typeof a?.header === 'string' && a.header ? String(a.header).toLowerCase().slice(0, 128) : (defaults[mode] || '');
    const credentialId = a && typeof a?.credentialId === 'string' ? a.credentialId : undefined;
    return { mode, header, credentialId };
  }
  function verifyJwtHS256(token: string, secret: string, node: any): boolean {
    try {
      const t = token.startsWith('Bearer ') ? token.slice(7) : token;
      const parts = t.split('.');
      if (parts.length !== 3) return false;
      const crypto = require('crypto');
      const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url' as any);
      const a = Buffer.from(expected);
      const b = Buffer.from(parts[2]);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url' as any).toString('utf8'));
      const nowS = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === 'number' && nowS > payload.exp) return false;
      if (typeof payload.nbf === 'number' && nowS < payload.nbf) return false;
      const auth = (node as any)?.parameters?.auth || {};
      if (typeof auth.issuer === 'string' && auth.issuer && payload.iss !== auth.issuer) return false;
      if (typeof auth.audience === 'string' && auth.audience && payload.aud !== auth.audience) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Public inbound webhooks: ANY /webhook/:path triggers the active
  // workflow whose webhook node declares that path. No internal secret —
  // external systems call this (like any webhook). Per-workflow auth,
  // rate limiting and idempotency are enforced here (P0-5); the payload
  // is capped at 200KB.
  const handleInboundWebhook = async (req: express.Request, res: express.Response) => {
    let webhookWfId: string | null = null;
    let deliveryKey: string | null = null;
    try {
      const rawPath = String((req.params as any)?.path || req.path.replace(/^\/webhook\/?/, ''));
      const clean = rawPath.replace(/^\/+|\/+$/g, '').split('?')[0].slice(0, 128);
      if (!clean || /[\r\n]/.test(clean)) {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      const wf = await findActiveWebhookWorkflow(clean);
      webhookWfId = wf?.id || null;
      if (!wf) {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      if (wf.org_id && await orgSuspended(wf.org_id)) {
        recordWebhookReject('org_suspended');
        return res.status(403).json({ error: 'org_suspended', message: 'this organization is suspended' });
      }
      // An owner-only graph cannot be made callable by an anonymous webhook,
      // even if its trigger was accidentally imported with auth.mode=none.
      if (wf.settings?.access !== undefined && wf.settings.access?.mode !== 'tenant') {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      const node = webhookNodeFor(wf, clean);
      const params = (node as any)?.parameters || {};
      const declaredMethod = String(params.httpMethod || 'POST').toUpperCase();
      if (req.method !== declaredMethod && !(declaredMethod === 'GET' && req.method === 'HEAD')) {
        recordWebhookReject('method_not_allowed');
        res.setHeader('Allow', declaredMethod);
        return res.status(405).json({ error: 'method_not_allowed', message: `this webhook accepts ${declaredMethod}` });
      }
      // Auth must run before the rate bucket is charged; otherwise an
      // unauthenticated caller can exhaust a tenant's legitimate budget.
      const auth = webhookAuthOf(node);
      if (auth.mode !== 'none') {
        let secret: string | null = null;
        if (auth.credentialId) {
          try {
            const rec = await getCredentialRec(auth.credentialId);
            if (rec) secret = decryptSecret(rec.secret_enc);
          } catch { /* fall through to misconfigured */ }
        }
        if (!secret) {
          recordWebhookReject('misconfigured');
          return res.status(500).json({ error: 'misconfigured', message: 'webhook auth misconfigured (unknown credential)' });
        }
        const got = String(req.headers[auth.header] || '');
        let ok = false;
        if (auth.mode === 'secret-header') {
          const a = Buffer.from(got);
          const b = Buffer.from(secret);
          ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
        } else if (auth.mode === 'hmac-sha256') {
          const crypto = require('crypto');
          const raw = ((req as any).rawBody as Buffer) || Buffer.from(JSON.stringify((req as any).body || ''));
          const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
          const norm = got.startsWith('sha256=') ? got.slice(7) : got;
          const a = Buffer.from(norm);
          const b = Buffer.from(expected);
          ok = norm.length > 0 && a.length === b.length && timingSafeEqual(a, b);
        } else if (auth.mode === 'jwt') {
          ok = verifyJwtHS256(got, secret, node);
        } else {
          recordWebhookReject('misconfigured');
          return res.status(500).json({ error: 'misconfigured', message: `unknown webhook auth mode '${auth.mode}'` });
        }
        if (!ok) {
          recordWebhookReject('unauthorized');
          return res.status(401).json({ error: 'unauthorized', message: 'invalid webhook credentials' });
        }
      }
      // Rate limit (fixed one-minute window per workflow, durable across
      // replicas via Postgres; in-memory fallback without DATABASE_URL).
      const rpm = Math.min(Math.max(Number(params?.rateLimit?.rpm) || 600, 1), 60000);
      const nowMs = Date.now();
      const bucket = await hitWebhookRate(wf.id);
      if (bucket.count > rpm) {
        recordWebhookReject('rate_limited');
        res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetMs - nowMs) / 1000)));
        return res.status(429).json({ error: 'rate_limited', message: `webhook exceeds ${rpm}/min` });
      }
      let input: any = {};
      if (req.method === 'GET' || req.method === 'HEAD') {
        input = { query: req.query || {} };
      } else {
        try {
          if (Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8') > 200 * 1024) {
            return res.status(413).json({ error: 'payload_too_large', message: 'webhook body ≤200KB' });
          }
        } catch { return res.status(400).json({ error: 'invalid_body' }); }
        input = (req.body && typeof req.body === 'object' ? req.body : { value: req.body }) || {};
        if (Object.keys(req.query || {}).length) (input as any)._query = req.query;
      }
      const startedAt = new Date().toISOString();
      const runPrincipal = workflowRunPrincipal(wf);
      const runnerMode = runnerModeForSettings(wf.settings);
      const waitForResult = req.query.wait === '1' || req.query.wait === 'true';
      if (!queueTransportEnabled() && (runnerMode === 'custom' || runnerMode === 'hybrid' || runnerMode === 'system')) {
        return res.status(503).json({ error: 'queue_unavailable', message: `workflow requires a ${runnerMode} runner queue but SynapseQueue is not configured` });
      }
      // Claim the idempotency receipt only after the request is valid and the
      // transport is available; release it if dispatch fails.
      const idem = (params as any)?.idempotency;
      if (idem && typeof idem === 'object' && typeof idem.header === 'string' && idem.header) {
        const keyVal = String(req.headers[String(idem.header).toLowerCase()] || '');
        if (keyVal) {
          deliveryKey = keyVal.slice(0, 256);
          const ttlMs = Math.min(Math.max(Number(idem.ttlSeconds) || 3600, 60), 86400) * 1000;
          const first = await claimWebhookDelivery(wf.id, deliveryKey, ttlMs);
          if (!first) {
            recordWebhookReject('duplicate');
            return res.status(409).json({ error: 'duplicate_delivery', message: 'delivery key already processed' });
          }
        }
      }
      if (queueTransportEnabled() && runnerMode !== 'inline') {
        const { execution, queue } = await enqueueExecution({
          wf, input, triggeredBy: 'webhook', principal: runPrincipal,
        });
        recordRun('webhook', 'queued');
        if (waitForResult) {
          const final = await waitForExecution(execution.id, Number(req.query.timeoutMs) || 30000);
          if (final) {
            const out = finishedResponse(final);
            return res.status(out.status).json(out.body);
          }
        }
        return res.status(202).json(queuedResponse(execution, queue));
      }
      const executionId = randomUUID();
      const r = await runWorkflow(
        { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
        input,
        {
          triggeredBy: 'webhook', principal: runPrincipal,
          credentialResolver: makeCredentialResolver(runPrincipal), synapseoneCall,
          humanTask: inlineHumanTaskSink(executionId, wf, runPrincipal),
        },
      );
      const finishedAt = new Date().toISOString();
      recordRun('webhook', r.status, r.nodeRuns);
      const exec = await createExecutionRec({
        id: executionId,
        workflow_id: wf.id, workflow_name: wf.name, status: r.status,
        input, output: r.output, node_runs: r.nodeRuns as any,
        error: (r as any).error ?? null, triggered_by: 'webhook',
        principal: runPrincipal, actor: actorFor(wf.id, runPrincipal), startedAt, finishedAt,
        workflow_revision: wf.revision,
        ...pauseBinding(r),
      });
      res.status(r.status === 'success' ? 200 : 500).json({ ok: r.status === 'success', output: r.output, executionId: exec.id, error: (r as any).error ?? undefined });
    } catch (e: any) {
      if (deliveryKey && webhookWfId) await releaseWebhookDelivery(webhookWfId, deliveryKey).catch(() => undefined);
      console.error('[workflow] webhook failed:', e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  };
  app.all('/webhook/:path', handleInboundWebhook as any);
  app.all('/webhook/*', (async (req: express.Request, res: express.Response) => {
    (req.params as any) = { ...(req.params as any), path: String(req.path).replace(/^\/webhook\/?/, '') };
    return handleInboundWebhook(req, res);
  }) as any);

  // ---- MCP server (Model Context Protocol) ----
  // Exposes active workflows with an `mcpTrigger` node as MCP tools. Clients
  // authenticate through the gateway with a Bearer JWT or X-API-Key.
  const MCP_PROTOCOL_VERSION = '2025-06-18';
  /** Public/anonymous MCP is opt-in and only for structurally read-only
   *  graphs. The gateway itself requires authentication by default; this flag
   *  exists for private deployments that intentionally expose public docs
   *  tools. */
  const mcpAnonymousEnabled = (): boolean => process.env.MCP_ALLOW_ANONYMOUS === 'true';
  const mcpAnonLimit = (): number => Math.max(1, Math.min(Number(process.env.MCP_ANONYMOUS_RATE_LIMIT_PER_MIN) || 30, 10000));
  const mcpAnonHits = new Map<string, { n: number; reset: number }>();
  function mcpAnonymousRateLimited(req: express.Request): boolean {
    if (!mcpAnonymousEnabled()) return false;
    const ip = String(req.headers['x-forwarded-for'] || req.ip || 'anon').split(',')[0].trim().slice(0, 64);
    const now = Date.now();
    const cur = mcpAnonHits.get(ip);
    if (!cur || cur.reset <= now) {
      mcpAnonHits.set(ip, { n: 1, reset: now + 60_000 });
      return false;
    }
    cur.n += 1;
    return cur.n > mcpAnonLimit();
  }
  const mcpGate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!INTERNAL_SECRET) return next();
    const raw = (req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as string | string[] | undefined;
    const got = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
    const a = Buffer.from(got);
    const b = Buffer.from(INTERNAL_SECRET);
    if (!got || a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'unauthorized', message: 'MCP requires the SynapseOne gateway (internal credential missing)' });
    }
    return next();
  };

  async function activeMcpTools(principal: Principal | null): Promise<Array<{ workflow: StoredWorkflow; tool: NonNullable<ReturnType<typeof findMcpTrigger>> }>> {
    const all = await listWorkflowRecs();
    const out: Array<{ workflow: StoredWorkflow; tool: NonNullable<ReturnType<typeof findMcpTrigger>> }> = [];
    for (const w of all) {
      if (!w.active) continue;
      const tool = findMcpTrigger({ nodes: w.nodes });
      if (!tool) continue;
      // Legacy public tools saved before structural validation must not stay
      // callable by anonymous or cross-tenant clients.
      if (tool.public && !isStructurallyReadOnlyDefinition({ nodes: w.nodes, connections: w.connections })) continue;
      if (w.settings?.access !== undefined && !canAccessWorkflow(w, principal)) continue;
      // Anonymous callers only see explicitly public, read-only tools. A
      // logged-in caller sees its tenant tools plus other tenants' public
      // read-only docs tools.
      if (!principal) {
        if (!mcpAnonymousEnabled() || !tool.public) continue;
        if (!isStructurallyReadOnlyDefinition({ nodes: w.nodes, connections: w.connections })) continue;
      } else if (!canAccessWorkflow(w, principal) && !tool.public) {
        continue;
      }
      out.push({ workflow: w, tool });
    }
    return out;
  }

  const mcpToolsList = async (principal: Principal | null) => {
    const tools = await activeMcpTools(principal);
    return {
      tools: tools.map(({ workflow, tool }) => ({
        name: tool.toolName,
        description: tool.description || `Run SynapseFlow workflow '${workflow.name}'`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
        annotations: { title: workflow.name, readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
      })),
    };
  };

  const mcpToolCall = async (principal: Principal | null, name: string, args: any) => {
    const tools = await activeMcpTools(principal);
    const hit = tools.find((t) => t.tool.toolName === name);
    if (!hit) throw Object.assign(new Error(`Unknown MCP tool '${name}'`), { rpcCode: -32602 });
    const wf = hit.workflow;
    if (!wf) throw Object.assign(new Error(`Workflow for tool '${name}' not found`), { rpcCode: -32602 });
    if (!principal) {
      if (!mcpAnonymousEnabled() || !hit.tool.public || !isStructurallyReadOnlyDefinition({ nodes: wf.nodes, connections: wf.connections })) {
        throw Object.assign(new Error(`Tool '${name}' requires authentication`), { rpcCode: -32001 });
      }
    }
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const runPrincipal = principal || workflowRunPrincipal(wf);
    const executionId = randomUUID();
    const startedAt = new Date().toISOString();
    const r = await runWorkflow(
      { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
      input,
      {
        triggeredBy: 'mcp',
        timeoutMs: 60000,
        principal: runPrincipal,
        credentialResolver: makeCredentialResolver(runPrincipal),
        synapseoneCall,
        humanTask: {
          create: async (task) => {
            const rec = await createHumanTaskRec({
              id: randomUUID(), execution_id: executionId, workflow_id: wf.id, node_name: task.node,
              title: task.title, description: task.description, assignee: task.assignee,
              candidate_roles: task.candidateRoles, decision_schema: task.decisionSchema,
              payload: task.payload, deadline: task.deadline,
              org_id: runPrincipal?.org || wf.org_id || null,
              account_id: runPrincipal?.account || wf.account_id || null,
            });
            return toPublicHumanTask(rec);
          },
        },
      },
    );
    const finishedAt = new Date().toISOString();
    recordRun('mcp', r.status, r.nodeRuns);
    const exec = await createExecutionRec({
      id: executionId, workflow_id: wf.id, workflow_name: wf.name, status: r.status,
      input, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'mcp',
      principal: runPrincipal, actor: actorFor(wf.id, runPrincipal), startedAt, finishedAt,
      workflow_revision: wf.revision,
      ...pauseBinding(r),
    });
    if (r.status === 'paused') {
      return {
        content: [{ type: 'text', text: `Workflow paused for a human task (task ${exec.output?.humanTask?.id || 'created'}). Approve it in SynapseOne Console → Human Tasks.` }],
        isError: true,
      };
    }
    const safe = maskSecrets(r.output);
    const text = safe && typeof safe === 'object' && typeof safe.content === 'string'
      ? safe.content
      : typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
    return {
      content: [{ type: 'text', text: String(text ?? '').slice(0, 500000) }],
      ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? { structuredContent: safe } : {}),
      ...(r.status === 'error' ? { isError: true } : {}),
    };
  };

  app.post('/mcp', mcpGate, async (req, res) => {
    const principal = principalFromHeaders(req);
    if (!principal && mcpAnonymousRateLimited(req)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'anonymous MCP rate limit exceeded' } });
    }
    const body = req.body;
    const handle = async (msg: any): Promise<any | null> => {
      const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : undefined;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return id === undefined ? null : { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
      }
      const method = msg.method;
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'synapseone-synapseflow', version: VERSION },
            instructions: 'Use tools/list to discover SynapseFlow workflows exposed as MCP tools. Authenticate with a SynapseOne Bearer JWT or X-API-Key.',
          },
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: await mcpToolsList(principal) };
      }
      if (method === 'tools/call') {
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        const name = String(params.name || '');
        if (!name) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call requires params.name' } };
        try {
          const result = await mcpToolCall(principal, name, params.arguments);
          return { jsonrpc: '2.0', id, result };
        } catch (e: any) {
          return { jsonrpc: '2.0', id, error: { code: e?.rpcCode || -32603, message: String(e?.message || e).slice(0, 1000) } };
        }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    };

    try {
      if (Array.isArray(body)) {
        const out = [];
        for (const msg of body.slice(0, 20)) {
          const r = await handle(msg);
          if (r) out.push(r);
        }
        if (!out.length) return res.status(202).end();
        return res.json(out);
      }
      const r = await handle(body);
      if (!r) return res.status(202).end();
      return res.json(r);
    } catch (e: any) {
      return res.status(500).json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: String(e?.message || 'Internal error').slice(0, 500) } });
    }
  });

  // Defense-in-depth: workflow KHÔNG tin gateway mù quáng. Khi SYNAPSEONE_INTERNAL_SECRET
  // được set (cùng giá trị ở gateway), mọi /v1/* (trừ /health) phải mang header
  // x-synapseone-internal khớp — chặn truy cập trực tiếp :4002 vượt mặt gateway.
  // Client KHÔNG bao giờ được gửi header này (gateway strip + set lại sau khi verify).
  const INTERNAL_SECRET = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[workflow][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production.');
  }
  app.use('/v1/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    // External rotation scheduler: authenticated by its own shared token in
    // the handler, never by the gateway-only internal credential.
    if (req.path === '/v1/secrets/rotation-webhook' || req.path === '/secrets/rotation-webhook') return next();
    if (!INTERNAL_SECRET) {
      if (IS_PROD_WF) return res.status(500).json({ error: 'misconfigured', message: 'internal secret required in production' });
      return next();
    }
    const raw = (req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as string | string[] | undefined;
    const got = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
    // Constant-time compare to avoid leaking secret prefix via timing.
    const a = Buffer.from(got);
    const b = Buffer.from(INTERNAL_SECRET);
    const ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
    next();
  }) as any);

  // Bọc async handler (Express 4 không catch async throw).
  for (const m of ['get', 'post', 'put', 'delete', 'patch'] as const) {
    const orig = ((app as any)[m] as Function).bind(app);
    (app as any)[m] = (path: string, ...handlers: any[]) =>
      orig(
        path,
        ...handlers.map((h: any) =>
          typeof h === 'function' && h.length < 4
            ? (req: express.Request, res: express.Response, next: express.NextFunction) =>
                Promise.resolve(h(req, res, next)).catch(next)
            : h,
        ),
      );
  }

  app.get('/health', async (_req, res) => {
    let counts: any = {};
    try {
      const [wfs] = await Promise.all([listWorkflowRecs()]);
      counts = { workflows: wfs.length };
    } catch { /* liveness never fails on db; /ready is the dependency probe */ }
    const queueOk = await pingWorkflowQueue();
    res.json({
      status: queueOk === false ? 'degraded' : 'ok',
      service: 'workflow', version: VERSION, engine: 'local',
      db: useDb() ? 'postgres' : 'memory',
      transport: queueTransportEnabled() ? 'queue' : 'inline',
      queue: queueOk === null ? 'inline' : queueOk ? 'ok' : 'down',
      worker: queueTransportEnabled() && String(process.env.WORKFLOW_WORKER_ENABLED || 'true').toLowerCase() !== 'false' ? 'platform' : 'off',
      selfAllowlist: selfAllowlist().length, ...counts, time: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req, res) => {
    const dbOk = await pingDb();
    const credentialsOk = !IS_PROD_WF || /^[0-9a-fA-F]{64}$/.test(String(process.env.SYNAPSEONE_CREDENTIAL_KEY || '').trim());
    const queueOk = await pingWorkflowQueue().catch(() => false);
    const queueRequired = queueTransportEnabled() && queueBackendConfigured();
    const ready = dbOk && credentialsOk && (!queueRequired || queueOk !== false);
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      service: 'workflow',
      version: VERSION,
      critical: {
        database: dbOk,
        credentialKey: credentialsOk,
        ...(queueRequired ? { queue: queueOk !== false } : {}),
      },
      transport: queueTransportEnabled() ? 'queue' : 'inline',
      time: new Date().toISOString(),
    });
  });

/** Path :id guard shared by the single-workflow routes (length + CRLF). */
function checkId(id: unknown): string | null {
  const s = String(id || '');
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function idGate(req: any, res: any): string | null {
  const id = checkId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid_id' });
    return null;
  }
  return id;
}

function cleanTenantField(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

/** Resolve tenant binding for create/update (P0-3). Explicit body values
 *  must stay inside the caller's verified tenant (403 otherwise); anonymous
 *  callers (dev/tests/direct) may set them freely. Account-scoped callers
 *  (API keys) never carry a verified org, so an explicit `orgId` is refused
 *  instead of being trusted. */
function tenantBinding(
  req: any, body: any, cur?: StoredWorkflow,
): { ok: true; value: { org_id: string | null; account_id: string | null; run_as: string | null } } | { ok: false; status: number; error: string; message: string } {
  const p = principalFromHeaders(req);
  const read = (key: string): { ok: true; value: string | null } | { ok: false } => {
    const raw = (body || {})[key];
    if (raw === undefined || raw === null || String(raw) === '') return { ok: true, value: null };
    const c = cleanTenantField(raw);
    return c === null ? { ok: false } : { ok: true, value: c };
  };
  const orgBody = read('orgId');
  if (!orgBody.ok) return { ok: false, status: 400, error: 'invalid_tenant', message: 'orgId must be 1..128 chars' };
  const accBody = read('accountId');
  if (!accBody.ok) return { ok: false, status: 400, error: 'invalid_tenant', message: 'accountId must be 1..128 chars' };
  const runAsBody = read('runAs');
  if (!runAsBody.ok) return { ok: false, status: 400, error: 'invalid_tenant', message: 'runAs must be 1..128 chars' };
  if (p && runAsBody.value && runAsBody.value !== (cur?.owner_sub || p.sub)) {
    return { ok: false, status: 403, error: 'invalid_run_as', message: 'runAs must match the workflow creator' };
  }

  if (p?.org && orgBody.value && orgBody.value !== p.org) {
    return { ok: false, status: 403, error: 'cross_tenant', message: 'cannot bind a workflow outside your own org' };
  }
  if (p && !p.org && orgBody.value) {
    return { ok: false, status: 403, error: 'cross_tenant', message: 'account-scoped callers cannot bind an org' };
  }
  if (p?.account && accBody.value && accBody.value !== p.account) {
    return { ok: false, status: 403, error: 'cross_tenant', message: 'cannot bind a workflow outside your own account' };
  }

  const org_id = orgBody.value ?? p?.org ?? cur?.org_id ?? null;
  const account_id = accBody.value ?? p?.account ?? cur?.account_id ?? null;
  const run_as = runAsBody.value ?? cur?.run_as ?? null;
  return { ok: true, value: { org_id, account_id, run_as } };
}

  // List workflows. Authenticated callers see only their own tenant slice
  // (org-bound rows for users, account-bound rows for machine identities;
  // legacy tenant-free rows stay dev-only). Explicit ?orgId=/accountId=
  // filters must stay inside the caller's own tenant (403 otherwise).
  // Anonymous direct calls keep the legacy global view (dev/tests).
  app.get('/v1/workflows', async (req, res) => {
    const p = principalFromHeaders(req);
    const q = req.query as any;
    const orgQ = typeof q.orgId === 'string' && q.orgId ? q.orgId.slice(0, 128) : undefined;
    const acctQ = typeof q.accountId === 'string' && q.accountId ? q.accountId.slice(0, 128) : undefined;
    if (p) {
      if (orgQ && (!p.org || orgQ !== p.org)) {
        return res.status(403).json({ error: 'forbidden', message: 'orgId is outside your own org' });
      }
      if (acctQ && (!p.account || acctQ !== p.account)) {
        return res.status(403).json({ error: 'forbidden', message: 'accountId is outside your own account' });
      }
      if (!p.org && !p.account) {
        return res.status(403).json({ error: 'forbidden', message: 'caller has no tenant scope' });
      }
      const all = await listWorkflowRecs();
      // Optional narrowing: when a user JWT (no account claim) filters by
      // accountId, keep the org condition too so foreign accounts stay hidden.
      const visible = all.filter((w) => {
        if (!canAccessWorkflow(w, p)) return false;
        if (orgQ && w.org_id !== orgQ) return false;
        if (acctQ && w.account_id !== acctQ) return false;
        return true;
      });
      res.json(visible.map(toApiWorkflow));
      return;
    }
    if (orgQ || acctQ) {
      const all = await listWorkflowRecs({ ...(orgQ ? { orgId: orgQ } : {}), ...(acctQ ? { accountId: acctQ } : {}) });
      res.json(all.filter((w) => canAccessWorkflow(w, null)).map(toApiWorkflow));
      return;
    }
    const all = await listWorkflowRecs();
    res.json(all.filter((w) => canAccessWorkflow(w, null)).map(toApiWorkflow));
  });

  // Get one workflow
  app.get('/v1/workflows/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const w = await getWorkflowRec(id);
    if (!w || !canAccessWorkflow(w, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    res.json(toApiWorkflow(w));
  });

  // Create workflow from template or raw definition
  app.post('/v1/workflows', async (req, res) => {
    const { name, definition, template, settings } = (req.body || {}) as any;
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
    }
    if (template != null && (typeof template !== 'string' || !/^[a-z0-9-]{1,64}$/.test(template))) {
      return res.status(400).json({ error: 'invalid_template', message: 'unknown template (see GET /v1/templates)' });
    }
    if (template != null && definition != null) {
      return res.status(400).json({ error: 'ambiguous_source', message: 'pass either template or definition, not both' });
    }
    const fromTemplate = Boolean(template && !definition);
    let payload: any = definition;
    if (fromTemplate) {
      payload = buildTemplate(template, (name as string) || template);
      if (!payload) return res.status(400).json({ error: 'unknown_template', available: listTemplates().map((t) => t.name) });
      // Template webhook paths must not collide: two active workflows sharing
      // a path makes /webhook/:path routing ambiguous. Suffix -2, -3, ….
      try {
        const hookIdx = (payload.nodes || []).findIndex((n: any) => isWebhookType((n as any)?.type));
        if (hookIdx >= 0) {
          const basePath = String(payload.nodes[hookIdx]?.parameters?.path || 'hook').replace(/^\/+|\/+$/g, '') || 'hook';
          const existing = new Set<string>();
          for (const w of await listWorkflowRecs()) {
            for (const n of (w.nodes || []) as any[]) {
              if (isWebhookType((n as any)?.type)) {
                const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
                if (p) existing.add(p);
              }
            }
          }
          let cand = basePath;
          for (let i = 2; existing.has(cand); i++) cand = `${basePath}-${i}`;
          payload.nodes[hookIdx] = {
            ...payload.nodes[hookIdx],
            parameters: { ...(payload.nodes[hookIdx]?.parameters || {}), path: cand },
          };
        }
      } catch { /* uniquify is best-effort */ }
    }
    if (!payload) return res.status(400).json({ error: 'definition or template required' });
    normalizeDecisionChoices(payload);
    // Built-in templates are trusted (fixed code); custom definitions get full validation.
    const defErr = fromTemplate ? null : validateDefinition(payload);
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    let settingsOut: Record<string, any> = {};
    // m10: explicit top-level settings win; definition.settings carries over
    // (e.g. Duplicate) when no top-level value is given.
    const settingsCand = settings ?? (payload as any).settings;
    if (settingsCand !== undefined && settingsCand !== null) {
      if (typeof settingsCand !== 'object' || Array.isArray(settingsCand)) {
        return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
      }
      try {
        if (Buffer.byteLength(JSON.stringify(settingsCand), 'utf8') > 8 * 1024) {
          return res.status(400).json({ error: 'invalid_settings', message: 'settings ≤8KB' });
        }
      } catch { return res.status(400).json({ error: 'invalid_settings', message: 'settings must be JSON-serializable' }); }
      settingsOut = settingsCand;
    }
    const execSettingsErr = validateExecutionSettings(settingsOut);
    if (execSettingsErr) return res.status(400).json({ error: 'invalid_settings', message: execSettingsErr });
    const accessErr = validateWorkflowAccess(settingsOut, principalFromHeaders(req));
    if (accessErr) return res.status(400).json({ error: 'invalid_settings', message: accessErr });
    // P0-3: tenant binding — explicit body org/account must stay inside the
    // caller's own org; otherwise inherit from the stamped principal.
    const tenant = tenantBinding(req, req.body || {});
    if (!tenant.ok) return res.status(tenant.status).json({ error: tenant.error, message: tenant.message });
    const w = await createWorkflowRec({
      name: String(name || payload.name || 'synapseone-workflow').slice(0, 200),
      nodes: payload.nodes || [],
      connections: payload.connections || {},
      settings: settingsOut,
      ...tenant.value,
      owner_sub: principalFromHeaders(req)?.sub ?? null,
    });
    res.status(201).json(toApiWorkflow(w));
  });

  // Update workflow name and/or definition.
  app.put('/v1/workflows/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { name, definition, settings, orgId, accountId, runAs } = (req.body || {}) as any;
    if (name == null && definition == null && settings == null && orgId == null && accountId == null && runAs == null) {
      return res.status(400).json({ error: 'invalid_body', message: 'name and/or definition and/or settings and/or tenant fields required' });
    }
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
    }
    const cur = await getWorkflowRec(id);
    if (!cur || !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    const execSettingsErr = validateExecutionSettings(settings ?? cur.settings);
    if (execSettingsErr) return res.status(400).json({ error: 'invalid_settings', message: execSettingsErr });
    const accessErr = validateWorkflowAccess(settings ?? cur.settings, principalFromHeaders(req), cur);
    if (accessErr) return res.status(400).json({ error: 'invalid_settings', message: accessErr });
    let nodes = cur.nodes;
    let connections = cur.connections;
    if (definition != null) {
      normalizeDecisionChoices(definition);
      const defErr = validateDefinition(definition);
      if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
      nodes = (definition as any).nodes || [];
      connections = (definition as any).connections || {};
      // A `settings` key inside `definition`, if any, is intentionally ignored.
    }
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify({ nodes, connections }), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (size > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'definition ≤200KB' });
    const tenant = tenantBinding(req, req.body || {}, cur);
    if (!tenant.ok) return res.status(tenant.status).json({ error: tenant.error, message: tenant.message });
    const updated = await updateWorkflowRec(id, {
      ...(name != null ? { name } : {}),
      ...(settings != null ? { settings } : {}),
      ...tenant.value,
      nodes, connections,
    });
    res.json(toApiWorkflow(updated!));
  });

  // Execute workflow: run the local DAG immediately with the given input.
  // Unlike the old n8n proxy (webhook-only + must be active), manual execute
  // via the authenticated API works for ANY trigger type and regardless of
  // the active flag — activating only gates cron + public /webhook/*.
  // This fixes cron/manual workflows being un-runnable from the Console.
  app.post('/v1/workflows/:id/execute', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const nestedDepth = Number(req.headers['x-workflow-depth'] || 0);
    if (!Number.isFinite(nestedDepth) || nestedDepth < 0 || nestedDepth > 3) {
      return res.status(400).json({ error: 'nesting_limit', message: 'workflow nesting depth must be 0..3' });
    }
    let bodySize = 0;
    try { bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (bodySize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'execute body ≤200KB' });
    const wf = await getWorkflowRec(id);
    const principal = principalFromHeaders(req);
    if (!wf || !canAccessWorkflow(wf, principal)) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    // Check the revision on the SAME workflow object that is executed or
    // enqueued. A separate client GET followed by execute leaves a race in
    // which an edited, unreviewed definition could run from a published page.
    if (req.query.expectedRevision !== undefined) {
      const raw = req.query.expectedRevision;
      if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        return res.status(400).json({ error: 'invalid_revision', message: 'expectedRevision must be a positive integer' });
      }
      if (Number(raw) !== wf.revision) {
        return res.status(409).json({ error: 'workflow_revision_conflict', message: 'workflow changed since approval', revision: wf.revision });
      }
    }
    const input = (req.body && typeof req.body === 'object' ? req.body : { value: req.body }) || {};
    const startedAt = new Date().toISOString();
    const executionId = randomUUID();
    const runnerMode = runnerModeForSettings(wf.settings);
    const wantsWait = req.query.wait === '1' || req.query.wait === 'true';
    // Nested/queued workflows can opt into inline execution to avoid a worker
    // waiting on another worker (self-deadlock). The public API still queues by
    // default; this is used by the remote runner's `workflows.execute` shim.
    const forceInline = req.query.inline === '1' || req.query.inline === 'true';
    if (!queueTransportEnabled() && !forceInline && (runnerMode === 'custom' || runnerMode === 'hybrid' || runnerMode === 'system')) {
      return res.status(503).json({ error: 'queue_unavailable', message: `workflow requires a ${runnerMode} runner queue but SynapseQueue is not configured` });
    }
    if (queueTransportEnabled() && runnerMode !== 'inline' && !forceInline) {
      const { execution, queue } = await enqueueExecution({
        wf, input, triggeredBy: 'manual', principal,
      });
      recordRun('manual', 'queued');
      if (wantsWait) {
        const final = await waitForExecution(execution.id, Number(req.query.timeoutMs) || 30000);
        if (final) {
          const out = finishedResponse(final);
          return res.status(out.status).json(out.body);
        }
      }
      return res.status(202).json(queuedResponse(execution, queue));
    }
    const runInline = () => runWorkflow(
      { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
      input,
      {
        triggeredBy: 'manual', principal, credentialResolver: makeCredentialResolver(principal), synapseoneCall,
        humanTask: {
          create: async (task) => {
            const rec = await createHumanTaskRec({
              id: randomUUID(), execution_id: executionId, workflow_id: wf.id, node_name: task.node,
              title: task.title, description: task.description, assignee: task.assignee,
              candidate_roles: task.candidateRoles, decision_schema: task.decisionSchema,
              payload: task.payload, deadline: task.deadline,
              org_id: principal?.org || wf.org_id || null,
              account_id: principal?.account || wf.account_id || null,
            });
            return toPublicHumanTask(rec);
          },
        },
      },
    );
    const r = nestedDepth > 0
      ? await workflowRunContext.run({ depth: nestedDepth }, runInline)
      : await runInline();
    const finishedAt = new Date().toISOString();
    recordRun('manual', r.status, r.nodeRuns);
    const exec = await createExecutionRec({
      id: executionId,
      workflow_id: wf.id, workflow_name: wf.name, status: r.status,
      input, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'manual',
      principal, actor: actorFor(wf.id, principal), startedAt, finishedAt,
      workflow_revision: wf.revision,
      ...pauseBinding(r),
    });
    if (r.status === 'paused') {
      return res.status(202).json({
        ok: true, paused: true, status: 'paused', output: r.output,
        executionId: exec.id, taskId: r.pause?.task?.id, task: r.pause?.task,
      });
    }
    res.status(r.status === 'success' ? 200 : 500).json({
      ok: r.status === 'success',
      output: r.output,
      executionId: exec.id,
      status: r.status,
      ...(r.status === 'error' ? { error: (r as any).error } : {}),
    });
  });

  // Activate / deactivate
  app.post('/v1/workflows/:id/activate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (!cur || !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    // Re-validate the stored definition: schedules that never fire and
    // webhook misconfigurations must fail loudly here, not silently.
    const defErr = validateDefinition({ nodes: cur.nodes, connections: cur.connections });
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    // M7: two active workflows sharing a webhook path make /webhook/:path
    // routing ambiguous — refuse with 409 so the clash is explicit.
    try {
      const trig = findWebhookTrigger({ nodes: cur.nodes });
      if (trig) {
        const all = await listWorkflowRecs();
        const clash = all.find((w) => {
          if (w.id === id || !w.active) return false;
          return (w.nodes || []).some((n: any) => {
            if (!isWebhookType((n as any)?.type)) return false;
            return String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '') === trig.path;
          });
        });
        if (clash) {
          return res.status(409).json({
            error: 'webhook_path_conflict',
            message: `webhook path '${trig.path}' already serves active workflow '${clash.name}' (${clash.id}) — change the path or deactivate it first`,
          });
        }
      }
      const mcp = findMcpTrigger({ nodes: cur.nodes });
      if (mcp) {
        const all = await listWorkflowRecs();
        const caller = principalFromHeaders(req);
        const clash = all.find((w) => {
          if (w.id === id || !w.active) return false;
          const other = findMcpTrigger({ nodes: w.nodes });
          if (!other || other.toolName !== mcp.toolName) return false;
          // Public tools are globally unique (anonymous lookup). Private tools
          // may reuse a name only inside a different tenant.
          if (mcp.public || other.public) return true;
          return canAccessWorkflow(w, caller);
        });
        if (clash) {
          return res.status(409).json({
            error: 'mcp_tool_conflict',
            message: `MCP tool '${mcp.toolName}' already serves active workflow '${clash.name}' (${clash.id}) — change the tool name or deactivate it first`,
          });
        }
      }
    } catch { /* conflict scan is best-effort */ }
    const w = await updateWorkflowRec(id, { active: true });
    if (!w) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json(toApiWorkflow(w));
  });

  app.post('/v1/workflows/:id/deactivate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (cur && !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    const w = await updateWorkflowRec(id, { active: false });
    if (!w) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json(toApiWorkflow(w));
  });

  // Executions list. Same allowlist contract as before.
  app.get('/v1/executions', async (req, res) => {
    const q = req.query as any;
    let limit = 20;
    let offset = 0;
    if (q.limit !== undefined) {
      if (typeof q.limit !== 'string' || !/^\d{1,4}$/.test(q.limit)) {
        return res.status(400).json({ error: 'invalid_query', message: 'limit must be a 0..9999 integer' });
      }
      limit = Math.min(Number(q.limit), 100) || 20;
    }
    if (q.offset !== undefined) {
      if (typeof q.offset !== 'string' || !/^\d{1,4}$/.test(q.offset)) {
        return res.status(400).json({ error: 'invalid_query', message: 'offset must be a 0..9999 integer' });
      }
      // offset=0 (any spelling) means first page.
      offset = Number(q.offset) === 0 ? 0 : Number(q.offset);
    }
    const workflowId = typeof q.workflowId === 'string' && q.workflowId.length <= 256 ? q.workflowId : undefined;
    if (workflowId && /[\r\n]/.test(workflowId)) return res.status(400).json({ error: 'invalid_query', message: 'bad workflowId' });
    const status = typeof q.status === 'string' && q.status.length <= 32 ? q.status : undefined;
    if (status && !['queued', 'running', 'paused', 'success', 'error', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'invalid_query', message: 'status must be queued|running|paused|success|error|cancelled' });
    }
    // M10: test runs persist server-side — filterable so history views can
    // include or exclude them (triggeredBy=manual|webhook|cron|test).
    const triggeredBy = typeof q.triggeredBy === 'string' && q.triggeredBy.length <= 32 ? q.triggeredBy : undefined;
    if (triggeredBy && !['manual', 'webhook', 'cron', 'test', 'human-task', 'workflow', 'mcp'].includes(triggeredBy)) {
      return res.status(400).json({ error: 'invalid_query', message: 'triggeredBy must be manual|webhook|cron|test|human-task|workflow|mcp' });
    }
    const includeData = q.includeData === 'true';
    const principal = principalFromHeaders(req);
    const scope = executionScope(principal);
    if (!scope) return res.status(403).json({ error: 'forbidden', message: 'caller has no tenant scope' });
    const { items } = await listExecutionRecs({ workflowId, status, triggeredBy, limit, offset, ...scope });
    const visibility = await Promise.all(items.map((e) => canReadExecution(e, principal)));
    const mapped = items.filter((_e, i) => visibility[i]).map((e) => toApiExecution(e, includeData));
    // Console accepts both a raw array and {data: []} — return the envelope
    // with data for forward-compat (n8n proxied {data} before).
    res.json({ data: mapped });
  });

  // Get one execution.
  app.get('/v1/executions/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const e = await getExecutionRec(id);
    if (!e || !await canReadExecution(e, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'execution not found' });
    }
    const includeData = (req.query as any).includeData === 'true';
    res.json(toApiExecution(e, includeData));
  });

  // Cancel a queued or paused execution. Running executions are left to their
  // lease owner; the worker/runner must report a terminal result.
  app.post('/v1/executions/:id/cancel', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const principal = principalFromHeaders(req);
    const execution = await getExecutionRec(id);
    if (!execution || !await canReadExecution(execution, principal)) {
      return res.status(404).json({ error: 'not_found', message: 'execution not found' });
    }
    if (!canCancelExecution(execution, principal)) {
      return res.status(403).json({ error: 'forbidden', message: 'you cannot cancel this execution' });
    }
    const reason = String((req.body || {}).reason || 'cancelled by user').slice(0, 500);
    const cancelled = await cancelExecutionRec(id, reason);
    if (!cancelled) {
      return res.status(409).json({
        error: 'execution_not_cancellable',
        message: 'only queued or human-paused executions can be cancelled; a running runner keeps its lease',
        status: execution.status,
      });
    }
    // Close any pending/claimed human checkpoints so they cannot be approved
    // after the execution has been cancelled.
    const tasks = await listHumanTaskRecs({ executionId: id, limit: 200 });
    for (const task of tasks) {
      if (task.status === 'pending' || task.status === 'claimed') {
        await transitionHumanTaskRec(task.id, ['pending', 'claimed'], { status: 'cancelled' }).catch(() => null);
      }
    }
    res.json(toApiExecution(cancelled, true));
  });

  // ---------- self-hosted workflow runners ----------
  // A runner is a tenant-owned worker that consumes a SynapseQueue workflow
  // queue. Users create a runner, mint an IAM API key for it, and deploy the
  // published runner image with the generated command.
  const RUNNER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,99}$/;

  app.post('/v1/workflow-runners', async (req, res) => {
    const principal = principalFromHeaders(req);
    if (!principal) return res.status(401).json({ error: 'unauthenticated', message: 'a verified principal is required' });
    const b = (req.body || {}) as any;
    const name = String(b.name || '').trim();
    if (!RUNNER_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 printable chars' });
    }
    const kind: 'workflow' | 'inference' | 'hybrid' = b.kind === 'inference' || b.kind === 'hybrid' ? b.kind : 'workflow';
    if (b.mode === 'system') {
      return res.status(403).json({
        error: 'platform_runner_required',
        message: 'system runners are owner-managed; use POST /v1/platform/runners as a platform owner',
      });
    }
    const mode: 'custom' | 'hybrid' = b.mode === 'hybrid' ? 'hybrid' : 'custom';
    // Account runners may only claim their own account's executions. Org-wide
    // compute is an explicit admin grant, never a default for any member.
    const requestedAudience: 'account' | 'org' = b.audience === 'org'
      ? 'org'
      : b.audience === 'account'
        ? 'account'
        : (principal.account ? 'account' : 'org');
    if (requestedAudience === 'org' && principal.isOrgAdmin !== true) {
      return res.status(403).json({
        error: 'org_admin_required',
        message: 'organization-wide runners require an organization administrator; use an account-bound key or ask an admin',
      });
    }
    if (requestedAudience === 'account' && !principal.account) {
      return res.status(400).json({
        error: 'account_required',
        message: 'account-scoped runners require an account-bound credential',
      });
    }
    const defaultWorkflowQueue = mode === 'hybrid' ? DEFAULT_SHARED_QUEUE : DEFAULT_CUSTOM_QUEUE;
    const queue = String(b.queue || (kind === 'inference' ? DEFAULT_INFERENCE_QUEUE : defaultWorkflowQueue)).trim();
    if (!isQueueName(queue)) {
      return res.status(400).json({ error: 'invalid_queue', message: 'queue must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
    }
    const inferenceQueue = kind === 'workflow'
      ? null
      : String(b.inferenceQueue || DEFAULT_INFERENCE_QUEUE).trim();
    if (inferenceQueue !== null && !isQueueName(inferenceQueue)) {
      return res.status(400).json({ error: 'invalid_queue', message: 'inferenceQueue must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
    }
    const apiKeyId = b.apiKeyId ? String(b.apiKeyId).slice(0, 128) : null;
    const keyPrefix = b.keyPrefix ? String(b.keyPrefix).slice(0, 32) : null;
    const scopes = Array.isArray(b.scopes) && b.scopes.length
      ? b.scopes.map(String).filter((s: string) => s && s.length <= 200).slice(0, 100)
      : RUNNER_KEY_SCOPES;
    // Tenant runners may also opt into explicit Docker controls; absent
    // config keeps the historical no-flags/concurrency-1 shape.
    let dockerResources: DockerResources | undefined;
    if (b.dockerResources !== undefined && b.dockerResources !== null) {
      const parsed = normalizeDockerResources(b.dockerResources, defaultDockerResources(kind));
      if (parsed.error) return res.status(400).json({ error: 'invalid_docker_resources', message: parsed.error });
      dockerResources = parsed.value;
    }
    const runner = await createRunnerRec({
      name,
      kind,
      scope: 'tenant',
      audience: requestedAudience,
      mode,
      queue,
      inference_queue: inferenceQueue,
      org_id: principal.org || null,
      account_id: principal.account || null,
      api_key_id: apiKeyId,
      key_prefix: keyPrefix,
      created_by: principal.sub,
      metadata: {
        ...stripDockerResourcesMetadata(b.metadata),
        scopes,
        ...(dockerResources ? { dockerResources } : {}),
      },
    });
    if (typeof b.apiKey === 'string' && b.apiKey) res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      runner: toApiRunner(runner),
      kind: runner.kind,
      queue: runner.queue,
      inferenceQueue: runner.inference_queue || null,
      scopes,
      command: runnerCommand(runner, typeof b.apiKey === 'string' ? b.apiKey : null),
      options: runnerOptions(),
      warning: typeof b.apiKey === 'string' && b.apiKey
        ? 'The API key is only echoed in this response and is never stored by workflow-service.'
        : 'Pass the API key to POST /v1/workflow-runners/:id/command to render a copy-paste command.',
    });
  });

  app.get('/v1/workflow-runners/options', async (_req, res) => {
    res.json(runnerOptions());
  });

  app.get('/v1/workflow-runners', async (req, res) => {
    const principal = principalFromHeaders(req);
    const scope = humanTaskScope(principal);
    if (scope === null) return res.status(403).json({ error: 'tenant_required' });
    const runners = await listRunnerRecs({ ...scope, scope: 'tenant', limit: Number((req.query as any).limit) || 100 });
    const instances = await listRunnerInstancesForRunners(runners.map((r) => r.id));
    const byRunner = new Map<string, StoredRunnerInstance[]>();
    for (const inst of instances) {
      const list = byRunner.get(inst.runner_id) || [];
      list.push(inst);
      byRunner.set(inst.runner_id, list);
    }
    res.json({
      data: runners.map((r) => toApiRunner(r, byRunner.get(r.id) || [])),
      options: runnerOptions(),
    });
  });

  app.get('/v1/workflow-runners/:id', async (req, res) => {
    const runner = await loadRunnerForRequest(req, res);
    if (!runner) return;
    const instances = await listRunnerInstances(runner.id);
    res.json({
      runner: toApiRunner(runner, instances),
      command: runnerCommand(runner),
      config: {
        ...runnerOptions(),
        runnerId: runner.id,
        queue: runner.queue,
        mode: runner.mode,
      },
    });
  });

  app.patch('/v1/workflow-runners/:id', async (req, res) => {
    const runner = await loadRunnerForRequest(req, res);
    if (!runner) return;
    const b = (req.body || {}) as any;
    const patch: { name?: string; kind?: 'workflow' | 'inference' | 'hybrid'; mode?: 'custom' | 'hybrid'; queue?: string; inference_queue?: string | null; metadata?: Record<string, any> } = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!RUNNER_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 printable chars' });
      patch.name = name;
    }
    if (b.kind !== undefined) {
      if (b.kind !== 'workflow' && b.kind !== 'inference' && b.kind !== 'hybrid') return res.status(400).json({ error: 'invalid_kind', message: 'kind must be workflow|inference|hybrid' });
      patch.kind = b.kind;
    }
    if (b.mode !== undefined) {
      if (b.mode !== 'custom' && b.mode !== 'hybrid') return res.status(400).json({ error: 'invalid_mode', message: 'mode must be custom|hybrid' });
      patch.mode = b.mode;
    }
    if (b.queue !== undefined) {
      const queue = String(b.queue).trim();
      if (!isQueueName(queue)) return res.status(400).json({ error: 'invalid_queue', message: 'queue must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
      patch.queue = queue;
    }
    if (b.inferenceQueue !== undefined) {
      if (b.inferenceQueue === null || b.inferenceQueue === '') patch.inference_queue = null;
      else {
        const iq = String(b.inferenceQueue).trim();
        if (!isQueueName(iq)) return res.status(400).json({ error: 'invalid_queue', message: 'inferenceQueue must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
        patch.inference_queue = iq;
      }
    }
    const nextKind = patch.kind || runner.kind;
    // Merge runtime metadata and validated Docker controls once so a single
    // PATCH may update both without one clobbering the other. A generic
    // metadata.dockerResources copy is ignored in favour of the typed field.
    let nextMetadata: Record<string, any> | undefined;
    const metadataBase = () => nextMetadata ?? { ...(runner.metadata || {}) };
    if (b.metadata !== undefined) {
      if (!b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata)) return res.status(400).json({ error: 'invalid_metadata' });
      nextMetadata = { ...metadataBase(), ...stripDockerResourcesMetadata(b.metadata) };
    }
    if (b.dockerResources !== undefined) {
      const metadata = { ...metadataBase() };
      if (b.dockerResources === null) {
        delete metadata.dockerResources;
      } else {
        const current = effectiveDockerResources({ ...runner, kind: nextKind }) || defaultDockerResources(nextKind);
        const parsed = normalizeDockerResources(b.dockerResources, current);
        if (parsed.error) return res.status(400).json({ error: 'invalid_docker_resources', message: parsed.error });
        metadata.dockerResources = parsed.value;
      }
      nextMetadata = metadata;
    }
    if (nextMetadata) patch.metadata = nextMetadata;
    if (nextKind !== 'workflow' && !patch.inference_queue && !runner.inference_queue) patch.inference_queue = DEFAULT_INFERENCE_QUEUE;
    const changingQueue = (patch.queue && patch.queue !== runner.queue)
      || (patch.mode && patch.mode !== runner.mode)
      || (patch.kind && patch.kind !== runner.kind)
      || (patch.inference_queue !== undefined && patch.inference_queue !== runner.inference_queue);
    if (changingQueue) {
      const instances = await listRunnerInstances(runner.id);
      if (runnerStatus(runner, instances).connected) {
        return res.status(409).json({ error: 'runner_connected', message: 'disconnect or delete the connector instances before changing queue/mode' });
      }
    }
    const updated = await updateRunnerRec(runner.id, patch);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    const instances = await listRunnerInstances(updated.id);
    res.json({ runner: toApiRunner(updated, instances), options: runnerOptions() });
  });

  app.get('/v1/workflow-runners/:id/config', async (req, res) => {
    const runner = await loadRunnerForAgent(req, res);
    if (!runner) return;
    res.json({
      runnerId: runner.id,
      name: runner.name,
      kind: runner.kind,
      scope: runner.scope,
      mode: runner.mode,
      queue: runner.queue,
      inferenceQueue: runner.inference_queue || null,
      queues: {
        workflow: runner.kind === 'inference' ? null : runner.queue,
        inference: runner.kind === 'workflow' ? null : (runner.inference_queue || DEFAULT_INFERENCE_QUEUE),
      },
      apiBaseUrl: runnerPublicUrl(),
      heartbeatIntervalSeconds: runnerHeartbeatSeconds(),
      longPollSeconds: runnerLongPollSeconds(),
      staleAfterSeconds: runnerStaleAfterSeconds(),
      pollIntervalMs: 500,
      visibilityTimeoutSeconds: queueVisibilitySeconds(),
      maxConcurrency: runnerMaxConcurrency(),
      workerImage: runnerImage(),
      inference: runner.metadata?.inference || null,
      options: runnerOptions(),
    });
  });

  app.post('/v1/workflow-runners/:id/heartbeat', async (req, res) => {
    const runner = await loadRunnerForAgent(req, res);
    if (!runner) return;
    const b = (req.body || {}) as any;
    const instanceId = String(b.instanceId || b.instance_id || runner.id).trim();
    if (!instanceId || instanceId.length > 128 || /[\r\n]/.test(instanceId)) {
      return res.status(400).json({ error: 'invalid_instance', message: 'instanceId must be 1..128 printable chars' });
    }
    const status: 'connected' | 'offline' = b.status === 'offline' ? 'offline' : 'connected';
    const queue = b.queue !== undefined ? String(b.queue) : runner.queue;
    if (!isQueueName(queue)) return res.status(400).json({ error: 'invalid_queue' });
    const concurrency = Math.min(Math.max(Number(b.concurrency) || 1, 1), runnerMaxConcurrency());
    const startedAt = b.startedAt && !Number.isNaN(new Date(String(b.startedAt)).getTime()) ? new Date(String(b.startedAt)).toISOString() : null;
    const reportedMetadata = b.metadata && typeof b.metadata === 'object' && !Array.isArray(b.metadata) ? b.metadata : {};
    const resourceSample = sanitizeRunnerResourceSample(reportedMetadata.resources);
    const reportedHeartbeat = Number(b.heartbeatIntervalSeconds ?? reportedMetadata.heartbeatIntervalSeconds);
    const heartbeatIntervalSeconds = Number.isFinite(reportedHeartbeat)
      ? Math.min(Math.max(Math.floor(reportedHeartbeat), 5), 300)
      : runnerHeartbeatSeconds();
    const existingInstances = await listRunnerInstances(runner.id);
    const existingInstance = existingInstances.find((item) => item.id === instanceId);
    const existingMetadata = existingInstance?.metadata && typeof existingInstance.metadata === 'object'
      ? existingInstance.metadata as Record<string, any>
      : {};
    const instanceMetadata: Record<string, any> = { ...existingMetadata, ...reportedMetadata };
    // The observation clock is per instance: use the interval this connector
    // actually reports, not a global 15 s assumption.
    instanceMetadata.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
    delete instanceMetadata.resourceHistory;
    if (resourceSample) {
      const priorHistory = Array.isArray(existingMetadata.resourceHistory)
        ? existingMetadata.resourceHistory.filter((item: any) => item && typeof item === 'object' && item.sampledAt).slice(-(RESOURCE_HISTORY_MAX - 1))
        : [];
      instanceMetadata.resources = resourceSample;
      instanceMetadata.resourceHistory = [...priorHistory, resourceSample].slice(-RESOURCE_HISTORY_MAX);
    } else {
      // Never trust a runner-supplied sample that did not sanitize; keep the
      // last server-stamped sample/history instead.
      delete instanceMetadata.resources;
      if (existingMetadata.resources) instanceMetadata.resources = existingMetadata.resources;
      if (existingMetadata.resourceHistory) instanceMetadata.resourceHistory = existingMetadata.resourceHistory;
    }
    const instance = await upsertRunnerInstance({
      id: instanceId,
      runner_id: runner.id,
      hostname: b.hostname ? String(b.hostname).slice(0, 255) : '',
      version: b.version !== undefined ? String(b.version) : undefined,
      queue,
      concurrency,
      status,
      started_at: startedAt,
      metadata: instanceMetadata,
    });
    if (resourceSample) {
      await recordRunnerResourceUsage(instance.id, runner.id, resourceSample).catch((e) => {
        console.error('[workflow][usage] rollup failed:', e?.message || e);
      });
    }
    // Runtime health is additive metadata. Never let a connector overwrite the
    // owner-managed inference configuration or the system-mode marker.
    let mergedMetadata: Record<string, any> | undefined;
    if (b.metadata && typeof b.metadata === 'object' && !Array.isArray(b.metadata)) {
      const incoming: Record<string, any> = { ...b.metadata };
      delete incoming.inference;
      delete incoming.dockerResources;
      delete incoming.scope;
      delete incoming.executionMode;
      delete incoming.resources;
      delete incoming.resourceHistory;
      if (resourceSample) incoming.resources = resourceSample;
      mergedMetadata = { ...(runner.metadata || {}), ...incoming };
    }
    const updated = await heartbeatRunnerRec(runner.id, {
      version: b.version !== undefined ? String(b.version) : undefined,
      status: 'connected',
      lastError: b.lastError !== undefined ? (b.lastError ? String(b.lastError) : null) : undefined,
      metadata: mergedMetadata,
    });
    if (!updated) return res.status(404).json({ error: 'not_found' });
    const instances = await listRunnerInstances(updated.id);
    res.json({
      ok: true,
      instance: runnerInstancePublic(instance),
      runner: toApiRunner(updated, instances),
      heartbeatIntervalSeconds: runnerHeartbeatSeconds(),
      staleAfterSeconds: runnerStaleAfterSeconds(),
    });
  });

  app.get('/v1/workflow-runners/:id/connection', async (req, res) => {
    const runner = await loadRunnerForAgent(req, res);
    if (!runner) return;
    const instances = await listRunnerInstances(runner.id);
    const api = toApiRunner(runner, instances);
    res.json({
      connected: api.connected,
      status: api.status,
      checkedAt: new Date().toISOString(),
      runner: api,
      instances: api.instances,
      instanceCount: api.instanceCount,
      connectedInstances: api.connectedInstances,
      lastSeenAt: api.lastSeenAt,
      queue: runner.queue,
      mode: runner.mode,
      version: api.version,
      lastError: runner.last_error,
      heartbeatIntervalSeconds: runnerHeartbeatSeconds(),
      staleAfterSeconds: runnerStaleAfterSeconds(),
    });
  });

  app.delete('/v1/workflow-runners/:id/instances/:instanceId', async (req, res) => {
    const runner = await loadRunnerForRequest(req, res);
    if (!runner) return;
    const instanceId = String(req.params.instanceId || '');
    if (!instanceId || instanceId.length > 128 || /[\r\n]/.test(instanceId)) return res.status(400).json({ error: 'invalid_instance' });
    const deleted = await deleteRunnerInstance(runner.id, instanceId);
    if (!deleted) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, runnerId: runner.id, instanceId, deleted: true });
  });

  app.post('/v1/workflow-runners/:id/command', async (req, res) => {
    const runner = await loadRunnerForRequest(req, res);
    if (!runner) return;
    const apiKey = typeof (req.body || {}).apiKey === 'string' ? (req.body as any).apiKey : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      command: runnerCommand(runner, apiKey),
      apiBaseUrl: runnerPublicUrl(),
      queue: runner.queue,
      mode: runner.mode,
      hasApiKey: !!apiKey,
      options: runnerOptions(),
    });
  });

  app.delete('/v1/workflow-runners/:id', async (req, res) => {
    const runner = await loadRunnerForRequest(req, res);
    if (!runner) return;
    const active = await countActiveExecutionsForRunner(runner.id, runner.queue, runner.mode !== 'system');
    if (active > 0) {
      return res.status(409).json({
        error: 'runner_has_active_executions',
        message: `drain or cancel ${active} queued/running execution(s) before deleting this runner`,
        active,
      });
    }
    res.json({ ok: true, id: runner.id, deleted: await deleteRunnerRec(runner.id) });
  });

  // ---------- owner-scoped (platform) runner management ----------
  // Reachable only with a platform administrator JWT (gateway /v1/platform/*
  // guard) and re-authorized as role=owner with IAM below. A platform runner
  // is shared system compute: any owner can manage it, it holds no user token,
  // and it executes explicitly `system`-mode work for every tenant.
  const PLATFORM_RUNNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

  async function platformRunnerById(id: string): Promise<StoredWorkflowRunner | null> {
    if (!PLATFORM_RUNNER_ID_RE.test(String(id || ''))) return null;
    const runner = await getRunnerRec(String(id));
    return runner && runner.scope === 'platform' ? runner : null;
  }

  /** Key rotation/revocation makes every prior connector credential stale.
   *  Preserve owner config and per-instance resource history, but remove the
   *  top-level "live" sample/active-job/readiness flags so the Console cannot
   *  show a phantom connected/ready state before the new worker heartbeats. */
  function staleRunnerLiveMetadata(metadata: Record<string, any> | null | undefined, reason: string): Record<string, any> {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const { inferenceHealth: _health, resources: _resources, activeJobs: _active, ...rest } = source;
    return {
      ...rest,
      inferenceHealth: {
        ready: false,
        status: 'disconnected',
        checkedAt: new Date().toISOString(),
        lastError: reason,
      },
    };
  }

  /** Parse the owner-facing docker resource body. `null` means "reset to the
   *  legacy defaults"; omitted fields inherit `base`. */
  function parseDockerResourcesInput(
    input: unknown,
    base: DockerResources,
  ): { value?: DockerResources | null; error?: string } {
    if (input === null) return { value: null };
    const parsed = normalizeDockerResources(input, base);
    return parsed.error ? { error: parsed.error } : { value: parsed.value };
  }

  function platformRunnerPayload(runner: StoredWorkflowRunner, instances: StoredRunnerInstance[], apiKey?: string | null): any {
    return {
      runner: toApiRunner(runner, instances),
      kind: runner.kind,
      scope: 'platform',
      mode: 'system',
      queue: runner.queue,
      inferenceQueue: runner.inference_queue || null,
      scopes: PLATFORM_RUNNER_KEY_SCOPES,
      command: runnerCommand(runner, apiKey || null),
      options: runnerOptions(),
      ...(apiKey
        ? { apiKey, warning: 'The platform runner key is shown once. Store it in the runner host secret manager; workflow-service never persists it.' }
        : {}),
    };
  }

  app.get('/v1/platform/runners/options', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    res.json({
      ...runnerOptions(),
      platformRunner: {
        queue: DEFAULT_SYSTEM_QUEUE,
        inferenceQueue: DEFAULT_SYSTEM_INFERENCE_QUEUE,
        scopes: PLATFORM_RUNNER_KEY_SCOPES,
        kinds: ['workflow', 'inference', 'hybrid'],
      },
    });
  });

  app.get('/v1/platform/runners', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runners = await listRunnerRecs({
      scope: 'platform',
      limit: Number((req.query as any).limit) || 100,
    });
    const instances = await listRunnerInstancesForRunners(runners.map((r) => r.id));
    const byRunner = new Map<string, StoredRunnerInstance[]>();
    for (const inst of instances) {
      const list = byRunner.get(inst.runner_id) || [];
      list.push(inst);
      byRunner.set(inst.runner_id, list);
    }
    res.json({
      data: runners.map((r) => toApiRunner(r, byRunner.get(r.id) || [])),
      options: runnerOptions(),
      platformRunner: {
        queue: DEFAULT_SYSTEM_QUEUE,
        inferenceQueue: DEFAULT_SYSTEM_INFERENCE_QUEUE,
        scopes: PLATFORM_RUNNER_KEY_SCOPES,
      },
    });
  });

  app.post('/v1/platform/runners', async (req, res) => {
    const owner = await requirePlatformOwner(req, res);
    if (!owner) return;
    const b = (req.body || {}) as any;
    const name = String(b.name || '').trim();
    if (!RUNNER_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 printable chars' });
    }
    const kind: 'workflow' | 'inference' | 'hybrid' = b.kind === 'inference' || b.kind === 'hybrid' ? b.kind : 'workflow';
    const inferenceConfig = normalizeInferenceConfig(b.inference);
    if (inferenceConfig.error) return res.status(400).json({ error: 'invalid_inference', message: inferenceConfig.error });
    applyInferenceResourceDefaults(inferenceConfig.value, kind, b.inference);
    let dockerResources: DockerResources | undefined;
    if (b.dockerResources !== undefined) {
      const parsed = parseDockerResourcesInput(b.dockerResources, defaultDockerResources(kind));
      if (parsed.error) return res.status(400).json({ error: 'invalid_docker_resources', message: parsed.error });
      dockerResources = parsed.value || undefined;
    }
    const queue = DEFAULT_SYSTEM_QUEUE;
    const inferenceQueue = kind === 'workflow' ? null : DEFAULT_SYSTEM_INFERENCE_QUEUE;
    const runner = await createRunnerRec({
      name,
      kind,
      scope: 'platform',
      mode: 'system',
      queue,
      inference_queue: inferenceQueue,
      org_id: null,
      account_id: null,
      created_by: owner.sub || null,
      metadata: {
        ...stripDockerResourcesMetadata(b.metadata),
        scopes: PLATFORM_RUNNER_KEY_SCOPES,
        scope: 'platform',
        executionMode: 'system',
        inference: inferenceConfig.value,
        ...(dockerResources ? { dockerResources } : {}),
      },
    });
    let key: { id: string; value: string; prefix: string; scopes: string[] } | null = null;
    try {
      key = await mintPlatformRunnerKey({
        runnerId: runner.id,
        name: `platform-runner-${name}`.slice(0, 100),
        scopes: PLATFORM_RUNNER_KEY_SCOPES,
        createdBy: owner.sub || null,
      });
      const updated = await updateRunnerRec(runner.id, {
        api_key_id: key.id,
        key_prefix: key.prefix,
      });
      if (!updated) throw httpError(503, 'runner_persist_failed', 'runner registration disappeared while attaching its key');
      const instances = await listRunnerInstances(updated.id);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json(platformRunnerPayload(updated, instances, key.value));
    } catch (e: any) {
      if (key) await revokePlatformRunnerKeyViaIam(key.id).catch(() => undefined);
      await deleteRunnerRec(runner.id).catch(() => undefined);
      if (e?.status) {
        return res.status(e.status).json({ error: e.code || 'runner_key_unavailable', message: String(e.message || 'cannot create the platform runner') });
      }
      throw e;
    }
  });

  app.get('/v1/platform/runners/:id', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const instances = await listRunnerInstances(runner.id);
    res.json(platformRunnerPayload(runner, instances));
  });

  // Hour/day/week/month request history for one runner registration. Counts
  // are built from real execution/inference intervals; CPU/RAM come from
  // hourly heartbeat rollups (the raw 30-minute sample history stays in the
  // instance payload).
  app.get('/v1/platform/runners/:id/usage', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const rawInterval = String((req.query as any).interval || 'hour');
    if (!['hour', 'day', 'week', 'month'].includes(rawInterval)) {
      return res.status(400).json({ error: 'invalid_query', message: 'interval must be hour|day|week|month' });
    }
    const interval = rawInterval as RunnerUsageInterval;
    const rawHours = String((req.query as any).hours || '24');
    if (!/^\d{1,5}$/.test(rawHours)) {
      return res.status(400).json({ error: 'invalid_query', message: 'hours must be a 1..26280 integer' });
    }
    const hours = Math.min(Math.max(Number(rawHours) || 24, 1), 26_280);
    const fromMs = usageBucketStart(Date.now() - hours * 3_600_000, interval);
    const [requests, resources] = await Promise.all([
      listRunnerUsageRequests(runner.id, new Date(fromMs)),
      listRunnerUsageHourly(runner.id, new Date(fromMs)),
    ]);
    res.json({
      runnerId: runner.id,
      ...aggregateRunnerUsage(requests, resources, fromMs, Date.now(), interval),
    });
  });

  app.patch('/v1/platform/runners/:id', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const b = (req.body || {}) as any;
    const patch: {
      name?: string;
      kind?: 'workflow' | 'inference' | 'hybrid';
      inference_queue?: string | null;
      metadata?: Record<string, any>;
    } = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!RUNNER_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 printable chars' });
      patch.name = name;
    }
    let nextKind: 'workflow' | 'inference' | 'hybrid' = runner.kind;
    if (b.kind !== undefined) {
      if (b.kind !== 'workflow' && b.kind !== 'inference' && b.kind !== 'hybrid') {
        return res.status(400).json({ error: 'invalid_kind', message: 'kind must be workflow|inference|hybrid' });
      }
      patch.kind = b.kind;
      patch.inference_queue = b.kind === 'workflow' ? null : DEFAULT_SYSTEM_INFERENCE_QUEUE;
      nextKind = b.kind;
    }
    if (b.mode !== undefined && b.mode !== 'system') {
      return res.status(400).json({ error: 'invalid_mode', message: 'platform runners always use system mode' });
    }
    if (b.queue !== undefined && b.queue !== DEFAULT_SYSTEM_QUEUE) {
      return res.status(400).json({ error: 'invalid_queue', message: `platform runners always use the ${DEFAULT_SYSTEM_QUEUE} queue` });
    }
    // Merge owner metadata once so inference/resource updates in the same
    // request cannot clobber each other, and strip any generic
    // `dockerResources` copy that would bypass typed validation.
    let nextMetadata: Record<string, any> | undefined;
    const metadataBase = () => nextMetadata ?? { ...(runner.metadata || {}) };
    if (b.metadata !== undefined) {
      if (!b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata)) {
        return res.status(400).json({ error: 'invalid_metadata' });
      }
      nextMetadata = { ...metadataBase(), ...stripDockerResourcesMetadata(b.metadata) };
    }
    if (b.inference !== undefined) {
      const cfg = normalizeInferenceConfig(b.inference);
      if (cfg.error) return res.status(400).json({ error: 'invalid_inference', message: cfg.error });
      applyInferenceResourceDefaults(cfg.value, nextKind, b.inference);
      nextMetadata = { ...metadataBase(), inference: cfg.value };
    }
    if (b.dockerResources !== undefined) {
      const current = effectiveDockerResources({ ...runner, kind: nextKind }) || defaultDockerResources(nextKind);
      const parsed = parseDockerResourcesInput(b.dockerResources, current);
      if (parsed.error) return res.status(400).json({ error: 'invalid_docker_resources', message: parsed.error });
      const metadata = { ...metadataBase() };
      if (parsed.value) metadata.dockerResources = parsed.value;
      else delete metadata.dockerResources;
      nextMetadata = metadata;
    }
    if (nextMetadata) patch.metadata = nextMetadata;
    if (patch.kind && patch.kind !== runner.kind) {
      const instances = await listRunnerInstances(runner.id);
      if (runnerStatus(runner, instances).connected) {
        return res.status(409).json({ error: 'runner_connected', message: 'disconnect or delete the connector instances before changing the runner kind' });
      }
    }
    const updated = await updateRunnerRec(runner.id, patch);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    const instances = await listRunnerInstances(updated.id);
    res.json({ runner: toApiRunner(updated, instances), options: runnerOptions() });
  });

  app.post('/v1/platform/runners/:id/disable', async (req, res) => {
    const owner = await requirePlatformOwner(req, res);
    if (!owner) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const updated = await updateRunnerRec(runner.id, {
      status: 'disabled',
      metadata: {
        ...(runner.metadata || {}),
        disabledAt: new Date().toISOString(),
        disabledBy: owner.sub || null,
      },
    });
    if (!updated) return res.status(404).json({ error: 'not_found' });
    await revokeExecutionDelegationsViaIam({ runnerId: runner.id });
    const instances = await listRunnerInstances(updated.id);
    res.json({ ok: true, runner: toApiRunner(updated, instances) });
  });

  app.post('/v1/platform/runners/:id/enable', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    if (!runner.api_key_id) {
      return res.status(409).json({
        error: 'runner_key_missing',
        message: 'rotate the runner key before enabling this runner',
      });
    }
    const updated = await updateRunnerRec(runner.id, {
      status: 'waiting',
      metadata: {
        ...(runner.metadata || {}),
        enabledAt: new Date().toISOString(),
      },
    });
    if (!updated) return res.status(404).json({ error: 'not_found' });
    const instances = await listRunnerInstances(updated.id);
    res.json({ ok: true, runner: toApiRunner(updated, instances) });
  });

  app.post('/v1/platform/runners/:id/revoke-key', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    // Revoke every key for the registration, then leave the row disabled so
    // the owner must rotate before a connector can reconnect.
    await revokeAllPlatformRunnerKeysViaIam(runner.id);
    await revokeExecutionDelegationsViaIam({ runnerId: runner.id });
    await markRunnerInstancesOffline(runner.id);
    const updated = await updateRunnerRec(runner.id, {
      api_key_id: null,
      key_prefix: null,
      status: 'disabled',
      metadata: {
        ...staleRunnerLiveMetadata(runner.metadata, 'runner key revoked; rotate the key and start a new connector'),
        keyRevokedAt: new Date().toISOString(),
      },
    });
    if (!updated) return res.status(404).json({ error: 'not_found' });
    const instances = await listRunnerInstances(updated.id);
    res.json({
      ok: true,
      runner: toApiRunner(updated, instances),
      warning: 'The runner key was revoked. Rotate the key to reconnect a connector.',
    });
  });

  app.post('/v1/platform/runners/:id/rotate-key', async (req, res) => {
    const owner = await requirePlatformOwner(req, res);
    if (!owner) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const key = await mintPlatformRunnerKey({
      runnerId: runner.id,
      name: `platform-runner-${runner.name}`.slice(0, 100),
      scopes: PLATFORM_RUNNER_KEY_SCOPES,
      createdBy: owner.sub || null,
    });
    try {
      // Retire the previous key/grants before publishing the new one so a
      // failed update cannot leave live system credentials behind. Existing
      // connector instances are obsolete immediately: mark them offline and
      // clear live readiness so no old worker can look connected/ready.
      await revokePlatformRunnerKeyViaIam(runner.api_key_id);
      await revokeExecutionDelegationsViaIam({ runnerId: runner.id });
      await markRunnerInstancesOffline(runner.id);
      const updated = await updateRunnerRec(runner.id, {
        api_key_id: key.id,
        key_prefix: key.prefix,
        status: 'waiting',
        metadata: {
          ...staleRunnerLiveMetadata(runner.metadata, 'runner key rotated; awaiting a new connector heartbeat'),
          keyRotatedAt: new Date().toISOString(),
        },
      });
      if (!updated) throw httpError(503, 'runner_persist_failed', 'runner registration disappeared during key rotation');
      const instances = await listRunnerInstances(updated.id);
      res.setHeader('Cache-Control', 'no-store');
      res.json(platformRunnerPayload(updated, instances, key.value));
    } catch (e: any) {
      await revokePlatformRunnerKeyViaIam(key.id).catch(() => undefined);
      if (e?.status) {
        return res.status(e.status).json({ error: e.code || 'runner_key_unavailable', message: String(e.message || 'cannot rotate the platform runner key') });
      }
      throw e;
    }
  });

  app.post('/v1/platform/runners/:id/command', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const apiKey = typeof (req.body || {}).apiKey === 'string' ? (req.body as any).apiKey : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      command: runnerCommand(runner, apiKey),
      apiBaseUrl: runnerPublicUrl(),
      queue: runner.queue,
      mode: runner.mode,
      hasApiKey: !!apiKey,
      options: runnerOptions(),
    });
  });

  app.post('/v1/platform/runners/:id/test', async (req, res) => {
    const owner = await requirePlatformOwner(req, res);
    if (!owner) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    if (runner.status === 'disabled') {
      return res.status(409).json({ error: 'runner_disabled', message: 'enable the runner before testing it' });
    }
    const instances = await listRunnerInstances(runner.id);
    const api = toApiRunner(runner, instances);
    if (!api.connected) {
      return res.status(409).json({
        error: 'runner_offline',
        message: 'no connector instance is online',
        status: api.status,
        instances: api.instances,
      });
    }
    const b = (req.body || {}) as any;
    const type = String(b.type || (runner.kind === 'workflow' ? 'workflow' : 'embeddings')).trim().toLowerCase();
    if (!['workflow', 'embeddings', 'decision', 'route'].includes(type)) {
      return res.status(400).json({ error: 'invalid_type', message: 'type must be workflow|embeddings|decision|route' });
    }
    if (type === 'workflow' && runner.kind === 'inference') {
      return res.status(409).json({ error: 'runner_kind', message: 'this runner has no workflow lane' });
    }
    if (type !== 'workflow' && runner.kind === 'workflow') {
      return res.status(409).json({ error: 'runner_kind', message: 'this runner has no inference lane' });
    }
    if (resourceAdmissionMode() === 'enforce') {
      const freshTelemetry = instances.some((instance) => {
        const sample = instance.metadata?.resources;
        const sampledAt = Date.parse(String(sample?.sampledAt || ''));
        return instance.status === 'connected' && Number.isFinite(sampledAt)
          && Date.now() - sampledAt <= 45_000 && sampledAt - Date.now() <= 5000;
      });
      if (!freshTelemetry) return res.status(409).json({
        error: 'runner_resources_unavailable',
        message: 'This connector has no fresh CPU/RAM telemetry. Update it using the current Docker command, then wait for its next heartbeat before running a test.',
      });
    }
    if (type === 'workflow') {
      const wf = await createWorkflowRec({
        name: `__platform-runner-test-${runner.id.slice(0, 8)}`,
        nodes: [
          { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
          { id: 'set', name: 'Self test', type: 'n8n-nodes-base.set', parameters: { values: { selfTest: true } } },
        ],
        connections: { Start: { main: [[{ node: 'Self test' }]] } },
        settings: { execution: { mode: 'system' } },
        active: false,
        org_id: owner.orgId || null,
        account_id: null,
        owner_sub: owner.sub || null,
      });
      const now = new Date().toISOString();
      const execution = await createExecutionRec({
        workflow_id: wf.id,
        workflow_name: wf.name,
        status: 'queued',
        input: { selfTest: true, runnerId: runner.id },
        output: null,
        node_runs: [],
        error: null,
        triggered_by: 'test',
        principal: owner.orgId ? { sub: owner.sub, org: owner.orgId, kind: 'user', scopes: ['*'] } : null,
        actor: `platform-owner:${owner.sub}`,
        queue_name: DEFAULT_SYSTEM_QUEUE,
        runner: 'system',
        target_runner_id: runner.id,
        workflow_revision: wf.revision,
        resource_requirements: { ...DEFAULT_WORKFLOW_RESOURCES },
        startedAt: now,
        finishedAt: now,
      } as any);
      try {
        await ensureWorkflowQueue(DEFAULT_SYSTEM_QUEUE, null, {
          maxAttempts: queueMaxAttempts(),
          visibilityTimeoutSeconds: Math.max(60, queueVisibilitySeconds()),
        });
        await publishWorkflowRun(DEFAULT_SYSTEM_QUEUE, execution.id, null, {
          tenant: execution.principal
            ? (execution.principal.org ? `org:${execution.principal.org}` : execution.principal.account ? `account:${execution.principal.account}` : `user:${execution.principal.sub}`)
            : undefined,
        });
      } catch (e: any) {
        await finishExecutionRec(execution.id, {
          status: 'error',
          output: null,
          node_runs: [],
          error: `queue dispatch failed: ${String(e?.message || e).slice(0, 500)}`,
          finishedAt: new Date().toISOString(),
          targetRunnerId: runner.id,
          allowedStatuses: ['queued'],
        } as any).catch(() => null);
        return res.status(503).json({ error: 'queue_unavailable', message: String(e?.message || e) });
      }
      return res.status(202).json({
        ok: false,
        status: 'queued',
        type,
        jobId: execution.id,
        runnerId: null,
        targetRunnerId: runner.id,
        pollUrl: `/v1/platform/runners/${encodeURIComponent(runner.id)}/test/${encodeURIComponent(execution.id)}`,
        model: null,
        dimensions: null,
        vectorCount: null,
        error: null,
      });
    }

    const health = runner.metadata?.inferenceHealth;
    const capabilities = health && typeof health === 'object' && health.capabilities && typeof health.capabilities === 'object'
      ? health.capabilities
      : {};
    const capability = capabilities[type];
    if (!capability || capability.ready !== true) {
      return res.status(409).json({
        error: 'inference_not_ready',
        message: `the selected runner has not loaded the '${type}' model`,
        type,
        capabilities,
        lastError: health?.lastError || null,
      });
    }
    const payload: Record<string, any> = type === 'embeddings'
      ? { input: ['synapseone runner self-test'] }
      : type === 'decision'
        ? { state: 'synapseone runner self-test', questions: { health: { type: 'noul', instructions: 'Is the runner healthy?' } } }
        : { input: 'run a workflow', choices: { workflow: 'execute a workflow', inference: 'run a local model' }, instruction: 'Pick the best destination' };
    const job = await createInferenceJobRec({
      type,
      request: payload,
      org_id: null,
      account_id: null,
      queue_name: DEFAULT_SYSTEM_INFERENCE_QUEUE,
      target_runner_id: runner.id,
      resource_requirements: { ...DEFAULT_INFERENCE_RESOURCES },
    } as any);
    try {
      await ensureWorkflowQueue(DEFAULT_SYSTEM_INFERENCE_QUEUE, null, {
        maxAttempts: queueMaxAttempts(),
        visibilityTimeoutSeconds: Math.max(60, queueVisibilitySeconds()),
      });
      await publishInferenceJob(DEFAULT_SYSTEM_INFERENCE_QUEUE, job.id, null);
    } catch (e: any) {
      await setInferenceJobError(job.id, `queue dispatch failed: ${String(e?.message || e).slice(0, 500)}`).catch(() => null);
      return res.status(503).json({ error: 'queue_unavailable', message: String(e?.message || e) });
    }
    return res.status(202).json({
      ok: false,
      status: 'queued',
      type,
      jobId: job.id,
      runnerId: null,
      targetRunnerId: runner.id,
      pollUrl: `/v1/platform/runners/${encodeURIComponent(runner.id)}/test/${encodeURIComponent(job.id)}`,
      model: capability.model || null,
      dimensions: null,
      vectorCount: null,
      error: null,
    });
  });

  app.get('/v1/platform/runners/:id/test/:jobId', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const jobId = String(req.params.jobId || '');
    if (!jobId || jobId.length > 128 || /[\r\n]/.test(jobId)) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    const execution = await getExecutionRec(jobId);
    if (execution) {
      if ((execution as any).target_runner_id !== runner.id) {
        return res.status(404).json({ error: 'not_found' });
      }
      const result = execution.output && typeof execution.output === 'object' ? execution.output : null;
      const terminal = execution.status === 'success' || execution.status === 'error';
      if (terminal) {
        // The synthetic test workflow is single-use; remove it once the run
        // is terminal. The execution row is retained for audit/history.
        await deleteWorkflowRec(execution.workflow_id).catch(() => false);
      }
      const actualRunnerId = execution.worker_id || null;
      const ok = terminal
        && execution.status === 'success'
        && actualRunnerId === runner.id;
      return res.json({
        ok,
        status: execution.status,
        type: 'workflow',
        jobId: execution.id,
        runnerId: actualRunnerId,
        targetRunnerId: runner.id,
        model: null,
        dimensions: null,
        vectorCount: null,
        output: result,
        error: execution.error || null,
        ...(terminal ? {} : { pollUrl: `/v1/platform/runners/${encodeURIComponent(runner.id)}/test/${encodeURIComponent(execution.id)}` }),
      });
    }
    const job = await getInferenceJobRec(jobId);
    if (!job || (job as any).target_runner_id !== runner.id) {
      return res.status(404).json({ error: 'not_found' });
    }
    const result = job.result && typeof job.result === 'object' ? job.result : null;
    const vectorCount = result && Array.isArray(result.data) ? result.data.length : null;
    const dimensions = result?.data?.[0]?.embedding?.length || null;
    const terminal = job.status === 'success' || job.status === 'error' || job.status === 'cancelled';
    const actualRunnerId = job.runner_id || null;
    const ok = terminal
      && job.status === 'success'
      && actualRunnerId === runner.id;
    return res.json({
      ok,
      status: job.status,
      type: job.type,
      jobId: job.id,
      runnerId: actualRunnerId,
      targetRunnerId: runner.id,
      model: result?.model || null,
      dimensions,
      vectorCount,
      result,
      error: job.error || null,
      ...(terminal ? {} : { pollUrl: `/v1/platform/runners/${encodeURIComponent(runner.id)}/test/${encodeURIComponent(job.id)}` }),
    });
  });

  app.get('/v1/platform/runners/:id/connection', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const instances = await listRunnerInstances(runner.id);
    const api = toApiRunner(runner, instances);
    res.json({
      connected: api.connected,
      status: api.status,
      checkedAt: new Date().toISOString(),
      runner: api,
      instances: api.instances,
      instanceCount: api.instanceCount,
      connectedInstances: api.connectedInstances,
      lastSeenAt: api.lastSeenAt,
      queue: runner.queue,
      mode: runner.mode,
      version: api.version,
      lastError: runner.last_error,
      heartbeatIntervalSeconds: runnerHeartbeatSeconds(),
      staleAfterSeconds: runnerStaleAfterSeconds(),
    });
  });

  app.delete('/v1/platform/runners/:id/instances/:instanceId', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    const instanceId = String(req.params.instanceId || '');
    if (!instanceId || instanceId.length > 128 || /[\r\n]/.test(instanceId)) return res.status(400).json({ error: 'invalid_instance' });
    const deleted = await deleteRunnerInstance(runner.id, instanceId);
    if (!deleted) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, runnerId: runner.id, instanceId, deleted: true });
  });

  app.delete('/v1/platform/runners/:id', async (req, res) => {
    if (!(await requirePlatformOwner(req, res))) return;
    const runner = await platformRunnerById(String(req.params.id || ''));
    if (!runner) return res.status(404).json({ error: 'not_found', message: 'platform runner not found' });
    // Revoke every key for the runner first: an orphaned system credential
    // could still touch the platform queue if deletion succeeded alone.
    await revokeAllPlatformRunnerKeysViaIam(runner.id);
    await revokeExecutionDelegationsViaIam({ runnerId: runner.id });
    const active = await countActiveExecutionsForRunner(runner.id, runner.queue, false);
    if (active > 0) {
      return res.status(409).json({
        error: 'runner_has_active_executions',
        message: `drain or cancel ${active} queued/running execution(s) before deleting this runner`,
        active,
      });
    }
    res.json({ ok: true, id: runner.id, scope: 'platform', deleted: await deleteRunnerRec(runner.id) });
  });

  // ---- inference jobs (inference / hybrid runners) ----
  const INFERENCE_JOB_TYPES = new Set(['chat', 'embeddings', 'decision', 'route', 'generic']);

  async function waitInferenceJob(id: string, timeoutMs = 120000): Promise<StoredInferenceJob | null> {
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 300000);
    let job = await getInferenceJobRec(id);
    while (job && (job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      job = await getInferenceJobRec(id);
    }
    return job;
  }

  /** Union of local-inference capabilities advertised by live platform
   *  runners. System inference jobs are rejected before they enter the queue
   *  when no connected runner has the requested real model loaded. */
  async function platformInferenceReadiness(): Promise<{
    onlineRunners: number;
    capabilities: Record<string, { ready: boolean; model?: string; reason?: string }>;
  }> {
    const runners = await listRunnerRecs({ scope: 'platform', limit: 100 });
    const instances = await listRunnerInstancesForRunners(runners.map((r) => r.id));
    const byRunner = new Map<string, StoredRunnerInstance[]>();
    for (const inst of instances) {
      const list = byRunner.get(inst.runner_id) || [];
      list.push(inst);
      byRunner.set(inst.runner_id, list);
    }
    const capabilities: Record<string, { ready: boolean; model?: string; reason?: string }> = {};
    let onlineRunners = 0;
    for (const runner of runners) {
      if (runner.status === 'disabled') continue;
      if (runner.kind !== 'inference' && runner.kind !== 'hybrid') continue;
      const status = runnerStatus(runner, byRunner.get(runner.id) || []);
      if (!status.connected) continue;
      onlineRunners += 1;
      const health = runner.metadata?.inferenceHealth;
      const caps = health && typeof health === 'object' && health.capabilities && typeof health.capabilities === 'object'
        ? health.capabilities
        : {};
      for (const [type, cap] of Object.entries(caps)) {
        if (!cap || typeof cap !== 'object' || (cap as any).ready !== true) continue;
        if (!capabilities[type] || !capabilities[type].ready) {
          capabilities[type] = {
            ready: true,
            ...(typeof (cap as any).model === 'string' ? { model: (cap as any).model } : {}),
          };
        }
      }
    }
    return { onlineRunners, capabilities };
  }

  app.post('/v1/inference-jobs', async (req, res) => {
    const principal = principalFromHeaders(req);
    if (!principal) return res.status(401).json({ error: 'unauthenticated', message: 'a verified principal is required' });
    const b = (req.body || {}) as any;
    const type = String(b.type || 'chat');
    if (!INFERENCE_JOB_TYPES.has(type)) {
      return res.status(400).json({ error: 'invalid_type', message: `type must be ${[...INFERENCE_JOB_TYPES].join('|')}` });
    }
    const request = b.payload !== undefined ? b.payload : b.input !== undefined ? b.input : b.request;
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return res.status(400).json({ error: 'invalid_payload', message: 'payload must be a JSON object' });
    }
    let bodySize = 0;
    try { bodySize = Buffer.byteLength(JSON.stringify(request), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_payload' }); }
    if (bodySize > 200 * 1024) return res.status(413).json({ error: 'payload_too_large', message: 'payload ≤200KB' });
    const queue = String(b.queue || DEFAULT_INFERENCE_QUEUE).trim();
    if (!isQueueName(queue)) return res.status(400).json({ error: 'invalid_queue' });
    const requirements = normalizeResourceRequirements(b.resources, DEFAULT_INFERENCE_RESOURCES);
    if (requirements.error) return res.status(400).json({ error: 'invalid_resources', message: requirements.error });
    // System inference jobs are only accepted when a live platform runner has
    // the requested real model ready. This prevents a job that the local
    // worker cannot execute from being acked later without a terminal record.
    if (queue === DEFAULT_SYSTEM_INFERENCE_QUEUE) {
      const readiness = await platformInferenceReadiness();
      const capability = readiness.capabilities[type];
      if (!capability || capability.ready !== true) {
        return res.status(409).json({
          error: 'inference_unavailable',
          message: `no connected platform runner has the '${type}' model ready`,
          type,
          onlineRunners: readiness.onlineRunners,
          capabilities: readiness.capabilities,
        });
      }
    }
    const job = await createInferenceJobRec({
      type,
      request,
      org_id: principal.org || null,
      account_id: principal.account || null,
      queue_name: queue,
      resource_requirements: requirements.value,
    } as any);
    try {
      await ensureWorkflowQueue(queue, principal, {
        maxAttempts: queueMaxAttempts(),
        visibilityTimeoutSeconds: Math.min(Math.max(Number(b.visibilityTimeoutSeconds) || 300, 30), 3600),
      });
      await publishInferenceJob(queue, job.id, queuePrincipalForInferenceQueue(queue, principal));
    } catch (e: any) {
      await setInferenceJobError(job.id, `queue dispatch failed: ${String(e?.message || e).slice(0, 500)}`).catch(() => null);
      return res.status(503).json({ error: 'queue_unavailable', message: String(e?.message || e) });
    }
    const wait = b.wait === true || b.wait === '1' || b.wait === 'true' || req.query.wait === '1' || req.query.wait === 'true';
    if (wait) {
      const final = await waitInferenceJob(job.id, Number(b.timeoutMs || req.query.timeoutMs) || 120000);
      if (!final) return res.status(202).json({ ok: true, jobId: job.id, status: 'queued', queue });
      return res.status(final.status === 'success' ? 200 : 500).json({
        ok: final.status === 'success',
        jobId: final.id,
        status: final.status,
        result: final.result,
        ...(final.error ? { error: final.error } : {}),
      });
    }
    res.status(202).json({ ok: true, jobId: job.id, status: 'queued', queue, type });
  });

  app.get('/v1/inference-jobs', async (req, res) => {
    const principal = principalFromHeaders(req);
    const scope = humanTaskScope(principal);
    if (scope === null) return res.status(403).json({ error: 'tenant_required' });
    const q = req.query as any;
    const jobs = await listInferenceJobRecs({
      ...scope,
      status: q.status ? String(q.status) : undefined,
      limit: Number(q.limit) || 20,
    });
    res.json({ data: jobs.map((j) => toApiInferenceJob(j)) });
  });

  app.get('/v1/inference-jobs/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const job = await getInferenceJobRec(id);
    if (!job || !canAccessInferenceJob(job, principalFromHeaders(req))) return res.status(404).json({ error: 'not_found' });
    res.json(toApiInferenceJob(job, (req.query as any).includeData === 'true'));
  });

  async function inferenceJobForRunner(req: any, res: any, opts: { requireRunning?: boolean } = {}): Promise<{
    runner: StoredWorkflowRunner;
    job: StoredInferenceJob;
    instanceId: string;
    attempt: number | null;
  } | null> {
    const runner = await loadRunnerForProtocol(req, res);
    if (!runner) return null;
    if (runner.kind !== 'inference' && runner.kind !== 'hybrid') {
      res.status(403).json({ error: 'runner_kind', message: `runner kind '${runner.kind}' cannot claim inference jobs` });
      return null;
    }
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return null;
    }
    const body = (req.body || {}) as any;
    const instanceIdRaw = body.instanceId !== undefined || body.instance_id !== undefined
      ? String(body.instanceId ?? body.instance_id).trim()
      : '';
    if (!instanceIdRaw || instanceIdRaw.length > 128) {
      res.status(400).json({ error: 'fencing_required', message: 'instanceId is required on every inference job call' });
      return null;
    }
    const instanceId = instanceIdRaw;
    const attempt = positiveAttempt(body.attempt);
    if (opts.requireRunning && attempt === null) {
      res.status(400).json({ error: 'fencing_required', message: 'attempt must be a positive integer on every inference job mutation' });
      return null;
    }
    const job = await getInferenceJobRec(id);
    const platformRunner = runner.scope === 'platform';
    if (!job || (!platformRunner && !canAccessInferenceJob(job, principalFromHeaders(req)))) {
      res.status(404).json({ error: 'not_found', message: 'inference job not found' });
      return null;
    }
    if (!platformRunner && !runnerAudienceAllows(runner, {
      principal: job.org_id || job.account_id
        ? { sub: '', org: job.org_id || undefined, account: job.account_id || undefined }
        : null,
    })) {
      return res.status(403).json({
        error: 'runner_audience',
        message: 'this runner is not authorized for the inference job tenant',
      });
    }
    const expectedQueue = runner.scope === 'platform'
      ? DEFAULT_SYSTEM_INFERENCE_QUEUE
      : (runner.inference_queue || DEFAULT_INFERENCE_QUEUE);
    if (job.queue_name !== expectedQueue) {
      res.status(403).json({ error: 'runner_mismatch', message: `job belongs to queue '${job.queue_name || '-'}'` });
      return null;
    }
    const targetRunnerId = (job as any).target_runner_id;
    if (targetRunnerId && targetRunnerId !== runner.id) {
      res.status(409).json({
        error: 'runner_not_target',
        message: 'this inference job is targeted at another runner registration; requeue it',
      });
      return null;
    }
    if (opts.requireRunning) {
      if (
        job.status !== 'running'
        || job.runner_id !== runner.id
        || job.instance_id !== instanceId
        || job.attempt !== attempt
      ) {
        res.status(409).json({ error: 'not_claimed', message: 'inference job is not claimed by this runner instance/attempt' });
        return null;
      }
    }
    return { runner, job, instanceId, attempt };
  }

  app.post('/v1/runner/inference/jobs/:id/claim', async (req, res) => {
    const ctx = await inferenceJobForRunner(req, res);
    if (!ctx) return;
    // Per-registration readiness is mandatory: a mixed embedding-only /
    // decision-only fleet must not claim a type it cannot run. Submission-time
    // global availability is not sufficient.
    if (ctx.runner.scope === 'platform') {
      const health = ctx.runner.metadata?.inferenceHealth;
      const capabilities = health && typeof health === 'object' && health.capabilities && typeof health.capabilities === 'object'
        ? health.capabilities
        : {};
      const capability = capabilities[ctx.job.type];
      if (!capability || capability.ready !== true) {
        return res.status(409).json({
          error: 'runner_capability_unavailable',
          message: `this runner has not loaded the '${ctx.job.type}' model`,
          type: ctx.job.type,
          capabilities,
          lastError: health?.lastError || null,
        });
      }
    }
    const b = (req.body || {}) as any;
    const instanceId = ctx.instanceId;
    const leaseSeconds = Math.min(Math.max(Number(b.leaseSeconds) || 300, 15), 3600);
    const required = storedResourceRequirements((ctx.job as any).resource_requirements, DEFAULT_INFERENCE_RESOURCES);
    const claimInstances = await listRunnerInstances(ctx.runner.id);
    const claimInstance = claimInstances.find((item) => item.id === instanceId);
    const admission = runnerResourceAdmission(
      ctx.runner,
      claimInstance?.metadata?.resources,
      required,
      runnerHeartbeatMaxAgeMs(claimInstance?.metadata),
    );
    if (admission) return res.status(409).json(admission);
    let claimed: StoredInferenceJob | null = null;
    try {
      claimed = await claimInferenceJobRec(ctx.job.id, {
        runnerId: ctx.runner.id,
        instanceId,
        leaseSeconds,
        enforceCapacity: resourceAdmissionMode() === 'enforce' && ctx.runner.scope === 'platform',
      } as any);
    } catch (e: any) {
      if (e?.status === 409) {
        return res.status(409).json({
          error: e.code || 'runner_capacity_unavailable',
          message: String(e.message || 'runner capacity admission failed'),
          ...(e.required ? { required: e.required } : {}),
          ...(e.available ? { available: e.available } : {}),
        });
      }
      throw e;
    }
    if (!claimed) {
      const current = await getInferenceJobRec(ctx.job.id);
      if (
        !current
        || current.status !== 'running'
        || current.runner_id !== ctx.runner.id
        || (instanceId && current.instance_id && current.instance_id !== instanceId)
      ) {
        return res.status(409).json({ error: 'not_claimable', message: 'inference job is already claimed or finished' });
      }
      await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
      return res.json({
        jobId: current.id, type: current.type, request: current.request,
        attempt: current.attempt, leaseExpiresAt: current.lease_expires_at,
      });
    }
    await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      jobId: claimed.id,
      type: claimed.type,
      request: claimed.request,
      attempt: claimed.attempt,
      leaseExpiresAt: claimed.lease_expires_at,
    });
  });

  app.post('/v1/runner/inference/jobs/:id/heartbeat', async (req, res) => {
    const ctx = await inferenceJobForRunner(req, res, { requireRunning: true });
    if (!ctx) return;
    const leaseSeconds = Math.min(Math.max(Number((req.body || {}).leaseSeconds) || 300, 15), 3600);
    const updated = await heartbeatInferenceJobRec(ctx.job.id, {
      runnerId: ctx.runner.id,
      instanceId: ctx.instanceId,
      attempt: ctx.attempt || undefined,
      leaseSeconds,
    });
    if (!updated) return res.status(409).json({ error: 'not_running' });
    await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
    res.json({ ok: true, leaseExpiresAt: updated.lease_expires_at });
  });

  app.post('/v1/runner/inference/jobs/:id/complete', async (req, res) => {
    const ctx = await inferenceJobForRunner(req, res, { requireRunning: true });
    if (!ctx) return;
    const b = (req.body || {}) as any;
    const status = b.status === 'success' ? 'success' : b.status === 'error' ? 'error' : null;
    if (!status) return res.status(400).json({ error: 'invalid_status', message: 'status must be success|error' });
    const finished = await finishInferenceJobRec(ctx.job.id, {
      status,
      result: b.result ?? null,
      error: b.error ? String(b.error).slice(0, 2000) : null,
      runnerId: ctx.runner.id,
      instanceId: ctx.instanceId,
      attempt: ctx.attempt || undefined,
    });
    if (!finished) return res.status(409).json({ error: 'already_finished' });
    recordRun(ctx.runner.kind === 'hybrid' ? 'runner-hybrid-inference' : 'runner-inference', finished.status);
    await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
    res.json({ ok: true, jobId: finished.id, status: finished.status });
  });

  app.post('/v1/runner/inference/jobs/:id/release', async (req, res) => {
    const ctx = await inferenceJobForRunner(req, res);
    if (!ctx) return;
    const released = await releaseInferenceJobRec(ctx.job.id, {
      runnerId: ctx.runner.id,
      instanceId: ctx.instanceId,
      error: (req.body || {}).error ? String((req.body || {}).error).slice(0, 1000) : undefined,
    });
    if (!released) return res.status(409).json({ error: 'not_releasable' });
    res.json({ ok: true, jobId: released.id, status: released.status });
  });

  // ---- runner job protocol (runner-key authenticated) ----
  async function loadRunnerForProtocol(req: any, res: any): Promise<StoredWorkflowRunner | null> {
    const runnerId = runnerForRequest(req, res, undefined, false);
    if (!runnerId) return null;
    const runner = await getRunnerRec(runnerId);
    const principal = principalFromHeaders(req);
    if (!runner) {
      res.status(404).json({ error: 'not_found', message: 'runner not found' });
      return null;
    }
    if (runner.status === 'disabled') {
      res.status(409).json({ error: 'runner_disabled', message: 'runner is disabled by the platform owner' });
      return null;
    }
    if (principal?.kind === 'platform-runner') {
      if (runner.scope !== 'platform' || principal.runnerId !== runner.id) {
        res.status(404).json({ error: 'not_found', message: 'runner not found' });
        return null;
      }
      return runner;
    }
    if (!canAccessRunner(runner, principal)) {
      res.status(404).json({ error: 'not_found', message: 'runner not found' });
      return null;
    }
    return runner;
  }

  async function runnerJob(req: any, res: any, opts: { requireRunning?: boolean } = {}): Promise<{
    runner: StoredWorkflowRunner;
    execution: StoredExecution;
    instanceId: string;
    attempt: number | null;
  } | null> {
    const runner = await loadRunnerForProtocol(req, res);
    if (!runner) return null;
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return null;
    }
    const body = (req.body || {}) as any;
    const instanceIdRaw = body.instanceId !== undefined || body.instance_id !== undefined
      ? String(body.instanceId ?? body.instance_id).trim()
      : '';
    if (!instanceIdRaw || instanceIdRaw.length > 128) {
      res.status(400).json({
        error: 'fencing_required',
        message: 'instanceId is required on every runner job call',
      });
      return null;
    }
    const instanceId = instanceIdRaw;
    const attempt = positiveAttempt(body.attempt);
    if (opts.requireRunning && attempt === null) {
      res.status(400).json({
        error: 'fencing_required',
        message: 'attempt must be a positive integer on every runner job mutation',
      });
      return null;
    }
    const execution = await getExecutionRec(id);
    const principal = principalFromHeaders(req);
    const platformRunner = runner.scope === 'platform';
    if (!execution || (!platformRunner && !canAccessExecution(execution, principal))) {
      res.status(404).json({ error: 'not_found', message: 'execution not found' });
      return null;
    }
    if (!platformRunner && !runnerAudienceAllows(runner, execution)) {
      return res.status(403).json({
        error: 'runner_audience',
        message: 'this runner is not authorized for the execution tenant',
      });
    }
    if (!platformRunner) {
      const workflow = await getWorkflowRec(execution.workflow_id);
      if (workflow?.settings?.access !== undefined && !canAccessWorkflow(workflow, principal)) {
        res.status(404).json({ error: 'not_found', message: 'execution not found' });
        return null;
      }
    }
    if (!execution.queue_name || execution.queue_name !== runner.queue || execution.runner !== runner.mode) {
      res.status(403).json({ error: 'runner_mismatch', message: `execution belongs to queue '${execution.queue_name || '-'}' / mode '${execution.runner || '-'}'` });
      return null;
    }
    const targetRunnerId = (execution as any).target_runner_id;
    if (targetRunnerId && targetRunnerId !== runner.id) {
      res.status(409).json({
        error: 'runner_not_target',
        message: 'this run is targeted at another runner registration; requeue it',
      });
      return null;
    }
    if (opts.requireRunning) {
      if (
        execution.status !== 'running'
        || execution.worker_id !== runner.id
        || execution.runner_instance_id !== instanceId
        || execution.attempt !== attempt
      ) {
        res.status(409).json({ error: 'not_claimed', message: 'execution is not claimed by this runner instance/attempt' });
        return null;
      }
    }
    return { runner, execution, instanceId, attempt };
  }

  app.post('/v1/runner/jobs/:id/claim', async (req, res) => {
    const ctx = await runnerJob(req, res);
    if (!ctx) return;
    const leaseSeconds = Math.min(Math.max(Number((req.body || {}).leaseSeconds) || queueVisibilitySeconds(), 15), 3600);
    const required = storedResourceRequirements((ctx.execution as any).resource_requirements, DEFAULT_WORKFLOW_RESOURCES);
    const claimInstances = await listRunnerInstances(ctx.runner.id);
    const claimInstance = claimInstances.find((item) => item.id === ctx.instanceId);
    const admission = runnerResourceAdmission(
      ctx.runner,
      claimInstance?.metadata?.resources,
      required,
      runnerHeartbeatMaxAgeMs(claimInstance?.metadata),
    );
    if (admission) return res.status(409).json(admission);
    let claimed: StoredExecution | null = null;
    try {
      claimed = await claimExecutionRec(ctx.execution.id, {
        workerId: ctx.runner.id,
        instanceId: ctx.instanceId,
        leaseSeconds,
        enforceCapacity: resourceAdmissionMode() === 'enforce' && ctx.runner.scope === 'platform',
      } as any);
    } catch (e: any) {
      if (e?.status === 409) {
        return res.status(409).json({
          error: e.code || 'runner_capacity_unavailable',
          message: String(e.message || 'runner capacity admission failed'),
          ...(e.required ? { required: e.required } : {}),
          ...(e.available ? { available: e.available } : {}),
        });
      }
      throw e;
    }
    if (!claimed) {
      // Idempotent re-claim: a retried HTTP request after a lost response must
      // get the same job back instead of orphaning an already-running run.
      // A different connector instance of the same registration is fenced out.
      const current = await getExecutionRec(ctx.execution.id);
      if (
        current
        && current.status === 'running'
        && current.worker_id === ctx.runner.id
        && (!ctx.instanceId || current.runner_instance_id === ctx.instanceId)
      ) claimed = current;
    }
    if (!claimed) return res.status(409).json({ error: 'not_claimable', message: 'execution is already claimed or finished' });
    const wf = await getWorkflowRec(claimed.workflow_id);
    if (!wf) {
      await finishExecutionRec(claimed.id, {
        status: 'error', output: null, node_runs: [],
        error: `workflow '${claimed.workflow_id}' no longer exists`,
        finishedAt: new Date().toISOString(), workerId: ctx.runner.id,
        instanceId: ctx.instanceId, attempt: claimed.attempt, allowedStatuses: ['running'],
      });
      return res.status(410).json({ error: 'workflow_not_found' });
    }
    // A queued run must never silently adopt a newer workflow definition.
    // Check after claiming, before returning any executable graph to a runner.
    if (claimed.workflow_revision != null && claimed.workflow_revision !== wf.revision) {
      await finishExecutionRec(claimed.id, {
        status: 'error', output: null, node_runs: [],
        error: 'workflow revision changed after this execution was queued; submit a new execution',
        finishedAt: new Date().toISOString(), workerId: ctx.runner.id,
        instanceId: ctx.instanceId, attempt: claimed.attempt, allowedStatuses: ['running'],
      });
      return res.status(409).json({ error: 'workflow_revision_conflict', message: 'queued workflow revision is no longer available' });
    }
    // System runners hold no user token. Give them one short-lived delegated
    // token for exactly this execution, carrying the original tenant/scopes.
    let delegation: { token: string; expiresIn: number; scopes: string[] } | null = null;
    if (ctx.runner.scope === 'platform') {
      if (!claimed.principal?.sub) {
        await releaseExecutionRec(claimed.id, {
          workerId: ctx.runner.id,
          instanceId: ctx.instanceId,
          attempt: claimed.attempt,
          error: 'system execution has no tenant principal to delegate',
        }).catch(() => null);
        return res.status(409).json({
          error: 'principal_required',
          message: 'system-mode execution has no tenant principal; re-submit it from an authenticated caller',
        });
      }
      try {
        const graphScopes = delegationScopesForPrincipal(
          claimed.principal,
          executionDataPlaneScopes({ nodes: wf.nodes, connections: wf.connections }),
        );
        delegation = await mintExecutionDelegation({
          runnerId: ctx.runner.id,
          instanceId: ctx.instanceId || 'unknown',
          executionId: claimed.id,
          principal: claimed.principal,
          scopes: graphScopes,
          ttlSeconds: delegationTtlForLease(claimed.lease_expires_at),
        });
      } catch (e: any) {
        await releaseExecutionRec(claimed.id, {
          workerId: ctx.runner.id,
          instanceId: ctx.instanceId,
          attempt: claimed.attempt,
          error: String(e?.message || e).slice(0, 1000),
        }).catch(() => null);
        return res.status(e?.status || 503).json({
          error: e?.code || 'delegation_unavailable',
          message: String(e?.message || 'cannot mint the execution delegation'),
        });
      }
    }
    await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      executionId: claimed.id,
      workflow: {
        id: wf.id, name: wf.name, revision: wf.revision,
        nodes: wf.nodes, connections: wf.connections, settings: wf.settings,
      },
      input: claimed.input,
      principal: claimed.principal || null,
      triggeredBy: claimed.triggered_by,
      attempt: claimed.attempt,
      leaseExpiresAt: claimed.lease_expires_at,
      resumeFrom: claimed.resume_node ? { node: claimed.resume_node, output: claimed.resume_output } : null,
      ...(delegation
        ? {
            delegatedToken: delegation.token,
            delegatedTokenExpiresIn: delegation.expiresIn,
            delegatedScopes: delegation.scopes,
          }
        : {}),
    });
  });

  app.post('/v1/runner/jobs/:id/delegate', async (req, res) => {
    const ctx = await runnerJob(req, res, { requireRunning: true });
    if (!ctx) return;
    if (ctx.runner.scope !== 'platform') {
      return res.status(403).json({ error: 'platform_runner_required', message: 'only platform runners use execution delegation' });
    }
    if (!ctx.execution.principal?.sub) {
      return res.status(409).json({ error: 'principal_required', message: 'execution has no tenant principal' });
    }
    if (!ctx.execution.lease_expires_at || new Date(ctx.execution.lease_expires_at).getTime() <= Date.now()) {
      return res.status(409).json({ error: 'not_running', message: 'execution lease is no longer live' });
    }
    try {
      await revokeExecutionDelegationsViaIam({ executionId: ctx.execution.id });
      const wf = await getWorkflowRec(ctx.execution.workflow_id);
      if (!wf) return res.status(404).json({ error: 'workflow_not_found' });
      if (ctx.execution.workflow_revision != null && ctx.execution.workflow_revision !== wf.revision) {
        return res.status(409).json({ error: 'workflow_revision_conflict', message: 'the execution graph changed since it was queued' });
      }
      const graphScopes = delegationScopesForPrincipal(
        ctx.execution.principal,
        executionDataPlaneScopes({ nodes: wf.nodes, connections: wf.connections }),
      );
      if (!graphScopes.length) {
        return res.status(409).json({ error: 'no_data_scopes', message: 'this execution graph does not declare any data-plane operations' });
      }
      const delegation = await mintExecutionDelegation({
        runnerId: ctx.runner.id,
        instanceId: ctx.instanceId,
        executionId: ctx.execution.id,
        principal: ctx.execution.principal,
        scopes: graphScopes,
        ttlSeconds: delegationTtlForLease(ctx.execution.lease_expires_at),
      });
      if (!delegation) return res.status(409).json({ error: 'principal_required' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        accessToken: delegation.token,
        expiresIn: delegation.expiresIn,
        delegatedScopes: delegation.scopes,
        jti: delegation.jti,
      });
    } catch (e: any) {
      return res.status(e?.status || 503).json({
        error: e?.code || 'delegation_unavailable',
        message: String(e?.message || 'cannot refresh execution delegation'),
      });
    }
  });

  app.post('/v1/runner/jobs/:id/heartbeat', async (req, res) => {
    const ctx = await runnerJob(req, res, { requireRunning: true });
    if (!ctx) return;
    const leaseSeconds = Math.min(Math.max(Number((req.body || {}).leaseSeconds) || queueVisibilitySeconds(), 15), 3600);
    const updated = await heartbeatExecutionRec(ctx.execution.id, {
      workerId: ctx.runner.id,
      instanceId: ctx.instanceId,
      attempt: ctx.attempt || undefined,
      leaseSeconds,
    });
    if (!updated) return res.status(409).json({ error: 'not_running' });
    // Long runs receive a fresh short-lived execution grant on every validated
    // heartbeat. We deliberately do not revoke the previous grant here: an
    // in-flight node request may still use it, and it expires within the same
    // ≤300s lease window. Complete/release/disable/delete revoke all grants.
    let refreshedDelegation: { token: string; expiresIn: number; scopes: string[]; jti: string | null } | null = null;
    if (ctx.runner.scope === 'platform' && ctx.execution.principal?.sub) {
      try {
        const wf = await getWorkflowRec(ctx.execution.workflow_id);
        const graphScopes = wf
          ? delegationScopesForPrincipal(ctx.execution.principal, executionDataPlaneScopes({ nodes: wf.nodes, connections: wf.connections }))
          : [];
        if (graphScopes.length) {
          refreshedDelegation = await mintExecutionDelegation({
            runnerId: ctx.runner.id,
            instanceId: ctx.instanceId,
            executionId: ctx.execution.id,
            principal: ctx.execution.principal,
            scopes: graphScopes,
            ttlSeconds: delegationTtlForLease(updated.lease_expires_at),
          });
        }
      } catch (e: any) {
        // Keep the previous grant alive; the next heartbeat retries.
        console.warn(`[workflow] delegation refresh failed for ${ctx.execution.id}: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
    await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
    res.json({
      ok: true,
      leaseExpiresAt: updated.lease_expires_at,
      ...(refreshedDelegation
        ? {
            delegatedToken: refreshedDelegation.token,
            delegatedTokenExpiresIn: refreshedDelegation.expiresIn,
            delegatedScopes: refreshedDelegation.scopes,
            delegatedTokenJti: refreshedDelegation.jti,
          }
        : {}),
    });
  });

  app.post('/v1/runner/jobs/:id/release', async (req, res) => {
    const ctx = await runnerJob(req, res, { requireRunning: true });
    if (!ctx) return;
    const error = (req.body || {}).error ? String((req.body || {}).error).slice(0, 1000) : null;
    const released = await releaseExecutionRec(ctx.execution.id, {
      workerId: ctx.runner.id,
      instanceId: ctx.instanceId,
      attempt: ctx.attempt || undefined,
      error: error || undefined,
    });
    if (!released) return res.status(409).json({ error: 'not_releasable' });
    await revokeExecutionDelegationsViaIam({ executionId: ctx.execution.id });
    res.json({ ok: true, status: released.status });
  });

  app.post('/v1/runner/jobs/:id/credentials', async (req, res) => {
    const ctx = await runnerJob(req, res, { requireRunning: true });
    if (!ctx) return;
    const credentialId = String((req.body || {}).credentialId || '');
    if (!credentialId || credentialId.length > 128 || /[\r\n]/.test(credentialId)) {
      return res.status(400).json({ error: 'invalid_credential', message: 'credentialId is required' });
    }
    const rec = await getCredentialRec(credentialId);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const wf = await getWorkflowRec(ctx.execution.workflow_id);
    if (!wf) return res.status(404).json({ error: 'workflow_not_found' });
    // A queued execution must not resolve credentials from a newer graph.
    if (ctx.execution.workflow_revision != null && ctx.execution.workflow_revision !== wf.revision) {
      return res.status(409).json({ error: 'workflow_revision_conflict', message: 'the execution graph changed since it was queued' });
    }
    const declared = referencedCredentialIds({ nodes: wf.nodes, connections: wf.connections });
    if (!declared.has(credentialId)) return res.status(404).json({ error: 'not_found' });
    if (!credentialVisibleTo(rec, ctx.execution.principal || principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found' });
    }
    let secret: string;
    try {
      secret = decryptSecret(rec.secret_enc);
    } catch {
      return res.status(500).json({ error: 'decrypt_failed' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ credentialId: rec.id, kind: rec.kind, secret });
  });

  app.post('/v1/runner/jobs/:id/complete', async (req, res) => {
    const ctx = await runnerJob(req, res, { requireRunning: true });
    if (!ctx) return;
    const b = (req.body || {}) as any;
    const status = String(b.status || '');
    if (!['success', 'error', 'paused'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status', message: 'status must be success|error|paused' });
    }
    const output = b.output ?? null;
    const nodeRunsIn = Array.isArray(b.nodeRuns) ? b.nodeRuns.slice(0, 2000) : [];
    const nodeRuns = ctx.execution.resume_node
      ? [...(ctx.execution.node_runs || []), ...nodeRunsIn]
      : nodeRunsIn;
    const error = b.error ? String(b.error).slice(0, 2000) : null;
    if (status === 'paused') {
      const pause = b.pause && typeof b.pause === 'object' ? b.pause : null;
      if (!pause || !pause.node || !pause.task) {
        return res.status(400).json({ error: 'invalid_pause', message: 'pause.node and pause.task are required' });
      }
      const task = pause.task || {};
      const wf = await getWorkflowRec(ctx.execution.workflow_id);
      const createdTask = await createHumanTaskRec({
        execution_id: ctx.execution.id,
        workflow_id: ctx.execution.workflow_id,
        node_name: String(pause.node).slice(0, 128),
        title: String(task.title || 'Human approval').slice(0, 300),
        description: String(task.description || '').slice(0, 4000),
        assignee: task.assignee ? String(task.assignee).slice(0, 128) : null,
        candidate_roles: Array.isArray(task.candidateRoles) ? task.candidateRoles.map(String).slice(0, 20) : [],
        decision_schema: task.decisionSchema && typeof task.decisionSchema === 'object' ? task.decisionSchema : {},
        payload: task.payload && typeof task.payload === 'object' ? task.payload : {},
        deadline: task.deadline ? String(task.deadline) : null,
        org_id: ctx.execution.principal?.org || wf?.org_id || null,
        account_id: ctx.execution.principal?.account || wf?.account_id || null,
      });
      const paused = await pauseExecutionRec(ctx.execution.id, {
        output, node_runs: nodeRuns, error, workerId: ctx.runner.id,
        instanceId: ctx.instanceId, attempt: ctx.attempt || undefined,
        pauseTaskId: createdTask.id,
        pauseNode: String(pause.node),
      });
      if (!paused) return res.status(409).json({ error: 'not_running' });
      await revokeExecutionDelegationsViaIam({ executionId: ctx.execution.id });
      await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
      res.status(202).json({ ok: true, status: 'paused', execution: toApiExecution(paused, true) });
      return;
    }
    const finished = await finishExecutionRec(ctx.execution.id, {
      status: status === 'success' ? 'success' : 'error',
      output, node_runs: nodeRuns, error,
      finishedAt: new Date().toISOString(),
      workerId: ctx.runner.id,
      instanceId: ctx.instanceId,
      attempt: ctx.attempt || undefined,
      allowedStatuses: ['running'],
    });
    if (!finished) return res.status(409).json({ error: 'already_finished' });
    await revokeExecutionDelegationsViaIam({ executionId: ctx.execution.id });
    recordRun(ctx.execution.runner === 'hybrid' ? 'runner-hybrid' : 'runner-custom', finished.status, nodeRuns);
    await heartbeatRunnerRec(ctx.runner.id, { status: 'connected' }).catch(() => null);
    res.json({ ok: true, status: finished.status, execution: toApiExecution(finished, true) });
  });

  // Delete a workflow.
  app.delete('/v1/workflows/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (cur && !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    for (const status of ['queued', 'running', 'paused']) {
      const active = await listExecutionRecs({ workflowId: id, status, limit: 1 });
      if (active.items.length) {
        return res.status(409).json({
          error: 'workflow_has_active_executions',
          message: `cancel active ${status} executions before deleting this workflow`,
          status,
        });
      }
    }
    const ok = await deleteWorkflowRec(id);
    if (!ok) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json({ ok: true, id });
  });

  // ---------- credentials (P0-4): account-scoped secrets, encrypted at rest ----------
  // Nodes store only credentialIds; secrets are resolved server-side at run
  // time and never appear in nodeRuns, params or list responses. Credentials
  // are additionally org-bound (#5): org callers can only list/create/delete
  // credentials of their own org, and resolvers refuse foreign-org secrets.
  function credentialAccountScope(req: any, accountId: string): { ok: boolean; status?: number; error?: string; message?: string; orgId?: string | null } {
    const p = principalFromHeaders(req);
    if (!p) return { ok: true, orgId: null }; // anonymous direct calls (dev/tests)
    if (p.account) {
      if (p.account !== accountId) {
        return { ok: false, status: 403, error: 'cross_account', message: 'credential account is outside your own account' };
      }
      return { ok: true, orgId: null };
    }
    if (!p.org) {
      return { ok: false, status: 403, error: 'forbidden', message: 'caller has no tenant scope' };
    }
    return { ok: true, orgId: p.org };
  }

  /** Shared create/rotate secret validation (never echoed back). */
  function credentialSecretError(kind: string, secret: unknown): { error: string; message: string } | null {
    if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret, 'utf8') > 8 * 1024) {
      return { error: 'invalid_secret', message: 'secret must be 1..8KB' };
    }
    if (kind === 'basic') {
      try {
        const parsed = JSON.parse(secret);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).password !== 'string') {
          return { error: 'invalid_secret', message: 'basic secret must be JSON {username, password}' };
        }
      } catch {
        return { error: 'invalid_secret', message: 'basic secret must be JSON {username, password}' };
      }
    }
    return null;
  }

  /** Tenant check shared by read/delete/rotate of an existing credential. */
  function canAccessCredential(req: any, cur: StoredCredential): { ok: boolean; status?: number; error?: string; message?: string } {
    if (cur.owner_sub && !credentialVisibleTo(cur, principalFromHeaders(req))) {
      return { ok: false, status: 404, error: 'not_found', message: 'credential not found' };
    }
    const scope = credentialAccountScope(req, cur.account_id);
    if (!scope.ok) return scope;
    // Org-scoped callers may only touch credentials actually bound to their
    // org — legacy/anonymous credentials of unknown tenancy are off-limits.
    if (scope.orgId && (!cur.org_id || cur.org_id !== scope.orgId)) {
      return { ok: false, status: 403, error: 'cross_tenant', message: 'credential is outside your own org' };
    }
    return { ok: true };
  }

  const listCredentialsHandler = async (req: express.Request, res: express.Response) => {
    const q = req.query as any;
    const p = principalFromHeaders(req);
    const paramAcc = (req.params as any)?.accountId;
    const queryAcc = typeof q.accountId === 'string' ? q.accountId : undefined;
    const rawAcc = paramAcc || queryAcc;
    if (typeof rawAcc === 'string' && rawAcc.length > 128) {
      return res.status(400).json({ error: 'invalid_account', message: 'accountId must be 1..128 chars' });
    }
    const accountId = rawAcc || p?.account;
    if (accountId) {
      const scope = credentialAccountScope(req, accountId);
      if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
      const items = await listCredentialRecs(accountId, scope.orgId ?? undefined);
      return res.json({ data: items.filter((c) => credentialVisibleTo(c, p)).map(toPublicCredential) });
    }
    // No account scope: anonymous dev view only (never secret material).
    if (p) {
      return res.status(400).json({ error: 'account_required', message: 'pass ?accountId= (credentials are account-scoped)' });
    }
    const items = await listCredentialRecs();
    res.json({ data: items.filter((c) => credentialVisibleTo(c, p)).map(toPublicCredential) });
  };
  app.get('/v1/credentials', listCredentialsHandler);
  app.get('/v1/accounts/:accountId/credentials', listCredentialsHandler);

  const createCredentialHandler = async (req: express.Request, res: express.Response) => {
    const body = (req.body || {}) as any;
    const accountId = (req.params as any)?.accountId || body.accountId;
    const name = body.name;
    const rawKind = body.kind || body.type;
    const kind = rawKind === 'apiKey' ? 'api-key' : rawKind;
    const secret = body.secret;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\r\n]/.test(accountId)) {
      return res.status(400).json({ error: 'invalid_account', message: 'accountId must be 1..128 chars' });
    }
    const scope = credentialAccountScope(req, accountId);
    if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
    if (typeof name !== 'string' || !name || name.length > 100) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 chars' });
    }
    if (!['bearer', 'api-key', 'basic', 'hmac'].includes(kind)) {
      return res.status(400).json({ error: 'invalid_kind', message: 'kind must be bearer|api-key|basic|hmac' });
    }
    const secretErr = credentialSecretError(kind, secret);
    if (secretErr) return res.status(400).json(secretErr);
    try {
      const c = await createCredentialRec({
        account_id: accountId, org_id: scope.orgId ?? null,
        owner_sub: principalFromHeaders(req)?.sub ?? null, name, kind, secret,
      });
      res.status(201).json(toPublicCredential(c));
    } catch (e: any) {
      if ((e as any)?.code === 'conflict') return res.status(409).json({ error: 'conflict', message: (e as any).message });
      throw e;
    }
  };
  app.post('/v1/credentials', createCredentialHandler);
  app.post('/v1/accounts/:accountId/credentials', createCredentialHandler);

  // Read one credential's metadata (never the secret). Same tenant rules as
  // list/delete: account callers must own the account, org callers must own
  // the credential's org binding.
  app.get('/v1/credentials/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getCredentialRec(id);
    if (!cur) return res.status(404).json({ error: 'not_found', message: 'credential not found' });
    const access = canAccessCredential(req, cur);
    if (!access.ok) return res.status(access.status!).json({ error: access.error, message: access.message });
    res.json(toPublicCredential(cur));
  });

  // Rotate a credential's secret in place (keeps the id, name and kind so
  // workflows referencing credentialId keep working). The old secret stops
  // working immediately; the new one is write-only.
  app.post('/v1/credentials/:id/rotate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getCredentialRec(id);
    if (!cur) return res.status(404).json({ error: 'not_found', message: 'credential not found' });
    const access = canAccessCredential(req, cur);
    if (!access.ok) return res.status(access.status!).json({ error: access.error, message: access.message });
    const secretErr = credentialSecretError(cur.kind, (req.body || {}).secret);
    if (secretErr) return res.status(400).json(secretErr);
    const next = await rotateCredentialRec(id, (req.body || {}).secret);
    if (!next) return res.status(404).json({ error: 'not_found', message: 'credential not found' });
    res.json(toPublicCredential(next));
  });

  app.delete('/v1/credentials/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getCredentialRec(id);
    if (!cur) return res.status(404).json({ error: 'not_found', message: 'credential not found' });
    const access = canAccessCredential(req, cur);
    if (!access.ok) return res.status(access.status!).json({ error: access.error, message: access.message });
    await deleteCredentialRec(id);
    res.json({ ok: true, id });
  });

  // ---------- durable human tasks (#44) ----------
  app.post('/v1/human-tasks', async (req, res) => {
    const principal = principalFromHeaders(req);
    if (!principal) return res.status(401).json({ error: 'unauthenticated', message: 'a verified principal is required' });
    const b = (req.body || {}) as any;
    const title = String(b.title || '').trim();
    if (!title || title.length > 300) return res.status(400).json({ error: 'invalid_title', message: 'title is required (≤300 chars)' });
    const assignee = b.assignee ? String(b.assignee).slice(0, 128) : null;
    const candidateRoles = Array.isArray(b.candidateRoles) ? b.candidateRoles.map(String).slice(0, 20) : [];
    const deadline = b.deadline ? new Date(String(b.deadline)) : null;
    if (deadline && Number.isNaN(deadline.getTime())) return res.status(400).json({ error: 'invalid_deadline' });
    // A fabricated task must not become a back door for resuming another
    // principal's protected execution with the workflow owner's authority.
    let linkedWorkflowId = b.workflowId ? String(b.workflowId) : null;
    if (b.executionId) {
      const execution = await getExecutionRec(String(b.executionId));
      if (!execution || !await canReadExecution(execution, principal)) return res.status(404).json({ error: 'not_found' });
      // A paused execution already owns exactly one engine-created approval
      // checkpoint. Creating a second task here would let an org member forge
      // an approval and choose the resume node; standalone tasks are still
      // allowed for every non-paused execution.
      if (execution.status === 'paused') {
        return res.status(409).json({
          error: 'pause_checkpoint_exists',
          message: 'this execution is paused on an engine-created task; decide that task instead',
        });
      }
      if (linkedWorkflowId && linkedWorkflowId !== execution.workflow_id) return res.status(400).json({ error: 'workflow_mismatch' });
      linkedWorkflowId = execution.workflow_id;
    }
    if (linkedWorkflowId) {
      const workflow = await getWorkflowRec(linkedWorkflowId);
      if (!workflow || !canAccessWorkflow(workflow, principal)) return res.status(404).json({ error: 'not_found' });
    }
    if (!assignee && !candidateRoles.length) {
      return res.status(400).json({
        error: 'approver_required',
        message: 'a human task needs an explicit assignee or at least one candidateRoles entry',
      });
    }
    const task = await createHumanTaskRec({
      execution_id: b.executionId ? String(b.executionId) : null,
      workflow_id: linkedWorkflowId,
      node_name: b.node ? String(b.node) : 'manual',
      title,
      description: String(b.description || '').slice(0, 4000),
      assignee,
      candidate_roles: candidateRoles,
      decision_schema: b.decisionSchema && typeof b.decisionSchema === 'object' ? b.decisionSchema : {},
      payload: b.payload && typeof b.payload === 'object' ? b.payload : {},
      deadline: deadline ? deadline.toISOString() : null,
      org_id: principal.org || null,
      account_id: principal.account || null,
    });
    res.status(201).json({ task: toPublicHumanTask(task) });
  });

  app.get('/v1/human-tasks', async (req, res) => {
    const principal = principalFromHeaders(req);
    const scope = humanTaskScope(principal);
    if (scope === null) return res.status(403).json({ error: 'tenant_required' });
    const q = req.query as any;
    const items = await listHumanTaskRecs({
      status: q.status ? String(q.status) : undefined,
      executionId: q.executionId ? String(q.executionId) : undefined,
      workflowId: q.workflowId ? String(q.workflowId) : undefined,
      assignee: q.assignee ? String(q.assignee) : undefined,
      ...scope,
      limit: Number(q.limit) || 50,
      offset: Number(q.offset) || 0,
    });
    const visibility = await Promise.all(items.map((task) => canAccessHumanTask(task, principal)));
    const visible = items.filter((_task, i) => visibility[i]);
    res.json({ items: visible.map(toPublicHumanTask), total: visible.length });
  });

  app.get('/v1/human-tasks/:id', async (req, res) => {
    const task = await getHumanTaskRec(String(req.params.id || ''));
    const principal = principalFromHeaders(req);
    if (!task || !await canAccessHumanTask(task, principal)) return res.status(404).json({ error: 'not_found' });
    res.json({ task: toPublicHumanTask(task) });
  });

  app.post('/v1/human-tasks/:id/claim', async (req, res) => {
    const principal = principalFromHeaders(req);
    if (!principal) return res.status(401).json({ error: 'unauthenticated' });
    const task = await getHumanTaskRec(String(req.params.id || ''));
    if (!task || !await canAccessHumanTask(task, principal)) return res.status(404).json({ error: 'not_found' });
    if (!canActOnHumanTask(task, principal)) return res.status(403).json({ error: 'not_assignee' });
    if (task.status !== 'pending' && task.status !== 'claimed') return res.status(409).json({ error: 'task_not_claimable', status: task.status });
    const updated = await transitionHumanTaskRec(task.id, ['pending', 'claimed'], {
      status: 'claimed', claimed_by: principal.sub, claimed_at: new Date().toISOString(),
    });
    if (!updated) return res.status(409).json({ error: 'claim_conflict' });
    res.json({ task: toPublicHumanTask(updated) });
  });

  async function decideHumanTask(req: any, res: any, decision: 'approve' | 'reject') {
    const principal = principalFromHeaders(req);
    if (!principal) return res.status(401).json({ error: 'unauthenticated' });
    const task = await getHumanTaskRec(String(req.params.id || ''));
    if (!task || !await canAccessHumanTask(task, principal)) return res.status(404).json({ error: 'not_found' });
    if (!canActOnHumanTask(task, principal)) return res.status(403).json({ error: 'not_assignee' });
    if (task.status === 'completed' || task.status === 'rejected') return res.status(409).json({ error: 'already_decided', status: task.status });
    if (task.status === 'expired' || task.status === 'cancelled') return res.status(409).json({ error: 'task_closed', status: task.status });
    // Resolve the execution before reserving the task. Only the exact task
    // the engine created for this pause may resume it, and only at its
    // recorded node. Legacy/unbound paused runs fail closed rather than
    // accepting a fabricated approval.
    let checkpointExec: StoredExecution | null = null;
    if (task.execution_id) {
      checkpointExec = await getExecutionRec(task.execution_id);
      if (!checkpointExec) return res.status(409).json({ error: 'execution_not_found' });
      if (checkpointExec.status === 'paused') {
        if (!checkpointExec.pause_task_id || checkpointExec.pause_task_id !== task.id || !checkpointExec.pause_node) {
          return res.status(409).json({
            error: 'not_pause_checkpoint',
            message: 'this task is not the engine-created checkpoint for the paused execution',
          });
        }
      }
    }
    if (task.deadline && new Date(task.deadline).getTime() < Date.now()) {
      await expireHumanTask(task, true);
      return res.status(409).json({ error: 'task_expired' });
    }
    const b = (req.body || {}) as any;
    const note = b.note === undefined ? null : String(b.note).slice(0, 2000);
    if (decision === 'reject' && (!note || note.trim().length < 3)) {
      return res.status(400).json({ error: 'note_required', message: 'a rejection note is required' });
    }
    const payload = b.decision && typeof b.decision === 'object' ? b.decision : {};
    const nextStatus = decision === 'approve' ? 'completed' : 'rejected';
    const previousStatus = task.status === 'claimed' ? 'claimed' : 'pending';
    // Reserve the decision before dispatching the resume. `resuming` is not a
    // terminal state: a dispatch failure restores the task so the caller can
    // retry, and the decision is only completed after the resume is durable.
    const updated = await transitionHumanTaskRec(task.id, ['pending', 'claimed'], {
      status: 'resuming',
      completed_by: principal.sub,
      completed_at: new Date().toISOString(),
      decision: { ...payload, approved: decision === 'approve' },
      note,
    });
    if (!updated) return res.status(409).json({ error: 'decision_conflict' });
    const restoreTask = async () => {
      await transitionHumanTaskRec(task.id, ['resuming'], {
        status: previousStatus,
        claimed_by: task.claimed_by,
        claimed_at: task.claimed_at,
        completed_by: null,
        completed_at: null,
        decision: null,
        note: null,
      }).catch(() => null);
    };
    const completeTask = () => transitionHumanTaskRec(task.id, ['resuming'], { status: nextStatus });
    let resumed: any = null;
    if (updated.execution_id) {
      const exec = checkpointExec || await getExecutionRec(updated.execution_id);
      const wf = updated.workflow_id ? await getWorkflowRec(updated.workflow_id) : null;
      if (exec && exec.status === 'paused' && wf && canAccessWorkflow(wf, exec.principal || principal)) {
        const output = { humanTask: { id: updated.id, status: nextStatus, decision: updated.decision, note: updated.note }, ...(updated.decision || {}) };
        // Never trust task.node_name for execution. The checkpoint node is
        // authoritative and was persisted by the engine at pause time.
        const resumeNode = exec.pause_node;
        if (!resumeNode) {
          await restoreTask();
          return res.status(409).json({ error: 'not_pause_checkpoint' });
        }
        if (exec.workflow_revision != null
          && wf.revision != null
          && Number(exec.workflow_revision) !== Number(wf.revision)) {
          await restoreTask();
          return res.status(409).json({
            error: 'workflow_revision_conflict',
            message: 'the workflow changed after this execution paused; review the new revision and start a new run',
            expectedRevision: exec.workflow_revision,
            actualRevision: wf.revision,
          });
        }
        if (exec.queue_name && exec.runner !== 'inline') {
          const queued = await queueExecutionResume(exec.id, { node: resumeNode, output });
          if (!queued) {
            await restoreTask();
            return res.status(409).json({ error: 'already_resumed', status: 'running' });
          }
          try {
            await publishExistingExecution(queued);
          } catch (e: any) {
            // Put the execution back to paused and release the decision: a
            // transient queue outage must not consume the approval.
            await restoreExecutionPaused(exec.id).catch(() => null);
            await restoreTask();
            return res.status(503).json({
              error: 'resume_dispatch_failed',
              message: `the execution could not be re-queued; the decision was not consumed (${String(e?.message || e).slice(0, 300)})`,
            });
          }
          const done = await completeTask();
          resumed = { executionId: exec.id, status: 'queued', queued: true, queue: queued.queue_name, workflowId: wf.id };
          return res.json({ task: toPublicHumanTask(done || updated), resumed });
        }
        const won = await claimExecutionResume(exec.id);
        if (!won) {
          await restoreTask();
          return res.status(409).json({ error: 'already_resumed', status: 'running' });
        }
        try {
          const r = await runWorkflow(
            { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
            exec.input,
            {
              triggeredBy: 'human-task', principal: exec.principal || principal,
              credentialResolver: makeCredentialResolver(exec.principal || principal), synapseoneCall,
              resumeFrom: { node: resumeNode, output },
              humanTask: {
                create: async (nodeTask: any) => {
                  const rec = await createHumanTaskRec({
                    id: randomUUID(), execution_id: exec.id, workflow_id: wf.id, node_name: nodeTask.node,
                    title: nodeTask.title, description: nodeTask.description, assignee: nodeTask.assignee,
                    candidate_roles: nodeTask.candidateRoles, decision_schema: nodeTask.decisionSchema,
                    payload: nodeTask.payload, deadline: nodeTask.deadline,
                    org_id: exec.principal?.org || wf.org_id || null,
                    account_id: exec.principal?.account || wf.account_id || null,
                  });
                  return toPublicHumanTask(rec);
                },
              },
            },
          );
          const finishedAt = new Date().toISOString();
          const mergedRuns = [...(exec.node_runs || []), ...(r.nodeRuns || [])];
          if (r.status === 'paused') {
            // A second human-task node pauses the same execution: persist the
            // new checkpoint instead of marking the run successful.
            await savePausedExecutionRec(exec.id, {
              output: r.output,
              node_runs: mergedRuns as any,
              pauseTaskId: r.pause?.task?.id ? String(r.pause.task.id) : null,
              pauseNode: r.pause?.node ? String(r.pause.node) : null,
            });
            await completeTask();
            recordRun('human-task', 'paused', r.nodeRuns);
            resumed = {
              executionId: exec.id, status: 'paused', paused: true, output: r.output,
              taskId: r.pause?.task?.id, task: r.pause?.task,
            };
          } else if (r.status === 'error') {
            await restoreExecutionPaused(exec.id).catch(() => null);
            await restoreTask();
            return res.status(503).json({
              error: 'resume_failed',
              message: `the execution failed to resume; the decision was not consumed (${String((r as any).error || '').slice(0, 300)})`,
            });
          } else {
            const finished = await finishExecutionRec(exec.id, {
              status: 'success', output: r.output, node_runs: mergedRuns as any,
              error: null, finishedAt, allowedStatuses: ['running'],
            });
            await completeTask();
            recordRun('human-task', r.status, r.nodeRuns);
            resumed = { executionId: exec.id, status: r.status, output: r.output, execution: finished ? toApiExecution(finished, true) : null };
          }
        } catch (e: any) {
          await restoreExecutionPaused(exec.id).catch(() => null);
          await restoreTask();
          return res.status(503).json({
            error: 'resume_dispatch_failed',
            message: `the execution could not be resumed; the decision was not consumed (${String(e?.message || e).slice(0, 300)})`,
          });
        }
      } else {
        await completeTask();
      }
    } else {
      await completeTask();
    }
    const fresh = await getHumanTaskRec(task.id);
    res.json({ task: toPublicHumanTask(fresh || updated), resumed });
  }

  app.post('/v1/human-tasks/:id/complete', (req, res) => decideHumanTask(req, res, 'approve'));
  app.post('/v1/human-tasks/:id/reject', (req, res) => decideHumanTask(req, res, 'reject'));

  async function expireHumanTask(task: any, force = false): Promise<{ ok: boolean; task?: any; error?: string; status?: number }> {
    if (!task) return { ok: false, error: 'not_found', status: 404 };
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired' || task.status === 'cancelled') {
      return { ok: false, error: 'task_closed', status: 409 };
    }
    if (!force && (!task.deadline || new Date(task.deadline).getTime() > Date.now())) {
      return { ok: false, error: 'deadline_not_reached', status: 409 };
    }
    const updated = await transitionHumanTaskRec(task.id, ['pending', 'claimed'], {
      status: 'expired', escalated_at: new Date().toISOString(),
    });
    if (!updated) return { ok: false, error: 'expire_conflict', status: 409 };
    // A paused execution must reach a terminal state on expiry; otherwise it
    // stays paused forever with no one able to approve it.
    if (updated.execution_id) {
      const exec = await getExecutionRec(updated.execution_id);
      if (exec && exec.status === 'paused') {
        await finishExecutionRec(exec.id, {
          status: 'error',
          output: exec.output,
          node_runs: exec.node_runs,
          error: `human task '${updated.title}' expired before a decision`,
          finishedAt: new Date().toISOString(),
          allowedStatuses: ['paused'],
        }).catch(() => null);
      }
    }
    return { ok: true, task: updated };
  }

  app.post('/v1/human-tasks/:id/expire', async (req, res) => {
    const principal = principalFromHeaders(req);
    const task = await getHumanTaskRec(String(req.params.id || ''));
    if (!task || !await canAccessHumanTask(task, principal)) return res.status(404).json({ error: 'not_found' });
    // Expiring a pending approval is a destructive action. Only an assignee /
    // candidate-role holder or an organization administrator may force it.
    if (!canActOnHumanTask(task, principal) && principal?.isOrgAdmin !== true) {
      return res.status(403).json({ error: 'not_assignee' });
    }
    const result = await expireHumanTask(task, (req.body || {}).force === true);
    if (!result.ok) return res.status(result.status || 409).json({ error: result.error });
    res.json({ task: toPublicHumanTask(result.task) });
  });

  // ---------- tenant secret vault (#47) ----------
  const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,127}$/;

  function secretOrg(req: any, res: any): { org: string; account: string | null; sub: string; isOrgAdmin: boolean } | null {
    const principal = principalFromHeaders(req);
    if (!principal) { res.status(401).json({ error: 'unauthenticated' }); return null; }
    if (!principal.org) { res.status(400).json({ error: 'org_required', message: 'the caller credential has no organization claim' }); return null; }
    return { org: principal.org, account: principal.account || null, sub: principal.sub, isOrgAdmin: principal.isOrgAdmin === true };
  }

  /** Secrets are tenant-sensitive: only an org administrator or the identity
   *  that created the secret may read or mutate it. A per-secret account ACL
   *  (account-bound secrets created by this account's owner) is represented by
   *  `created_by`; ordinary org members get neither names nor values. */
  function canManageSecret(scope: { sub: string; isOrgAdmin: boolean }, secret: { created_by?: string | null }): boolean {
    return scope.isOrgAdmin || (!!secret.created_by && secret.created_by === scope.sub);
  }

  async function scopedSecret(req: any, res: any, scope: { org: string; account: string | null }) {
    const name = String(req.params.name || '');
    if (!SECRET_NAME_RE.test(name)) { res.status(400).json({ error: 'invalid_name' }); return null; }
    const secret = await findSecretRec(scope.org, name);
    if (!secret || (secret.account_id && scope.account && secret.account_id !== scope.account)) {
      res.status(404).json({ error: 'not_found' }); return null;
    }
    if (secret.account_id && !scope.account) { res.status(404).json({ error: 'not_found' }); return null; }
    return secret;
  }

  app.post('/v1/secrets', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const b = (req.body || {}) as any;
    const name = String(b.name || '').trim();
    if (!SECRET_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid_name', message: 'name must be 2..128 chars [A-Za-z0-9_.-]' });
    if (typeof b.value !== 'string' || b.value.length < 1 || Buffer.byteLength(b.value, 'utf8') > 65536) {
      return res.status(400).json({ error: 'invalid_value', message: 'value must be a 1..64KiB string' });
    }
    const account = b.accountId && !scope.account ? String(b.accountId).slice(0, 128) : scope.account;
    try {
      const secret = await createSecretRec({
        org_id: scope.org, account_id: account, name,
        description: b.description === undefined ? '' : String(b.description).slice(0, 500),
        scope: ['tenant', 'account', 'workflow'].includes(String(b.scope)) ? String(b.scope) : 'tenant',
        value: b.value, created_by: scope.sub,
      });
      res.status(201).json({ secret: toPublicSecret(secret) });
    } catch (e: any) {
      if (String(e?.code) === 'conflict' || String(e?.code) === '23505') return res.status(409).json({ error: 'secret_exists' });
      throw e;
    }
  });

  app.get('/v1/secrets', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const rows = await listSecretRecs(scope.org, scope.account || undefined);
    // Non-admins can enumerate only their own secrets (no cross-member names).
    const visible = scope.isOrgAdmin ? rows : rows.filter((s) => s.created_by === scope.sub);
    res.setHeader('cache-control', 'no-store');
    res.json({ items: visible.map(toPublicSecret), total: visible.length });
  });

  app.get('/v1/secrets/:name', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const secret = await scopedSecret(req, res, scope);
    if (!secret) return;
    if (!canManageSecret(scope, secret)) return res.status(403).json({ error: 'org_admin_required', message: 'only the secret owner or an organization administrator may read this secret' });
    const versions = await listSecretVersionRecs(secret);
    res.setHeader('cache-control', 'no-store');
    res.json({ secret: toPublicSecret(secret), versions: versions.map(toPublicSecretVersion) });
  });

  app.post('/v1/secrets/:name/read', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const secret = await scopedSecret(req, res, scope);
    if (!secret) return;
    if (!canManageSecret(scope, secret)) return res.status(403).json({ error: 'org_admin_required', message: 'only the secret owner or an organization administrator may read this secret' });
    const version = (req.body || {}).version === undefined ? undefined : Number((req.body || {}).version);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) return res.status(400).json({ error: 'invalid_version' });
    const result = await readSecretValue(secret, version);
    if ('error' in result) {
      return res.status(result.error === 'not_found' ? 404 : 410).json({ error: result.error === 'expired' ? 'version_expired' : result.error === 'revoked' ? 'version_revoked' : 'not_found' });
    }
    // Reads are sensitive even though the route is POST; audit explicitly
    // (the generic middleware skips `*/read` tails).
    try { auditRequest(req, 'workflow', 'allowed'); } catch { /* audit never breaks a read */ }
    res.setHeader('cache-control', 'no-store');
    res.json({ name: secret.name, version: result.version, value: result.value });
  });

  app.post('/v1/secrets/:name/rotate', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const secret = await scopedSecret(req, res, scope);
    if (!secret) return;
    if (!canManageSecret(scope, secret)) return res.status(403).json({ error: 'org_admin_required', message: 'only the secret owner or an organization administrator may rotate this secret' });
    const b = (req.body || {}) as any;
    if (typeof b.value !== 'string' || b.value.length < 1 || Buffer.byteLength(b.value, 'utf8') > 65536) {
      return res.status(400).json({ error: 'invalid_value' });
    }
    const grace = b.graceSeconds === undefined ? 86400 : Math.min(Math.max(Number(b.graceSeconds) || 0, 0), 30 * 86400);
    const updated = await rotateSecretRec(secret, b.value, grace, scope.sub);
    res.json({ secret: toPublicSecret(updated), graceSeconds: grace });
  });

  app.post('/v1/secrets/:name/revoke', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const secret = await scopedSecret(req, res, scope);
    if (!secret) return;
    if (!canManageSecret(scope, secret)) return res.status(403).json({ error: 'org_admin_required', message: 'only the secret owner or an organization administrator may revoke this secret' });
    const version = (req.body || {}).version === undefined ? undefined : Number((req.body || {}).version);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) return res.status(400).json({ error: 'invalid_version' });
    const revoked = await revokeSecretRec(secret, version);
    try { auditRequest(req, 'workflow', 'allowed'); } catch { /* never break the mutation */ }
    res.json({ ok: true, revoked, version: version || 'all' });
  });

  app.delete('/v1/secrets/:name', async (req, res) => {
    const scope = secretOrg(req, res);
    if (!scope) return;
    const secret = await scopedSecret(req, res, scope);
    if (!secret) return;
    if (!canManageSecret(scope, secret)) return res.status(403).json({ error: 'org_admin_required', message: 'only the secret owner or an organization administrator may delete this secret' });
    await deleteSecretRec(secret);
    try { auditRequest(req, 'workflow', 'allowed'); } catch { /* never break the mutation */ }
    res.json({ ok: true, name: secret.name });
  });

  /** Rotation webhook for external schedulers/HSMs. Authenticated by the
   *  shared rotation token, never by a user session. */
  app.post('/v1/secrets/rotation-webhook', async (req, res) => {
    const configured = process.env.SECRET_ROTATION_WEBHOOK_SECRET || '';
    const got = String(req.headers['x-rotation-token'] || '');
    if (!configured || !got || !timingSafeEqual(Buffer.from(got), Buffer.from(configured))) {
      return res.status(401).json({ error: 'invalid_rotation_token' });
    }
    const b = (req.body || {}) as any;
    const org = String(b.orgId || '').trim();
    const name = String(b.name || '').trim();
    if (!org || !SECRET_NAME_RE.test(name) || typeof b.value !== 'string' || !b.value) {
      return res.status(400).json({ error: 'invalid_rotation_request' });
    }
    const secret = await findSecretRec(org, name);
    if (!secret) return res.status(404).json({ error: 'not_found' });
    const grace = b.graceSeconds === undefined ? 86400 : Math.min(Math.max(Number(b.graceSeconds) || 0, 0), 30 * 86400);
    const updated = await rotateSecretRec(secret, b.value, grace, 'rotation-webhook');
    res.json({ secret: toPublicSecret(updated), graceSeconds: grace });
  });

  // ---------- /metrics (P2): Prometheus exposition ----------
  app.get('/metrics', async (_req, res) => {
    const tenantRows = await activeExecutionCountsByTenant().catch(() => []);
    const lines = [
      '# HELP synapseone_workflow_runs_total Workflow executions by trigger and status.',
      '# TYPE synapseone_workflow_runs_total counter',
      ...[...metricRuns.entries()].map(([k, v]) => {
        const [triggeredBy, status] = k.split('|');
        return `synapseone_workflow_runs_total{triggered_by="${triggeredBy}",status="${status}"} ${v}`;
      }),
      '# HELP synapseone_workflow_webhook_rejected_total Rejected inbound webhook calls by reason.',
      '# TYPE synapseone_workflow_webhook_rejected_total counter',
      ...[...metricWebhookRejected.entries()].map(([reason, v]) => `synapseone_workflow_webhook_rejected_total{reason="${reason}"} ${v}`),
      '# HELP synapseone_workflow_active_executions Queued or running executions per tenant.',
      '# TYPE synapseone_workflow_active_executions gauge',
      ...tenantRows.map((row) => `synapseone_workflow_active_executions{tenant="${String(row.tenant).replace(/[\\"\n]/g, '_').slice(0, 128)}"} ${row.count}`),
      '# HELP synapseone_workflow_system_queue_tenant_max Admission cap for shared system-runner executions (0 = unlimited).',
      '# TYPE synapseone_workflow_system_queue_tenant_max gauge',
      `synapseone_workflow_system_queue_tenant_max ${Math.max(0, Number(process.env.WORKFLOW_SYSTEM_QUEUE_TENANT_MAX ?? 100) || 0)}`,
    ];
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Test-run a definition without saving (validates + executes in sandbox).
  // Powers the editor's "try code/set/if" before Save. Persists as a
  // triggered_by=test execution — pass { workflowId } of a saved workflow
  // to attach it to that workflow's history, otherwise it lands under a
  // synthetic test-* id (visible in unfiltered /v1/executions).
  app.post('/v1/workflows/test-run', async (req, res) => {
    const { definition, input, workflowId } = (req.body || {}) as any;
    if (!definition) return res.status(400).json({ error: 'definition required' });
    // Sandbox fragments may omit trigger nodes (editor "try node without a graph").
    const defErr = validateDefinition(definition, { requireTrigger: false });
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    let inSize = 0;
    try { inSize = Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (inSize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'input ≤200KB' });
    let attach: StoredWorkflow | null = null;
    if (workflowId !== undefined && workflowId !== null && workflowId !== '') {
      if (typeof workflowId !== 'string' || workflowId.length > 128 || /[\r\n]/.test(workflowId)) {
        return res.status(400).json({ error: 'invalid_workflow_id' });
      }
      attach = await getWorkflowRec(workflowId);
      if (!attach || !canAccessWorkflow(attach, principalFromHeaders(req))) {
        return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
      }
    }
    const principal = principalFromHeaders(req);
    const startedAt = new Date().toISOString();
    const executionId = randomUUID();
    const syntheticWfId = `test-${randomUUID().slice(0, 8)}`;
    const testWf: StoredWorkflow = attach || {
      id: syntheticWfId, name: 'test-run', nodes: [], connections: {},
      settings: {}, active: false, org_id: principal?.org || null, account_id: principal?.account || null,
      owner_sub: principal?.sub || null, run_as: null, revision: 1, created_at: startedAt, updated_at: startedAt,
    };
    const r = await runWorkflow(definition, input ?? {}, {
      triggeredBy: 'test', principal, credentialResolver: makeCredentialResolver(principal), synapseoneCall,
      humanTask: inlineHumanTaskSink(executionId, testWf, principal),
    });
    const finishedAt = new Date().toISOString();
    recordRun('test', r.status, r.nodeRuns);
    const wfId = attach ? attach.id : syntheticWfId;
    const exec = await createExecutionRec({
      id: executionId,
      workflow_id: wfId, workflow_name: attach ? attach.name : 'test-run', status: r.status,
      input: input ?? {}, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'test',
      principal, actor: actorFor(wfId, principal), startedAt, finishedAt,
      workflow_revision: attach ? attach.revision : undefined,
      ...pauseBinding(r),
    });
    res.status(r.status === 'success' ? 200 : 500).json({
      ok: r.status === 'success', output: r.output, nodeRuns: r.nodeRuns,
      executionId: exec.id, error: (r as any).error ?? undefined,
    });
  });

  // Built-in templates (versioned JSON)
  app.get('/v1/templates', (_req, res) => res.json(listTemplates()));
  app.get('/v1/templates/:name', (req, res) => {
    const t = buildTemplate(req.params.name, req.params.name);
    if (!t) return res.status(404).json({ error: 'template_not_found' });
    res.json(t);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[workflow] unhandled:', err?.message || err);
    if (res.headersSent) return;
    // Store/instance fencing errors carry a typed 409 code (for example
    // instance_conflict or runner_capacity_unavailable). Never turn them into
    // a generic 500 that the runner cannot classify/requeue.
    if (err?.status === 409 && err?.code) {
      return res.status(409).json({
        error: String(err.code),
        message: String(err.message || err.code),
        ...(err.required ? { required: err.required } : {}),
        ...(err.available ? { available: err.available } : {}),
        ...(err.sampledAt ? { sampledAt: err.sampledAt } : {}),
      });
    }
    // Malformed JSON body: 400, not 500.
    if (err?.status === 400 || err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && /JSON/i.test(err.message))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err?.status === 413 || err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({
        error: String(err.code || 'request_rejected'),
        message: String(err.message || 'request rejected').slice(0, 500),
      });
    }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

export function listTemplates() {
  return [
    { name: 'webhook-to-log', description: 'Webhook receives a gateway event -> writes a log -> replies 200' },
    { name: 'cron-etl', description: 'Nightly cron -> fetches API health -> transforms -> logs' },
    { name: 'iam-webhook', description: 'Receives IAM events (user.created) -> calls back into the API' },
    { name: 'code-transform', description: 'Webhook -> sandboxed JS transform -> conditional branch -> set fields' },
    { name: 'manual-starter', description: 'Manual trigger -> code transform -> set fields (click Execute to try)' },
    { name: 'synapseone-self-check', description: 'Manual -> SynapseOne API (list orgs) -> count -> summary (first-party integration demo)' },
    { name: 'webhook-to-lds', description: 'Webhook -> SynapseLDS: publish the payload as an NGSI-LD record (payload carries datasourceId)' },
    { name: 'github-push-to-log', description: 'GitHub push webhook (HMAC verified) -> normalize commits -> summary' },
    { name: 'ai-triage-ops', description: 'AI triage showcase: webhook -> Decision (4 routes) -> 3 AI Agents with canvas Tools/Model sockets + Base/Faststore/IAM/HTTP tools -> aggregate -> escalation queue' },
    { name: 'customer-360-orchestrator', description: 'Customer 360 showcase: webhook -> Decision (4 routes) -> AI SRE agent + canvas Tools/Model sockets -> Base/Faststore/IAM/LDS/Queue/Flow integrations -> fan-out/fan-in -> risk gate' },
    { name: 'vector-rag-orchestrator', description: 'Enterprise RAG triage: webhook -> Base vector search -> Decision (multi-route) -> AI Agent with vector tools -> Faststore cache -> Queue escalation' },
    { name: 'etl-batch-warehouse', description: 'Manual/cron ETL: run a warehouse SQL transform into a target dataset (daily rollup template)' },
    { name: 'etl-stream-warehouse', description: 'Manual: ensure a SynapseStream topic consumer job that appends events to a warehouse dataset' },
    { name: 'etl-stream-microbatch', description: 'Manual: consume a SynapseStream micro-batch -> warehouse ingest -> ack (at-least-once)' },
    { name: 'mcp-docs-reader', description: 'MCP tool: AI clients read SynapseOne docs through an mcpTrigger -> fetch -> format -> MCP response' },
  ];
}

export { isBlockedUrl, validateDefinition, findSsrfUrl };

/** Webhook trigger of a workflow: validated path + declared HTTP method. */
export interface WebhookTrigger {
  path: string;
  method: string;
}

export function findWebhookTrigger(workflow: any): WebhookTrigger | null {
  try {
    const nodes = workflow?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      if (!isWebhookType((n as any)?.type)) continue;
      const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
      if (!p || p.length > 128) continue;
      if (!/^[A-Za-z0-9_.\/-]+$/.test(p)) continue;
      if (p.split('/').includes('..')) continue;
      const raw = String((n as any)?.parameters?.httpMethod || 'POST').toUpperCase();
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(raw) ? raw : 'POST';
      return { path: p, method };
    }
  } catch { /* ignore */ }
  return null;
}

/** First webhook trigger path of a workflow definition, or null. */
export function findWebhookPath(workflow: any): string | null {
  return findWebhookTrigger(workflow)?.path || null;
}

export function mcpToolName(node: any): string {
  return String(node?.parameters?.toolName || node?.name || '').trim();
}

export function findMcpTrigger(workflow: any): { toolName: string; description: string; inputSchema: any; public: boolean; readOnly: boolean; node: any } | null {
  try {
    const nodes = workflow?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      if (!isMcpTriggerType((n as any)?.type)) continue;
      const toolName = mcpToolName(n);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(toolName)) continue;
      const description = String((n as any)?.parameters?.description || '').slice(0, 500);
      const inputSchema = (n as any)?.parameters?.inputSchema && typeof (n as any).parameters.inputSchema === 'object'
        ? (n as any).parameters.inputSchema
        : { type: 'object', properties: {}, additionalProperties: true };
      const readOnly = (n as any)?.parameters?.readOnly !== false;
      const isPublic = (n as any)?.parameters?.public === true && readOnly;
      return { toolName, description, inputSchema, public: isPublic, readOnly, node: n };
    }
  } catch { /* ignore */ }
  return null;
}

/** Decide routes are positional (main[0..n]); PostgreSQL JSONB does not
 *  preserve object key order. Normalize legacy object maps to ordered arrays
 *  at save time so a Decision node keeps its route/branch contract. */
export function normalizeDecisionChoices(definition: any): any {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  for (const n of nodes) {
    if (!isDecisionType(n?.type)) continue;
    const p = n?.parameters;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    for (const key of ['choices', 'routes'] as const) {
      const raw = (p as any)[key];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        (p as any)[key] = Object.entries(raw).map(([name, description]) => ({
          name,
          description: String(description ?? name),
        }));
      }
    }
  }
  return definition;
}

export function buildTemplate(name: string, workflowName?: string): any | null {
  const wname = workflowName || name;
  const wid = () => (globalThis.crypto as any)?.randomUUID?.() || Math.random().toString(36).slice(2);
  if (name === 'webhook-to-log') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'synapseone-event', httpMethod: 'POST' } },
        { id: wid(), name: 'Log', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 300], parameters: {} },
      ],
      connections: { Webhook: { main: [[{ node: 'Log', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'cron-etl') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Cron', type: 'n8n-nodes-base.cron', typeVersion: 1, position: [200, 300], parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } } },
        { id: wid(), name: 'FetchAPI', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 300], parameters: { url: 'https://api.example.com/health', method: 'GET' } },
      ],
      connections: { Cron: { main: [[{ node: 'FetchAPI', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'iam-webhook') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'IAMEvent', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'iam-event', httpMethod: 'POST' } },
        { id: wid(), name: 'CallAPI', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [420, 300], parameters: { url: 'https://api.example.com/v1/orgs', method: 'GET' } },
      ],
      connections: { IAMEvent: { main: [[{ node: 'CallAPI', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'code-transform') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'transform', httpMethod: 'POST' } },
        { id: wid(), name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' } },
        { id: wid(), name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 1, position: [600, 300], parameters: { condition: '$input.doubled > 10' } },
        { id: wid(), name: 'Big', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 220], parameters: { values: { tag: 'big' } } },
        { id: wid(), name: 'Small', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 380], parameters: { values: { tag: 'small' } } },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
        Transform: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
        // if: main[0] = true branch, main[1] = false branch
        Check: { main: [[{ node: 'Big', type: 'main', index: 0 }], [{ node: 'Small', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'manual-starter') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        { id: wid(), name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' } },
        { id: wid(), name: 'Tag', type: 'n8n-nodes-base.set', typeVersion: 1, position: [600, 300], parameters: { values: { tag: 'processed' } } },
      ],
      connections: {
        Manual: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
        Transform: { main: [[{ node: 'Tag', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'synapseone-self-check') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        { id: wid(), name: 'GetOrgs', type: 'synapseone.api', typeVersion: 1, position: [400, 300], parameters: { resource: 'orgs', operation: 'list', input: {} } },
        { id: wid(), name: 'Count', type: 'n8n-nodes-base.code', typeVersion: 1, position: [600, 300], parameters: { code: 'const list = Array.isArray($input) ? $input : []; return { count: list.length, at: $now };' } },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 300], parameters: { values: { checked: true } } },
      ],
      connections: {
        Manual: { main: [[{ node: 'GetOrgs', type: 'main', index: 0 }]] },
        GetOrgs: { main: [[{ node: 'Count', type: 'main', index: 0 }]] },
        Count: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'webhook-to-lds') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'lds-publish', httpMethod: 'POST' } },
        { id: wid(), name: 'PublishToLDS', type: 'synapseone.api', typeVersion: 1, position: [440, 300], parameters: { resource: 'lds', operation: 'publish-record', input: { datasourceId: '={{ $json.datasourceId }}', record: '={{ $json }}' } } },
        { id: wid(), name: 'Done', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [680, 300], parameters: {} },
      ],
      connections: {
        Webhook: { main: [[{ node: 'PublishToLDS', type: 'main', index: 0 }]] },
        PublishToLDS: { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'github-push-to-log') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'GitHubPush', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'github-push', httpMethod: 'POST', auth: { mode: 'hmac-sha256', header: 'x-hub-signature-256' } } },
        { id: wid(), name: 'Normalize', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'const p = $input || {}; const commits = Array.isArray(p.commits) ? p.commits : []; return { repo: p.repository?.full_name || null, ref: p.ref || null, pusher: p.pusher?.name || null, count: commits.length, messages: commits.slice(0, 10).map((c) => c.message) };' } },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.set', typeVersion: 1, position: [600, 300], parameters: { values: { source: 'github' } } },
      ],
      connections: {
        GitHubPush: { main: [[{ node: 'Normalize', type: 'main', index: 0 }]] },
        Normalize: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'customer-360-orchestrator') {
    const node = (n: string, type: string, x: number, y: number, parameters: any = {}) => ({
      id: wid(), name: n, type, typeVersion: 1, position: [x, y], parameters,
    });
    const edge = (target: string) => ({ node: target, type: 'main', index: 0 });
    const tool = (target: string) => ({ node: target, type: 'tools', index: 0, targetPort: 'tools' });
    const model = (target: string) => ({ node: target, type: 'model', index: 0, targetPort: 'model' });
    return {
      name: wname,
      settings: { onError: 'continue', timeoutMs: 300000 },
      nodes: [
        { ...node('Intake', 'n8n-nodes-base.webhook', 80, 480, { path: 'customer-360-demo', httpMethod: 'POST' }), webhookId: wid() },
        node('Normalize', 'n8n-nodes-base.code', 320, 480, {
          code:
            'const p = $input || {};' +
            'const query = String(p.query || p.message || p.intent || "customer health review").trim();' +
            'const amount = Number(p.amount || p.mrr || 0);' +
            'const tier = String(p.tier || "standard");' +
            'const urgent = /(urgent|asap|down|outage|production|critical)/i.test(query);' +
            'const eventId = p.eventId || ("evt-" + Date.now());' +
            'const customerId = p.customerId || "demo-customer";' +
            'const riskScore = Math.min(100, Math.round(amount / 100 + (tier === "enterprise" ? 25 : 0) + (urgent ? 30 : 0)));' +
            'return { ...p, query, amount, tier, customerId, eventId, priority: p.priority || (urgent ? "urgent" : "normal"), riskScore, receivedAt: $now };',
        }),
        node('Route', 'synapseflow.decision', 580, 480, {
          input: '={{ $json.query }}',
          choices: [
            { name: 'billing', description: 'billing, invoice, refund, charge, payment, subscription' },
            { name: 'technical', description: 'technical, error, outage, api, bug, incident, production' },
            { name: 'account', description: 'account, login, password, permission, access, user' },
            { name: 'growth', description: 'growth, upgrade, pricing, plan, renewal, expansion, sales' },
          ],
          instruction: 'Route this customer event to the team best equipped to handle it.',
          fallbackBranch: 3,
          minConfidence: 0.25,
        }),
        node('FlowCatalog', 'synapseone.flow', 840, 40, {
          operation: 'workflows.list',
          input: {},
        }),
        node('HasLDS', 'n8n-nodes-base.if', 840, 200, {
          condition: '={{ !!$json.datasourceId }}',
        }),
        node('PublishTimeline', 'synapseone.lds', 1100, 120, {
          operation: 'publish-record',
          input: {
            datasourceId: '={{ $json.datasourceId }}',
            record: {
              id: '={{ $json.eventId }}',
              eventId: '={{ $json.eventId }}',
              kind: 'customer360.event',
              customerId: '={{ $json.customerId }}',
              route: 'pending',
              query: '={{ $json.query }}',
              amount: '={{ $json.amount }}',
              priority: '={{ $json.priority }}',
              receivedAt: '={{ $json.receivedAt }}',
            },
          },
        }),
        node('SkipLDS', 'n8n-nodes-base.noOp', 1100, 260, {}),

        // Billing lane: calculation -> cache + Base audit in parallel -> aggregate.
        node('BillingCalc', 'n8n-nodes-base.code', 840, 380, {
          code:
            'const amount = Number($input.amount || 0);' +
            'const tier = String($input.tier || "standard");' +
            'const discount = tier === "enterprise" ? 0.15 : tier === "pro" ? 0.08 : 0;' +
            'const credit = Math.round(amount * discount * 100) / 100;' +
            'return { ...$input, billing: { amount, credit, currency: "USD", tier, discount, decision: credit > 0 ? "credit_approved" : "no_credit", calculatedAt: $now } };',
        }),
        node('BillingCache', 'synapseone.faststore', 1120, 320, {
          operation: 'set',
          input: { key: 'billing:{{ $json.eventId }}', value: '={{ $json.billing }}', ttlSeconds: 3600 },
        }),
        node('BillingRecord', 'synapseone.base', 1120, 440, {
          operation: 'create-document',
          input: { collection: 'customer360_events', id: '={{ $json.eventId }}', data: '={{ $json }}' },
        }),
        node('BillingDone', 'n8n-nodes-base.set', 1380, 440, {
          values: { route: 'billing', branchResult: '={{ $json.data }}', processedBy: 'billing' },
        }),

        // Technical lane: autonomous SRE agent with built-in + canvas tools.
        node('IncidentAgent', 'synapseflow.aiAgent', 840, 620, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt:
            'You are the SRE commander in SynapseFlow. Diagnose incidents using the available tools. ' +
            'Prefer evidence from SynapseBase, Faststore, IAM and the workflow catalog. ' +
            'The audit collection is customer360_events. SynapseBase filters are JSON objects, for example {"eventId":"evt-123"}; never pass a SQL-style string or guess a collection name. ' +
            'Never invent status or customer data. Keep the final answer under 250 words and end with a one-paragraph customer-safe update.',
          userPrompt:
            'Incident: "{{ $json.query }}". Event: {{ $json.eventId }}. Customer: {{ $json.customerId }}. ' +
            'Priority: {{ $json.priority }}. Route: {{ $json.decision.route }}. ' +
            'Use at most two tools, then return the remediation plan.',
          tools: [
            'synapsebase_query',
            'synapsebase_vector_search',
            'faststore_cache',
            'iam_check_permission',
            'workflow_list',
          ],
          maxSteps: 4,
          maxTokens: 1024,
          temperature: 0.1,
        }),

        // Account lane: permission check + cache snapshot in parallel, then audit.
        node('AccountPrep', 'n8n-nodes-base.noOp', 840, 820, {}),
        node('AccountAuth', 'synapseone.iam', 1120, 740, {
          operation: 'authorize.check',
          input: { userId: '={{ $json.userId }}', action: 'read', resource: 'customer360' },
        }),
        node('AccountSnapshot', 'synapseone.faststore', 1120, 840, {
          operation: 'hash-set',
          input: {
            key: 'account:{{ $json.customerId }}',
            values: { tier: '={{ $json.tier }}', riskScore: '={{ $json.riskScore }}', lastRoute: 'account', checkedAt: '={{ $now }}' },
          },
        }),
        node('AccountRecord', 'synapseone.base', 1120, 940, {
          operation: 'create-document',
          input: { collection: 'customer360_events', id: '={{ $json.eventId }}', data: '={{ $json }}' },
        }),
        node('AccountDone', 'n8n-nodes-base.set', 1380, 940, {
          values: { route: 'account', branchResult: '={{ $json.data }}', processedBy: 'account' },
        }),

        // Growth lane: deterministic plan + Base audit; Flow catalog ran above.
        node('GrowthPlan', 'n8n-nodes-base.code', 840, 1080, {
          code:
            'const amount = Number($input.amount || 0);' +
            'const tier = String($input.tier || "standard");' +
            'const plan = amount >= 5000 ? "enterprise-expansion" : amount > 0 ? "growth-nurture" : "community";' +
            'return { ...$input, growth: { plan, tier, nextStep: plan === "enterprise-expansion" ? "executive-business-review" : "self-serve-nurture", createdAt: $now } };',
        }),
        node('GrowthRecord', 'synapseone.base', 1120, 1080, {
          operation: 'create-document',
          input: { collection: 'customer360_events', id: '={{ $json.eventId }}', data: '={{ $json }}' },
        }),
        node('GrowthDone', 'n8n-nodes-base.set', 1380, 1080, {
          values: { route: 'growth', branchResult: '={{ $json.data }}', processedBy: 'growth' },
        }),

        // Fan-in: normalize every lane into one result, then side-effect metrics.
        node('Aggregate', 'n8n-nodes-base.code', 1680, 620, {
          code:
            'const p = $input || {};' +
            'const payload = p.branchResult || p;' +
            'const d = p.decision || payload.decision || {};' +
            'const route = p.route || payload.route || d.route || "unknown";' +
            'const agent = p.agent || payload.agent || {};' +
            'return { ...p, route, confidence: d.confidence ?? payload.confidence ?? p.confidence ?? 1, ' +
            'reply: p.response || agent.response || payload.reply || "", customerId: p.customerId || payload.customerId || "demo-customer", ' +
            'eventId: p.eventId || payload.eventId || ("evt-" + Date.now()), amount: Number(p.amount ?? payload.amount ?? 0), ' +
            'priority: p.priority || payload.priority || "normal", processedAt: $now };',
        }),
        node('Metrics', 'synapseone.faststore', 1960, 500, {
          operation: 'incr',
          input: { key: 'customer360:processed', by: 1 },
        }),
        node('RiskGate', 'n8n-nodes-base.if', 1960, 640, {
          condition: '={{ ($json.confidence ?? 1) < 0.55 || $json.priority === "urgent" || ($json.amount ?? 0) >= 1000 }}',
        }),
        node('Escalate', 'synapseone.queue', 2240, 560, {
          operation: 'publish',
          input: { queue: 'customer360-escalations', payload: '={{ $json }}', priority: 8 },
        }),
        node('Done', 'n8n-nodes-base.noOp', 2240, 740, {}),

        // Canvas tools (purple Tools sockets) + Model socket.
        node('KBLookup', 'synapseone.base', 840, 1360, {
          operation: 'query-documents',
          input: { collection: 'customer360_events', limit: 3 },
        }),
        node('TraceCache', 'synapseone.faststore', 1060, 1360, {
          operation: 'get',
          input: { key: 'customer360:{{ $json.customerId }}' },
        }),
        node('PermissionProbe', 'synapseone.iam', 1280, 1360, {
          operation: 'authorize.check',
          input: { userId: '={{ $json.userId }}', action: 'read', resource: 'customer360' },
        }),
        node('FlowProbe', 'synapseone.flow', 1500, 1360, {
          operation: 'workflows.list',
          input: {},
        }),
        node('ModelCore', 'synapseflow.model', 1720, 1360, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
        }),
      ],
      connections: {
        Intake: { main: [[edge('Normalize')]] },
        Normalize: { main: [[edge('Route'), edge('FlowCatalog'), edge('HasLDS')]] },
        HasLDS: { main: [[edge('PublishTimeline')], [edge('SkipLDS')]] },
        Route: {
          main: [
            [edge('BillingCalc')],
            [edge('IncidentAgent')],
            [edge('AccountPrep')],
            [edge('GrowthPlan')],
          ],
        },
        BillingCalc: { main: [[edge('BillingCache'), edge('BillingRecord')]] },
        BillingRecord: { main: [[edge('BillingDone')]] },
        BillingDone: { main: [[edge('Aggregate')]] },
        IncidentAgent: { main: [[edge('Aggregate')]] },
        AccountPrep: { main: [[edge('AccountAuth'), edge('AccountSnapshot'), edge('AccountRecord')]] },
        AccountRecord: { main: [[edge('AccountDone')]] },
        AccountDone: { main: [[edge('Aggregate')]] },
        GrowthPlan: { main: [[edge('GrowthRecord')]] },
        GrowthRecord: { main: [[edge('GrowthDone')]] },
        GrowthDone: { main: [[edge('Aggregate')]] },
        Aggregate: { main: [[edge('Metrics'), edge('RiskGate')]] },
        RiskGate: { main: [[edge('Escalate')], [edge('Done')]] },
        // tool/model sockets (auxiliary edges, never execution flow)
        KBLookup: { main: [[tool('IncidentAgent')]] },
        TraceCache: { main: [[tool('IncidentAgent')]] },
        PermissionProbe: { main: [[tool('IncidentAgent')]] },
        FlowProbe: { main: [[tool('IncidentAgent')]] },
        ModelCore: { main: [[model('IncidentAgent')]] },
      },
    };
  }
  if (name === 'ai-triage-ops') {
    const node = (n: string, type: string, x: number, y: number, parameters: any = {}) => ({
      id: wid(), name: n, type, typeVersion: 1, position: [x, y], parameters,
    });
    const edge = (target: string) => ({ node: target, type: 'main', index: 0 });
    const tool = (target: string) => ({ node: target, type: 'tools', index: 0, targetPort: 'tools' });
    const model = (target: string) => ({ node: target, type: 'model', index: 0, targetPort: 'model' });
    return {
      name: wname,
      settings: { onError: 'continue', timeoutMs: 300000 },
      nodes: [
        node('Intake', 'n8n-nodes-base.webhook', 80, 340, { path: 'ai-triage-demo', httpMethod: 'POST' }),
        node('Normalize', 'n8n-nodes-base.code', 330, 340, {
          code:
            'const p = $input || {};' +
            'const query = String(p.query || p.message || p.text || p.description || "").trim();' +
            'const urgent = /(urgent|asap|down|outage|production)/i.test(query);' +
            'return { ...p, query, ticketId: p.ticketId || ("T-" + Date.now()), priority: p.priority || (urgent ? "urgent" : "normal"), receivedAt: $now };',
        }),
        node('Triage', 'synapseflow.decision', 600, 340, {
          input: '={{ $json.query }}',
          choices: [
            { name: 'billing', description: 'billing, invoices, refunds, payments, subscription charges' },
            { name: 'technical', description: 'bugs, errors, API failures, outages, technical problems' },
            { name: 'account', description: 'login, password, profile, permissions, account access' },
            { name: 'sales', description: 'pricing, plans, purchase, upgrade, partnership' },
          ],
          instruction: 'Route this support ticket to the team best equipped to handle it.',
          fallbackBranch: 3,
          minConfidence: 0.3,
        }),
        node('BillingAgent', 'synapseflow.aiAgent', 900, 80, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt: 'You are the Billing specialist in SynapseFlow. Use SynapseBase and Faststore tools to ground every answer in real data. Be concise, cite amounts and invoice ids, and never invent a payment.',
          userPrompt: 'Handle this billing ticket. Customer says: "{{ $json.query }}". Ticket: {{ $json.ticketId }}. Look up the knowledge base/cache when useful, then produce the customer reply.',
          tools: ['synapsebase_query', 'faststore_cache', 'decision_eval', 'http_request', 'workflow_run'],
          maxSteps: 7,
          temperature: 0.2,
        }),
        node('TechAgent', 'synapseflow.aiAgent', 900, 320, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt: 'You are the Technical support specialist in SynapseFlow. Diagnose the issue, use the code sandbox for calculations/transforms, and call the HTTP tool only for public status endpoints. Give concrete next steps.',
          userPrompt: 'Diagnose and answer this technical ticket: "{{ $json.query }}". Priority: {{ $json.priority }}. Use the KB/status tools, then produce the customer reply.',
          tools: ['synapsebase_query', 'code_sandbox', 'logic_calculator', 'decision_eval', 'queue_publish', 'http_request'],
          maxSteps: 8,
          temperature: 0.2,
        }),
        node('AccountAgent', 'synapseflow.aiAgent', 900, 560, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt: 'You are the Account & Access specialist in SynapseFlow. Use the IAM permission check and cache tools before making claims about access. Never disclose secrets or other tenants\' data.',
          userPrompt: 'Resolve this account/access ticket: "{{ $json.query }}". Customer id: {{ $json.customerId || "unknown" }}. Check permissions with tools, then produce the customer reply.',
          tools: ['iam_check_permission', 'faststore_cache', 'workflow_list', 'workflow_run'],
          maxSteps: 6,
          temperature: 0.2,
        }),
        node('SalesReply', 'n8n-nodes-base.set', 900, 800, {
          values: {
            department: 'sales',
            reply: 'Thanks for your interest in SynapseOne! Our sales team will reach out shortly with pricing and the right plan for your team.',
          },
        }),
        node('Aggregate', 'n8n-nodes-base.code', 1240, 340, {
          code:
            'const d = $input.decision || {};' +
            'const a = $input.agent || {};' +
            'return { ...$input, route: d.route || $input.department || "sales", confidence: d.confidence ?? $input.confidence ?? 1, reply: a.response || $input.reply || "", department: d.route || $input.department || "sales", processedAt: $now };',
        }),
        node('NeedsEscalation', 'n8n-nodes-base.if', 1500, 340, {
          condition: '={{ ($json.confidence ?? 1) < 0.55 || $json.priority === "urgent" }}',
        }),
        node('Escalate', 'synapseone.queue', 1780, 220, {
          operation: 'publish',
          input: { queue: 'support-escalations', payload: '={{ $json }}', priority: 5 },
        }),
        node('Done', 'n8n-nodes-base.noOp', 1780, 460, {}),
        // ---- Canvas tools (connect to agents' Tools sockets) ----
        node('KBLookup', 'synapseone.base', 620, 980, {
          operation: 'query-documents',
          input: { collection: 'support_kb', limit: 5 },
        }),
        node('CustomerCache', 'synapseone.faststore', 620, 1120, {
          operation: 'get',
          input: { key: 'customer:={{ $json.customerId }}' },
        }),
        node('PermissionCheck', 'synapseone.iam', 620, 1260, {
          operation: 'authorize.check',
          input: { userId: '={{ $json.userId }}', action: 'read', resource: 'support_ticket' },
        }),
        node('StatusAPI', 'n8n-nodes-base.httpRequest', 620, 1400, {
          url: 'https://api.example.com/health',
          method: 'GET',
        }),
        node('ModelCore', 'synapseflow.model', 620, 1540, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
        }),
      ],
      connections: {
        Intake: { main: [[edge('Normalize')]] },
        Normalize: { main: [[edge('Triage')]] },
        Triage: {
          main: [
            [edge('BillingAgent')],
            [edge('TechAgent')],
            [edge('AccountAgent')],
            [edge('SalesReply')],
          ],
        },
        BillingAgent: { main: [[edge('Aggregate')]] },
        TechAgent: { main: [[edge('Aggregate')]] },
        AccountAgent: { main: [[edge('Aggregate')]] },
        SalesReply: { main: [[edge('Aggregate')]] },
        Aggregate: { main: [[edge('NeedsEscalation')]] },
        NeedsEscalation: { main: [[edge('Escalate')], [edge('Done')]] },
        // tool/model sockets (not execution flow)
        KBLookup: { main: [[tool('BillingAgent')], [tool('TechAgent')]] },
        CustomerCache: { main: [[tool('BillingAgent')], [tool('AccountAgent')]] },
        PermissionCheck: { main: [[tool('AccountAgent')]] },
        StatusAPI: { main: [[tool('TechAgent')]] },
        ModelCore: { main: [[model('BillingAgent')]] },
      },
    };
  }
  if (name === 'vector-rag-orchestrator') {
    const node = (n: string, type: string, x: number, y: number, parameters: any = {}) => ({
      id: wid(), name: n, type, typeVersion: 1, position: [x, y], parameters,
    });
    const edge = (target: string) => ({ node: target, type: 'main', index: 0 });
    return {
      name: wname,
      settings: { onError: 'continue', timeoutMs: 300000 },
      nodes: [
        { ...node('Intake', 'n8n-nodes-base.webhook', 80, 360, { path: 'vector-rag-demo', httpMethod: 'POST' }), webhookId: wid() },
        node('Normalize', 'n8n-nodes-base.code', 300, 360, {
          code: 'const p = $input || {}; const query = String(p.query || p.message || p.question || "How to configure SSO").trim(); const incidentId = p.incidentId || ("inc-" + Date.now()); const category = p.category || "knowledge"; const urgency = /(urgent|critical|outage|down)/i.test(query) ? "high" : "normal"; return { ...p, query, incidentId, category, urgency, timestamp: $now };',
        }),
        node('KBVectorSearch', 'synapseone.base', 540, 360, {
          operation: 'vector-search',
          input: {
            collection: 'kb_articles',
            query: '={{ $json.query }}',
            limit: 3,
            metric: 'cosine',
            as: 'object',
          },
        }),
        node('ScoreMatch', 'n8n-nodes-base.code', 780, 360, {
          code: 'const prev = $input || {}; const items = prev.items || []; const total = prev.total || items.length; const topItem = items[0] || null; const similarity = topItem ? Number(topItem.similarity || 0) : 0; const doc = topItem ? (topItem.object || topItem.data || {}) : {}; let route = "escalate"; if (similarity >= 0.85) route = "auto_resolve"; else if (similarity >= 0.50) route = "agent_triage"; return { ...prev, topDocId: topItem ? topItem.id : null, topDocTitle: doc.title || "No matching article", topDocSolution: doc.solution || doc.content || "Standard triage runbook", similarity, matchCount: total, route };',
        }),
        node('RouteByScore', 'synapseflow.decision', 1020, 360, {
          input: '={{ $json.route }}',
          choices: [
            { name: 'auto_resolve', description: 'High confidence semantic match above 0.85 similarity' },
            { name: 'agent_triage', description: 'Medium confidence match between 0.50 and 0.85 similarity requiring AI Agent investigation' },
            { name: 'escalate', description: 'Low confidence match below 0.50 or missing article' },
          ],
        }),
        node('AutoResolve', 'n8n-nodes-base.code', 1300, 200, {
          code: 'const p = $input || {}; return { status: "resolved", resolutionType: "automated_rag", incidentId: p.incidentId, query: p.query, matchedDocId: p.topDocId, matchedDocTitle: p.topDocTitle, similarity: p.similarity, solution: p.topDocSolution, actionTaken: "KB runbook automatically dispatched to customer", resolvedAt: $now };',
        }),
        node('AgentTriage', 'synapseflow.agent', 1300, 360, {
          systemPrompt: 'You are an intelligent SRE & Support Specialist in SynapseFlow. Use vector search and tools to investigate tickets, verify knowledge base articles, and generate concise resolution reports.',
          input: '={{ "Incident: " + $json.incidentId + ". Query: " + $json.query + ". Top KB match: " + $json.topDocTitle + " (similarity: " + $json.similarity + "). Please provide resolution recommendation." }}',
          tools: ['synapsebase_vector_search', 'synapsebase_query', 'faststore_get'],
        }),
        node('AgentFormat', 'n8n-nodes-base.code', 1540, 360, {
          code: 'const p = $input || {}; return { status: "resolved", resolutionType: "agent_assisted_rag", incidentId: p.incidentId, query: p.query, similarity: p.similarity, solution: p.output || p.result || "Agent verified resolution from KB context", resolvedAt: $now };',
        }),
        node('EscalateQueue', 'synapseone.queue', 1300, 520, {
          operation: 'publish',
          input: {
            queue: 'incident-escalations',
            payload: '={{ $json }}',
          },
        }),
        node('EscalateFormat', 'n8n-nodes-base.code', 1540, 520, {
          code: 'const p = $input || {}; const incidentId = p.incidentId || p.message?.payload?.incidentId || p.payload?.incidentId; const query = p.query || p.message?.payload?.query || ""; const similarity = p.similarity ?? p.message?.payload?.similarity ?? 0; return { status: "escalated", resolutionType: "human_sre_queue", incidentId, query, similarity, queueId: p.id || p.messageId || "queued", actionTaken: "Dispatched to Tier-2 SRE queue", escalatedAt: $now };',
        }),
        node('CacheResult', 'synapseone.faststore', 1800, 360, {
          operation: 'set',
          input: {
            key: '={{ "rag:incident:" + $json.incidentId }}',
            value: '={{ JSON.stringify($json) }}',
            ttl: 3600,
          },
        }),
        node('FinalSummary', 'n8n-nodes-base.code', 2040, 360, {
          code: 'const p = $input || {}; return { ok: true, summary: "Pipeline completed for incident " + (p.incidentId || "unknown"), incidentId: p.incidentId, resolutionType: p.resolutionType, status: p.status, similarity: p.similarity, solution: p.solution, actionTaken: p.actionTaken, completedAt: $now };',
        }),
      ],
      connections: {
        Intake: { main: [[edge('Normalize')]] },
        Normalize: { main: [[edge('KBVectorSearch')]] },
        KBVectorSearch: { main: [[edge('ScoreMatch')]] },
        ScoreMatch: { main: [[edge('RouteByScore')]] },
        RouteByScore: {
          main: [
            [edge('AutoResolve')],
            [edge('AgentTriage')],
            [edge('EscalateQueue')],
          ],
        },
        AutoResolve: { main: [[edge('CacheResult'), edge('FinalSummary')]] },
        AgentTriage: { main: [[edge('AgentFormat')]] },
        AgentFormat: { main: [[edge('CacheResult'), edge('FinalSummary')]] },
        EscalateQueue: { main: [[edge('EscalateFormat')]] },
        EscalateFormat: { main: [[edge('CacheResult'), edge('FinalSummary')]] },
      },
    };
  }
  if (name === 'etl-batch-warehouse') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        {
          id: wid(), name: 'WarehouseETL', type: 'synapseone.api', typeVersion: 1, position: [460, 300],
          parameters: {
            resource: 'warehouse',
            operation: 'run-batch',
            input: {
              targetDatasetId: 'city_daily',
              writeMode: 'replace',
              name: 'Daily incident rollup',
              sql: "SELECT date_trunc('day', ts) AS day, category, count(*) AS events FROM city_incidents GROUP BY 1, 2 ORDER BY 1 DESC",
            },
          },
        },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [720, 300], parameters: {} },
      ],
      connections: {
        Manual: { main: [[{ node: 'WarehouseETL', type: 'main', index: 0 }]] },
        WarehouseETL: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'etl-stream-warehouse') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        {
          id: wid(), name: 'EnsureStreamJob', type: 'synapseone.api', typeVersion: 1, position: [460, 300],
          parameters: {
            resource: 'warehouse',
            operation: 'ensure-stream',
            input: {
              name: 'sensor-stream-ingest',
              targetDatasetId: 'sensor_readings',
              streamTopic: 'iot-sensors',
              batchSize: 100,
              intervalMs: 1000,
            },
          },
        },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [720, 300], parameters: {} },
      ],
      connections: {
        Manual: { main: [[{ node: 'EnsureStreamJob', type: 'main', index: 0 }]] },
        EnsureStreamJob: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'etl-stream-microbatch') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        {
          id: wid(), name: 'EnsureGroup', type: 'synapseone.api', typeVersion: 1, position: [380, 300],
          parameters: {
            resource: 'stream',
            operation: 'ensure-group',
            input: { topic: 'iot-sensors', group: 'warehouse-microbatch', startId: '0' },
          },
        },
        {
          id: wid(), name: 'Consume', type: 'synapseone.api', typeVersion: 1, position: [560, 300],
          parameters: {
            resource: 'stream',
            operation: 'consume',
            input: { topic: 'iot-sensors', group: 'warehouse-microbatch', count: 50, consumer: 'synapseflow-etl' },
          },
        },
        {
          id: wid(), name: 'Ingest', type: 'synapseone.api', typeVersion: 1, position: [740, 300],
          parameters: {
            resource: 'warehouse',
            operation: 'ingest',
            input: {
              datasetId: 'sensor_readings',
              rows: '={{ $json.events.map((event) => event.payload) }}',
            },
          },
        },
        {
          id: wid(), name: 'Ack', type: 'synapseone.api', typeVersion: 1, position: [920, 300],
          parameters: {
            resource: 'stream',
            operation: 'ack',
            input: {
              topic: 'iot-sensors',
              group: 'warehouse-microbatch',
              ids: '={{ $json.events.map((event) => event.id) }}',
            },
          },
        },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [1100, 300], parameters: {} },
      ],
      connections: {
        Manual: { main: [[{ node: 'EnsureGroup', type: 'main', index: 0 }]] },
        EnsureGroup: { main: [[{ node: 'Consume', type: 'main', index: 0 }]] },
        Consume: { main: [[{ node: 'Ingest', type: 'main', index: 0 }]] },
        Ingest: { main: [[{ node: 'Ack', type: 'main', index: 0 }]] },
        Ack: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'mcp-docs-reader') {
    return {
      name: wname,
      nodes: [
        {
          id: wid(), name: 'MCP Trigger', type: 'mcpTrigger', typeVersion: 1, position: [200, 300],
          parameters: {
            toolName: 'read_synapseone_docs',
            public: true,
            readOnly: true,
            description: 'Read SynapseOne documentation pages. Pass a repository docs path such as docs/api.md or docs/README.md.',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Docs path inside the SynapseOne repository (for example docs/api.md)' },
              },
              additionalProperties: false,
            },
          },
        },
        {
          id: wid(), name: 'Build docs URL', type: 'code', typeVersion: 2, position: [420, 300],
          parameters: {
            code: "const raw = String($input.path || 'docs/README.md').replace(/^\\/+/, '');\nif (!raw || raw.includes('..')) throw new Error('invalid docs path');\nreturn { path: raw, url: `https://raw.githubusercontent.com/vku-open-source-2026/SynapseOne/main/${raw}` };",
          },
        },
        {
          id: wid(), name: 'Fetch docs', type: 'httpRequest', typeVersion: 4.2, position: [640, 300],
          parameters: { url: '={{ $json.url }}', method: 'GET', timeoutMs: 30000, retry: { attempts: 2, delayMs: 500 } },
        },
        {
          id: wid(), name: 'Format docs', type: 'code', typeVersion: 2, position: [860, 300],
          parameters: {
            code: "const body = $json.body;\nconst text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);\nreturn { content: String(text || '').slice(0, 400000) };",
          },
        },
      ],
      connections: {
        'MCP Trigger': { main: [[{ node: 'Build docs URL', type: 'main', index: 0 }]] },
        'Build docs URL': { main: [[{ node: 'Fetch docs', type: 'main', index: 0 }]] },
        'Fetch docs': { main: [[{ node: 'Format docs', type: 'main', index: 0 }]] },
      },
      settings: { timeoutMs: 60000 },
    };
  }
  return null;
}
/** Local pre-filter for the cron loop; the authoritative cross-replica gate
 *  is the durable slot claim in the store (claimCronSlot). */
const lastCronRun = new Map<string, number>();

/** Recover executions whose runner/worker died mid-job (expired lease) and
 *  expire human tasks whose deadline passed. The queue is at-least-once, so a
 *  duplicate republish is harmless: claimExecutionRec is the exactly-one guard. */
export async function reclaimWorkflowStateOnce(opts: { resumeStaleMs?: number } = {}): Promise<{ reclaimed: number; republished: number; expiredTasks: number; reconciledTasks: number }> {
  let reclaimed = 0;
  let republished = 0;
  let expiredTasks = 0;
  const expired = await listExpiredRunningExecutions(200);
  for (const exec of expired) {
    const reclaimedExec = await reclaimExpiredExecution(exec.id).catch(() => null);
    if (!reclaimedExec) continue;
    reclaimed += 1;
    if (!reclaimedExec.queue_name || reclaimedExec.runner === 'inline') {
      await finishExecutionRec(reclaimedExec.id, {
        status: 'error', output: reclaimedExec.output, node_runs: reclaimedExec.node_runs,
        error: 'execution lease expired; the inline runner did not report a result',
        finishedAt: new Date().toISOString(), allowedStatuses: ['queued'],
      }).catch(() => null);
      continue;
    }
    try {
      await publishExistingExecution(reclaimedExec, 0, `reclaim:${reclaimedExec.id}`);
      republished += 1;
    } catch (e: any) {
      console.error(`[workflow][reclaim] republish ${reclaimedExec.id} failed:`, e?.message || e);
    }
  }
  // Queued rows with no consumer activity (lost publish, queue wipe) are also
  // recoverable work. Republish after two visibility windows.
  if (queueTransportEnabled()) {
    const staleAfterMs = Math.max(60, queueVisibilitySeconds() * 2) * 1000;
    const queued = await listExecutionRecs({ status: 'queued', limit: 500 }).catch(() => ({ items: [] as StoredExecution[] }));
    for (const exec of queued.items) {
      if (!exec.queue_name || exec.runner === 'inline') continue;
      if (Date.now() - new Date(exec.startedAt).getTime() < staleAfterMs) continue;
      try {
        await publishExistingExecution(exec, 0, `stale:${exec.id}`);
        republished += 1;
      } catch (e: any) {
        console.error(`[workflow][reclaim] stale queued ${exec.id} republish failed:`, e?.message || e);
      }
    }
  }
  // Reconcile decisions that were reserved as `resuming` but whose process
  // died before dispatch. This is the durable recovery path for the
  // reservation→dispatch crash window: a still-paused execution gets its task
  // back for retry; an accepted/terminal execution completes the task.
  const staleResumeAfterMs = opts.resumeStaleMs ?? Math.max(15, Number(process.env.WORKFLOW_RESUME_STALE_SECONDS || 60) || 60) * 1000;
  const resuming = await listStaleResumingHumanTasks(staleResumeAfterMs, 200).catch(() => []);
  let reconciledTasks = 0;
  for (const task of resuming) {
    const exec = task.execution_id ? await getExecutionRec(task.execution_id).catch(() => null) : null;
    if (!exec) {
      const closed = await transitionHumanTaskRec(task.id, ['resuming'], {
        status: 'cancelled', escalated_at: new Date().toISOString(),
      }).catch(() => null);
      if (closed) reconciledTasks += 1;
      continue;
    }
    if (exec.status === 'paused') {
      const restored = await transitionHumanTaskRec(task.id, ['resuming'], {
        status: task.claimed_by ? 'claimed' : 'pending',
        claimed_by: task.claimed_by || null,
        claimed_at: task.claimed_at || null,
        completed_by: null,
        completed_at: null,
        decision: null,
        note: null,
        escalated_at: null,
      }).catch(() => null);
      if (restored) reconciledTasks += 1;
      continue;
    }
    const decision = task.decision && typeof task.decision === 'object' ? task.decision as any : {};
    const done = await transitionHumanTaskRec(task.id, ['resuming'], {
      status: decision.approved === false ? 'rejected' : 'completed',
    }).catch(() => null);
    if (done) reconciledTasks += 1;
  }
  const overdue = await listOverdueHumanTasks(200).catch(() => []);
  for (const task of overdue) {
    const updated = await transitionHumanTaskRec(task.id, ['pending', 'claimed'], {
      status: 'expired', escalated_at: new Date().toISOString(),
    }).catch(() => null);
    if (!updated) continue;
    expiredTasks += 1;
    if (updated.execution_id) {
      const exec = await getExecutionRec(updated.execution_id).catch(() => null);
      if (exec && exec.status === 'paused') {
        await finishExecutionRec(exec.id, {
          status: 'error', output: exec.output, node_runs: exec.node_runs,
          error: `human task '${updated.title}' expired before a decision`,
          finishedAt: new Date().toISOString(), allowedStatuses: ['paused'],
        }).catch(() => null);
      }
    }
  }
  return { reclaimed, republished, expiredTasks, reconciledTasks };
}

export function startWorkflowReclaimer(): void {
  const everyMs = Math.max(5000, Number(process.env.WORKFLOW_RECLAIM_TICK_MS || 30000));
  const tick = () => {
    reclaimWorkflowStateOnce().catch((e: any) => console.error('[workflow][reclaim] tick failed:', e?.message || e));
  };
  setInterval(tick, everyMs).unref?.();
  setTimeout(tick, 5000).unref?.();
}


function startCronLoop(): void {
  const everyMs = Math.max(10000, Number(process.env.WORKFLOW_CRON_TICK_MS || 15000));
  const tick = async () => {
    try {
      const actives = await listActiveCronWorkflows();
      const now = Date.now();
      for (const wf of actives) {
        if (wf.org_id && await orgSuspended(wf.org_id)) continue;
        const interval = workflowCronIntervalMs({ nodes: wf.nodes as any });
        const wallClock = !interval ? workflowCronNextRunAt({ nodes: wf.nodes as any }, now) : null;
        if (!interval && !wallClock) continue;
        const last = lastCronRun.get(wf.id) || 0;
        if (interval) {
          if (now - last < interval) continue;
        } else if (!(wallClock && wallClock <= now && last < wallClock)) {
          continue;
        }
        // Durable cross-replica claim: the slot (interval bucket or the
        // wall-clock timestamp) is claimed in Postgres, so N replicas ticking
        // the same schedule enqueue exactly once. The local map stays as a
        // cheap pre-filter; the claim is authoritative.
        const slot = interval ? `i:${Math.floor(now / interval)}` : `w:${wallClock}`;
        if (!(await claimCronSlot(wf.id, slot))) continue;
        lastCronRun.set(wf.id, now);
        try {
          const runPrincipal = workflowRunPrincipal(wf);
          const mode = runnerModeForSettings(wf.settings);
          if (!queueTransportEnabled() && (mode === 'custom' || mode === 'hybrid' || mode === 'system')) {
            console.error(`[workflow][cron] ${wf.name} (${wf.id}) requires a ${mode} queue but SynapseQueue is not configured — skipped`);
            continue;
          }
          if (queueTransportEnabled() && mode !== 'inline') {
            const { execution, queue } = await enqueueExecution({
              wf, input: { scheduledAt: new Date().toISOString() }, triggeredBy: 'cron', principal: runPrincipal,
            });
            recordRun('cron', 'queued');
            console.log(`[workflow][cron] ${wf.name} (${wf.id}) queued on ${queue} as ${execution.id}`);
            continue;
          }
          const startedAt = new Date().toISOString();
          const executionId = randomUUID();
          const r = await runWorkflow(
            { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
            { scheduledAt: startedAt },
            {
              triggeredBy: 'cron', principal: runPrincipal,
              credentialResolver: makeCredentialResolver(runPrincipal), synapseoneCall,
              humanTask: inlineHumanTaskSink(executionId, wf, runPrincipal),
            },
          );
          const finishedAt = new Date().toISOString();
          recordRun('cron', r.status, r.nodeRuns);
          await createExecutionRec({
            id: executionId,
            workflow_id: wf.id, workflow_name: wf.name, status: r.status,
            input: { scheduledAt: startedAt }, output: r.output, node_runs: r.nodeRuns as any,
            error: (r as any).error ?? null, triggered_by: 'cron',
            principal: runPrincipal, actor: actorFor(wf.id, runPrincipal), startedAt, finishedAt,
            workflow_revision: wf.revision,
            ...pauseBinding(r),
          });
          console.log(`[workflow][cron] ${wf.name} (${wf.id}) -> ${r.status}`);
        } catch (e: any) {
          console.error(`[workflow][cron] ${wf.id} failed:`, e?.message || e);
        }
      }
    } catch (e: any) {
      console.error('[workflow][cron] tick failed:', e?.message || e);
    }
  };
  setInterval(tick, everyMs).unref?.();
  // Jittered first tick so a fresh deploy doesn't thundering-herd crons.
  setTimeout(tick, Math.min(everyMs, 5000)).unref?.();
}

if (require.main === module) {
  ensureTables()
    .then(() => {
      const app = createApp();
      startCronLoop();
      startWorkflowReclaimer();
      const workerEnabled = queueTransportEnabled() && String(process.env.WORKFLOW_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
      const worker = workerEnabled ? startPlatformWorker({ synapseoneCall, makeCredentialResolver, recordRun }) : null;
      const server = app.listen(PORT, () => console.log(`[workflow] listening on :${PORT} engine=local db=${useDb() ? 'postgres' : 'memory'} transport=${queueTransportEnabled() ? 'queue' : 'inline'} worker=${workerEnabled ? platformWorkerId() : 'off'}`));
      const shutdown = () => {
        console.log('[workflow] shutting down...');
        worker?.stop();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 8000).unref();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((e: any) => {
      // A failed/partial migration must never accept workflow traffic.
      console.error('[workflow][fatal] startup failed:', e?.message || e);
      process.exit(1);
    });
}

// Exported for tests (start loop only under main).
export { detectCycle, ensureTables, startCronLoop };
