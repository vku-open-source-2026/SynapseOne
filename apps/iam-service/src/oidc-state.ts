// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Server-side, browser-bound, single-use OIDC authorization state.
 */
import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { ensureTables, getDb, useDb } from './db';
import * as schema from './schema';

export const OIDC_BROWSER_COOKIE = 'synapseone_oidc';
export const OIDC_BROWSER_COOKIE_PATH = '/v1/auth/oidc';
export const OIDC_BROWSER_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export interface OidcLoginState {
  id: string;
  orgSlug: string;
  nonce: string;
  verifierEnc: string;
  browserHash: string;
  expiresAt: Date;
}

const memoryStates = new Map<string, OidcLoginState>();

export function newOidcBrowserToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOidcBrowserToken(token: string): string {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

/** Parse only the exact cookie name. The value is an opaque random token, not
 *  JSON or a signed state payload, so URL-decoding is deliberately unnecessary. */
export function readOidcBrowserCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0 || part.slice(0, equals).trim() !== OIDC_BROWSER_COOKIE) continue;
    const value = part.slice(equals + 1).trim();
    return /^[A-Za-z0-9_-]{43,128}$/.test(value) ? value : null;
  }
  return null;
}

export async function storeOidcLoginState(input: OidcLoginState): Promise<void> {
  const now = new Date();
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    // Opportunistic cleanup keeps abandoned/expired logins from accumulating.
    await db.delete(schema.oidcLoginStates).where(lt(schema.oidcLoginStates.expiresAt, now));
    await db.insert(schema.oidcLoginStates).values({
      id: input.id,
      orgSlug: input.orgSlug,
      nonce: input.nonce,
      verifierEnc: input.verifierEnc,
      browserHash: input.browserHash,
      expiresAt: input.expiresAt,
    });
    return;
  }
  pruneMemoryOidcStates(now);
  memoryStates.set(input.id, input);
}

/** Atomically consume a state only when its initiating-browser binding and TTL
 *  still match. Postgres DELETE ... RETURNING serializes concurrent callbacks;
 *  the memory fallback deletes synchronously before its first await. */
export async function consumeOidcLoginState(id: string, browserToken: string): Promise<OidcLoginState | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const browserHash = hashOidcBrowserToken(browserToken);
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.delete(schema.oidcLoginStates).where(and(
      eq(schema.oidcLoginStates.id, id),
      eq(schema.oidcLoginStates.browserHash, browserHash),
      gt(schema.oidcLoginStates.expiresAt, new Date()),
    )).returning();
    const row = rows[0];
    return row ? {
      id: String(row.id), orgSlug: String(row.orgSlug), nonce: String(row.nonce),
      verifierEnc: String(row.verifierEnc), browserHash: String(row.browserHash), expiresAt: new Date(row.expiresAt),
    } : null;
  }
  const now = new Date();
  pruneMemoryOidcStates(now);
  const state = memoryStates.get(id);
  if (!state || state.browserHash !== browserHash || state.expiresAt.getTime() <= now.getTime()) return null;
  memoryStates.delete(id);
  return state;
}

function pruneMemoryOidcStates(now: Date): void {
  for (const [id, state] of memoryStates) {
    if (state.expiresAt.getTime() <= now.getTime()) memoryStates.delete(id);
  }
}

export function __clearOidcStateMemory(): void {
  memoryStates.clear();
}
