// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseBase persistence — Drizzle ORM on Postgres with in-memory fallback
 * (dev/test). Tables and indexes are defined in ./schema.ts and applied by
 * versioned Drizzle migrations.
 */
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { BaseMapping, cloneJson, deepMerge, getPath, setPath } from './mapping';
import { baseCollections, baseDocuments, baseOutbox, baseVectors, searchIndex } from './schema';
import { QuerySpec, QueryResult, VectorSearchSpec, VectorSearchResult, applyVectorSearch, formatQueryPage } from './query';
import { compileQuery } from './pg-query';

export interface StoredCollection {
  id: string;
  name: string;
  description: string | null;
  mapping: BaseMapping;
  org_id: string | null;
  account_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredDocument {
  collection_id: string;
  id: string;
  data: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export type StoreErrorCode = 'conflict' | 'version_conflict' | 'not_found' | 'invalid';

export class StoreError extends Error {
  code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'StoreError';
  }
}

const DATABASE_URL = process.env.DATABASE_URL || '';
let pool: Pool | null = null;
let db: NodePgDatabase<typeof import('./schema')> | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[base][db] pool error', e.message));
  db = drizzle(pool, { schema: { baseCollections, baseDocuments, baseOutbox, baseVectors, searchIndex } });
}

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!db || ensured) return;
  ensured = true;
  try {
    const client = await pool!.connect();
    try {
      // Hold the advisory lock on the same dedicated session that runs the
      // migration (pool connections are not guaranteed to be reused).
      const migrationDb = drizzle(client, { schema: { baseCollections, baseDocuments, baseOutbox, baseVectors, searchIndex } });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapseone_base_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_base',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapseone_base_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[base][db] migrations failed:', e?.message || e);
  }
}

export function useDb(): boolean {
  return !!db;
}

/** Run one parameterised statement against the configured Postgres pool.
 *  Only the query compiler builds SQL; every caller value is a bind param. */
