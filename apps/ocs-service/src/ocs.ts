// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 *
 * SynapseOCS — bucket-aware object cloud storage.
 *
 * The legacy `/v1/storage` API remains the default-bucket compatibility
 * surface. `/v1/ocs` adds MinIO-style buckets, scoped quotas, usage, copy,
 * range/conditional reads, delimited listing and bucket-aware multipart.
 */
import express, { Express, Request, Response } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { ObjectMeta, Backend, checksumHex, validateKey } from './backend';

export const DEFAULT_BUCKET = 'default';
export const OCS_PREFIX = '@ocs/';
export const BUCKET_MARKER = '.bucket';

export interface OcsOptions {
  maxObjectBytes: number;
  tenantQuotaBytes: number;
  allowedTypes: string[];
}

export interface BucketMeta {
  name: string;
  createdAt: string;
  updatedAt?: string;
  owner?: string;
  quotaBytes?: number;
}

export interface OcsObjectMeta extends ObjectMeta {
  bucket: string;
}

export function validateBucketName(name: string): string | null {
  const value = String(name || '');
  if (value.length < 3 || value.length > 63) return 'bucket name must be 3..63 characters';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    return 'bucket name must use lowercase letters, digits, dots or hyphens and start/end with alphanumeric';
  }
  if (value.includes('..') || value.includes('.-') || value.includes('-.')) return 'bucket name contains an invalid separator';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return 'bucket name must not look like an IPv4 address';
  return null;
}

/** User keys may not enter the reserved internal bucket namespace. */
export function validateOcsKey(key: string): string | null {
  const error = validateKey(key);
  if (error) return error;
  const value = String(key || '');
  if (value.startsWith(OCS_PREFIX)) return 'key uses a reserved prefix';
  if (value === BUCKET_MARKER || value.endsWith(`/${BUCKET_MARKER}`)) return 'key uses a reserved name';
  return null;
}

export interface PresignPayload {
  tenant: string;
  bucket: string;
  key: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  exp: number;
  nonce: string;
}

function presignSecret(): string {
  const secret = process.env.OCS_PRESIGN_SECRET || process.env.SYNAPSEONE_INTERNAL_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') throw new Error('SynapseOCS presign requires OCS_PRESIGN_SECRET or SYNAPSEONE_INTERNAL_SECRET');
  return 'ocs-dev-presign-secret';
}

/** HMAC-signed URL token; no backend S3 credential is exposed to the browser. */
export function createPresignToken(payload: PresignPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', presignSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyPresignToken(token: string, method: string): PresignPayload {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw Object.assign(new Error('invalid presign token'), { status: 403, code: 'invalid_presign_token' });
  const expected = createHmac('sha256', presignSecret()).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw Object.assign(new Error('invalid presign token'), { status: 403, code: 'invalid_presign_token' });
  }
  let payload: PresignPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PresignPayload;
  } catch {
    throw Object.assign(new Error('invalid presign token'), { status: 403, code: 'invalid_presign_token' });
  }
  if (!payload.tenant || !payload.bucket || !payload.key || !payload.method || !payload.exp) {
    throw Object.assign(new Error('invalid presign token'), { status: 403, code: 'invalid_presign_token' });
  }
  if (payload.exp * 1000 < Date.now()) throw Object.assign(new Error('presign token expired'), { status: 410, code: 'presign_expired' });
  if (payload.method !== String(method || '').toUpperCase()) {
    throw Object.assign(new Error('presign method mismatch'), { status: 403, code: 'presign_method_mismatch' });
  }
  return payload;
}

function publicBaseUrl(): string {
  return (process.env.OCS_PUBLIC_BASE_URL || 'https://api.synapseone.space').replace(/\/+$/, '');
}

