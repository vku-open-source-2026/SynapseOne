// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { randomUUID } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';
import { isQuotaService, type QuotaService } from './quotas';

export const QUOTA_WINDOWS = ['minute', 'fiveHour', 'day'] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export interface QuotaLimits {
  minute: number;
  fiveHour: number;
  day: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  window: QuotaWindow;
  count: number;
  limit: number;
  retryAfterSeconds: number;
  resetAt: string;
}

export interface QuotaCheckInput {
  subject: string;
  service: QuotaService;
  limits: QuotaLimits;
}

interface WindowBucket {
  window: QuotaWindow;
  bucket: string;
  resetAtSeconds: number;
  ttlSeconds: number;
}

/** Fixed UTC/epoch windows; never sliding windows and never process-local time. */
export function quotaWindows(nowMs = Date.now()): WindowBucket[] {
  const now = Number.isFinite(nowMs) ? Math.floor(nowMs / 1000) : Math.floor(Date.now() / 1000);
  const minute = Math.floor(now / 60) * 60;
  const fiveHour = Math.floor(now / 18_000) * 18_000;
  const day = new Date(now * 1000);
  day.setUTCHours(0, 0, 0, 0);
  const dayStart = Math.floor(day.getTime() / 1000);
  return [
    { window: 'minute', bucket: String(minute), resetAtSeconds: minute + 60, ttlSeconds: minute + 61 - now },
    { window: 'fiveHour', bucket: String(fiveHour), resetAtSeconds: fiveHour + 18_000, ttlSeconds: fiveHour + 18_001 - now },
    {
      window: 'day',
      bucket: day.toISOString().slice(0, 10),
      resetAtSeconds: dayStart + 86_400,
      ttlSeconds: dayStart + 86_401 - now,
    },
  ];
}

export function quotaKeys(input: QuotaCheckInput, nowMs?: number): string[] {
  return quotaWindows(nowMs).map(({ window, bucket }) =>
    `quota:v1:${input.service}:${input.subject}:${window}:${bucket}`);
}

/**
 * All three counters are read and checked before any INCR. A rejected request
 * therefore consumes no budget in any window. Accepted requests increment all
 * three and refresh TTLs in the same atomic Valkey operation.
 *
 * ARGV: limits[1..3], ttls[4..6], reset epochs[7..9], now epoch[10].
 */
export const QUOTA_CHECK_LUA = `
local counts = {}
local denied = nil
local denied_ratio = -1
for i = 1, 3 do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  local limit = tonumber(ARGV[i])
  counts[i] = count
  if count >= limit then
    local ratio = count / limit
    local reset = tonumber(ARGV[6 + i])
    if denied == nil or ratio > denied_ratio or (ratio == denied_ratio and reset < tonumber(ARGV[6 + denied])) then
      denied = i
      denied_ratio = ratio
    end
  end
end
if denied ~= nil then
  local retry = math.max(1, tonumber(ARGV[6 + denied]) - tonumber(ARGV[10]))
  return {0, denied - 1, counts[denied], ARGV[denied], retry, ARGV[6 + denied]}
end
local selected = 1
local selected_ratio = -1
for i = 1, 3 do
  local count = redis.call('INCR', KEYS[i])
  redis.call('EXPIRE', KEYS[i], ARGV[3 + i])
  counts[i] = count
  local ratio = count / tonumber(ARGV[i])
  local reset = tonumber(ARGV[6 + i])
  if ratio > selected_ratio or (ratio == selected_ratio and reset < tonumber(ARGV[6 + selected])) then
    selected = i
    selected_ratio = ratio
  end
end
return {1, selected - 1, counts[selected], ARGV[selected], 0, ARGV[6 + selected]}
`;

export interface ExecutionLimits {
  hour: number;
  concurrent: number;
}

export interface ExecutionAdmissionInput {
  subject: string;
  limits: ExecutionLimits;
}

export interface ExecutionAdmissionResult {
  allowed: boolean;
  window: 'hour' | 'concurrent';
  count: number;
  limit: number;
  retryAfterSeconds: number;
  resetAt: string | null;
  token: string | null;
}

