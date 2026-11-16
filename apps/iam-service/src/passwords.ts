// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * First-party password primitives (issue #22): scrypt hashing, password policy
 * and single-use token generation. No external dependency.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { hashSecret } from './db';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, n: number) => Promise<Buffer>;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Why a password is unacceptable (null = accepted). */
export function passwordPolicyError(password: unknown, email?: string): string | null {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  // Reject the obvious credential-stuffing favourites without pretending to be
  // a full password-strength oracle.
  if (/^(password|passw0rd|123456|qwerty|letmein)/i.test(password)) return 'password is too common';
  if (email && password.toLowerCase() === String(email).toLowerCase()) return 'password must not equal the email address';
  return null;
}

/** Hash a password with a per-user random salt: `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time password verification. Unknown/garbage formats fail closed. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    want = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length < 8 || want.length !== KEY_LEN) return false;
  const got = await scrypt(password, salt, KEY_LEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Opaque, single-use token (reset / verification / invite) + its at-rest hash. */
export function newOneTimeToken(prefix: 'reset' | 'verify' | 'invite'): { value: string; hash: string } {
  const value = `synapseone_${prefix}_` + randomBytes(32).toString('base64url');
  return { value, hash: hashSecret(value) };
}

export function inviteTokenExpiry(): Date {
  const raw = Number(process.env.IAM_INVITE_TOKEN_TTL_SECONDS ?? 7 * 86_400);
  const secs = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 300), 30 * 86_400) : 7 * 86_400;
  return new Date(Date.now() + secs * 1000);
}

export function resetTokenExpiry(): Date {
  const raw = Number(process.env.IAM_RESET_TOKEN_TTL_SECONDS ?? 3600);
  const secs = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 60), 86_400) : 3600;
  return new Date(Date.now() + secs * 1000);
}

export function verifyTokenExpiry(): Date {
  const raw = Number(process.env.IAM_VERIFY_TOKEN_TTL_SECONDS ?? 86_400);
  const secs = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 300), 30 * 86_400) : 86_400;
  return new Date(Date.now() + secs * 1000);
}
