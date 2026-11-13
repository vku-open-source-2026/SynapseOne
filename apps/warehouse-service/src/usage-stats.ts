// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Internal usage-analytics rollups (#usage).
 *
 * The gateway usage pipeline writes one row per request to IAM/Postgres. The
 * dashboard must not scan that raw table on every load, so IAM periodically
 * pushes two pre-aggregated shapes into each tenant's DuckDB file:
 *
 *   _usage_hourly       — one row per hour × feature × route × method × status
 *                         class × auth kind × account × model, with latency
 *                         histogram counters for p95.
 *   _usage_hourly_user  — one row per hour × feature × method × status class ×
 *                         account × user, used for distinct active actors.
 *
 * These tables are internal: they are not exposed as datasets, never listed in
 * /v1/warehouse/datasets and cannot be queried through the read-only SQL API.
 * IAM merges the rollups with the still-unaggregated tail in Postgres.
 */
import { Conn, readAll, warehouseStore } from './duck';
import { WarehouseError } from './duck';

/** Inclusive upper bounds (ms) for the latency histogram; the last bucket is overflow. */
export const USAGE_LATENCY_BOUNDS = [1, 2, 5, 10, 20, 30, 40, 50, 60, 75, 90, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000] as const;
export const USAGE_LATENCY_BUCKETS = USAGE_LATENCY_BOUNDS.length + 1;

const LAT_COLUMNS = [
  ...USAGE_LATENCY_BOUNDS.map((bound) => `lat_${bound}`),
  'lat_inf',
];

const HOURLY_COLUMNS = [
  'bucket', 'feature', 'route', 'method', 'status_class', 'auth_kind', 'account_id', 'model',
  'requests', 'success', 'client_errors', 'server_errors', 'duration_sum', 'duration_max',
  ...LAT_COLUMNS,
  'prompt_tokens', 'completion_tokens', 'total_tokens', 'last_request_at',
];

const USER_COLUMNS = [
  'bucket', 'feature', 'method', 'status_class', 'account_id', 'user_id',
  'requests', 'first_seen', 'last_seen',
];

const HOUR_MS = 3600_000;
const MAX_ROLLUP_HOURS = 48;
const MAX_HOURLY_ROWS = 20_000;
const MAX_USER_ROWS = 50_000;

