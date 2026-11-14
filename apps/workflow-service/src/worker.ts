// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * Built-in platform workflow worker.
 *
 * The same transport contract as a self-hosted runner: consume SynapseQueue,
 * claim the execution, run the DAG, report the result, ack. The only
 * difference is that this worker runs inside workflow-service and talks to
 * Postgres directly instead of going through the public runner API.
 */
import './env-compat';
import { randomUUID } from 'crypto';
import { runWorkflow } from './engine';
import type { CredentialResolver, SynapseOneCall } from './engine';
import {
  claimExecutionRec, createHumanTaskRec, finishExecutionRec, getWorkflowRec,
  heartbeatExecutionRec, listRunnableExecutions, pauseExecutionRec, releaseExecutionRec,
  toPublicHumanTask,
} from './store';
import type { Principal, StoredExecution } from './store';
import {
  ackWorkflowRun, consumeWorkflowRuns, heartbeatWorkflowRun, nackWorkflowRun,
  queueTenantKey, queueVisibilitySeconds,
} from './queue';

export interface PlatformWorkerDeps {
  synapseoneCall: SynapseOneCall;
  makeCredentialResolver: (p: Principal | null | undefined) => CredentialResolver;
  recordRun?: (triggeredBy: string, status: string, nodeRuns?: Array<{ status: string }>) => void;
}

interface WorkerTarget {
  queue: string;
  principal: Principal | null;
  key: string;
}

const WORKER_ID = `platform-${process.pid}-${randomUUID().slice(0, 8)}`;

function targetKey(queue: string, p: Principal | null): string {
  return `${queue}\u0000${queueTenantKey(p)}`;
}

/** Pull the execution id out of a workflow queue message. Foreign messages are
 *  ignored (and acked) rather than crashing a worker. */
export function executionIdFromMessage(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.kind !== 'workflow.run') return null;
  const id = String(payload.executionId || '');
  return id && id.length <= 128 && !/[\r\n]/.test(id) ? id : null;
}

function groupTargets(execs: StoredExecution[]): WorkerTarget[] {
  const map = new Map<string, WorkerTarget>();
  for (const e of execs) {
    const queue = String(e.queue_name || '');
    if (!queue) continue;
    const p = (e.principal || null) as Principal | null;
    const key = targetKey(queue, p);
    if (!map.has(key)) map.set(key, { queue, principal: p, key });
  }
  return [...map.values()];
}

