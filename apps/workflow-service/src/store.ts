// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Local workflow persistence — Drizzle ORM on Postgres with in-memory
 * fallback for dev/test. Tables/indexes live in ./schema.ts and are applied by
 * versioned Drizzle migrations.
 */
import './env-compat';
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isWebhookType, isCronType, normalizeNodeType } from './engine';
import { credentials, executions, humanTasks, inferenceJobs, secrets, secretVersions, workflowRunnerInstances, workflowRunners, workflows } from './schema';

/** Caller principal stamped by the gateway (P0-2). Anonymous when called
 *  directly with only the internal secret (dev/tests). */
export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

export interface StoredWorkflow {
  id: string;
  name: string;
  nodes: any[];
  connections: Record<string, any>;
  settings: Record<string, any>;
  active: boolean;
  /** Tenant binding (P0-3): null = legacy global workflow. */
  org_id?: string | null;
  account_id?: string | null;
  owner_sub?: string | null;
  run_as?: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface StoredExecution {
  id: string;
  workflow_id: string;
  workflow_name?: string;
  status: 'queued' | 'running' | 'success' | 'error' | 'paused' | 'cancelled';
  input: any;
  output: any;
  node_runs: Array<{
    node: string;
    type: string;
    status: 'success' | 'error' | 'skipped';
    input: any;
    output: any;
    error?: string;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
  }>;
  error?: string | null;
  triggered_by: string;
  /** Principal snapshot at run time (P0-2/P0-3) + audit actor string. */
  principal?: Principal | null;
  actor?: string | null;
  /** Queue dispatch metadata (queue execution mode). */
  queue_name?: string | null;
  runner?: string | null;
  worker_id?: string | null;
  attempt?: number;
  lease_expires_at?: string | null;
  workflow_revision?: number | null;
  resume_node?: string | null;
  resume_output?: any;
  startedAt: string;
  finishedAt: string;
}

export type RunnerMode = 'custom' | 'hybrid';

export type RunnerKind = 'workflow' | 'inference' | 'hybrid';

export interface StoredWorkflowRunner {
  id: string;
  name: string;
  kind: RunnerKind;
  mode: RunnerMode;
  queue: string;
  inference_queue?: string | null;
  org_id?: string | null;
  account_id?: string | null;
  api_key_id?: string | null;
  key_prefix?: string | null;
  status: 'waiting' | 'connected' | 'stale' | 'disabled';
  version?: string | null;
  last_seen_at?: string | null;
  last_error?: string | null;
  created_by?: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface StoredRunnerInstance {
  id: string;
  runner_id: string;
  hostname: string;
  version?: string | null;
  queue: string;
  concurrency: number;
  status: 'connected' | 'offline';
  last_seen_at: string;
  started_at?: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface StoredInferenceJob {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
  request: any;
  result: any;
  error?: string | null;
  org_id?: string | null;
  account_id?: string | null;
  runner_id?: string | null;
  instance_id?: string | null;
  queue_name?: string | null;
  attempt: number;
  lease_expires_at?: string | null;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
}

const DATABASE_URL = process.env.DATABASE_URL || '';
// Migrations need a stable Postgres session; bypass PgBouncer transaction mode.
const DIRECT_DATABASE_URL = process.env.DATABASE_DIRECT_URL || DATABASE_URL;
let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[workflow][db] pool error', (e as any)?.message || e));
}
let directPool: Pool | null = null;
function getDirectPool(): Pool | null {
  if (!DIRECT_DATABASE_URL) return null;
  if (!directPool) {
    directPool = new Pool({ connectionString: DIRECT_DATABASE_URL, max: 2 });
    directPool.on('error', (e) => console.error('[workflow][db] direct pool error', (e as any)?.message || e));
  }
  return directPool;
}
const db = pool ? drizzle(pool, { schema: { credentials, executions, inferenceJobs, workflowRunnerInstances, workflowRunners, workflows } }) : null;

export function useDb(): boolean {
  return !!db;
}

// ---- in-memory fallback ----
const memWorkflows = new Map<string, StoredWorkflow>();
const memExecutions = new Map<string, StoredExecution>();
const memRunners = new Map<string, StoredWorkflowRunner>();
const memRunnerInstances = new Map<string, StoredRunnerInstance>();
const memInferenceJobs = new Map<string, StoredInferenceJob>();
// newest-first ordering helper
const memExecOrder: string[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function iso(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return String(v);
  }
  return nowIso();
}

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!db || ensured) return;
  ensured = true;
  try {
    const client = await getDirectPool()!.connect();
    try {
      // Hold the advisory lock on the same dedicated session that runs the
      // migration (pool connections are not guaranteed to be reused).
      const migrationDb = drizzle(client, { schema: { credentials, executions, inferenceJobs, workflowRunnerInstances, workflowRunners, workflows } });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapseone_workflow_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_workflow',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapseone_workflow_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[workflow][db] migrations failed:', e?.message || e);
  }
}

