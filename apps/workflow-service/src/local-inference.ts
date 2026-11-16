// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Self-contained local inference bridge for owner-scoped runners.
 *
 * The runner never calls an inference API server and never opens a listening
 * port. It spawns the bundled Python worker and exchanges one JSON object per
 * line:
 *
 *   -> {"id":"1","op":"health"}
 *   <- {"id":"1","ok":true,"result":{ready,capabilities,...}}
 *   -> {"id":"2","op":"infer","type":"embeddings","request":{...}}
 *   <- {"id":"2","ok":true,"result":{...}}
 *
 * stdout is protocol-only; worker logs go to stderr. A missing/broken model is
 * reported as not-ready and the inference lane never claims work as if it were
 * healthy. There is deliberately no deterministic/mock fallback here: the
 * owner UI must show the real model state.
 *
 * Safety properties:
 *  - stdout frames are byte-capped and parsed without readline's unbounded
 *    buffer (a broken worker cannot exhaust runner RAM);
 *  - health probes are skipped while an infer request is in flight (the worker
 *    is serial), so a slow inference cannot falsely mark models not-ready;
 *  - an infer timeout kills the worker and restarts it with backoff;
 *  - the model subprocess receives a minimal allowlisted environment, never
 *    the runner API key or platform/internal secrets.
 */
import './env-compat';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export type LocalInferenceType = 'embeddings' | 'chat' | 'decision' | 'route' | 'generic';

export interface LocalInferenceCapability {
  ready: boolean;
  model?: string;
  reason?: string;
  [key: string]: any;
}

export interface LocalInferenceHealth {
  ready: boolean;
  workerRunning: boolean;
  startedAt?: string | null;
  checkedAt?: string | null;
  lastError?: string | null;
  capabilities: Record<string, LocalInferenceCapability>;
  limits?: Record<string, any>;
  [key: string]: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  op: string;
}

export interface LocalInferenceOptions {
  script: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  maxLineBytes?: number;
  onLog?: (line: string) => void;
  onHealth?: (health: LocalInferenceHealth) => void;
  maxRestartDelayMs?: number;
}

const EMPTY_HEALTH: LocalInferenceHealth = {
  ready: false,
  workerRunning: false,
  capabilities: {},
  lastError: 'local inference worker has not started',
};

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** The model subprocess gets only model/runtime knobs. Tenant credentials,
 *  the runner API key, IAM secrets, provider keys and proxy variables never
 *  cross this boundary. */
const WORKER_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LANGUAGE', 'TZ', 'TMPDIR',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'TRANSFORMERS_CACHE', 'TORCH_HOME',
  'SYNAPSE_LOCAL_MODELS_DIR',
  'EMBEDDING_BACKEND', 'EMBEDDING_MODEL_NAME', 'EMBEDDING_ONNX_PATH', 'EMBEDDING_ONNX_FILE',
  'EMBEDDING_MAX_LENGTH', 'EMBEDDING_BATCH_SIZE', 'EMBEDDING_DIM',
  'DECISION_ENABLED', 'DECISION_BACKEND', 'DECISION_MODEL_NAME', 'DECISION_THREADS',
  'DECISION_WARMUP', 'INFERENCE_CPU_THREADS', 'INFERENCE_DEVICE',
  'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'TOKENIZERS_PARALLELISM',
  'INFERENCE_MODEL_DOWNLOAD', 'INFERENCE_MOCK_MODELS',
]);

/** Explicit LOCAL_INFERENCE_* contract.  Do not use a prefix match: an
 *  arbitrary LOCAL_INFERENCE_SECRET-style variable must not leak into Python. */
const LOCAL_INFERENCE_ENV_ALLOWLIST = new Set([
  'LOCAL_INFERENCE_CAPABILITIES',
  'LOCAL_INFERENCE_EMBEDDING',
  'LOCAL_INFERENCE_DECISION',
  'LOCAL_INFERENCE_CHAT_MODEL',
  'LOCAL_INFERENCE_MODEL_EMBEDDINGS',
  'LOCAL_INFERENCE_MODEL_DECISION',
  'LOCAL_INFERENCE_MODEL_ROUTE',
  'LOCAL_INFERENCE_MODEL_CHAT',
  'LOCAL_INFERENCE_THREADS',
  'LOCAL_INFERENCE_MAX_BATCH',
  'LOCAL_INFERENCE_MAX_TOKENS',
  'LOCAL_INFERENCE_MAX_RSS_MB',
  'LOCAL_INFERENCE_TIMEOUT_MS',
  'LOCAL_INFERENCE_MODEL_RETRY_SECONDS',
  'LOCAL_INFERENCE_MAX_LINE_BYTES',
  'LOCAL_INFERENCE_MAX_RESPONSE_BYTES',
  'LOCAL_INFERENCE_HOME',
]);

