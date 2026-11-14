// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import fs from 'fs';
import yaml from 'js-yaml';
import client from 'prom-client';
import dotenv from 'dotenv';
import {
  enqueueUsage,
  featureForRoute,
  flushUsageNow,
  isUsageExcluded,
  isUsageTelemetryEnabled,
  startUsageTelemetry,
} from './usage';
import { scopeAllows } from './scopes';
import { authzMiddleware, registerAuthzMetrics, authzMode, actionFor, type ActionOverride } from './authz';

dotenv.config();

const PORT = Number(process.env.PORT || process.env.GATEWAY_PORT || 8080);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IAM_SERVICE_URL = process.env.IAM_SERVICE_URL || 'http://iam:4001';

/** Fail fast on weak/default JWT secrets in production; warn loudly in dev. */
function jwtSecret(): string {
  const s = process.env.IAM_JWT_SECRET || '';
  const weak = !s || s.includes('change_me') || s.length < 32;
  if (weak) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[gateway] IAM_JWT_SECRET must be set to a random value ≥32 chars in production');
    }
    console.warn('[gateway][security] WARNING: IAM_JWT_SECRET is default/weak — dev only. Gateway and IAM must share the same strong secret.');
  }
  return s || 'change_me_super_secret_32chars_min';
}
const JWT_SECRET = jwtSecret();
/** Accept both issuers during the SynapseDX -> SynapseOne rebrand window. */
const JWT_ISSUERS: [string, ...string[]] = ['synapseone-iam', 'synapsedx-iam'];

/** Shared service-to-service credential (gateway → iam/workflow). Empty = dev mode (warn). */
const INTERNAL_SECRET = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
if (!INTERNAL_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[gateway] SYNAPSEONE_INTERNAL_SECRET must be set in production');
  }
  console.warn('[gateway][security] SYNAPSEONE_INTERNAL_SECRET not set — downstream services cannot tell gateway traffic apart (dev default). Set it in production.');
}

/** Fail-closed API-key verification: default true; explicit false only allowed in dev. */
export function isVerifyApiKeyEnabled(): boolean {
  const raw = process.env.GATEWAY_VERIFY_APIKEY;
  if (raw === undefined || raw === '') return true;
  return raw === 'true';
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpCounter = new client.Counter({
  name: 'gateway_requests_total',
  help: 'Total proxied requests',
  labelNames: ['route', 'status'],
  registers: [register],
});
registerAuthzMetrics(register);

export interface RouteRule {
  path: string;
  target: string;
  auth: 'none' | 'jwt' | 'apikey' | 'either';
  /** Per-route proxy timeout (ms). LLM-backed routes legitimately need longer
   *  than the 30s default (retried model calls); unset = global default. */
  timeoutMs?: number;
  /** Service namespace for central authorization (`<service>:<Verb>` actions,
   *  `arn:synapseone:...:<service>:...` resources). Unset = not policy-checked. */
  service?: string;
  /** Per-path action overrides for RPC-style endpoints (POST query → Read). */
  actions?: ActionOverride[];
  /** Compiled matcher cache (set by loadRoutes / createApp validation). */
  compiled?: { match: (pathname: string) => boolean; specificity: number };
}

export function expandEnv(s: string): string {
  return s.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '');
}

/**
 * Route path syntax:
 *  - static prefixes match exactly or as prefix (`/v1/orgs` + `/v1/orgs/...`,
 *    không khớp `/v1/organizations`);
 *  - a `*` segment matches exactly one non-empty path segment (slash-free);
 *  - a trailing slash-star matches any remainder, including none, so the LDS
 *    public rule covers both the export collection path and the single-entity
 *    path below it — but never sibling resources like records or attributes.
 * Specificity: more literal characters win, so static rules always shadow the
 * shorter prefix they overlap with and wildcard rules shadow `/v1/lds` for
 * their exact shape only.
 */