export interface UsageHourlyRow {
  bucket: string;
  feature: string;
  route: string;
  method: string;
  statusClass: number;
  authKind: string;
  accountId: string | null;
  model: string | null;
  requests: number;
  success: number;
  clientErrors: number;
  serverErrors: number;
  durationSum: number;
  durationMax?: number;
  latency: number[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastRequestAt: string;
}

export interface UsageUserRow {
  bucket: string;
  feature: string;
  method: string;
  statusClass: number;
  accountId: string | null;
  userId: string;
  requests: number;
  firstSeen: string;
  lastSeen: string;
}

export interface UsageRollupInput {
  from: string;
  to: string;
  hourly?: UsageHourlyRow[];
  users?: UsageUserRow[];
}

export interface UsageStatsFilter {
  from: string;
  to: string;
  feature?: string;
  accountId?: string;
  method?: string;
  statusClass?: number;
}

export interface UsageAggregate {
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

export interface UsageWarehouseSummary {
  from: string;
  to: string;
  /** Oldest hourly bucket present for this tenant (null = no rows yet). */
  minBucket: string | null;
  /** Inclusive start of continuously covered rollup time. */
  coverageStart: string | null;
  /** Exclusive end of time covered by completed rollups (includes empty hours). */
  coverageEnd: string | null;
  totals: UsageAggregate & { userIds: string[]; accountIds: string[] };
  features: Array<UsageAggregate & { feature: string }>;
  series: Array<{ ts: string; requests: number; errors: number; durationSum: number }>;
  statusClasses: Array<{ class: string; count: number }>;
  authKinds: Array<{ kind: string; requests: number }>;
  topRoutes: Array<{ feature: string; route: string; method: string; requests: number; errors: number; durationSum: number }>;
  models: Array<{ model: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
}

function emptyLatency(): number[] {
  return new Array(USAGE_LATENCY_BUCKETS).fill(0);
}

function emptyAggregate(): UsageAggregate {
  return {
    requests: 0, success: 0, clientErrors: 0, serverErrors: 0, durationSum: 0,
    latency: emptyLatency(), promptTokens: 0, completionTokens: 0, totalTokens: 0,
    lastRequestAt: null,
  };
}

function text(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

function nullableText(value: unknown, max: number): string | null {
  const s = text(value, max).trim();
  return s ? s : null;
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

function isoTimestamp(value: unknown): string {
  const d = new Date(String(value ?? ''));
  if (!Number.isFinite(d.getTime())) throw new WarehouseError(400, 'invalid_timestamp', 'invalid timestamp in usage rollup');
  return d.toISOString();
}

function numberOrNull(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function ensureUsageTables(conn: Conn): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS _usage_hourly (
    bucket TIMESTAMP NOT NULL,
    feature VARCHAR NOT NULL,
    route VARCHAR NOT NULL,
    method VARCHAR NOT NULL,
    status_class INTEGER NOT NULL,
    auth_kind VARCHAR NOT NULL,
    account_id VARCHAR,
    model VARCHAR,
    requests BIGINT NOT NULL,
    success BIGINT NOT NULL,
    client_errors BIGINT NOT NULL,
    server_errors BIGINT NOT NULL,
    duration_sum BIGINT NOT NULL,
    duration_max INTEGER NOT NULL,
    ${LAT_COLUMNS.map((column) => `${column} BIGINT NOT NULL`).join(',\n    ')},
    prompt_tokens BIGINT NOT NULL,
    completion_tokens BIGINT NOT NULL,
    total_tokens BIGINT NOT NULL,
    last_request_at TIMESTAMP NOT NULL
  )`);
  await conn.run(`CREATE TABLE IF NOT EXISTS _usage_hourly_user (
    bucket TIMESTAMP NOT NULL,
    feature VARCHAR NOT NULL,
    method VARCHAR NOT NULL,
    status_class INTEGER NOT NULL,
    account_id VARCHAR,
    user_id VARCHAR NOT NULL,
    requests BIGINT NOT NULL,
    first_seen TIMESTAMP NOT NULL,
    last_seen TIMESTAMP NOT NULL
  )`);
  await conn.run(`CREATE TABLE IF NOT EXISTS _usage_rollup_state (
    id VARCHAR PRIMARY KEY,
    covered_from TIMESTAMP,
    covered_until TIMESTAMP NOT NULL
  )`);
  // Migration for warehouses created before covered_from existed.
  const stateCols = await readAll(conn, 'DESCRIBE _usage_rollup_state');
  if (!stateCols.rows.some((row) => String(row.column_name) === 'covered_from')) {
    await conn.run('ALTER TABLE _usage_rollup_state ADD COLUMN covered_from TIMESTAMP');
    await conn.run(
      "UPDATE _usage_rollup_state SET covered_from = covered_until - INTERVAL 30 DAY WHERE covered_from IS NULL",
    );
  }
}

function validateRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
  const from = new Date(String(fromRaw ?? ''));
  const to = new Date(String(toRaw ?? ''));
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new WarehouseError(400, 'invalid_range', 'from/to must be ISO timestamps');
  }
  if (to <= from) throw new WarehouseError(400, 'invalid_range', 'to must be after from');
  if (to.getTime() - from.getTime() > MAX_ROLLUP_HOURS * HOUR_MS) {
    throw new WarehouseError(400, 'range_too_large', `usage rollup range is limited to ${MAX_ROLLUP_HOURS}h`);
  }
  return { from, to };
}

function validateSummaryRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
  const from = new Date(String(fromRaw ?? ''));
  const to = new Date(String(toRaw ?? ''));
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new WarehouseError(400, 'invalid_range', 'from/to must be ISO timestamps');
  }
  if (to <= from) throw new WarehouseError(400, 'invalid_range', 'to must be after from');
  if (to.getTime() - from.getTime() > 366 * 24 * HOUR_MS) {
    throw new WarehouseError(400, 'range_too_large', 'usage summary range is limited to 366 days');
  }
  return { from, to };
}

function normalizeHourly(row: any, from: Date, to: Date): any[] {
  const bucket = isoTimestamp(row?.bucket);
  const when = new Date(bucket).getTime();
  if (when < from.getTime() || when >= to.getTime()) {
    throw new WarehouseError(400, 'invalid_bucket', 'hourly bucket must be inside [from, to)');
  }
  const latency = Array.isArray(row?.latency) ? row.latency.map((n: unknown) => count(n)) : [];
  while (latency.length < USAGE_LATENCY_BUCKETS) latency.push(0);
  return [
    bucket,
    text(row?.feature, 64) || 'other',
    text(row?.route, 200) || '/',
    text(row?.method, 16).toUpperCase() || 'GET',
    Math.min(Math.max(count(row?.statusClass, 5), 0), 5),
    text(row?.authKind, 32) || 'unknown',
    nullableText(row?.accountId, 64),
    nullableText(row?.model, 200),
    count(row?.requests),
    count(row?.success),
    count(row?.clientErrors),
    count(row?.serverErrors),
    count(row?.durationSum),
    count(row?.durationMax ?? 0),
    ...latency.slice(0, USAGE_LATENCY_BUCKETS),
    count(row?.promptTokens),
    count(row?.completionTokens),
    count(row?.totalTokens),
    isoTimestamp(row?.lastRequestAt),
  ];
}

function normalizeUser(row: any, from: Date, to: Date): any[] {
  const bucket = isoTimestamp(row?.bucket);
  const when = new Date(bucket).getTime();
  if (when < from.getTime() || when >= to.getTime()) {
    throw new WarehouseError(400, 'invalid_bucket', 'user bucket must be inside [from, to)');
  }
  return [
    bucket,
    text(row?.feature, 64) || 'other',
    text(row?.method, 16).toUpperCase() || 'GET',
    Math.min(Math.max(count(row?.statusClass, 5), 0), 5),
    nullableText(row?.accountId, 64),
    text(row?.userId, 64),
    count(row?.requests),
    isoTimestamp(row?.firstSeen),
    isoTimestamp(row?.lastSeen),
  ];
}

function placeholders(columns: string[], rows: number, timestampIndexes: number[] = []): string {
  const one = columns.map((_c, i) => (timestampIndexes.includes(i) ? '?::TIMESTAMP' : '?')).join(', ');
  return new Array(rows).fill(`(${one})`).join(', ');
}

/** Replace one [from, to) rollup range atomically. Idempotent per range. */
export async function replaceUsageRollup(tenant: string, input: UsageRollupInput): Promise<{ hourly: number; users: number }> {
  const { from, to } = validateRange(input.from, input.to);
  const hourly = Array.isArray(input.hourly) ? input.hourly : [];
  const users = Array.isArray(input.users) ? input.users : [];
  if (hourly.length > MAX_HOURLY_ROWS) throw new WarehouseError(413, 'too_many_rows', `hourly rollup is limited to ${MAX_HOURLY_ROWS} rows`);
  if (users.length > MAX_USER_ROWS) throw new WarehouseError(413, 'too_many_rows', `user rollup is limited to ${MAX_USER_ROWS} rows`);
  const hourlyValues = hourly.map((row) => normalizeHourly(row, from, to));
  const userValues = users.map((row) => normalizeUser(row, from, to));

  await warehouseStore.run(tenant, async (conn) => {
    await ensureUsageTables(conn);
    await conn.run('BEGIN');
    try {
      await conn.run('DELETE FROM _usage_hourly WHERE bucket >= ?::TIMESTAMP AND bucket < ?::TIMESTAMP', [from.toISOString(), to.toISOString()]);
      await conn.run('DELETE FROM _usage_hourly_user WHERE bucket >= ?::TIMESTAMP AND bucket < ?::TIMESTAMP', [from.toISOString(), to.toISOString()]);
      const HOURLY_TS = [0, HOURLY_COLUMNS.length - 1];
      const USER_TS = [0, 7, 8];
      for (let i = 0; i < hourlyValues.length; i += 100) {
        const chunk = hourlyValues.slice(i, i + 100);
        const args = chunk.flat();
        await conn.run(
          `INSERT INTO _usage_hourly (${HOURLY_COLUMNS.join(', ')}) VALUES ${placeholders(HOURLY_COLUMNS, chunk.length, HOURLY_TS)}`,
          args,
        );
      }
      for (let i = 0; i < userValues.length; i += 200) {
        const chunk = userValues.slice(i, i + 200);
        const args = chunk.flat();
        await conn.run(
          `INSERT INTO _usage_hourly_user (${USER_COLUMNS.join(', ')}) VALUES ${placeholders(USER_COLUMNS, chunk.length, USER_TS)}`,
          args,
        );
      }
      // Advance coverage even when the window contains no traffic, otherwise
      // a quiet hour would keep the rollup cursor pinned forever.
      const prev = await readAll(conn, "SELECT covered_from, covered_until FROM _usage_rollup_state WHERE id = 'usage'");
      const prevFrom = prev.rows[0]?.covered_from ? new Date(String(prev.rows[0].covered_from)).toISOString() : null;
      const prevUntil = prev.rows[0]?.covered_until ? new Date(String(prev.rows[0].covered_until)).toISOString() : null;
      const nextFrom = prevFrom && new Date(prevFrom).getTime() < from.getTime() ? prevFrom : from.toISOString();
      const nextUntil = prevUntil && new Date(prevUntil).getTime() > to.getTime() ? prevUntil : to.toISOString();
      await conn.run("DELETE FROM _usage_rollup_state WHERE id = 'usage'");
      await conn.run(
        "INSERT INTO _usage_rollup_state (id, covered_from, covered_until) VALUES ('usage', ?::TIMESTAMP, ?::TIMESTAMP)",
        [nextFrom, nextUntil],
      );
      await conn.run('COMMIT');
    } catch (error) {
      await conn.run('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  return { hourly: hourlyValues.length, users: userValues.length };
}

function whereClause(filter: UsageStatsFilter, includeRoute: boolean): { sql: string; params: any[] } {
  const conds = ['bucket >= ?::TIMESTAMP', 'bucket < ?::TIMESTAMP'];
  const params: any[] = [filter.from, filter.to];
  if (filter.feature) { conds.push('feature = ?'); params.push(filter.feature); }
  if (filter.method) { conds.push('method = ?'); params.push(filter.method); }
  if (filter.statusClass) { conds.push('status_class = ?'); params.push(filter.statusClass); }
  if (filter.accountId) { conds.push('account_id = ?'); params.push(filter.accountId); }
  void includeRoute;
  return { sql: conds.join(' AND '), params };
}

const AGGREGATE_SELECT = `
  coalesce(sum(requests), 0) AS requests,
  coalesce(sum(success), 0) AS success,
  coalesce(sum(client_errors), 0) AS client_errors,
  coalesce(sum(server_errors), 0) AS server_errors,
  coalesce(sum(duration_sum), 0) AS duration_sum,
  ${LAT_COLUMNS.map((c) => `coalesce(sum(${c}), 0) AS ${c}`).join(',\n  ')},
  coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
  coalesce(sum(completion_tokens), 0) AS completion_tokens,
  coalesce(sum(total_tokens), 0) AS total_tokens,
  max(last_request_at) AS last_request_at
`;

function aggregateFromRow(row: Record<string, any>): UsageAggregate {
  if (!row) return emptyAggregate();
  return {
    requests: numberOrNull(row.requests),
    success: numberOrNull(row.success),
    clientErrors: numberOrNull(row.client_errors),
    serverErrors: numberOrNull(row.server_errors),
    durationSum: numberOrNull(row.duration_sum),
    latency: LAT_COLUMNS.map((c) => numberOrNull(row[c])),
    promptTokens: numberOrNull(row.prompt_tokens),
    completionTokens: numberOrNull(row.completion_tokens),
    totalTokens: numberOrNull(row.total_tokens),
    lastRequestAt: row.last_request_at ? new Date(String(row.last_request_at)).toISOString() : null,
  };
}

/** Read pre-aggregated usage for one tenant. Internal endpoint only. */
export async function usageStatsSummary(tenant: string, filter: UsageStatsFilter): Promise<UsageWarehouseSummary> {
  const { from, to } = validateSummaryRange(filter.from, filter.to);
  const bounded: UsageStatsFilter = {
    ...filter,
    from: from.toISOString(),
    to: to.toISOString(),
    ...(filter.statusClass ? { statusClass: Math.min(Math.max(Math.floor(filter.statusClass), 0), 5) } : {}),
  };
  return warehouseStore.run(tenant, async (conn) => {
    await ensureUsageTables(conn);
    const bounds = await readAll(conn, 'SELECT min(bucket) AS min_bucket FROM _usage_hourly');
    const state = await readAll(conn, "SELECT covered_from, covered_until FROM _usage_rollup_state WHERE id = 'usage'");
    const minRaw = bounds.rows[0]?.min_bucket;
    const coveredRaw = state.rows[0]?.covered_until;
    const coveredFromRaw = state.rows[0]?.covered_from;
    const minBucket = minRaw ? new Date(String(minRaw)).toISOString() : null;
    const coverageStart = coveredFromRaw ? new Date(String(coveredFromRaw)).toISOString() : null;
    const coverageEnd = coveredRaw ? new Date(String(coveredRaw)).toISOString() : null;
    if (!coverageEnd) {
      return {
        from: bounded.from,
        to: bounded.to,
        minBucket: null,
        coverageStart: null,
        coverageEnd: null,
        totals: { ...emptyAggregate(), userIds: [], accountIds: [] },
        features: [],
        series: [],
        statusClasses: [],
        authKinds: [],
        topRoutes: [],
        models: [],
      };
    }
    const queryTo = new Date(bounded.to).getTime() < new Date(coverageEnd).getTime() ? bounded.to : coverageEnd;
    if (new Date(bounded.from).getTime() >= new Date(queryTo).getTime()) {
      return {
        from: bounded.from,
        to: bounded.to,
        minBucket,
        coverageStart,
        coverageEnd,
        totals: { ...emptyAggregate(), userIds: [], accountIds: [] },
        features: [],
        series: [],
        statusClasses: [],
        authKinds: [],
        topRoutes: [],
        models: [],
      };
    }
    const scoped: UsageStatsFilter = { ...bounded, to: queryTo };
    const where = whereClause(scoped, true);
    const userWhere = whereClause(scoped, false);

    const totalsRows = await readAll(conn, `SELECT ${AGGREGATE_SELECT} FROM _usage_hourly WHERE ${where.sql}`, where.params);
    const featureRows = await readAll(
      conn,
      `SELECT feature, ${AGGREGATE_SELECT} FROM _usage_hourly WHERE ${where.sql} GROUP BY feature ORDER BY sum(requests) DESC`,
      where.params,
    );
    const seriesRows = await readAll(
      conn,
      `SELECT bucket AS ts, coalesce(sum(requests), 0) AS requests,
              coalesce(sum(client_errors + server_errors), 0) AS errors,
              coalesce(sum(duration_sum), 0) AS duration_sum
         FROM _usage_hourly WHERE ${where.sql} GROUP BY bucket ORDER BY bucket`,
      where.params,
    );
    const statusRows = await readAll(
      conn,
      `SELECT status_class, coalesce(sum(requests), 0) AS requests
         FROM _usage_hourly WHERE ${where.sql} GROUP BY status_class ORDER BY status_class`,
      where.params,
    );
    const authRows = await readAll(
      conn,
      `SELECT auth_kind, coalesce(sum(requests), 0) AS requests
         FROM _usage_hourly WHERE ${where.sql} GROUP BY auth_kind ORDER BY sum(requests) DESC`,
      where.params,
    );
    const routeRows = await readAll(
      conn,
      `SELECT feature, route, method, coalesce(sum(requests), 0) AS requests,
              coalesce(sum(client_errors + server_errors), 0) AS errors,
              coalesce(sum(duration_sum), 0) AS duration_sum
         FROM _usage_hourly WHERE ${where.sql}
        GROUP BY feature, route, method ORDER BY sum(requests) DESC LIMIT 10`,
      where.params,
    );
    const modelRows = await readAll(
      conn,
      `SELECT model, coalesce(sum(requests), 0) AS requests,
              coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
              coalesce(sum(completion_tokens), 0) AS completion_tokens,
              coalesce(sum(total_tokens), 0) AS total_tokens
         FROM _usage_hourly WHERE ${where.sql} AND model IS NOT NULL AND model <> ''
        GROUP BY model ORDER BY sum(total_tokens) DESC LIMIT 20`,
      where.params,
    );
    const userRows = await readAll(
      conn,
      `SELECT DISTINCT user_id FROM _usage_hourly_user WHERE ${userWhere.sql} AND user_id <> ''`,
      userWhere.params,
    );
    const accountRows = await readAll(
      conn,
      `SELECT DISTINCT account_id FROM _usage_hourly WHERE ${where.sql} AND account_id IS NOT NULL AND account_id <> ''`,
      where.params,
    );

    const totals = aggregateFromRow(totalsRows.rows[0]);
    return {
      from: bounded.from,
      to: bounded.to,
      minBucket,
      coverageStart,
      coverageEnd,
      totals: {
        ...totals,
        userIds: userRows.rows.map((r) => String(r.user_id)).filter(Boolean),
        accountIds: accountRows.rows.map((r) => String(r.account_id)).filter(Boolean),
      },
      features: featureRows.rows.map((r) => ({ feature: String(r.feature), ...aggregateFromRow(r) })),
      series: seriesRows.rows.map((r) => ({
        ts: new Date(String(r.ts)).toISOString(),
        requests: numberOrNull(r.requests),
        errors: numberOrNull(r.errors),
        durationSum: numberOrNull(r.duration_sum),
      })),
      statusClasses: statusRows.rows.map((r) => ({ class: `${numberOrNull(r.status_class)}xx`, count: numberOrNull(r.requests) })),
      authKinds: authRows.rows.map((r) => ({ kind: String(r.auth_kind), requests: numberOrNull(r.requests) })),
      topRoutes: routeRows.rows.map((r) => ({
        feature: String(r.feature), route: String(r.route), method: String(r.method),
        requests: numberOrNull(r.requests), errors: numberOrNull(r.errors), durationSum: numberOrNull(r.duration_sum),
      })),
      models: modelRows.rows.map((r) => ({
        model: String(r.model), requests: numberOrNull(r.requests),
        promptTokens: numberOrNull(r.prompt_tokens), completionTokens: numberOrNull(r.completion_tokens),
        totalTokens: numberOrNull(r.total_tokens),
      })),
    };
  });
}

/** Coverage watermark for a tenant (null when no completed rollup yet). */
export async function usageWatermark(tenant: string): Promise<{
  minBucket: string | null;
  maxBucket: string | null;
  coveredFrom: string | null;
  coveredUntil: string | null;
}> {
  return warehouseStore.run(tenant, async (conn) => {
    await ensureUsageTables(conn);
    const rows = await readAll(conn, 'SELECT min(bucket) AS min_bucket, max(bucket) AS max_bucket FROM _usage_hourly');
    const state = await readAll(conn, "SELECT covered_from, covered_until FROM _usage_rollup_state WHERE id = 'usage'");
    const minRaw = rows.rows[0]?.min_bucket;
    const maxRaw = rows.rows[0]?.max_bucket;
    const coveredRaw = state.rows[0]?.covered_until;
    const coveredFromRaw = state.rows[0]?.covered_from;
    return {
      minBucket: minRaw ? new Date(String(minRaw)).toISOString() : null,
      maxBucket: maxRaw ? new Date(String(maxRaw)).toISOString() : null,
      coveredFrom: coveredFromRaw ? new Date(String(coveredFromRaw)).toISOString() : null,
      coveredUntil: coveredRaw ? new Date(String(coveredRaw)).toISOString() : null,
    };
  });
}