export class LocalInferenceWorker {
  private readonly opts: LocalInferenceOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private seq = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private restarts = 0;
  private healthFailures = 0;
  private activeInfer = 0;
  private inferActivity = 0;
  private restarting = false;
  private restartFallbackTimer: NodeJS.Timeout | null = null;
  private exitingChild: ChildProcessWithoutNullStreams | null = null;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private lastHealth: LocalInferenceHealth = { ...EMPTY_HEALTH };
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private intentionalExit = false;

  constructor(opts: LocalInferenceOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return !!this.child && !this.child.killed;
  }

  health(): LocalInferenceHealth {
    return { ...this.lastHealth, capabilities: { ...(this.lastHealth.capabilities || {}) } };
  }

  async start(): Promise<LocalInferenceHealth> {
    this.stopping = false;
    this.spawnWorker();
    const health = await this.requestHealth(this.opts.healthTimeoutMs || 15000).catch((e: any) => {
      this.lastError = String(e?.message || e);
      this.setHealth({ ...EMPTY_HEALTH, capabilities: this.lastHealth.capabilities, lastError: this.lastError });
      return this.health();
    });
    const interval = Math.max(100, Number(this.opts.healthIntervalMs) || 30000);
    this.healthTimer = setInterval(() => {
      if (!this.running || this.stopping) return;
      // The worker is serial: a health probe sent during a long inference
      // would queue behind it and time out, falsely marking real models
      // not-ready. Wait for the inference to finish instead.
      if (this.activeInfer > 0) return;
      const inferEpoch = this.inferActivity;
      this.requestHealth(this.opts.healthTimeoutMs || 15000).then(() => {
        this.healthFailures = 0;
      }).catch((e: any) => {
        // A probe that overlapped any inference (started or finished) may have
        // timed out behind the serial worker; do not count it as a model fault.
        if (this.activeInfer > 0 || this.inferActivity !== inferEpoch) return;
        this.healthFailures += 1;
        this.lastError = String(e?.message || e);
        if (this.healthFailures >= 3) {
          this.setHealth({ ...this.lastHealth, ready: false, lastError: this.lastError });
          this.restartWorker(`health probes failed ${this.healthFailures} times: ${this.lastError}`);
        }
      });
    }, interval);
    this.healthTimer.unref?.();
    return health;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.intentionalExit = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.restartFallbackTimer) clearTimeout(this.restartFallbackTimer);
    this.restartFallbackTimer = null;
    if (this.child && this.running) {
      // Ask the worker to stop cleanly first; SIGTERM is the fallback.
      await this.send({ op: 'shutdown' }, 2000).catch(() => undefined);
    }
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.rejectAll(new Error('local inference worker stopped'));
    this.setHealth({ ...EMPTY_HEALTH, lastError: 'worker stopped' });
  }

  /** Kill a stuck/broken worker. The exit handler restarts it with backoff. */
  private restartWorker(reason: string): void {
    if (this.stopping || this.restarting) return;
    this.restarting = true;
    this.lastError = reason;
    this.opts.onLog?.(`restarting local inference worker: ${reason}`);
    this.rejectAll(new Error(reason));
    this.stdoutBuffer = Buffer.alloc(0);
    const child = this.child;
    this.child = null;
    this.exitingChild = child;
    this.setHealth({ ...EMPTY_HEALTH, lastError: reason });
    if (!child) {
      this.restarting = false;
      this.scheduleRestart();
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch { /* already dead */ }
    // Normal path: the child 'exit' handler schedules the restart. Add a
    // bounded fallback for the rare case where 'exit' never fires.
    if (this.restartFallbackTimer) clearTimeout(this.restartFallbackTimer);
    this.restartFallbackTimer = setTimeout(() => {
      this.restartFallbackTimer = null;
      if (this.stopping || this.child || this.restartTimer) return;
      this.restarting = false;
      this.scheduleRestart();
    }, 5000);
    this.restartFallbackTimer.unref?.();
  }

  /** Start worker with exponential backoff after an unexpected exit. */
  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restarts += 1;
    const cap = Math.max(50, Number(this.opts.maxRestartDelayMs) || 30000);
    const delay = Math.min(cap, 1000 * 2 ** Math.min(this.restarts - 1, 5));
    this.opts.onLog?.(`local inference worker exited; restarting in ${delay}ms (restart #${this.restarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnWorker();
    }, delay);
    this.restartTimer.unref?.();
  }

  private spawnWorker(): void {
    if (this.stopping) return;
    this.intentionalExit = false;
    this.restarting = false;
    this.healthFailures = 0;
    this.exitingChild = null;
    if (this.restartFallbackTimer) clearTimeout(this.restartFallbackTimer);
    this.restartFallbackTimer = null;
    this.stdoutBuffer = Buffer.alloc(0);
    try {
      const child = spawn('python3', [this.opts.script], {
        cwd: this.opts.cwd,
        env: minimalWorkerEnv(this.opts.env || {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      this.startedAt = new Date().toISOString();
      this.stdoutBuffer = Buffer.alloc(0);
      child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
      child.stderr.on('data', (chunk) => {
        const text = String(chunk || '').trimEnd();
        if (text) this.opts.onLog?.(text);
      });
      child.on('error', (error) => {
        if (this.child && this.child !== child) return;
        this.lastError = `local inference worker spawn failed: ${error.message}`;
        this.opts.onLog?.(this.lastError);
        this.setHealth({ ...EMPTY_HEALTH, lastError: this.lastError });
      });
      child.on('exit', (code, signal) => {
        // A late exit from a killed/replaced child must never clobber a newer
        // worker (or schedule a duplicate restart). A child we just killed via
        // restartWorker is tracked separately because this.child is already null.
        if (this.child && this.child !== child) {
          this.opts.onLog?.(`ignoring late exit from a replaced local inference worker (code=${code ?? '-'} signal=${signal || '-'})`);
          return;
        }
        if (this.exitingChild === child) this.exitingChild = null;
        this.child = null;
        this.stdoutBuffer = Buffer.alloc(0);
        this.restarting = false;
        if (this.restartFallbackTimer) clearTimeout(this.restartFallbackTimer);
        this.restartFallbackTimer = null;
        const why = `local inference worker exited (code=${code ?? '-'} signal=${signal || '-'})`;
        this.lastError = why;
        this.opts.onLog?.(why);
        this.rejectAll(new Error(why));
        this.setHealth({ ...EMPTY_HEALTH, lastError: why });
        if (!this.stopping && !this.intentionalExit) this.scheduleRestart();
      });
      this.opts.onLog?.(`local inference worker started pid=${child.pid} script=${this.opts.script}`);
    } catch (e: any) {
      this.lastError = `local inference worker start failed: ${String(e?.message || e)}`;
      this.opts.onLog?.(this.lastError);
      this.setHealth({ ...EMPTY_HEALTH, lastError: this.lastError });
      this.scheduleRestart();
    }
  }

  /** Byte-capped newline framing. Never rely on readline for hostile output. */
  private onStdout(chunk: Buffer): void {
    const max = Math.max(1024, Number(this.opts.maxLineBytes) || DEFAULT_MAX_LINE_BYTES);
    if (!chunk || !chunk.length) return;
    this.stdoutBuffer = this.stdoutBuffer.length
      ? Buffer.concat([this.stdoutBuffer, chunk])
      : Buffer.from(chunk);

    // Parse every complete frame in this chunk first. A large *batch* of small
    // frames must not be mistaken for one oversized frame.
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.length > max) {
        this.restartWorker(`local inference protocol line exceeded ${max} bytes`);
        return;
      }
      const line = frame.toString('utf8').trim();
      if (line) this.onLine(line);
      newline = this.stdoutBuffer.indexOf(0x0a);
    }

    // An incomplete frame that is already over the limit can never become valid.
    if (this.stdoutBuffer.length > max) {
      this.restartWorker(`local inference protocol buffer exceeded ${max} bytes`);
    }
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.opts.onLog?.(`local inference protocol: non-JSON stdout ignored: ${line.slice(0, 300)}`);
      return;
    }
    const id = String(message?.id || '');
    const pending = this.pending.get(id);
    if (!pending) {
      this.opts.onLog?.(`local inference protocol: response for unknown id '${id}' ignored`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      const error = message.error && typeof message.error === 'object'
        ? new Error(String(message.error.message || message.error.code || 'local inference failed'))
        : new Error(String(message.error || 'local inference failed'));
      (error as any).code = message.error?.code;
      (error as any).retryable = message.error?.retryable;
      (error as any).detail = message.error;
      pending.reject(error);
    }
  }

  private setHealth(health: LocalInferenceHealth): void {
    this.lastHealth = {
      ...health,
      workerRunning: this.running,
      startedAt: this.startedAt,
      checkedAt: new Date().toISOString(),
      restarts: this.restarts,
    };
    this.opts.onHealth?.(this.health());
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(payload: Record<string, any>, timeoutMs: number): Promise<any> {
    if (!this.child || !this.running) {
      return Promise.reject(new Error('local inference worker is not running'));
    }
    const id = String(++this.seq);
    const op = String(payload.op || '');
    const body = `${JSON.stringify({ ...payload, id })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error: any = new Error(`local inference worker timed out after ${timeoutMs}ms (op=${op})`);
        error.code = 'worker_timeout';
        error.retryable = true;
        if (op === 'infer') {
          // A stuck Python inference would block the serial worker forever.
          this.restartWorker(`infer timed out after ${timeoutMs}ms`);
        }
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, startedAt: Date.now(), op });
      this.child!.stdin.write(body, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`local inference worker write failed: ${error.message}`));
      });
    });
  }

  private async requestHealth(timeoutMs: number): Promise<LocalInferenceHealth> {
    const result = await this.send({ op: 'health' }, timeoutMs);
    const health: LocalInferenceHealth = {
      ready: result?.ready === true,
      workerRunning: this.running,
      startedAt: this.startedAt,
      checkedAt: new Date().toISOString(),
      lastError: result?.lastError || null,
      capabilities: result?.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {},
      limits: result?.limits && typeof result.limits === 'object' ? result.limits : {},
      ...(result && typeof result === 'object' ? result : {}),
    };
    // A worker may claim ready while advertising zero ready capabilities. That
    // is not useful compute; keep it not-ready so the lane never claims work.
    const anyReady = Object.values(health.capabilities).some((cap) => cap && (cap as any).ready === true);
    if (!health.ready || !anyReady) health.ready = false;
    this.lastError = health.lastError ? String(health.lastError) : null;
    this.setHealth(health);
    return this.health();
  }

  async infer(type: string, request: any, timeoutMs?: number): Promise<any> {
    const health = this.lastHealth;
    const capability = health.capabilities?.[type];
    if (type !== 'generic' && (!capability || capability.ready !== true)) {
      const reason = capability?.reason || health.lastError || 'capability is not loaded';
      const error = new Error(`local inference capability '${type}' is not ready: ${reason}`);
      (error as any).code = 'unsupported_type';
      throw error;
    }
    this.activeInfer += 1;
    this.inferActivity += 1;
    try {
      const result = await this.send(
        { op: 'infer', type, request },
        Math.min(Math.max(Number(timeoutMs) || this.opts.requestTimeoutMs || 120000, 1000), 300000),
      );
      return normalizeLocalInferenceResult(type, result);
    } finally {
      this.activeInfer = Math.max(0, this.activeInfer - 1);
      this.inferActivity += 1;
    }
  }
}

