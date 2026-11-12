// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * Self-hosted SynapseFlow runner.
 *
 * Deploy this image in your own infrastructure, give it a scoped SynapseOne
 * API key, and it will consume its workflow queue through the public gateway,
 * execute DAGs locally (same engine as the platform), and report results back.
 *
 * Required env:
 *   SYNAPSEONE_URL          public gateway URL (https://api.synapseone.space)
 *   SYNAPSEONE_API_KEY      scoped API key minted for this runner
 *   WORKFLOW_RUNNER_ID      runner id from the console/API
 * Optional:
 *   WORKFLOW_RUNNER_QUEUE   queue override (default: server config)
 *   WORKFLOW_RUNNER_CONCURRENCY, WORKFLOW_RUNNER_POLL_MS,
 *   WORKFLOW_RUNNER_LEASE_SECONDS, WORKFLOW_RUNNER_ONCE
 */
import './env-compat';
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
  mode: 'custom' | 'hybrid';
  queue: string;
  heartbeatIntervalSeconds: number;
  visibilityTimeoutSeconds: number;
}

interface ClaimedJob {
  executionId: string;
  workflow: { id: string; name: string; nodes: any[]; connections: Record<string, any>; settings: Record<string, any>; revision?: number };
  input: any;
  principal: Principal | null;
  triggeredBy: string;
  attempt?: number;
  leaseExpiresAt?: string;
  resumeFrom?: { node: string; output: any } | null;
}

function executionIdFromMessage(payload: any): string | null {
  if (!payload || typeof payload !== 'object' || payload.kind !== 'workflow.run') return null;
  const id = String(payload.executionId || '');
  return id && id.length <= 128 && !/[\r\n]/.test(id) ? id : null;
}

