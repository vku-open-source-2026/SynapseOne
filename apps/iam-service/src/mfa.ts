// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Multi-factor authentication (TOTP, RFC 6238) and login lockout.
 *
 * - TOTP secrets are encrypted at rest with AES-256-GCM. The key comes from
 *   IAM_MFA_ENCRYPTION_KEY (32 bytes, hex or base64) or is derived from
 *   IAM_JWT_SECRET with HKDF when that variable is unset.
 * - Recovery codes are stored as SHA-256 hashes and are single-use.
 * - A TOTP time step is accepted at most once (replay protection).
 * - The login challenge is a short-lived JWT signed with a key and issuer
 *   that verifyAccess() never accepts, so it cannot be used as an access token.
 * - Failed password / second-factor attempts lock the user temporarily.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { ensureTables, getDb } from './db';
import { getJwtSecret } from './tokens';
import * as schema from './schema';

// ---------------------------------------------------------------- TOTP core

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // accept one step of clock drift either side

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) with HMAC-SHA1, as every authenticator app expects. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

export function totp(secret: Buffer, nowMs = Date.now()): string {
  return hotp(secret, totpStep(nowMs));
}

/**
 * Return the matched time step, or null. Steps at or below `lastStep` are
 * rejected so an observed code cannot be replayed.
 */
export function verifyTotp(secret: Buffer, code: string, lastStep: number | null, nowMs = Date.now()): number | null {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = totpStep(nowMs);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = now + d;
    if (lastStep != null && step <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = process.env.IAM_MFA_ISSUER || 'SynapseOne'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ---------------------------------------------------- secret encryption

function encryptionKey(): Buffer {
  const raw = (process.env.IAM_MFA_ENCRYPTION_KEY || '').trim();
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
    console.warn('[iam][security] IAM_MFA_ENCRYPTION_KEY must be 32 bytes (hex or base64); deriving from IAM_JWT_SECRET');
  }
  return Buffer.from(hkdfSync('sha256', getJwtSecret(), 'synapseone-iam', 'mfa-secret-encryption', 32));
}

export function sealSecret(secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function openSecret(sealed: string): Buffer {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('unsupported MFA secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
}

// ---------------------------------------------------------- recovery codes

const RECOVERY_COUNT = 10;

function hashRecovery(code: string): string {
  return createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
}

/** Ten codes like `k7m2-9xq4`: shown once, stored only as hashes. */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) s += alphabet[randomInt(alphabet.length)];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return { codes, hashes: codes.map(hashRecovery) };
}

// ---------------------------------------------------------- persistence

export interface MfaRecord {
  user_id: string;
  secret_enc: string;
  enabled: boolean;
  recovery_hashes: string[];
  last_step: number | null;
  enabled_at: string | null;
}

const mem = {
  mfa: new Map<string, MfaRecord>(),
  lock: new Map<string, { failures: number; locked_until: number | null }>(),
};

function rowToRecord(r: typeof schema.userMfa.$inferSelect): MfaRecord {
  return {
    user_id: r.userId,
    secret_enc: r.secretEnc,
    enabled: r.enabled,
    recovery_hashes: r.recoveryHashes || [],
    last_step: r.lastStep ?? null,
    enabled_at: r.enabledAt ? new Date(r.enabledAt).toISOString() : null,
  };
}

export async function getMfa(userId: string): Promise<MfaRecord | null> {
  const db = getDb();
  if (db) {
    await ensureTables();
    const rows = await db.select().from(schema.userMfa).where(eq(schema.userMfa.userId, userId)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }
  const r = mem.mfa.get(userId);
  return r ? { ...r, recovery_hashes: [...r.recovery_hashes] } : null;
}

/** Start (or restart) enrolment. Never overwrites an enabled factor. */
export async function beginTotpEnrolment(userId: string): Promise<{ secret: string } | null> {
  const existing = await getMfa(userId);
  if (existing?.enabled) return null;
  const raw = randomBytes(20);
  const sealed = sealSecret(raw);
  const db = getDb();
  if (db) {
    await db.insert(schema.userMfa)
      .values({ userId, secretEnc: sealed, enabled: false, recoveryHashes: [], lastStep: null })
      .onConflictDoUpdate({ target: schema.userMfa.userId, set: { secretEnc: sealed, enabled: false, recoveryHashes: [], lastStep: null, enabledAt: null } });
  } else {
    mem.mfa.set(userId, { user_id: userId, secret_enc: sealed, enabled: false, recovery_hashes: [], last_step: null, enabled_at: null });
  }
  return { secret: base32Encode(raw) };
}

async function saveMfa(userId: string, patch: Partial<Pick<MfaRecord, 'enabled' | 'recovery_hashes' | 'last_step' | 'enabled_at'>>): Promise<void> {
  const db = getDb();
  if (db) {
    const set: Record<string, unknown> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.recovery_hashes !== undefined) set.recoveryHashes = patch.recovery_hashes;
    if (patch.last_step !== undefined) set.lastStep = patch.last_step;
    if (patch.enabled_at !== undefined) set.enabledAt = patch.enabled_at ? new Date(patch.enabled_at) : null;
    await db.update(schema.userMfa).set(set).where(eq(schema.userMfa.userId, userId));
    return;
  }
  const r = mem.mfa.get(userId);
  if (r) Object.assign(r, patch);
}

/** Atomically claim a TOTP step. Concurrent requests reusing the same code
 *  race on this conditional update; exactly one wins. */
async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const db = getDb();
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.userMfa)
      .set({ lastStep: step })
      .where(and(
        eq(schema.userMfa.userId, userId),
        or(isNull(schema.userMfa.lastStep), lt(schema.userMfa.lastStep, step)),
      ))
      .returning({ userId: schema.userMfa.userId });
    return rows.length > 0;
  }
  const r = mem.mfa.get(userId);
  if (!r) return false;
  if (r.last_step != null && r.last_step >= step) return false;
  r.last_step = step;
  return true;
}

