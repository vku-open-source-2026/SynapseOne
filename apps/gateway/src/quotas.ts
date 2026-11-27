// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// TypeScript behavioural reference for the Rust gateway quota client.

export const QUOTA_SERVICES = ['ai', 'inference', 'workflow'] as const;
export type QuotaService = (typeof QUOTA_SERVICES)[number];

export interface EffectiveQuota {
  service: QuotaService;
  orgId: string;
  requestsPerMin: number;
  requestsPer5h: number;
  requestsPerDay: number;
  tokensPerDay: number | null;
  executionsPerHour: number | null;
  concurrentExecutions: number | null;
  overridden: boolean;
}

export interface QuotaLookup {
  quota: EffectiveQuota;
  authoritative: boolean;
}

export interface QuotaCheckResult {
  allowed: boolean;
  window: 'minute' | 'fiveHour' | 'day';
  count: number;
  limit: number;
  retryAfterSeconds: number;
  resetAt?: string;
}

export interface ExecutionAdmissionResult {
  allowed: boolean;
  window: 'hour' | 'concurrent';
  count: number;
  limit: number;
  retryAfterSeconds: number;
  resetAt?: string | null;
  token: string | null;
}

export function quotaServiceForRoute(path: string): QuotaService | null {
  if (path === '/v1/ai' || path.startsWith('/v1/ai/')) return 'ai';
  if (path === '/v1/inference' || path.startsWith('/v1/inference/')) return 'inference';
  for (const prefix of ['/v1/workflows', '/v1/templates', '/v1/human-tasks', '/v1/executions', '/v1/credentials', '/v1/inference-jobs', '/v1/secrets', '/mcp']) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return 'workflow';
  }
  if (path.startsWith('/v1/accounts/') && (path.endsWith('/credentials') || path.includes('/credentials/'))) return 'workflow';
  return null;
}

