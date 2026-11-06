// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Token management: JWT access tokens + opaque refresh tokens + API keys.
 */
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { ensureTables, getDb, useDb, __mem, hashSecret, hashCandidates } from './db';
import { apiKeys, refreshTokens } from './schema';

/** Fail fast on weak/default JWT secrets in production; warn loudly in dev. */
function jwtSecret(): string {
  const s = process.env.IAM_JWT_SECRET || '';
  const weak = !s || s.includes('change_me') || s.length < 32;
  if (weak) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[iam] IAM_JWT_SECRET must be set to a random value ≥32 chars in production');
    }
    console.warn('[iam][security] WARNING: IAM_JWT_SECRET is default/weak — dev only. Set a random ≥32-char secret before exposing anything.');
  }
  return s || 'change_me_super_secret_32chars_min';
}

const JWT_SECRET = jwtSecret();

/** Shared HMAC/JWT secret (also signs OIDC `state`; see oidc.ts). */
export function getJwtSecret(): string {
  return JWT_SECRET;
}

function ttl(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) {
    console.warn(`[iam][security] ${name} is not a number — using default ${fallback}`);
    return fallback;
  }
  return Math.min(Math.max(Math.floor(raw), min), max);
}

// Clamp TTLs so a garbage env can't produce NaN/negative expiries (login 500s,
// immortal tokens, or instantly-dead refresh).
const ACCESS_TTL = ttl('IAM_JWT_EXPIRES_IN', 3600, 60, 86400);
const REFRESH_TTL = ttl('IAM_REFRESH_EXPIRES_IN', 2592000, 3600, 315360000);

/** Thời điểm hết hạn refresh token mới (dùng REFRESH_TTL, mặc định 30 ngày). */
export function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TTL * 1000);
}

export interface AccessClaims {
  sub: string; // user id
  email?: string;
  org?: string; // org id
  account?: string; // account id
  scopes?: string[];
  kind?: string;
  /** Delegated token: the service identity that acted for the user. */
  act?: { sub: string; kind?: string };
  /** Delegation marker + audience (Tier-2 service). */
  delegated?: boolean;
  aud?: string;
}

export function signAccess(
  claims: AccessClaims,
  opts: { expiresIn?: number; audience?: string } = {},
): { token: string; expiresIn: number } {
  const expiresIn = Math.min(Math.max(Math.floor(opts.expiresIn ?? ACCESS_TTL), 60), 86_400);
  const kind = claims.kind || 'user';
  // Org-member user tokens carry full authority; narrow credentials (service
  // accounts, delegated tokens) pass scopes explicitly and are never widened.
  const scopes = claims.scopes ?? (kind === 'user' ? ['*'] : []);
  const payload: Record<string, unknown> = { ...claims, scopes, iss: 'synapseone-iam', kind };
  if (opts.audience) payload.aud = opts.audience;
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn });
  return { token, expiresIn };
}

/**
 * Sign a short-lived delegated token for a specific user (issue #22).
 * `act` records the service identity that requested it; the audit trail uses
 * the same fields. TTL is capped at 1h so a leaked token expires quickly.
 */
export function signDelegated(input: {
  userId: string;
  org: string;
  account: string;
  scopes: string[];
  actor: string;
  actorKind?: string;
  audience?: string;
  ttlSeconds?: number;
}): { token: string; expiresIn: number } {
  return signAccess(
    {
      sub: input.userId,
      org: input.org,
      account: input.account,
      scopes: input.scopes,
      kind: 'delegated',
      delegated: true,
      act: { sub: input.actor, kind: input.actorKind || 'service-account' },
    },
    { expiresIn: input.ttlSeconds ?? 900, audience: input.audience },
  );
}

export function verifyAccess(token: string): AccessClaims {
  // Accept legacy issuer during the rebrand window so existing sessions survive.
  return jwt.verify(token, JWT_SECRET, { issuer: ['synapseone-iam', 'synapsedx-iam'], algorithms: ['HS256'] }) as AccessClaims;
}

