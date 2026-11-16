// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Node bridge contract tests for the self-contained local inference worker.
 * A tiny Python stub speaks the frozen JSONL protocol; real model execution is
 * covered by the runtime agent's --probe evidence. No HTTP listener is used.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalInferenceWorker,
  localInferenceEnv,
  minimalWorkerEnv,
  normalizeLocalInferenceResult,
  type LocalInferenceOptions,
} from './local-inference';

const STUB = String.raw`
import json, os, sys, time

MODE = "__MODE__"
DELAY = __DELAY__
SENTINEL = "__SENTINEL__"
ENV_FILE = "__ENV_FILE__"

def cap(name, ready, model):
    return {
        "supported": True,
        "enabled": True,
        "ready": ready,
        "state": "ready" if ready else "loading",
        "model": model,
        "backend": "stub",
        "error": None,
    }

def health():
    caps = {
        "embeddings": cap("embeddings", True, "stub-minilm"),
        "decision": cap("decision", True, "stub-decision2"),
        "route": cap("route", True, "stub-decision2"),
        "chat": {
            "supported": False, "enabled": False, "ready": False,
            "state": "unsupported", "model": None, "backend": None, "error": None,
        },
    }
    return {
        "worker": "stub", "version": "0", "protocol": 1,
        "ready": True, "status": "ready",
        "readyCapabilities": ["embeddings", "decision", "route"],
        "unsupportedTypes": ["chat", "generic"],
        "capabilities": caps,
        "limits": {"maxEmbeddingInputs": 256, "maxQuestions": 64},
    }

def emit(obj):
    print(json.dumps(obj), flush=True)

def write_sentinel():
    try:
        with open(SENTINEL, "w") as handle:
            handle.write("1")
    except Exception:
        pass

if MODE == "env":
    try:
        with open(ENV_FILE, "w") as handle:
            json.dump(dict(os.environ), handle)
    except Exception:
        pass

for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    op = req.get("op")
    if MODE == "badline":
        print("this-is-not-json", flush=True)
    if op == "shutdown":
        emit({"id": rid, "ok": True, "result": {"stopping": True}})
        break
    if op == "health":
        emit({"id": rid, "ok": True, "result": health()})
        continue
    if op == "infer":
        typ = req.get("type")
        if MODE == "hang-once" and not os.path.exists(SENTINEL):
            write_sentinel()
            time.sleep(60)
            continue
        if MODE == "crash-once" and not os.path.exists(SENTINEL):
            write_sentinel()
            os._exit(9)
        if MODE == "huge":
            print("x" * 5000, flush=True)
            continue
        if MODE == "delay":
            time.sleep(DELAY)
        if MODE == "fail":
            emit({"id": rid, "ok": False, "error": {
                "code": "model_not_ready",
                "message": "stub model is not loaded",
                "retryable": True,
            }})
            continue
        reqbody = req.get("request") or {}
        if typ == "embeddings":
            texts = reqbody.get("input")
            if isinstance(texts, str):
                texts = [texts]
            emit({"id": rid, "ok": True, "result": {
                "object": "list",
                "data": [{"object": "embedding", "index": i, "embedding": [0.6, 0.8]} for i, _ in enumerate(texts or [])],
                "model": "stub-minilm",
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            }})
            continue
        if typ == "decision":
            emit({"id": rid, "ok": True, "result": {
                "model": "stub-decision2",
                "results": {"q1": {"best_choice": "yes", "probability": 0.9}},
                "duration_ms": 1.5,
            }})
            continue
        if typ == "route":
            emit({"id": rid, "ok": True, "result": {
                "best_choice": "workflow",
                "confidence": 0.9,
                "probabilities": {"workflow": 0.9, "other": 0.1},
                "model": "stub-decision2",
                "duration_ms": 2.0,
            }})
            continue
        emit({"id": rid, "ok": False, "error": {
            "code": "unsupported_type",
            "message": "type is not supported",
            "retryable": False,
            "details": {"capability": typ},
        }})
        continue
    emit({"id": rid, "ok": False, "error": {"code": "bad_request", "message": "unknown op"}})
`;

interface WorkerContext {
  worker: LocalInferenceWorker;
  dir: string;
  logs: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function makeStub(mode: string, dir: string, delayMs = 0): string {
  const sentinel = path.join(dir, 'sentinel');
  const envFile = path.join(dir, 'env.json');
  return STUB
    .replaceAll('__MODE__', mode)
    .replaceAll('__DELAY__', String(delayMs / 1000))
    .replaceAll('__SENTINEL__', sentinel)
    .replaceAll('__ENV_FILE__', envFile);
}

function createWorker(
  mode: string,
  options: Partial<LocalInferenceOptions> = {},
  stubDelayMs = 0,
): WorkerContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-local-inference-'));
  const script = path.join(dir, 'worker.py');
  fs.writeFileSync(script, makeStub(mode, dir, stubDelayMs));
  const logs: string[] = [];
  const { env: extraEnv, ...rest } = options;
  const worker = new LocalInferenceWorker({
    script,
    env: {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LOCAL_INFERENCE_THREADS: '2',
      ...(extraEnv || {}),
    },
    requestTimeoutMs: 5000,
    healthTimeoutMs: 2000,
    healthIntervalMs: 30000,
    maxRestartDelayMs: 100,
    onLog: (line) => logs.push(line),
    ...rest,
  });
  return { worker, dir, logs };
}