/** Validate/normalize the worker result against the existing inference API
 *  shapes. Decision/route must keep the native DecisionResponse/RouteResponse
 *  fields; embeddings may be returned as `vectors` and are wrapped into the
 *  OpenAI-compatible `data[]` shape used by the job API. */
export function normalizeLocalInferenceResult(type: string, result: any): any {
  if (type === 'embeddings') {
    if (result && Array.isArray(result.data)) return result;
    if (result && Array.isArray(result.vectors)) {
      return {
        object: 'list',
        data: result.vectors.map((embedding: number[], index: number) => ({
          object: 'embedding',
          index,
          embedding,
        })),
        model: String(result.model || 'local-embeddings'),
        usage: result.usage && typeof result.usage === 'object'
          ? result.usage
          : { prompt_tokens: 0, total_tokens: 0 },
      };
    }
    throw Object.assign(new Error('local embeddings result must contain data[] or vectors[]'), { code: 'invalid_result' });
  }
  if (type === 'decision') {
    if (!result || !result.results || typeof result.results !== 'object') {
      throw Object.assign(new Error('local decision result must use DecisionResponse {model, results, duration_ms}'), { code: 'invalid_result' });
    }
    if (typeof result.model !== 'string' || !result.model) {
      throw Object.assign(new Error('local decision result is missing model'), { code: 'invalid_result' });
    }
    return result;
  }
  if (type === 'route') {
    if (!result || typeof result.best_choice !== 'string' || typeof result.confidence !== 'number') {
      throw Object.assign(new Error('local route result must use RouteResponse {best_choice, confidence, probabilities, model, duration_ms}'), { code: 'invalid_result' });
    }
    if (!result.probabilities || typeof result.probabilities !== 'object') {
      throw Object.assign(new Error('local route result is missing probabilities'), { code: 'invalid_result' });
    }
    return result;
  }
  if (type === 'chat') {
    if (!result || !Array.isArray(result.choices)) {
      throw Object.assign(new Error('local chat result must use OpenAI-compatible choices[]'), { code: 'invalid_result' });
    }
    return result;
  }
  return result;
}

