// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Real OIDC Authorization Code flow (Authentik / Keycloak / any OIDC IdP).
 * No extra dependencies: discovery + token exchange over fetch, ID-token
 * signature verification via JWKS + node:crypto JWK import + jsonwebtoken.
 */
import jwt from 'jsonwebtoken';
import { createHmac, randomBytes, createPublicKey, timingSafeEqual } from 'crypto';
import { getJwtSecret } from './tokens';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  provider: string;
}

export function oidcSettings(): OidcSettings {
  return {
    // Public HTTPS issuer (browser-reachable). The old internal
    // http://authentik-server:9000 default made production login impossible.
    issuer: (process.env.OIDC_ISSUER || 'https://auth.synapseone.space/application/o/synapseone/').replace(/\/*$/, '/'),
    clientId: process.env.OIDC_CLIENT_ID || 'synapseone-platform',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || 'http://localhost:3000/oidc/callback',
    provider: process.env.OIDC_PROVIDER || 'authentik',
  };
}

/** True when a URL is HTTPS and its host is publicly resolvable (not an
 *  internal docker/k8s name, loopback or RFC1918 address). */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.svc')) return false;
  if (!host.includes('.')) return false; // bare service name (iam, authentik-server)
  if (/^127\./.test(host) || host === '::1' || host === '[::1]') return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  return true;
}

/** Production boot guard for the OIDC configuration (issue #21).
 *  A browser must be able to reach the authorize URL over valid TLS. */
export function assertOidcConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const rawIssuer = String(env.OIDC_ISSUER || '').trim();
  if (!rawIssuer) {
    throw new Error(
      '[iam] OIDC_ISSUER must be configured in production with a public HTTPS issuer '
      + '(e.g. https://auth.example.com/application/o/synapseone/).',
    );
  }
  const issuer = rawIssuer.replace(/\/*$/, '/');
  if (!isPublicHttpsUrl(issuer)) {
    // Explicit operator override for deployments where Authentik/Keycloak is
    // not exposed publicly yet (the browser path is handled by the reverse
    // proxy later). Never enable this on a shared/public issuer without TLS.
    const allowInternal = String(env.IAM_ALLOW_INTERNAL_OIDC_ISSUER || '').toLowerCase() === 'true';
    if (!allowInternal) {
      throw new Error(
        `[iam] OIDC_ISSUER must be a public HTTPS URL in production (got '${issuer}'). `
        + "Browsers cannot resolve an internal Docker host; configure e.g. https://auth.example.com/application/o/synapseone/.",
      );
    }
    console.warn(`[iam] OIDC_ISSUER is not a public HTTPS URL ('${issuer}'); IAM_ALLOW_INTERNAL_OIDC_ISSUER=true is set.`);
  }
  const clientId = String(env.OIDC_CLIENT_ID || '').trim();
  if (!clientId || clientId.includes('change_me')) {
    throw new Error('[iam] OIDC_CLIENT_ID must be set to the IdP client id in production.');
  }
  if (!env.OIDC_CLIENT_SECRET || env.OIDC_CLIENT_SECRET.includes('change_me')) {
    throw new Error('[iam] OIDC_CLIENT_SECRET must be set to the IdP client secret in production.');
  }
  // The browser is redirected back to this URL, so it must be public HTTPS too
  // (a localhost/internal callback is unreachable for the end user).
  const redirect = env.OIDC_REDIRECT_URI || '';
  if (!isPublicHttpsUrl(redirect)) {
    throw new Error(
      `[iam] OIDC_REDIRECT_URI must be a public HTTPS URL in production (got '${redirect || '(unset)'}'); `
      + 'point it at the Console /oidc/callback page, e.g. https://cloud.example.com/oidc/callback.',
    );
  }
}

export class OidcError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!r.ok) {
      const detail =
        typeof body === 'object' && body
          ? String((body as any).error_description || (body as any).error || r.status).slice(0, 200)
          : String(r.status);
      throw new OidcError('oidc_upstream_error', `IdP request failed (${detail})`, 502);
    }
    return body;
  } catch (e: any) {
    if (e instanceof OidcError) throw e;
    throw new OidcError('oidc_unreachable', `IdP unreachable: ${e?.message || e}`, 502);
  } finally {
    clearTimeout(to);
  }
}

// ---------- signed state (CSRF/replay protection for the SPA round-trip) ----------

const STATE_TTL_MS = 10 * 60 * 1000;

function b64u(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function stateSecret(): string {
  // Separate key for OIDC state HMAC so a leaked JWT secret alone doesn't forge state.
  return process.env.OIDC_STATE_SECRET || getJwtSecret();
}

/** state = base64url({org,t,n}).hmac — HMAC key is OIDC_STATE_SECRET (fallback JWT secret). */
export function signState(org: string): string {
  const payload = b64u({ org, t: Date.now(), n: randomBytes(16).toString('hex') });
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyState(state: string): { org: string } {
  const parts = String(state || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (format).', 400);
  }
  const want = createHmac('sha256', stateSecret()).update(parts[0]).digest();
  let got: Buffer;
  try {
    got = Buffer.from(parts[1], 'hex');
  } catch {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (signature).', 400);
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (signature).', 400);
  }
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (payload).', 400);
  }
  if (typeof payload.org !== 'string' || !/^[a-z0-9-]{1,64}$/.test(payload.org)) {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (org).', 400);
  }
  if (typeof payload.t !== 'number' || Date.now() - payload.t > STATE_TTL_MS || payload.t > Date.now() + 60_000) {
    throw new OidcError('oidc_state_expired', 'OIDC state expired — restart login.', 400);
  }
  return { org: payload.org };
}

// ---------- discovery + JWKS (short-TTL caches) ----------

interface CacheEntry {
  at: number;
  value: any;
}
let discovery: CacheEntry | null = null;
const jwksCache = new Map<string, { at: number; value: any }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function discover(issuer: string): Promise<any> {
  if (discovery && Date.now() - discovery.at < CACHE_TTL_MS && discovery.value.__issuer === issuer) {
    return discovery.value;
  }
  const url = `${issuer}.well-known/openid-configuration`;
  let doc: any;
  try {
    doc = await fetchJson(url, { headers: { Accept: 'application/json' } }, 10_000);
  } catch (e: any) {
    if (e instanceof OidcError) {
      throw new OidcError('oidc_discovery_failed', e.message, e.status);
    }
    throw e;
  }
  if (!doc || typeof doc !== 'object' || !doc.token_endpoint || !doc.jwks_uri || !doc.authorization_endpoint) {
    throw new OidcError('oidc_discovery_failed', 'IdP discovery document is missing endpoints.', 502);
  }
  // Pin the issuer we configured: prevents an attacker-controlled discovery doc
  // from redirecting the exchange at a rogue token endpoint mid-flight.
  if (typeof doc.issuer === 'string' && doc.issuer.replace(/\/*$/, '/') !== issuer) {
    throw new OidcError('oidc_issuer_mismatch', 'IdP issuer mismatch (possible misconfiguration).', 502);
  }
  // Production guard: IdP endpoints must share the issuer origin (blocks discovery-doc
  // redirect to rogue hosts) and use https (blocks credential + code interception).
  if (process.env.NODE_ENV === 'production') {
    try {
      const issuerOrigin = new URL(issuer).origin;
      for (const k of ['token_endpoint', 'jwks_uri', 'authorization_endpoint'] as const) {
        const u = new URL(String(doc[k]));
        if (u.origin !== issuerOrigin) {
          throw new OidcError('oidc_endpoint_origin', `IdP ${k} is not on the issuer origin.`, 502);
        }
        if (u.protocol !== 'https:') {
          throw new OidcError('oidc_insecure_endpoint', `IdP ${k} must use https in production.`, 502);
        }
      }
    } catch (e: any) {
      if (e instanceof OidcError) throw e;
      throw new OidcError('oidc_discovery_failed', 'IdP discovery endpoints are not valid URLs.', 502);
    }
  }
  doc.__issuer = issuer;
  discovery = { at: Date.now(), value: doc };
  return doc;
}

/** Resolve the browser-facing authorize endpoint from discovery (validated
 *  by `discover`: https + issuer origin in production). */
export async function authorizationEndpoint(issuer: string): Promise<string> {
  const doc = await discover(issuer.replace(/\/*$/, '/'));
  return String(doc.authorization_endpoint);
}

async function getJwks(jwksUri: string): Promise<any[]> {  const hit = jwksCache.get(jwksUri);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const doc: any = await fetchJson(jwksUri, { headers: { Accept: 'application/json' } }, 10_000);
  if (!doc || !Array.isArray(doc.keys)) {
    throw new OidcError('oidc_jwks_failed', 'IdP JWKS document has no keys.', 502);
  }
  jwksCache.set(jwksUri, { at: Date.now(), value: doc.keys });
  return doc.keys;
}

/** Test hook: drop cached discovery/JWKS (unit tests point at a stub IdP). */
export function __clearOidcCache(): void {
  discovery = null;
  jwksCache.clear();
}

// ---------- ID-token verification ----------

const ALLOWED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384']);

export interface VerifiedIdentity {
  org: string;
  email: string;
  sub: string;
  displayName: string;
}

async function verifyIdToken(idToken: string, doc: any, clientId: string, issuer: string): Promise<any> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('oidc_bad_id_token', 'Malformed ID token.', 502);
  let header: any;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new OidcError('oidc_bad_id_token', 'Malformed ID token header.', 502);
  }
  // Never accept symmetric or unsigned IdP tokens: the IdP must prove itself
  // with an asymmetric key from its own JWKS.
  if (!ALLOWED_ALGS.has(header.alg) || !header.kid) {
    throw new OidcError('oidc_bad_id_token', 'ID token must be asymmetrically signed (RS*/ES*) with a kid.', 502);
  }
  const keys = await getJwks(doc.jwks_uri);
  const jwk = keys.find((k: any) => k.kid === header.kid && (k.kty === 'RSA' || k.kty === 'EC'));
  if (!jwk) throw new OidcError('oidc_unknown_kid', 'ID token key not found in IdP JWKS.', 502);
  let pem: string;
  try {
    pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'pem', type: 'spki' }) as string;
  } catch {
    throw new OidcError('oidc_bad_jwk', 'IdP JWK could not be imported.', 502);
  }
  try {
    return jwt.verify(idToken, pem, { algorithms: [header.alg], issuer, audience: clientId });
  } catch (e: any) {
    throw new OidcError('oidc_bad_id_token', `ID token verification failed: ${e?.message || e}`, 502);
  }
}

// ---------- full exchange ----------

export async function exchangeCode(code: string, state: string): Promise<VerifiedIdentity> {
  const { org } = verifyState(state);
  if (!code || typeof code !== 'string' || code.length > 4096) {
    throw new OidcError('oidc_code_required', 'Authorization `code` is required.', 400);
  }
  const cfg = oidcSettings();
  if (!cfg.clientSecret) {
    throw new OidcError(
      'oidc_not_configured',
      'OIDC_CLIENT_SECRET is not set — configure the IdP client first.',
      501,
    );
  }
  const doc = await discover(cfg.issuer);
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const tok: any = await fetchJson(
    doc.token_endpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params.toString() },
    15_000,
  );
  if (!tok || typeof tok.id_token !== 'string') {
    throw new OidcError('oidc_token_failed', 'IdP did not return an ID token.', 502);
  }
  const claims: any = await verifyIdToken(tok.id_token, doc, cfg.clientId, cfg.issuer);
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new OidcError('oidc_no_email', 'IdP did not release an email claim (check client scopes).', 502);
  }
  // Require verified email when the IdP releases the claim (prevents impersonation
  // via unverified addresses). IdPs that omit the claim are still accepted.
  if ('email_verified' in claims && claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new OidcError('oidc_email_unverified', 'IdP email address is not verified.', 502);
  }
  // OIDC `sub` is mandatory — never fall back to email (weak binding).
  const rawSub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!rawSub) {
    throw new OidcError('oidc_no_sub', 'IdP did not release a sub claim.', 502);
  }
  const sub = rawSub.slice(0, 320);
  const rawName = String(claims.name || claims.preferred_username || email).trim();
  // Strip control chars / angle brackets (stored-XSS hardening for console rendering).
  const displayName = rawName.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 200) || email;
  return { org, email, sub, displayName };
}