async function withWorker(
  mode: string,
  options: Partial<LocalInferenceOptions>,
  run: (ctx: WorkerContext & { health: any }) => Promise<void>,
  stubDelayMs = 0,
): Promise<void> {
  const ctx = createWorker(mode, options, stubDelayMs);
  try {
    const health = await ctx.worker.start();
    await run({ ...ctx, health });
  } finally {
    await ctx.worker.stop();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}

describe('local inference bridge', () => {
  it('reports per-capability readiness and no HTTP listener', async () => {
    await withWorker('ready', {}, async ({ worker, health }) => {
      assert.equal(health.ready, true);
      assert.equal(health.workerRunning, true);
      assert.equal(health.capabilities.embeddings.ready, true);
      assert.equal(health.capabilities.decision.ready, true);
      assert.equal(health.capabilities.route.ready, true);
      assert.equal(health.capabilities.chat.ready, false);
      assert.equal(health.capabilities.chat.state, 'unsupported');
      assert.equal((worker.health() as any).httpServer, undefined);
    });
  });

  it('keeps the native embeddings/decision/route result shapes', async () => {
    await withWorker('ready', {}, async ({ worker }) => {
      const emb: any = await worker.infer('embeddings', { input: ['a', 'b'] });
      assert.equal(emb.object, 'list');
      assert.equal(emb.data.length, 2);
      assert.equal(emb.data[0].index, 0);
      assert.ok(Array.isArray(emb.data[0].embedding));

      const dec: any = await worker.infer('decision', { state: 'x', questions: {} });
      assert.equal(dec.model, 'stub-decision2');
      assert.equal(typeof dec.results, 'object');
      assert.equal(typeof dec.duration_ms, 'number');

      const route: any = await worker.infer('route', {
        input: 'x',
        choices: { workflow: 'run a workflow' },
      });
      assert.equal(route.best_choice, 'workflow');
      assert.equal(typeof route.confidence, 'number');
      assert.equal(typeof route.probabilities, 'object');
      assert.equal(route.model, 'stub-decision2');
    });
  });

  it('fails closed for unsupported and worker-declared errors', async () => {
    await withWorker('ready', {}, async ({ worker }) => {
      await assert.rejects(
        () => worker.infer('chat', { messages: [{ role: 'user', content: 'hi' }] }),
        (e: any) => e?.code === 'unsupported_type',
      );
      await assert.rejects(
        () => worker.infer('generic', { path: '/x', body: {} }),
        (e: any) => e?.code === 'unsupported_type',
      );
    });

    await withWorker('fail', {}, async ({ worker }) => {
      await assert.rejects(
        () => worker.infer('embeddings', { input: 'x' }),
        (e: any) =>
          e?.code === 'model_not_ready' &&
          e?.retryable === true &&
          /not loaded/.test(String(e.message)),
      );
    });
  });

  it('normalizes only embeddings vectors and rejects malformed decision/route', () => {
    const wrapped = normalizeLocalInferenceResult('embeddings', { vectors: [[1, 0]], model: 'm' });
    assert.equal(wrapped.object, 'list');
    assert.equal(wrapped.data[0].embedding[0], 1);
    assert.throws(() => normalizeLocalInferenceResult('decision', { decision: 'yes' }), /DecisionResponse/);
    assert.throws(() => normalizeLocalInferenceResult('route', { decision: 'workflow' }), /RouteResponse/);
    assert.throws(() => normalizeLocalInferenceResult('chat', { text: 'hi' }), /choices/);
  });

  it('maps owner config to the worker env and strips legacy provider env', () => {
    const env = localInferenceEnv({
      capabilities: ['embeddings', 'decision', 'route'],
      models: { embeddings: 'mini', chat: '' },
      limits: { threads: 2, maxBatch: 4, maxTokens: 128, maxRssMb: 4096, timeoutMs: 60000 },
    }, {
      INFERENCE_RUNNER_URL: 'http://should-not-be-used',
      INFERENCE_RUNNER_API_KEY: 'provider-key',
      INFERENCE_RUNNER_MODEL: 'remote-model',
      LOCAL_INFERENCE_CHAT_MODEL: '/stale/chat',
    });
    assert.equal(env.INFERENCE_RUNNER_URL, undefined);
    assert.equal(env.INFERENCE_RUNNER_API_KEY, undefined);
    assert.equal(env.INFERENCE_RUNNER_MODEL, undefined);
    assert.equal(env.LOCAL_INFERENCE_CHAT_MODEL, undefined);
    assert.equal(env.LOCAL_INFERENCE_CAPABILITIES, 'embeddings,decision,route');
    assert.equal(env.LOCAL_INFERENCE_EMBEDDING, '1');
    assert.equal(env.LOCAL_INFERENCE_DECISION, '1');
    assert.equal(env.LOCAL_INFERENCE_MODEL_EMBEDDINGS, 'mini');
    assert.equal(env.LOCAL_INFERENCE_THREADS, '2');
    assert.equal(env.LOCAL_INFERENCE_MAX_BATCH, '4');
    assert.equal(env.LOCAL_INFERENCE_TIMEOUT_MS, '60000');
  });

  it('never passes runner/provider/platform secrets to the Python child', async () => {
    const secrets = {
      SYNAPSEONE_API_KEY: 'runner-key',
      SYNAPSEONE_INTERNAL_SECRET: 'internal',
      INFERENCE_RUNNER_API_KEY: 'provider-key',
      OPENROUTER_API_KEY: 'openrouter',
      AWS_SECRET_ACCESS_KEY: 'aws',
      HTTPS_PROXY: 'http://proxy',
      LOCAL_INFERENCE_SECRET: 'must-not-leak',
    };
    const filtered = minimalWorkerEnv({
      PATH: '/usr/bin',
      LOCAL_INFERENCE_THREADS: '2',
      ...secrets,
    });
    for (const key of Object.keys(secrets)) assert.equal(filtered[key], undefined, key);
    assert.equal(filtered.PATH, '/usr/bin');
    assert.equal(filtered.LOCAL_INFERENCE_THREADS, '2');

    await withWorker(
      'env',
      { env: { PATH: '/usr/bin', LOCAL_INFERENCE_THREADS: '2', ...secrets } },
      async ({ dir }) => {
        const envFile = path.join(dir, 'env.json');
        await waitFor(() => fs.existsSync(envFile), 2000);
        const childEnv = JSON.parse(fs.readFileSync(envFile, 'utf8')) as Record<string, string>;
        for (const key of Object.keys(secrets)) {
          assert.equal(childEnv[key], undefined, `${key} leaked into the child`);
        }
        assert.equal(childEnv.LOCAL_INFERENCE_THREADS, '2');
        assert.equal(childEnv.PYTHONUNBUFFERED, '1');
        assert.equal(childEnv.HF_HUB_OFFLINE, '1');
      },
    );
  });

  it('ignores malformed stdout frames and still resolves the response', async () => {
    await withWorker('badline', {}, async ({ worker, logs }) => {
      const result: any = await worker.infer('embeddings', { input: 'x' });
      assert.equal(result.data.length, 1);
      assert.ok(logs.some((line) => /non-JSON stdout ignored/.test(line)));
    });
  });

  it('kills a worker that emits an overlong frame instead of buffering it', async () => {
    await withWorker(
      'huge',
      { maxLineBytes: 1024, healthIntervalMs: 100, healthTimeoutMs: 500 },
      async ({ worker, logs }) => {
        await assert.rejects(
          () => worker.infer('embeddings', { input: 'x' }),
          /protocol line exceeded|protocol buffer exceeded|restarting/i,
        );
        await waitFor(() => worker.health().ready && worker.running, 5000);
        assert.ok(logs.some((line) => /exceeded 1024 bytes/.test(line)));
      },
    );
  });

  it('kills and restarts a stalled inference, then serves the next job', async () => {
    await withWorker(
      'hang-once',
      { requestTimeoutMs: 1000, healthIntervalMs: 100, healthTimeoutMs: 500, maxRestartDelayMs: 100 },
      async ({ worker }) => {
        await assert.rejects(
          () => worker.infer('embeddings', { input: 'x' }),
          (e: any) => e?.code === 'worker_timeout' && e?.retryable === true,
        );
        await waitFor(() => worker.health().ready && worker.running, 5000);
        const result: any = await worker.infer('embeddings', { input: 'y' });
        assert.equal(result.data.length, 1);
      },
    );
  });

  it('restarts after an unexpected worker exit and then serves jobs', async () => {
    await withWorker(
      'crash-once',
      { healthIntervalMs: 100, healthTimeoutMs: 500, maxRestartDelayMs: 100 },
      async ({ worker }) => {
        await assert.rejects(
          () => worker.infer('embeddings', { input: 'x' }),
          /exited/i,
        );
        await waitFor(() => worker.health().ready && worker.running, 5000);
        const result: any = await worker.infer('route', {
          input: 'x',
          choices: { workflow: 'run a workflow' },
        });
        assert.equal(result.best_choice, 'workflow');
      },
    );
  });

  it('does not mark models not-ready when health polling overlaps serial inference', async () => {
    await withWorker(
      'delay',
      {
        requestTimeoutMs: 5000,
        healthIntervalMs: 100,
        healthTimeoutMs: 50,
      },
      async ({ worker, logs }) => {
        const result: any = await worker.infer('embeddings', { input: 'slow' });
        assert.equal(result.data.length, 1);
        await waitFor(() => worker.health().ready, 3000);
        assert.equal(worker.health().ready, true);
        assert.equal(
          logs.some((line) => /health probes failed/.test(line)),
          false,
          logs.join('\n'),
        );
      },
      1500,
    );
  });
});
