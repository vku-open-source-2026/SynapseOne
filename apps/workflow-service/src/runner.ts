// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * Self-hosted SynapseOne runner.
 *
 * A connector can run one or two lanes:
 *   - workflow  : consume a SynapseQueue workflow queue and execute DAGs
 *   - inference : consume a SynapseQueue inference queue and call a local
 *                 OpenAI-compatible inference backend
 *   - hybrid    : both lanes in one process
 *
 * The runner only needs outbound HTTPS to the SynapseOne gateway. It uses the
 * scoped API key for every SynapseOne call (queue, workflow jobs, inference
 * jobs, credentials, Base/LDS/Faststore/Inference/...), and never needs a
 * database, internal secret or service-network address.
 *
 * Required env:
 *   SYNAPSEONE_URL          public gateway URL (https://api.synapseone.space)
 *   SYNAPSEONE_API_KEY      scoped API key minted for this runner
 *   WORKFLOW_RUNNER_ID      runner id from the console/API
 * Optional:
 *   WORKFLOW_RUNNER_INSTANCE_ID  stable connector id (default host-pid-random)
 *   WORKFLOW_RUNNER_CONCURRENCY, WORKFLOW_RUNNER_INFERENCE_CONCURRENCY,
 *   WORKFLOW_RUNNER_POLL_MS, WORKFLOW_RUNNER_LEASE_SECONDS,
 *   WORKFLOW_RUNNER_HEARTBEAT_SECONDS, WORKFLOW_RUNNER_ONCE
 * Inference lane:
 *   INFERENCE_RUNNER_URL        OpenAI-compatible base URL (http://vllm:8000/v1)
 *   INFERENCE_RUNNER_API_KEY    optional backend bearer token
 *   INFERENCE_RUNNER_MODEL      optional model override
 *   INFERENCE_RUNNER_CHAT_PATH / EMBEDDINGS_PATH / DECISION_PATH / ROUTE_PATH
 * Network:
 *   HTTPS_PROXY / HTTP_PROXY / NO_PROXY, SYNAPSEONE_CA_CERT,
 *   SYNAPSEONE_TLS_INSECURE (dev only), SYNAPSEONE_HTTP_RETRIES
 */
import './env-compat';
import os from 'os';
import { randomUUID } from 'crypto';
import { runWorkflow } from './engine';
import type { Principal } from './store';
import { createRemoteCredentialResolver, createRemoteSynapseOneCall, createRunnerApi, RunnerHttpError } from './remote-call';

const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function intEnv(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name] || def);
  return Math.min(Math.max(Number.isFinite(n) ? n : def, min), max);
}

function log(...args: any[]): void {
  console.log(`[runner ${new Date().toISOString()}]`, ...args);
}

function errorLog(...args: any[]): void {
  console.error(`[runner ${new Date().toISOString()}]`, ...args);
}

interface RunnerConfig {
  runnerId: string;
  name?: string;
  kind: 'workflow' | 'inference' | 'hybrid';
  mode: 'custom' | 'hybrid';
  queue: string;
  inferenceQueue?: string | null;
  queues?: { workflow?: string | null; inference?: string | null };
  heartbeatIntervalSeconds: number;
  staleAfterSeconds?: number;
  maxConcurrency?: number;
  visibilityTimeoutSeconds: number;
}

interface ClaimedWorkflowJob {
  executionId: string;
  workflow: { id: string; name: string; nodes: any[]; connections: Record<string, any>; settings: Record<string, any>; revision?: number };
  input: any;
  principal: Principal | null;
  triggeredBy: string;
  attempt?: number;
  leaseExpiresAt?: string;
  resumeFrom?: { node: string; output: any } | null;
}

interface ClaimedInferenceJob {
  jobId: string;
  type: string;
  request: any;
  attempt?: number;
  leaseExpiresAt?: string;
}

function executionIdFromMessage(payload: any): string | null {
  if (!payload || typeof payload !== 'object' || payload.kind !== 'workflow.run') return null;
  const id = String(payload.executionId || '');
  return id && id.length <= 128 && !/[\r\n]/.test(id) ? id : null;
}

function inferenceJobIdFromMessage(payload: any): string | null {
  if (!payload || typeof payload !== 'object' || payload.kind !== 'inference.run') return null;
  const id = String(payload.jobId || '');
  return id && id.length <= 128 && !/[\r\n]/.test(id) ? id : null;
}