export function consumesWorkflowExecution(method: string, path: string): boolean {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  if (path === '/v1/inference-jobs' || path === '/v1/workflows/test-run') return true;
  return /^\/v1\/workflows\/[^/]+\/(execute|test-run)$/.test(path);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function serviceDefaults(prefix: string, fallbackRpm: number, legacyRpm?: string) {
  const requestsPerMin = intEnv(
    `${prefix}_QUOTA_REQUESTS_PER_MIN`,
    legacyRpm ? intEnv(legacyRpm, fallbackRpm, 1, 100_000) : fallbackRpm,
    1,
    100_000,
  );
  return {
    requestsPerMin,
    requestsPer5h: intEnv(`${prefix}_QUOTA_REQUESTS_PER_5H`, requestsPerMin * 300, 1, 1_000_000_000),
    requestsPerDay: intEnv(`${prefix}_QUOTA_REQUESTS_PER_DAY`, requestsPerMin * 1_440, 1, 1_000_000_000),
    tokensPerDay: null as number | null,
    executionsPerHour: null as number | null,
    concurrentExecutions: null as number | null,
  };
}

export function gatewayQuotaDefaults(): Record<QuotaService, Omit<EffectiveQuota, 'service' | 'orgId' | 'overridden'>> {
  const ai = serviceDefaults('AI', 30, 'AI_RATE_LIMIT');
  ai.tokensPerDay = intEnv('AI_QUOTA_TOKENS_PER_DAY', 1_000_000, 1, 1_000_000_000);
  const inference = serviceDefaults('INFERENCE', 60, 'INFERENCE_RATE_LIMIT_PER_MIN');
  inference.tokensPerDay = intEnv('INFERENCE_QUOTA_TOKENS_PER_DAY', 1_000_000, 1, 1_000_000_000);
  const workflow = serviceDefaults('WORKFLOW', 120);
  workflow.executionsPerHour = intEnv('WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR', 1_000, 1, 1_000_000);
  workflow.concurrentExecutions = intEnv('WORKFLOW_QUOTA_CONCURRENT', 10, 1, 1_000);
  return { ai, inference, workflow };
}

function positive(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function nullablePositive(value: unknown, max: number): number | null | undefined {
  if (value == null) return null;
  return positive(value, max) ? value : undefined;
}

function parseQuota(service: QuotaService, orgId: string, body: any): EffectiveQuota | null {
  if (!body || !positive(body.requestsPerMin, 100_000)
    || !positive(body.requestsPer5h, 1_000_000_000)
    || !positive(body.requestsPerDay, 1_000_000_000)) return null;
  const tokensPerDay = nullablePositive(body.tokensPerDay, 1_000_000_000);
  const executionsPerHour = nullablePositive(body.executionsPerHour, 1_000_000);
  const concurrentExecutions = nullablePositive(body.concurrentExecutions, 1_000);
  if (tokensPerDay === undefined || executionsPerHour === undefined || concurrentExecutions === undefined) return null;
  return {
    service,
    orgId,
    requestsPerMin: body.requestsPerMin,
    requestsPer5h: body.requestsPer5h,
    requestsPerDay: body.requestsPerDay,
    tokensPerDay,
    executionsPerHour,
    concurrentExecutions,
    overridden: body.overridden === true,
  };
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class QuotaManager {
  private readonly quotaCache = new Map<string, { quota: EffectiveQuota; at: number }>();
  private readonly meterCache = new Map<string, { meter: any; at: number }>();

  constructor(
    private readonly iamBase: string,
    private readonly internalSecret: string,
    private readonly ttlMs: number,
    private readonly defaults: Record<QuotaService, Omit<EffectiveQuota, 'service' | 'orgId' | 'overridden'>>,
  ) {}

  private headers(): Record<string, string> {
    return this.internalSecret ? { 'x-synapseone-internal': this.internalSecret } : {};
  }

  defaultFor(service: QuotaService): EffectiveQuota {
    return { service, orgId: '', overridden: false, ...this.defaults[service] };
  }

  async effective(orgId: string, service: QuotaService): Promise<QuotaLookup> {
    const key = `${service}:${orgId}`;
    const hit = this.quotaCache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return { quota: hit.quota, authoritative: true };
    const body = await fetchJson(`${this.iamBase}/internal/quotas?orgId=${encodeURIComponent(orgId)}&service=${service}`, { headers: this.headers() });
    const quota = parseQuota(service, orgId, body);
    if (!quota) return { quota: this.defaultFor(service), authoritative: false };
    if (this.quotaCache.size > 10_000) this.quotaCache.clear();
    this.quotaCache.set(key, { quota, at: Date.now() });
    return { quota, authoritative: true };
  }

  async check(subject: string, quota: EffectiveQuota): Promise<QuotaCheckResult | null> {
    const body = await fetchJson(`${this.iamBase}/internal/quota/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({
        subject,
        service: quota.service,
        limits: { minute: quota.requestsPerMin, fiveHour: quota.requestsPer5h, day: quota.requestsPerDay },
      }),
    });
    if (!body || typeof body.allowed !== 'boolean' || !['minute', 'fiveHour', 'day'].includes(body.window)
      || !positive(body.count, Number.MAX_SAFE_INTEGER) || !positive(body.limit, 1_000_000_000)
      || !Number.isInteger(body.retryAfterSeconds) || body.retryAfterSeconds < 0) return null;
    return {
      allowed: body.allowed,
      window: body.window,
      count: body.count,
      limit: body.limit,
      retryAfterSeconds: body.retryAfterSeconds,
      ...(typeof body.resetAt === 'string' ? { resetAt: body.resetAt } : {}),
    };
  }

  async admitExecution(subject: string, hour: number, concurrent: number): Promise<ExecutionAdmissionResult | null> {
    const body = await fetchJson(`${this.iamBase}/internal/workflow/execution/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({ subject, limits: { hour, concurrent } }),
    });
    if (!body || typeof body.allowed !== 'boolean' || !['hour', 'concurrent'].includes(body.window)
      || !Number.isInteger(body.count) || body.count < 0
      || !Number.isInteger(body.limit) || body.limit < 1
      || !Number.isInteger(body.retryAfterSeconds) || body.retryAfterSeconds < 0) return null;
    const token = body.allowed ? body.token : null;
    if (body.allowed && (typeof token !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(token))) return null;
    return {
      allowed: body.allowed,
      window: body.window,
      count: body.count,
      limit: body.limit,
      retryAfterSeconds: body.retryAfterSeconds,
      resetAt: typeof body.resetAt === 'string' ? body.resetAt : null,
      token,
    };
  }

  async releaseExecution(subject: string, token: string): Promise<boolean> {
    const body = await fetchJson(`${this.iamBase}/internal/workflow/execution/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({ subject, token }),
    });
    return body?.released === true;
  }

  async meter(orgId: string): Promise<any> {
    const hit = this.meterCache.get(orgId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.meter;
    const meter = await fetchJson(`${this.iamBase}/internal/usage/meter?orgId=${encodeURIComponent(orgId)}`, { headers: this.headers() })
      || { tokensToday: { ai: 0, inference: 0 } };
    if (this.meterCache.size > 10_000) this.meterCache.clear();
    this.meterCache.set(orgId, { meter, at: Date.now() });
    return meter;
  }
}