function executionKeys(subject: string, nowSeconds: number): [string, string] {
  const hour = Math.floor(nowSeconds / 3600) * 3600;
  return [
    `quota:v1:workflow:${subject}:executionHour:${hour}`,
    `quota:v1:workflow:${subject}:concurrent`,
  ];
}

/** Atomic hourly + in-flight execution admission. The concurrent key is a sorted
 *  set of opaque lease tokens; stale leases expire after five minutes so a lost
 *  release cannot permanently consume capacity. */
export const EXECUTION_ADMIT_LUA = `
local hourCount = tonumber(redis.call('GET', KEYS[1]) or '0')
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5])
local concurrentCount = redis.call('ZCARD', KEYS[2])
local hourLimit = tonumber(ARGV[1])
local concurrentLimit = tonumber(ARGV[2])
if hourCount >= hourLimit then
  local retry = math.max(1, tonumber(ARGV[4]) - tonumber(ARGV[5]))
  return {0, 0, hourCount, ARGV[1], retry, ARGV[4], ''}
end
if concurrentCount >= concurrentLimit then
  return {0, 1, concurrentCount, ARGV[2], 60, 0, ''}
end
hourCount = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], tonumber(ARGV[5]) + tonumber(ARGV[7]), ARGV[6])
return {1, 0, hourCount, ARGV[1], 0, ARGV[4], ARGV[6]}
`;

export const EXECUTION_RELEASE_LUA = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

export interface QuotaRedis {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  readonly status: string;
}

export interface QuotaMeterHealth {
  configured: boolean;
  status: string;
  checks: number;
  allowed: number;
  denied: number;
  unavailable: number;
  lastErrorAt: string | null;
}

export class QuotaMeter {
  private readonly counters = {
    checks: 0, allowed: 0, denied: 0, unavailable: 0, lastErrorAt: null as string | null,
  };
  constructor(private readonly redis: QuotaRedis | null) {}

  health(): QuotaMeterHealth {
    return {
      configured: !!this.redis,
      status: this.redis?.status || 'disabled',
      checks: this.counters.checks,
      allowed: this.counters.allowed,
      denied: this.counters.denied,
      unavailable: this.counters.unavailable,
      lastErrorAt: this.counters.lastErrorAt,
    };
  }

  async check(input: QuotaCheckInput, nowMs?: number): Promise<QuotaCheckResult> {
    this.counters.checks++;
    try {
      if (!this.redis || this.redis.status !== 'ready') throw new Error('quota_store_unavailable');
      // Capture once: bucket keys, TTLs, reset metadata and Lua ARGV must all
      // describe the same instant, including at minute/5h/UTC-day boundaries.
      const nowSeconds = Math.floor((nowMs ?? Date.now()) / 1000);
      const windows = quotaWindows(nowSeconds * 1000);
      const keys = quotaKeys(input, nowSeconds * 1000);
      const limits = [input.limits.minute, input.limits.fiveHour, input.limits.day];
      const args = [
        ...limits,
        ...windows.map((window) => window.ttlSeconds),
        ...windows.map((window) => window.resetAtSeconds),
        nowSeconds,
      ];
      const raw = await this.redis.eval(QUOTA_CHECK_LUA, keys.length, ...keys, ...args.map(String));
      if (!Array.isArray(raw) || raw.length !== 6) throw new Error('quota_store_invalid_response');
      const allowed = Number(raw[0]) === 1;
      const index = Number(raw[1]);
      const window = QUOTA_WINDOWS[index];
      if (!window) throw new Error('quota_store_invalid_response');
      if (allowed) this.counters.allowed++;
      else this.counters.denied++;
      return {
        allowed,
        window,
        count: Number(raw[2]),
        limit: Number(raw[3]),
        retryAfterSeconds: Number(raw[4]),
        resetAt: new Date(Number(raw[5]) * 1000).toISOString(),
      };
    } catch (error) {
      this.counters.unavailable++;
      this.counters.lastErrorAt = new Date().toISOString();
      throw error;
    }
  }