export async function pgQuery<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error('[base] DATABASE_URL is not configured');
  await ensureTables();
  const res = await pool.query(text, params as any[]);
  return res.rows as T[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function iso(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : nowIso();
}

function rowToCollection(r: typeof baseCollections.$inferSelect): StoredCollection {
  return {
    id: String(r.id),
    name: String(r.name || ''),
    description: r.description != null ? String(r.description) : null,
    mapping: r.mapping && typeof r.mapping === 'object' ? (r.mapping as BaseMapping) : { fields: {} },
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    created_by: r.createdBy != null ? String(r.createdBy) : null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function rowToDocument(r: typeof baseDocuments.$inferSelect): StoredDocument {
  return {
    collection_id: String(r.collectionId),
    id: String(r.id),
    data: r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {},
    version: Number(r.version) || 1,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

/** Map a raw `pg` row (snake_case columns) to a StoredDocument. */
function pgRowToDocument(r: any): StoredDocument {
  return {
    collection_id: String(r.collection_id ?? r.collectionId ?? ''),
    id: String(r.id),
    data: r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {},
    version: Number(r.version) || 1,
    created_at: iso(r.created_at ?? r.createdAt),
    updated_at: iso(r.updated_at ?? r.updatedAt),
  };
}

function isUniqueViolation(e: any): boolean {
  return String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message));
}

// ---- in-memory fallback ----
const memCollections = new Map<string, StoredCollection>();
const memDocuments = new Map<string, Map<string, StoredDocument>>();
const memOutbox: Array<Record<string, any>> = []; // collectionId -> id -> doc

// ---------- collections ----------

function sameScope(a: { org_id?: string | null; account_id?: string | null }, b: { org_id?: string | null; account_id?: string | null }): boolean {
  return (a.org_id || '') === (b.org_id || '') && (a.account_id || '') === (b.account_id || '');
}

export async function createCollectionRec(input: {
  name: string;
  description?: string | null;
  mapping: BaseMapping;
  org_id?: string | null;
  account_id?: string | null;
  created_by?: string | null;
}): Promise<StoredCollection> {
  const rec: StoredCollection = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    mapping: input.mapping,
    org_id: input.org_id ?? null,
    account_id: input.account_id ?? null,
    created_by: input.created_by ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (db) {
    await ensureTables();
    const rows = await db.insert(baseCollections).values({
      id: rec.id,
      name: rec.name,
      description: rec.description,
      mapping: rec.mapping,
      orgId: rec.org_id,
      accountId: rec.account_id,
      createdBy: rec.created_by,
    }).onConflictDoNothing().returning();
    if (!rows[0]) throw new StoreError('conflict', `collection '${input.name}' already exists in this scope`);
    return rowToCollection(rows[0]);
  }
  for (const c of memCollections.values()) {
    if (c.name === rec.name && sameScope(c, rec)) {
      throw new StoreError('conflict', `collection '${input.name}' already exists in this scope`);
    }
  }
  memCollections.set(rec.id, rec);
  return rec;
}

/**
 * Resolve a collection by name inside a caller scope.
 *  - org callers: any collection owned by that org (account is informational);
 *  - account-only callers: unbound-org, account-owned collections;
 *  - platform callers: an explicit org/account scope, otherwise unbound tables.
 */
export async function findCollectionRec(
  name: string,
  scope: { org_id?: string | null; account_id?: string | null; platform?: boolean },
): Promise<StoredCollection | null> {
  if (db) {
    await ensureTables();
    let where;
    if (scope.platform && !scope.org_id && !scope.account_id) {
      where = and(eq(baseCollections.name, name), isNull(baseCollections.orgId), isNull(baseCollections.accountId));
    } else if (scope.org_id) {
      where = and(eq(baseCollections.name, name), eq(baseCollections.orgId, scope.org_id));
    } else {
      where = and(
        eq(baseCollections.name, name),
        isNull(baseCollections.orgId),
        eq(baseCollections.accountId, scope.account_id ?? ''),
      );
    }
    const rows = await db.select().from(baseCollections).where(where).orderBy(asc(baseCollections.createdAt)).limit(2);
    if (rows.length > 1) {
      throw new StoreError('conflict', `collection '${name}' is ambiguous in this org; add accountId to disambiguate`);
    }
    return rows[0] ? rowToCollection(rows[0]) : null;
  }
  const candidates = [...memCollections.values()].filter((c) => {
    if (c.name !== name) return false;
    if (scope.platform && !scope.org_id && !scope.account_id) return !c.org_id && !c.account_id;
    if (scope.org_id) return c.org_id === scope.org_id;
    return !c.org_id && c.account_id === (scope.account_id ?? '');
  });
  if (candidates.length > 1) {
    throw new StoreError('conflict', `collection '${name}' is ambiguous in this org; add accountId to disambiguate`);
  }
  return candidates[0] || null;
}

export async function getCollectionRec(id: string): Promise<StoredCollection | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseCollections).where(eq(baseCollections.id, id)).limit(1);
    return rows[0] ? rowToCollection(rows[0]) : null;
  }
  return memCollections.get(id) || null;
}

export async function listCollectionRecs(): Promise<StoredCollection[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseCollections).orderBy(asc(baseCollections.name), asc(baseCollections.createdAt));
    return rows.map(rowToCollection);
  }
  return [...memCollections.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateCollectionRec(
  id: string,
  patch: { name?: string; description?: string | null; mapping?: BaseMapping },
): Promise<StoredCollection | null> {
  if (db) {
    await ensureTables();
    const values: Partial<typeof baseCollections.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.mapping !== undefined) values.mapping = patch.mapping;
    try {
      const rows = await db.update(baseCollections).set(values).where(eq(baseCollections.id, id)).returning();
      return rows[0] ? rowToCollection(rows[0]) : null;
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new StoreError('conflict', 'collection name already exists in this scope');
      throw e;
    }
  }
  const cur = memCollections.get(id);
  if (!cur) return null;
  if (patch.name !== undefined && patch.name !== cur.name) {
    for (const c of memCollections.values()) {
      if (c.id !== id && c.name === patch.name && sameScope(c, cur)) {
        throw new StoreError('conflict', 'collection name already exists in this scope');
      }
    }
  }
  const next: StoredCollection = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.mapping !== undefined ? { mapping: patch.mapping } : {}),
    updated_at: nowIso(),
  };
  memCollections.set(id, next);
  return next;
}