export function compileRoutePath(path: string): { match: (pathname: string) => boolean; specificity: number } {
  if (!path.includes('*')) {
    const match = (p: string) => p === path || p.startsWith(path + '/');
    return { match, specificity: path.length };
  }
  if (/\/\//.test(path) || !path.startsWith('/')) throw new Error(`[gateway] invalid wildcard route path '${path}'`);
  const segments = path.split('/');
  let literal = 0;
  let pattern = '^';
  segments.forEach((seg, i) => {
    if (i === 0) return;
    if (seg === '*' && i === segments.length - 1) {
      pattern += '(?:/.*)?';
      literal += 1; // the slash itself
    } else if (seg === '*') {
      pattern += '/[^/]+';
      literal += 1;
    } else {
      if (!seg) throw new Error(`[gateway] invalid wildcard route path '${path}' (empty segment)`);
      pattern += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      literal += seg.length;
    }
  });
  pattern += '$';
  const re = new RegExp(pattern);
  return { match: (p) => re.test(p), specificity: literal };
}

export function findRoute(routes: RouteRule[], pathname: string): RouteRule | undefined {
  let best: RouteRule | undefined;
  let bestScore = -1;
  for (const r of routes) {
    const m = r.compiled || (r.compiled = compileRoutePath(r.path)); // compiled at load; lazily here for legacy callers
    if (!m.match(pathname)) continue;
    if (m.specificity > bestScore) {
      best = r;
      bestScore = m.specificity;
    }
  }
  return best;
}

function loadRoutes(): RouteRule[] {
  const p = process.env.GATEWAY_ROUTES_PATH || './routes.yaml';
  const candidates = [p, './routes.yaml', '/app/routes.yaml', __dirname + '/../routes.yaml'];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const raw = expandEnv(fs.readFileSync(c, 'utf8'));
        const doc: any = yaml.load(raw);
        return (doc.routes || []) as RouteRule[];
      }
    } catch { /* try next */ }
  }
  // fallback defaults
  return [
    { path: '/v1/auth', target: IAM_SERVICE_URL, auth: 'none' },
    { path: '/v1/orgs', target: IAM_SERVICE_URL, auth: 'either' },
    { path: '/v1/workflows', target: process.env.WORKFLOW_SERVICE_URL || 'http://workflow:4002', auth: 'either' },
  ];
}

const SESSION_CACHE = new Map<string, { exp: number; status: number; error?: string }>();
function jwtCacheTtlMs(): number {
  const n = Number(process.env.GATEWAY_SESSION_CACHE_MS ?? 2000);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 30_000) : 2000;
}

/** Ask IAM (the authority for users.auth_version + active state) whether this
 *  exact access token is still valid. Positive and negative results are cached
 *  for a very short window to avoid an IAM round-trip per request. IAM/network
 *  failures fail closed for routes that require authentication. */
export function clearSessionCache(): void { SESSION_CACHE.clear(); }
export async function validateJwtSession(token: string, decoded: any, iamBase = IAM_SERVICE_URL): Promise<{ status: number; error: string } | null> {
  if (!decoded || decoded.kind === 'platform-step-up') return null;
  if (!decoded.sub) return { status: 401, error: 'invalid_token' };
  const ttl = jwtCacheTtlMs();
  const key = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const hit = SESSION_CACHE.get(key);
  if (hit && hit.exp > now) return hit.status === 200 ? null : { status: hit.status, error: hit.error || 'token_revoked' };
  if (SESSION_CACHE.size > 20_000) SESSION_CACHE.clear();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(`${iamBase.replace(/\/$/, '')}/v1/auth/verify`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      if (ttl > 0) SESSION_CACHE.set(key, { exp: Date.now() + ttl, status: 200 });
      return null;
    }
    if (r.status === 401) {
      if (ttl > 0) SESSION_CACHE.set(key, { exp: Date.now() + ttl, status: 401, error: 'token_revoked' });
      return { status: 401, error: 'token_revoked' };
    }
    if (r.status === 403) {
      let error = 'org_suspended';
      try { const body: any = await r.json(); if (body?.error) error = String(body.error); } catch { /* default */ }
      if (ttl > 0) SESSION_CACHE.set(key, { exp: Date.now() + ttl, status: 403, error });
      return { status: 403, error };
    }
    // IAM errors are never treated as "still valid".
    if (ttl > 0) SESSION_CACHE.set(key, { exp: Date.now() + 500, status: 503, error: 'iam_unavailable' });
    return { status: 503, error: 'iam_unavailable' };
  } catch {
    clearTimeout(timer);
    if (ttl > 0) SESSION_CACHE.set(key, { exp: Date.now() + 500, status: 503, error: 'iam_unavailable' });
    return { status: 503, error: 'iam_unavailable' };
  }
}