  async admitExecution(input: ExecutionAdmissionInput, nowMs?: number): Promise<ExecutionAdmissionResult> {
    if (!this.redis || this.redis.status !== 'ready') throw new Error('quota_store_unavailable');
    const nowSeconds = Math.floor((nowMs ?? Date.now()) / 1000);
    const hourStart = Math.floor(nowSeconds / 3600) * 3600;
    const resetAtSeconds = hourStart + 3600;
    const keys = executionKeys(input.subject, nowSeconds);
    const token = randomUUID();
    const raw = await this.redis.eval(
      EXECUTION_ADMIT_LUA,
      keys.length,
      ...keys,
      String(input.limits.hour),
      String(input.limits.concurrent),
      String(resetAtSeconds + 1 - nowSeconds),
      String(resetAtSeconds),
      String(nowSeconds),
      token,
      '300',
    );
    if (!Array.isArray(raw) || raw.length !== 7) throw new Error('quota_store_invalid_response');
    const allowed = Number(raw[0]) === 1;
    const window = Number(raw[1]) === 1 ? 'concurrent' : 'hour';
    const reset = Number(raw[5]);
    return {
      allowed,
      window,
      count: Number(raw[2]),
      limit: Number(raw[3]),
      retryAfterSeconds: Number(raw[4]),
      resetAt: reset > 0 ? new Date(reset * 1000).toISOString() : null,
      token: allowed ? String(raw[6]) : null,
    };
  }

  async releaseExecution(subject: string, token: string): Promise<boolean> {
    if (!this.redis || this.redis.status !== 'ready') throw new Error('quota_store_unavailable');
    const [, concurrentKey] = executionKeys(subject, Math.floor(Date.now() / 1000));
    const removed = await this.redis.eval(EXECUTION_RELEASE_LUA, 1, concurrentKey, token);
    return Number(removed) > 0;
  }
}

let shared: QuotaMeter | null = null;

export function createQuotaRedis(url: string): Redis {
  const options: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 1_500,
    // Reconnect forever with a capped backoff. A transient outage must not
    // permanently leave the process on local-minute fallback.
    retryStrategy: (times) => Math.min(100 * 2 ** Math.min(times, 5), 2_000),
  };
  return new Redis(url, options);
}

/** Lazy so tests/dev can import IAM without opening a Valkey connection. */
export function getQuotaMeter(): QuotaMeter {
  if (shared) return shared;
  const url = (process.env.IAM_QUOTA_VALKEY_URL || process.env.VALKEY_URL || process.env.REDIS_URL || '').trim();
  if (!url) {
    shared = new QuotaMeter(null);
    return shared;
  }
  const redis = createQuotaRedis(url);
  redis.on('error', () => console.warn(JSON.stringify({ event: 'iam_quota_valkey_error', status: redis.status })));
  redis.on('ready', () => console.info(JSON.stringify({ event: 'iam_quota_valkey_ready' })));
  void redis.connect().catch(() => undefined);
  shared = new QuotaMeter(redis);
  return shared;
}

export function getQuotaMeterHealth(): QuotaMeterHealth {
  return getQuotaMeter().health();
}

export function validateExecutionAdmission(body: unknown): ExecutionAdmissionInput | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (typeof value.subject !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.subject)) return null;
  if (!value.limits || typeof value.limits !== 'object') return null;
  const limits = value.limits as Record<string, unknown>;
  const positive = (input: unknown, max: number): input is number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= max;
  if (!positive(limits.hour, 1_000_000) || !positive(limits.concurrent, 1_000)) return null;
  return { subject: value.subject, limits: { hour: limits.hour, concurrent: limits.concurrent } };
}

export function validateQuotaCheck(body: unknown): QuotaCheckInput | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (typeof value.subject !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.subject)) return null;
  if (typeof value.service !== 'string' || !isQuotaService(value.service)) return null;
  if (!value.limits || typeof value.limits !== 'object') return null;
  const limits = value.limits as Record<string, unknown>;
  const positive = (input: unknown, max: number): input is number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= max;
  if (!positive(limits.minute, 100_000) || !positive(limits.fiveHour, 1_000_000_000) || !positive(limits.day, 1_000_000_000)) return null;
  return { subject: value.subject, service: value.service, limits: { minute: limits.minute, fiveHour: limits.fiveHour, day: limits.day } };
}
