// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Central authorization point (AWS-style). After authentication, every
 * request on a route that declares a `service` is mapped to an action
 * (`<service>:<Verb>`) and a resource ARN, then decided by IAM for the
 * verified principal (user, service account or API key).
 *
 *   AUTHZ_MODE=off      no policy check (tenant isolation only, legacy)
 *   AUTHZ_MODE=audit    decide + log/audit, never block (safe rollout)
 *   AUTHZ_MODE=enforce  deny → 403 access_denied; IAM down → 503
 *
 * Decisions are cached briefly per (principal, action, resource) so the hot
 * path does not hit IAM on every request.
 */
import type express from 'express';
import client from 'prom-client';

export type AuthzMode = 'off' | 'audit' | 'enforce';

export interface ActionOverride {
  method?: string;
  path: string;
  action: string;
}

export interface AuthzRoute {
  path: string;
  service?: string;
  actions?: ActionOverride[];
}

export interface AuthzPrincipal {
  type: 'jwt' | 'apikey';
  kind?: string;
  sub?: string;
  org?: string;
  account?: string;
  scopes?: string[];
  keyId?: string;
}

export interface AuthzDecision {
  allowed: boolean;
  reason: string;
}

export function authzMode(): AuthzMode {
  const raw = String(process.env.AUTHZ_MODE || 'off').trim().toLowerCase();
  return raw === 'audit' || raw === 'enforce' ? raw : 'off';
}

/** Default verb from the HTTP method; routes override RPC-style POSTs. */
export function verbForMethod(method: string): string {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return 'Read';
  if (m === 'DELETE') return 'Delete';
  return 'Write';
}

function matchOverridePath(pattern: string, pathname: string): boolean {
  // Same shape rules as route paths: `*` = one segment, trailing `/*` = rest.
  const segs = pattern.split('/');
  let re = '^';
  segs.forEach((seg, i) => {
    if (i === 0) return;
    if (seg === '*' && i === segs.length - 1) re += '(?:/.*)?';
    else if (seg === '*') re += '/[^/]+';
    else re += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(re + '$').test(pathname);
}

export function actionFor(route: AuthzRoute, method: string, pathname: string): string | null {
  if (!route.service) return null;
  for (const o of route.actions || []) {
    if (o.method && o.method.toUpperCase() !== method.toUpperCase()) continue;
    if (matchOverridePath(o.path, pathname)) return o.action;
  }
  return `${route.service}:${verbForMethod(method)}`;
}

/** arn:synapseone:<org>:<account>:<service>:<resource-path> ('-' = none). */
export function resourceFor(route: AuthzRoute, principal: AuthzPrincipal | undefined, pathname: string): string {
  const service = route.service || 'unknown';
  let rest = pathname.replace(/^\/v1\//, '').replace(/^\/+/, '');
  if (rest === service) rest = '';
  else if (rest.startsWith(service + '/')) rest = rest.slice(service.length + 1);
  const clean = (v?: string) => (v && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : '-');
  return `arn:synapseone:${clean(principal?.org)}:${clean(principal?.account)}:${service}:${rest.slice(0, 1500)}`;
}

function principalKey(p: AuthzPrincipal): string {
  if (p.type === 'apikey') return `k:${p.keyId}`;
  return `${p.kind || 'user'}:${p.sub}:${(p.scopes || []).join(',')}`;
}

/** Body sent to IAM `/internal/authorize`; null when the principal has no
 *  verifiable identity (dev presence-only API keys). */
export function iamPrincipal(p: AuthzPrincipal): Record<string, unknown> | null {
  if (p.type === 'apikey') return p.keyId ? { kind: 'apikey', keyId: p.keyId, account: p.account } : null;
  if (!p.sub) return null;
  return {
    kind: p.kind === 'service-account' ? 'service-account' : 'user',
    sub: p.sub,
    org: p.org,
    account: p.account,
    scopes: p.scopes && p.scopes.length ? p.scopes : undefined,
  };
}

// ---------- decision cache ----------

const cache = new Map<string, { d: AuthzDecision; exp: number }>();

function cacheTtlMs(): number {
  const n = Number(process.env.AUTHZ_CACHE_TTL_MS ?? 30000);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 300000) : 30000;
}
const CACHE_MAX = 10000;

export function clearAuthzCache(): void {
  cache.clear();
}

export async function decideViaIam(
  principal: Record<string, unknown>,
  action: string,
  resource: string,
  iamBase: string,
  internalSecret: string,
): Promise<AuthzDecision> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${iamBase.replace(/\/$/, '')}/internal/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalSecret ? { 'x-synapseone-internal': internalSecret } : {}),
      },
      body: JSON.stringify({ principal, action, resource }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`iam_status_${r.status}`);
    const j: any = await r.json();
    return { allowed: j.allowed === true, reason: String(j.reason || 'unknown') };
  } finally {
    clearTimeout(to);
  }
}

let decisions: client.Counter<'mode' | 'result'> | null = null;

export function registerAuthzMetrics(register: client.Registry): void {
  decisions = new client.Counter({
    name: 'gateway_authz_decisions_total',
    help: 'Central authorization decisions',
    labelNames: ['mode', 'result'],
    registers: [register],
  });
}

/**
 * Express middleware factory. `decide` is injectable for tests; production
 * uses IAM. Runs after authentication (req.principal) and route resolution.
 */
export function authzMiddleware(opts: {
  iamBase: string;
  internalSecret: string;
  decide?: typeof decideViaIam;
}) {
  const decide = opts.decide || decideViaIam;
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const mode = authzMode();
    const route = (req as any).synapseoneRoute as (AuthzRoute & { auth?: string }) | undefined;
    const principal = (req as any).principal as AuthzPrincipal | undefined;
    if (mode === 'off' || !route?.service || route.auth === 'none' || !principal || req.method === 'OPTIONS') return next();
    const body = iamPrincipal(principal);
    if (!body) return next();
    const action = actionFor(route, req.method, req.path)!;
    const resource = resourceFor(route, principal, req.path);
    const key = `${principalKey(principal)}|${action}|${resource}`;
    let d: AuthzDecision | undefined;
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) d = hit.d;
    if (!d) {
      try {
        d = await decide(body, action, resource, opts.iamBase, opts.internalSecret);
        const ttl = cacheTtlMs();
        if (ttl > 0) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(key, { d, exp: Date.now() + ttl });
        }
      } catch {
        decisions?.inc({ mode, result: 'error' });
        if (mode === 'enforce') {
          (req as any).synapseoneError = 'authz_unavailable';
          return res.status(503).json({ error: 'authz_unavailable', message: 'authorization service unreachable' });
        }
        return next();
      }
    }
    (req as any).synapseoneAuthz = { action, resource, ...d };
    if (d.allowed) {
      decisions?.inc({ mode, result: 'allow' });
      return next();
    }
    decisions?.inc({ mode, result: 'deny' });
    if (mode === 'audit') {
      res.setHeader('x-synapseone-authz', `would-deny; action=${action}; reason=${d.reason}`);
      console.warn(`[gateway][authz] audit would-deny ${action} on ${resource} (${d.reason})`);
      return next();
    }
    (req as any).synapseoneError = 'access_denied';
    return res.status(403).json({
      error: 'access_denied',
      message: `not authorized to perform ${action} on ${resource}`,
      action,
      resource,
      reason: d.reason,
    });
  };
}
