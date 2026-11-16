// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Optional L2 read-through cache for SynapseBase document GETs.
 *
 * The cache is Synapse Faststore (Valkey) reached over the internal network.
 * Every operation is fail-open: a cache timeout, 5xx or malformed value falls
 * back to Postgres and never fails the request. Cache keys are namespaced by
 * Faststore's tenant layer, so a document cannot be served across tenants.
 */
import type { Request } from 'express';

export interface CachedDocument {
  collection_id: string;
  id: string;
  data: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

const FASTSTORE_URL = String(process.env.FASTSTORE_SERVICE_URL || '').trim().replace(/\/$/, '');
const INTERNAL_SECRET = String(process.env.SYNAPSEONE_INTERNAL_SECRET || '');
const TTL_SECONDS = clampInt(process.env.BASE_CACHE_TTL_SECONDS, 60, 1, 3600);
const TIMEOUT_MS = clampInt(process.env.BASE_CACHE_TIMEOUT_MS, 250, 25, 5000);
const KEY_PREFIX = 'base:doc:v1';

const metrics = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 };
let warned = false;
// After a few consecutive failures, stop paying the timeout on every request
// for a short cooldown. The cache is an optimization; Postgres is the source.
const CIRCUIT_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
let consecutiveErrors = 0;
let circuitOpenUntil = 0;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[base][cache] ${message}; falling back to Postgres`);
}

export function cacheEnabled(): boolean {
  return Boolean(FASTSTORE_URL);
}

export function documentCacheKey(collectionId: string, docId: string): string {
  return `${KEY_PREFIX}:${collectionId}:${docId}`;
}

export interface CacheMetrics {
  enabled: boolean;
  ttlSeconds: number;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
}

export function cacheMetrics(): CacheMetrics {
  return { enabled: cacheEnabled(), ttlSeconds: TTL_SECONDS, ...metrics };
}

/** Test helper: reset counters and the one-shot warning flag. */
export function __resetCacheMetrics(): void {
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.sets = 0;
  metrics.deletes = 0;
  metrics.errors = 0;
  warned = false;
  consecutiveErrors = 0;
  circuitOpenUntil = 0;
}

const TENANT_HEADERS: Array<[string, string]> = [
  ['x-synapseone-org', 'x-synapsedx-org'],
  ['x-synapseone-account', 'x-synapsedx-account'],
  ['x-synapseone-user', 'x-synapsedx-user'],
  ['x-synapseone-kind', 'x-synapsedx-kind'],
  ['x-synapseone-tenant', 'x-synapsedx-tenant'],
];

/** Forward only the caller's tenant scope; never the inbound auth material. */
function tenantHeaders(req: Pick<Request, 'headers'>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [primary, legacy] of TENANT_HEADERS) {
    const raw = req.headers[primary] ?? req.headers[legacy];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && value.length <= 128 && !/[\r\n\x00-\x1f\x7f]/.test(value)) out[primary] = value;
  }
  const scoped = out['x-synapseone-org'] || out['x-synapseone-account'] || out['x-synapseone-user'] || out['x-synapseone-tenant'];
  return scoped ? out : null;
}

async function cacheRequest(path: string, init: RequestInit, headers: Record<string, string>): Promise<Response | null> {
  if (!FASTSTORE_URL || Date.now() < circuitOpenUntil) return null;
  const merged = new Headers(init.headers as HeadersInit);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set('accept', 'application/json');
  if (INTERNAL_SECRET) merged.set('x-synapseone-internal', INTERNAL_SECRET);
  try {
    const res = await fetch(`${FASTSTORE_URL}${path}`, {
      ...init,
      headers: merged,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 500) {
      consecutiveErrors++;
      if (consecutiveErrors >= CIRCUIT_FAILURES) circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    } else {
      consecutiveErrors = 0;
    }
    return res;
  } catch (error: any) {
    metrics.errors++;
    consecutiveErrors++;
    if (consecutiveErrors >= CIRCUIT_FAILURES) circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    warnOnce(`request failed (${error?.name || 'error'})`);
    return null;
  }
}

function isCachedDocument(value: unknown, collectionId: string, docId: string): value is CachedDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<CachedDocument>;
  return doc.collection_id === collectionId
    && doc.id === docId
    && typeof doc.version === 'number'
    && typeof doc.data === 'object' && doc.data !== null
    && typeof doc.created_at === 'string'
    && typeof doc.updated_at === 'string';
}

/** Returns the cached document, or null on miss/disabled/any cache failure. */
export async function getCachedDocument(
  req: Pick<Request, 'headers'>,
  collectionId: string,
  docId: string,
): Promise<CachedDocument | null> {
  if (!cacheEnabled()) return null;
  const headers = tenantHeaders(req);
  if (!headers) return null;
  const key = documentCacheKey(collectionId, docId);
  const res = await cacheRequest(`/v1/faststore/keys/${encodeURIComponent(key)}`, { method: 'GET' }, headers);
  if (!res) return null;
  if (res.status === 404) {
    metrics.misses++;
    await res.text().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    metrics.errors++;
    warnOnce(`read returned ${res.status}`);
    await res.text().catch(() => undefined);
    return null;
  }
  try {
    const body: any = await res.json();
    const value = body?.value;
    if (!isCachedDocument(value, collectionId, docId)) {
      metrics.errors++;
      warnOnce('cached value has the wrong shape');
      return null;
    }
    metrics.hits++;
    return value;
  } catch {
    metrics.errors++;
    warnOnce('cached value is not valid JSON');
    return null;
  }
}

/** Best-effort cache fill; failures are counted but never surfaced. */
export async function setCachedDocument(
  req: Pick<Request, 'headers'>,
  doc: CachedDocument,
): Promise<void> {
  if (!cacheEnabled()) return;
  const headers = tenantHeaders(req);
  if (!headers) return;
  const key = documentCacheKey(doc.collection_id, doc.id);
  const res = await cacheRequest(`/v1/faststore/keys/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ value: doc, ttlSeconds: TTL_SECONDS }),
  }, headers);
  if (!res) return;
  if (res.ok) {
    metrics.sets++;
  } else {
    metrics.errors++;
    warnOnce(`write returned ${res.status}`);
  }
  await res.text().catch(() => undefined);
}