export async function deleteCollectionRec(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(baseCollections).where(eq(baseCollections.id, id)).returning({ id: baseCollections.id });
    return rows.length > 0;
  }
  memDocuments.delete(id);
  return memCollections.delete(id);
}


export interface OutboxEvent {
  event_id: string;
  schema_version: number;
  source: 'synapsebase';
  resource_type: 'document';
  organization_id: string | null;
  account_id: string | null;
  collection_id: string;
  collection_name: string;
  document_id: string;
  operation: 'create' | 'update' | 'delete';
  version: number;
  occurred_at: string;
  data?: Record<string, unknown>;
}

function outboxPayload(
  collection: StoredCollection | null | undefined,
  doc: StoredDocument,
  operation: OutboxEvent['operation'],
  eventId: string = randomUUID(),
): OutboxEvent {
  const payload: OutboxEvent = {
    event_id: eventId,
    schema_version: 1,
    source: 'synapsebase',
    resource_type: 'document',
    organization_id: collection?.org_id ?? null,
    account_id: collection?.account_id ?? null,
    collection_id: doc.collection_id,
    collection_name: collection?.name ?? '',
    document_id: doc.id,
    operation,
    version: doc.version,
    occurred_at: doc.updated_at,
  };
  if (operation !== 'delete') payload.data = doc.data;
  return payload;
}

async function collectionMeta(tx: any, collectionId: string): Promise<StoredCollection | null> {
  if (tx) {
    const rows = await tx.select().from(baseCollections).where(eq(baseCollections.id, collectionId)).limit(1);
    return rows[0] ? rowToCollection(rows[0]) : null;
  }
  return memCollections.get(collectionId) || null;
}

async function enqueueOutbox(tx: any, collectionId: string, doc: StoredDocument, operation: OutboxEvent['operation'], eventId?: string): Promise<void> {
  const meta = await collectionMeta(tx, collectionId);
  const payload = outboxPayload(meta, doc, operation, eventId);
  if (tx) {
    await tx.insert(baseOutbox).values({
      eventId: payload.event_id,
      orgId: payload.organization_id,
      accountId: payload.account_id,
      collectionId: payload.collection_id,
      collectionName: payload.collection_name,
      documentId: payload.document_id,
      operation: payload.operation,
      version: payload.version,
      occurredAt: new Date(payload.occurred_at),
      payload: payload as unknown as Record<string, unknown>,
    });
    return;
  }
  memOutbox.push({ ...payload, published_at: null, attempts: 0, last_error: null });
}


/** Enqueue a replayable snapshot of current documents. Deterministic event ids
 *  make repeated backfills idempotent; relay publishes them like live changes. */
export async function enqueueBackfill(collectionId: string, docs: StoredDocument[]): Promise<number> {
  if (!docs.length) return 0;
  const meta = await collectionMeta(db, collectionId);
  let inserted = 0;
  if (db) {
    await ensureTables();
    for (const doc of docs) {
      const eventId = `backfill:${collectionId}:${doc.id}:${doc.version}`;
      const payload = outboxPayload(meta, doc, 'create', eventId);
      const rows = await db.insert(baseOutbox).values({
        eventId,
        orgId: payload.organization_id,
        accountId: payload.account_id,
        collectionId,
        collectionName: payload.collection_name,
        documentId: doc.id,
        operation: 'create',
        version: doc.version,
        occurredAt: new Date(payload.occurred_at),
        payload: payload as unknown as Record<string, unknown>,
      }).onConflictDoNothing().returning({ eventId: baseOutbox.eventId });
      inserted += rows.length;
    }
    return inserted;
  }
  const existing = new Set(memOutbox.map((e) => e.event_id));
  for (const doc of docs) {
    const eventId = `backfill:${collectionId}:${doc.id}:${doc.version}`;
    if (existing.has(eventId)) continue;
    const payload = outboxPayload(meta, doc, 'create', eventId);
    memOutbox.push({ ...payload, published_at: null, attempts: 0, last_error: null });
    existing.add(eventId);
    inserted += 1;
  }
  return inserted;
}

