// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Tenant-scoped search over SynapseBase documents (#46).
 *
 * The index is a denormalised projection: collection/tenant/ACL/text plus a
 * deterministic local embedding. It is rebuilt by POST /v1/search/reindex and
 * every query re-checks tenant and document ACLs — the index is never a way
 * around collection scoping.
 */
import { createHash } from 'crypto';
import { pgQuery, useDb, type StoredCollection, type StoredDocument } from './store';

export interface SearchRecord {
  id: string;
  collection_id: string;
  collection_name: string;
  document_id: string;
  org_id: string | null;
  account_id: string | null;
  title: string;
  body: string;
  acl: string[];
  embedding: number[];
  /** Real 384-d embedding from Tier-1 inference (pgvector); absent in the memory fallback. */
  vector?: number[] | null;
  metadata: Record<string, unknown>;
  updated_at: string;
}

const DIM = 64;
const memIndex = new Map<string, SearchRecord>();

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'with', 'will', 'you', 'your',
]);

export function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .slice(0, 4000);
}

/** Deterministic feature-hashing embedding (no network, stable across runs). */
export function embed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  for (const token of tokenize(text)) {
    const h = createHash('sha256').update(token).digest();
    const idx = h.readUInt32BE(0) % DIM;
    const sign = (h[4] & 1) === 0 ? 1 : -1;
    vec[idx] += sign * (1 + Math.log(1 + token.length));
  }
  const norm = Math.sqrt(vec.reduce((n, v) => n + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

const REAL_DIM = 384;
let vectorReady: boolean | null = null;

/** True when the search table has a pgvector column + ANN index. */
export async function ensureVectorColumn(): Promise<boolean> {
  if (!useDb()) return false;
  if (vectorReady !== null) return vectorReady;
  try {
    await pgQuery('CREATE EXTENSION IF NOT EXISTS vector');
    await pgQuery(`ALTER TABLE synapseone_search_index ADD COLUMN IF NOT EXISTS embedding_vec vector(${REAL_DIM})`);
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_search_embedding_vec ON synapseone_search_index USING hnsw (embedding_vec vector_cosine_ops)');
    vectorReady = true;
  } catch (error) {
    vectorReady = false;
    console.warn('[base][search] pgvector unavailable, using hashed embeddings:', (error as Error).message);
  }
  return vectorReady;
}

/** Embed text with the Tier-1 inference service (all-MiniLM-L6-v2, 384-d). */
export async function embedTextAsync(text: string): Promise<number[] | null> {
  const base = String(process.env.INFERENCE_SERVICE_URL || '').replace(/\/$/, '');
  if (!base) return null;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.SYNAPSEONE_API_KEY) headers['x-api-key'] = process.env.SYNAPSEONE_API_KEY;
    if (process.env.SYNAPSEONE_INTERNAL_SECRET) headers['x-synapseone-internal'] = process.env.SYNAPSEONE_INTERNAL_SECRET;
    const response = await fetch(`${base}/v1/inference/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: String(text || '').slice(0, 8000) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const body: any = await response.json();
    const vector = body?.data?.[0]?.embedding ?? body?.embeddings?.[0] ?? body?.embedding;
    if (!Array.isArray(vector) || vector.length !== REAL_DIM) return null;
    return vector.map(Number);
  } catch {
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

function recordId(collectionId: string, documentId: string): string {
  return `${collectionId}:${documentId}`;
}

function textOf(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data).slice(0, 20_000);
  } catch {
    return '';
  }
}

function titleOf(document: StoredDocument): string {
  const data = document.data || {};
  for (const key of ['title', 'name', 'label', 'subject', 'headline']) {
    const value = (data as any)[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
  }
  return document.id;
}

function aclOf(data: Record<string, unknown>): string[] {
  const raw = (data as any).acl ?? (data as any)._acl ?? (data as any).visibility;
  const out = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, 100)) if (typeof item === 'string' && item.trim()) out.add(item.trim().slice(0, 128));
  } else if (typeof raw === 'string' && raw.trim()) {
    for (const item of raw.split(',')) if (item.trim()) out.add(item.trim().slice(0, 128));
  }
  if ((data as any).public === true) out.add('*');
  return [...out];
}

export function projectDocument(collection: StoredCollection, document: StoredDocument): SearchRecord {
  const body = textOf(document.data);
  return {
    id: recordId(collection.id, document.id),
    collection_id: collection.id,
    collection_name: collection.name,
    document_id: document.id,
    org_id: collection.org_id,
    account_id: collection.account_id,
    title: titleOf(document),
    body,
    acl: aclOf(document.data),
    embedding: embed(`${titleOf(document)} ${body}`),
    metadata: {
      type: typeof (document.data as any).type === 'string' ? (document.data as any).type : collection.name,
      status: typeof (document.data as any).status === 'string' ? (document.data as any).status : null,
      version: document.version,
    },
    updated_at: document.updated_at,
  };
}

/** Replace one collection's index projection. Safe to re-run: rows for
 *  documents that no longer exist are removed, existing rows are upserted. */
export async function replaceCollectionIndex(collection: StoredCollection, documents: StoredDocument[]): Promise<number> {
  const records = documents.map((doc) => projectDocument(collection, doc));
  const ids = records.map((r) => r.id);
  if (useDb()) {
    const vectors = await ensureVectorColumn();
    await pgQuery('DELETE FROM synapseone_search_index WHERE collection_id = $1 AND id <> ALL($2::text[])', [collection.id, ids]);
    for (const r of records) {
      const real = vectors ? await embedTextAsync(`${r.title} ${r.body}`) : null;
      await pgQuery(
        `INSERT INTO synapseone_search_index
           (id, collection_id, collection_name, document_id, org_id, account_id, title, body, acl, embedding, metadata, updated_at, indexed_at, embedding_vec)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::timestamptz,now(),$13::vector)
         ON CONFLICT (id) DO UPDATE SET
           collection_name = EXCLUDED.collection_name, org_id = EXCLUDED.org_id, account_id = EXCLUDED.account_id,
           title = EXCLUDED.title, body = EXCLUDED.body, acl = EXCLUDED.acl,
           embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at, indexed_at = now(), embedding_vec = EXCLUDED.embedding_vec`,
        [
          r.id, r.collection_id, r.collection_name, r.document_id, r.org_id, r.account_id, r.title, r.body,
          JSON.stringify(r.acl), JSON.stringify(r.embedding), JSON.stringify(r.metadata),
          r.updated_at, real ? JSON.stringify(real) : null,
        ],
      );
    }
  }
  for (const [id, rec] of memIndex) {
    if (rec.collection_id === collection.id && !ids.includes(id)) memIndex.delete(id);
  }
  for (const r of records) memIndex.set(r.id, r);
  return records.length;
}

/** Remove a collection projection (collection delete / tenant cleanup). */
export async function dropCollectionIndex(collectionId: string): Promise<void> {
  if (useDb()) await pgQuery('DELETE FROM synapseone_search_index WHERE collection_id = $1', [collectionId]);
  for (const [id, rec] of memIndex) if (rec.collection_id === collectionId) memIndex.delete(id);
}

/** Index one document immediately after a write (upsert semantics). */
export async function upsertDocumentIndex(collection: StoredCollection, document: StoredDocument): Promise<void> {
  const r = projectDocument(collection, document);
  memIndex.set(r.id, r);
  if (useDb()) {
    const vectors = await ensureVectorColumn();
    const real = vectors ? await embedTextAsync(`${r.title} ${r.body}`) : null;
    await pgQuery(
      `INSERT INTO synapseone_search_index
         (id, collection_id, collection_name, document_id, org_id, account_id, title, body, acl, embedding, metadata, updated_at, indexed_at, embedding_vec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::timestamptz,now(),$13::vector)
       ON CONFLICT (id) DO UPDATE SET
         collection_name = EXCLUDED.collection_name, org_id = EXCLUDED.org_id, account_id = EXCLUDED.account_id,
         title = EXCLUDED.title, body = EXCLUDED.body, acl = EXCLUDED.acl,
         embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at, indexed_at = now(), embedding_vec = EXCLUDED.embedding_vec`,
      [r.id, r.collection_id, r.collection_name, r.document_id, r.org_id, r.account_id, r.title, r.body,
        JSON.stringify(r.acl), JSON.stringify(r.embedding), JSON.stringify(r.metadata), r.updated_at,
        real ? JSON.stringify(real) : null],
    );
  }
}

/** Remove one document from the index after a delete. */
export async function removeDocumentIndex(collectionId: string, documentId: string): Promise<void> {
  const id = recordId(collectionId, documentId);
  memIndex.delete(id);
  if (useDb()) await pgQuery('DELETE FROM synapseone_search_index WHERE id = $1', [id]);
}

/**
 * Collection-name prefixes reserved for operator/machine credentials
 * (`SYNAPSEONE_BASE_MACHINE_COLLECTION_PREFIXES`, default empty). Memoised per
 * process; invalid entries are ignored rather than widening access.
 */
let cachedMachinePrefixes: string[] | null = null;
export function machineCollectionPrefixes(): string[] {
  if (cachedMachinePrefixes === null) {
    cachedMachinePrefixes = String(process.env.SYNAPSEONE_BASE_MACHINE_COLLECTION_PREFIXES || '')
      .split(',')
      .map((value) => value.trim().replace(/\*+$/, '').trim().toLowerCase())
      .filter((value) => value.length > 0 && value.length <= 40 && /^[a-z0-9_-]+$/.test(value))
      .filter((value, index, all) => all.indexOf(value) === index);
  }
  return cachedMachinePrefixes;
}

/** Machine-only collection names (prefix match, case-insensitive). */
export function isReservedCollection(name: string): boolean {
  const prefixes = machineCollectionPrefixes();
  if (!prefixes.length) return false;
  const lower = String(name || '').toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

export interface SearchScope {
  platform: boolean;
  orgId?: string | null;
  accountId?: string | null;
  subject?: string | null;
  /** Operator/machine caller; reserved collections stay visible only to it. */
  machine?: boolean;
}

export interface SearchOptions {
  mode?: 'fulltext' | 'semantic' | 'hybrid';
  collection?: string;
  collections?: string[];
  limit?: number;
  cursor?: string | null;
  filters?: Record<string, string | undefined>;
}

function scopedRecords(scope: SearchScope): SearchRecord[] {
  let rows = [...memIndex.values()];
  if (useDb()) {
    // The memory map is a write-through cache; on a cold process the rows are
    // loaded from Postgres so search works immediately after a restart.
    // (Handled asynchronously by loadRecords below.)
  }
  if (!scope.platform) {
    rows = rows.filter((r) => {
      if (scope.orgId && r.org_id === scope.orgId) return true;
      if (scope.accountId && r.account_id === scope.accountId) return true;
      return false;
    });
  }
  return rows;
}

async function loadRecords(scope: SearchScope): Promise<SearchRecord[]> {
  if (!useDb()) return scopedRecords(scope);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (!scope.platform) {
    if (scope.orgId) { params.push(scope.orgId); conds.push(`org_id = $${params.length}`); }
    else if (scope.accountId) { params.push(scope.accountId); conds.push(`account_id = $${params.length}`); }
    else return [];
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await pgQuery<any>(`SELECT * FROM synapseone_search_index ${where} ORDER BY updated_at DESC LIMIT 50000`, params);
  return rows.map((r) => ({
    id: String(r.id),
    collection_id: String(r.collection_id),
    collection_name: String(r.collection_name || ''),
    document_id: String(r.document_id),
    org_id: r.org_id ?? null,
    account_id: r.account_id ?? null,
    title: String(r.title || ''),
    body: String(r.body || ''),
    acl: Array.isArray(r.acl) ? r.acl : [],
    embedding: Array.isArray(r.embedding) ? r.embedding : [],
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || ''),
  }));
}

function aclAllows(record: SearchRecord, scope: SearchScope): boolean {
  if (scope.platform) return true;
  if (!record.acl.length) return true; // no per-document ACL -> tenant scope only
  if (record.acl.includes('*')) return true;
  if (scope.subject && record.acl.includes(scope.subject)) return true;
  if (scope.orgId && record.acl.includes(`org:${scope.orgId}`)) return true;
  if (scope.accountId && record.acl.includes(`account:${scope.accountId}`)) return true;
  return false;
}

function snippet(text: string, terms: string[]): { snippet: string; highlights: string[] } {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { snippet: '', highlights: [] };
  const lower = clean.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  const start = Math.max(0, at - 70);
  const raw = clean.slice(start, start + 240);
  const highlights: string[] = [];
  let marked = raw;
  for (const term of [...terms].sort((a, b) => b.length - a.length).slice(0, 8)) {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    if (re.test(marked)) {
      highlights.push(term);
      marked = marked.replace(re, '<mark>$1</mark>');
    }
  }
  return { snippet: marked, highlights };
}

function scoreFulltext(record: SearchRecord, terms: string[]): number {
  if (!terms.length) return 0;
  const title = record.title.toLowerCase();
  const body = record.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let tf = 0;
    let from = 0;
    while (true) {
      const idx = body.indexOf(term, from);
      if (idx < 0) break;
      tf++;
      from = idx + term.length;
      if (tf > 50) break;
    }
    const titleHits = title.split(term).length - 1;
    score += tf * 1.0 + titleHits * 4.0;
    if (title.includes(term)) score += 2.0;
  }
  const lengthPenalty = Math.sqrt(Math.max(1, record.body.length / 200));
  const phrase = record.body.toLowerCase().includes(terms.join(' ')) ? 2.5 : 0;
  return Number(((score / lengthPenalty) + phrase).toFixed(6));
}

export interface SearchHit {
  id: string;
  collectionId: string;
  documentId: string;
  title: string;
  snippet: string;
  highlights: string[];
  score: number;
  mode: string;
  acl: string[];
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface SearchResponse {
  items: SearchHit[];
  total: number;
  nextCursor: string | null;
  facets: Record<string, Array<{ value: string; count: number }>>;
  mode: string;
  index: { indexed: number; updatedAt: string | null };
}

export async function searchRecords(scope: SearchScope, query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const mode = opts.mode === 'semantic' || opts.mode === 'hybrid' ? opts.mode : 'fulltext';
  const terms = tokenize(query);
  if (!terms.length && mode !== 'semantic') {
    return { items: [], total: 0, nextCursor: null, facets: {}, mode, index: { indexed: 0, updatedAt: null } };
  }
  let rows = await loadRecords(scope);
  rows = rows.filter((r) => aclAllows(r, scope));
  if (!scope.machine) rows = rows.filter((r) => !isReservedCollection(r.collection_name));
  if (opts.collection) rows = rows.filter((r) => r.collection_name === opts.collection || r.collection_id === opts.collection);
  if (Array.isArray(opts.collections) && opts.collections.length) {
    const wanted = new Set(opts.collections);
    rows = rows.filter((r) => wanted.has(r.collection_name) || wanted.has(r.collection_id));
  }
  for (const [key, value] of Object.entries(opts.filters || {})) {
    if (!value) continue;
    if (key === 'status' || key === 'type') {
      rows = rows.filter((r) => String(r.metadata[key] || '') === String(value));
    }
  }

  const qvec = embed(terms.join(' '));
  const qvecReal = mode === 'semantic' || mode === 'hybrid' ? await embedTextAsync(query) : null;
  const scored = rows.map((record) => {
    const full = scoreFulltext(record, terms);
    const semantic = mode === 'semantic' || mode === 'hybrid'
      ? (qvecReal && record.vector && record.vector.length === qvecReal.length
        ? Math.max(0, cosine(qvecReal, record.vector))
        : Math.max(0, cosine(qvec, record.embedding)))
      : 0;
    const score = mode === 'semantic'
      ? semantic
      : mode === 'hybrid'
        ? Number((full * 0.65 + semantic * 35).toFixed(6))
        : full;
    const snip = snippet(`${record.title} ${record.body}`, terms);
    return {
      id: record.id,
      collectionId: record.collection_id,
      documentId: record.document_id,
      title: record.title,
      snippet: snip.snippet,
      highlights: snip.highlights,
      score,
      mode,
      acl: record.acl,
      metadata: { ...record.metadata, collection: record.collection_name || record.collection_id } as Record<string, unknown>,
      updatedAt: record.updated_at,
      _semantic: semantic,
    };
  }).filter((hit) => hit.score > 0 || (mode === 'semantic' && hit._semantic > 0));

  scored.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));

  const facets: Record<string, Array<{ value: string; count: number }>> = {};
  const addFacet = (name: string, value: string) => {
    const list = facets[name] || (facets[name] = []);
    const found = list.find((f) => f.value === value);
    if (found) found.count++;
    else list.push({ value, count: 1 });
  };
  for (const hit of scored.slice(0, 5000)) {
    addFacet('collection', String(hit.metadata.collection));
    if (hit.metadata.type) addFacet('type', String(hit.metadata.type));
    if (hit.metadata.status) addFacet('status', String(hit.metadata.status));
  }
  for (const list of Object.values(facets)) list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const offset = decodeCursor(opts.cursor);
  const page = scored.slice(offset, offset + limit).map(({ _semantic, ...hit }) => hit);
  const next = offset + limit < scored.length ? encodeCursor(offset + limit) : null;
  return {
    items: page,
    total: scored.length,
    nextCursor: next,
    facets,
    mode,
    index: {
      indexed: rows.length,
      updatedAt: scored[0]?.updatedAt || null,
    },
  };
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: Math.max(0, offset) })).toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isInteger(parsed?.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

export async function indexStatus(scope: SearchScope): Promise<{ indexed: number; collections: number; updatedAt: string | null }> {
  const rows = await loadRecords(scope);
  const collections = new Set(rows.map((r) => r.collection_id));
  let updatedAt: string | null = null;
  for (const r of rows) if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
  return { indexed: rows.length, collections: collections.size, updatedAt };
}

export function __clearSearchMem(): void {
  memIndex.clear();
}