/** Best-effort invalidation after a write. Missing keys are not an error. */
export async function deleteCachedDocument(
  req: Pick<Request, 'headers'>,
  collectionId: string,
  docId: string,
): Promise<void> {
  if (!cacheEnabled()) return;
  const headers = tenantHeaders(req);
  if (!headers) return;
  const key = documentCacheKey(collectionId, docId);
  const res = await cacheRequest(`/v1/faststore/keys/${encodeURIComponent(key)}`, { method: 'DELETE' }, headers);
  if (!res) return;
  if (res.ok || res.status === 404) metrics.deletes++;
  else {
    metrics.errors++;
    warnOnce(`delete returned ${res.status}`);
  }
  await res.text().catch(() => undefined);
}

/** Invalidate up to 100 documents with one Faststore batch call. */
export async function deleteCachedDocuments(
  req: Pick<Request, 'headers'>,
  collectionId: string,
  docIds: string[],
): Promise<void> {
  if (!cacheEnabled() || !docIds.length) return;
  const headers = tenantHeaders(req);
  if (!headers) return;
  const operations = docIds.slice(0, 100).map((docId) => ({ op: 'delete', key: documentCacheKey(collectionId, docId) }));
  const res = await cacheRequest('/v1/faststore/batch', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ operations }),
  }, headers);
  if (!res) return;
  if (res.ok) metrics.deletes += operations.length;
  else {
    metrics.errors++;
    warnOnce(`batch delete returned ${res.status}`);
  }
  await res.text().catch(() => undefined);
}