/** Read the durable change feed. Deletes are tombstones, not omitted. */
export async function listOutboxChanges(
  collectionId: string,
  opts: { since: string; afterId?: string; limit: number },
): Promise<{ events: OutboxEvent[]; nextSince: string; nextAfter: string | null }> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseOutbox)
      .where(and(
        eq(baseOutbox.collectionId, collectionId),
        sql`${baseOutbox.occurredAt} >= ${new Date(opts.since)}`,
        opts.afterId ? sql`(${baseOutbox.occurredAt} > ${new Date(opts.since)} OR ${baseOutbox.eventId} > ${opts.afterId})` : sql`true`,
      ))
      .orderBy(asc(baseOutbox.occurredAt), asc(baseOutbox.eventId))
      .limit(opts.limit);
    const events = rows.map((r: any) => r.payload as OutboxEvent);
    const last = rows[rows.length - 1];
    return {
      events,
      nextSince: last ? new Date(last.occurredAt).toISOString() : opts.since,
      nextAfter: last ? String(last.eventId) : opts.afterId ?? null,
    };
  }
  const filtered = memOutbox.filter((e) => e.collection_id === collectionId
    && (e.occurred_at > opts.since || (e.occurred_at === opts.since && (!opts.afterId || e.event_id > opts.afterId))))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id))
    .slice(0, opts.limit);
  return {
    events: filtered.map((e) => ({ ...e, payload: undefined } as any)),
    nextSince: filtered.length ? filtered[filtered.length - 1].occurred_at : opts.since,
    nextAfter: filtered.length ? filtered[filtered.length - 1].event_id : opts.afterId ?? null,
  };
}


export async function outboxStats(): Promise<{ pending: number; oldest: string | null }> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      pending: sql<number>`count(*) filter (where ${baseOutbox.publishedAt} is null)::int`,
      oldest: sql<Date | null>`min(${baseOutbox.occurredAt}) filter (where ${baseOutbox.publishedAt} is null)`,
    }).from(baseOutbox);
    return {
      pending: Number(rows[0]?.pending) || 0,
      oldest: rows[0]?.oldest ? iso(rows[0].oldest) : null,
    };
  }
  const pending = memOutbox.filter((e) => !e.published_at);
  return { pending: pending.length, oldest: pending[0]?.occurred_at || null };
}

/** Relay helpers: unpublished rows in commit order. */
export async function listUnpublishedOutbox(limit = 100): Promise<Array<{ eventId: string; payload: OutboxEvent; attempts: number }>> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseOutbox)
      .where(isNull(baseOutbox.publishedAt))
      .orderBy(asc(baseOutbox.occurredAt), asc(baseOutbox.eventId))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((r: any) => ({ eventId: String(r.eventId), payload: r.payload as OutboxEvent, attempts: Number(r.attempts) || 0 }));
  }
  return memOutbox.filter((e) => !e.published_at).slice(0, limit).map((e) => ({ eventId: e.event_id, payload: e as OutboxEvent, attempts: e.attempts || 0 }));
}

export async function markOutboxPublished(eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  if (db) {
    await ensureTables();
    for (const eventId of eventIds) {
      await db.update(baseOutbox).set({ publishedAt: new Date(), lastError: null }).where(eq(baseOutbox.eventId, eventId));
    }
    return;
  }
  for (const e of memOutbox) if (eventIds.includes(e.event_id)) e.published_at = nowIso();
}

