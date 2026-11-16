// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseOCS — bucket-aware object cloud storage (legacy /v1/storage kept).
 *
 * Direct binary upload/download (no base64 in JSON), presigned URLs (S3),
 * multipart uploads, checksums, size/type limits and per-tenant quotas.
 * Backend: filesystem for dev/single-node, S3-compatible for production.
 */
import './env-compat';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import { createBackend, checksumHex, validateKey, type Backend } from './backend';
import { registerOcsRoutes } from './ocs';

dotenv.config();

const PORT = Number(process.env.PORT || 4010);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_OBJECT_BYTES = Math.min(Math.max(Number(process.env.STORAGE_MAX_OBJECT_BYTES || 25 * 1024 * 1024), 1024), 5 * 1024 * 1024 * 1024);
const TENANT_QUOTA_BYTES = Math.min(Math.max(Number(process.env.STORAGE_TENANT_QUOTA_BYTES || 5 * 1024 * 1024 * 1024), 1024), 1024 ** 4);
const ALLOWED_TYPES = (process.env.STORAGE_ALLOWED_CONTENT_TYPES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

export function principalFromHeaders(req: express.Request): Principal | null {
  const h = (n: string): string => {
    const legacy = n.startsWith('x-synapseone-') ? n.replace('x-synapseone-', 'x-synapsedx-') : n;
    const v = req.headers[n] ?? req.headers[legacy];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  const user = h('x-synapseone-user');
  if (user) return { sub: user, org: clean(h('x-synapseone-org')), account: clean(h('x-synapseone-account')), kind: clean(h('x-synapseone-kind')) };
  const kind = clean(h('x-synapseone-kind'));
  const account = clean(h('x-synapseone-account'));
  const org = clean(h('x-synapseone-org'));
  if (kind || account || org) {
    return { sub: account ? `apikey:${account}` : `${kind || 'principal'}:unknown`, org, account, kind: kind || 'apikey' };
  }
  return null;
}

/** Canonical tenant: org-wide first, then account, then user (#28). */
export function resolveTenant(req: express.Request): string | null {
  const p = principalFromHeaders(req);
  if (p?.org) return `org:${p.org}`;
  if (p?.account) return `account:${p.account}`;
  if (p?.sub) return `user:${p.sub}`;
  const raw = (req.headers['x-synapseone-tenant'] ?? req.headers['x-synapsedx-tenant'] ?? req.query.tenant) as string | string[] | undefined;
  const explicit = Array.isArray(raw) ? raw[0] : raw;
  if (explicit && /^[A-Za-z0-9_:.-]{1,128}$/.test(explicit)) return explicit;
  return null;
}

function verifyInternal(req: express.Request): boolean {
  const secret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  if (!secret) return false;
  const h = req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal'];
  const val = (Array.isArray(h) ? h[0] : h || '').trim();
  if (!val || val.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(val), Buffer.from(secret));
  } catch {
    return false;
  }
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (!env.SYNAPSEONE_INTERNAL_SECRET) throw new Error('[storage] SYNAPSEONE_INTERNAL_SECRET must be set in production.');
  if (!env.STORAGE_BACKEND) throw new Error('[storage] STORAGE_BACKEND must be set in production (fs|s3).');
  if (env.STORAGE_BACKEND === 's3') {
    for (const k of ['STORAGE_S3_ENDPOINT', 'STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY']) {
      if (!env[k]) throw new Error(`[storage] ${k} must be set for the S3 backend.`);
    }
  }
  const origins = (env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length) throw new Error('[storage] CORS_ORIGIN must be set in production.');
}

function keyFromReq(req: express.Request): string {
  const raw = (req.params as any)[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function metaHeaders(meta: { key: string; size: number; etag: string; checksumSha256?: string; contentType: string; createdAt: string; updatedAt: string }): Record<string, string> {
  return {
    'Content-Type': meta.contentType,
    'Content-Length': String(meta.size),
    ETag: `"${meta.etag}"`,
    'x-object-key': meta.key,
    'x-object-created-at': meta.createdAt,
    'x-object-updated-at': meta.updatedAt,
    ...(meta.checksumSha256 ? { 'x-object-checksum-sha256': meta.checksumSha256 } : {}),
  };
}

export function createApp(backend: Backend = createBackend()): express.Express {
  assertProductionConfig();
  const app = express();
  app.disable('x-powered-by');
  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length && !IS_PROD) console.warn('[storage][security] CORS_ORIGIN not set — allowing all origins (dev default).');
  app.use(cors(origins.length ? { origin: origins } : undefined));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({
    service: 'storage',
    product: 'SynapseOCS',
    status: 'ok',
    version: VERSION,
    backend: backend.name,
    capabilities: { buckets: true, objects: true, presign: Boolean(backend.presign), multipart: Boolean(backend.createMultipart) },
    time: new Date().toISOString(),
  }));
  app.get('/metrics', (_req, res) => {
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.send(`# HELP synapseone_storage_up Service up status\n# TYPE synapseone_storage_up gauge\nsynapseone_storage_up 1\nsynapseone_ocs_up 1\nsynapseone_storage_backend{backend="${backend.name}"} 1\n`);
  });

  const attachTenant = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // HMAC-signed public URLs carry their own tenant/bucket/key scope.
    if (req.originalUrl.split('?')[0] === '/v1/ocs/signed') return next();
    if (IS_PROD && !verifyInternal(req)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
    }
    const tenant = resolveTenant(req);
    if (!tenant) return res.status(401).json({ error: 'tenant_required', message: 'Authenticated principal or x-synapseone-tenant required' });
    (req as any).tenant = tenant;
    next();
  };

  app.use('/v1/storage', attachTenant);
  app.use('/v1/ocs', attachTenant);

  const raw = express.raw({ type: () => true, limit: MAX_OBJECT_BYTES });

  // ---- object CRUD ----
  app.put('/v1/storage/objects/*', raw as any, async (req, res) => {
    const tenant = (req as any).tenant as string;
    const key = keyFromReq(req);
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: 'invalid_key', message: keyErr });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ error: 'empty_body', message: 'object body is required' });
    if (body.length > MAX_OBJECT_BYTES) {
      return res.status(413).json({ error: 'object_too_large', message: `max object size is ${MAX_OBJECT_BYTES} bytes` });
    }
    const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (ALLOWED_TYPES.length && !ALLOWED_TYPES.includes(contentType)) {
      return res.status(415).json({ error: 'unsupported_media_type', message: `content type '${contentType}' is not allowed`, allowed: ALLOWED_TYPES });
    }
    const providedChecksum = String(req.headers['x-object-checksum-sha256'] || req.headers['x-amz-checksum-sha256'] || '').trim().toLowerCase();
    const actual = checksumHex(body);
    if (providedChecksum && providedChecksum !== actual) {
      return res.status(400).json({ error: 'checksum_mismatch', message: 'x-object-checksum-sha256 does not match the body', expected: actual });
    }
    try {
      const usage = await backend.usage(tenant);
      const existing = await backend.head(tenant, key);
      const nextBytes = usage.bytes - (existing?.size || 0) + body.length;
      if (nextBytes > TENANT_QUOTA_BYTES) {
        return res.status(413).json({
          error: 'quota_exceeded',
          message: `tenant quota is ${TENANT_QUOTA_BYTES} bytes`,
          usedBytes: usage.bytes,
          quotaBytes: TENANT_QUOTA_BYTES,
        });
      }
      const meta = await backend.put(tenant, key, body, contentType, actual);
      res.setHeader('ETag', `"${meta.etag}"`);
      res.status(existing ? 200 : 201).json({ object: meta });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  app.get('/v1/storage/objects', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const prefix = String(req.query.prefix || '');
    if (prefix && validateKey(prefix.replace(/\/$/, ''))) return res.status(400).json({ error: 'invalid_prefix' });
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return res.status(400).json({ error: 'invalid_limit', message: 'limit must be 1..1000' });
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    try {
      const page = await backend.list(tenant, prefix, limit, cursor);
      res.json({ objects: page.objects, nextCursor: page.nextCursor || null });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  app.get('/v1/storage/objects/*', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const key = keyFromReq(req);
    try {
      const obj = await backend.get(tenant, key);
      if (!obj) return res.status(404).json({ error: 'not_found' });
      res.set(metaHeaders(obj));
      res.send(obj.body);
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  app.head('/v1/storage/objects/*', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const key = keyFromReq(req);
    try {
      const meta = await backend.head(tenant, key);
      if (!meta) return res.status(404).end();
      res.set(metaHeaders(meta)).end();
    } catch {
      res.status(502).end();
    }
  });

  app.delete('/v1/storage/objects/*', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const key = keyFromReq(req);
    try {
      const ok = await backend.delete(tenant, key);
      if (!ok) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true, key });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  // ---- presigned URLs (S3 backend) ----
  app.post('/v1/storage/presign', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const { key, method, expiresIn } = (req.body || {}) as any;
    const keyErr = validateKey(String(key || ''));
    if (keyErr) return res.status(400).json({ error: 'invalid_key', message: keyErr });
    const verb = String(method || 'GET').toUpperCase();
    if (!['GET', 'PUT', 'DELETE', 'HEAD'].includes(verb)) return res.status(400).json({ error: 'invalid_method' });
    const ttl = expiresIn === undefined ? 900 : Number(expiresIn);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800) return res.status(400).json({ error: 'invalid_expires_in', message: 'expiresIn must be 1..604800' });
    if (!backend.presign) {
      return res.status(501).json({ error: 'presign_unsupported', message: 'presigned URLs require the S3 backend', backend: backend.name });
    }
    res.json({ url: backend.presign(tenant, verb as any, String(key), ttl), method: verb, expiresIn: ttl });
  });

  // ---- multipart upload ----
  app.post('/v1/storage/uploads', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const { key, contentType } = (req.body || {}) as any;
    const keyErr = validateKey(String(key || ''));
    if (keyErr) return res.status(400).json({ error: 'invalid_key', message: keyErr });
    if (!backend.createMultipart) return res.status(501).json({ error: 'multipart_unsupported' });
    const type = String(contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (ALLOWED_TYPES.length && !ALLOWED_TYPES.includes(type)) return res.status(415).json({ error: 'unsupported_media_type' });
    try {
      const uploadId = await backend.createMultipart(tenant, String(key), type);
      res.status(201).json({ uploadId, key, contentType: type });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  app.put('/v1/storage/uploads/:id/parts/:part', raw as any, async (req, res) => {
    const tenant = (req as any).tenant as string;
    const uploadId = String(req.params.id || '');
    const partNumber = Number(req.params.part);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(uploadId)) return res.status(400).json({ error: 'invalid_upload_id' });
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return res.status(400).json({ error: 'invalid_part_number' });
    if (!backend.uploadPart) return res.status(501).json({ error: 'multipart_unsupported' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ error: 'empty_body' });
    if (body.length > MAX_OBJECT_BYTES) return res.status(413).json({ error: 'part_too_large' });
    try {
      const key = String(req.query.key || '');
      const out = await backend.uploadPart(tenant, uploadId, key, partNumber, body);
      res.json({ partNumber, etag: out.etag, size: body.length });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  app.post('/v1/storage/uploads/:id/complete', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const uploadId = String(req.params.id || '');
    if (!backend.completeMultipart) return res.status(501).json({ error: 'multipart_unsupported' });
    const { key, parts } = (req.body || {}) as any;
    const keyErr = validateKey(String(key || ''));
    if (keyErr) return res.status(400).json({ error: 'invalid_key', message: keyErr });
    if (!Array.isArray(parts) || !parts.length || parts.length > 10000) {
      return res.status(400).json({ error: 'invalid_parts', message: 'parts must contain 1..10000 entries' });
    }
    const clean = parts.map((p: any) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') }));
    if (clean.some((p: any) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || !p.etag)) {
      return res.status(400).json({ error: 'invalid_parts' });
    }
    try {
      const meta = await backend.completeMultipart(tenant, uploadId, String(key), clean);
      res.status(201).json({ object: meta });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  app.delete('/v1/storage/uploads/:id', async (req, res) => {
    const tenant = (req as any).tenant as string;
    if (!backend.abortMultipart) return res.status(501).json({ error: 'multipart_unsupported' });
    try {
      await backend.abortMultipart(tenant, String(req.params.id), String(req.query.key || ''));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(502).json({ error: 'backend_error', message: String(e?.message || e).slice(0, 300) });
    }
  });

  registerOcsRoutes(app, backend, {
    maxObjectBytes: MAX_OBJECT_BYTES,
    tenantQuotaBytes: TENANT_QUOTA_BYTES,
    allowedTypes: ALLOWED_TYPES,
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'object_too_large', message: `max object size is ${MAX_OBJECT_BYTES} bytes` });
    }
    console.error('[storage] unhandled:', err?.message || err);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

function warnProductionStorage(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.STORAGE_BACKEND !== 's3') return;
  const endpoint = (process.env.STORAGE_S3_ENDPOINT || '').trim();
  // The bundled SeaweedFS/MinIO endpoints are real S3-compatible stores on the
  // private Docker network; only flag the known adobe/s3mock test double.
  const isMock = /s3mock|adobe|localhost|127\.0\.0\.1|\[::1\]/i.test(endpoint);
  if (isMock) {
    const banner = '='.repeat(72);
    console.error(banner);
    console.error('[storage] WARNING: production object storage is pointed at a test mock');
    console.error('[storage] endpoint: ' + endpoint);
    console.error('[storage] This is NOT durable production storage. Configure a real S3-compatible');
    console.error('[storage] endpoint (bundled SeaweedFS, MinIO, AWS S3 or Cloudflare R2) via');
    console.error('[storage] STORAGE_S3_ENDPOINT with matching STORAGE_S3_ACCESS_KEY/SECRET_KEY.');
    console.error(banner);
  }
}

if (require.main === module) {
  const app = createApp();
  warnProductionStorage();
  const server = app.listen(PORT, () => console.log(`[ocs] SynapseOCS listening on :${PORT}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
