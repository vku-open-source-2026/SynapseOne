// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseOCS client: buckets, objects, copy, range/conditional reads,
 * delimited listing, presigned URLs and multipart uploads.
 */

import { HttpClient, RequestOptions } from './_http';

const P = '/v1/ocs';

export interface OcsBucket {
  name: string;
  createdAt: string;
  updatedAt?: string;
  owner?: string;
  quotaBytes?: number;
  objects?: number;
  bytes?: number;
}

export interface OcsObject {
  key: string;
  bucket: string;
  size: number;
  contentType: string;
  etag: string;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OcsList {
  bucket: string;
  prefix: string;
  delimiter?: string;
  objects: OcsObject[];
  commonPrefixes: string[];
  nextCursor: string | null;
}

export interface PutOcsOptions extends RequestOptions {
  contentType?: string;
  checksumSha256?: string;
}

export interface GetOcsOptions extends RequestOptions {
  range?: string;
  ifNoneMatch?: string;
  ifMatch?: string;
}

export class OcsService {
  constructor(private readonly http: HttpClient) {}

  createBucket(name: string, opts: { quotaBytes?: number } = {}): Promise<{ bucket: OcsBucket }> {
    return this.http.req(`${P}/buckets`, {
      method: 'POST',
      body: JSON.stringify({ name, ...(opts.quotaBytes ? { quotaBytes: opts.quotaBytes } : {}) }),
    });
  }

  listBuckets(opts: { withStats?: boolean } = {}): Promise<{ buckets: OcsBucket[]; total: number }> {
    return this.http.req(`${P}/buckets${opts.withStats ? '?withStats=1' : ''}`);
  }

  getBucket(name: string): Promise<{ bucket: OcsBucket }> {
    return this.http.req(`${P}/buckets/${encodeURIComponent(name)}`);
  }

  async headBucket(name: string, opts: RequestOptions = {}): Promise<Record<string, string> | null> {
    try {
      return await this.http.head(`${P}/buckets/${encodeURIComponent(name)}`, opts);
    } catch (error: any) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  bucketStats(name: string): Promise<{ bucket: string; objects: number; bytes: number; quotaBytes: number }> {
    return this.http.req(`${P}/buckets/${encodeURIComponent(name)}/stats`);
  }

  deleteBucket(name: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; bucket: string; deletedObjects: number }> {
    return this.http.req(`${P}/buckets/${encodeURIComponent(name)}${opts.force ? '?force=true' : ''}`, { method: 'DELETE' });
  }

  async putObject(bucket: string, key: string, body: Uint8Array | ArrayBuffer | string, opts: PutOcsOptions = {}): Promise<OcsObject> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body);
    const result = await this.http.upload<{ object: OcsObject }>(
      `${P}/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`,
      bytes,
      {
        ...opts,
        contentType: opts.contentType || 'application/octet-stream',
        headers: { ...(opts.checksumSha256 ? { 'x-object-checksum-sha256': opts.checksumSha256 } : {}), ...(opts.headers || {}) },
      },
    );
    return result.object;
  }

  getObject(bucket: string, key: string, opts: GetOcsOptions = {}): Promise<Uint8Array> {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.range) headers.Range = opts.range;
    if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    return this.http.reqBinary(`${P}/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`, undefined, { ...opts, headers });
  }

  async headObject(bucket: string, key: string, opts: RequestOptions = {}): Promise<OcsObject | null> {
    try {
      const headers = await this.http.head(`${P}/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`, opts);
      return {
        key: headers['x-object-key'] || key,
        bucket: headers['x-ocs-bucket'] || bucket,
        size: Number(headers['content-length'] || 0),
        contentType: headers['content-type'] || 'application/octet-stream',
        etag: (headers.etag || '').replace(/"/g, ''),
        checksumSha256: headers['x-object-checksum-sha256'],
        createdAt: headers['x-object-created-at'] || '',
        updatedAt: headers['x-object-updated-at'] || '',
      };
    } catch (error: any) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  deleteObject(bucket: string, key: string): Promise<{ ok: boolean; bucket: string; key: string }> {
    return this.http.req(`${P}/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`, { method: 'DELETE' });
  }

  listObjects(bucket: string, opts: { prefix?: string; delimiter?: string; limit?: number; cursor?: string } = {}): Promise<OcsList> {
    const query = new URLSearchParams();
    if (opts.prefix) query.set('prefix', opts.prefix);
    if (opts.delimiter) query.set('delimiter', opts.delimiter);
    if (opts.limit) query.set('limit', String(opts.limit));
    if (opts.cursor) query.set('cursor', opts.cursor);
    const suffix = query.toString();
    return this.http.req(`${P}/buckets/${encodeURIComponent(bucket)}/objects${suffix ? `?${suffix}` : ''}`);
  }

  copyObject(bucket: string, input: { sourceKey: string; destinationKey: string; sourceBucket?: string; contentType?: string }): Promise<{ object: OcsObject }> {
    return this.http.req(`${P}/buckets/${encodeURIComponent(bucket)}/objects/copy`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  presign(bucket: string, key: string, opts: { method?: 'GET' | 'PUT' | 'DELETE' | 'HEAD'; expiresIn?: number } = {}) {
    return this.http.req<{ url: string; bucket: string; key: string; method: string; expiresIn: number }>(
      `${P}/buckets/${encodeURIComponent(bucket)}/presign`,
      { method: 'POST', body: JSON.stringify({ key, method: opts.method || 'GET', expiresIn: opts.expiresIn ?? 900 }) },
    );
  }

  createMultipart(bucket: string, key: string, contentType = 'application/octet-stream') {
    return this.http.req<{ uploadId: string; bucket: string; key: string; contentType: string }>(
      `${P}/buckets/${encodeURIComponent(bucket)}/uploads`,
      { method: 'POST', body: JSON.stringify({ key, contentType }) },
    );
  }

  uploadPart(bucket: string, uploadId: string, key: string, partNumber: number, body: Uint8Array | string) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return this.http.upload<{ partNumber: number; etag: string; size: number }>(
      `${P}/buckets/${encodeURIComponent(bucket)}/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}?key=${encodeURIComponent(key)}`,
      bytes,
      { method: 'PUT', contentType: 'application/octet-stream' },
    );
  }

  completeMultipart(bucket: string, uploadId: string, key: string, parts: Array<{ partNumber: number; etag: string }>) {
    return this.http.req<{ object: OcsObject }>(
      `${P}/buckets/${encodeURIComponent(bucket)}/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', body: JSON.stringify({ key, parts }) },
    );
  }

  abortMultipart(bucket: string, uploadId: string, key: string) {
    return this.http.req(
      `${P}/buckets/${encodeURIComponent(bucket)}/uploads/${encodeURIComponent(uploadId)}?key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
  }
}

function encodeKey(key: string): string {
  return String(key || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