export async function recordOutboxFailure(eventId: string, error: unknown): Promise<void> {
  const message = String((error as Error)?.message || error).slice(0, 1000);
  if (db) {
    await ensureTables();
    await db.update(baseOutbox).set({
      attempts: sql`${baseOutbox.attempts} + 1`,
      lastError: message,
    }).where(eq(baseOutbox.eventId, eventId));
    return;
  }
  const e = memOutbox.find((x) => x.event_id === eventId);
  if (e) { e.attempts = (e.attempts || 0) + 1; e.last_error = message; }
}

// ---------- documents ----------

export async function createDocumentRec(
  collectionId: string,
  id: string,
  data: Record<string, unknown>,
): Promise<StoredDocument> {
  const rec: StoredDocument = {
    collection_id: collectionId,
    id,
    data: cloneJson(data),
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const rows = await tx.insert(baseDocuments).values({
        collectionId,
        id,
        data: rec.data,
        version: 1,
      }).onConflictDoNothing().returning();
      if (!rows[0]) throw new StoreError('conflict', `document '${id}' already exists`);
      const doc = rowToDocument(rows[0]);
      await enqueueOutbox(tx, collectionId, doc, 'create');
      return doc;
    });
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  if (docs.has(id)) throw new StoreError('conflict', `document '${id}' already exists`);
  memDocuments.set(collectionId, docs);
  docs.set(id, rec);
  await enqueueOutbox(null, collectionId, rec, 'create');
  return cloneJson(rec);
}

export async function getDocumentRec(collectionId: string, id: string): Promise<StoredDocument | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseDocuments)
      .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id)))
      .limit(1);
    return rows[0] ? rowToDocument(rows[0]) : null;
  }
  const rec = memDocuments.get(collectionId)?.get(id);
  return rec ? cloneJson(rec) : null;
}

/** List documents (optionally changed after `since`) for the in-service query engine. */
export async function listDocumentRecs(
  collectionId: string,
  opts: { since?: string; scanLimit?: number; afterId?: string } = {},
): Promise<StoredDocument[]> {
  const limit = Math.min(Math.max(Number(opts.scanLimit) || 10001, 1), 50001);
  if (db) {
    await ensureTables();
    const conds = [eq(baseDocuments.collectionId, collectionId)];
    if (opts.since) conds.push(gt(baseDocuments.updatedAt, new Date(opts.since)));
    if (opts.afterId) conds.push(gt(baseDocuments.id, opts.afterId));
    const base = db.select().from(baseDocuments).where(and(...conds));
    const rows = opts.since
      ? await base.orderBy(asc(baseDocuments.updatedAt), asc(baseDocuments.id)).limit(limit)
      : await base.orderBy(asc(baseDocuments.id)).limit(limit);
    return rows.map(rowToDocument);
  }
  let docs = [...(memDocuments.get(collectionId)?.values() || [])];
  if (opts.since) {
    const since = Date.parse(opts.since);
    docs = docs.filter((d) => Date.parse(d.updated_at) > since);
    docs.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
  } else {
    docs.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (opts.afterId) docs = docs.filter((d) => d.id > opts.afterId!);
  return docs.slice(0, limit).map(cloneJson);
}

/**
 * Page through a whole collection without buffering one giant query (#29).
 * Returns up to `max` documents; callers enforce their own limit. This keeps
 * the API process responsive for large collections instead of failing outright
 * at 10k rows.
 */
export async function listAllDocumentRecs(
  collectionId: string,
  opts: { max?: number; pageSize?: number } = {},
): Promise<StoredDocument[]> {
  const max = Math.min(Math.max(Number(opts.max) || 200_000, 1), 1_000_000);
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 5000, 1), 20_000);
  const out: StoredDocument[] = [];
  let afterId: string | undefined;
  while (out.length < max) {
    const page = await listDocumentRecs(collectionId, {
      afterId,
      scanLimit: Math.min(pageSize, max - out.length),
    });
    if (!page.length) break;
    out.push(...page);
    if (page.length < pageSize) break;
    afterId = page[page.length - 1].id;
  }
  return out;
}