/** Atomically consume one recovery-code hash. Returns remaining count, or
 *  null when the code is missing/already used. */
async function consumeRecoveryCode(userId: string, codeHash: string): Promise<number | null> {
  const db = getDb();
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const rows = await tx.select({ hashes: schema.userMfa.recoveryHashes })
        .from(schema.userMfa)
        .where(eq(schema.userMfa.userId, userId))
        .for('update');
      const hashes = rows[0]?.hashes || [];
      const idx = hashes.indexOf(codeHash);
      if (idx < 0) return null;
      const left = hashes.filter((_, i) => i !== idx);
      await tx.update(schema.userMfa).set({ recoveryHashes: left }).where(eq(schema.userMfa.userId, userId));
      return left.length;
    });
  }
  const r = mem.mfa.get(userId);
  if (!r) return null;
  const idx = r.recovery_hashes.indexOf(codeHash);
  if (idx < 0) return null;
  r.recovery_hashes.splice(idx, 1);
  return r.recovery_hashes.length;
}

/**
 * Check a TOTP code or a recovery code against the user's factor.
 * `requireEnabled=false` is only for confirming a pending enrolment.
 */
export async function checkSecondFactor(
  userId: string,
  input: { code?: string | null; recoveryCode?: string | null },
  requireEnabled = true,
): Promise<{ ok: true; method: 'totp' | 'recovery'; remainingRecovery: number } | { ok: false }> {
  const rec = await getMfa(userId);
  if (!rec || (requireEnabled && !rec.enabled)) return { ok: false };
  if (input.code) {
    let secret: Buffer;
    try {
      secret = openSecret(rec.secret_enc);
    } catch {
      return { ok: false };
    }
    const step = verifyTotp(secret, input.code, rec.last_step);
    if (step == null) return { ok: false };
    if (!(await claimTotpStep(userId, step))) return { ok: false };
    return { ok: true, method: 'totp', remainingRecovery: rec.recovery_hashes.length };
  }
  if (input.recoveryCode && rec.enabled) {
    const h = hashRecovery(input.recoveryCode);
    const remaining = await consumeRecoveryCode(userId, h);
    if (remaining == null) return { ok: false };
    return { ok: true, method: 'recovery', remainingRecovery: remaining };
  }
  return { ok: false };
}

