// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Usage rollups → Synapse Warehouse.
 *
 * Raw gateway telemetry lands in Postgres (`usage_events`). A periodic job
 * aggregates completed hours into the tenant's DuckDB warehouse so dashboard
 * queries can combine cheap pre-aggregated history with a small live tail.
 * Rollups are idempotent: each [from, to) window replaces the same window.
 */
import { sql } from 'drizzle-orm';
import { ensureTables, getDb, getDirectPool, useDb } from './db';
import type { UsageFilter } from './usage';

export const USAGE_LATENCY_BOUNDS = [1, 2, 5, 10, 20, 30, 40, 50, 60, 75, 90, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000] as const;
export const USAGE_LATENCY_BUCKETS = USAGE_LATENCY_BOUNDS.length + 1;

const HOUR_MS = 3600_000;
const MAX_ROLLUP_HOURS = 24;

export interface WarehouseUsageAggregate {
  requests: number;
  success: number;
  clientErrors: number;
  serverErrors: number;
  durationSum: number;
  latency: number[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastRequestAt: string | null;
}

export interface WarehouseUsageResponse {
  from: string;
  to: string;
  minBucket: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  totals: WarehouseUsageAggregate & { userIds: string[]; accountIds: string[] };
  features: Array<WarehouseUsageAggregate & { feature: string }>;
  series: Array<{ ts: string; requests: number; errors: number; durationSum: number }>;
  statusClasses: Array<{ class: string; count: number }>;
  authKinds: Array<{ kind: string; requests: number }>;
  topRoutes: Array<{ feature: string; route: string; method: string; requests: number; errors: number; durationSum: number }>;
  models: Array<{ model: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
}

function warehouseUrl(): string | null {
  const url = String(process.env.WAREHOUSE_SERVICE_URL || '').trim().replace(/\/$/, '');
  return url || null;
}

function intEnv(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function isoTimestamp(value: string): string | null {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Timestamps are formatted in UTC by Postgres so DuckDB sees stable wall time. */
const PG_TS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const PG_BUCKET = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

function latencySelect(): string {
  // Non-cumulative histogram buckets: each request belongs to exactly one.
  // Cumulative `<= bound` counters would double-count when merged.
  const parts: string[] = [];
  let previous = 0;
  for (const bound of USAGE_LATENCY_BOUNDS) {
    parts.push(`count(*) filter (where duration_ms > ${previous} and duration_ms <= ${bound})::bigint AS lat_${bound}`);
    previous = bound;
  }
  parts.push(`count(*) filter (where duration_ms > ${USAGE_LATENCY_BOUNDS[USAGE_LATENCY_BOUNDS.length - 1]})::bigint AS lat_inf`);
  return parts.join(',\n  ');
}

async function readHourly(orgId: string, from: Date, to: Date): Promise<any[]> {
  const db = getDb()!;
  const result: any = await db.execute(sql`
    SELECT
      to_char(date_trunc('hour', created_at AT TIME ZONE 'UTC'), ${sql.raw(PG_BUCKET)}) AS bucket,
      feature,
      route,
      method,
      floor(status / 100)::int AS status_class,
      auth_kind,
      account_id::text AS account_id,
      coalesce(model, '') AS model,
      count(*)::bigint AS requests,
      count(*) filter (where status < 400)::bigint AS success,
      count(*) filter (where status >= 400 and status < 500)::bigint AS client_errors,
      count(*) filter (where status >= 500)::bigint AS server_errors,
      coalesce(sum(duration_ms), 0)::bigint AS duration_sum,
      coalesce(max(duration_ms), 0)::int AS duration_max,
      ${sql.raw(latencySelect())},
      coalesce(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
      coalesce(sum(completion_tokens), 0)::bigint AS completion_tokens,
      coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
      to_char((max(created_at) AT TIME ZONE 'UTC'), ${sql.raw(PG_TS)}) AS last_request_at
    FROM usage_events
    WHERE org_id = ${orgId}::uuid
      AND created_at >= ${from.toISOString()}
      AND created_at < ${to.toISOString()}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    ORDER BY 1
  `);
  return result?.rows || [];
}

async function readUsers(orgId: string, from: Date, to: Date): Promise<any[]> {
  const db = getDb()!;
  const result: any = await db.execute(sql`
    SELECT
      to_char(date_trunc('hour', created_at AT TIME ZONE 'UTC'), ${sql.raw(PG_BUCKET)}) AS bucket,
      feature,
      method,
      floor(status / 100)::int AS status_class,
      account_id::text AS account_id,
      user_id::text AS user_id,
      count(*)::bigint AS requests,
      to_char((min(created_at) AT TIME ZONE 'UTC'), ${sql.raw(PG_TS)}) AS first_seen,
      to_char((max(created_at) AT TIME ZONE 'UTC'), ${sql.raw(PG_TS)}) AS last_seen
    FROM usage_events
    WHERE org_id = ${orgId}::uuid
      AND user_id IS NOT NULL
      AND created_at >= ${from.toISOString()}
      AND created_at < ${to.toISOString()}
    GROUP BY 1, 2, 3, 4, 5, 6
    ORDER BY 1
  `);
  return result?.rows || [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hourlyPayload(rows: any[]): any[] {
  return rows.map((row) => ({
    bucket: String(row.bucket),
    feature: String(row.feature || 'other'),
    route: String(row.route || '/'),
    method: String(row.method || 'GET'),
    statusClass: num(row.status_class),
    authKind: String(row.auth_kind || 'unknown'),
    accountId: row.account_id ? String(row.account_id) : null,
    model: row.model ? String(row.model) : null,
    requests: num(row.requests),
    success: num(row.success),
    clientErrors: num(row.client_errors),
    serverErrors: num(row.server_errors),
    durationSum: num(row.duration_sum),
    durationMax: num(row.duration_max),
    latency: [
      ...USAGE_LATENCY_BOUNDS.map((bound) => num(row[`lat_${bound}`])),
      num(row.lat_inf),
    ],
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    lastRequestAt: String(row.last_request_at),
  }));
}

function userPayload(rows: any[]): any[] {
  return rows.map((row) => ({
    bucket: String(row.bucket),
    feature: String(row.feature || 'other'),
    method: String(row.method || 'GET'),
    statusClass: num(row.status_class),
    accountId: row.account_id ? String(row.account_id) : null,
    userId: String(row.user_id),
    requests: num(row.requests),
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen),
  }));
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 30_000): Promise<any> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const message = body?.message || body?.error || String(body || '').slice(0, 200);
      throw new Error(`warehouse ${init.method || 'GET'} ${url} -> ${res.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(to);
  }
}

function internalHeaders(orgId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-synapseone-org': orgId,
  };
  if (process.env.SYNAPSEONE_INTERNAL_SECRET) {
    headers['x-synapseone-internal'] = process.env.SYNAPSEONE_INTERNAL_SECRET;
  }
  return headers;
}

export async function warehouseWatermark(orgId: string): Promise<{
  coveredFrom: string | null;
  coveredUntil: string | null;
  minBucket: string | null;
}> {
  const base = warehouseUrl();
  if (!base) return { coveredFrom: null, coveredUntil: null, minBucket: null };
  const body = await fetchJson(`${base}/internal/usage/watermark`, {
    method: 'GET',
    headers: internalHeaders(orgId),
  }, 10_000);
  return {
    coveredFrom: body?.coveredFrom ? isoTimestamp(String(body.coveredFrom)) : null,
    coveredUntil: body?.coveredUntil ? isoTimestamp(String(body.coveredUntil)) : null,
    minBucket: body?.minBucket ? isoTimestamp(String(body.minBucket)) : null,
  };
}

async function pushRollup(orgId: string, from: Date, to: Date, hourly: any[], users: any[]): Promise<void> {
  const base = warehouseUrl();
  if (!base) return;
  await fetchJson(`${base}/internal/usage/rollup`, {
    method: 'POST',
    headers: internalHeaders(orgId),
    body: JSON.stringify({ from: from.toISOString(), to: to.toISOString(), hourly, users }),
  }, 60_000);
}

/** Query the pre-aggregated warehouse history for one tenant. */
export async function fetchWarehouseUsage(f: UsageFilter): Promise<WarehouseUsageResponse | null> {
  const base = warehouseUrl();
  if (!base || !f.orgId) return null;
  return fetchJson(`${base}/internal/usage/summary`, {
    method: 'POST',
    headers: internalHeaders(f.orgId),
    body: JSON.stringify({
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      ...(f.feature ? { feature: f.feature } : {}),
      ...(f.accountId ? { accountId: f.accountId } : {}),
      ...(f.method ? { method: f.method } : {}),
      ...(f.statusClass ? { statusClass: f.statusClass } : {}),
    }),
  }, 15_000);
}

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[iam][usage-rollup] ${message}`);
}

/** One rollup pass. Safe to call concurrently: Postgres advisory lock guards it. */
export async function runUsageRollupOnce(): Promise<{ orgs: number; pushed: number } | null> {
  const base = warehouseUrl();
  if (!base || !useDb()) return null;
  await ensureTables();
  const db = getDb();
  // The advisory lock is session-scoped, so it must use the direct Postgres
  // pool rather than PgBouncer's transaction pool.
  const pool = getDirectPool();
  if (!db || !pool) return null;

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("select pg_try_advisory_lock(hashtext('synapseone_usage_rollup')) as ok");
    locked = Boolean(lock.rows[0]?.ok);
    if (!locked) return null;

    const now = Date.now();
    const to = new Date(floorHour(now));
    const backfillHours = intEnv(process.env.USAGE_ROLLUP_BACKFILL_HOURS, 720, 1, 8760);
    const intervalHours = intEnv(process.env.USAGE_ROLLUP_INTERVAL_HOURS, 6, 1, MAX_ROLLUP_HOURS);
    const backfillStart = floorHour(now - backfillHours * HOUR_MS);
    if (to.getTime() <= backfillStart) return { orgs: 0, pushed: 0 };

    // Only orgs with recent telemetry need a pass; scanning the full backfill
    // window every 5 minutes would defeat the purpose of this job. An org that
    // has been quiet for longer simply catches up when it next emits traffic.
    const orgWindowStart = floorHour(now - 24 * HOUR_MS);
    const orgRows: any = await db.execute(sql`
      SELECT DISTINCT org_id::text AS org_id
        FROM usage_events
       WHERE org_id IS NOT NULL
         AND created_at >= ${new Date(orgWindowStart).toISOString()}
    `);
    const orgs = (orgRows?.rows || []).map((r: any) => String(r.org_id)).filter(Boolean);

    let pushed = 0;
    for (const orgId of orgs) {
      let coveredUntil: string | null = null;
      try {
        coveredUntil = (await warehouseWatermark(orgId)).coveredUntil;
      } catch (error: any) {
        warnOnce(`watermark failed for ${orgId}: ${error?.message || error}`);
        continue;
      }
      const coveredMs = coveredUntil ? new Date(coveredUntil).getTime() : 0;
      let fromMs = coveredMs > 0 ? floorHour(coveredMs) : backfillStart;
      if (fromMs < backfillStart && !coveredUntil) fromMs = backfillStart;
      if (fromMs >= to.getTime()) continue;

      while (fromMs < to.getTime()) {
        const chunkTo = Math.min(fromMs + intervalHours * HOUR_MS, to.getTime());
        const fromDate = new Date(fromMs);
        const toDate = new Date(chunkTo);
        try {
          const [hourlyRows, userRows] = await Promise.all([
            readHourly(orgId, fromDate, toDate),
            readUsers(orgId, fromDate, toDate),
          ]);
          await pushRollup(orgId, fromDate, toDate, hourlyPayload(hourlyRows), userPayload(userRows));
          pushed++;
        } catch (error: any) {
          warnOnce(`rollup failed for ${orgId} ${fromDate.toISOString()}..${toDate.toISOString()}: ${error?.message || error}`);
          break;
        }
        fromMs = chunkTo;
      }
    }
    return { orgs: orgs.length, pushed };
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext('synapseone_usage_rollup'))").catch(() => undefined);
    }
    client.release();
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the background rollup loop (no-op without Postgres or warehouse URL). */
export function startUsageRollup(): void {
  if (timer || !warehouseUrl() || !useDb()) return;
  const intervalMs = intEnv(process.env.USAGE_ROLLUP_INTERVAL_MS, 5 * 60_000, 60_000, 60 * 60_000);
  const tick = () => {
    runUsageRollupOnce().catch((error) => warnOnce(String(error?.message || error)));
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 15_000).unref?.();
}