async function runClaimed(
  claimed: StoredExecution,
  deps: PlatformWorkerDeps,
  stopHeartbeat: () => void,
): Promise<void> {
  const wf = await getWorkflowRec(claimed.workflow_id);
  if (!wf) {
    await finishExecutionRec(claimed.id, {
      status: 'error',
      output: null,
      node_runs: [],
      error: `workflow '${claimed.workflow_id}' no longer exists`,
      finishedAt: new Date().toISOString(),
      workerId: WORKER_ID,
      allowedStatuses: ['running'],
    });
    return;
  }
  // The graph was approved when this execution was queued. Editing the
  // workflow while it waits must not cause the worker to run a different graph.
  if (claimed.workflow_revision != null && claimed.workflow_revision !== wf.revision) {
    await finishExecutionRec(claimed.id, {
      status: 'error', output: null, node_runs: [],
      error: 'workflow revision changed after this execution was queued; submit a new execution',
      finishedAt: new Date().toISOString(), workerId: WORKER_ID, allowedStatuses: ['running'],
    });
    return;
  }
  const executionId = claimed.id;
  const principal = (claimed.principal || null) as Principal | null;
  const runPrincipal = principal || {
    sub: String(wf.owner_sub || wf.run_as || 'workflow'),
    org: wf.org_id || undefined,
    account: wf.account_id || undefined,
    kind: 'workflow',
  };
  let result: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    result = await runWorkflow(
      { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
      claimed.input,
      {
        triggeredBy: claimed.triggered_by,
        principal: runPrincipal,
        credentialResolver: deps.makeCredentialResolver(runPrincipal),
        synapseoneCall: deps.synapseoneCall,
        resumeFrom: claimed.resume_node ? { node: claimed.resume_node, output: claimed.resume_output } : undefined,
        humanTask: {
          create: async (task) => {
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
        },
      },
    );
  } finally {
    stopHeartbeat();
  }
  const finishedAt = new Date().toISOString();
  const mergedRuns = claimed.resume_node
    ? [...(claimed.node_runs || []), ...(result.nodeRuns || [])]
    : result.nodeRuns;
  deps.recordRun?.(claimed.triggered_by || 'manual', result.status, result.nodeRuns);
  if (result.status === 'paused') {
    await pauseExecutionRec(executionId, {
      output: result.output,
      node_runs: mergedRuns as any,
      error: result.error ?? null,
      workerId: WORKER_ID,
    });
    return;
  }
  await finishExecutionRec(executionId, {
    status: result.status === 'success' ? 'success' : 'error',
    output: result.output,
    node_runs: mergedRuns as any,
    error: result.error ?? null,
    finishedAt,
    workerId: WORKER_ID,
    allowedStatuses: ['running'],
  });
}

export function startPlatformWorker(deps: PlatformWorkerDeps): { stop: () => void; tick: () => Promise<void> } {
  const everyMs = Math.min(Math.max(Number(process.env.WORKFLOW_WORKER_POLL_MS || 500), 100), 10000);
  const concurrency = Math.min(Math.max(Number(process.env.WORKFLOW_WORKER_CONCURRENCY || 4), 1), 32);
  const leaseSeconds = queueVisibilitySeconds();
  const consumer = `workflow-${WORKER_ID}`;
  const inFlight = new Set<string>();
  let running = true;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (!running || ticking) return;
    ticking = true;
    try {
      const slots = concurrency - inFlight.size;
      if (slots <= 0) return;
      const runnable = await listRunnableExecutions(200);
      if (!runnable.length) return;
      const targets = groupTargets(runnable);
      for (const target of targets) {
        const free = concurrency - inFlight.size;
        if (free <= 0) break;
        let messages: Awaited<ReturnType<typeof consumeWorkflowRuns>>;
        try {
          messages = await consumeWorkflowRuns(target.queue, target.principal, {
            maxMessages: Math.min(free + 2, 10),
            visibilityTimeoutSeconds: leaseSeconds,
            consumer,
          });
        } catch (e: any) {
          console.error(`[workflow][worker] consume ${target.queue} failed:`, e?.message || e);
          continue;
        }
        for (const msg of messages) {
          const executionId = executionIdFromMessage(msg.payload);
          if (process.env.WORKFLOW_WORKER_DEBUG === '1') console.log(`[workflow][worker] consume ${target.queue} msg=${msg.id} exec=${executionId} inflight=${executionId ? inFlight.has(executionId) : '-'}`);
          if (!executionId) {
            await ackWorkflowRun(target.queue, target.principal, msg.receipt).catch(() => undefined);
            continue;
          }
          if (inFlight.size >= concurrency || inFlight.has(executionId)) {
            await nackWorkflowRun(target.queue, target.principal, msg.receipt, { delaySeconds: 5 }).catch(() => undefined);
            continue;
          }
          inFlight.add(executionId);
          void (async () => {
            let hb: NodeJS.Timeout | null = null;
            try {
              const claimed = await claimExecutionRec(executionId, { workerId: WORKER_ID, leaseSeconds });
              if (process.env.WORKFLOW_WORKER_DEBUG === '1') console.log(`[workflow][worker] claim ${executionId} -> ${claimed ? claimed.status : 'null'}`);
              if (!claimed) {
                await ackWorkflowRun(target.queue, target.principal, msg.receipt);
                return;
              }
              hb = setInterval(() => {
                Promise.all([
                  heartbeatExecutionRec(executionId, { workerId: WORKER_ID, leaseSeconds }).catch(() => null),
                  heartbeatWorkflowRun(target.queue, target.principal, msg.receipt, leaseSeconds).catch(() => undefined),
                ]).catch(() => undefined);
              }, Math.max(10, Math.floor(leaseSeconds / 3)) * 1000);
              hb.unref?.();
              await runClaimed(claimed, deps, () => { if (hb) { clearInterval(hb); hb = null; } });
              await ackWorkflowRun(target.queue, target.principal, msg.receipt);
            } catch (e: any) {
              console.error(`[workflow][worker] execution ${executionId} failed:`, e?.message || e);
              await releaseExecutionRec(executionId, { workerId: WORKER_ID, error: e?.message || String(e) }).catch(() => null);
              await nackWorkflowRun(target.queue, target.principal, msg.receipt, {
                delaySeconds: 10,
                error: e?.message || String(e),
              }).catch(() => undefined);
            } finally {
              if (hb) clearInterval(hb);
              inFlight.delete(executionId);
            }
          })();
        }
      }
    } catch (e: any) {
      console.error('[workflow][worker] tick failed:', e?.message || e);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, everyMs);
  timer.unref?.();
  setTimeout(() => { void tick(); }, Math.min(everyMs, 1000)).unref?.();

  return {
    tick,
    stop: () => { running = false; clearInterval(timer); },
  };
}

export function platformWorkerId(): string {
  return WORKER_ID;
}
