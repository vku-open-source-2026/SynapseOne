// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Shared fetch-based HTTP plumbing for the synapseone JavaScript SDK.
 */

/** Public API gateway origin. The console/marketing host is NOT the API. */
export const DEFAULT_BASE_URL = 'https://api.synapseone.space';

/** Default per-request timeout. Long-running namespaces override it. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Inference/LLM calls routinely exceed 15s; keep in sync with the gateway route. */
export const INFERENCE_TIMEOUT_MS = 120_000;
/** Public inbound webhooks can run up to the workflow 300s budget. */
export const WEBHOOK_TIMEOUT_MS = 300_000;
/** Default cap for JSON/text responses (checked while reading, never truncated). */
export const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Default cap for binary downloads. Matches the production OCS object limit. */
export const DEFAULT_MAX_BINARY_BYTES = 128 * 1024 * 1024;
/** Default number of redirect hops followed by one request attempt. */
export const DEFAULT_MAX_REDIRECTS = 10;

/**
 * Headers that must never cross an origin boundary. `Authorization` and
 * `X-API-Key` are the API credentials; the rest are defence in depth for
 * callers that inject cookies, proxy credentials or platform tenant headers.
 */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'x-synapseone-tenant',
  'x-synapsedx-tenant',
]);

export interface SynapseOneClientOptions {
  baseUrl?: string; // gateway, defaults to https://api.synapseone.space or $SYNAPSEONE_BASE_URL
  token?: string; // Bearer JWT
  apiKey?: string; // X-API-Key
  tenant?: string; // x-synapseone-tenant (platform callers of faststore/queue)
  timeoutMs?: number; // default per-request timeout (default 15000)
  /** Max attempts for idempotent requests on 429/502/503/504 (default 3, 1 = no retry). */
  maxAttempts?: number;
  /** Base backoff in ms for retries (exponential, default 200). */
  retryBaseMs?: number;
  /** Max redirect hops per request attempt (default 10, 0 disables redirects). */
  maxRedirects?: number;
  /**
   * Cross-origin redirect targets that may be followed. They are always
   * followed WITHOUT credentials; same-origin redirects keep credentials.
   * Values are origins such as `https://objects.example.com`, not paths.
   */
  trustedRedirectOrigins?: string[];
  /** Max JSON/text response bytes (default 8 MiB; 0 disables the cap). */
  maxJsonBytes?: number;
  /** Max binary response bytes (default 128 MiB; 0 disables the cap). */
  maxBinaryBytes?: number;
}

/** Per-call transport options. */
export interface RequestOptions {
  /** Override the client/namespace timeout for this call. */
  timeoutMs?: number;
  /** Caller-supplied abort signal. */
  signal?: AbortSignal;
  /** Max total attempts for this call (1 disables retries). */
  maxAttempts?: number;
  /** Force retry eligibility (defaults to idempotent methods). */
  retryable?: boolean;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

/** All SDK failures surface as SynapseOneError (network or HTTP). */
export class SynapseOneError extends Error {
  /** HTTP status code when the failure came from a response, undefined for network errors. */
  status?: number;
  /** Parsed error body when the response carried JSON. */
  body?: unknown;
  /** Machine-readable error code (when known). */
  code?: string;
  /** Base URL the request was sent to (diagnoses console-vs-API misconfiguration). */
  baseUrl?: string;

  constructor(message: string, opts: { status?: number; body?: unknown; code?: string; baseUrl?: string } = {}) {
    super(message);
    this.name = 'SynapseOneError';
    this.status = opts.status;
    this.body = opts.body;
    this.code = opts.code;
    this.baseUrl = opts.baseUrl;
  }
}

/**
 * @deprecated Use {@link SynapseOneError}. Kept for the SynapseDX -> SynapseOne
 * rebrand window; identical class (so `instanceof` works across both names).
 */
export { SynapseOneError as SynapseDXError };

/** @deprecated Use {@link SynapseOneClientOptions}. */
export type SynapseDXClientOptions = SynapseOneClientOptions;

/** Emit a deprecation notice through Node's warning channel (console fallback). */
export function warnDeprecated(name: string, replacement: string): void {
  const message = `synapseone: ${name}() is deprecated; use ${replacement}() instead`;
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(message, { type: 'DeprecationWarning' });
  } else if (typeof console !== 'undefined' && console.warn) {
    console.warn(message);
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is either delta-seconds or an HTTP date. Clamp to a sane max. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), 30_000);
  return undefined;
}