/** One LIMIT/OFFSET page in id order. Postgres reads only the requested window
 *  instead of buffering every preceding row (#29). */
export async function listDocumentRecsPage(
  collectionId: string,
  opts: { limit: number; offset: number },
): Promise<StoredDocument[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  if (db) {
    await ensureTables();
    const rows = await pgQuery<any>(
      `SELECT collection_id, id, data, version, created_at, updated_at
         FROM synapseone_base_documents
        WHERE collection_id = $1
        ORDER BY id ASC
        LIMIT $2 OFFSET $3`,
      [collectionId, limit, offset],
    );
    return rows.map(pgRowToDocument);
  }
  return listDocumentRecs(collectionId, { scanLimit: offset + limit }).then((docs) =>
    docs.slice(offset, offset + limit),
  );
}

/**
 * Execute a parsed query in Postgres (#29): filter, order and pagination run
 * in the database; only the requested page is returned to the API process.
 * The in-memory path keeps using `applyQuery` in query.ts.
 */
export async function queryDocumentRecs(
  collectionId: string,
  spec: QuerySpec,
  mapping?: BaseMapping | null,
): Promise<QueryResult> {
  if (!db) {
    throw new Error('[base] queryDocumentRecs requires Postgres');
  }
  await ensureTables();
  const compiled = compileQuery(collectionId, spec);
  const countRows = await pgQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM synapseone_base_documents WHERE ${compiled.whereSql}`,
    compiled.whereParams,
  );
  const total = Number(countRows[0]?.n) || 0;
  const pageRows = await pgQuery<any>(
    `SELECT collection_id, id, data, version, created_at, updated_at
       FROM synapseone_base_documents
      WHERE ${compiled.whereSql}
      ORDER BY ${compiled.orderSql}
      LIMIT $${compiled.allParams.length + 1} OFFSET $${compiled.allParams.length + 2}`,
    [...compiled.allParams, spec.limit, spec.offset],
  );
  const docs = pageRows.map(pgRowToDocument);
  const views = docs.map((d) => ({
    id: d.id, data: d.data, version: d.version, created_at: d.created_at, updated_at: d.updated_at,
  }));
  return formatQueryPage(views, spec, mapping, total);
}

/** Exact document count for the collection (indexed count on Postgres). */
export async function countDocumentRecs(collectionId: string): Promise<number> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ n: sql<number>`count(*)::int` })
      .from(baseDocuments).where(eq(baseDocuments.collectionId, collectionId));
    return Number(rows[0]?.n) || 0;
  }
  return memDocuments.get(collectionId)?.size || 0;
}

export async function setDocumentRec(
  collectionId: string,
  id: string,
  data: Record<string, unknown>,
  opts: { merge?: boolean; ifVersion?: number } = {},
): Promise<{ doc: StoredDocument; created: boolean }> {
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const cur = await tx.select().from(baseDocuments)
        .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id)))
        .for('update')
        .limit(1);
      if (!cur[0]) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new StoreError('version_conflict', `document '${id}' does not exist`);
        }
        const rows = await tx.insert(baseDocuments).values({
          collectionId,
          id,
          data: cloneJson(data),
          version: 1,
        }).returning();
        const doc = rowToDocument(rows[0]);
        await enqueueOutbox(tx, collectionId, doc, 'create');
        return { doc, created: true };
      }
      const prev = rowToDocument(cur[0]);
      if (opts.ifVersion !== undefined && prev.version !== opts.ifVersion) {
        throw new StoreError('version_conflict', `document version is ${prev.version}, expected ${opts.ifVersion}`);
      }
      const next = opts.merge ? deepMerge(prev.data, data) : cloneJson(data);
      const rows = await tx.update(baseDocuments).set({
        data: next,
        version: prev.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id))).returning();
      const doc = rowToDocument(rows[0]);
      await enqueueOutbox(tx, collectionId, doc, 'update');
      return { doc, created: false };
    });
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  const cur = docs.get(id);
  if (!cur) {
    if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
      throw new StoreError('version_conflict', `document '${id}' does not exist`);
    }
    const rec: StoredDocument = {
      collection_id: collectionId,
      id,
      data: cloneJson(data),
      version: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    memDocuments.set(collectionId, docs);
    docs.set(id, rec);
    await enqueueOutbox(null, collectionId, rec, 'create');
    return { doc: cloneJson(rec), created: true };
  }
  if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
    throw new StoreError('version_conflict', `document version is ${cur.version}, expected ${opts.ifVersion}`);
  }
  const rec: StoredDocument = {
    ...cur,
    data: opts.merge ? deepMerge(cur.data, data) : cloneJson(data),
    version: cur.version + 1,
    updated_at: nowIso(),
  };
  docs.set(id, rec);
  await enqueueOutbox(null, collectionId, rec, 'update');
  return { doc: cloneJson(rec), created: false };
}

export async function deleteDocumentRec(
  collectionId: string,
  id: string,
  opts: { ifVersion?: number } = {},
): Promise<boolean> {
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      if (opts.ifVersion !== undefined) {
        const rows = await tx.delete(baseDocuments).where(and(
          eq(baseDocuments.collectionId, collectionId),
          eq(baseDocuments.id, id),
          eq(baseDocuments.version, opts.ifVersion),
        )).returning();
        if (rows.length > 0) {
          await enqueueOutbox(tx, collectionId, rowToDocument(rows[0]), 'delete');
          return true;
        }
        const exists = await tx.select().from(baseDocuments)
          .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id))).limit(1);
        if (exists[0]) throw new StoreError('version_conflict', `document version is ${exists[0].version}, expected ${opts.ifVersion}`);
        throw new StoreError('not_found', `document '${id}' not found`);
      }
      const rows = await tx.delete(baseDocuments).where(and(
        eq(baseDocuments.collectionId, collectionId),
        eq(baseDocuments.id, id),
      )).returning();
      if (!rows.length) return false;
      await enqueueOutbox(tx, collectionId, rowToDocument(rows[0]), 'delete');
      return true;
    });
  }
  const docs = memDocuments.get(collectionId);
  const cur = docs?.get(id);
  if (!cur) throw new StoreError('not_found', `document '${id}' not found`);
  if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
    throw new StoreError('version_conflict', `document version is ${cur.version}, expected ${opts.ifVersion}`);
  }
  const ok = !!docs!.delete(id);
  if (ok) await enqueueOutbox(null, collectionId, cur, 'delete');
  return ok;
}

export async function incrementDocumentRec(
  collectionId: string,
  id: string,
  field: string,
  by: number,
  opts: { ifVersion?: number } = {},
): Promise<StoredDocument> {
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const cur = await tx.select().from(baseDocuments)
        .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id)))
        .for('update')
        .limit(1);
      let prev: StoredDocument;
      let created = false;
      if (!cur[0]) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new StoreError('version_conflict', `document '${id}' does not exist`);
        }
        prev = { collection_id: collectionId, id, data: {}, version: 0, created_at: nowIso(), updated_at: nowIso() };
        created = true;
      } else {
        prev = rowToDocument(cur[0]);
        if (opts.ifVersion !== undefined && prev.version !== opts.ifVersion) {
          throw new StoreError('version_conflict', `document version is ${prev.version}, expected ${opts.ifVersion}`);
        }
      }
      const current = getPath(prev.data, field);
      if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current))) {
        throw new StoreError('invalid', `field '${field}' is not numeric`);
      }
      const next = deepMerge(prev.data, {});
      setPath(next, field, (typeof current === 'number' ? current : 0) + by);
      if (created) {
        const rows = await tx.insert(baseDocuments).values({
          collectionId,
          id,
          data: next,
          version: 1,
        }).returning();
        const doc = rowToDocument(rows[0]);
        await enqueueOutbox(tx, collectionId, doc, 'create');
        return doc;
      }
      const rows = await tx.update(baseDocuments).set({
        data: next,
        version: prev.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id))).returning();
      const doc = rowToDocument(rows[0]);
      await enqueueOutbox(tx, collectionId, doc, 'update');
      return doc;
    });
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  const cur = docs.get(id);
  if (cur && opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
    throw new StoreError('version_conflict', `document version is ${cur.version}, expected ${opts.ifVersion}`);
  }
  const current = cur ? getPath(cur.data, field) : undefined;
  if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current))) {
    throw new StoreError('invalid', `field '${field}' is not numeric`);
  }
  const data = deepMerge(cur?.data || {}, {});
  setPath(data, field, (typeof current === 'number' ? current : 0) + by);
  const rec: StoredDocument = cur
    ? { ...cur, data, version: cur.version + 1, updated_at: nowIso() }
    : { collection_id: collectionId, id, data, version: 1, created_at: nowIso(), updated_at: nowIso() };
  memDocuments.set(collectionId, docs);
  docs.set(id, rec);
  await enqueueOutbox(null, collectionId, rec, cur ? 'update' : 'create');
  return cloneJson(rec);
}

export async function documentStatsRec(collectionId: string): Promise<{ documents: number; bytes: number; lastUpdatedAt: string | null }> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      documents: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(octet_length(${baseDocuments.data}::text)), 0)::bigint`,
      lastUpdatedAt: sql<Date | null>`max(${baseDocuments.updatedAt})`,
    }).from(baseDocuments).where(eq(baseDocuments.collectionId, collectionId));
    const row = rows[0] || {} as any;
    return {
      documents: Number(row.documents) || 0,
      bytes: Number(row.bytes) || 0,
      lastUpdatedAt: row.lastUpdatedAt ? iso(row.lastUpdatedAt) : null,
    };
  }
  const docs = [...(memDocuments.get(collectionId)?.values() || [])];
  let bytes = 0;
  let last: string | null = null;
  for (const d of docs) {
    bytes += Buffer.byteLength(JSON.stringify(d.data), 'utf8');
    if (!last || d.updated_at > last) last = d.updated_at;
  }
  return { documents: docs.length, bytes, lastUpdatedAt: last };
}

