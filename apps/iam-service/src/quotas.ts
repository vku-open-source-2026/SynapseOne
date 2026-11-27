// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import * as schema from './schema';
import { __mem, ensureTables, getDb } from './db';

export const QUOTA_SERVICES = ['ai', 'inference', 'workflow'] as const;
export type QuotaService = (typeof QUOTA_SERVICES)[number];

export interface OrgQuota {
  id: string;
  org_id: string;
  service: QuotaService;
  requests_per_min: number | null;
  requests_per_5h: number | null;
  requests_per_day: number | null;
  tokens_per_day: number | null;
  executions_per_hour: number | null;
  concurrent_executions: number | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface QuotaDefaults {
  requestsPerMin: number;
  requestsPer5h: number;
  requestsPerDay: number;
  tokensPerDay: number | null;
  executionsPerHour: number | null;
  concurrentExecutions: number | null;
}

export type EffectiveQuota = QuotaDefaults & {
  service: QuotaService;
  orgId: string;
  overridden: boolean;
  /** Field-level source: true means an explicit org override, false means default. */
  overrides: Record<keyof QuotaDefaults, boolean>;
};

type QuotaFields = Partial<Record<keyof QuotaDefaults, number | null>>;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function serviceDefaults(prefix: string, fallbackRpm: number, legacyRpmName?: string): QuotaDefaults {
  const requestsPerMin = envInt(
    `${prefix}_QUOTA_REQUESTS_PER_MIN`,
    legacyRpmName ? envInt(legacyRpmName, fallbackRpm, 1, 100_000) : fallbackRpm,
    1,
    100_000,
  );
  return {
    requestsPerMin,
    // Fixed-window defaults are derived, not independent sliding windows.
    requestsPer5h: envInt(`${prefix}_QUOTA_REQUESTS_PER_5H`, requestsPerMin * 300, 1, 1_000_000_000),
    requestsPerDay: envInt(`${prefix}_QUOTA_REQUESTS_PER_DAY`, requestsPerMin * 1_440, 1, 1_000_000_000),
    tokensPerDay: null,
    executionsPerHour: null,
    concurrentExecutions: null,
  };
}

/** Global defaults shared by IAM, the gateway fallback and the Console. */
export function quotaDefaults(): Record<QuotaService, QuotaDefaults> {
  const ai = serviceDefaults('AI', 30, 'AI_RATE_LIMIT');
  ai.tokensPerDay = envInt('AI_QUOTA_TOKENS_PER_DAY', 1_000_000, 1, 1_000_000_000);
  const inference = serviceDefaults('INFERENCE', 60, 'INFERENCE_RATE_LIMIT_PER_MIN');
  inference.tokensPerDay = envInt('INFERENCE_QUOTA_TOKENS_PER_DAY', 1_000_000, 1, 1_000_000_000);
  const workflow = serviceDefaults('WORKFLOW', 120);
  workflow.executionsPerHour = envInt('WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR', 1_000, 1, 1_000_000);
  workflow.concurrentExecutions = envInt('WORKFLOW_QUOTA_CONCURRENT', 10, 1, 1_000);
  return { ai, inference, workflow };
}

export function isQuotaService(value: string): value is QuotaService {
  return (QUOTA_SERVICES as readonly string[]).includes(value);
}

function quotaStore(): Map<string, OrgQuota> {
  const store = (__mem as any).orgQuotas as Map<string, OrgQuota> | undefined;
  if (store) return store;
  const created = new Map<string, OrgQuota>();
  (__mem as any).orgQuotas = created;
  return created;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function quotaRow(row: any): OrgQuota {
  return {
    id: String(row.id ?? row.Id),
    org_id: String(row.orgId ?? row.org_id),
    service: String(row.service) as QuotaService,
    requests_per_min: row.requestsPerMin ?? row.requests_per_min ?? null,
    requests_per_5h: row.requestsPer5h ?? row.requests_per_5h ?? null,
    requests_per_day: row.requestsPerDay ?? row.requests_per_day ?? null,
    tokens_per_day: row.tokensPerDay ?? row.tokens_per_day ?? null,
    executions_per_hour: row.executionsPerHour ?? row.executions_per_hour ?? null,
    concurrent_executions: row.concurrentExecutions ?? row.concurrent_executions ?? null,
    updated_by: row.updatedBy ?? row.updated_by ?? null,
    created_at: iso(row.createdAt ?? row.created_at),
    updated_at: iso(row.updatedAt ?? row.updated_at),
  };
}

export async function listOrgQuotas(orgId: string): Promise<OrgQuota[]> {
  if (getDb()) {
    await ensureTables();
    const rows = await getDb()!.select().from(schema.orgQuotas)
      .where(eq(schema.orgQuotas.orgId, orgId)).orderBy(asc(schema.orgQuotas.service));
    return rows.map(quotaRow);
  }
  return [...quotaStore().values()].filter((row) => row.org_id === orgId).map((row) => ({ ...row }));
}

export async function getOrgQuota(orgId: string, service: QuotaService): Promise<OrgQuota | null> {
  if (getDb()) {
    await ensureTables();
    const rows = await getDb()!.select().from(schema.orgQuotas)
      .where(and(eq(schema.orgQuotas.orgId, orgId), eq(schema.orgQuotas.service, service))).limit(1);
    return rows[0] ? quotaRow(rows[0]) : null;
  }
  return quotaStore().get(`${orgId}:${service}`) || null;
}

export async function getEffectiveQuota(orgId: string, service: QuotaService): Promise<EffectiveQuota> {
  const defaults = quotaDefaults()[service];
  const override = await getOrgQuota(orgId, service);
  const value = (field: keyof QuotaDefaults, snake: keyof OrgQuota): number | null =>
    override ? (override[snake] as number | null) ?? defaults[field] : defaults[field];
  return {
    service,
    orgId,
    requestsPerMin: value('requestsPerMin', 'requests_per_min')!,
    requestsPer5h: value('requestsPer5h', 'requests_per_5h')!,
    requestsPerDay: value('requestsPerDay', 'requests_per_day')!,
    tokensPerDay: value('tokensPerDay', 'tokens_per_day'),
    executionsPerHour: value('executionsPerHour', 'executions_per_hour'),
    concurrentExecutions: value('concurrentExecutions', 'concurrent_executions'),
    overridden: !!override,
    overrides: {
      requestsPerMin: override?.requests_per_min != null,
      requestsPer5h: override?.requests_per_5h != null,
      requestsPerDay: override?.requests_per_day != null,
      tokensPerDay: override?.tokens_per_day != null,
      executionsPerHour: override?.executions_per_hour != null,
      concurrentExecutions: override?.concurrent_executions != null,
    },
  };
}

export async function effectiveQuotas(orgId: string): Promise<Record<QuotaService, EffectiveQuota>> {
  const [ai, inference, workflow] = await Promise.all([
    getEffectiveQuota(orgId, 'ai'),
    getEffectiveQuota(orgId, 'inference'),
    getEffectiveQuota(orgId, 'workflow'),
  ]);
  return { ai, inference, workflow };
}

/** Null clears one field; undefined preserves it. A new row starts with all NULLs. */
export async function upsertOrgQuota(
  orgId: string,
  service: QuotaService,
  fields: QuotaFields,
  updatedBy?: string | null,
): Promise<OrgQuota> {
  if (getDb()) {
    await ensureTables();
    const db = getDb()!;
    const existing = await getOrgQuota(orgId, service);
    const values = {
      requestsPerMin: fields.requestsPerMin === undefined ? existing?.requests_per_min ?? null : fields.requestsPerMin,
      requestsPer5h: fields.requestsPer5h === undefined ? existing?.requests_per_5h ?? null : fields.requestsPer5h,
      requestsPerDay: fields.requestsPerDay === undefined ? existing?.requests_per_day ?? null : fields.requestsPerDay,
      tokensPerDay: fields.tokensPerDay === undefined ? existing?.tokens_per_day ?? null : fields.tokensPerDay,
      executionsPerHour: fields.executionsPerHour === undefined ? existing?.executions_per_hour ?? null : fields.executionsPerHour,
      concurrentExecutions: fields.concurrentExecutions === undefined ? existing?.concurrent_executions ?? null : fields.concurrentExecutions,
    };
    const now = new Date();
    const rows = await db.insert(schema.orgQuotas).values({
      orgId, service, ...values, updatedBy: updatedBy ?? null, updatedAt: now,
    }).onConflictDoUpdate({
      target: [schema.orgQuotas.orgId, schema.orgQuotas.service],
      set: { ...values, updatedBy: updatedBy ?? null, updatedAt: now },
    }).returning();
    return quotaRow(rows[0]);
  }
  const store = quotaStore();
  const key = `${orgId}:${service}`;
  const previous = store.get(key);
  const record: OrgQuota = {
    id: previous?.id || randomUUID(),
    org_id: orgId,
    service,
    requests_per_min: fields.requestsPerMin === undefined ? previous?.requests_per_min ?? null : fields.requestsPerMin,
    requests_per_5h: fields.requestsPer5h === undefined ? previous?.requests_per_5h ?? null : fields.requestsPer5h,
    requests_per_day: fields.requestsPerDay === undefined ? previous?.requests_per_day ?? null : fields.requestsPerDay,
    tokens_per_day: fields.tokensPerDay === undefined ? previous?.tokens_per_day ?? null : fields.tokensPerDay,
    executions_per_hour: fields.executionsPerHour === undefined ? previous?.executions_per_hour ?? null : fields.executionsPerHour,
    concurrent_executions: fields.concurrentExecutions === undefined ? previous?.concurrent_executions ?? null : fields.concurrentExecutions,
    updated_by: updatedBy ?? null,
    created_at: previous?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.set(key, record);
  return { ...record };
}

export async function deleteOrgQuota(orgId: string, service: QuotaService): Promise<boolean> {
  if (getDb()) {
    await ensureTables();
    const rows = await getDb()!.delete(schema.orgQuotas)
      .where(and(eq(schema.orgQuotas.orgId, orgId), eq(schema.orgQuotas.service, service)))
      .returning({ id: schema.orgQuotas.id });
    return rows.length > 0;
  }
  return quotaStore().delete(`${orgId}:${service}`);
}

/** Search is applied in SQL before count/limit so pagination totals stay correct. */
export async function listAllQuotas(opts: { service?: string; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: Array<OrgQuota & { org_slug?: string }>; total: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
  const offset = Math.min(Math.max(Math.floor(Number(opts.offset) || 0), 0), 100_000);
  const q = String(opts.q || '').trim().toLowerCase().slice(0, 200);
  if (getDb()) {
    await ensureTables();
    const db = getDb()!;
    const conditions = [];
    if (opts.service && isQuotaService(opts.service)) conditions.push(eq(schema.orgQuotas.service, opts.service));
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(or(
        ilike(schema.organizations.slug, pattern),
        ilike(schema.organizations.displayName, pattern),
        ilike(schema.orgQuotas.service, pattern),
        sql`${schema.orgQuotas.orgId}::text ilike ${pattern}`,
      )!);
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const totals = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orgQuotas)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgQuotas.orgId)).where(where);
    const rows = await db.select({ quota: schema.orgQuotas, orgSlug: schema.organizations.slug })
      .from(schema.orgQuotas)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgQuotas.orgId))
      .where(where).orderBy(desc(schema.orgQuotas.updatedAt), asc(schema.orgQuotas.id))
      .limit(limit).offset(offset);
    return {
      items: rows.map((row) => ({ ...quotaRow(row.quota), org_slug: row.orgSlug })),
      total: Number(totals[0]?.n) || 0,
    };
  }
  const orgs = (__mem as any).orgs as Map<string, any>;
  const all = [...quotaStore().values()]
    .filter((row) => !opts.service || row.service === opts.service)
    .map((row) => ({ ...row, org_slug: orgs?.get(row.org_id)?.slug }))
    .filter((row) => !q || row.org_id.toLowerCase().includes(q)
      || String(row.org_slug || '').toLowerCase().includes(q) || row.service.includes(q))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.id.localeCompare(b.id));
  return { items: all.slice(offset, offset + limit), total: all.length };
}