function isHtml(body: string): boolean {
  const head = body.slice(0, 256).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Normalized `scheme://host[:port]` used for redirect origin comparisons. */
function originOf(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  return `${url.protocol}//${url.hostname.toLowerCase()}${port ? `:${port}` : ''}`;
}

function parseTrustedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return originOf(url);
  } catch {
    return undefined;
  }
}

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || /aborted|abort error/i.test(String(error?.message || ''));
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await (response as any).body?.cancel?.();
  } catch {
    /* the redirect body is discarded; a failed cancel must not mask the redirect */
  }
}

/**
 * Read a response body with a hard byte limit. The limit is enforced while
 * streaming, so an oversized body is rejected instead of silently truncated.
 * A content-length larger than the limit is rejected before reading.
 */
async function readLimited(
  response: Response,
  limit: number,
  path: string,
  baseUrl: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers?.get?.('content-length') || NaN);
  if (limit > 0 && Number.isFinite(declared) && declared > limit) {
    await cancelBody(response);
    throw new SynapseOneError(
      `synapseone response ${path} is ${declared} bytes, above the ${limit}-byte limit (base ${baseUrl})`,
      { status: response.status, code: 'response_too_large', baseUrl },
    );
  }

  const body: any = (response as any).body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength || value.length || 0;
        if (limit > 0 && total > limit) {
          try { await reader.cancel(); } catch { /* already closed */ }
          throw new SynapseOneError(
            `synapseone response ${path} exceeded the ${limit}-byte limit (base ${baseUrl})`,
            { status: response.status, code: 'response_too_large', baseUrl },
          );
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (limit > 0 && bytes.byteLength > limit) {
    throw new SynapseOneError(
      `synapseone response ${path} exceeded the ${limit}-byte limit (base ${baseUrl})`,
      { status: response.status, code: 'response_too_large', baseUrl },
    );
  }
  return bytes;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export class HttpClient {
  baseUrl: string;
  token?: string;
  apiKey?: string;
  tenant?: string;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  maxRedirects: number;
  trustedRedirectOrigins: Set<string>;
  maxJsonBytes: number;
  maxBinaryBytes: number;

  constructor(opts: SynapseOneClientOptions = {}) {
    const raw = opts.baseUrl ?? (typeof process !== 'undefined' ? (process.env?.SYNAPSEONE_BASE_URL || process.env?.SYNAPSEDX_BASE_URL) : undefined) ?? DEFAULT_BASE_URL;
    this.baseUrl = raw.replace(/\/$/, '');
    this.token = opts.token;
    this.apiKey = opts.apiKey;
    this.tenant = opts.tenant;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
    this.retryBaseMs = Math.max(0, Math.floor(opts.retryBaseMs ?? 200));
    this.maxRedirects = Math.max(0, Math.floor(opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
    const envTrusted = typeof process !== 'undefined'
      ? (process.env?.SYNAPSEONE_TRUSTED_REDIRECT_ORIGINS || process.env?.SYNAPSEDX_TRUSTED_REDIRECT_ORIGINS || '')
      : '';
    const trusted = opts.trustedRedirectOrigins ?? envTrusted.split(',');
    this.trustedRedirectOrigins = new Set(
      trusted.map(parseTrustedOrigin).filter((origin): origin is string => Boolean(origin)),
    );
    this.maxJsonBytes = Math.max(0, Math.floor(opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES));
    this.maxBinaryBytes = Math.max(0, Math.floor(opts.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES));
  }

  setToken(t: string): void { this.token = t; }
  setApiKey(k: string): void { this.apiKey = k; }
  setTenant(t: string | undefined): void { this.tenant = t; }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    if (this.apiKey) h['X-API-Key'] = this.apiKey;
    if (this.tenant) h['x-synapseone-tenant'] = this.tenant;
    return h;
  }

  /**
   * One fetch attempt with manual redirect handling.
   *
   * Credentials are attached only while the request stays on the configured
   * base origin. Same-origin redirects are followed automatically. Cross-origin
   * redirects are followed only when the target origin is explicitly trusted,
   * and are then sent without `Authorization`, `X-API-Key`, cookies or platform
   * tenant headers. The abort timer stays armed through response-body reads.
   */
  private async fetchWithRedirects(
    path: string,
    init: RequestInit | undefined,
    opts: RequestOptions,
    timeoutMs: number,
  ): Promise<{ response: Response; cleanup: () => void; aborted: () => boolean }> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const to = timeoutMs > 0 ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (to) clearTimeout(to);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const baseOrigin = originOf(new URL(this.baseUrl));
    let url = new URL(`${this.baseUrl}${path}`);
    let method = String(init?.method || 'GET').toUpperCase();
    let body: any = init?.body;
    const extraHeaders = {
      ...((init?.headers as Record<string, string> | undefined) || {}),
      ...(opts.headers || {}),
    };

    try {
      for (let redirects = 0; ; redirects++) {
        const credentialsAllowed = originOf(url) === baseOrigin;
        let headers = this.headers(extraHeaders);
        if (!credentialsAllowed) headers = stripCredentialHeaders(headers);

        const response = await fetch(url.toString(), {
          ...init,
          method,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: ctl.signal,
          redirect: 'manual',
          headers,
        });

        if (response.type === 'opaqueredirect') {
          // Browsers hide manual redirects behind an opaque response. Fail
          // closed: following it would require automatic redirects, and the
          // browser cannot guarantee that X-API-Key is stripped.
          cleanup();
          throw new SynapseOneError(
            `synapseone refused an unverifiable redirect from ${this.baseUrl}${path}; `
            + 'use the canonical API origin or run this call in Node.js',
            { status: 0, code: 'redirect_not_allowed', baseUrl: this.baseUrl },
          );
        }

        if (!REDIRECT_STATUS.has(response.status)) {
          return { response, cleanup, aborted: () => ctl.signal.aborted };
        }

        const location = response.headers?.get?.('location');
        if (!location) return { response, cleanup, aborted: () => ctl.signal.aborted };

        if (redirects >= this.maxRedirects) {
          await cancelBody(response);
          cleanup();
          throw new SynapseOneError(
            `synapseone too many redirects (${this.maxRedirects}) for ${path} (base ${this.baseUrl})`,
            { status: response.status, code: 'too_many_redirects', baseUrl: this.baseUrl },
          );
        }

        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          await cancelBody(response);
          cleanup();
          throw new SynapseOneError(
            `synapseone invalid redirect location '${location}' for ${path} (base ${this.baseUrl})`,
            { status: response.status, code: 'redirect_not_allowed', baseUrl: this.baseUrl },
          );
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          await cancelBody(response);
          cleanup();
          throw new SynapseOneError(
            `synapseone refused a redirect to non-HTTP origin ${next.origin} for ${path}`,
            { status: response.status, code: 'redirect_not_allowed', baseUrl: this.baseUrl },
          );
        }

        const nextOrigin = originOf(next);
        if (nextOrigin !== originOf(url) && !this.trustedRedirectOrigins.has(nextOrigin)) {
          await cancelBody(response);
          cleanup();
          throw new SynapseOneError(
            `synapseone refused a cross-origin redirect from ${originOf(url)} to ${nextOrigin} for ${path}; `
            + 'add the target origin to trustedRedirectOrigins to follow it without credentials',
            { status: response.status, code: 'redirect_not_allowed', baseUrl: this.baseUrl },
          );
        }

        // 303 always becomes GET; 301/302 downgrade POST to GET. 307/308
        // preserve the method and body.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        await cancelBody(response);
        url = next;
      }
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /**
   * Open a request for non-retrying callers, mapping transport failures to a
   * typed error while leaving redirect-policy errors untouched.
   */
  private async openSession(
    path: string,
    init: RequestInit | undefined,
    opts: RequestOptions,
    timeoutMs: number,
  ): Promise<{ response: Response; cleanup: () => void; aborted: () => boolean }> {
    try {
      return await this.fetchWithRedirects(path, init, opts, timeoutMs);
    } catch (e: any) {
      if (e instanceof SynapseOneError) throw e;
      if (isAbortError(e)) {
        throw new SynapseOneError(`synapseone timeout ${path} after ${timeoutMs}ms (base ${this.baseUrl})`, {
          code: 'timeout',
          baseUrl: this.baseUrl,
        });
      }
      throw new SynapseOneError(`synapseone network ${path}: ${e?.message || e} (base ${this.baseUrl})`, {
        code: 'network_error',
        baseUrl: this.baseUrl,
      });
    }
  }

  async req<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
    const method = String(init?.method || 'GET').toUpperCase();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? this.maxAttempts));
    const retryable = options.retryable ?? IDEMPOTENT_METHODS.has(method);
    let attempt = 0;
    let lastErr: SynapseOneError | undefined;
    for (;;) {
      attempt++;
      let session: { response: Response; cleanup: () => void; aborted: () => boolean } | undefined;
      try {
        session = await this.fetchWithRedirects(path, init, options, timeoutMs);
        const r = session.response;
        if (!r.ok) {
          const bytes = await readLimited(r, this.maxJsonBytes, path, this.baseUrl);
          const text = decodeText(bytes).slice(0, 2000);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          const err = new SynapseOneError(`synapseone ${r.status} ${path}: ${text} (base ${this.baseUrl})`, {
            status: r.status,
            body,
            code: (body as any)?.error,
            baseUrl: this.baseUrl,
          });
          if (retryable && RETRYABLE_STATUS.has(r.status) && attempt < maxAttempts) {
            const wait = retryAfterMs(r.headers?.get?.('retry-after') ?? null)
              ?? this.retryBaseMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseMs;
            await sleep(wait);
            lastErr = err;
            continue;
          }
          throw err;
        }
        const contentType = String(r.headers?.get?.('content-type') || '').toLowerCase();
        const text = decodeText(await readLimited(r, this.maxJsonBytes, path, this.baseUrl));
        if (!text) return null as T;
        if (contentType.includes('text/html') || isHtml(text)) {
          // A 200 SPA/HTML response means the base URL points at the console host,
          // not the API gateway — surface it instead of returning HTML as data.
          throw new SynapseOneError(
            `synapseone expected JSON from ${this.baseUrl}${path} but received HTML (status ${r.status}). `
            + `The base URL looks like the console/marketing host; use ${DEFAULT_BASE_URL}.`,
            { status: r.status, code: 'non_json_response', baseUrl: this.baseUrl },
          );
        }
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      } catch (e: any) {
        if (e instanceof SynapseOneError) {
          // Typed transport/HTTP errors are final for this attempt (retryable
          // HTTP statuses were handled above). Never retry a policy refusal.
          throw e;
        }
        if (session?.aborted() || isAbortError(e)) {
          const err = new SynapseOneError(`synapseone timeout ${path} after ${timeoutMs}ms (base ${this.baseUrl})`, {
            code: 'timeout',
            baseUrl: this.baseUrl,
          });
          if (retryable && attempt < maxAttempts) {
            await sleep(this.retryBaseMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseMs);
            lastErr = err;
            continue;
          }
          throw err;
        }
        lastErr = new SynapseOneError(`synapseone network ${path}: ${e?.message || e} (base ${this.baseUrl})`, {
          code: 'network_error',
          baseUrl: this.baseUrl,
        });
        if (retryable && attempt < maxAttempts) {
          await sleep(this.retryBaseMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseMs);
          continue;
        }
        throw lastErr;
      } finally {
        session?.cleanup();
      }
    }
  }

  /** Upload a binary body and parse the JSON response. */
  async upload<T>(
    path: string,
    body: Uint8Array | ArrayBuffer | ArrayBufferView | string,
    options: RequestOptions & { method?: string; contentType?: string } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const bytes = typeof body === 'string'
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    const session = await this.openSession(path, {
      method: options.method || 'PUT',
      body: bytes as any,
      headers: {
        'Content-Type': options.contentType || 'application/octet-stream',
        ...(options.headers || {}),
      },
    }, options, timeoutMs);
    try {
      const r = session.response;
      const text = decodeText(await readLimited(r, this.maxJsonBytes, path, this.baseUrl));
      if (!r.ok) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        throw new SynapseOneError(`synapseone ${r.status} ${path}: ${text.slice(0, 500)} (base ${this.baseUrl})`, {
          status: r.status,
          body: parsed,
          baseUrl: this.baseUrl,
        });
      }
      if (!text) return null as T;
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    } catch (e: any) {
      if (e instanceof SynapseOneError) throw e;
      if (session.aborted() || isAbortError(e)) {
        throw new SynapseOneError(`synapseone timeout ${path} after ${timeoutMs}ms (base ${this.baseUrl})`, {
          code: 'timeout',
          baseUrl: this.baseUrl,
        });
      }
      throw new SynapseOneError(`synapseone network ${path}: ${e?.message || e} (base ${this.baseUrl})`, {
        code: 'network_error',
        baseUrl: this.baseUrl,
      });
    } finally {
      session.cleanup();
    }
  }

  /** HEAD request; returns response headers (no body). */
  async head(path: string, options: RequestOptions = {}): Promise<Record<string, string>> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const session = await this.openSession(path, { method: 'HEAD' }, options, timeoutMs);
    try {
      const r = session.response;
      if (!r.ok) {
        throw new SynapseOneError(`synapseone ${r.status} ${path} (base ${this.baseUrl})`, {
          status: r.status,
          baseUrl: this.baseUrl,
        });
      }
      const out: Record<string, string> = {};
      r.headers?.forEach?.((v, k) => { out[k.toLowerCase()] = v; });
      return out;
    } catch (e: any) {
      if (e instanceof SynapseOneError) throw e;
      if (session.aborted() || isAbortError(e)) {
        throw new SynapseOneError(`synapseone timeout ${path} after ${timeoutMs}ms (base ${this.baseUrl})`, {
          code: 'timeout',
          baseUrl: this.baseUrl,
        });
      }
      throw new SynapseOneError(`synapseone network ${path}: ${e?.message || e} (base ${this.baseUrl})`, {
        code: 'network_error',
        baseUrl: this.baseUrl,
      });
    } finally {
      session.cleanup();
    }
  }

  /** Fetch a binary body (bytes). Used by object storage/file downloads. */
  async reqBinary(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const session = await this.openSession(path, init, options, timeoutMs);
    try {
      const r = session.response;
      if (!r.ok) {
        const text = decodeText(await readLimited(r, this.maxJsonBytes, path, this.baseUrl)).slice(0, 2000);
        throw new SynapseOneError(`synapseone ${r.status} ${path}: ${text} (base ${this.baseUrl})`, {
          status: r.status,
          baseUrl: this.baseUrl,
        });
      }
      return await readLimited(r, this.maxBinaryBytes, path, this.baseUrl);
    } catch (e: any) {
      if (e instanceof SynapseOneError) throw e;
      if (session.aborted() || isAbortError(e)) {
        throw new SynapseOneError(`synapseone timeout ${path} after ${timeoutMs}ms (base ${this.baseUrl})`, {
          code: 'timeout',
          baseUrl: this.baseUrl,
        });
      }
      throw new SynapseOneError(`synapseone network ${path}: ${e?.message || e} (base ${this.baseUrl})`, {
        code: 'network_error',
        baseUrl: this.baseUrl,
      });
    } finally {
      session.cleanup();
    }
  }

  /**
   * Stream a Server-Sent-Events response as parsed `{event, data}` records.
   * The transport is not buffered; each event is yielded as soon as a blank
   * line terminates it. Pass an AbortSignal to cancel.
   */
  async *stream(path: string, init?: RequestInit, options: RequestOptions = {}): AsyncGenerator<{ event: string; data: string }> {
    const timeoutMs = options.timeoutMs ?? INFERENCE_TIMEOUT_MS;
    const session = await this.openSession(path, init, options, timeoutMs);
    let reader: any;
    try {
      const r = session.response;
      if (!r.ok) {
        const text = decodeText(await readLimited(r, this.maxJsonBytes, path, this.baseUrl)).slice(0, 2000);
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        throw new SynapseOneError(`synapseone ${r.status} ${path}: ${text} (base ${this.baseUrl})`, {
          status: r.status,
          body,
          baseUrl: this.baseUrl,
        });
      }
      const body: any = (r as any).body;
      if (!body || typeof body.getReader !== 'function') {
        // Non-streaming environment: decode the whole payload and parse SSE lines.
        const text = decodeText(await readLimited(r, this.maxBinaryBytes, path, this.baseUrl));
        yield* parseSse(text);
        return;
      }
      reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
          for (const ev of parseSse(chunk)) yield ev;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) for (const ev of parseSse(buffer)) yield ev;
    } catch (e: any) {
      if (e instanceof SynapseOneError) throw e;
      if (session.aborted() || isAbortError(e)) {
        throw new SynapseOneError(`synapseone timeout ${path} after ${timeoutMs}ms (base ${this.baseUrl})`, {
          code: 'timeout',
          baseUrl: this.baseUrl,
        });
      }
      throw new SynapseOneError(`synapseone network ${path}: ${e?.message || e} (base ${this.baseUrl})`, {
        code: 'network_error',
        baseUrl: this.baseUrl,
      });
    } finally {
      try { await reader?.cancel?.(); } catch { /* already closed */ }
      try { reader?.releaseLock?.(); } catch { /* already released */ }
      session.cleanup();
    }
  }

  /** Generic escape hatch (forward-compat with endpoints added after this SDK). */
  call(method: string, path: string, body?: unknown, options: RequestOptions = {}) {
    const m = String(method || 'GET').toUpperCase();
    return this.req(path.startsWith('/') ? path : `/${path}`, {
      method: m,
      body: body === undefined || m === 'GET' || m === 'HEAD' ? undefined : JSON.stringify(body),
    }, options);
  }
}

function* parseSse(text: string): Generator<{ event: string; data: string }> {
  let event = 'message';
  const data: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (data.length) yield { event, data: data.join('\n') };
      event = 'message';
      data.length = 0;
      continue;
    }
    if (line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length) yield { event, data: data.join('\n') };
}