/** All documents matching a filter, pushed down to Postgres when available.
 *  Used by vector search, where scoring still happens in the service but the
 *  metadata filter narrows candidates in SQL (#29). */
export async function listDocumentRecsMatching(
  collectionId: string,
  where: QuerySpec['where'],
  max = 200_000,
): Promise<StoredDocument[]> {
  const limit = Math.min(Math.max(Number(max) || 200_000, 1), 1_000_000);
  if (!db) return listAllDocumentRecs(collectionId, { max: limit });
  const compiled = compileQuery(collectionId, {
    where,
    orderBy: [],
    limit,
    offset: 0,
    as: 'data',
  });
  const rows = await pgQuery<any>(
    `SELECT collection_id, id, data, version, created_at, updated_at
       FROM synapseone_base_documents
      WHERE ${compiled.whereSql}
      ORDER BY id ASC
      LIMIT $${compiled.allParams.length + 1}`,
    [...compiled.allParams, limit],
  );
  return rows.map(pgRowToDocument);
}

/** Vector search over collection documents with metadata filtering. */
export async function vectorSearchRec(
  collectionId: string,
  spec: VectorSearchSpec,
  mapping?: BaseMapping | null,
  scanLimit = 200_000,
): Promise<VectorSearchResult> {
  const docs = await listDocumentRecsMatching(collectionId, spec.where, scanLimit);
  return applyVectorSearch(docs, spec, mapping);
}

/** Test helper: wipe in-memory state (no effect when Postgres is configured). */
export function __clearBaseMem(): void {
  memCollections.clear();
  memDocuments.clear();
  memOutbox.length = 0;
}
