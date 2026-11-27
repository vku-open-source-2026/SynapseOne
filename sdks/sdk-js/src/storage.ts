// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseObjectStorage client: tenant-scoped object/file storage (#24).
 */

import { HttpClient, RequestOptions } from './_http';

const P = '/v1/storage';

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  etag: string;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectList {
  objects: StoredObject[];
  nextCursor: string | null;
}

export interface PutObjectOptions extends RequestOptions {
  contentType?: string;
  /** Hex sha256 of the body; the server rejects a mismatch. */
  checksumSha256?: string;
  /** Overwrite an existing object (the default is an upsert). */
  overwrite?: boolean;
}

export class StorageService {
  constructor(private readonly http: HttpClient) {}

  /** Upload raw bytes (Uint8Array, Buffer, ArrayBuffer or a string). */
  async putObject(key: string, body: Uint8Array | ArrayBuffer | string, opts: PutObjectOptions = {}): Promise<StoredObject> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
    const res = await this.http.upload<{ object: StoredObject }>(`${P}/objects/${encodeKey(key)}`, bytes, {
      ...opts,
      contentType: opts.contentType || 'application/octet-stream',
      headers: { ...(opts.checksumSha256 ? { 'x-object-checksum-sha256': opts.checksumSha256 } : {}), ...(opts.headers || {}) },
    });
    return res.object;
  }

  /** Download an object as bytes (use `text()`/`blob()` on your side). */
  getObject(key: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    return this.http.reqBinary(`${P}/objects/${encodeKey(key)}`, undefined, opts);
  }

  /** HEAD metadata for an object. Returns null when it does not exist. */
  async headObject(key: string, opts: RequestOptions = {}): Promise<StoredObject | null> {
    try {
      const h = await this.http.head(`${P}/objects/${encodeKey(key)}`, opts);
      return {
        key: h['x-object-key'] || key,
        size: Number(h['content-length'] || 0),
        contentType: h['content-type'] || 'application/octet-stream',
        etag: (h['etag'] || '').replace(/"/g, ''),
        checksumSha256: h['x-object-checksum-sha256'],
        createdAt: h['x-object-created-at'] || '',
        updatedAt: h['x-object-updated-at'] || '',
      };
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  }

  deleteObject(key: string) {
    return this.http.req<{ ok: boolean; key: string }>(`${P}/objects/${encodeKey(key)}`, { method: 'DELETE' });
  }

  listObjects(opts: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<ObjectList> {
    const qs = new URLSearchParams();
    if (opts.prefix) qs.set('prefix', opts.prefix);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.cursor) qs.set('cursor', opts.cursor);
    const s = qs.toString();
    return this.http.req<ObjectList>(`${P}/objects${s ? `?${s}` : ''}`);
  }

  /** Presigned URL (S3 backend only; 501 on the filesystem backend). */
  presign(key: string, opts: { method?: 'GET' | 'PUT' | 'DELETE' | 'HEAD'; expiresIn?: number } = {}) {
    return this.http.req<{ url: string; method: string; expiresIn: number }>(`${P}/presign`, {
      method: 'POST',
      body: JSON.stringify({ key, method: opts.method || 'GET', expiresIn: opts.expiresIn ?? 900 }),
    });
  }

  createMultipart(key: string, contentType = 'application/octet-stream') {
    return this.http.req<{ uploadId: string; key: string; contentType: string }>(`${P}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ key, contentType }),
    });
  }

  uploadPart(uploadId: string, key: string, partNumber: number, body: Uint8Array | ArrayBuffer | string) {
    const bytes = typeof body === 'string'
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body);
    return this.http.upload<{ partNumber: number; etag: string; size: number }>(
      `${P}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}?key=${encodeURIComponent(key)}`,
      bytes,
      { method: 'PUT', contentType: 'application/octet-stream' },
    );
  }

  completeMultipart(uploadId: string, key: string, parts: Array<{ partNumber: number; etag: string }>) {
    return this.http.req<{ object: StoredObject }>(`${P}/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ key, parts }),
    });
  }

  abortMultipart(uploadId: string, key: string) {
    return this.http.req(`/v1/storage/uploads/${encodeURIComponent(uploadId)}?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
  }
}

function encodeKey(key: string): string {
  return String(key || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
