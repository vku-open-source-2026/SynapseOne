// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * Public-API implementation of the engine's first-party call surface.
 *
 * A self-hosted runner has no access to SynapseOne's service network or
 * internal secret. It talks to the same public gateway as any tenant using its
 * scoped API key. This module maps the internal `synapseone.api` operations
 * onto public `/v1/...` routes and resolves workflow credentials through the
 * runner job protocol (never by reading the database).
 */
import './env-compat';
import type { CredentialResolver, SynapseOneCall } from './engine';

export class RunnerHttpError extends Error {
  status: number;
  body: any;
  constructor(status: number, path: string, body: any) {
    super(`SynapseOne ${status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'RunnerHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface RunnerApiOptions {
  baseUrl: string;
  apiKey: string;
  runnerId: string;
  timeoutMs?: number;
}

export function createRunnerApi(opts: RunnerApiOptions) {
  const base = String(opts.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('SYNAPSEONE_URL is required');
  if (!opts.apiKey) throw new Error('SYNAPSEONE_API_KEY is required');
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 300000);

  async function request(method: string, path: string, body?: any, extraHeaders: Record<string, string> = {}): Promise<any> {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': opts.apiKey,
          'X-Workflow-Runner-Id': opts.runnerId,
          ...extraHeaders,
        },
        signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) throw new RunnerHttpError(r.status, path, parsed);
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`SynapseOne ${method} ${path} timed out after ${timeoutMs}ms`);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  return { base, request };
}

function cleanId(v: unknown, field: string, max = 256): string {
  const s = String(v ?? '');
  if (!s || s.length > max || /[\r\n]/.test(s)) throw new Error(`synapseone.api: '${field}' is required`);
  return s;
}

function enc(v: unknown, field: string, max = 256): string {
  return encodeURIComponent(cleanId(v, field, max));
}

function requireObj(v: unknown, field: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`synapseone.api: '${field}' must be an object`);
  return v as Record<string, any>;
}

/** Map one engine integration call onto the public REST API. */
export function createRemoteSynapseOneCall(api: ReturnType<typeof createRunnerApi>, depth = 0): SynapseOneCall {
  return async (resource, operation, args) => {
    const a = args && typeof args === 'object' ? args : {};
    switch (`${resource}.${operation}`) {
      case 'workflows.list':
        return api.request('GET', '/v1/workflows');
      case 'workflows.get':
        return api.request('GET', `/v1/workflows/${enc(a.id, 'id', 128)}`);
      case 'workflows.execute': {
        const nextDepth = depth + 1;
        if (nextDepth > 3) throw new Error('synapseone.api: workflows.execute nesting limit (3) reached');
        const input = a.input && typeof a.input === 'object' && !Array.isArray(a.input) ? a.input : {};
        const res = await api.request(
          'POST',
          `/v1/workflows/${enc(a.id, 'id', 128)}/execute?wait=1&inline=1&timeoutMs=60000`,
          input,
          { 'X-Workflow-Depth': String(nextDepth) },
        );
        return {
          ok: res?.status === 'success' || res?.ok === true,
          executionId: res?.executionId,
          workflow: res?.workflow,
          output: res?.output,
          ...(res?.error ? { error: res.error } : {}),
        };
      }
      case 'executions.list': {
        const qs = new URLSearchParams();
        qs.set('limit', String(Math.min(Math.max(Number(a.limit) || 20, 1), 100)));
        qs.set('offset', String(Math.max(Number(a.offset) || 0, 0)));
        if (a.status) qs.set('status', String(a.status));
        if (a.workflowId) qs.set('workflowId', String(a.workflowId));
        return api.request('GET', `/v1/executions?${qs.toString()}`);
      }
      case 'executions.get':
        return api.request('GET', `/v1/executions/${enc(a.id, 'id', 128)}?includeData=true`);
      case 'templates.list':
        return api.request('GET', '/v1/templates');
      case 'templates.get':
        return api.request('GET', `/v1/templates/${enc(a.name, 'name', 64)}`);

      // SynapseLDS
      case 'lds.list-datasources':
        return api.request('GET', '/v1/lds/datasources');
      case 'lds.publish-record': {
        const record = a.record !== undefined ? a.record : a.data;
        requireObj(record, 'record');
        return api.request('POST', `/v1/lds/datasources/${enc(a.datasourceId, 'datasourceId', 128)}/records`, { record });
      }
      case 'lds.get-entity':
        return api.request('GET', `/v1/lds/datasources/${enc(a.datasourceId, 'datasourceId', 128)}/entities/${enc(a.entityId, 'entityId', 256)}`);

      // SynapseBase
      case 'base.list-collections':
        return api.request('GET', '/v1/base/collections');
      case 'base.create-document':
        return api.request('POST', `/v1/base/collections/${enc(a.collection, 'collection', 128)}/documents`, {
          ...(a.id ? { id: String(a.id) } : {}),
          data: a.data !== undefined ? a.data : a.document,
        });
      case 'base.get-document':
        return api.request('GET', `/v1/base/collections/${enc(a.collection, 'collection', 128)}/documents/${enc(a.id, 'id', 256)}`);
      case 'base.query-documents': {
        const where = a.where !== undefined ? a.where : a.filter;
        const orderBy = a.orderBy !== undefined ? a.orderBy : a.sort;
        return api.request('POST', `/v1/base/collections/${enc(a.collection, 'collection', 128)}/query`, {
          ...(where !== undefined ? { where } : {}),
          ...(orderBy !== undefined ? { orderBy } : {}),
          limit: a.limit,
          offset: a.offset,
        });
      }
      case 'base.delete-document':
        return api.request('DELETE', `/v1/base/collections/${enc(a.collection, 'collection', 128)}/documents/${enc(a.id, 'id', 256)}`);
      case 'base.vector-search':
        return api.request('POST', `/v1/base/collections/${enc(a.collection, 'collection', 128)}/vector-search`, {
          vector: a.vector ?? a.embedding,
          query: a.query ?? a.text ?? a.prompt,
          limit: a.limit ?? a.k,
          field: a.field,
          metric: a.metric,
          where: a.where !== undefined ? a.where : a.filter,
          as: a.as,
        });

      // Synapse Faststore
      case 'faststore.get':
        return api.request('GET', `/v1/faststore/keys/${enc(a.key, 'key', 256)}`);
      case 'faststore.set':
        return api.request('PUT', `/v1/faststore/keys/${enc(a.key, 'key', 256)}`, {
          value: a.value, ttlSeconds: a.ttlSeconds, nx: a.nx, xx: a.xx,
        });
      case 'faststore.incr':
        return api.request('POST', `/v1/faststore/keys/${enc(a.key, 'key', 256)}/incr`, {
          by: a.by !== undefined ? Number(a.by) : 1, ttlSeconds: a.ttlSeconds,
        });
      case 'faststore.delete':
        return api.request('DELETE', `/v1/faststore/keys/${enc(a.key, 'key', 256)}`);
      case 'faststore.hash-get':
        return api.request('GET', `/v1/faststore/hashes/${enc(a.key, 'key', 256)}${a.field ? `/${enc(a.field, 'field', 128)}` : ''}`);
      case 'faststore.hash-set':
        return api.request('PUT', `/v1/faststore/hashes/${enc(a.key, 'key', 256)}`, {
          values: a.values || a.fields || (a.field && a.value !== undefined ? { [a.field]: a.value } : {}),
          ttlSeconds: a.ttlSeconds,
        });

      // SynapseQueue
      case 'queue.list':
        return api.request('GET', '/v1/queue/queues');
      case 'queue.publish':
        return api.request('POST', `/v1/queue/queues/${enc(a.queue, 'queue', 128)}/messages`, {
          payload: a.payload !== undefined ? a.payload : a.body !== undefined ? a.body : a.message,
          priority: a.priority,
          delaySeconds: a.delaySeconds,
        });
      case 'queue.consume':
        return api.request('POST', `/v1/queue/queues/${enc(a.queue, 'queue', 128)}/consume`, {
          maxMessages: a.maxMessages !== undefined ? Number(a.maxMessages) : a.count !== undefined ? Number(a.count) : 1,
          consumer: a.consumer || 'workflow-runner',
          visibilityTimeoutSeconds: a.visibilityTimeoutSeconds,
        });
      case 'queue.ack':
        return api.request('POST', `/v1/queue/queues/${enc(a.queue, 'queue', 128)}/ack`, {
          receipt: a.receipt || a.receiptHandle,
        });

      // Synapse Inference
      case 'inference.chat':
        return api.request('POST', '/v1/inference/chat/completions', {
          messages: a.messages, model: a.model, temperature: a.temperature, max_tokens: a.max_tokens,
          ...(a.tools !== undefined ? { tools: a.tools } : {}),
          ...(a.tool_choice !== undefined ? { tool_choice: a.tool_choice } : {}),
          ...(a.response_format !== undefined ? { response_format: a.response_format } : {}),
          ...(a.top_p !== undefined ? { top_p: a.top_p } : {}),
        });
      case 'inference.embeddings':
        return api.request('POST', '/v1/inference/embeddings', { input: a.input, model: a.model });
      case 'inference.decision':
        return api.request('POST', '/v1/inference/decision', { state: a.state, questions: a.questions, instruction: a.instruction });
      case 'inference.route':
        return api.request('POST', '/v1/inference/decision/route', { input: a.input, choices: a.choices, instruction: a.instruction });

      // Synapse Warehouse
      case 'warehouse.list-datasets':
        return api.request('GET', '/v1/warehouse/datasets');
      case 'warehouse.list-jobs':
        return api.request('GET', '/v1/warehouse/jobs');
      case 'warehouse.create-dataset':
        return api.request('POST', '/v1/warehouse/datasets', {
          id: a.id, name: a.name, description: a.description, columns: a.columns, mode: a.mode, streamTopic: a.streamTopic,
        });
      case 'warehouse.ingest':
        return api.request('POST', `/v1/warehouse/datasets/${enc(a.datasetId, 'datasetId', 64)}/rows`, { rows: a.rows });
      case 'warehouse.query':
        return api.request('POST', '/v1/warehouse/query', { sql: a.sql, limit: a.limit });
      case 'warehouse.run-batch':
        return api.request('POST', '/v1/warehouse/etl/batch', {
          targetDatasetId: a.targetDatasetId, sql: a.sql, writeMode: a.writeMode, name: a.name,
        });
      case 'warehouse.ensure-stream':
        return api.request('POST', '/v1/warehouse/etl/stream', {
          targetDatasetId: a.targetDatasetId, streamTopic: a.streamTopic, streamGroup: a.streamGroup,
          name: a.name, batchSize: a.batchSize, intervalMs: a.intervalMs,
        });

      // SynapseStream
      case 'stream.list-topics':
        return api.request('GET', '/v1/stream/topics');
      case 'stream.publish':
        return api.request('POST', `/v1/stream/topics/${enc(a.topic, 'topic', 64)}/events`, {
          payload: a.payload, key: a.key, headers: a.headers,
        });
      case 'stream.ensure-group':
        await api.request('PUT', `/v1/stream/topics/${enc(a.topic, 'topic', 64)}`, {});
        return api.request('PUT', `/v1/stream/topics/${enc(a.topic, 'topic', 64)}/groups/${enc(a.group, 'group', 128)}`, {
          startId: a.startId !== undefined ? a.startId : '0',
        });
      case 'stream.consume':
        return api.request('POST', `/v1/stream/topics/${enc(a.topic, 'topic', 64)}/groups/${enc(a.group, 'group', 128)}/read`, {
          consumer: a.consumer || 'workflow-runner',
          count: Math.min(Math.max(Number(a.count) || 50, 1), 100),
          blockMs: a.blockMs,
        });
      case 'stream.ack':
        return api.request('POST', `/v1/stream/topics/${enc(a.topic, 'topic', 64)}/groups/${enc(a.group, 'group', 128)}/ack`, { ids: a.ids });

      // IAM
      case 'orgs.list':
        return api.request('GET', '/v1/orgs');
      case 'users.list':
        return api.request('GET', `/v1/orgs/${enc(a.orgId, 'orgId')}/users`);
      case 'roles.list':
        return api.request('GET', `/v1/accounts/${enc(a.accountId, 'accountId')}/roles`);
      case 'policies.list':
        return api.request('GET', `/v1/accounts/${enc(a.accountId, 'accountId')}/policies`);
      case 'authorize.check':
        return api.request('POST', '/v1/authorize', {
          userId: cleanId(a.userId, 'userId'), action: cleanId(a.action, 'action', 512),
          resource: cleanId(a.resource, 'resource', 2048), ...(a.context !== undefined ? { context: a.context } : {}),
        });
      case 'audit.query': {
        const qs = new URLSearchParams();
        qs.set('limit', String(Math.min(Math.max(Number(a.limit) || 20, 1), 200)));
        if (a.actor !== undefined) qs.set('actor', String(a.actor));
        if (a.allowed !== undefined) qs.set('allowed', String(!!a.allowed));
        return api.request('GET', `/v1/audit?${qs.toString()}`);
      }
      case 'keys.list':
        return api.request('GET', `/v1/accounts/${enc(a.accountId, 'accountId')}/keys`);
      case 'service-accounts.list':
        return api.request('GET', `/v1/accounts/${enc(a.accountId, 'accountId')}/service-accounts`);

      default:
        throw new Error(`synapseone.api: unsupported call '${resource}.${operation}' on a self-hosted runner`);
    }
  };
}

/** Resolve node credentials for exactly one claimed execution. */
export function createRemoteCredentialResolver(api: ReturnType<typeof createRunnerApi>, executionId: string, runnerId: string): CredentialResolver {
  return async (credentialId: string) => {
    if (!credentialId || typeof credentialId !== 'string' || credentialId.length > 128 || /[\r\n]/.test(credentialId)) return null;
    try {
      const r = await api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/credentials`, {
        runnerId,
        credentialId,
      });
      if (!r || typeof r.secret !== 'string') return null;
      return { kind: String(r.kind || 'bearer'), secret: r.secret };
    } catch (e: any) {
      if (e instanceof RunnerHttpError && e.status === 404) return null;
      throw e;
    }
  };
}