async function main(): Promise<void> {
  const baseUrl = String(process.env.SYNAPSEONE_URL || '').trim();
  const apiKey = String(process.env.SYNAPSEONE_API_KEY || '').trim();
  const runnerId = String(process.env.WORKFLOW_RUNNER_ID || '').trim();
  if (!baseUrl) throw new Error('SYNAPSEONE_URL is required');
  if (!apiKey) throw new Error('SYNAPSEONE_API_KEY is required');
  if (!runnerId) throw new Error('WORKFLOW_RUNNER_ID is required (create a runner in the console)');

  const concurrency = intEnv('WORKFLOW_RUNNER_CONCURRENCY', 1, 1, 32);
  const pollMs = intEnv('WORKFLOW_RUNNER_POLL_MS', 1000, 200, 30000);
  const leaseSeconds = intEnv('WORKFLOW_RUNNER_LEASE_SECONDS', 300, 30, 3600);
  const heartbeatSeconds = intEnv('WORKFLOW_RUNNER_HEARTBEAT_SECONDS', 15, 5, 300);
  const once = String(process.env.WORKFLOW_RUNNER_ONCE || '').toLowerCase() === '1'
    || String(process.env.WORKFLOW_RUNNER_ONCE || '').toLowerCase() === 'true';

  const api = createRunnerApi({ baseUrl, apiKey, runnerId, timeoutMs: 60000 });
  const config: RunnerConfig = await api.request('GET', `/v1/workflow-runners/${encodeURIComponent(runnerId)}/config`);
  if (!config || !config.queue) throw new Error('runner config did not return a queue');
  if (process.env.WORKFLOW_RUNNER_QUEUE && process.env.WORKFLOW_RUNNER_QUEUE !== config.queue) {
    log(`warning: WORKFLOW_RUNNER_QUEUE=${process.env.WORKFLOW_RUNNER_QUEUE} differs from server queue '${config.queue}' — using the server value`);
  }
  const queue = config.queue;
  const consumer = `runner-${runnerId}`;
  log(`starting id=${runnerId} queue=${queue} mode=${config.mode} concurrency=${concurrency} version=${VERSION}`);

  let stopping = false;
  let ticking = false;
  const inFlight = new Set<string>();

  const heartbeat = async (): Promise<void> => {
    try {
      await api.request('POST', `/v1/workflow-runners/${encodeURIComponent(runnerId)}/heartbeat`, {
        version: VERSION,
        status: 'connected',
        metadata: { queues: [queue], concurrency, once },
      });
    } catch (e: any) {
      errorLog('heartbeat failed:', e?.message || e);
    }
  };
  await heartbeat();
  const hbTimer = setInterval(() => { void heartbeat(); }, heartbeatSeconds * 1000);
  hbTimer.unref?.();

  const runJob = async (executionId: string, receipt: string): Promise<void> => {
    let job: ClaimedJob | null = null;
    let hb: NodeJS.Timeout | null = null;
    try {
      job = await api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/claim`, {
        runnerId,
        leaseSeconds,
      });
      if (!job) throw new Error('claim returned an empty job');
      const claimed = job;
      hb = setInterval(() => {
        Promise.all([
          api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/heartbeat`, { runnerId, leaseSeconds }).catch(() => null),
          api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/heartbeat`, {
            receipt, visibilityTimeoutSeconds: leaseSeconds,
          }).catch(() => null),
        ]).catch(() => undefined);
      }, Math.max(5, Math.floor(leaseSeconds / 3)) * 1000);
      hb.unref?.();

      const synapseoneCall = createRemoteSynapseOneCall(api);
      const credentialResolver = createRemoteCredentialResolver(api, executionId, runnerId);
      log(`run execution=${executionId} workflow=${claimed.workflow.id} trigger=${claimed.triggeredBy}`);
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
        status: result.status,
        output: result.output,
        nodeRuns: result.nodeRuns,
        error: (result as any).error ?? null,
        ...(result.status === 'paused' ? { pause: (result as any).pause } : {}),
      });
      await api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/ack`, { receipt });
      log(`done execution=${executionId} status=${result.status}`);
    } catch (e: any) {
      if (e instanceof RunnerHttpError && (e.status === 404 || e.status === 409 || e.status === 403)) {
        // Not claimable (already finished/claimed by another worker), wrong
        // runner mode/queue, or the workflow was deleted. Acking prevents a
        // poison-message loop.
        await api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/ack`, { receipt }).catch(() => null);
        log(`skip execution=${executionId}: ${e.status}`);
        return;
      }
      errorLog(`execution ${executionId} failed:`, e?.message || e);
      await api.request('POST', `/v1/runner/jobs/${encodeURIComponent(executionId)}/release`, {
        runnerId, error: String(e?.message || e).slice(0, 1000),
      }).catch(() => null);
      await api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/nack`, {
        receipt, requeue: true, delaySeconds: 10, error: String(e?.message || e).slice(0, 1024),
      }).catch(() => null);
    } finally {
      if (hb) clearInterval(hb);
      inFlight.delete(executionId);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping || ticking) return;
    ticking = true;
    try {
      const slots = concurrency - inFlight.size;
      if (slots <= 0) return;
      let consumed: any;
      try {
        consumed = await api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/consume`, {
          maxMessages: Math.min(slots + 1, 10),
          visibilityTimeoutSeconds: leaseSeconds,
          consumer,
        });
      } catch (e: any) {
        errorLog('consume failed:', e?.message || e);
        return;
      }
      const messages = Array.isArray(consumed?.messages) ? consumed.messages : [];
      for (const m of messages) {
        if (inFlight.size >= concurrency) break;
        const executionId = executionIdFromMessage(m.payload);
        const receipt = String(m.receipt || '');
        if (!executionId || !receipt) {
          await api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/ack`, { receipt }).catch(() => null);
          continue;
        }
        if (inFlight.has(executionId)) {
          await api.request('POST', `/v1/queue/queues/${encodeURIComponent(queue)}/nack`, {
            receipt, requeue: true, delaySeconds: 5,
          }).catch(() => null);
          continue;
        }
        inFlight.add(executionId);
        void runJob(executionId, receipt);
      }
    } finally {
      ticking = false;
    }
  };

  if (once) {
    await tick();
    const deadline = Date.now() + 120000;
    while (inFlight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    clearInterval(hbTimer);
    await heartbeat().catch(() => undefined);
    return;
  }

  const timer = setInterval(() => { void tick(); }, pollMs);
  timer.unref?.();
  setTimeout(() => { void tick(); }, 100).unref?.();

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — draining ${inFlight.size} job(s)`);
    clearInterval(timer);
    clearInterval(hbTimer);
    const deadline = Date.now() + 30000;
    while (inFlight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    log('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

if (require.main === module) {
  main().catch((e: any) => {
    errorLog(e?.message || e);
    process.exit(1);
  });
}
