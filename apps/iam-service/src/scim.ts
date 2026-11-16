// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SCIM 2.0 provisioning support (#48): scoped tokens, filter parsing,
 * Users/Groups projections and group-to-role mapping storage.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ensureTables, getDb, useDb, type User } from './db';
import * as schema from './schema';

export interface ScimToken {
  id: string;
  org_id: string;
  description: string;
  scopes: string[];
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface ScimGroup {
  id: string;
  org_id: string;
  account_id: string | null;
  display_name: string;
  external_id: string | null;
  members: string[];
  roles: string[];
  created_at: string;
  updated_at: string;
}

const memTokens = new Map<string, { record: ScimToken; hash: string }>();
const memGroups = new Map<string, ScimGroup>();

export function hashScimToken(raw: string): string {
  return createHash('sha256').update(String(raw)).digest('hex');
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export async function createScimToken(input: {
  orgId: string; description?: string; scopes?: string[]; createdBy?: string | null; ttlSeconds?: number | null;
}): Promise<{ token: string; record: ScimToken }> {
  const raw = `scim_${randomBytes(32).toString('base64url')}`;
  const hash = hashScimToken(raw);
  const scopes = Array.isArray(input.scopes) && input.scopes.length ? input.scopes.slice(0, 10) : ['scim:read', 'scim:write'];
  const expiresAt = input.ttlSeconds ? new Date(Date.now() + Math.min(Math.max(input.ttlSeconds, 60), 365 * 86400) * 1000) : null;
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.insert(schema.scimTokens).values({
      orgId: input.orgId, tokenHash: hash, description: input.description || '',
      scopes, createdBy: input.createdBy ?? null, expiresAt,
    }).returning();
    const r = rows[0] as any;
    return {
      token: raw,
      record: {
        id: String(r.id), org_id: String(r.orgId), description: String(r.description || ''),
        scopes: Array.isArray(r.scopes) ? r.scopes : scopes, created_by: r.createdBy ?? null,
        created_at: iso(r.createdAt)!, expires_at: iso(r.expiresAt), revoked_at: iso(r.revokedAt),
      },
    };
  }
  const record: ScimToken = {
    id: randomUUID(), org_id: input.orgId, description: input.description || '', scopes,
    created_by: input.createdBy ?? null, created_at: new Date().toISOString(),
    expires_at: expiresAt?.toISOString() || null, revoked_at: null,
  };
  memTokens.set(hash, { record, hash });
  return { token: raw, record };
}

export async function verifyScimToken(raw: string): Promise<{ orgId: string; scopes: string[]; id: string } | null> {
  if (!raw || !raw.startsWith('scim_')) return null;
  const hash = hashScimToken(raw);
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.select().from(schema.scimTokens).where(eq(schema.scimTokens.tokenHash, hash)).limit(1);
    const r: any = rows[0];
    if (!r || r.revokedAt) return null;
    if (r.expiresAt && new Date(r.expiresAt).getTime() < Date.now()) return null;
    return { orgId: String(r.orgId), scopes: Array.isArray(r.scopes) ? r.scopes : [], id: String(r.id) };
  }
  const rec = memTokens.get(hash);
  if (!rec || rec.record.revoked_at) return null;
  if (rec.record.expires_at && new Date(rec.record.expires_at).getTime() < Date.now()) return null;
  return { orgId: rec.record.org_id, scopes: rec.record.scopes, id: rec.record.id };
}

export async function listScimTokens(orgId: string): Promise<ScimToken[]> {
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.select().from(schema.scimTokens)
      .where(eq(schema.scimTokens.orgId, orgId)).orderBy(desc(schema.scimTokens.createdAt));
    return rows.map((r: any) => ({
      id: String(r.id), org_id: String(r.orgId), description: String(r.description || ''),
      scopes: Array.isArray(r.scopes) ? r.scopes : [], created_by: r.createdBy ?? null,
      created_at: iso(r.createdAt)!, expires_at: iso(r.expiresAt), revoked_at: iso(r.revokedAt),
    }));
  }
  return [...memTokens.values()].filter((t) => t.record.org_id === orgId).map((t) => t.record);
}

export async function revokeScimToken(orgId: string, id: string): Promise<boolean> {
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.update(schema.scimTokens).set({ revokedAt: sql`now()` })
      .where(and(eq(schema.scimTokens.id, id), eq(schema.scimTokens.orgId, orgId), sql`${schema.scimTokens.revokedAt} is null`))
      .returning({ id: schema.scimTokens.id });
    return rows.length > 0;
  }
  for (const [hash, entry] of memTokens) {
    if (entry.record.id === id && entry.record.org_id === orgId && !entry.record.revoked_at) {
      entry.record.revoked_at = new Date().toISOString();
      memTokens.set(hash, entry);
      return true;
    }
  }
  return false;
}

// ---------- groups ----------

function groupRow(r: any): ScimGroup {
  return {
    id: String(r.id), org_id: String(r.orgId), account_id: r.accountId ? String(r.accountId) : null,
    display_name: String(r.displayName || ''), external_id: r.externalId ? String(r.externalId) : null,
    members: Array.isArray(r.members) ? r.members.map(String) : [],
    roles: Array.isArray(r.roles) ? r.roles.map(String) : [],
    created_at: iso(r.createdAt) || new Date().toISOString(),
    updated_at: iso(r.updatedAt) || new Date().toISOString(),
  };
}

export async function listScimGroups(orgId: string): Promise<ScimGroup[]> {
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.select().from(schema.scimGroups).where(eq(schema.scimGroups.orgId, orgId));
    return rows.map(groupRow);
  }
  return [...memGroups.values()].filter((g) => g.org_id === orgId);
}