export function newRefreshToken(): { value: string; hash: string } {
  const value = 'synapseone_rt_' + randomBytes(32).toString('base64url');
  return { value, hash: hashSecret(value) };
}

/** Resolve a presented refresh token to its stored hash (peppered or legacy). */
function refreshHashes(value: string): string[] {
  return hashCandidates(value);
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export async function storeRefresh(userId: string, hash: string, expiresAt: Date): Promise<void> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    await db.insert(refreshTokens).values({ userId, tokenHash: hash, expiresAt });
    return;
  }
  __mem.refresh.set(hash, { id: randomUUID(), user_id: userId, expires_at: expiresAt.toISOString(), revoked_at: null, created_at: new Date().toISOString() });
}

export async function consumeRefresh(value: string): Promise<{ user_id: string } | null> {
  for (const hash of refreshHashes(value)) {
    const hit = await consumeRefreshByHash(hash);
    if (hit) return hit;
  }
  return null;
}

async function consumeRefreshByHash(hash: string): Promise<{ user_id: string } | null> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    }).from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) return null;
    return { user_id: row.userId };
  }
  const rec = __mem.refresh.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;
  return { user_id: rec.user_id };
}

/** Thu hồi refresh token (dùng khi rotate hoặc logout). Thu hồi mọi candidate hash (peppered + legacy). */
export async function revokeRefresh(value: string): Promise<void> {
  for (const hash of refreshHashes(value)) {
    if (useDb()) {
      const db = getDb()!;
      await ensureTables();
      await db.update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)));
    } else {
      const rec = __mem.refresh.get(hash);
      if (rec && !rec.revoked_at) rec.revoked_at = new Date().toISOString();
    }
  }
}

/**
 * Tiêu thụ + thu hồi NGUYÊN TỬ (1 câu lệnh / 1 tick): 2 request song song
 * dùng cùng RT thì chỉ 1 thành công — chống replay tuyệt đối.
 */
export async function consumeAndRevokeRefresh(value: string): Promise<{ user_id: string } | null> {
  for (const hash of refreshHashes(value)) {
    const hit = await consumeAndRevokeByHash(hash);
    if (hit) return hit;
  }
  return null;
}