function authMiddleware(mode: RouteRule['auth']) {
  return (async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (mode === 'none') {
      // Public routes are anonymous, BUT a valid Bearer JWT or API key is
      // honoured as optional auth: public read-only MCP tools and LDS
      // exports share the same endpoint with authenticated tenant calls.
      // An invalid/absent credential stays anonymous.
      const h = String(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization || ''));
      const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (bearer) {
        try {
          const decoded: any = jwt.verify(bearer, JWT_SECRET, { issuer: JWT_ISSUERS, algorithms: ['HS256'] });
          if (decoded.kind === 'platform-step-up') {
            (req as any).synapseoneError = 'invalid_token';
            return res.status(401).json({ error: 'invalid_token', message: 'step-up token is not an access token' });
          }
          if (await validateJwtSession(bearer, decoded)) {
            // Optional auth: a revoked token falls back to anonymous, never tenant access.
            return next();
          }
          (req as any).principal = {
            type: 'jwt',
            kind: decoded.kind || 'user',
            sub: decoded.sub,
            org: decoded.org,
            account: decoded.account,
            scopes: decoded.scopes || [],
          };
          return next();
        } catch { /* try API key below */ }
      }
      const rawKey = req.headers['x-api-key'] as string | string[] | undefined;
      const apiKey = Array.isArray(rawKey) ? (rawKey[0] || '') : (rawKey || '') || bearer;
      if (apiKey && isVerifyApiKeyEnabled()) {
        verifyApiKeyUpstream(apiKey).then(
          (info) => {
            if (info) {
              (req as any).principal = {
                type: 'apikey',
                account: info.account_id,
                org: (info as any).org_id,
                scopes: info.scopes,
                keyId: info.id,
                owner: info.user_id,
              };
            }
            next();
          },
          () => next(),
        );
        return;
      }
      return next();
    }
    const h = String(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization || ''));
    const hasBearer = h.startsWith('Bearer ');
    const apiKeyRaw = req.headers['x-api-key'] as string | string[] | undefined;
    let apiKey = Array.isArray(apiKeyRaw) ? (apiKeyRaw[0] || '') : (apiKeyRaw || '');
    // MCP/CLI clients often only support an Authorization Bearer header.
    // For `either` routes, allow `Bearer <api-key>` as an API-key fallback.
    if (!apiKey && hasBearer && mode === 'either') apiKey = h.slice(7);
    if (mode === 'jwt' || mode === 'either') {
      if (hasBearer) {
        const token = h.slice(7);
        try {
          const decoded: any = jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUERS, algorithms: ['HS256'] });
          if (decoded.kind === 'platform-step-up') {
            (req as any).synapseoneError = 'invalid_token';
            return res.status(401).json({ error: 'invalid_token', message: 'step-up token is not an access token' });
          }
          const rejected = await validateJwtSession(token, decoded);
          if (rejected) {
            (req as any).synapseoneError = rejected.error;
            return res.status(rejected.status).json({ error: rejected.error, message: rejected.error === 'iam_unavailable' ? 'IAM session check unavailable' : rejected.error === 'org_suspended' ? 'This organization is suspended.' : 'This session was revoked. Sign in again.' });
          }
          (req as any).principal = {
            type: 'jwt',
            kind: decoded.kind || 'user',
            sub: decoded.sub,
            org: decoded.org,
            account: decoded.account,
            scopes: decoded.scopes || [],
          };
          return next();
        } catch (e) {
          (req as any).synapseoneError = 'invalid_token';
          if (mode === 'jwt') return res.status(401).json({ error: 'invalid_token', message: 'JWT invalid or expired' });
          // fallthrough to apikey check for 'either'
        }
      }
    }
    if (mode === 'apikey' || mode === 'either') {
      if (apiKey) {
        // Fail-closed by default: verify API keys against IAM.
        // GATEWAY_VERIFY_APIKEY=false is dev-only (presence check) and forbidden in prod.
        if (isVerifyApiKeyEnabled()) {
          verifyApiKeyUpstream(apiKey).then(
            (info) => {
              if (!info) {
                (req as any).synapseoneError = 'invalid_api_key';
                return res.status(401).json({ error: 'invalid_api_key' });
              }
              (req as any).principal = {
                type: 'apikey',
                account: info.account_id,
                org: (info as any).org_id,
                scopes: info.scopes,
                keyId: info.id,
                owner: info.user_id,
              };
              return next();
            },
            () => {
              (req as any).synapseoneError = 'iam_unavailable';
              return res.status(503).json({ error: 'iam_unavailable' });
            },
          );
          return;
        }
        if (process.env.NODE_ENV === 'production') {
          return res.status(500).json({ error: 'misconfigured', message: 'GATEWAY_VERIFY_APIKEY=false is forbidden in production' });
        }
        console.warn('[gateway][security] accepting unverified X-API-Key (GATEWAY_VERIFY_APIKEY=false, dev only)');
        (req as any).principal = { type: 'apikey' };
        return next();
      }
      if (mode === 'apikey') {
        (req as any).synapseoneError = 'missing_api_key';
        return res.status(401).json({ error: 'missing_api_key', message: 'X-API-Key required' });
      }
    }
    (req as any).synapseoneError = 'unauthorized';
    return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT and/or X-API-Key' });
  }) as any;
}

export async function verifyApiKeyUpstream(
  apiKey: string,
  iamBase?: string,
  internalSecret: string | undefined = INTERNAL_SECRET,
): Promise<{ id?: string; account_id: string; org_id?: string; user_id?: string | null; scopes: string[] } | null> {
  const iam = (iamBase || process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${iam}/v1/keys/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // IAM requires this when SYNAPSEONE_INTERNAL_SECRET is set (same value
        // propagatePrincipal attaches to proxied traffic). Without it,
        // GATEWAY_VERIFY_APIKEY=true + internal secret would fail-closed always.
        ...(internalSecret ? { 'x-synapseone-internal': internalSecret } : {}),
      },
      body: JSON.stringify({ apiKey }),
      signal: ctl.signal,
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!j.valid) return null;
    return { id: j.id, account_id: j.account_id, ...(j.org_id ? { org_id: j.org_id } : {}), user_id: j.user_id ?? null, scopes: j.scopes || [] };
  } catch {
    clearTimeout(to);
    throw new Error('iam_unreachable');
  }
}

