// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Minimal S3-compatible client (SigV4) used by SynapseOCS in
 * production. No SDK dependency: AWS S3, SeaweedFS and other S3 services implement the
 * same HTTP contract.
 */
import { createHash, createHmac } from 'crypto';

export interface S3Config {
  endpoint: string; // https://s3.example.com (no bucket in the path)
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

export interface S3Object {
  body: Buffer;
  contentType: string;
  etag: string;
  size: number;
  lastModified?: string;
  metadata?: Record<string, string>;
}

/**
 * Decode XML character references in an S3 response field. Backends differ:
 * AWS escapes `&` as `&amp;`, SeaweedFS also writes `"` as `&#34;`. Without
 * this, keys with `&`, `<`, `>` and quoted ETags come back still escaped.
 */
export function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[ref];
  });
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
function encodePath(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p).replace(/%2F/g, '/')).join('/');
}
function encodeQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

/** Sign an S3 request. `payloadHash` is the hex sha256 of the body. */
export function signRequest(
  cfg: S3Config,
  method: string,
  key: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string,
  now = new Date(),
): { url: string; headers: Record<string, string> } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const base = new URL(cfg.endpoint);
  const host = base.host;
  const prefix = cfg.pathStyle ? `/${cfg.bucket}` : '';
  const path = `${base.pathname.replace(/\/$/, '')}${prefix}/${key ? encodePath(key) : ''}` || '/';
  const allHeaders: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  };
  const signedHeaderNames = Object.keys(allHeaders).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${String(allHeaders[h] ?? '').trim()}`).join('\n') + '\n';
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [method, path, encodeQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const outHeaders: Record<string, string> = {
    ...headers,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  const qs = encodeQuery(query);
  return { url: `${cfg.endpoint.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`, headers: outHeaders };
}

/** Presigned URL (query-string auth), valid for `expiresIn` seconds. */
export function presignUrl(
  cfg: S3Config,
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  key: string,
  expiresIn: number,
  now = new Date(),
): string {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const base = new URL(cfg.endpoint);
  const host = base.host;
  const prefix = cfg.pathStyle ? `/${cfg.bucket}` : '';
  const path = `${base.pathname.replace(/\/$/, '')}${prefix}/${key ? encodePath(key) : ''}` || '/';
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(Math.max(expiresIn, 1), 604800)),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalRequest = [method, path, encodeQuery(params), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const qs = encodeQuery({ ...params, 'X-Amz-Signature': signature });
  return `${cfg.endpoint.replace(/\/$/, '')}${path}?${qs}`;
}

export class S3Client {
  constructor(private readonly cfg: S3Config) {}

  private async call(method: string, key: string, query: Record<string, string> = {}, headers: Record<string, string> = {}, body?: Buffer): Promise<Response> {
    const payload = body ?? Buffer.alloc(0);
    const hash = sha256Hex(payload);
    const signed = signRequest(this.cfg, method, key, query, headers, hash);
    const res = await fetch(signed.url, {
      method,
      headers: { ...signed.headers, ...(body ? { 'content-length': String(payload.length) } : {}) },
      body: body && method !== 'GET' && method !== 'HEAD' ? new Uint8Array(payload) : undefined,
    });
    return res;
  }

  async put(key: string, body: Buffer, contentType: string, checksumSha256?: string): Promise<{ etag: string }> {
    const headers: Record<string, string> = { 'content-type': contentType };
    if (checksumSha256) headers['x-amz-checksum-sha256'] = Buffer.from(checksumSha256, 'hex').toString('base64');
    const res = await this.call('PUT', key, {}, headers, body);
    if (!res.ok) throw new Error(`s3 put ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { etag: (res.headers.get('etag') || '').replace(/"/g, '') || sha256Hex(body) };
  }

  async get(key: string): Promise<S3Object | null> {
    const res = await this.call('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 get ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = Buffer.from(await res.arrayBuffer());
    return {
      body,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      etag: (res.headers.get('etag') || '').replace(/"/g, ''),
      size: Number(res.headers.get('content-length') || body.length),
      lastModified: res.headers.get('last-modified') || undefined,
    };
  }

  async head(key: string): Promise<Omit<S3Object, 'body'> | null> {
    const res = await this.call('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 head ${res.status}`);
    return {
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      etag: (res.headers.get('etag') || '').replace(/"/g, ''),
      size: Number(res.headers.get('content-length') || 0),
      lastModified: res.headers.get('last-modified') || undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.call('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`s3 delete ${res.status}`);
  }

  async list(prefix: string, limit: number, token?: string): Promise<{ objects: Array<{ key: string; size: number; etag: string; lastModified?: string }>; next?: string }> {
    const q: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': String(Math.min(Math.max(limit, 1), 1000)) };
    if (token) q['continuation-token'] = token;
    const res = await this.call('GET', '', q);
    if (!res.ok) throw new Error(`s3 list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    const objects: Array<{ key: string; size: number; etag: string; lastModified?: string }> = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const key = xmlDecode(/<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] || '');
      const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1] || 0);
      const etag = xmlDecode(/<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] || '').replace(/"/g, '');
      const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
      if (key) objects.push({ key, size, etag, lastModified });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const rawNext = truncated ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    const next = rawNext ? xmlDecode(rawNext) : undefined;
    return { objects, next };
  }

  presign(method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, expiresIn: number): string {
    return presignUrl(this.cfg, method, key, expiresIn);
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.call('POST', key, { uploads: '' }, { 'content-type': contentType });
    if (!res.ok) throw new Error(`s3 create multipart ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    const rawId = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(xml)?.[1];
    const id = rawId ? xmlDecode(rawId) : undefined;
    if (!id) throw new Error('s3 create multipart: missing UploadId');
    return id;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<{ etag: string }> {
    const res = await this.call('PUT', key, { partNumber: String(partNumber), uploadId }, {}, body);
    if (!res.ok) throw new Error(`s3 upload part ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { etag: (res.headers.get('etag') || '').replace(/"/g, '') };
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    const xml = `<CompleteMultipartUpload>${parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    const res = await this.call('POST', key, { uploadId }, { 'content-type': 'application/xml' }, Buffer.from(xml));
    if (!res.ok) throw new Error(`s3 complete multipart ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.call('DELETE', key, { uploadId }).catch(() => undefined);
  }
}
