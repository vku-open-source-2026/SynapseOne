// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow client: templates, workflow CRUD/lifecycle, executions, test runs
 * and public inbound webhooks.
 */

import { HttpClient, WEBHOOK_TIMEOUT_MS } from './_http';

/** Credential kinds accepted by the workflow engine (used by http/webhook nodes). */
export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'hmac';

export interface CredentialInput {
  /** Owning account (credentials are account-scoped, org-bound for org callers). */
  accountId: string;
  name: string;
  kind?: CredentialKind | string;
  type?: CredentialKind | string;
  /** Write-only: never returned by any endpoint. */
  secret: string;
}

export interface CredentialMetadata {
  id: string;
  accountId: string;
  name: string;
  kind: CredentialKind | string;
  createdAt: string;
  updatedAt: string;
}

export class WorkflowService {
  constructor(private readonly http: HttpClient) {}

  // ---- templates ----
  listTemplates() { return this.http.req('/v1/templates'); }
  getTemplate(name: string) { return this.http.req(`/v1/templates/${encodeURIComponent(name)}`); }

  // ---- workflows ----
  listWorkflows() { return this.http.req('/v1/workflows'); }
  getWorkflow(id: string) { return this.http.req(`/v1/workflows/${encodeURIComponent(id)}`); }
  createWorkflowFromTemplate(template: string, name?: string) {
    return this.http.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ template, name }) });
  }
  createWorkflow(name: string, definition: any, settings?: Record<string, unknown>) {
    return this.http.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ name, definition, ...(settings ? { settings } : {}) }) });
  }
  updateWorkflow(id: string, patch: { name?: string; definition?: any; settings?: Record<string, unknown> }) {
    return this.http.req(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  deleteWorkflow(id: string) {
    return this.http.req(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  activateWorkflow(id: string) { return this.http.req(`/v1/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' }); }
  deactivateWorkflow(id: string) { return this.http.req(`/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }); }
  executeWorkflow(id: string, payload: Record<string, unknown> = {}, opts: { wait?: boolean; timeoutMs?: number } = {}) {
    const qs = opts.wait
      ? `?wait=1&timeoutMs=${encodeURIComponent(Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 300000))}`
      : '';
    return this.http.req(`/v1/workflows/${encodeURIComponent(id)}/execute${qs}`, { method: 'POST', body: JSON.stringify(payload) });
  }

  /** Poll an execution until it leaves queued/running (queue mode). */
  async waitForExecution(id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<any> {
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 300000);
    const pollMs = Math.min(Math.max(Number(opts.pollMs) || 500, 100), 5000);
    const deadline = Date.now() + timeoutMs;
    let current: any = await this.getExecution(id, true);
    while (current && (current.status === 'queued' || current.status === 'running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      current = await this.getExecution(id, true);
    }
    return current;
  }

  // ---- self-hosted workflow runners ----
  listWorkflowRunners() { return this.http.req('/v1/workflow-runners'); }
  getWorkflowRunnerOptions() { return this.http.req('/v1/workflow-runners/options'); }
  getWorkflowRunner(id: string) { return this.http.req(`/v1/workflow-runners/${encodeURIComponent(id)}`); }
  updateWorkflowRunner(id: string, patch: { name?: string; mode?: 'custom' | 'hybrid'; queue?: string; metadata?: Record<string, unknown> }) {
    return this.http.req(`/v1/workflow-runners/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  createWorkflowRunner(body: {
    name: string;
    mode?: 'custom' | 'hybrid';
    queue?: string;
    apiKeyId?: string;
    keyPrefix?: string;
    scopes?: string[];
    metadata?: Record<string, unknown>;
  }) {
    return this.http.req('/v1/workflow-runners', { method: 'POST', body: JSON.stringify(body) });
  }
  getWorkflowRunnerConnection(id: string) {
    return this.http.req(`/v1/workflow-runners/${encodeURIComponent(id)}/connection`);
  }
  getWorkflowRunnerCommand(id: string, apiKey?: string) {
    return this.http.req(`/v1/workflow-runners/${encodeURIComponent(id)}/command`, {
      method: 'POST', body: JSON.stringify(apiKey ? { apiKey } : {}),
    });
  }
  deleteWorkflowRunner(id: string) {
    return this.http.req(`/v1/workflow-runners/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  deleteWorkflowRunnerInstance(id: string, instanceId: string) {
    return this.http.req(`/v1/workflow-runners/${encodeURIComponent(id)}/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
  }

  // ---- executions ----
  getExecution(id: string, includeData = false) {
    const qs = includeData ? '?includeData=true' : '';
    return this.http.req(`/v1/executions/${encodeURIComponent(id)}${qs}`);
  }
  listExecutions(query: string | Record<string, string | number | boolean | undefined> = ''): Promise<any[]> {
    let q = '';
    if (typeof query === 'string') {
      q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    } else if (query && typeof query === 'object') {
      // Allowlist mirrors GET /v1/executions (limit/offset/workflowId/status/triggeredBy/includeData).
      const allowed = ['limit', 'offset', 'workflowId', 'status', 'triggeredBy', 'includeData'] as const;
      const params = new URLSearchParams();
      for (const k of allowed) {
        const v = (query as any)[k];
        if (v !== undefined && v !== null && String(v) !== '') params.set(k, String(v));
      }
      const s = params.toString();
      q = s ? `?${s}` : '';
    }
    return this.http.req(`/v1/executions${q}`).then(unwrapExecutions);
  }
  testRun(definition: any, input: Record<string, unknown> = {}, workflowId?: string) {
    return this.http.req('/v1/workflows/test-run', { method: 'POST', body: JSON.stringify({ definition, input, ...(workflowId ? { workflowId } : {}) }) });
  }

  // ---- credentials (account-scoped secrets, encrypted at rest) ----
  // Secrets are write-only: create/rotate accept `secret` once, every read
  // returns metadata only. Kinds: bearer | api-key | basic | hmac.
  createCredential(
    inputOrAccountId: CredentialInput | string,
    opts?: { name: string; kind?: CredentialKind | string; type?: CredentialKind | string; secret: string; expiresAt?: string }
  ): Promise<CredentialMetadata> {
    const body = typeof inputOrAccountId === 'string'
      ? {
          accountId: inputOrAccountId,
          name: opts?.name,
          kind: opts?.kind || opts?.type || 'bearer',
          secret: opts?.secret,
        }
      : {
          accountId: inputOrAccountId.accountId,
          name: inputOrAccountId.name,
          kind: inputOrAccountId.kind || inputOrAccountId.type || 'bearer',
          secret: inputOrAccountId.secret,
        };
    return this.http.req('/v1/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  listCredentials(accountId?: string): Promise<CredentialMetadata[]> {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return this.http.req<any>(`/v1/credentials${qs}`).then(unwrapCredentialList);
  }
  getCredential(id: string): Promise<CredentialMetadata> {
    return this.http.req(`/v1/credentials/${encodeURIComponent(id)}`);
  }
  rotateCredential(id: string, secret: string): Promise<CredentialMetadata> {
    return this.http.req(`/v1/credentials/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
  }
  deleteCredential(id: string) {
    return this.http.req(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ---- durable human tasks (#44) ----
  /** Create a standalone human task (workflow nodes create theirs on pause). */
  createHumanTask(input: {
    title: string; description?: string; assignee?: string; candidateRoles?: string[];
    deadline?: string; decisionSchema?: Record<string, unknown>; payload?: Record<string, unknown>;
    workflowId?: string; executionId?: string; node?: string;
  }) {
    return this.http.req('/v1/human-tasks', { method: 'POST', body: JSON.stringify(input) });
  }
  listHumanTasks(query: Record<string, string | number | boolean | undefined> = {}) {
    const allowed = ['status', 'executionId', 'workflowId', 'assignee', 'limit', 'offset'] as const;
    const params = new URLSearchParams();
    for (const k of allowed) {
      const v = query[k];
      if (v !== undefined && v !== null && String(v) !== '') params.set(k, String(v));
    }
    const s = params.toString();
    return this.http.req(`/v1/human-tasks${s ? `?${s}` : ''}`);
  }
  getHumanTask(id: string) { return this.http.req(`/v1/human-tasks/${encodeURIComponent(id)}`); }
  claimHumanTask(id: string) { return this.http.req(`/v1/human-tasks/${encodeURIComponent(id)}/claim`, { method: 'POST', body: '{}' }); }
  completeHumanTask(id: string, decision: Record<string, unknown> = {}, note?: string) {
    return this.http.req(`/v1/human-tasks/${encodeURIComponent(id)}/complete`, {
      method: 'POST', body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    });
  }
  rejectHumanTask(id: string, note: string, decision: Record<string, unknown> = {}) {
    return this.http.req(`/v1/human-tasks/${encodeURIComponent(id)}/reject`, {
      method: 'POST', body: JSON.stringify({ note, decision }),
    });
  }
  expireHumanTask(id: string, force = false) {
    return this.http.req(`/v1/human-tasks/${encodeURIComponent(id)}/expire`, {
      method: 'POST', body: JSON.stringify({ force }),
    });
  }

  // ---- tenant secret vault (#47) ----
  createSecret(name: string, value: string, opts: { description?: string; scope?: string; accountId?: string } = {}) {
    return this.http.req('/v1/secrets', { method: 'POST', body: JSON.stringify({ name, value, ...opts }) });
  }
  listSecrets() { return this.http.req('/v1/secrets'); }
  getSecret(name: string) { return this.http.req(`/v1/secrets/${encodeURIComponent(name)}`); }
  readSecret(name: string, version?: number) {
    return this.http.req(`/v1/secrets/${encodeURIComponent(name)}/read`, {
      method: 'POST', body: JSON.stringify(version ? { version } : {}),
    });
  }
  rotateSecret(name: string, value: string, graceSeconds = 86400) {
    return this.http.req(`/v1/secrets/${encodeURIComponent(name)}/rotate`, {
      method: 'POST', body: JSON.stringify({ value, graceSeconds }),
    });
  }
  revokeSecret(name: string, version?: number) {
    return this.http.req(`/v1/secrets/${encodeURIComponent(name)}/revoke`, {
      method: 'POST', body: JSON.stringify(version ? { version } : {}),
    });
  }
  deleteSecret(name: string) {
    return this.http.req(`/v1/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  // ---- public inbound webhooks ----
  /**
   * Fire a public inbound webhook through the gateway: `ANY /webhook/:path`.
   * No auth is required; per-workflow auth/rate-limit/idempotency still apply.
   * `path` is the webhook node's `parameters.path`, not a workflow id.
   *
   * The gateway allows 300s for `/webhook`; this call uses that budget unless
   * `init.timeoutMs` overrides it.
   */
  triggerWebhook(
    path: string,
    payload?: unknown,
    init: { method?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const clean = String(path || '').replace(/^\/+|\/+$/g, '').split('?')[0];
    if (!clean) throw new Error('synapseone webhook: path required');
    const method = (init.method || (payload === undefined ? 'GET' : 'POST')).toUpperCase();
    return this.http.req(`/webhook/${clean}`, {
      method,
      body: payload === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
    }, { timeoutMs: init.timeoutMs ?? WEBHOOK_TIMEOUT_MS, signal: init.signal, retryable: true });
  }
}

/** Normalize GET /v1/credentials: the API returns `{data: []}`. */
export function unwrapCredentialList(payload: any): CredentialMetadata[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload == null ? [] : payload as any;
}

/**
 * Normalize GET /v1/executions responses: the engine returns `{data: []}`
 * (envelope, forward-compat with the old n8n proxy); older mocks return a
 * bare array. Accepts both so callers always get an array.
 */
export function unwrapExecutions(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload == null ? [] : payload as any;
}

/**
 * Fire a public inbound webhook: `ANY /webhook/:path` (no auth) triggers the
 * ACTIVE workflow whose webhook node declares that `path`.
 *
 * The gateway proxies `/webhook/*` to the workflow service, so `webhookBaseUrl`
 * is normally the gateway URL. Use `client.workflow.triggerWebhook()` for the
 * gateway-bound convenience form. `path` is the webhook node's
 * `parameters.path` (e.g. `synapseone-event`), not a workflow id.
 */
export async function triggerWebhook(
  webhookBaseUrl: string,
  path: string,
  payload?: unknown,
  init?: { method?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<any> {
  const base = webhookBaseUrl.replace(/\/$/, '');
  const clean = String(path || '').replace(/^\/+|\/+$/g, '').split('?')[0];
  if (!clean) throw new Error('synapseone webhook: path required');
  const method = (init?.method || (payload === undefined ? 'GET' : 'POST')).toUpperCase();
  const url = `${base}/webhook/${clean}`;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (init?.signal) {
    if (init.signal.aborted) ctl.abort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
  }
  const to = setTimeout(() => ctl.abort(), init?.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload),
    });
  } catch (e: any) {
    throw new Error(`synapseone network /webhook/${clean}: ${e?.message || e}`);
  } finally {
    clearTimeout(to);
    if (init?.signal) init.signal.removeEventListener('abort', onAbort);
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`synapseone ${r.status} /webhook/${clean}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