async function consumeAndRevokeByHash(hash: string): Promise<{ user_id: string } | null> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(
        eq(refreshTokens.tokenHash, hash),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.expiresAt} > now()`,
      ))
      .returning({ userId: refreshTokens.userId });
    return rows[0] ? { user_id: rows[0].userId } : null;
  }
  const rec = __mem.refresh.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;
  rec.revoked_at = new Date().toISOString();
  return { user_id: rec.user_id };
}

/** Lookup owner of a refresh token even if revoked/expired (reuse-detection). */
export async function findRefreshOwner(value: string): Promise<{ user_id: string } | null> {
  for (const hash of refreshHashes(value)) {
    if (useDb()) {
      const db = getDb()!;
      await ensureTables();
      try {
        const rows = await db.select({ userId: refreshTokens.userId })
          .from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
        if (rows[0]) return { user_id: rows[0].userId };
      } catch { /* ignore */ }
    } else {
      const rec = __mem.refresh.get(hash);
      if (rec) return { user_id: rec.user_id };
    }
  }
  return null;
}

/** Thu hồi TẤT CẢ refresh token của user (mất thiết bị). Trả về số token bị thu hồi. */
export async function revokeAllRefresh(userId: string): Promise<number> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length;
  }
  let n = 0;
  for (const rec of __mem.refresh.values()) {
    if (rec.user_id === userId && !rec.revoked_at) {
      rec.revoked_at = new Date().toISOString();
      n++;
    }
  }
  return n;
}

/** Session metadata (refresh-token rows) for the account-security UI. */
export interface RefreshSession {
  id: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
}

export async function listRefreshSessions(userId: string): Promise<RefreshSession[]> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      id: refreshTokens.id,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
      createdAt: refreshTokens.createdAt,
    }).from(refreshTokens)
      .where(eq(refreshTokens.userId, userId))
      .orderBy(desc(refreshTokens.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      expires_at: iso(r.expiresAt),
      revoked_at: iso(r.revokedAt),
      created_at: iso(r.createdAt),
    }));
  }
  const out: RefreshSession[] = [];
  for (const rec of __mem.refresh.values()) {
    if (rec.user_id === userId) {
      out.push({ id: rec.id || '', expires_at: rec.expires_at || null, revoked_at: rec.revoked_at || null, created_at: rec.created_at || null });
    }
  }
  return out;
}

/** Revoke one session owned by the user (id is the refresh-token row id). */
export async function revokeRefreshById(userId: string, id: string): Promise<boolean> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.id, id), eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length > 0;
  }
  for (const rec of __mem.refresh.values()) {
    if (rec.user_id === userId && rec.id === id && !rec.revoked_at) {
      rec.revoked_at = new Date().toISOString();
      return true;
    }
  }
  return false;
}

export async function createApiKeyRecord(accountId: string, userId: string | null, name: string, scopes: string[], expiresAt: Date | null): Promise<{ id: string; value: string; prefix: string }> {  const raw = 'synapseone_' + randomBytes(24).toString('base64url');
  const prefix = raw.slice(0, 12);
  const hash = hashSecret(raw);
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.insert(apiKeys).values({
      accountId,
      userId,
      keyPrefix: prefix,
      keyHash: hash,
      name,
      scopes,
      expiresAt,
    }).returning({ id: apiKeys.id });
    return { id: rows[0].id, value: raw, prefix };
  }
  const id = randomUUID();
  __mem.apiKeys.set(hash, { id, account_id: accountId, user_id: userId, key_prefix: prefix, name, scopes, expires_at: expiresAt?.toISOString() || null, revoked_at: null, created_at: new Date().toISOString() });
  return { id, value: raw, prefix };
}

/** Thu hồi API key theo id (trả về false nếu không tồn tại). */
export async function revokeApiKey(id: string): Promise<boolean> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }
  for (const rec of __mem.apiKeys.values()) {
    if (rec.id === id && !rec.revoked_at) {
      rec.revoked_at = new Date().toISOString();
      return true;
    }
  }
  return false;
}

/** Revoke every API key created on behalf of a deprovisioned user. */
export async function revokeApiKeysForUser(userId: string): Promise<number> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length;
  }
  let count = 0;
  for (const rec of __mem.apiKeys.values()) {
    if (rec.user_id === userId && !rec.revoked_at) {
      rec.revoked_at = new Date().toISOString();
      count++;
    }
  }
  return count;
}

/** Lookup by id for tenant-scoped revoke (safe fields only). */
export interface ApiKeyRecord {
  account_id: string;
  user_id: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

export async function findApiKeyById(id: string): Promise<ApiKeyRecord | null> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      accountId: apiKeys.accountId,
      userId: apiKeys.userId,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const r = rows[0];
    return r
      ? { account_id: r.accountId, user_id: r.userId, name: r.name, scopes: r.scopes || [], expires_at: iso(r.expiresAt), revoked_at: iso(r.revokedAt) }
      : null;
  }
  for (const rec of __mem.apiKeys.values()) {
    if (rec.id === id) {
      return { account_id: rec.account_id, user_id: rec.user_id || null, name: rec.name, scopes: rec.scopes || [], expires_at: rec.expires_at || null, revoked_at: rec.revoked_at || null };
    }
  }
  return null;
}

/**
 * Rotate an API key: mint a successor with the same owner/name/scopes/expiry
 * and retire the old one. `graceSeconds` > 0 keeps the old key valid for a
 * short overlap (zero-downtime redeploys, like AWS access-key rotation);
 * 0 revokes it immediately. Returns null when the key is missing or retired.
 */
export async function rotateApiKey(id: string, graceSeconds: number): Promise<{ id: string; value: string; prefix: string; oldKeyExpiresAt: string } | null> {
  const old = await findApiKeyById(id);
  if (!old || old.revoked_at) return null;
  if (old.expires_at && new Date(old.expires_at).getTime() < Date.now()) return null;
  const next = await createApiKeyRecord(old.account_id, old.user_id, old.name, old.scopes, old.expires_at ? new Date(old.expires_at) : null);
  const retireAt = new Date(Date.now() + Math.max(0, graceSeconds) * 1000);
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    if (graceSeconds > 0) {
      await db.update(apiKeys).set({ expiresAt: retireAt }).where(eq(apiKeys.id, id));
    } else {
      await db.update(apiKeys).set({ revokedAt: sql`now()` }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
    }
  } else {
    for (const rec of __mem.apiKeys.values()) {
      if (rec.id !== id) continue;
      if (graceSeconds > 0) rec.expires_at = retireAt.toISOString();
      else rec.revoked_at = new Date().toISOString();
    }
  }
  return { ...next, oldKeyExpiresAt: retireAt.toISOString() };
}

/** Safe key listing (id/prefix/metadata only — hashes and secret values NEVER leave the server). */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  user_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string | null;
}

export async function listApiKeys(accountId: string): Promise<ApiKeyInfo[]> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      userId: apiKeys.userId,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .orderBy(desc(apiKeys.createdAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes || [],
      user_id: r.userId ?? null,
      expires_at: iso(r.expiresAt),
      revoked_at: iso(r.revokedAt),
      last_used_at: iso(r.lastUsedAt),
      created_at: iso(r.createdAt),
    }));
  }
  return [...__mem.apiKeys.values()]
    .filter((rec) => rec.account_id === accountId)
    .slice(0, 500)
    .map((rec) => ({
      id: rec.id,
      name: rec.name,
      prefix: rec.key_prefix,
      scopes: rec.scopes || [],
      user_id: rec.user_id || null,
      expires_at: rec.expires_at || null,
      revoked_at: rec.revoked_at || null,
      last_used_at: rec.last_used_at || null,
      created_at: rec.created_at || null,
    }));
}

export interface VerifiedApiKey {
  id: string;
  account_id: string;
  user_id: string | null;
  scopes: string[];
}

/** last_used_at is written at most once per minute per key (hot-path friendly). */
const LAST_USED_THROTTLE_MS = 60_000;

export async function verifyApiKey(raw: string): Promise<VerifiedApiKey | null> {
  if (!raw || typeof raw !== 'string' || raw.length > 512) return null;
  // Thử peppered hash trước, legacy sau (rotation-safe cho key cũ).
  for (const hash of hashCandidates(raw)) {
    const hit = await verifyApiKeyByHash(hash);
    if (hit) return hit;
  }
  return null;
}

async function verifyApiKeyByHash(hash: string): Promise<VerifiedApiKey | null> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      id: apiKeys.id,
      accountId: apiKeys.accountId,
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
    }).from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null;
    if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > LAST_USED_THROTTLE_MS) {
      // Best-effort usage stamp; verification never fails because of it.
      db.update(apiKeys).set({ lastUsedAt: sql`now()` })
        .where(and(eq(apiKeys.id, row.id), or(isNull(apiKeys.lastUsedAt), sql`${apiKeys.lastUsedAt} < now() - interval '60 seconds'`)))
        .catch(() => undefined);
    }
    return { id: row.id, account_id: row.accountId, user_id: row.userId ?? null, scopes: row.scopes || [] };
  }
  const rec = __mem.apiKeys.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return null;
  rec.last_used_at = new Date().toISOString();
  return { id: rec.id, account_id: rec.account_id, user_id: rec.user_id || null, scopes: rec.scopes || [] };
}