export async function enableTotp(userId: string): Promise<string[]> {
  const { codes, hashes } = newRecoveryCodes();
  await saveMfa(userId, { enabled: true, recovery_hashes: hashes, enabled_at: new Date().toISOString() });
  return codes;
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const { codes, hashes } = newRecoveryCodes();
  await saveMfa(userId, { recovery_hashes: hashes });
  return codes;
}

export async function removeMfa(userId: string): Promise<boolean> {
  const db = getDb();
  if (db) {
    const rows = await db.delete(schema.userMfa).where(eq(schema.userMfa.userId, userId)).returning({ id: schema.userMfa.userId });
    return rows.length > 0;
  }
  return mem.mfa.delete(userId);
}

export async function mfaEnabled(userId: string): Promise<boolean> {
  return !!(await getMfa(userId))?.enabled;
}

// ---------------------------------------------------------- login challenge

const CHALLENGE_TTL = 300;
const CHALLENGE_ISSUER = 'synapseone-iam-mfa';

function challengeKey(): string {
  return createHmac('sha256', getJwtSecret()).update('mfa-challenge').digest('hex');
}

export function signMfaChallenge(userId: string, method: string): { mfaToken: string; expiresIn: number } {
  const mfaToken = jwt.sign({ sub: userId, amr: [method], typ: 'mfa_challenge' }, challengeKey(), {
    issuer: CHALLENGE_ISSUER,
    expiresIn: CHALLENGE_TTL,
    algorithm: 'HS256',
  });
  return { mfaToken, expiresIn: CHALLENGE_TTL };
}

export function verifyMfaChallenge(token: string): { sub: string; amr: string[] } | null {
  try {
    const c = jwt.verify(token, challengeKey(), { issuer: CHALLENGE_ISSUER, algorithms: ['HS256'] }) as any;
    if (c?.typ !== 'mfa_challenge' || typeof c.sub !== 'string') return null;
    return { sub: c.sub, amr: Array.isArray(c.amr) ? c.amr : [] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- login lockout

function lockoutSettings(): { max: number; seconds: number } {
  const max = Math.min(Math.max(Math.floor(Number(process.env.IAM_LOGIN_MAX_FAILURES ?? 5)) || 5, 1), 100);
  const seconds = Math.min(Math.max(Math.floor(Number(process.env.IAM_LOGIN_LOCKOUT_SECONDS ?? 900)) || 900, 1), 86_400);
  return { max, seconds };
}

/** Seconds until the user may try again, or 0 when not locked. */
export async function lockRemaining(userId: string): Promise<number> {
  const db = getDb();
  let until: number | null = null;
  if (db) {
    await ensureTables();
    const rows = await db.select({ lockedUntil: schema.users.lockedUntil }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    until = rows[0]?.lockedUntil ? new Date(rows[0].lockedUntil).getTime() : null;
  } else {
    until = mem.lock.get(userId)?.locked_until ?? null;
  }
  if (!until) return 0;
  const left = Math.ceil((until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

/** Record a failed attempt; returns the lock duration in seconds if this failure locked the user. */
export async function recordLoginFailure(userId: string): Promise<number> {
  const { max, seconds } = lockoutSettings();
  const db = getDb();
  if (db) {
    const rows = await db.update(schema.users)
      .set({ failedLoginCount: sql`${schema.users.failedLoginCount} + 1` })
      .where(eq(schema.users.id, userId))
      .returning({ failures: schema.users.failedLoginCount });
    const failures = rows[0]?.failures ?? 0;
    if (failures >= max) {
      await db.update(schema.users)
        .set({ failedLoginCount: 0, lockedUntil: new Date(Date.now() + seconds * 1000) })
        .where(eq(schema.users.id, userId));
      return seconds;
    }
    return 0;
  }
  const cur = mem.lock.get(userId) || { failures: 0, locked_until: null };
  cur.failures += 1;
  if (cur.failures >= max) {
    cur.failures = 0;
    cur.locked_until = Date.now() + seconds * 1000;
    mem.lock.set(userId, cur);
    return seconds;
  }
  mem.lock.set(userId, cur);
  return 0;
}

export async function clearLoginFailures(userId: string): Promise<void> {
  const db = getDb();
  if (db) {
    await db.update(schema.users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, userId));
    return;
  }
  mem.lock.delete(userId);
}