export async function getScimGroup(orgId: string, id: string): Promise<ScimGroup | null> {
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.select().from(schema.scimGroups)
      .where(and(eq(schema.scimGroups.orgId, orgId), eq(schema.scimGroups.id, id))).limit(1);
    return rows[0] ? groupRow(rows[0]) : null;
  }
  const group = memGroups.get(id);
  return group && group.org_id === orgId ? group : null;
}

export async function createScimGroup(orgId: string, input: {
  displayName: string; accountId?: string | null; externalId?: string | null; members?: string[]; roles?: string[];
}): Promise<ScimGroup> {
  const now = new Date().toISOString();
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.insert(schema.scimGroups).values({
      orgId, accountId: input.accountId ?? null, displayName: input.displayName,
      externalId: input.externalId ?? null, members: input.members || [], roles: input.roles || [],
    }).returning();
    return groupRow(rows[0]);
  }
  const group: ScimGroup = {
    id: randomUUID(), org_id: orgId, account_id: input.accountId ?? null,
    display_name: input.displayName, external_id: input.externalId ?? null,
    members: input.members || [], roles: input.roles || [], created_at: now, updated_at: now,
  };
  memGroups.set(group.id, group);
  return group;
}

export async function updateScimGroup(orgId: string, id: string, patch: {
  displayName?: string; externalId?: string | null; members?: string[]; roles?: string[]; accountId?: string | null;
}): Promise<ScimGroup | null> {
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.update(schema.scimGroups).set({
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
      ...(patch.members !== undefined ? { members: patch.members } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
      updatedAt: sql`now()`,
    }).where(and(eq(schema.scimGroups.orgId, orgId), eq(schema.scimGroups.id, id))).returning();
    return rows[0] ? groupRow(rows[0]) : null;
  }
  const group = memGroups.get(id);
  if (!group || group.org_id !== orgId) return null;
  const next: ScimGroup = {
    ...group,
    ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
    ...(patch.externalId !== undefined ? { external_id: patch.externalId } : {}),
    ...(patch.members !== undefined ? { members: patch.members } : {}),
    ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
    ...(patch.accountId !== undefined ? { account_id: patch.accountId } : {}),
    updated_at: new Date().toISOString(),
  };
  memGroups.set(id, next);
  return next;
}

export async function deleteScimGroup(orgId: string, id: string): Promise<boolean> {
  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const rows = await db.delete(schema.scimGroups)
      .where(and(eq(schema.scimGroups.orgId, orgId), eq(schema.scimGroups.id, id)))
      .returning({ id: schema.scimGroups.id });
    return rows.length > 0;
  }
  const group = memGroups.get(id);
  if (!group || group.org_id !== orgId) return false;
  return memGroups.delete(id);
}

// ---------- SCIM projections ----------

export function toScimUser(user: User, groups: ScimGroup[] = []): any {
  const memberOf = groups.filter((g) => g.members.includes(user.id)).map((g) => ({ value: g.id, display: g.display_name }));
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    externalId: user.external_sub || undefined,
    userName: user.email,
    name: { formatted: user.display_name || user.email },
    displayName: user.display_name || user.email,
    emails: [{ value: user.email, primary: true, type: 'work' }],
    active: user.active !== false,
    ...(memberOf.length ? { groups: memberOf } : {}),
    meta: {
      resourceType: 'User',
      created: (user as any).created_at || undefined,
      location: `/scim/v2/Users/${user.id}`,
    },
  };
}

export function toScimGroup(group: ScimGroup): any {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: group.id,
    externalId: group.external_id || undefined,
    displayName: group.display_name,
    members: group.members.map((id) => ({ value: id })),
    roles: group.roles,
    meta: {
      resourceType: 'Group',
      created: group.created_at,
      lastModified: group.updated_at,
      location: `/scim/v2/Groups/${group.id}`,
    },
  };
}

export interface ScimFilter {
  field: string;
  op: string;
  value: string | boolean;
}

/** Minimal, safe SCIM filter parser: `field eq value` with optional quotes.
 *  Anything else is rejected rather than interpreted. */
export function parseScimFilter(raw: unknown): ScimFilter | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const m = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s+(eq|ne|co|sw)\s+(?:"([^"]*)"|'([^']*)'|(true|false|[^\s]+))\s*$/i.exec(raw);
  if (!m) return null;
  const valueRaw = m[3] ?? m[4] ?? m[5] ?? '';
  const value = /^(true|false)$/i.test(valueRaw) ? valueRaw.toLowerCase() === 'true' : valueRaw;
  return { field: m[1].toLowerCase(), op: m[2].toLowerCase(), value };
}

export function matchesScimFilter(item: any, filter: ScimFilter | null): boolean {
  if (!filter) return true;
  const aliases: Record<string, string> = {
    username: 'userName', externalid: 'externalId', displayname: 'displayName',
    display_name: 'displayName', 'name.formatted': 'displayName', id: 'id', active: 'active',
  };
  const field = aliases[filter.field] || filter.field;
  const actual = field.split('.').reduce((obj: any, key) => (obj && typeof obj === 'object' ? obj[key] : undefined), item);
  const expected = filter.value;
  switch (filter.op) {
    case 'eq': return String(actual).toLowerCase() === String(expected).toLowerCase();
    case 'ne': return String(actual).toLowerCase() !== String(expected).toLowerCase();
    case 'co': return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'sw': return String(actual).toLowerCase().startsWith(String(expected).toLowerCase());
    default: return false;
  }
}

export function __clearScimMem(): void {
  memTokens.clear();
  memGroups.clear();
}