function keyFromReq(req: Request): string {
  const raw = (req.params as any)[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function tenantOf(req: Request): string {
  return String((req as any).tenant || '');
}

function internalKey(bucket: string, key: string): string {
  return bucket === DEFAULT_BUCKET ? key : `${OCS_PREFIX}${bucket}/${key}`;
}

function userKey(bucket: string, key: string): string {
  if (bucket === DEFAULT_BUCKET) return key;
  const prefix = `${OCS_PREFIX}${bucket}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function markerKey(bucket: string): string {
  return `${OCS_PREFIX}${bucket}/${BUCKET_MARKER}`;
}

function publicMeta(bucket: string, meta: ObjectMeta): OcsObjectMeta {
  return { ...meta, key: userKey(bucket, meta.key), bucket };
}

function metaHeaders(bucket: string, meta: ObjectMeta): Record<string, string> {
  const out: Record<string, string> = {
    'Content-Type': meta.contentType,
    'Content-Length': String(meta.size),
    ETag: `"${meta.etag}"`,
    'Accept-Ranges': 'bytes',
    'x-object-key': userKey(bucket, meta.key),
    'x-ocs-bucket': bucket,
    'x-object-created-at': meta.createdAt,
    'x-object-updated-at': meta.updatedAt,
  };
  if (meta.checksumSha256) out['x-object-checksum-sha256'] = meta.checksumSha256;
  return out;
}

function parseExpires(value: unknown): number {
  const ttl = value === undefined ? 900 : Number(value);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800) throw new Error('expiresIn must be 1..604800');
  return ttl;
}

function parseLimit(value: unknown): number {
  const limit = value === undefined ? 100 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000');
  return limit;
}

function encodeCursor(value: string | undefined): string | null {
  return value ? Buffer.from(value, 'utf8').toString('base64url') : null;
}

function decodeCursor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new Error('cursor is invalid');
  }
}

async function listAll(backend: Backend, tenant: string, prefix: string): Promise<ObjectMeta[]> {
  const objects: ObjectMeta[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await backend.list(tenant, prefix, 1000, cursor);
    objects.push(...result.objects);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return objects;
}

async function readBucket(backend: Backend, tenant: string, bucket: string): Promise<BucketMeta | null> {
  if (bucket === DEFAULT_BUCKET) return { name: DEFAULT_BUCKET, createdAt: new Date(0).toISOString() };
  const marker = await backend.get(tenant, markerKey(bucket));
  if (!marker) return null;
  try {
    const parsed = JSON.parse(marker.body.toString('utf8')) as BucketMeta;
    return { ...parsed, name: bucket };
  } catch {
    return { name: bucket, createdAt: marker.createdAt };
  }
}

async function bucketObjects(backend: Backend, tenant: string, bucket: string): Promise<ObjectMeta[]> {
  const prefix = bucket === DEFAULT_BUCKET ? '' : `${OCS_PREFIX}${bucket}/`;
  const all = await listAll(backend, tenant, prefix);
  return all.filter((object) => {
    if (bucket === DEFAULT_BUCKET) return !object.key.startsWith(OCS_PREFIX);
    return object.key !== markerKey(bucket);
  });
}

async function bucketStats(backend: Backend, tenant: string, bucket: string): Promise<{ objects: number; bytes: number }> {
  const objects = await bucketObjects(backend, tenant, bucket);
  return { objects: objects.length, bytes: objects.reduce((sum, object) => sum + object.size, 0) };
}

async function requireBucket(
  backend: Backend,
  tenant: string,
  bucket: string,
  res: Response,
  stats = false,
): Promise<BucketMeta | null> {
  const meta = await readBucket(backend, tenant, bucket);
  if (!meta) {
    res.status(404).json({ error: 'bucket_not_found', message: `bucket '${bucket}' does not exist`, bucket });
    return null;
  }
  if (stats) {
    const usage = await bucketStats(backend, tenant, bucket);
    return { ...meta, ...usage } as BucketMeta & { objects: number; bytes: number };
  }
  return meta;
}

function ownerOf(req: Request): string | undefined {
  const value = req.headers['x-synapseone-user'] ?? req.headers['x-synapsedx-user'];
  const text = String(Array.isArray(value) ? value[0] : value || '').trim();
  return text || undefined;
}

function mediaType(req: Request): string {
  return String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
}

function ensureAllowedType(type: string, allowedTypes: string[]): void {
  if (allowedTypes.length && !allowedTypes.includes(type)) {
    const error = new Error(`content type '${type}' is not allowed`);
    (error as any).status = 415;
    (error as any).code = 'unsupported_media_type';
    throw error;
  }
}

async function putObject(
  backend: Backend,
  tenant: string,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
  options: OcsOptions,
  providedChecksum?: string,
): Promise<{ meta: OcsObjectMeta; created: boolean }> {
  const actual = checksumHex(body);
  if (providedChecksum && providedChecksum !== actual) {
    const error = new Error('x-object-checksum-sha256 does not match the body');
    (error as any).status = 400;
    (error as any).code = 'checksum_mismatch';
    throw error;
  }
  const target = internalKey(bucket, key);
  const existing = await backend.head(tenant, target);
  const [tenantUsage, bucketUsage, bucketMeta] = await Promise.all([
    backend.usage(tenant),
    bucketStats(backend, tenant, bucket),
    readBucket(backend, tenant, bucket),
  ]);
  const tenantNext = tenantUsage.bytes - (existing?.size || 0) + body.length;
  if (tenantNext > options.tenantQuotaBytes) {
    const error = new Error(`tenant quota is ${options.tenantQuotaBytes} bytes`);
    (error as any).status = 413;
    (error as any).code = 'quota_exceeded';
    (error as any).details = { usedBytes: tenantUsage.bytes, quotaBytes: options.tenantQuotaBytes };
    throw error;
  }
  const quotaBytes = bucketMeta?.quotaBytes;
  if (quotaBytes && bucketUsage.bytes - (existing?.size || 0) + body.length > quotaBytes) {
    const error = new Error(`bucket quota is ${quotaBytes} bytes`);
    (error as any).status = 413;
    (error as any).code = 'bucket_quota_exceeded';
    (error as any).details = { usedBytes: bucketUsage.bytes, quotaBytes };
    throw error;
  }
  const meta = await backend.put(tenant, target, body, contentType, actual);
  return { meta: publicMeta(bucket, meta), created: !existing };
}

function sendError(res: Response, error: any): void {
  const status = Number(error?.status) || 502;
  const code = error?.code || (status === 502 ? 'backend_error' : 'invalid_request');
  res.status(status).json({
    error: code,
    message: String(error?.message || error).slice(0, 300),
    ...(error?.details ? { details: error.details } : {}),
  });
}

export function registerOcsRoutes(app: Express, backend: Backend, options: OcsOptions): void {
  const raw = express.raw({ type: () => true, limit: options.maxObjectBytes });
  const base = '/v1/ocs';

  // ---- HMAC-signed public URLs (no S3 credential leaves the service) ----
  app.get(`${base}/signed`, async (req, res) => {
    try {
      const payload = verifyPresignToken(String(req.query.token || ''), 'GET');
      if (!(await readBucket(backend, payload.tenant, payload.bucket))) return res.status(404).json({ error: 'bucket_not_found' });
      const object = await backend.get(payload.tenant, internalKey(payload.bucket, payload.key));
      if (!object) return res.status(404).json({ error: 'object_not_found' });
      res.set(metaHeaders(payload.bucket, object));
      const range = String(req.headers.range || '').trim();
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.setHeader('content-range', `bytes */${object.size}`);
          return res.status(416).json({ error: 'invalid_range' });
        }
        const start = match[1] === '' ? Math.max(0, object.size - Number(match[2])) : Number(match[1]);
        const end = match[1] === '' || match[2] === '' ? object.size - 1 : Math.min(Number(match[2]), object.size - 1);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= object.size || end < start) {
          res.setHeader('content-range', `bytes */${object.size}`);
          return res.status(416).json({ error: 'invalid_range' });
        }
        res.status(206);
        res.setHeader('content-range', `bytes ${start}-${end}/${object.size}`);
        res.setHeader('content-length', String(end - start + 1));
        return res.send(object.body.subarray(start, end + 1));
      }
      res.send(object.body);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.head(`${base}/signed`, async (req, res) => {
    try {
      const payload = verifyPresignToken(String(req.query.token || ''), 'HEAD');
      if (!(await readBucket(backend, payload.tenant, payload.bucket))) return res.status(404).end();
      const object = await backend.head(payload.tenant, internalKey(payload.bucket, payload.key));
      if (!object) return res.status(404).end();
      res.set(metaHeaders(payload.bucket, object)).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put(`${base}/signed`, raw as any, async (req, res) => {
    try {
      const payload = verifyPresignToken(String(req.query.token || ''), 'PUT');
      if (!(await readBucket(backend, payload.tenant, payload.bucket))) return res.status(404).json({ error: 'bucket_not_found' });
      const keyError = validateOcsKey(payload.key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) return res.status(400).json({ error: 'empty_body' });
      if (body.length > options.maxObjectBytes) return res.status(413).json({ error: 'object_too_large' });
      const type = mediaType(req);
      ensureAllowedType(type, options.allowedTypes);
      const checksum = String(req.headers['x-object-checksum-sha256'] || '').trim().toLowerCase();
      const result = await putObject(backend, payload.tenant, payload.bucket, payload.key, body, type, options, checksum || undefined);
      res.setHeader('ETag', `"${result.meta.etag}"`);
      res.status(result.created ? 201 : 200).json({ bucket: payload.bucket, object: result.meta });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete(`${base}/signed`, async (req, res) => {
    try {
      const payload = verifyPresignToken(String(req.query.token || ''), 'DELETE');
      if (!(await readBucket(backend, payload.tenant, payload.bucket))) return res.status(404).json({ error: 'bucket_not_found' });
      const deleted = await backend.delete(payload.tenant, internalKey(payload.bucket, payload.key));
      if (!deleted) return res.status(404).json({ error: 'object_not_found' });
      res.json({ ok: true, bucket: payload.bucket, key: payload.key });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ---- buckets ----
  app.get(`${base}/buckets`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const markers = await listAll(backend, tenant, OCS_PREFIX);
      const names = new Set<string>([DEFAULT_BUCKET]);
      for (const marker of markers) {
        if (!marker.key.endsWith(`/${BUCKET_MARKER}`)) continue;
        const name = marker.key.slice(OCS_PREFIX.length, -(`/${BUCKET_MARKER}`).length);
        if (name && !name.includes('/')) names.add(name);
      }
      const buckets: Array<BucketMeta & { objects?: number; bytes?: number }> = [];
      for (const name of [...names].sort()) {
        const meta = await readBucket(backend, tenant, name);
        if (!meta) continue;
        if (String(req.query.withStats || '') === '1') {
          const usage = await bucketStats(backend, tenant, name);
          buckets.push({ ...meta, ...usage });
        } else {
          buckets.push(meta);
        }
      }
      res.json({ buckets, total: buckets.length });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`${base}/buckets`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const name = String(body.name || '').trim().toLowerCase();
      const nameError = validateBucketName(name);
      if (nameError) return res.status(400).json({ error: 'invalid_bucket_name', message: nameError });
      if (name === DEFAULT_BUCKET) return res.status(409).json({ error: 'bucket_exists', message: 'the default bucket is managed by the platform' });
      if (await readBucket(backend, tenant, name)) {
        return res.status(409).json({ error: 'bucket_exists', message: `bucket '${name}' already exists` });
      }
      const quota = body.quotaBytes === undefined ? undefined : Number(body.quotaBytes);
      if (quota !== undefined && (!Number.isInteger(quota) || quota < 1024 || quota > 1024 ** 4)) {
        return res.status(400).json({ error: 'invalid_quota', message: 'quotaBytes must be an integer between 1024 and 1 TiB' });
      }
      const now = new Date().toISOString();
      const meta: BucketMeta = {
        name,
        createdAt: now,
        ...(ownerOf(req) ? { owner: ownerOf(req) } : {}),
        ...(quota !== undefined ? { quotaBytes: quota } : {}),
      };
      await backend.put(tenant, markerKey(name), Buffer.from(JSON.stringify(meta)), 'application/json');
      res.status(201).json({ bucket: { ...meta, ...(await bucketStats(backend, tenant, name)) } });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(`${base}/buckets/:bucket`, async (req, res) => {
    try {
      const bucket = String(req.params.bucket || '');
      const meta = await requireBucket(backend, tenantOf(req), bucket, res, true);
      if (!meta) return;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-ocs-bucket', bucket);
      res.setHeader('x-ocs-quota-bytes', String(meta.quotaBytes || options.tenantQuotaBytes));
      res.json({ bucket: meta });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.head(`${base}/buckets/:bucket`, async (req, res) => {
    try {
      const bucket = String(req.params.bucket || '');
      const meta = await readBucket(backend, tenantOf(req), bucket);
      if (!meta) return res.status(404).end();
      res.setHeader('x-ocs-bucket', bucket);
      res.setHeader('x-ocs-quota-bytes', String(meta.quotaBytes || options.tenantQuotaBytes));
      res.status(200).end();
    } catch {
      res.status(502).end();
    }
  });

  app.get(`${base}/buckets/:bucket/stats`, async (req, res) => {
    try {
      const bucket = String(req.params.bucket || '');
      const meta = await readBucket(backend, tenantOf(req), bucket);
      if (!meta) return res.status(404).json({ error: 'bucket_not_found' });
      const usage = await bucketStats(backend, tenantOf(req), bucket);
      res.json({ bucket, ...usage, quotaBytes: meta.quotaBytes || options.tenantQuotaBytes });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete(`${base}/buckets/:bucket`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (bucket === DEFAULT_BUCKET) {
        return res.status(403).json({ error: 'default_bucket_protected', message: 'the default bucket cannot be deleted' });
      }
      if (!(await readBucket(backend, tenant, bucket))) {
        return res.status(404).json({ error: 'bucket_not_found' });
      }
      const objects = await bucketObjects(backend, tenant, bucket);
      const force = String(req.query.force || '') === 'true';
      if (objects.length && !force) {
        return res.status(409).json({
          error: 'bucket_not_empty',
          message: `bucket '${bucket}' still has ${objects.length} object(s); pass ?force=true to delete them`,
          objects: objects.length,
        });
      }
      for (const object of objects) await backend.delete(tenant, object.key);
      await backend.delete(tenant, markerKey(bucket));
      res.json({ ok: true, bucket, deletedObjects: objects.length });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ---- object listing (must precede the wildcard) ----
  app.get(`${base}/buckets/:bucket/objects`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      const prefix = String(req.query.prefix || '');
      if (prefix) {
        const prefixError = validateOcsKey(prefix.replace(/\/$/, ''));
        if (prefixError) return res.status(400).json({ error: 'invalid_prefix', message: prefixError });
      }
      const delimiter = req.query.delimiter === undefined ? '' : String(req.query.delimiter);
      if (delimiter.length > 1) return res.status(400).json({ error: 'invalid_delimiter' });
      const limit = parseLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor);
      const internalPrefix = bucket === DEFAULT_BUCKET ? prefix : `${OCS_PREFIX}${bucket}/${prefix}`;
      const page = await backend.list(tenant, internalPrefix, limit, cursor);
      const objects: OcsObjectMeta[] = [];
      const commonPrefixes = new Set<string>();
      for (const object of page.objects) {
        if (object.key === markerKey(bucket)) continue;
        const key = userKey(bucket, object.key);
        if (delimiter) {
          const index = key.indexOf(delimiter, prefix.length);
          if (index >= 0) {
            commonPrefixes.add(key.slice(0, index + delimiter.length));
            continue;
          }
        }
        objects.push(publicMeta(bucket, object));
      }
      res.json({
        bucket,
        prefix,
        ...(delimiter ? { delimiter } : {}),
        objects,
        commonPrefixes: [...commonPrefixes].sort(),
        nextCursor: encodeCursor(page.nextCursor),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ---- copy ----
  app.post(`${base}/buckets/:bucket/objects/copy`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      const body = (req.body || {}) as Record<string, unknown>;
      const sourceBucket = String(body.sourceBucket || bucket);
      const sourceKey = String(body.sourceKey || '');
      const destinationKey = String(body.destinationKey || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      if (!(await requireBucket(backend, tenant, sourceBucket, res))) return;
      const sourceError = validateOcsKey(sourceKey);
      if (sourceError) return res.status(400).json({ error: 'invalid_source_key', message: sourceError });
      const destinationError = validateOcsKey(destinationKey);
      if (destinationError) return res.status(400).json({ error: 'invalid_destination_key', message: destinationError });
      const source = await backend.get(tenant, internalKey(sourceBucket, sourceKey));
      if (!source) return res.status(404).json({ error: 'source_not_found' });
      const contentType = body.contentType === undefined ? source.contentType : String(body.contentType).split(';')[0].trim().toLowerCase();
      ensureAllowedType(contentType, options.allowedTypes);
      const result = await putObject(backend, tenant, bucket, destinationKey, source.body, contentType, options, checksumHex(source.body));
      res.status(result.created ? 201 : 200).json({ bucket, object: result.meta, source: { bucket: sourceBucket, key: sourceKey } });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ---- object CRUD ----
  app.put(`${base}/buckets/:bucket/objects/*`, raw as any, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      const key = keyFromReq(req);
      const keyError = validateOcsKey(key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) return res.status(400).json({ error: 'empty_body', message: 'object body is required' });
      if (body.length > options.maxObjectBytes) {
        return res.status(413).json({ error: 'object_too_large', message: `max object size is ${options.maxObjectBytes} bytes` });
      }
      const type = mediaType(req);
      ensureAllowedType(type, options.allowedTypes);
      const checksum = String(req.headers['x-object-checksum-sha256'] || req.headers['x-amz-checksum-sha256'] || '').trim().toLowerCase();
      const result = await putObject(backend, tenant, bucket, key, body, type, options, checksum || undefined);
      res.setHeader('ETag', `"${result.meta.etag}"`);
      res.status(result.created ? 201 : 200).json({ bucket, object: result.meta });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(`${base}/buckets/:bucket/objects/*`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      const key = keyFromReq(req);
      const object = await backend.get(tenant, internalKey(bucket, key));
      if (!object) return res.status(404).json({ error: 'object_not_found' });
      const etag = `"${object.etag}"`;
      const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();
      if (ifNoneMatch && (ifNoneMatch === '*' || ifNoneMatch.split(',').map((v) => v.trim()).includes(etag))) {
        return res.status(304).end();
      }
      const ifMatch = String(req.headers['if-match'] || '').trim();
      if (ifMatch && ifMatch !== '*' && !ifMatch.split(',').map((v) => v.trim()).includes(etag)) {
        return res.status(412).json({ error: 'precondition_failed' });
      }
      res.set(metaHeaders(bucket, object));
      const range = String(req.headers.range || '').trim();
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.setHeader('content-range', `bytes */${object.size}`);
          return res.status(416).json({ error: 'invalid_range' });
        }
        const start = match[1] === '' ? Math.max(0, object.size - Number(match[2])) : Number(match[1]);
        const end = match[1] === '' || match[2] === '' ? object.size - 1 : Math.min(Number(match[2]), object.size - 1);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= object.size || end < start) {
          res.setHeader('content-range', `bytes */${object.size}`);
          return res.status(416).json({ error: 'invalid_range' });
        }
        res.status(206);
        res.setHeader('content-range', `bytes ${start}-${end}/${object.size}`);
        res.setHeader('content-length', String(end - start + 1));
        return res.send(object.body.subarray(start, end + 1));
      }
      res.send(object.body);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.head(`${base}/buckets/:bucket/objects/*`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      const object = await backend.head(tenant, internalKey(bucket, keyFromReq(req)));
      if (!object) return res.status(404).end();
      res.set(metaHeaders(bucket, object)).end();
    } catch {
      res.status(502).end();
    }
  });

  app.delete(`${base}/buckets/:bucket/objects/*`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      const key = keyFromReq(req);
      const deleted = await backend.delete(tenant, internalKey(bucket, key));
      if (!deleted) return res.status(404).json({ error: 'object_not_found' });
      res.json({ ok: true, bucket, key });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ---- presign ----
  app.post(`${base}/buckets/:bucket/presign`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      const body = (req.body || {}) as Record<string, unknown>;
      const key = String(body.key || '');
      const keyError = validateOcsKey(key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      const method = String(body.method || 'GET').toUpperCase();
      if (!['GET', 'PUT', 'DELETE', 'HEAD'].includes(method)) return res.status(400).json({ error: 'invalid_method' });
      const expiresIn = parseExpires(body.expiresIn);
      const payload: PresignPayload = {
        tenant,
        bucket,
        key,
        method: method as PresignPayload['method'],
        exp: Math.floor(Date.now() / 1000) + expiresIn,
        nonce: randomUUID(),
      };
      const token = createPresignToken(payload);
      res.json({
        url: `${publicBaseUrl()}${base}/signed?token=${encodeURIComponent(token)}`,
        bucket, key, method, expiresIn,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ---- multipart ----
  app.post(`${base}/buckets/:bucket/uploads`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      if (!backend.createMultipart) return res.status(501).json({ error: 'multipart_unsupported' });
      const body = (req.body || {}) as Record<string, unknown>;
      const key = String(body.key || '');
      const keyError = validateOcsKey(key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      const type = String(body.contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      ensureAllowedType(type, options.allowedTypes);
      const uploadId = await backend.createMultipart(tenant, internalKey(bucket, key), type);
      res.status(201).json({ uploadId, bucket, key, contentType: type });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put(`${base}/buckets/:bucket/uploads/:id/parts/:part`, raw as any, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      if (!backend.uploadPart) return res.status(501).json({ error: 'multipart_unsupported' });
      const uploadId = String(req.params.id || '');
      const partNumber = Number(req.params.part);
      if (!/^[A-Za-z0-9-]{1,128}$/.test(uploadId)) return res.status(400).json({ error: 'invalid_upload_id' });
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return res.status(400).json({ error: 'invalid_part_number' });
      const key = String(req.query.key || '');
      const keyError = validateOcsKey(key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) return res.status(400).json({ error: 'empty_body' });
      if (body.length > options.maxObjectBytes) return res.status(413).json({ error: 'part_too_large' });
      const result = await backend.uploadPart(tenant, uploadId, internalKey(bucket, key), partNumber, body);
      res.json({ partNumber, etag: result.etag, size: body.length });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`${base}/buckets/:bucket/uploads/:id/complete`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      if (!backend.completeMultipart) return res.status(501).json({ error: 'multipart_unsupported' });
      const body = (req.body || {}) as Record<string, unknown>;
      const key = String(body.key || '');
      const keyError = validateOcsKey(key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      const parts = body.parts;
      if (!Array.isArray(parts) || !parts.length || parts.length > 10000) {
        return res.status(400).json({ error: 'invalid_parts', message: 'parts must contain 1..10000 entries' });
      }
      const clean = parts.map((part: any) => ({ partNumber: Number(part.partNumber), etag: String(part.etag || '') }));
      if (clean.some((part) => !Number.isInteger(part.partNumber) || part.partNumber < 1 || !part.etag)) {
        return res.status(400).json({ error: 'invalid_parts' });
      }
      const meta = await backend.completeMultipart(tenant, String(req.params.id), internalKey(bucket, key), clean);
      res.status(201).json({ bucket, object: publicMeta(bucket, meta) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete(`${base}/buckets/:bucket/uploads/:id`, async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const bucket = String(req.params.bucket || '');
      if (!(await requireBucket(backend, tenant, bucket, res))) return;
      if (!backend.abortMultipart) return res.status(501).json({ error: 'multipart_unsupported' });
      const key = String(req.query.key || '');
      const keyError = validateOcsKey(key);
      if (keyError) return res.status(400).json({ error: 'invalid_key', message: keyError });
      await backend.abortMultipart(tenant, String(req.params.id), internalKey(bucket, key));
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });
}