/** Minimal environment for the Python model process: no runner API key, no
 *  platform/internal secret, no provider credentials, no proxy variables. */
export function minimalWorkerEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (WORKER_ENV_ALLOWLIST.has(key) || LOCAL_INFERENCE_ENV_ALLOWLIST.has(key)) {
      env[key] = value;
    }
  }
  // Keep process lookup working when the caller supplies a minimal env object.
  if (!env.PATH) {
    env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  }
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.HF_HUB_OFFLINE = '1';
  env.TRANSFORMERS_OFFLINE = '1';
  env.INFERENCE_MODEL_DOWNLOAD = '0';
  env.INFERENCE_MOCK_MODELS = '0';
  return env;
}

/** Map server-managed inference config onto the worker's env contract. The
 *  worker reads LOCAL_INFERENCE_* variables; the runner re-applies them when
 *  the owner changes the config in the UI. */
export function localInferenceEnv(config: any, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = minimalWorkerEnv(extra);
  if (!config || typeof config !== 'object') return env;
  const capabilities = Array.isArray(config.capabilities) && config.capabilities.length
    ? config.capabilities.map(String)
    : ['embeddings', 'decision', 'route'];
  env.LOCAL_INFERENCE_CAPABILITIES = capabilities.join(',');
  env.LOCAL_INFERENCE_EMBEDDING = capabilities.includes('embeddings') ? '1' : '0';
  env.LOCAL_INFERENCE_DECISION = capabilities.includes('decision') || capabilities.includes('route') ? '1' : '0';
  if (!capabilities.includes('chat')) {
    delete env.LOCAL_INFERENCE_CHAT_MODEL;
    delete env.LOCAL_INFERENCE_MODEL_CHAT;
  }
  if (config.models && typeof config.models === 'object') {
    for (const [key, value] of Object.entries(config.models)) {
      if (!value || !/^(embeddings|chat|decision|route)$/.test(key)) continue;
      env[`LOCAL_INFERENCE_MODEL_${key.toUpperCase()}`] = String(value);
    }
  }
  if (config.limits && typeof config.limits === 'object') {
    const map: Record<string, string> = {
      threads: 'LOCAL_INFERENCE_THREADS',
      maxBatch: 'LOCAL_INFERENCE_MAX_BATCH',
      maxTokens: 'LOCAL_INFERENCE_MAX_TOKENS',
      maxRssMb: 'LOCAL_INFERENCE_MAX_RSS_MB',
      timeoutMs: 'LOCAL_INFERENCE_TIMEOUT_MS',
    };
    for (const [key, name] of Object.entries(map)) {
      const value = (config.limits as any)[key];
      if (value !== undefined && value !== null && value !== '') env[name] = String(value);
    }
  }
  return env;
}