function cleanTenant(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function rowToWorkflow(r: typeof workflows.$inferSelect): StoredWorkflow {
  return {
    id: String(r.id),
    name: String(r.name || ''),
    nodes: Array.isArray(r.nodes)
      ? r.nodes.map((n: any) => {
          const type = normalizeNodeType(n?.type);
          return type === n?.type ? n : { ...n, type };
        })
      : [],
    connections: r.connections && typeof r.connections === 'object' ? r.connections : {},
    settings: r.settings && typeof r.settings === 'object' ? r.settings : {},
    active: !!r.active,
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    owner_sub: r.ownerSub != null ? String(r.ownerSub) : null,
    run_as: r.runAs != null ? String(r.runAs) : null,
    revision: Number.isFinite(Number(r.revision)) ? Number(r.revision) : 1,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function rowToExecution(r: typeof executions.$inferSelect): StoredExecution {
  let principal: Principal | null = null;
  try {
    const p = r.principal;
    if (p && typeof p === 'object' && typeof (p as any).sub === 'string') principal = p as Principal;
  } catch { /* ignore */ }
  return {
    id: String(r.id),
    workflow_id: String(r.workflowId || ''),
    workflow_name: String(r.workflowName || ''),
    status: r.status === 'error' ? 'error'
      : r.status === 'running' ? 'running'
        : r.status === 'paused' ? 'paused'
          : r.status === 'queued' ? 'queued'
            : r.status === 'cancelled' ? 'cancelled' : 'success',
    input: r.input ?? {},
    output: r.output ?? null,
    node_runs: Array.isArray(r.nodeRuns) ? r.nodeRuns : [],
    error: r.error ?? null,
    triggered_by: String(r.triggeredBy || 'manual'),
    principal,
    actor: r.actor != null ? String(r.actor) : null,
    queue_name: r.queueName != null ? String(r.queueName) : null,
    runner: r.runner != null ? String(r.runner) : null,
    worker_id: r.workerId != null ? String(r.workerId) : null,
    attempt: Number.isFinite(Number(r.attempt)) ? Number(r.attempt) : 0,
    lease_expires_at: r.leaseExpiresAt ? iso(r.leaseExpiresAt) : null,
    workflow_revision: r.workflowRevision != null ? Number(r.workflowRevision) : null,
    resume_node: r.resumeNode != null ? String(r.resumeNode) : null,
    resume_output: r.resumeOutput ?? null,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}

export async function createWorkflowRec(data: {
  name: string;
  nodes: any[];
  connections: Record<string, any>;
  settings?: Record<string, any>;
  active?: boolean;
  org_id?: string | null;
  account_id?: string | null;
  owner_sub?: string | null;
  run_as?: string | null;
}): Promise<StoredWorkflow> {
  const rec: StoredWorkflow = {
    id: randomUUID(),
    name: data.name,
    nodes: data.nodes || [],
    connections: data.connections || {},
    settings: data.settings || {},
    active: !!data.active,
    org_id: cleanTenant(data.org_id),
    account_id: cleanTenant(data.account_id),
    owner_sub: cleanTenant(data.owner_sub),
    run_as: cleanTenant(data.run_as),
    revision: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(workflows).values({
      id: rec.id,
      name: rec.name,
      nodes: rec.nodes,
      connections: rec.connections,
      settings: rec.settings,
      active: rec.active,
      orgId: rec.org_id,
      accountId: rec.account_id,
      ownerSub: rec.owner_sub,
      runAs: rec.run_as,
      revision: 1,
    }).returning();
    return rowToWorkflow(rows[0]);
  }
  memWorkflows.set(rec.id, rec);
  return rec;
}

export async function getWorkflowRec(id: string): Promise<StoredWorkflow | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    return rows[0] ? rowToWorkflow(rows[0]) : null;
  }
  return memWorkflows.get(id) || null;
}

export async function listWorkflowRecs(filter?: { orgId?: string; accountId?: string }): Promise<StoredWorkflow[]> {
  if (db) {
    await ensureTables();
    const conds = [];
    if (filter?.orgId) conds.push(eq(workflows.orgId, filter.orgId));
    if (filter?.accountId) conds.push(eq(workflows.accountId, filter.accountId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(workflows).where(where).orderBy(asc(workflows.createdAt));
    return rows.map(rowToWorkflow);
  }
  let arr = [...memWorkflows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (filter?.orgId) arr = arr.filter((w) => w.org_id === filter.orgId);
  if (filter?.accountId) arr = arr.filter((w) => w.account_id === filter.accountId);
  return arr;
}

export async function updateWorkflowRec(
  id: string,
  patch: { name?: string; nodes?: any[]; connections?: Record<string, any>; settings?: Record<string, any>; active?: boolean; org_id?: string | null; account_id?: string | null; run_as?: string | null },
): Promise<StoredWorkflow | null> {
  if (db) {
    await ensureTables();
    const cur = await getWorkflowRec(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      nodes: patch.nodes ?? cur.nodes,
      connections: patch.connections ?? cur.connections,
      settings: patch.settings ?? cur.settings,
      active: patch.active ?? cur.active,
      orgId: patch.org_id !== undefined ? cleanTenant(patch.org_id) : cur.org_id,
      accountId: patch.account_id !== undefined ? cleanTenant(patch.account_id) : cur.account_id,
      runAs: patch.run_as !== undefined ? cleanTenant(patch.run_as) : cur.run_as,
    };
    const rows = await db.update(workflows).set({
      ...next,
      revision: sql`${workflows.revision} + 1`,
      updatedAt: new Date(),
    }).where(eq(workflows.id, id)).returning();
    return rows[0] ? rowToWorkflow(rows[0]) : null;
  }
  const cur = memWorkflows.get(id);
  if (!cur) return null;
  const next: StoredWorkflow = {
    ...cur,
    name: patch.name ?? cur.name,
    nodes: patch.nodes ?? cur.nodes,
    connections: patch.connections ?? cur.connections,
    settings: patch.settings ?? cur.settings,
    active: patch.active ?? cur.active,
    org_id: patch.org_id !== undefined ? cleanTenant(patch.org_id) : cur.org_id,
    account_id: patch.account_id !== undefined ? cleanTenant(patch.account_id) : cur.account_id,
    run_as: patch.run_as !== undefined ? cleanTenant(patch.run_as) : cur.run_as,
    revision: (cur.revision || 1) + 1,
    updated_at: nowIso(),
  };
  memWorkflows.set(id, next);
  return next;
}

export async function deleteWorkflowRec(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(workflows).where(eq(workflows.id, id)).returning({ id: workflows.id });
    return rows.length > 0;
  }
  return memWorkflows.delete(id);
}

export async function createExecutionRec(data: {
  workflow_id: string;
  workflow_name?: string;
  status: StoredExecution['status'];
  input: any;
  output: any;
  node_runs: StoredExecution['node_runs'];
  error?: string | null;
  triggered_by: string;
  principal?: Principal | null;
  actor?: string | null;
  startedAt: string;
  finishedAt?: string;
  id?: string;
  queue_name?: string | null;
  runner?: string | null;
  worker_id?: string | null;
  attempt?: number;
  lease_expires_at?: string | null;
  workflow_revision?: number | null;
  resume_node?: string | null;
  resume_output?: any;
}): Promise<StoredExecution> {
  const rec: StoredExecution = {
    id: data.id || randomUUID(),
    workflow_id: data.workflow_id,
    workflow_name: data.workflow_name || '',
    status: data.status,
    input: data.input ?? {},
    output: data.output ?? null,
    node_runs: data.node_runs || [],
    error: data.error ?? null,
    triggered_by: data.triggered_by || 'manual',
    principal: data.principal ?? null,
    actor: data.actor ?? null,
    queue_name: data.queue_name ?? null,
    runner: data.runner ?? null,
    worker_id: data.worker_id ?? null,
    attempt: data.attempt ?? 0,
    lease_expires_at: data.lease_expires_at ?? null,
    workflow_revision: data.workflow_revision ?? null,
    resume_node: data.resume_node ?? null,
    resume_output: data.resume_output ?? null,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt || data.startedAt,
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(executions).values({
      id: rec.id,
      workflowId: rec.workflow_id,
      workflowName: rec.workflow_name,
      status: rec.status,
      input: rec.input ?? {},
      output: rec.output ?? null,
      nodeRuns: rec.node_runs ?? [],
      error: rec.error,
      triggeredBy: rec.triggered_by,
      principal: rec.principal,
      actor: rec.actor,
      queueName: rec.queue_name,
      runner: rec.runner,
      workerId: rec.worker_id,
      attempt: rec.attempt ?? 0,
      leaseExpiresAt: rec.lease_expires_at ? new Date(rec.lease_expires_at) : null,
      workflowRevision: rec.workflow_revision,
      resumeNode: rec.resume_node,
      resumeOutput: rec.resume_output ?? null,
      startedAt: new Date(rec.startedAt),
      finishedAt: new Date(rec.finishedAt),
    }).returning();
    return rowToExecution(rows[0]);
  }
  memExecutions.set(rec.id, rec);
  memExecOrder.unshift(rec.id);
  if (memExecOrder.length > 2000) {
    const drop = memExecOrder.pop();
    if (drop) memExecutions.delete(drop);
  }
  return rec;
}

export async function getExecutionRec(id: string): Promise<StoredExecution | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  return memExecutions.get(id) || null;
}

export async function listExecutionRecs(opts: {
  workflowId?: string;
  status?: string;
  triggeredBy?: string;
  /** Tenant filters (P0-3/#6): match the principal snapshot stored at run time. */
  orgId?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: StoredExecution[]; total?: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (db) {
    await ensureTables();
    const conds = [];
    if (opts.workflowId) conds.push(eq(executions.workflowId, opts.workflowId));
    if (opts.status) conds.push(eq(executions.status, opts.status));
    if (opts.triggeredBy) conds.push(eq(executions.triggeredBy, opts.triggeredBy));
    if (opts.orgId) conds.push(sql`${executions.principal}->>'org' = ${opts.orgId}`);
    if (opts.accountId) conds.push(sql`${executions.principal}->>'account' = ${opts.accountId}`);
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(executions)
      .where(where)
      .orderBy(desc(executions.startedAt))
      .limit(limit)
      .offset(offset);
    return { items: rows.map(rowToExecution) };
  }
  let arr = memExecOrder.map((id) => memExecutions.get(id)!).filter(Boolean);
  if (opts.workflowId) arr = arr.filter((e) => e.workflow_id === opts.workflowId);
  if (opts.status) arr = arr.filter((e) => e.status === opts.status);
  if (opts.triggeredBy) arr = arr.filter((e) => e.triggered_by === opts.triggeredBy);
  if (opts.orgId) arr = arr.filter((e) => (e.principal?.org || null) === opts.orgId);
  if (opts.accountId) arr = arr.filter((e) => (e.principal?.account || null) === opts.accountId);
  return { items: arr.slice(offset, offset + limit) };
}

/** Atomically claim a queued execution (or an expired running lease) for a
 *  worker. Returns null when another worker already owns it or it finished.
 *  This is the cross-worker exactly-one-runner guard; the queue itself is
 *  at-least-once, so duplicates are expected and discarded here. */
export async function claimExecutionRec(id: string, opts: { workerId: string; leaseSeconds: number }): Promise<StoredExecution | null> {
  const leaseSeconds = Math.min(Math.max(Number(opts.leaseSeconds) || 300, 15), 3600);
  const workerId = String(opts.workerId || '').slice(0, 128) || 'worker';
  const now = new Date();
  const lease = new Date(now.getTime() + leaseSeconds * 1000);
  if (db) {
    await ensureTables();
    const rows = await db.update(executions).set({
      status: 'running',
      workerId,
      leaseExpiresAt: lease,
      attempt: sql`${executions.attempt} + 1`,
      startedAt: sql`case when ${executions.status} = 'queued' then ${now} else ${executions.startedAt} end`,
      error: null,
    }).where(and(
      eq(executions.id, id),
      or(
        eq(executions.status, 'queued'),
        and(eq(executions.status, 'running'), or(isNull(executions.leaseExpiresAt), lt(executions.leaseExpiresAt, now))),
      ),
    )).returning();
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  const cur = memExecutions.get(id);
  if (!cur) return null;
  const expired = cur.status === 'running'
    && (!cur.lease_expires_at || new Date(cur.lease_expires_at).getTime() < now.getTime());
  if (cur.status !== 'queued' && !expired) return null;
  const next: StoredExecution = {
    ...cur,
    status: 'running',
    worker_id: workerId,
    lease_expires_at: lease.toISOString(),
    attempt: (cur.attempt || 0) + 1,
    error: null,
  };
  memExecutions.set(id, next);
  return next;
}

/** Extend the execution lease while a runner is still working. */
export async function heartbeatExecutionRec(id: string, opts: { workerId: string; leaseSeconds: number }): Promise<StoredExecution | null> {
  const leaseSeconds = Math.min(Math.max(Number(opts.leaseSeconds) || 300, 15), 3600);
  const lease = new Date(Date.now() + leaseSeconds * 1000);
  if (db) {
    await ensureTables();
    const rows = await db.update(executions).set({
      leaseExpiresAt: lease,
      workerId: String(opts.workerId || '').slice(0, 128) || 'worker',
    }).where(and(eq(executions.id, id), eq(executions.status, 'running'))).returning();
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  const cur = memExecutions.get(id);
  if (!cur || cur.status !== 'running') return null;
  const next: StoredExecution = { ...cur, lease_expires_at: lease.toISOString() };
  memExecutions.set(id, next);
  return next;
}

/** Put a claimed execution back in the queue after a retryable failure. The
 *  queue message is nacked separately; the next delivery can claim it again. */
export async function releaseExecutionRec(id: string, opts: { workerId?: string; error?: string }): Promise<StoredExecution | null> {
  if (db) {
    await ensureTables();
    const conds: any[] = [eq(executions.id, id), eq(executions.status, 'running')];
    if (opts.workerId) conds.push(eq(executions.workerId, opts.workerId));
    const rows = await db.update(executions).set({
      status: 'queued',
      workerId: null,
      leaseExpiresAt: null,
      error: opts.error ? String(opts.error).slice(0, 1000) : null,
    }).where(and(...conds)).returning();
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  const cur = memExecutions.get(id);
  if (!cur || cur.status !== 'running') return null;
  if (opts.workerId && cur.worker_id && cur.worker_id !== opts.workerId) return null;
  const next: StoredExecution = {
    ...cur,
    status: 'queued',
    worker_id: null,
    lease_expires_at: null,
    error: opts.error ? String(opts.error).slice(0, 1000) : null,
  };
  memExecutions.set(id, next);
  return next;
}

/** Mark a running execution as paused on a durable human task. */
export async function pauseExecutionRec(id: string, patch: {
  output: any;
  node_runs: StoredExecution['node_runs'];
  error?: string | null;
  workerId?: string | null;
}): Promise<StoredExecution | null> {
  if (db) {
    await ensureTables();
    const conds: any[] = [eq(executions.id, id), eq(executions.status, 'running')];
    if (patch.workerId) conds.push(eq(executions.workerId, patch.workerId));
    const rows = await db.update(executions).set({
      status: 'paused',
      output: patch.output,
      nodeRuns: patch.node_runs,
      error: patch.error ?? null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
    }).where(and(...conds)).returning();
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  const cur = memExecutions.get(id);
  if (!cur || cur.status !== 'running') return null;
  if (patch.workerId && cur.worker_id && cur.worker_id !== patch.workerId) return null;
  const next: StoredExecution = {
    ...cur,
    status: 'paused',
    output: patch.output,
    node_runs: patch.node_runs,
    error: patch.error ?? null,
    lease_expires_at: null,
    finishedAt: new Date().toISOString(),
  };
  memExecutions.set(id, next);
  return next;
}

/** Queued/expired executions the built-in platform worker is allowed to run. */
export async function listRunnableExecutions(limit = 50, now = new Date()): Promise<StoredExecution[]> {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  if (db) {
    await ensureTables();
    const rows = await db.select().from(executions).where(and(
      inArray(executions.runner, ['platform', 'hybrid']),
      isNotNull(executions.queueName),
      or(
        eq(executions.status, 'queued'),
        and(eq(executions.status, 'running'), or(isNull(executions.leaseExpiresAt), lt(executions.leaseExpiresAt, now))),
      ),
    )).orderBy(asc(executions.startedAt)).limit(cap);
    return rows.map(rowToExecution);
  }
  const arr = memExecOrder.map((id) => memExecutions.get(id)!).filter(Boolean).filter((e) =>
    (e.runner === 'platform' || e.runner === 'hybrid')
    && !!e.queue_name
    && (e.status === 'queued'
      || (e.status === 'running' && (!e.lease_expires_at || new Date(e.lease_expires_at).getTime() < now.getTime()))),
  );
  return arr.slice(0, cap);
}

export async function findActiveWebhookWorkflow(path: string): Promise<StoredWorkflow | null> {  const clean = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  const all = await listWorkflowRecs();
  for (const w of all) {
    if (!w.active) continue;
    for (const n of w.nodes || []) {
      if (!isWebhookType((n as any)?.type)) continue;
      const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
      if (p === clean) return w;
    }
  }
  return null;
}

export async function listActiveCronWorkflows(): Promise<StoredWorkflow[]> {
  const all = await listWorkflowRecs();
  return all.filter((w) => w.active && (w.nodes || []).some((n) => isCronType((n as any)?.type)));
}

// ---------- credentials (P0-4): account-scoped secrets, encrypted at rest ----------

export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'hmac';

export interface StoredCredential {
  id: string;
  account_id: string;
  /** Owning org (P0-4/#5): null only for legacy/anonymous dev credentials. */
  org_id?: string | null;
  /** Owning principal subject. Null on legacy rows; when set, only that subject
   *  may resolve the credential. */
  owner_sub?: string | null;
  name: string;
  kind: CredentialKind;
  /** AES-256-GCM envelope: {iv, tag, data} base64 (never the raw secret). */
  secret_enc: string;
  created_at: string;
  updated_at: string;
}

/** Kept for callers/back-compat; credentials are part of the same migration set. */
export async function ensureCredentialTables(): Promise<void> {
  await ensureTables();
}

const memCredentials = new Map<string, StoredCredential>();

function credKey(): Buffer {
  // Production requires an explicit 32-byte hex key; dev falls back to an
  // ephemeral key (secrets don't survive restart — fail-safe, never plaintext).
  const raw = (process.env.SYNAPSEONE_CREDENTIAL_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[workflow] SYNAPSEONE_CREDENTIAL_KEY must be a 32-byte hex string in production');
  }
  if (!(globalThis as any).__synapseoneCredKey) {
    console.warn('[workflow][security] SYNAPSEONE_CREDENTIAL_KEY not set — using an ephemeral dev key (credentials reset on restart).');
    (globalThis as any).__synapseoneCredKey = require('crypto').randomBytes(32);
  }
  return (globalThis as any).__synapseoneCredKey;
}

/** Encrypt a secret envelope (AES-256-GCM). Returns opaque base64 JSON. */
export function encryptSecret(plain: string): string {
  const crypto = require('crypto');
  const key = credKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(JSON.stringify({
    iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64'),
  })).toString('base64');
}

/** Decrypt an envelope produced by encryptSecret. Throws on tamper. */
export function decryptSecret(enc: string): string {
  const crypto = require('crypto');
  const key = credKey();
  const { iv, tag, data } = JSON.parse(Buffer.from(String(enc), 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function rowToCredential(r: typeof credentials.$inferSelect): StoredCredential {
  return {
    id: String(r.id),
    account_id: String(r.accountId || ''),
    org_id: r.orgId ? String(r.orgId) : null,
    owner_sub: r.ownerSub ? String(r.ownerSub) : null,
    name: String(r.name || ''),
    kind: (['bearer', 'api-key', 'basic', 'hmac'].includes(r.kind) ? r.kind : 'bearer') as CredentialKind,
    secret_enc: String(r.secretEnc || ''),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

/** Public metadata shape — never includes secret material. */
export function toPublicCredential(c: StoredCredential): any {
  return {
    id: c.id,
    accountId: c.account_id,
    name: c.name,
    kind: c.kind,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    ...(c.owner_sub ? { owner: c.owner_sub } : {}),
  };
}

export async function createCredentialRec(data: { account_id: string; org_id?: string | null; owner_sub?: string | null; name: string; kind: CredentialKind; secret: string }): Promise<StoredCredential> {
  const rec: StoredCredential = {
    id: randomUUID(), account_id: data.account_id, org_id: data.org_id ?? null, owner_sub: cleanTenant(data.owner_sub), name: data.name, kind: data.kind,
    secret_enc: encryptSecret(data.secret), created_at: nowIso(), updated_at: nowIso(),
  };
  if (db) {
    await ensureCredentialTables();
    try {
      const rows = await db.insert(credentials).values({
        id: rec.id,
        accountId: rec.account_id,
        orgId: rec.org_id,
        ownerSub: rec.owner_sub,
        name: rec.name,
        kind: rec.kind,
        secretEnc: rec.secret_enc,
      }).returning();
      return rowToCredential(rows[0]);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        throw Object.assign(new Error(`credential name '${data.name}' already exists in this account`), { code: 'conflict' });
      }
      throw e;
    }
  }
  for (const c of memCredentials.values()) {
    if (c.account_id === rec.account_id && c.name === rec.name) {
      throw Object.assign(new Error(`credential name '${data.name}' already exists in this account`), { code: 'conflict' });
    }
  }
  memCredentials.set(rec.id, rec);
  return rec;
}

export async function getCredentialRec(id: string): Promise<StoredCredential | null> {
  if (db) {
    await ensureCredentialTables();
    const rows = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1);
    return rows[0] ? rowToCredential(rows[0]) : null;
  }
  return memCredentials.get(id) || null;
}

/** List credential metadata. `accountId` narrows by owning account; `orgId`
 *  (P0-4/#5) narrows by owning org — org-scoped callers must not see legacy
 *  rows without an org binding. */
export async function listCredentialRecs(accountId?: string, orgId?: string): Promise<StoredCredential[]> {
  if (db) {
    await ensureCredentialTables();
    const conds = [];
    if (accountId) conds.push(eq(credentials.accountId, accountId));
    if (orgId) conds.push(eq(credentials.orgId, orgId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(credentials).where(where).orderBy(asc(credentials.createdAt));
    return rows.map(rowToCredential);
  }
  let arr = [...memCredentials.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (accountId) arr = arr.filter((c) => c.account_id === accountId);
  if (orgId) arr = arr.filter((c) => (c.org_id || null) === orgId);
  return arr;
}

/** Replace a credential's secret (rotation). Returns null when the id is unknown. */
export async function rotateCredentialRec(id: string, secret: string): Promise<StoredCredential | null> {
  const secret_enc = encryptSecret(secret);
  const updated_at = nowIso();
  if (db) {
    await ensureCredentialTables();
    const rows = await db.update(credentials)
      .set({ secretEnc: secret_enc, updatedAt: new Date(updated_at) })
      .where(eq(credentials.id, id))
      .returning();
    return rows[0] ? rowToCredential(rows[0]) : null;
  }
  const cur = memCredentials.get(id);
  if (!cur) return null;
  const next: StoredCredential = { ...cur, secret_enc, updated_at };
  memCredentials.set(id, next);
  return next;
}

export async function deleteCredentialRec(id: string): Promise<boolean> {
  if (db) {
    await ensureCredentialTables();
    const rows = await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id });
    return rows.length > 0;
  }
  return memCredentials.delete(id);
}

export function __clearCredentials(): void {
  memCredentials.clear();
  memHumanTasks.clear();
  memSecrets.clear();
  memSecretVersions.clear();
  memRunners.clear();
  memRunnerInstances.clear();
  memInferenceJobs.clear();
}

export function __clearMem(): void {
  memWorkflows.clear();
  memExecutions.clear();
  memExecOrder.length = 0;
  memCredentials.clear();
  memHumanTasks.clear();
  memSecrets.clear();
  memSecretVersions.clear();
  memRunners.clear();
  memRunnerInstances.clear();
  memInferenceJobs.clear();
}


// ---------- durable human tasks (#44) ----------

export type HumanTaskStatus = 'pending' | 'claimed' | 'completed' | 'rejected' | 'expired' | 'cancelled';

export interface StoredHumanTask {
  id: string;
  execution_id: string | null;
  workflow_id: string | null;
  node_name: string;
  title: string;
  description: string;
  status: HumanTaskStatus;
  assignee: string | null;
  candidate_roles: string[];
  decision_schema: Record<string, any>;
  payload: Record<string, any>;
  decision: Record<string, any> | null;
  note: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  deadline: string | null;
  escalated_at: string | null;
  org_id: string | null;
  account_id: string | null;
  created_at: string;
  updated_at: string;
}

const memHumanTasks = new Map<string, StoredHumanTask>();
const HUMAN_TASK_STATUSES: HumanTaskStatus[] = ['pending', 'claimed', 'completed', 'rejected', 'expired', 'cancelled'];

function rowToHumanTask(r: typeof humanTasks.$inferSelect): StoredHumanTask {
  const status = HUMAN_TASK_STATUSES.includes(r.status as HumanTaskStatus) ? r.status as HumanTaskStatus : 'pending';
  return {
    id: String(r.id),
    execution_id: r.executionId != null ? String(r.executionId) : null,
    workflow_id: r.workflowId != null ? String(r.workflowId) : null,
    node_name: String(r.nodeName || ''),
    title: String(r.title || ''),
    description: String(r.description || ''),
    status,
    assignee: r.assignee != null ? String(r.assignee) : null,
    candidate_roles: Array.isArray(r.candidateRoles) ? r.candidateRoles.map(String) : [],
    decision_schema: r.decisionSchema && typeof r.decisionSchema === 'object' ? r.decisionSchema : {},
    payload: r.payload && typeof r.payload === 'object' ? r.payload : {},
    decision: r.decision && typeof r.decision === 'object' ? r.decision : null,
    note: r.note != null ? String(r.note) : null,
    claimed_by: r.claimedBy != null ? String(r.claimedBy) : null,
    claimed_at: r.claimedAt ? iso(r.claimedAt) : null,
    completed_by: r.completedBy != null ? String(r.completedBy) : null,
    completed_at: r.completedAt ? iso(r.completedAt) : null,
    deadline: r.deadline ? iso(r.deadline) : null,
    escalated_at: r.escalatedAt ? iso(r.escalatedAt) : null,
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

export function toPublicHumanTask(t: StoredHumanTask): any {
  return {
    id: t.id, executionId: t.execution_id, workflowId: t.workflow_id, node: t.node_name,
    title: t.title, description: t.description, status: t.status, assignee: t.assignee,
    candidateRoles: t.candidate_roles, decisionSchema: t.decision_schema, payload: t.payload,
    decision: t.decision, note: t.note, claimedBy: t.claimed_by, claimedAt: t.claimed_at,
    completedBy: t.completed_by, completedAt: t.completed_at, deadline: t.deadline,
    escalatedAt: t.escalated_at, orgId: t.org_id, accountId: t.account_id,
    createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

export async function createHumanTaskRec(data: {
  execution_id?: string | null;
  workflow_id?: string | null;
  node_name?: string;
  title: string;
  description?: string;
  assignee?: string | null;
  candidate_roles?: string[];
  decision_schema?: Record<string, any>;
  payload?: Record<string, any>;
  deadline?: string | null;
  org_id?: string | null;
  account_id?: string | null;
  id?: string;
}): Promise<StoredHumanTask> {
  const rec: StoredHumanTask = {
    id: data.id || randomUUID(),
    execution_id: data.execution_id ?? null,
    workflow_id: data.workflow_id ?? null,
    node_name: data.node_name || '',
    title: data.title,
    description: data.description || '',
    status: 'pending',
    assignee: data.assignee ?? null,
    candidate_roles: Array.isArray(data.candidate_roles) ? data.candidate_roles.map(String).slice(0, 20) : [],
    decision_schema: data.decision_schema || {},
    payload: data.payload || {},
    decision: null,
    note: null,
    claimed_by: null,
    claimed_at: null,
    completed_by: null,
    completed_at: null,
    deadline: data.deadline ?? null,
    escalated_at: null,
    org_id: data.org_id ?? null,
    account_id: data.account_id ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(humanTasks).values({
      id: rec.id,
      executionId: rec.execution_id,
      workflowId: rec.workflow_id,
      nodeName: rec.node_name,
      title: rec.title,
      description: rec.description,
      status: rec.status,
      assignee: rec.assignee,
      candidateRoles: rec.candidate_roles,
      decisionSchema: rec.decision_schema,
      payload: rec.payload,
      deadline: rec.deadline ? new Date(rec.deadline) : null,
      orgId: rec.org_id,
      accountId: rec.account_id,
    }).returning();
    return rowToHumanTask(rows[0]);
  }
  memHumanTasks.set(rec.id, rec);
  return rec;
}

export async function getHumanTaskRec(id: string): Promise<StoredHumanTask | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(humanTasks).where(eq(humanTasks.id, id)).limit(1);
    return rows[0] ? rowToHumanTask(rows[0]) : null;
  }
  return memHumanTasks.get(id) || null;
}

export async function listHumanTaskRecs(opts: {
  status?: string;
  executionId?: string;
  workflowId?: string;
  assignee?: string;
  orgId?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<StoredHumanTask[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (db) {
    await ensureTables();
    const conds = [];
    if (opts.status) conds.push(eq(humanTasks.status, opts.status));
    if (opts.executionId) conds.push(eq(humanTasks.executionId, opts.executionId));
    if (opts.workflowId) conds.push(eq(humanTasks.workflowId, opts.workflowId));
    if (opts.assignee) conds.push(eq(humanTasks.assignee, opts.assignee));
    if (opts.orgId) conds.push(eq(humanTasks.orgId, opts.orgId));
    if (opts.accountId) conds.push(eq(humanTasks.accountId, opts.accountId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(humanTasks).where(where).orderBy(desc(humanTasks.createdAt)).limit(limit).offset(offset);
    return rows.map(rowToHumanTask);
  }
  let arr = [...memHumanTasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (opts.status) arr = arr.filter((t) => t.status === opts.status);
  if (opts.executionId) arr = arr.filter((t) => t.execution_id === opts.executionId);
  if (opts.workflowId) arr = arr.filter((t) => t.workflow_id === opts.workflowId);
  if (opts.assignee) arr = arr.filter((t) => t.assignee === opts.assignee);
  if (opts.orgId) arr = arr.filter((t) => t.org_id === opts.orgId);
  if (opts.accountId) arr = arr.filter((t) => t.account_id === opts.accountId);
  return arr.slice(offset, offset + limit);
}

/** Conditional transition: only the expected current status may move. This is
 *  the concurrency guard for claim/complete/resume (never double-resume). */
export async function transitionHumanTaskRec(
  id: string,
  expected: HumanTaskStatus[],
  patch: Partial<Pick<StoredHumanTask,
    'status' | 'claimed_by' | 'claimed_at' | 'completed_by' | 'completed_at' | 'decision' | 'note' | 'escalated_at' | 'execution_id'>>,
): Promise<StoredHumanTask | null> {
  const updated_at = nowIso();
  if (db) {
    await ensureTables();
    const rows = await db.update(humanTasks).set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.claimed_by !== undefined ? { claimedBy: patch.claimed_by } : {}),
      ...(patch.claimed_at !== undefined ? { claimedAt: patch.claimed_at ? new Date(patch.claimed_at) : null } : {}),
      ...(patch.completed_by !== undefined ? { completedBy: patch.completed_by } : {}),
      ...(patch.completed_at !== undefined ? { completedAt: patch.completed_at ? new Date(patch.completed_at) : null } : {}),
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.escalated_at !== undefined ? { escalatedAt: patch.escalated_at ? new Date(patch.escalated_at) : null } : {}),
      ...(patch.execution_id !== undefined ? { executionId: patch.execution_id } : {}),
      updatedAt: new Date(updated_at),
    }).where(and(eq(humanTasks.id, id), inArray(humanTasks.status, expected))).returning();
    return rows[0] ? rowToHumanTask(rows[0]) : null;
  }
  const cur = memHumanTasks.get(id);
  if (!cur || !expected.includes(cur.status)) return null;
  const next: StoredHumanTask = {
    ...cur,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.claimed_by !== undefined ? { claimed_by: patch.claimed_by } : {}),
    ...(patch.claimed_at !== undefined ? { claimed_at: patch.claimed_at } : {}),
    ...(patch.completed_by !== undefined ? { completed_by: patch.completed_by } : {}),
    ...(patch.completed_at !== undefined ? { completed_at: patch.completed_at } : {}),
    ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.escalated_at !== undefined ? { escalated_at: patch.escalated_at } : {}),
    ...(patch.execution_id !== undefined ? { execution_id: patch.execution_id } : {}),
    updated_at,
  };
  memHumanTasks.set(id, next);
  return next;
}

/** Mark a paused execution as resumed exactly once. */
export async function claimExecutionResume(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(executions)
      .set({ status: 'running' })
      .where(and(eq(executions.id, id), eq(executions.status, 'paused')))
      .returning({ id: executions.id });
    return rows.length > 0;
  }
  const cur = memExecutions.get(id);
  if (!cur || cur.status !== 'paused') return false;
  memExecutions.set(id, { ...cur, status: 'running' });
  return true;
}

export async function finishExecutionRec(id: string, patch: {
  status: 'success' | 'error';
  output: any;
  node_runs: StoredExecution['node_runs'];
  error?: string | null;
  finishedAt: string;
  workerId?: string | null;
  allowedStatuses?: StoredExecution['status'][];
}): Promise<StoredExecution | null> {
  const allowed = patch.allowedStatuses && patch.allowedStatuses.length
    ? patch.allowedStatuses
    : ['running', 'paused'] as StoredExecution['status'][];
  if (db) {
    await ensureTables();
    const conds: any[] = [eq(executions.id, id), inArray(executions.status, allowed)];
    if (patch.workerId) conds.push(eq(executions.workerId, patch.workerId));
    const rows = await db.update(executions).set({
      status: patch.status,
      output: patch.output,
      nodeRuns: patch.node_runs,
      error: patch.error ?? null,
      leaseExpiresAt: null,
      finishedAt: new Date(patch.finishedAt),
    }).where(and(...conds)).returning();
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  const cur = memExecutions.get(id);
  if (!cur || !allowed.includes(cur.status)) return null;
  if (patch.workerId && cur.worker_id && cur.worker_id !== patch.workerId) return null;
  const next: StoredExecution = {
    ...cur, status: patch.status, output: patch.output, node_runs: patch.node_runs,
    error: patch.error ?? null, lease_expires_at: null, finishedAt: patch.finishedAt,
  };
  memExecutions.set(id, next);
  return next;
}

/** Put a paused execution back on its queue with a human-decision resume
 *  checkpoint. The next worker claim picks up `resume_node`/`resume_output`. */
export async function queueExecutionResume(id: string, patch: {
  node: string;
  output: any;
}): Promise<StoredExecution | null> {
  if (db) {
    await ensureTables();
    const rows = await db.update(executions).set({
      status: 'queued',
      resumeNode: patch.node,
      resumeOutput: patch.output,
      workerId: null,
      leaseExpiresAt: null,
      error: null,
    }).where(and(eq(executions.id, id), eq(executions.status, 'paused'))).returning();
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  const cur = memExecutions.get(id);
  if (!cur || cur.status !== 'paused') return null;
  const next: StoredExecution = {
    ...cur,
    status: 'queued',
    resume_node: patch.node,
    resume_output: patch.output,
    worker_id: null,
    lease_expires_at: null,
    error: null,
  };
  memExecutions.set(id, next);
  return next;
}

export function __clearHumanTasks(): void {
  memHumanTasks.clear();
  memSecrets.clear();
  memSecretVersions.clear();
}


// ---------- tenant secret vault (#47) ----------

export interface StoredSecret {
  id: string;
  org_id: string;
  account_id: string;
  name: string;
  description: string;
  scope: string;
  current_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StoredSecretVersion {
  id: string;
  secret_id: string;
  version: number;
  value_enc: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const memSecrets = new Map<string, StoredSecret>();
const memSecretVersions = new Map<string, StoredSecretVersion[]>();

function rowToSecret(r: typeof secrets.$inferSelect): StoredSecret {
  return {
    id: String(r.id), org_id: String(r.orgId || ''), account_id: String(r.accountId || ''),
    name: String(r.name || ''), description: String(r.description || ''), scope: String(r.scope || 'tenant'),
    current_version: Number(r.currentVersion) || 1, created_by: r.createdBy != null ? String(r.createdBy) : null,
    created_at: iso(r.createdAt), updated_at: iso(r.updatedAt), deleted_at: r.deletedAt ? iso(r.deletedAt) : null,
  };
}

function rowToSecretVersion(r: typeof secretVersions.$inferSelect): StoredSecretVersion {
  return {
    id: String(r.id), secret_id: String(r.secretId || ''), version: Number(r.version) || 1,
    value_enc: String(r.valueEnc || ''), created_by: r.createdBy != null ? String(r.createdBy) : null,
    created_at: iso(r.createdAt), expires_at: r.expiresAt ? iso(r.expiresAt) : null,
    revoked_at: r.revokedAt ? iso(r.revokedAt) : null,
  };
}

export function toPublicSecret(s: StoredSecret): any {
  return {
    id: s.id, orgId: s.org_id, accountId: s.account_id || null, name: s.name,
    description: s.description, scope: s.scope, currentVersion: s.current_version,
    createdBy: s.created_by, createdAt: s.created_at, updatedAt: s.updated_at,
  };
}

function toPublicSecretVersion(v: StoredSecretVersion): any {
  return {
    version: v.version, createdBy: v.created_by, createdAt: v.created_at,
    expiresAt: v.expires_at, revokedAt: v.revoked_at,
    status: v.revoked_at ? 'revoked' : v.expires_at && new Date(v.expires_at).getTime() < Date.now() ? 'expired' : 'active',
  };
}

export async function createSecretRec(data: {
  org_id: string; account_id?: string | null; name: string; description?: string;
  scope?: string; value: string; created_by?: string | null;
}): Promise<StoredSecret> {
  const rec: StoredSecret = {
    id: randomUUID(), org_id: data.org_id, account_id: data.account_id || '', name: data.name,
    description: data.description || '', scope: data.scope || 'tenant', current_version: 1,
    created_by: data.created_by ?? null, created_at: nowIso(), updated_at: nowIso(), deleted_at: null,
  };
  const version: StoredSecretVersion = {
    id: randomUUID(), secret_id: rec.id, version: 1, value_enc: encryptSecret(data.value),
    created_by: rec.created_by, created_at: rec.created_at, expires_at: null, revoked_at: null,
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(secrets).values({
      id: rec.id, orgId: rec.org_id, accountId: rec.account_id || null, name: rec.name,
      description: rec.description, scope: rec.scope, currentVersion: 1, createdBy: rec.created_by,
    }).returning();
    await db.insert(secretVersions).values({
      id: version.id, secretId: version.secret_id, version: 1, valueEnc: version.value_enc, createdBy: version.created_by,
    });
    return rowToSecret(rows[0]);
  }
  for (const existing of memSecrets.values()) {
    if (existing.org_id === rec.org_id && existing.account_id === rec.account_id && existing.name === rec.name && !existing.deleted_at) {
      throw Object.assign(new Error(`secret '${rec.name}' already exists`), { code: 'conflict' });
    }
  }
  memSecrets.set(rec.id, rec);
  memSecretVersions.set(rec.id, [version]);
  return rec;
}

export async function listSecretRecs(orgId: string, accountId?: string | null): Promise<StoredSecret[]> {
  if (db) {
    await ensureTables();
    const conds = [eq(secrets.orgId, orgId), isNull(secrets.deletedAt)];
    if (accountId) conds.push(eq(secrets.accountId, accountId));
    const rows = await db.select().from(secrets).where(and(...conds)).orderBy(asc(secrets.name));
    return rows.map(rowToSecret);
  }
  return [...memSecrets.values()]
    .filter((s) => s.org_id === orgId && !s.deleted_at && (!accountId || s.account_id === accountId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function findSecretRec(orgId: string, name: string, accountId?: string | null): Promise<StoredSecret | null> {
  if (db) {
    await ensureTables();
    const conds = [eq(secrets.orgId, orgId), eq(secrets.name, name), isNull(secrets.deletedAt)];
    if (accountId) conds.push(eq(secrets.accountId, accountId));
    const rows = await db.select().from(secrets).where(and(...conds)).limit(1);
    return rows[0] ? rowToSecret(rows[0]) : null;
  }
  return [...memSecrets.values()].find((s) =>
    s.org_id === orgId && s.name === name && !s.deleted_at && (!accountId || s.account_id === accountId),
  ) || null;
}

/** Read a secret value. Cross-tenant access is a 404 at the route; this
 *  function is only called with an already-scoped secret. */
export async function readSecretValue(secret: StoredSecret, version?: number): Promise<{ value: string; version: number } | { error: 'not_found' | 'expired' | 'revoked' }> {
  const want = version || secret.current_version;
  let row: StoredSecretVersion | null = null;
  if (db) {
    await ensureTables();
    const rows = await db.select().from(secretVersions)
      .where(and(eq(secretVersions.secretId, secret.id), eq(secretVersions.version, want))).limit(1);
    row = rows[0] ? rowToSecretVersion(rows[0]) : null;
  } else {
    row = (memSecretVersions.get(secret.id) || []).find((v) => v.version === want) || null;
  }
  if (!row) return { error: 'not_found' };
  if (row.revoked_at) return { error: 'revoked' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { error: 'expired' };
  try {
    return { value: decryptSecret(row.value_enc), version: row.version };
  } catch {
    return { error: 'not_found' };
  }
}

export async function rotateSecretRec(secret: StoredSecret, value: string, graceSeconds: number, actor?: string | null): Promise<StoredSecret> {
  const nextVersion = secret.current_version + 1;
  const now = nowIso();
  const expiresAt = graceSeconds > 0 ? new Date(Date.now() + graceSeconds * 1000).toISOString() : now;
  const version: StoredSecretVersion = {
    id: randomUUID(), secret_id: secret.id, version: nextVersion, value_enc: encryptSecret(value),
    created_by: actor ?? null, created_at: now, expires_at: null, revoked_at: null,
  };
  if (db) {
    await ensureTables();
    await db.update(secretVersions)
      .set({ expiresAt: new Date(expiresAt) })
      .where(and(eq(secretVersions.secretId, secret.id), eq(secretVersions.version, secret.current_version)));
    await db.insert(secretVersions).values({
      id: version.id, secretId: version.secret_id, version: version.version,
      valueEnc: version.value_enc, createdBy: version.created_by,
    });
    const rows = await db.update(secrets).set({ currentVersion: nextVersion, updatedAt: new Date(now) })
      .where(eq(secrets.id, secret.id)).returning();
    return rowToSecret(rows[0]);
  }
  const versions = memSecretVersions.get(secret.id) || [];
  for (const v of versions) {
    if (v.version === secret.current_version) v.expires_at = expiresAt;
  }
  versions.push(version);
  memSecretVersions.set(secret.id, versions);
  const next: StoredSecret = { ...secret, current_version: nextVersion, updated_at: now };
  memSecrets.set(secret.id, next);
  return next;
}

export async function listSecretVersionRecs(secret: StoredSecret): Promise<StoredSecretVersion[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(secretVersions)
      .where(eq(secretVersions.secretId, secret.id)).orderBy(desc(secretVersions.version));
    return rows.map(rowToSecretVersion);
  }
  return [...(memSecretVersions.get(secret.id) || [])].sort((a, b) => b.version - a.version);
}

export { toPublicSecretVersion };

export async function revokeSecretRec(secret: StoredSecret, version?: number): Promise<number> {
  const now = new Date();
  if (db) {
    await ensureTables();
    const conds = [eq(secretVersions.secretId, secret.id)];
    if (version) conds.push(eq(secretVersions.version, version));
    const rows = await db.update(secretVersions).set({ revokedAt: now })
      .where(and(...conds)).returning({ id: secretVersions.id });
    return rows.length;
  }
  let count = 0;
  for (const v of memSecretVersions.get(secret.id) || []) {
    if ((!version || v.version === version) && !v.revoked_at) { v.revoked_at = now.toISOString(); count++; }
  }
  return count;
}

export async function deleteSecretRec(secret: StoredSecret): Promise<boolean> {
  const now = new Date();
  if (db) {
    await ensureTables();
    await db.update(secretVersions).set({ revokedAt: now }).where(eq(secretVersions.secretId, secret.id));
    const rows = await db.update(secrets).set({ deletedAt: now, updatedAt: now })
      .where(eq(secrets.id, secret.id)).returning({ id: secrets.id });
    return rows.length > 0;
  }
  const cur = memSecrets.get(secret.id);
  if (!cur) return false;
  cur.deleted_at = now.toISOString();
  cur.updated_at = now.toISOString();
  for (const v of memSecretVersions.get(secret.id) || []) v.revoked_at = now.toISOString();
  return true;
}

export function __clearSecrets(): void {
  memSecrets.clear();
  memSecretVersions.clear();
}

// ---------- self-hosted workflow runners ----------

function rowToRunnerInstance(r: typeof workflowRunnerInstances.$inferSelect): StoredRunnerInstance {
  return {
    id: String(r.id),
    runner_id: String(r.runnerId),
    hostname: String(r.hostname || ''),
    version: r.version != null ? String(r.version) : null,
    queue: String(r.queue || ''),
    concurrency: Number.isFinite(Number(r.concurrency)) ? Number(r.concurrency) : 1,
    status: r.status === 'offline' ? 'offline' : 'connected',
    last_seen_at: iso(r.lastSeenAt),
    started_at: r.startedAt ? iso(r.startedAt) : null,
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

/** Create or refresh one connector instance for a runner registration. */
export async function upsertRunnerInstance(data: {
  id: string;
  runner_id: string;
  hostname?: string;
  version?: string | null;
  queue?: string;
  concurrency?: number;
  status?: 'connected' | 'offline';
  started_at?: string | null;
  metadata?: Record<string, any>;
}): Promise<StoredRunnerInstance> {
  const now = nowIso();
  const next: StoredRunnerInstance = {
    id: data.id,
    runner_id: data.runner_id,
    hostname: String(data.hostname || '').slice(0, 255),
    version: data.version ? String(data.version).slice(0, 64) : null,
    queue: String(data.queue || '').slice(0, 64),
    concurrency: Math.min(Math.max(Number(data.concurrency) || 1, 1), 64),
    status: data.status === 'offline' ? 'offline' : 'connected',
    last_seen_at: now,
    started_at: data.started_at || null,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    created_at: now,
    updated_at: now,
  };
  if (db) {
    await ensureTables();
    const existing = await db.select().from(workflowRunnerInstances).where(eq(workflowRunnerInstances.id, data.id)).limit(1);
    if (existing[0]) {
      const rows = await db.update(workflowRunnerInstances).set({
        hostname: next.hostname,
        version: next.version,
        queue: next.queue,
        concurrency: next.concurrency,
        status: next.status,
        lastSeenAt: new Date(now),
        startedAt: next.started_at ? new Date(next.started_at) : existing[0].startedAt,
        metadata: next.metadata,
        updatedAt: new Date(now),
      }).where(eq(workflowRunnerInstances.id, data.id)).returning();
      return rowToRunnerInstance(rows[0]);
    }
    const rows = await db.insert(workflowRunnerInstances).values({
      id: next.id,
      runnerId: next.runner_id,
      hostname: next.hostname,
      version: next.version,
      queue: next.queue,
      concurrency: next.concurrency,
      status: next.status,
      lastSeenAt: new Date(now),
      startedAt: next.started_at ? new Date(next.started_at) : null,
      metadata: next.metadata,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }).returning();
    return rowToRunnerInstance(rows[0]);
  }
  const cur = memRunnerInstances.get(next.id);
  const merged: StoredRunnerInstance = cur
    ? { ...cur, ...next, started_at: next.started_at || cur.started_at, created_at: cur.created_at }
    : next;
  memRunnerInstances.set(next.id, merged);
  return merged;
}

export async function listRunnerInstances(runnerId: string): Promise<StoredRunnerInstance[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(workflowRunnerInstances)
      .where(eq(workflowRunnerInstances.runnerId, runnerId))
      .orderBy(desc(workflowRunnerInstances.lastSeenAt));
    return rows.map(rowToRunnerInstance);
  }
  return [...memRunnerInstances.values()]
    .filter((i) => i.runner_id === runnerId)
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
}

export async function listRunnerInstancesForRunners(runnerIds: string[]): Promise<StoredRunnerInstance[]> {
  const ids = [...new Set(runnerIds.filter(Boolean))];
  if (!ids.length) return [];
  if (db) {
    await ensureTables();
    const rows = await db.select().from(workflowRunnerInstances)
      .where(inArray(workflowRunnerInstances.runnerId, ids))
      .orderBy(desc(workflowRunnerInstances.lastSeenAt));
    return rows.map(rowToRunnerInstance);
  }
  return [...memRunnerInstances.values()]
    .filter((i) => ids.includes(i.runner_id))
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
}

export async function deleteRunnerInstance(runnerId: string, instanceId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(workflowRunnerInstances)
      .where(and(eq(workflowRunnerInstances.id, instanceId), eq(workflowRunnerInstances.runnerId, runnerId)))
      .returning({ id: workflowRunnerInstances.id });
    return rows.length > 0;
  }
  const cur = memRunnerInstances.get(instanceId);
  if (!cur || cur.runner_id !== runnerId) return false;
  return memRunnerInstances.delete(instanceId);
}

export async function deleteRunnerInstancesForRunner(runnerId: string): Promise<void> {
  if (db) {
    await ensureTables();
    await db.delete(workflowRunnerInstances).where(eq(workflowRunnerInstances.runnerId, runnerId));
    return;
  }
  for (const [id, inst] of memRunnerInstances) {
    if (inst.runner_id === runnerId) memRunnerInstances.delete(id);
  }
}

export async function updateRunnerRec(id: string, patch: {
  name?: string;
  kind?: RunnerKind;
  mode?: RunnerMode;
  queue?: string;
  inference_queue?: string | null;
  metadata?: Record<string, any>;
}): Promise<StoredWorkflowRunner | null> {
  const now = new Date();
  if (db) {
    await ensureTables();
    const rows = await db.update(workflowRunners).set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.queue !== undefined ? { queue: patch.queue } : {}),
      ...(patch.inference_queue !== undefined ? { inferenceQueue: patch.inference_queue } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: now,
    }).where(eq(workflowRunners.id, id)).returning();
    return rows[0] ? rowToRunner(rows[0]) : null;
  }
  const cur = memRunners.get(id);
  if (!cur) return null;
  const next: StoredWorkflowRunner = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.queue !== undefined ? { queue: patch.queue } : {}),
    ...(patch.inference_queue !== undefined ? { inference_queue: patch.inference_queue } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    updated_at: now.toISOString(),
  };
  memRunners.set(id, next);
  return next;
}

function rowToRunner(r: typeof workflowRunners.$inferSelect): StoredWorkflowRunner {
  const mode: RunnerMode = r.mode === 'hybrid' ? 'hybrid' : 'custom';
  const status = r.status === 'connected' || r.status === 'stale' || r.status === 'disabled' ? r.status : 'waiting';
  return {
    id: String(r.id),
    name: String(r.name || ''),
    kind: r.kind === 'inference' || r.kind === 'hybrid' ? r.kind : 'workflow',
    mode,
    queue: String(r.queue || ''),
    inference_queue: r.inferenceQueue != null ? String(r.inferenceQueue) : null,
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    api_key_id: r.apiKeyId != null ? String(r.apiKeyId) : null,
    key_prefix: r.keyPrefix != null ? String(r.keyPrefix) : null,
    status,
    version: r.version != null ? String(r.version) : null,
    last_seen_at: r.lastSeenAt ? iso(r.lastSeenAt) : null,
    last_error: r.lastError != null ? String(r.lastError) : null,
    created_by: r.createdBy != null ? String(r.createdBy) : null,
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

export async function createRunnerRec(data: {
  id?: string;
  name: string;
  kind?: RunnerKind;
  mode: RunnerMode;
  queue: string;
  inference_queue?: string | null;
  org_id?: string | null;
  account_id?: string | null;
  api_key_id?: string | null;
  key_prefix?: string | null;
  created_by?: string | null;
  metadata?: Record<string, any>;
}): Promise<StoredWorkflowRunner> {
  const rec: StoredWorkflowRunner = {
    id: data.id || randomUUID(),
    name: data.name,
    kind: data.kind === 'inference' || data.kind === 'hybrid' ? data.kind : 'workflow',
    mode: data.mode === 'hybrid' ? 'hybrid' : 'custom',
    queue: data.queue,
    inference_queue: cleanTenant(data.inference_queue),
    org_id: cleanTenant(data.org_id),
    account_id: cleanTenant(data.account_id),
    api_key_id: cleanTenant(data.api_key_id),
    key_prefix: cleanTenant(data.key_prefix),
    status: 'waiting',
    version: null,
    last_seen_at: null,
    last_error: null,
    created_by: cleanTenant(data.created_by),
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(workflowRunners).values({
      id: rec.id,
      name: rec.name,
      kind: rec.kind,
      mode: rec.mode,
      queue: rec.queue,
      inferenceQueue: rec.inference_queue,
      orgId: rec.org_id,
      accountId: rec.account_id,
      apiKeyId: rec.api_key_id,
      keyPrefix: rec.key_prefix,
      status: rec.status,
      createdBy: rec.created_by,
      metadata: rec.metadata,
    }).returning();
    return rowToRunner(rows[0]);
  }
  memRunners.set(rec.id, rec);
  return rec;
}

export async function getRunnerRec(id: string): Promise<StoredWorkflowRunner | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(workflowRunners).where(eq(workflowRunners.id, id)).limit(1);
    return rows[0] ? rowToRunner(rows[0]) : null;
  }
  return memRunners.get(id) || null;
}

export async function listRunnerRecs(opts: { orgId?: string; accountId?: string; limit?: number } = {}): Promise<StoredWorkflowRunner[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  if (db) {
    await ensureTables();
    const conds: any[] = [];
    if (opts.orgId) conds.push(eq(workflowRunners.orgId, opts.orgId));
    if (opts.accountId) conds.push(eq(workflowRunners.accountId, opts.accountId));
    const rows = await db.select().from(workflowRunners)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(workflowRunners.createdAt))
      .limit(limit);
    return rows.map(rowToRunner);
  }
  let arr = [...memRunners.values()];
  if (opts.orgId) arr = arr.filter((r) => r.org_id === opts.orgId);
  if (opts.accountId) arr = arr.filter((r) => r.account_id === opts.accountId);
  return arr.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export async function heartbeatRunnerRec(id: string, patch: {
  version?: string | null;
  status?: 'waiting' | 'connected' | 'stale' | 'disabled';
  lastError?: string | null;
  metadata?: Record<string, any>;
}): Promise<StoredWorkflowRunner | null> {
  const now = new Date();
  if (db) {
    await ensureTables();
    const rows = await db.update(workflowRunners).set({
      status: patch.status || 'connected',
      version: patch.version !== undefined ? (patch.version ? String(patch.version).slice(0, 64) : null) : undefined,
      lastSeenAt: now,
      lastError: patch.lastError !== undefined ? (patch.lastError ? String(patch.lastError).slice(0, 1000) : null) : undefined,
      metadata: patch.metadata ?? undefined,
      updatedAt: now,
    }).where(eq(workflowRunners.id, id)).returning();
    return rows[0] ? rowToRunner(rows[0]) : null;
  }
  const cur = memRunners.get(id);
  if (!cur) return null;
  const next: StoredWorkflowRunner = {
    ...cur,
    status: patch.status || 'connected',
    version: patch.version !== undefined ? (patch.version ? String(patch.version).slice(0, 64) : null) : cur.version,
    last_seen_at: now.toISOString(),
    last_error: patch.lastError !== undefined ? (patch.lastError ? String(patch.lastError).slice(0, 1000) : null) : cur.last_error,
    metadata: patch.metadata ?? cur.metadata,
    updated_at: now.toISOString(),
  };
  memRunners.set(id, next);
  return next;
}

export async function deleteRunnerRec(id: string): Promise<boolean> {
  await deleteRunnerInstancesForRunner(id);
  if (db) {
    await ensureTables();
    const rows = await db.delete(workflowRunners).where(eq(workflowRunners.id, id)).returning({ id: workflowRunners.id });
    return rows.length > 0;
  }
  return memRunners.delete(id);
}

// ---------- inference jobs (inference/hybrid runners) ----------

function rowToInferenceJob(r: typeof inferenceJobs.$inferSelect): StoredInferenceJob {
  return {
    id: String(r.id),
    type: String(r.type || 'chat'),
    status: r.status === 'running' ? 'running'
      : r.status === 'success' ? 'success'
        : r.status === 'error' ? 'error'
          : r.status === 'cancelled' ? 'cancelled' : 'queued',
    request: r.request ?? {},
    result: r.result ?? null,
    error: r.error ?? null,
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    runner_id: r.runnerId != null ? String(r.runnerId) : null,
    instance_id: r.instanceId != null ? String(r.instanceId) : null,
    queue_name: r.queueName != null ? String(r.queueName) : null,
    attempt: Number.isFinite(Number(r.attempt)) ? Number(r.attempt) : 0,
    lease_expires_at: r.leaseExpiresAt ? iso(r.leaseExpiresAt) : null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
    finished_at: r.finishedAt ? iso(r.finishedAt) : null,
  };
}

export async function createInferenceJobRec(data: {
  id?: string;
  type: string;
  request: any;
  org_id?: string | null;
  account_id?: string | null;
  queue_name: string;
}): Promise<StoredInferenceJob> {
  const now = nowIso();
  const rec: StoredInferenceJob = {
    id: data.id || randomUUID(),
    type: String(data.type || 'chat').slice(0, 32),
    status: 'queued',
    request: data.request ?? {},
    result: null,
    error: null,
    org_id: cleanTenant(data.org_id),
    account_id: cleanTenant(data.account_id),
    runner_id: null,
    instance_id: null,
    queue_name: data.queue_name,
    attempt: 0,
    lease_expires_at: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(inferenceJobs).values({
      id: rec.id,
      type: rec.type,
      status: rec.status,
      request: rec.request,
      orgId: rec.org_id,
      accountId: rec.account_id,
      queueName: rec.queue_name,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }).returning();
    return rowToInferenceJob(rows[0]);
  }
  memInferenceJobs.set(rec.id, rec);
  return rec;
}

export async function getInferenceJobRec(id: string): Promise<StoredInferenceJob | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(inferenceJobs).where(eq(inferenceJobs.id, id)).limit(1);
    return rows[0] ? rowToInferenceJob(rows[0]) : null;
  }
  return memInferenceJobs.get(id) || null;
}

export async function listInferenceJobRecs(opts: { orgId?: string; accountId?: string; status?: string; limit?: number } = {}): Promise<StoredInferenceJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  if (db) {
    await ensureTables();
    const conds: any[] = [];
    if (opts.orgId) conds.push(eq(inferenceJobs.orgId, opts.orgId));
    if (opts.accountId) conds.push(eq(inferenceJobs.accountId, opts.accountId));
    if (opts.status) conds.push(eq(inferenceJobs.status, opts.status));
    const rows = await db.select().from(inferenceJobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(inferenceJobs.createdAt))
      .limit(limit);
    return rows.map(rowToInferenceJob);
  }
  return [...memInferenceJobs.values()]
    .filter((j) => (!opts.orgId || j.org_id === opts.orgId)
      && (!opts.accountId || j.account_id === opts.accountId)
      && (!opts.status || j.status === opts.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export async function claimInferenceJobRec(id: string, opts: { runnerId: string; instanceId?: string | null; leaseSeconds: number }): Promise<StoredInferenceJob | null> {
  const leaseSeconds = Math.min(Math.max(Number(opts.leaseSeconds) || 120, 15), 3600);
  const now = new Date();
  const lease = new Date(now.getTime() + leaseSeconds * 1000);
  if (db) {
    await ensureTables();
    const rows = await db.update(inferenceJobs).set({
      status: 'running',
      runnerId: opts.runnerId,
      instanceId: opts.instanceId || null,
      leaseExpiresAt: lease,
      attempt: sql`${inferenceJobs.attempt} + 1`,
      error: null,
      updatedAt: now,
    }).where(and(
      eq(inferenceJobs.id, id),
      or(
        eq(inferenceJobs.status, 'queued'),
        and(eq(inferenceJobs.status, 'running'), or(isNull(inferenceJobs.leaseExpiresAt), lt(inferenceJobs.leaseExpiresAt, now))),
      ),
    )).returning();
    return rows[0] ? rowToInferenceJob(rows[0]) : null;
  }
  const cur = memInferenceJobs.get(id);
  if (!cur) return null;
  const expired = cur.status === 'running'
    && (!cur.lease_expires_at || new Date(cur.lease_expires_at).getTime() < now.getTime());
  if (cur.status !== 'queued' && !expired) return null;
  const next: StoredInferenceJob = {
    ...cur,
    status: 'running',
    runner_id: opts.runnerId,
    instance_id: opts.instanceId || null,
    lease_expires_at: lease.toISOString(),
    attempt: (cur.attempt || 0) + 1,
    error: null,
    updated_at: now.toISOString(),
  };
  memInferenceJobs.set(id, next);
  return next;
}

export async function heartbeatInferenceJobRec(id: string, opts: { runnerId: string; leaseSeconds: number }): Promise<StoredInferenceJob | null> {
  const leaseSeconds = Math.min(Math.max(Number(opts.leaseSeconds) || 120, 15), 3600);
  const lease = new Date(Date.now() + leaseSeconds * 1000);
  if (db) {
    await ensureTables();
    const rows = await db.update(inferenceJobs).set({
      leaseExpiresAt: lease,
      updatedAt: new Date(),
    }).where(and(eq(inferenceJobs.id, id), eq(inferenceJobs.status, 'running'), eq(inferenceJobs.runnerId, opts.runnerId))).returning();
    return rows[0] ? rowToInferenceJob(rows[0]) : null;
  }
  const cur = memInferenceJobs.get(id);
  if (!cur || cur.status !== 'running' || cur.runner_id !== opts.runnerId) return null;
  const next: StoredInferenceJob = { ...cur, lease_expires_at: lease.toISOString(), updated_at: new Date().toISOString() };
  memInferenceJobs.set(id, next);
  return next;
}

export async function finishInferenceJobRec(id: string, patch: {
  status: 'success' | 'error';
  result?: any;
  error?: string | null;
  runnerId: string;
}): Promise<StoredInferenceJob | null> {
  const now = new Date();
  if (db) {
    await ensureTables();
    const rows = await db.update(inferenceJobs).set({
      status: patch.status,
      result: patch.result ?? null,
      error: patch.error ?? null,
      leaseExpiresAt: null,
      updatedAt: now,
      finishedAt: now,
    }).where(and(
      eq(inferenceJobs.id, id),
      eq(inferenceJobs.status, 'running'),
      eq(inferenceJobs.runnerId, patch.runnerId),
    )).returning();
    return rows[0] ? rowToInferenceJob(rows[0]) : null;
  }
  const cur = memInferenceJobs.get(id);
  if (!cur || cur.status !== 'running' || cur.runner_id !== patch.runnerId) return null;
  const next: StoredInferenceJob = {
    ...cur,
    status: patch.status,
    result: patch.result ?? null,
    error: patch.error ?? null,
    lease_expires_at: null,
    updated_at: now.toISOString(),
    finished_at: now.toISOString(),
  };
  memInferenceJobs.set(id, next);
  return next;
}

export async function releaseInferenceJobRec(id: string, opts: { runnerId: string; error?: string }): Promise<StoredInferenceJob | null> {
  if (db) {
    await ensureTables();
    const rows = await db.update(inferenceJobs).set({
      status: 'queued',
      runnerId: null,
      instanceId: null,
      leaseExpiresAt: null,
      error: opts.error ? String(opts.error).slice(0, 1000) : null,
      updatedAt: new Date(),
    }).where(and(eq(inferenceJobs.id, id), eq(inferenceJobs.status, 'running'), eq(inferenceJobs.runnerId, opts.runnerId))).returning();
    return rows[0] ? rowToInferenceJob(rows[0]) : null;
  }
  const cur = memInferenceJobs.get(id);
  if (!cur || cur.status !== 'running' || cur.runner_id !== opts.runnerId) return null;
  const next: StoredInferenceJob = {
    ...cur,
    status: 'queued',
    runner_id: null,
    instance_id: null,
    lease_expires_at: null,
    error: opts.error ? String(opts.error).slice(0, 1000) : null,
    updated_at: new Date().toISOString(),
  };
  memInferenceJobs.set(id, next);
  return next;
}

export async function setInferenceJobError(id: string, error: string): Promise<StoredInferenceJob | null> {
  const now = new Date();
  if (db) {
    await ensureTables();
    const rows = await db.update(inferenceJobs).set({
      status: 'error', error: String(error).slice(0, 2000), updatedAt: now, finishedAt: now,
    }).where(and(eq(inferenceJobs.id, id), eq(inferenceJobs.status, 'queued'))).returning();
    return rows[0] ? rowToInferenceJob(rows[0]) : null;
  }
  const cur = memInferenceJobs.get(id);
  if (!cur || cur.status !== 'queued') return null;
  const next: StoredInferenceJob = { ...cur, status: 'error', error: String(error).slice(0, 2000), updated_at: now.toISOString(), finished_at: now.toISOString() };
  memInferenceJobs.set(id, next);
  return next;
}
