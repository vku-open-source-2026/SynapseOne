// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Object storage backends: local filesystem (dev/single-node) and S3-compatible
 * (SeaweedFS / AWS S3 / any S3 API) in production.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { S3Client, type S3Config } from './s3';

export interface ObjectMeta {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectBody extends ObjectMeta {
  body: Buffer;
}

export interface ListPage {
  objects: ObjectMeta[];
  nextCursor?: string;
}

export interface Backend {
  readonly name: 'fs' | 's3';
  put(tenant: string, key: string, body: Buffer, contentType: string, checksumSha256?: string): Promise<ObjectMeta>;
  get(tenant: string, key: string): Promise<ObjectBody | null>;
  head(tenant: string, key: string): Promise<ObjectMeta | null>;
  delete(tenant: string, key: string): Promise<boolean>;
  list(tenant: string, prefix: string, limit: number, cursor?: string): Promise<ListPage>;
  usage(tenant: string): Promise<{ objects: number; bytes: number }>;
  presign?(tenant: string, method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, expiresIn: number): string;
  createMultipart?(tenant: string, key: string, contentType: string): Promise<string>;
  uploadPart?(tenant: string, uploadId: string, key: string, partNumber: number, body: Buffer): Promise<{ etag: string }>;
  completeMultipart?(tenant: string, uploadId: string, key: string, parts: Array<{ partNumber: number; etag: string }>): Promise<ObjectMeta>;
  abortMultipart?(tenant: string, uploadId: string, key: string): Promise<void>;
}

export function checksumHex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Encode a tenant id into one safe path segment (opaque, no traversal). */
export function tenantSegment(tenant: string): string {
  return createHash('sha256').update(tenant).digest('hex').slice(0, 32);
}

/** Reject absolute/traversal keys before they touch a backend. */
export function validateKey(key: string): string | null {
  const k = String(key || '');
  if (!k || k.length > 1024) return 'key must be 1..1024 characters';
  if (k.startsWith('/') || k.endsWith('/')) return 'key must not start or end with /';
  if (k.includes('\\') || k.includes('\0')) return 'key contains invalid characters';
  if (k.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return 'key contains an empty or traversal segment';
  if (!/^[A-Za-z0-9!_.*'()/:@$=+-]+$/.test(k)) return 'key contains unsupported characters';
  return null;
}

class FileBackend implements Backend {
  readonly name = 'fs' as const;
  constructor(private readonly root: string) {}

  private objPath(tenant: string, key: string): string {
    return path.join(this.root, 'objects', tenantSegment(tenant), ...key.split('/'));
  }
  private metaPath(tenant: string, key: string): string {
    return path.join(this.root, 'meta', tenantSegment(tenant), `${checksumHex(Buffer.from(key))}.json`);
  }
  private uploadDir(tenant: string, id: string): string {
    return path.join(this.root, 'uploads', tenantSegment(tenant), id);
  }

  private async writeMeta(meta: ObjectMeta, tenant: string): Promise<void> {
    const p = this.metaPath(tenant, meta.key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(meta));
  }
  private async readMeta(tenant: string, key: string): Promise<ObjectMeta | null> {
    try {
      return JSON.parse(await fsp.readFile(this.metaPath(tenant, key), 'utf8')) as ObjectMeta;
    } catch {
      return null;
    }
  }

  async put(tenant: string, key: string, body: Buffer, contentType: string, checksumSha256?: string): Promise<ObjectMeta> {
    const p = this.objPath(tenant, key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
    const now = new Date().toISOString();
    const prev = await this.readMeta(tenant, key);
    const meta: ObjectMeta = {
      key,
      size: body.length,
      contentType,
      etag: checksumHex(body),
      checksumSha256,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    await this.writeMeta(meta, tenant);
    return meta;
  }

  async get(tenant: string, key: string): Promise<ObjectBody | null> {
    const meta = await this.readMeta(tenant, key);
    if (!meta) return null;
    try {
      const body = await fsp.readFile(this.objPath(tenant, key));
      return { ...meta, body };
    } catch {
      return null;
    }
  }

  async head(tenant: string, key: string): Promise<ObjectMeta | null> {
    return this.readMeta(tenant, key);
  }

  async delete(tenant: string, key: string): Promise<boolean> {
    const meta = await this.readMeta(tenant, key);
    if (!meta) return false;
    await fsp.rm(this.objPath(tenant, key), { force: true });
    await fsp.rm(this.metaPath(tenant, key), { force: true });
    return true;
  }

  async list(tenant: string, prefix: string, limit: number, cursor?: string): Promise<ListPage> {
    const dir = path.join(this.root, 'meta', tenantSegment(tenant));
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return { objects: [] };
    }
    const metas: ObjectMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as ObjectMeta;
        if (m.key.startsWith(prefix)) metas.push(m);
      } catch { /* skip corrupt metadata */ }
    }
    metas.sort((a, b) => a.key.localeCompare(b.key));
    const start = cursor ? metas.findIndex((m) => m.key > cursor) : 0;
    const slice = metas.slice(start < 0 ? metas.length : start, (start < 0 ? metas.length : start) + limit);
    const next = (start < 0 ? metas.length : start) + slice.length;
    return { objects: slice, nextCursor: next < metas.length ? slice[slice.length - 1]?.key : undefined };
  }

  async usage(tenant: string): Promise<{ objects: number; bytes: number }> {
    const all = await this.list(tenant, '', 10_000);
    return { objects: all.objects.length, bytes: all.objects.reduce((s, o) => s + o.size, 0) };
  }

  async createMultipart(tenant: string, key: string, contentType: string): Promise<string> {
    const id = randomUUID();
    const dir = this.uploadDir(tenant, id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ key, contentType, createdAt: new Date().toISOString() }));
    return id;
  }

  async uploadPart(tenant: string, uploadId: string, key: string, partNumber: number, body: Buffer): Promise<{ etag: string }> {
    const dir = this.uploadDir(tenant, uploadId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${partNumber}.part`), body);
    return { etag: checksumHex(body) };
  }

  async completeMultipart(tenant: string, uploadId: string, key: string, parts: Array<{ partNumber: number; etag: string }>): Promise<ObjectMeta> {
    const dir = this.uploadDir(tenant, uploadId);
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as { contentType: string };
    const ordered = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Buffer[] = [];
    for (const part of ordered) {
      chunks.push(await fsp.readFile(path.join(dir, `${part.partNumber}.part`)));
    }
    const body = Buffer.concat(chunks);
    const meta = await this.put(tenant, key, body, manifest.contentType || 'application/octet-stream');
    await fsp.rm(dir, { recursive: true, force: true });
    return meta;
  }

  async abortMultipart(tenant: string, uploadId: string): Promise<void> {
    await fsp.rm(this.uploadDir(tenant, uploadId), { recursive: true, force: true });
  }
}

class S3Backend implements Backend {
  readonly name = 's3' as const;
  constructor(private readonly client: S3Client) {}

  private full(tenant: string, key: string): string {
    return `tenants/${tenantSegment(tenant)}/${key}`;
  }

  async put(tenant: string, key: string, body: Buffer, contentType: string, checksumSha256?: string): Promise<ObjectMeta> {
    const { etag } = await this.client.put(this.full(tenant, key), body, contentType, checksumSha256);
    const now = new Date().toISOString();
    return { key, size: body.length, contentType, etag, checksumSha256, createdAt: now, updatedAt: now };
  }
  async get(tenant: string, key: string): Promise<ObjectBody | null> {
    const obj = await this.client.get(this.full(tenant, key));
    if (!obj) return null;
    return {
      key,
      body: obj.body,
      size: obj.size,
      contentType: obj.contentType,
      etag: obj.etag,
      createdAt: obj.lastModified || new Date().toISOString(),
      updatedAt: obj.lastModified || new Date().toISOString(),
    };
  }
  async head(tenant: string, key: string): Promise<ObjectMeta | null> {
    const obj = await this.client.head(this.full(tenant, key));
    if (!obj) return null;
    return {
      key,
      size: obj.size,
      contentType: obj.contentType,
      etag: obj.etag,
      createdAt: obj.lastModified || new Date().toISOString(),
      updatedAt: obj.lastModified || new Date().toISOString(),
    };
  }
  async delete(tenant: string, key: string): Promise<boolean> {
    const exists = await this.head(tenant, key);
    if (!exists) return false;
    await this.client.delete(this.full(tenant, key));
    return true;
  }
  async list(tenant: string, prefix: string, limit: number, cursor?: string): Promise<ListPage> {
    const base = `tenants/${tenantSegment(tenant)}/`;
    const page = await this.client.list(`${base}${prefix}`, limit, cursor);
    return {
      objects: page.objects.map((o) => ({
        key: o.key.slice(base.length),
        size: o.size,
        contentType: 'application/octet-stream',
        etag: o.etag,
        createdAt: o.lastModified || new Date().toISOString(),
        updatedAt: o.lastModified || new Date().toISOString(),
      })),
      nextCursor: page.next,
    };
  }
  async usage(tenant: string): Promise<{ objects: number; bytes: number }> {
    let cursor: string | undefined;
    let objects = 0;
    let bytes = 0;
    for (let i = 0; i < 100; i++) {
      const page = await this.list(tenant, '', 1000, cursor);
      objects += page.objects.length;
      bytes += page.objects.reduce((s, o) => s + o.size, 0);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { objects, bytes };
  }
  presign(tenant: string, method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, expiresIn: number): string {
    return this.client.presign(method, this.full(tenant, key), expiresIn);
  }
  createMultipart(tenant: string, key: string, contentType: string): Promise<string> {
    return this.client.createMultipart(this.full(tenant, key), contentType);
  }
  uploadPart(tenant: string, uploadId: string, key: string, partNumber: number, body: Buffer): Promise<{ etag: string }> {
    return this.client.uploadPart(this.full(tenant, key), uploadId, partNumber, body);
  }
  async completeMultipart(tenant: string, uploadId: string, key: string, parts: Array<{ partNumber: number; etag: string }>): Promise<ObjectMeta> {
    await this.client.completeMultipart(this.full(tenant, key), uploadId, parts);
    const head = await this.head(tenant, key);
    if (!head) throw new Error('multipart complete but object is missing');
    return head;
  }
  abortMultipart(tenant: string, uploadId: string, key: string): Promise<void> {
    return this.client.abortMultipart(this.full(tenant, key), uploadId);
  }
}

export function createBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const kind = (env.STORAGE_BACKEND || '').trim().toLowerCase();
  if (kind === 's3') {
    const cfg: S3Config = {
      endpoint: env.STORAGE_S3_ENDPOINT || '',
      bucket: env.STORAGE_S3_BUCKET || '',
      region: env.STORAGE_S3_REGION || 'us-east-1',
      accessKey: env.STORAGE_S3_ACCESS_KEY || '',
      secretKey: env.STORAGE_S3_SECRET_KEY || '',
      pathStyle: (env.STORAGE_S3_PATH_STYLE ?? 'true') !== 'false',
    };
    const missing = Object.entries(cfg).filter(([k, v]) => (k === 'pathStyle' ? false : !v));
    if (missing.length) throw new Error(`[storage] STORAGE_BACKEND=s3 requires ${missing.map(([k]) => k).join(', ')}`);
    return new S3Backend(new S3Client(cfg));
  }
  if (kind && kind !== 'fs') throw new Error(`[storage] unknown STORAGE_BACKEND '${kind}' (want fs|s3)`);
  const root = env.STORAGE_FS_ROOT || path.join(process.cwd(), '.storage');
  fs.mkdirSync(root, { recursive: true });
  return new FileBackend(root);
}

export { FileBackend, S3Backend };
