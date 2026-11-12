// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * SynapseQueue transport for workflow executions.
 *
 * A trigger no longer runs the DAG inside the HTTP request. It creates a
 * queued execution row and publishes a tiny `{executionId}` message to a
 * tenant-scoped SynapseQueue queue. Workers (the built-in platform worker or
 * user-deployed runners) consume the queue, claim the execution through the
 * workflow API and report the result back. Queue delivery is at-least-once;
 * `claimExecutionRec` is the exactly-one-runner guard.
 */
import './env-compat';
import type { Principal } from './store';

export type WorkflowRunnerMode = 'inline' | 'platform' | 'custom' | 'hybrid';

export interface QueueOptions {
  maxAttempts?: number;
  visibilityTimeoutSeconds?: number;
}

export interface ConsumedMessage {
  id: string;
  receipt: string;
  payload: any;
  attempts?: number;
  leaseExpiresAt?: string;
}

const QUEUE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function queueBase(): string {
  return (process.env.QUEUE_SERVICE_URL || '').replace(/\/$/, '');
}

function internalSecret(): string {
  return process.env.SYNAPSEONE_INTERNAL_SECRET || '';
}

export const DEFAULT_PLATFORM_QUEUE = process.env.WORKFLOW_QUEUE_PLATFORM || 'synapseone-wf-platform';
export const DEFAULT_CUSTOM_QUEUE = process.env.WORKFLOW_QUEUE_CUSTOM || 'synapseone-wf-custom';
export const DEFAULT_SHARED_QUEUE = process.env.WORKFLOW_QUEUE_SHARED || 'synapseone-wf-shared';

/** `queue` when a SynapseQueue URL is configured, `inline` for dev/tests.
 *  WORKFLOW_EXECUTION_MODE=queue|inline forces one or the other. */
export function queueTransportEnabled(): boolean {
  const raw = String(process.env.WORKFLOW_EXECUTION_MODE || 'auto').trim().toLowerCase();
  if (raw === 'inline' || raw === 'local' || raw === 'sync') return false;
  if (raw === 'queue' || raw === 'async') return true;
  return !!queueBase() || process.env.NODE_ENV === 'production';
}

export function queueBackendConfigured(): boolean {
  return !!queueBase();
}

export function queueVisibilitySeconds(): number {
  const n = Number(process.env.WORKFLOW_QUEUE_VISIBILITY_SECONDS || 300);
  return Math.min(Math.max(Number.isFinite(n) ? n : 300, 30), 3600);
}

export function queueMaxAttempts(): number {
  const n = Number(process.env.WORKFLOW_QUEUE_MAX_ATTEMPTS || 5);
  return Math.min(Math.max(Number.isFinite(n) ? n : 5, 1), 100);
}

/** Read the per-workflow runner mode from settings. Accepts both the modern
 *  `settings.execution.mode` object and the short `settings.runner` string so
 *  imported workflows and older console builds keep working. */
export function runnerModeForSettings(settings: Record<string, any> | null | undefined): WorkflowRunnerMode {
  const s = settings && typeof settings === 'object' ? settings : {};
  const execution = s.execution && typeof s.execution === 'object' ? s.execution : {};
  const raw = String(execution.mode ?? execution.runner ?? s.runner ?? '').trim().toLowerCase();
  if (raw === 'inline' || raw === 'local' || raw === 'sync') return 'inline';
  if (raw === 'custom') return 'custom';
  if (raw === 'hybrid') return 'hybrid';
  return 'platform';
}

/** Queue name for a workflow. A per-workflow `settings.execution.queue`
 *  override lets a tenant target a dedicated self-hosted runner queue. */
export function queueNameForSettings(settings: Record<string, any> | null | undefined, mode: WorkflowRunnerMode): string {
  const s = settings && typeof settings === 'object' ? settings : {};
  const execution = s.execution && typeof s.execution === 'object' ? s.execution : {};
  const override = String(execution.queue || '').trim();
  if (override && QUEUE_RE.test(override)) return override;
  if (mode === 'custom') return DEFAULT_CUSTOM_QUEUE;
  if (mode === 'hybrid') return DEFAULT_SHARED_QUEUE;
  return DEFAULT_PLATFORM_QUEUE;
}

export function isQueueName(v: unknown): boolean {
  return QUEUE_RE.test(String(v || ''));
}

/** Tenant identity used by SynapseQueue. The prefix mirrors the queue
 *  service's own `org:` > `account:` > `user:` precedence. */
export function queueTenantKey(p: Principal | null | undefined): string {
  if (!p) return 'platform';
  if (p.org) return `org:${p.org}`;
  if (p.account) return `account:${p.account}`;
  if (p.sub) return `user:${p.sub}`;
  return 'platform';
}

/** Headers that make queue-service derive the same tenant as the workflow
 *  principal. Internal calls carry the service secret; the principal headers
 *  are gateway-style stamps and are never accepted from clients by the queue
 *  service (the gateway strips them on public routes). */
export function queueHeaders(p: Principal | null | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = internalSecret();
  if (secret) h['x-synapseone-internal'] = secret;
  if (!p || (!p.sub && !p.org && !p.account)) {
    h['x-synapseone-tenant'] = 'platform';
    return h;
  }
  h['x-synapseone-user'] = String(p.sub || 'workflow').slice(0, 128);
  h['x-synapseone-kind'] = String(p.kind || 'workflow').slice(0, 32);
  if (p.org) h['x-synapseone-org'] = String(p.org).slice(0, 128);
  if (p.account) h['x-synapseone-account'] = String(p.account).slice(0, 128);
  return h;
}