/** Parse TRUST_PROXY (issue #41).
 *  Accepts:
 *   - unset/''/'0'/'false'  → disabled (direct exposure; the default)
 *   - an integer hop count   → trust that many proxies (`1` behind nginx)
 *   - a comma list of IPs/CIDRs/names (`loopback,172.16.0.0/12`)
 *  Rejects a blanket `true`: trusting every peer lets any client spoof
 *  X-Forwarded-For and forge another client's rate-limit bucket. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? '').trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') {
    throw new Error('[gateway] TRUST_PROXY=true is forbidden (any peer could spoof X-Forwarded-For). Use a hop count or a CIDR list.');
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new Error('[gateway] TRUST_PROXY hop count must be 1..10');
    }
    return n;
  }
  if (!/^[A-Za-z0-9.:/,_\- ]+$/.test(v)) {
    throw new Error('[gateway] TRUST_PROXY must be a hop count or a comma-separated IP/CIDR list');
  }
  return v;
}

/** Xóa x-synapseone-* do client gửi (chống spoof), ghi lại từ principal đã verify.
 *  Auth:none routes: đánh dấu `x-synapseone-anon: 1` để upstream phân biệt
 *  khách ẩn danh công khai (public LDS export) với platform context nội bộ —
 *  cả hai đều không có principal. Marker chỉ do gateway gắn, client gửi thêm
 *  sẽ bị xóa trước. */
export function propagatePrincipal(req: express.Request): void {
  const h = req.headers as Record<string, string | string[] | undefined>;
  delete h['x-synapseone-user'];
  delete h['x-synapseone-org'];
  delete h['x-synapseone-account'];
  delete h['x-synapseone-scopes'];
  delete h['x-synapseone-kind'];
  delete h['x-synapseone-internal'];
  delete h['x-synapseone-anon'];
  // Never let a client smuggle the legacy prefix past the new canonical names.
  // x-synapsedx-tenant is the one exception: platform callers (no principal)
  // have always selected a tenant with it, so it is normalised below.
  const legacyTenant = h['x-synapsedx-tenant'];
  for (const key of Object.keys(h)) {
    if (key.toLowerCase().startsWith('x-synapsedx-') && key.toLowerCase() !== 'x-synapsedx-tenant') delete h[key];
  }
  if (legacyTenant && !h['x-synapseone-tenant']) h['x-synapseone-tenant'] = legacyTenant;
  // Service-to-service credential: downstream (iam/workflow) requires this header
  // when SYNAPSEONE_INTERNAL_SECRET is configured. Set AFTER stripping client input
  // but BEFORE the principal check — unauthenticated routes (/v1/auth/*) need it too.
  if (INTERNAL_SECRET) h['x-synapseone-internal'] = INTERNAL_SECRET;
  const p = (req as any).principal;
  if (p?.type === 'jwt') {
    if (p.sub) h['x-synapseone-user'] = String(p.sub);
    if (p.org) h['x-synapseone-org'] = String(p.org);
    if (p.account) h['x-synapseone-account'] = String(p.account);
    if (Array.isArray(p.scopes) && p.scopes.length) h['x-synapseone-scopes'] = p.scopes.join(',');
    h['x-synapseone-kind'] = String(p.kind || 'user');
  } else if (p?.type === 'apikey') {
    h['x-synapseone-kind'] = 'apikey';
    if ((p as any).org) h['x-synapseone-org'] = String((p as any).org);
    if ((p as any).account) h['x-synapseone-account'] = String((p as any).account);
    // A user-bound API key (verified IAM `user_id`) acts for that user: stamp the
    // owner so workflow/audit/owner-only policies see the real user while the
    // credential keeps `kind=apikey`. Account-level keys have no owner and stay
    // pure machines. Client-supplied user headers were deleted above.
    if ((p as any).owner) h['x-synapseone-user'] = String((p as any).owner);
    if (Array.isArray((p as any).scopes) && (p as any).scopes.length) {
      h['x-synapseone-scopes'] = (p as any).scopes.join(',');
    }
  } else if ((req as any).synapseoneRoute?.auth === 'none') {
    // Unauthenticated call on a public route → anonymous visitor marker.
    // Platform context (internal ops, no marker) stays marker-less.
    h['x-synapseone-anon'] = '1';
  }
  // Mirror canonical headers onto the legacy prefix so a rolling deploy can
  // keep older upstream images working. Values are set only after the strip
  // above, so this can never amplify client-supplied identity.
  for (const name of ['user', 'org', 'account', 'scopes', 'kind', 'internal', 'anon']) {
    const value = h[`x-synapseone-${name}`];
    if (value !== undefined) h[`x-synapsedx-${name}`] = value;
  }
}