function hasScope(scopes: string[], service: string, actions: string[]): boolean {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes('*')) return true;
  if (list.includes(`${service}:*`)) return true;
  if (list.includes(`${service}:write`)) return true;
  if (list.includes('*:write')) return true;
  return actions.some((a) => list.includes(`${service}:${a}`));
}

async function localInferenceRequest(
  type: string,
  request: any,
  opts: { baseUrl: string; apiKey: string; model?: string; timeoutMs: number },
): Promise<any> {
  const base = opts.baseUrl.replace(/\/$/, '');
  const pathFor = (): string => {
    if (type === 'chat') return process.env.INFERENCE_RUNNER_CHAT_PATH || '/chat/completions';
    if (type === 'embeddings') return process.env.INFERENCE_RUNNER_EMBEDDINGS_PATH || '/embeddings';
    if (type === 'decision') return process.env.INFERENCE_RUNNER_DECISION_PATH || '/decision';
    if (type === 'route') return process.env.INFERENCE_RUNNER_ROUTE_PATH || '/decision/route';
    return String(request?.path || process.env.INFERENCE_RUNNER_GENERIC_PATH || '/infer');
  };
  const path = pathFor().startsWith('/') ? pathFor() : `/${pathFor()}`;
  const payload = (() => {
    if (type === 'generic') return request?.body !== undefined ? request.body : request;
    const body = { ...(request && typeof request === 'object' ? request : {}) };
    if (opts.model) body.model = opts.model;
    return body;
  })();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' ? (parsed.error?.message || parsed.error || parsed.message || '') : '';
      throw new Error(`inference backend ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
    }
    return parsed;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`inference backend timed out after ${opts.timeoutMs}ms`);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const baseUrl = String(process.env.SYNAPSEONE_URL || '').trim();
  const apiKey = String(process.env.SYNAPSEONE_API_KEY || '').trim();
  const runnerId = String(process.env.WORKFLOW_RUNNER_ID || '').trim();
  if (!baseUrl) throw new Error('SYNAPSEONE_URL is required');
  if (!apiKey) throw new Error('SYNAPSEONE_API_KEY is required');
  if (!runnerId) throw new Error('WORKFLOW_RUNNER_ID is required (create a runner in the console)');

  const instanceId = String(process.env.WORKFLOW_RUNNER_INSTANCE_ID || '').trim()
    || `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const hostname = os.hostname();
  const pollMs = intEnv('WORKFLOW_RUNNER_POLL_MS', 1000, 200, 30000);
  const leaseSeconds = intEnv('WORKFLOW_RUNNER_LEASE_SECONDS', 300, 30, 3600);
  const heartbeatOverride = process.env.WORKFLOW_RUNNER_HEARTBEAT_SECONDS;
  const once = String(process.env.WORKFLOW_RUNNER_ONCE || '').toLowerCase() === '1'
    || String(process.env.WORKFLOW_RUNNER_ONCE || '').toLowerCase() === 'true';

  const api = createRunnerApi({ baseUrl, apiKey, runnerId, timeoutMs: 60000 });
  const config: RunnerConfig = await api.request('GET', `/v1/workflow-runners/${encodeURIComponent(runnerId)}/config`);
  if (!config) throw new Error('runner config is empty');
  const kind: RunnerConfig['kind'] = config.kind === 'inference' || config.kind === 'hybrid' ? config.kind : 'workflow';
  const envKind = String(process.env.WORKFLOW_RUNNER_KIND || '').trim();
  if (envKind && envKind !== kind) {
    log(`warning: WORKFLOW_RUNNER_KIND=${envKind} differs from server kind '${kind}' — using the server value`);
  }
  const workflowQueue = config.queues?.workflow || config.queue || '';
  const inferenceQueue = config.queues?.inference || config.inferenceQueue || '';
  const workflowLane = kind === 'workflow' || kind === 'hybrid';
  const inferenceLane = kind === 'inference' || kind === 'hybrid';
  if (workflowLane && !workflowQueue) throw new Error('runner config has no workflow queue');
  if (inferenceLane && !inferenceQueue) throw new Error('runner config has no inference queue');

  const maxConcurrency = Math.min(Math.max(Number(config.maxConcurrency) || 32, 1), 64);
  const concurrency = Math.min(intEnv('WORKFLOW_RUNNER_CONCURRENCY', 1, 1, 64), maxConcurrency);
  const inferenceConcurrency = Math.min(intEnv('WORKFLOW_RUNNER_INFERENCE_CONCURRENCY', concurrency, 1, 64), maxConcurrency);
  const heartbeatSeconds = heartbeatOverride
    ? intEnv('WORKFLOW_RUNNER_HEARTBEAT_SECONDS', 15, 5, 300)
    : Math.min(Math.max(Number(config.heartbeatIntervalSeconds) || 15, 5), 300);
  const consumer = `runner-${runnerId}-${instanceId}`.slice(0, 128);
  const capabilities = [
    ...(workflowLane ? ['workflow'] : []),
    ...(inferenceLane ? ['inference'] : []),
  ];

  // Preflight the API key before opening any queue. A connector that cannot
  // authenticate should fail loudly, not sit in "waiting" forever.
  const verify = await api.request('GET', '/v1/auth/verify').catch((e: any) => {
    if (e instanceof RunnerHttpError && (e.status === 401 || e.status === 403)) {
      throw new Error(`SYNAPSEONE_API_KEY was rejected by ${baseUrl} (${e.status}). Check the key, tenant, and that this URL is the SynapseOne gateway.`);
    }
    throw e;
  });
  if (!verify || verify.valid !== true) throw new Error('SYNAPSEONE_API_KEY verification failed');
  const scopes: string[] = Array.isArray(verify.scopes) ? verify.scopes : Array.isArray(verify.claims?.scopes) ? verify.claims.scopes : [];
  if (workflowLane && !hasScope(scopes, 'workflow', ['read', 'write', 'execute'])) {
    throw new Error(`API key is missing workflow scopes. Add workflow:* (current: ${scopes.join(', ') || 'none'})`);
  }
  if (!hasScope(scopes, 'queue', ['read', 'write', 'consume', 'ack'])) {
    throw new Error(`API key is missing queue scopes. Add queue:* (current: ${scopes.join(', ') || 'none'})`);
  }
  if (inferenceLane && !hasScope(scopes, 'inference', ['invoke', 'write', 'read'])) {
    throw new Error(`API key is missing inference scopes. Add inference:* (current: ${scopes.join(', ') || 'none'})`);
  }

  let inferenceBackend = '';
  if (inferenceLane) {
    inferenceBackend = String(process.env.INFERENCE_RUNNER_URL || '').trim().replace(/\/$/, '');
    if (!inferenceBackend) {
      throw new Error('INFERENCE_RUNNER_URL is required for an inference/hybrid runner (OpenAI-compatible base URL, e.g. http://vllm:8000/v1)');
    }
    try { new URL(inferenceBackend); } catch {
      throw new Error(`INFERENCE_RUNNER_URL is not a valid URL: ${inferenceBackend}`);
    }
  }

  log(`starting runner=${runnerId} instance=${instanceId} host=${hostname} kind=${kind} capabilities=${capabilities.join('+')} workflowQueue=${workflowQueue || '-'} inferenceQueue=${inferenceQueue || '-'} concurrency=${concurrency}/${inferenceConcurrency} version=${VERSION}`);

  let stopping = false;
  const workflowInFlight = new Set<string>();
  const inferenceInFlight = new Set<string>();
  let workflowTicking = false;
  let inferenceTicking = false;

  const heartbeat = async (status: 'connected' | 'offline' = 'connected'): Promise<void> => {
    try {
      await api.request('POST', `/v1/workflow-runners/${encodeURIComponent(runnerId)}/heartbeat`, {
        instanceId,
        hostname,
        version: VERSION,
        queue: workflowQueue || inferenceQueue,
        concurrency,
        startedAt,
        status,
        metadata: {
          kind,
          capabilities,
          queues: [...new Set([workflowQueue, inferenceQueue].filter(Boolean))],
          concurrency,
          inferenceConcurrency,
          once,
          pid: process.pid,
          platform: process.platform,
          inferenceBackend: inferenceBackend ? new URL(inferenceBackend).host : null,
          proxy: api.proxy ? true : false,
        },
      });
    } catch (e: any) {
      if (status !== 'offline') errorLog('heartbeat failed:', e?.message || e);
    }
  };
  await heartbeat();
  const hbTimer = setInterval(() => { void heartbeat(); }, heartbeatSeconds * 1000);

  const runWorkflowJob = async (executionId: string, receipt: string): Promise<void> => {
    let hb: NodeJS.Timeout | null = null;
    try {
      const claimed = await api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/claim`, {
        runnerId,
        instanceId,
        leaseSeconds,
      }) as ClaimedWorkflowJob;
      if (!claimed) throw new Error('claim returned an empty workflow job');
      hb = setInterval(() => {
        Promise.all([
          api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/heartbeat`, { runnerId, instanceId, leaseSeconds }).catch(() => null),
          api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/heartbeat`, {
            receipt, visibilityTimeoutSeconds: leaseSeconds,
          }).catch(() => null),
        ]).catch(() => undefined);
      }, Math.max(5, Math.floor(leaseSeconds / 3)) * 1000);
      hb.unref?.();

      const synapseoneCall = createRemoteSynapseOneCall(api);
      const credentialResolver = createRemoteCredentialResolver(api, executionId, runnerId);
      log(`run workflow execution=${executionId} workflow=${claimed.workflow.id} trigger=${claimed.triggeredBy}`);
      const result = await runWorkflow(claimed.workflow, claimed.input, {
        triggeredBy: claimed.triggeredBy,
        principal: claimed.principal,
        credentialResolver,
        synapseoneCall,
        resumeFrom: claimed.resumeFrom || undefined,
        humanTask: {
          create: async (task) => ({
            id: `runner-${randomUUID()}`,
            status: 'pending',
            title: task.title,
            description: task.description,
            assignee: task.assignee ?? null,
            candidateRoles: task.candidateRoles ?? [],
            decisionSchema: task.decisionSchema ?? {},
            payload: task.payload ?? {},
            deadline: task.deadline ?? null,
          }),
        },
      });
      await api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/complete`, {
        runnerId,
        instanceId,
        status: result.status,
        output: result.output,
        nodeRuns: result.nodeRuns,
        error: (result as any).error ?? null,
        ...(result.status === 'paused' ? { pause: (result as any).pause } : {}),
      });
      await api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/ack`, { receipt });
      log(`done workflow execution=${executionId} status=${result.status}`);
    } catch (e: any) {
      if (e instanceof RunnerHttpError && (e.status === 404 || e.status === 409 || e.status === 403)) {
        await api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/ack`, { receipt }).catch(() => null);
        log(`skip workflow execution=${executionId}: ${e.status}`);
        return;
      }
      errorLog(`workflow execution ${executionId} failed:`, e?.message || e);
      await api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/release`, {
        runnerId, instanceId, error: String(e?.message || e).slice(0, 1000),
      }).catch(() => null);
      await api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/nack`, {
        receipt, requeue: true, delaySeconds: 10, error: String(e?.message || e).slice(0, 1024),
      }).catch(() => null);
    } finally {
      if (hb) clearInterval(hb);
      workflowInFlight.delete(executionId);
    }
  };

  const runInferenceJob = async (jobId: string, receipt: string): Promise<void> => {
    let hb: NodeJS.Timeout | null = null;
    try {
      const claimed = await api.request('POST', `/v1/runner/inference/jobs/${encodeURIComponent(jobId)}/claim`, {
        runnerId,
        instanceId,
        leaseSeconds,
      }) as ClaimedInferenceJob;
      if (!claimed) throw new Error('claim returned an empty inference job');
      hb = setInterval(() => {
        Promise.all([
          api.request('POST', `/v1/runner/inference/jobs/${encodeURIComponent(jobId)}/heartbeat`, { runnerId, instanceId, leaseSeconds }).catch(() => null),
          api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/heartbeat`, {
            receipt, visibilityTimeoutSeconds: leaseSeconds,
          }).catch(() => null),
        ]).catch(() => undefined);
      }, Math.max(5, Math.floor(leaseSeconds / 3)) * 1000);
      hb.unref?.();
      log(`run inference job=${jobId} type=${claimed.type} backend=${inferenceBackend}`);
      const result = await localInferenceRequest(claimed.type, claimed.request, {
        baseUrl: inferenceBackend,
        apiKey: String(process.env.INFERENCE_RUNNER_API_KEY || ''),
        model: process.env.INFERENCE_RUNNER_MODEL ? String(process.env.INFERENCE_RUNNER_MODEL) : undefined,
        timeoutMs: intEnv('INFERENCE_RUNNER_TIMEOUT_MS', 120000, 1000, 300000),
      });
      await api.request('POST', `/v1/runner/inference/jobs/${encodeURIComponent(jobId)}/complete`, {
        runnerId,
        instanceId,
        status: 'success',
        result,
      });
      await api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/ack`, { receipt });
      log(`done inference job=${jobId}`);
    } catch (e: any) {
      if (e instanceof RunnerHttpError && (e.status === 404 || e.status === 409 || e.status === 403)) {
        await api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/ack`, { receipt }).catch(() => null);
        log(`skip inference job=${jobId}: ${e.status}`);
        return;
      }
      errorLog(`inference job ${jobId} failed:`, e?.message || e);
      await api.request('POST', `/v1/runner/inference/jobs/${encodeURIComponent(jobId)}/complete`, {
        runnerId,
        instanceId,
        status: 'error',
        error: String(e?.message || e).slice(0, 2000),
      }).catch(() => null);
      await api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/ack`, { receipt }).catch(() => null);
    } finally {
      if (hb) clearInterval(hb);
      inferenceInFlight.delete(jobId);
    }
  };

  const tickWorkflow = async (): Promise<void> => {
    if (stopping || workflowTicking || !workflowLane) return;
    workflowTicking = true;
    try {
      const slots = concurrency - workflowInFlight.size;
      if (slots <= 0) return;
      const consumed: any = await api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/consume`, {
        maxMessages: Math.min(slots + 1, 10),
        visibilityTimeoutSeconds: leaseSeconds,
        consumer: `${consumer}-wf`,
      });
      const messages = Array.isArray(consumed?.messages) ? consumed.messages : [];
      for (const m of messages) {
        if (workflowInFlight.size >= concurrency) break;
        const executionId = executionIdFromMessage(m.payload);
        const receipt = String(m.receipt || '');
        if (!executionId || !receipt) {
          await api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/ack`, { receipt }).catch(() => null);
          continue;
        }
        if (workflowInFlight.has(executionId)) {
          await api.request('POST', `/v1/queue/queues/${encodeURIComponent(workflowQueue)}/nack`, {
            receipt, requeue: true, delaySeconds: 5,
          }).catch(() => null);
          continue;
        }
        workflowInFlight.add(executionId);
        void runWorkflowJob(executionId, receipt);
      }
    } catch (e: any) {
      errorLog('workflow consume failed:', e?.message || e);
    } finally {
      workflowTicking = false;
    }
  };

  const tickInference = async (): Promise<void> => {
    if (stopping || inferenceTicking || !inferenceLane) return;
    inferenceTicking = true;
    try {
      const slots = inferenceConcurrency - inferenceInFlight.size;
      if (slots <= 0) return;
      const consumed: any = await api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/consume`, {
        maxMessages: Math.min(slots + 1, 10),
        visibilityTimeoutSeconds: leaseSeconds,
        consumer: `${consumer}-inf`,
      });
      const messages = Array.isArray(consumed?.messages) ? consumed.messages : [];
      for (const m of messages) {
        if (inferenceInFlight.size >= inferenceConcurrency) break;
        const jobId = inferenceJobIdFromMessage(m.payload);
        const receipt = String(m.receipt || '');
        if (!jobId || !receipt) {
          await api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/ack`, { receipt }).catch(() => null);
          continue;
        }
        if (inferenceInFlight.has(jobId)) {
          await api.request('POST', `/v1/queue/queues/${encodeURIComponent(inferenceQueue)}/nack`, {
            receipt, requeue: true, delaySeconds: 5,
          }).catch(() => null);
          continue;
        }
        inferenceInFlight.add(jobId);
        void runInferenceJob(jobId, receipt);
      }
    } catch (e: any) {
      errorLog('inference consume failed:', e?.message || e);
    } finally {
      inferenceTicking = false;
    }
  };

  const timers: NodeJS.Timeout[] = [];
  if (once) {
    await Promise.allSettled([tickWorkflow(), tickInference()]);
    const deadline = Date.now() + 120000;
    while ((workflowInFlight.size || inferenceInFlight.size) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    clearInterval(hbTimer);
    await heartbeat('offline').catch(() => undefined);
    return;
  }

  if (workflowLane) timers.push(setInterval(() => { void tickWorkflow(); }, pollMs));
  if (inferenceLane) timers.push(setInterval(() => { void tickInference(); }, pollMs));
  setTimeout(() => { void tickWorkflow(); void tickInference(); }, 100).unref?.();

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — draining ${workflowInFlight.size + inferenceInFlight.size} job(s)`);
    for (const t of timers) clearInterval(t);
    clearInterval(hbTimer);
    const deadline = Date.now() + 30000;
    while ((workflowInFlight.size || inferenceInFlight.size) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    await heartbeat('offline').catch(() => undefined);
    log('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

if (require.main === module) {
  main().catch((e: any) => {
    errorLog(e?.message || e);
    if (/SYNAPSEONE_API_KEY|SYNAPSEONE_URL|WORKFLOW_RUNNER_ID/.test(String(e?.message || e))) {
      errorLog('hint: copy the install command from Console → Runner Engine; it includes the correct URL and API key.');
    }
    process.exit(1);
  });
}