async function queueFetch(method: string, path: string, p: Principal | null | undefined, body?: any, timeoutMs = 15000): Promise<any> {
  const base = queueBase();
  if (!base) throw new Error('SynapseQueue is not configured (QUEUE_SERVICE_URL is empty)');
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: queueHeaders(p),
      signal: ctl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!r.ok) {
      const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
      const err: any = new Error(`SynapseQueue ${method} ${path} -> ${r.status}${detail ? ` (${detail})` : ''}`);
      err.status = r.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`SynapseQueue ${method} ${path} timed out after ${timeoutMs}ms`);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(to);
  }
}

export async function ensureWorkflowQueue(queue: string, p: Principal | null | undefined, opts: QueueOptions = {}): Promise<void> {
  if (!isQueueName(queue)) throw new Error(`invalid queue name '${queue}'`);
  const body: Record<string, any> = {
    maxAttempts: Math.min(Math.max(Number(opts.maxAttempts ?? queueMaxAttempts()) || queueMaxAttempts(), 1), 100),
    visibilityTimeoutSeconds: Math.min(Math.max(Number(opts.visibilityTimeoutSeconds ?? queueVisibilitySeconds()) || queueVisibilitySeconds(), 1), 3600),
  };
  try {
    await queueFetch('PUT', `/v1/queue/queues/${encodeURIComponent(queue)}`, p, body);
  } catch (e: any) {
    // 409 means another dispatcher created it with compatible settings.
    if (e?.status !== 409) throw e;
  }
}

/** Publish a run job. The payload deliberately contains only the execution
 *  id: inputs/definitions stay in Postgres and are fetched by the worker after
 *  an authenticated claim. This keeps queue messages small and avoids putting
 *  workflow data (or secrets) into the message log. */
export async function publishWorkflowRun(queue: string, executionId: string, p: Principal | null | undefined, opts: {
  delaySeconds?: number;
  maxAttempts?: number;
  dedupeKey?: string;
} = {}): Promise<{ id: string; duplicate: boolean }> {
  const body: Record<string, any> = {
    payload: { v: 1, kind: 'workflow.run', executionId },
    ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    ...(opts.delaySeconds ? { delaySeconds: Math.min(Math.max(Number(opts.delaySeconds), 0), 604800) } : {}),
    ...(opts.maxAttempts ? { maxAttempts: Math.min(Math.max(Number(opts.maxAttempts), 1), 100) } : {}),
  };
  const res = await queueFetch('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/messages`, p, body);
  return { id: String(res?.id || ''), duplicate: !!res?.duplicate };
}

export async function consumeWorkflowRuns(queue: string, p: Principal | null | undefined, opts: {
  maxMessages?: number;
  visibilityTimeoutSeconds?: number;
  consumer?: string;
} = {}): Promise<ConsumedMessage[]> {
  const body = {
    maxMessages: Math.min(Math.max(Number(opts.maxMessages) || 1, 1), 100),
    visibilityTimeoutSeconds: Math.min(Math.max(Number(opts.visibilityTimeoutSeconds) || queueVisibilitySeconds(), 1), 3600),
    consumer: String(opts.consumer || 'workflow-worker').slice(0, 128),
  };
  const res = await queueFetch('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/consume`, p, body, 30000);
  const messages = Array.isArray(res?.messages) ? res.messages : [];
  return messages.map((m: any) => ({
    id: String(m.id || ''),
    receipt: String(m.receipt || ''),
    payload: m.payload,
    attempts: Number(m.attempts) || 0,
    leaseExpiresAt: m.leaseExpiresAt,
  }));
}

export async function ackWorkflowRun(queue: string, p: Principal | null | undefined, receipt: string): Promise<void> {
  try {
    await queueFetch('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/ack`, p, { receipt });
  } catch (e: any) {
    // An expired receipt means the message was already redelivered/acked.
    if (e?.status !== 404) throw e;
  }
}

export async function nackWorkflowRun(queue: string, p: Principal | null | undefined, receipt: string, opts: {
  requeue?: boolean;
  delaySeconds?: number;
  error?: string;
} = {}): Promise<void> {
  try {
    await queueFetch('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/nack`, p, {
      receipt,
      requeue: opts.requeue !== false,
      delaySeconds: Math.min(Math.max(Number(opts.delaySeconds) || 0, 0), 604800),
      error: opts.error ? String(opts.error).slice(0, 1024) : undefined,
    });
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
}

export async function heartbeatWorkflowRun(queue: string, p: Principal | null | undefined, receipt: string, visibilityTimeoutSeconds?: number): Promise<void> {
  try {
    await queueFetch('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/heartbeat`, p, {
      receipt,
      ...(visibilityTimeoutSeconds ? { visibilityTimeoutSeconds } : {}),
    });
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
}

export async function workflowQueueStats(queue: string, p: Principal | null | undefined): Promise<any> {
  return queueFetch('GET', `/v1/queue/queues/${encodeURIComponent(queue)}/stats`, p);
}

/** Cheap dependency probe for /health: the queue service's public /health. */
export async function pingWorkflowQueue(): Promise<boolean | null> {
  const base = queueBase();
  if (!base) return null;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(`${base}/health`, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(to);
  }
}