export function createApp(): express.Express {
  if (process.env.NODE_ENV === 'production' && !isVerifyApiKeyEnabled()) {
    throw new Error('[gateway] GATEWAY_VERIFY_APIKEY=false is forbidden in production (auth bypass). Set true.');
  }
  if (process.env.NODE_ENV === 'production' && process.env.AUTHZ_MODE_REQUIRED === 'true' && authzMode() === 'off') {
    throw new Error('[gateway] AUTHZ_MODE=off is forbidden when AUTHZ_MODE_REQUIRED=true. Set audit or enforce.');
  }
  if (process.env.NODE_ENV === 'production' && authzMode() === 'off') {
    console.warn('[gateway][security] AUTHZ_MODE=off — central policy enforcement is disabled. Set audit/enforce before exposing multi-tenant administration.');
  }
  const app = express();
  app.disable('x-powered-by');
  // Trust proxy (issue #41): behind nginx/TLS edge, req.ip must be the real
  // client from X-Forwarded-For, not the proxy container. Default is off so a
  // directly-exposed gateway can never be fooled by a spoofed header.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== false) app.set('trust proxy', trustProxy as any);
  if (process.env.NODE_ENV === 'production' && trustProxy === false) {
    console.warn('[gateway][security] TRUST_PROXY is unset in production — per-IP limits will key on the TLS edge address. Set TRUST_PROXY=1 (nginx) or a CIDR list.');
  }
  // Baseline security headers (no extra dep; gateway is a proxy, not a page server).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if ((process.env.HSTS_ENABLED || 'false') === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  // CORS: mở hết theo mặc định (MVP/dev); production BẮT BUỘC set CORS_ORIGIN=a.com,b.com
  const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!corsOrigins.length) {
    console.warn('[gateway][security] CORS_ORIGIN not set — allowing all origins (dev default). Set it in production.');
  }
  app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
  // Log kem request-id de trace gateway -> upstream (header do middleware rid gan ben duoi).
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Request ID: dùng client gửi lên nếu có, else tự sinh; trả về + forward upstream.
  // Sanitize: chỉ giữ token chars (tránh CRLF/header-injection làm crash setHeader).
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  // Request telemetry: one event per matched route, recorded on response finish.
  // The listener is installed before auth so rejected/anonymous calls are visible
  // too; route resolution happens later in the pipeline and is read at finish.
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req as any).synapseoneRoute as RouteRule | undefined;
      if (!route || isUsageExcluded(req.path)) return;
      const p = (req as any).principal;
      let authKind = 'unauthenticated';
      if (p?.type === 'jwt') authKind = p.kind || 'user';
      else if (p?.type === 'apikey') authKind = 'apikey';
      else if (route.auth === 'none') authKind = 'anonymous';

      const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - t0) / 1e6));
      const isUser = p?.type === 'jwt' && (p.kind || 'user') === 'user';
      enqueueUsage({
        createdAt: new Date().toISOString(),
        requestId: String(req.headers['x-request-id'] || ''),
        feature: featureForRoute(route.path),
        route: route.path,
        method: String(req.method || 'GET').toUpperCase(),
        path: String(req.path || ''),
        status: res.statusCode,
        durationMs,
        authKind,
        orgId: p?.org || null,
        accountId: p?.account || null,
        userId: isUser ? p.sub || null : null,
        error:
          (req as any).synapseoneError ||
          (res.statusCode >= 500 ? 'server_error' : res.statusCode >= 400 ? 'client_error' : null),
      });
    });
    next();
  }) as any);
  // In-memory edge rate limiting (per-IP; outer Ingress/WAF still required in prod
  // for DDoS, but this stops single-IP brute-force / /ready fan-out amplification).
  const hits = new Map<string, { n: number; reset: number }>();
  const WINDOW_MS = 60_000;
  /** Hard cap so a botnet spraying source IPs cannot grow the map forever. */
  const HITS_MAX = 50_000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, WINDOW_MS).unref?.();
  function edgeLimit(max: number) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      // req.ip honours TRUST_PROXY (parseTrustProxy above): behind the edge it is
      // the real client from X-Forwarded-For, not the nginx container IP.
      const ip = String(req.ip || req.socket?.remoteAddress || 'anon').slice(0, 64);
      const now = Date.now();
      if (hits.size > HITS_MAX) {
        for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
        if (hits.size > HITS_MAX) hits.clear(); // pathological spray: fail open for one window
      }
      const cur = hits.get(ip + ':' + max);
      if (!cur || cur.reset < now) { hits.set(ip + ':' + max, { n: 1, reset: now + WINDOW_MS }); return next(); }
      cur.n++;
      if (cur.n > max) {
        (req as any).synapseoneError = 'rate_limited';
        return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down' });
      }
      return next();
    };
  }
  // Per-tenant inference quota (#26): LLM calls burn a shared provider budget,
  // so cap requests per org/account (or client IP for anonymous) per minute.
  const INFERENCE_LIMIT_PER_MIN = Math.min(
    Math.max(Number(process.env.INFERENCE_RATE_LIMIT_PER_MIN || 60), 1),
    100_000,
  );
  const quotaHits = new Map<string, { n: number; reset: number }>();
  function inferenceQuota(req: express.Request): { ok: boolean; retryAfter: number } {
    const p = (req as any).principal;
    const key = `inference:${p?.org || p?.account || req.ip || 'anon'}`;
    const now = Date.now();
    const cur = quotaHits.get(key);
    if (!cur || cur.reset < now) {
      quotaHits.set(key, { n: 1, reset: now + WINDOW_MS });
      return { ok: true, retryAfter: 0 };
    }
    cur.n++;
    if (cur.n > INFERENCE_LIMIT_PER_MIN) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of quotaHits) if (v.reset < now) quotaHits.delete(k);
  }, WINDOW_MS).unref?.();

  // NOTE: không dùng express.json() toàn cục — body-parser sẽ nuốt stream
  // khiến http-proxy-middleware forward body rỗng/bể tới upstream.
  // Gateway là proxy thuần nên giữ nguyên raw body.

  app.get('/health', (_req, res) => res.json({
    status: 'ok',
    service: 'gateway',
    version: VERSION,
    schemaVersion: '1',
    // Shallow health: the gateway itself. Dependency detail lives on /ready.
    dependencies: [],
    time: new Date().toISOString(),
  }));
  app.get('/metrics', async (_req, res) => {
    try {
      res.setHeader('Content-Type', register.contentType);
      res.send(await register.metrics());
    } catch (e: any) {
      res.status(500).json({ error: 'metrics_failed', message: e.message });
    }
  });

  // Aggregate readiness: gateway + các upstream chính (timeout ngắn, không fail hard).
  // Rate-limited: mỗi hit quạt 1:2 upstream nên phải giới hạn.
  app.get('/ready', edgeLimit(30) as any, async (_req, res) => {
    async function probe(name: string, url: string): Promise<{ name: string; ok: boolean; status?: number; ms?: number; version?: string; error?: string }> {
      const t0 = Date.now();
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${url.replace(/\/$/, '')}/health`, {
          signal: ctl.signal,
          headers: {
            'x-request-id': 'ready-probe',
            ...(INTERNAL_SECRET ? { 'x-synapseone-internal': INTERNAL_SECRET } : {}),
          },
        });
        clearTimeout(to);
        let version: string | undefined;
        try {
          const body: any = await r.json();
          if (body && typeof body.version === 'string') version = body.version;
        } catch { /* non-JSON health is still a health signal */ }
        return { name, ok: r.ok, status: r.status, ms: Date.now() - t0, ...(version ? { version } : {}) };
      } catch {
        return { name, ok: false, ms: Date.now() - t0, error: 'unreachable' };
      }
    }
    const iamUrl = process.env.IAM_SERVICE_URL || 'http://iam:4001';
    const wfUrl = process.env.WORKFLOW_SERVICE_URL || 'http://workflow:4002';
    const aiUrl = process.env.AI_SERVICE_URL || 'http://ai:4003';
    const ldsUrl = process.env.LDS_SERVICE_URL || 'http://lds:4004';
    const baseUrl = process.env.BASE_SERVICE_URL || 'http://base:4005';
    const faststoreUrl = process.env.FASTSTORE_SERVICE_URL || 'http://faststore:4006';
    const queueUrl = process.env.QUEUE_SERVICE_URL || 'http://queue:4007';
    const streamUrl = process.env.STREAM_SERVICE_URL;
    const inferenceUrl = process.env.INFERENCE_SERVICE_URL;
    const ocsUrl = process.env.OCS_SERVICE_URL || process.env.STORAGE_SERVICE_URL;
    const notificationsUrl = process.env.NOTIFICATIONS_SERVICE_URL;
    const warehouseUrl = process.env.WAREHOUSE_SERVICE_URL;
    const probeList = [
      probe('iam', iamUrl), probe('workflow', wfUrl), probe('ai', aiUrl), probe('lds', ldsUrl),
      probe('base', baseUrl), probe('faststore', faststoreUrl), probe('queue', queueUrl),
    ];
    if (streamUrl) probeList.push(probe('stream', streamUrl));
    if (warehouseUrl) probeList.push(probe('warehouse', warehouseUrl));
    // Inference is a routed dependency; probe it whenever its URL is configured.
    if (inferenceUrl) probeList.push(probe('inference', inferenceUrl));
    if (ocsUrl) probeList.push(probe('ocs', ocsUrl));
    if (notificationsUrl) probeList.push(probe('notifications', notificationsUrl));
    const upstreams = await Promise.all(probeList);
    const allOk = upstreams.every((u) => u.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ready' : 'degraded',
      service: 'gateway',
      version: VERSION,
      schemaVersion: '1',
      upstreams,
      time: new Date().toISOString(),
    });
  });

  const routes = loadRoutes();
  // Precompile matchers + fail fast on operator typos: unknown auth mode would
  // 401 everything silently; malformed wildcard paths would throw mid-request.
  for (const r of routes) {
    if (!['none', 'jwt', 'apikey', 'either'].includes(r.auth)) {
      throw new Error(`[gateway] invalid auth mode '${r.auth}' for path '${r.path}' (want none|jwt|apikey|either)`);
    }
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
      throw new Error(`[gateway] invalid route path '${r.path}' (must start with /)`);
    }
    try {
      r.compiled = compileRoutePath(r.path);
    } catch (e: any) {
      throw new Error(`[gateway] ${e?.message || 'invalid route path'}`);
    }
    if (r.timeoutMs !== undefined && (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1000 || r.timeoutMs > 300000)) {
      throw new Error(`[gateway] invalid timeoutMs '${r.timeoutMs}' for path '${r.path}' (want 1000..300000)`);
    }
    if (r.service !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(String(r.service))) {
      throw new Error(`[gateway] invalid service '${r.service}' for path '${r.path}'`);
    }
    for (const o of r.actions || []) {
      if (!o || typeof o.path !== 'string' || !o.path.startsWith('/') || typeof o.action !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z]+$/.test(o.action)) {
        throw new Error(`[gateway] invalid action override on '${r.path}': ${JSON.stringify(o)}`);
      }
    }
  }
  const authz = authzMiddleware({ iamBase: IAM_SERVICE_URL, internalSecret: INTERNAL_SECRET });
  console.log(`[gateway] central authorization mode: ${authzMode()}`);
  console.log(`[gateway] loaded ${routes.length} routes: ${routes.map((r) => `${r.path}->${expandEnv(r.target)}[${r.auth}]`).join(', ')}`);

  app.get('/', (_req, res) =>
    res.json({
      name: 'SynapseOne Gateway (Tier-1 PaaS)',
      version: VERSION,
      docs: ['/health', '/ready', '/metrics'],
      auth: 'Bearer JWT | X-API-Key (except /v1/auth/*)',
      routes: routes.map((r) => ({ path: r.path, auth: r.auth })),
    }),
  );

  // Auth resolver toàn cục. KHÔNG dùng app.use(path, proxy): Express strips
  // mount-prefix khỏi req.url (bookkeeping slashAdded/removed); gán lại req.url
  // sẽ tạo URL rác với exact-path. Dùng pathFilter của proxy v3 + mount ở root.
  // Sau khi xác thực, gateway XÓA header x-synapseone-* do client gửi (chống spoof) và
  // GHI header từ principal đã verify để upstream tin dùng mà không cần re-verify JWT.
  // Auth endpoints (/v1/auth/*) đi thẳng nhưng vẫn giới hạn brute-force.
  // /v1/auth/verify is a server-to-server hot path used by Tier-2 for every
  // request; it is not a password attempt and must not be throttled by the
  // brute-force bucket.
  app.use('/v1/auth/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.originalUrl.split('?')[0] === '/v1/auth/verify') return next();
    return edgeLimit(120)(req, res, next);
  }) as any);
  app.use('/v1/platform/' as any, edgeLimit(120) as any);
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const urlPath = req.path; // pathname, không query
    if (urlPath === '/' || urlPath === '/health' || urlPath === '/metrics' || urlPath === '/ready') return next();
    // Service-to-service endpoints: never reachable through the public gateway,
    // even with a valid tenant credential. Internal callers hit the services
    // directly over the Docker network.
    const INTERNAL_ONLY_PATHS = new Set(['/v1/audit/ingest', '/v1/usage/ingest', '/v1/keys/verify']);
    if (INTERNAL_ONLY_PATHS.has(urlPath)) {
      return res.status(404).json({ error: 'not_found', message: 'No gateway route matched' });
    }
    const route = findRoute(routes, urlPath);
    if (!route) return res.status(404).json({ error: 'not_found', message: 'No gateway route matched' });
    (req as any).synapseoneRoute = route;
    httpCounter.inc({ route: route.path, status: 'incoming' });
    return authMiddleware(route.auth)(req, res, (err?: any) => {
      if (err) return next(err);
      // Per-route authorization (#23): the credential must carry a scope that
      // covers this service+action. Derive the service from the route table
      // (not a parallel prefix list) so every route, including RPC-style POSTs
      // with action overrides, is enforced consistently.
      const principal = (req as any).principal;
      const isPlatformPath = req.path === '/v1/platform' || req.path.startsWith('/v1/platform/');
      const isPlatformSession = req.path === '/v1/platform/session';
      if (isPlatformPath && !isPlatformSession && principal?.kind !== 'platform-admin') {
        (req as any).synapseoneError = 'platform_admin_required';
        return res.status(403).json({ error: 'platform_admin_required', message: 'a platform administrator token is required' });
      }
      if (!isPlatformPath && principal?.kind === 'platform-admin') {
        (req as any).synapseoneError = 'platform_token_tenant_forbidden';
        return res.status(403).json({ error: 'platform_token_tenant_forbidden', message: 'platform tokens cannot call tenant APIs' });
      }
      // The session exchange is the boundary where a normal user proves platform
      // administrator status + a fresh second factor. Central tenant-policy
      // enforcement must not pre-empt it (a tenant admin is not a platform
      // admin, but IAM owns that decision and writes the denial audit record).
      if (isPlatformSession) {
        propagatePrincipal(req);
        return next();
      }
      const scopeAction = route.service ? actionFor(route as any, req.method, req.path) : null;
      if (principal && route.auth !== 'none' && !scopeAllows(principal.scopes || [], req.path, req.method, {
        service: route.service,
        action: scopeAction || undefined,
      })) {
        (req as any).synapseoneError = 'scope_denied';
        return res.status(403).json({
          error: 'scope_denied',
          message: `Credential scopes do not allow ${String(req.method || 'GET').toUpperCase()} ${req.path}`,
        });
      }
      // Per-tenant inference quota (configurable budget, 429 + Retry-After).
      if (route.path === '/v1/inference' || route.path === '/v1/ai') {
        const quota = inferenceQuota(req);
        if (!quota.ok) {
          (req as any).synapseoneError = 'quota_exceeded';
          res.setHeader('Retry-After', String(quota.retryAfter));
          return res.status(429).json({
            error: 'quota_exceeded',
            message: `Inference quota is ${INFERENCE_LIMIT_PER_MIN} requests/minute per tenant`,
            retryAfter: quota.retryAfter,
          });
        }
      }
      propagatePrincipal(req);
      return authz(req, res, next);
    });
  }) as any);

  for (const r of routes) {
    const target = expandEnv(r.target).replace(/\/$/, '');
    const proxyTimeoutMs = (() => {
      if (r.timeoutMs !== undefined) return r.timeoutMs;
      const n = Number(process.env.PROXY_TIMEOUT_MS || 30000);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 300000) : 30000;
    })();
    // pathFilter = chuẩn theo cùng logic findRoute: mỗi request đúng MỘT proxy
    // (exclusive match) — wildcard routes phải chiếm đúng shape của chúng mà
    // không bị proxy prefix tổng ('/v1/lds') nhốt hết.
    const routeMatcher = (pathname: string) => findRoute(routes, pathname) === r;
    const proxy = createProxyMiddleware({
      pathFilter: routeMatcher as any,
      target,
      changeOrigin: true,
      logLevel: 'warn',
      // Upstream treo thì 504 sau 30s thay vì treo gateway theo.
      proxyTimeout: proxyTimeoutMs,
      timeout: proxyTimeoutMs,
      // HPM v3: error handling qua `on.error` (KHÔNG phải `onError` v2).
      // Upstream chết giữa chừng (ECONNREFUSED/socket hangup): trả 502 JSON ngay
      // thay vì trang 504 mặc định của proxy.
      on: {
        error: (err: any, _req: any, res: any) => {
          (_req as any).synapseoneError = 'upstream_unavailable';
          console.error(`[gateway] proxy ${r.path}->${target} failed:`, err?.message || err);
          try {
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            if (!res.writableEnded) res.end(JSON.stringify({ error: 'bad_gateway', message: 'upstream unavailable' }));
          } catch { /* socket already dead */ }
        },
      },
    } as any);
    app.use(proxy as any); // không path → proxy tự filter theo pathFilter, forward nguyên req.url
  }

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'No gateway route matched' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (res.headersSent || res.writableEnded) return;
    res.status(500).json({ error: 'gateway_error' });
  });
  if (isUsageTelemetryEnabled()) startUsageTelemetry();
  return app;
}

if (require.main === module) {
  // 19+ routes → every proxy registers a close listener on the server; the
  // default EventEmitter cap of 10 turns that into a scary warning per boot.
  require('node:events').EventEmitter.defaultMaxListeners = 60;
  const app = createApp();
  const server = app.listen(PORT, () => console.log(`[gateway] listening on :${PORT}`));
  const shutdown = () => {
    console.log('[gateway] shutting down...');
    server.close(() => {
      // Best-effort: ship the last telemetry batch before exiting.
      void flushUsageNow().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
