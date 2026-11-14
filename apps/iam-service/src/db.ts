// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM persistence layer — Drizzle ORM on Postgres with in-memory fallback
 * (dev/test). Tables/indexes live in ./schema.ts and are applied by versioned
 * Drizzle migrations.
 */
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema';

export interface Organization { id: string; slug: string; display_name: string; kind?: string; status?: string; suspended_at?: string; suspended_by?: string; suspend_reason?: string; created_at?: string }
export interface Account { id: string; org_id: string; slug: string; display_name: string }
export interface User { id: string; org_id: string; email: string; display_name?: string; external_sub?: string; password_hash?: string; email_verified?: boolean; active?: boolean; is_org_admin?: boolean; auth_version?: number }
export interface Role { id: string; account_id: string; slug: string; description?: string }
export interface PolicyDoc { Version?: string; Statement: Array<{ Effect: 'Allow'|'Deny'; Action: string|string[]; Resource: string|string[]; Condition?: any }> }
export interface Policy { id: string; account_id: string; slug: string; description?: string; document: PolicyDoc }
export interface PlatformAdmin {
  user_id: string;
  role: 'owner' | 'operator' | 'auditor';
  granted_by?: string | null;
  granted_at?: string;
  revoked_at?: string | null;
  reason?: string;
}

const DATABASE_URL = process.env.DATABASE_URL || '';
// Migrations and advisory-lock work need a stable Postgres session; when
// DATABASE_URL points at PgBouncer in transaction mode they must bypass it.
const DIRECT_DATABASE_URL = process.env.DATABASE_DIRECT_URL || DATABASE_URL;

let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[iam][db] pool error', e.message));
}

let directPool: Pool | null = null;
/** Small bypass pool for migrations and session-scoped advisory locks. */
export function getDirectPool(): Pool | null {
  if (!DIRECT_DATABASE_URL) return null;
  if (!directPool) {
    directPool = new Pool({ connectionString: DIRECT_DATABASE_URL, max: 2 });
    directPool.on('error', (e) => console.error('[iam][db] direct pool error', e.message));
  }
  return directPool;
}
const baseDb: NodePgDatabase<typeof schema> | null = pool ? drizzle(pool, { schema }) : null;
/** Request-scoped transaction context. A Proxy keeps every existing helper on
 *  the same connection inside withTransaction(), including audit inserts, so a
 *  failed mandatory audit rolls the privileged mutation back. */
const txStore = new AsyncLocalStorage<{ tx: any }>();
const db: NodePgDatabase<typeof schema> | null = baseDb
  ? new Proxy(baseDb, {
      get(target, prop, receiver) {
        const tx = txStore.getStore()?.tx;
        const src = tx || target;
        const value = Reflect.get(src, prop, src);
        return typeof value === 'function' ? value.bind(src) : value;
      },
    }) as NodePgDatabase<typeof schema>
  : null;

export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (!baseDb) return fn();
  return baseDb.transaction(async (tx) => txStore.run({ tx }, fn));
}

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!db || ensured) return;
  ensured = true;
  try {
    const client = await getDirectPool()!.connect();
    try {
      // Hold the advisory lock on the same dedicated session that runs the
      // migration (pool connections are not guaranteed to be reused).
      const migrationDb = drizzle(client, { schema });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapseone_iam_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_iam',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapseone_iam_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[iam][db] migrations failed:', e?.message || e);
  }
}

// ---- in-memory fallback ----
const mem = {
  orgs: new Map<string, Organization>(),
  orgsBySlug: new Map<string, Organization>(),
  accounts: new Map<string, Account>(),
  users: new Map<string, User>(),
  roles: new Map<string, Role>(),
  policies: new Map<string, Policy>(),
  rolePolicies: new Map<string, Set<string>>(), // roleId -> policyIds
  userRoles: new Map<string, Set<string>>(), // userId -> roleIds
  apiKeys: new Map<string, any>(), // hash -> record
  refresh: new Map<string, any>(),
  serviceAccounts: new Map<string, any>(),
  passwordResets: new Map<string, any>(), // hash -> { user_id, purpose, expires_at, used_at }
  serviceAccountRoles: new Map<string, Set<string>>(), // serviceAccountId -> roleIds
  platformAdmins: new Map<string, PlatformAdmin>(), // userId -> admin record
  platformStepUps: new Map<string, { user_id: string; session_jti: string; action: string; expires_at: string; used_at: string | null }>(),
  usage: [] as any[], // request/feature usage events (schedule from gateway)
};

function seedMem() {
  if (mem.orgsBySlug.has('acme')) return;
  const org: Organization = { id: randomUUID(), slug: 'acme', display_name: 'ACME Demo Organization' };
  mem.orgs.set(org.id, org); mem.orgsBySlug.set(org.slug, org);
  const acc: Account = { id: randomUUID(), org_id: org.id, slug: 'prod', display_name: 'Production' };
  mem.accounts.set(acc.id, acc);
  const adminRole: Role = { id: randomUUID(), account_id: acc.id, slug: 'admin', description: 'Full access' };
  mem.roles.set(adminRole.id, adminRole);
  const adminPolicy: Policy = {
    id: randomUUID(), account_id: acc.id, slug: 'admin-full',
    description: 'Allow all',
    document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] },
  };
  mem.policies.set(adminPolicy.id, adminPolicy);
  mem.rolePolicies.set(adminRole.id, new Set([adminPolicy.id]));
}
seedMem();

export function useDb(): boolean { return !!db; }
export function getPool(): Pool | null { return pool; }
/** Internal Drizzle handle used by the token module; callers must check useDb(). */
export function getDb(): NodePgDatabase<typeof schema> | null { return db; }

function iso(v: Date | string | null | undefined): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function orgRow(r: { id: string; slug: string; displayName: string; kind?: string | null; status?: string | null; suspendedAt?: Date | null; suspendedBy?: string | null; suspendReason?: string | null; createdAt?: Date | null }): Organization {
  return {
    id: r.id, slug: r.slug, display_name: r.displayName, kind: r.kind ?? 'tenant',
    status: r.status ?? 'active',
    ...(r.suspendedAt ? { suspended_at: iso(r.suspendedAt) } : {}),
    ...(r.suspendedBy ? { suspended_by: r.suspendedBy } : {}),
    ...(r.suspendReason ? { suspend_reason: r.suspendReason } : {}),
    ...(r.createdAt ? { created_at: iso(r.createdAt) } : {}),
  };
}
function accountRow(r: { id: string; orgId: string; slug: string; displayName: string }): Account {
  return { id: r.id, org_id: r.orgId, slug: r.slug, display_name: r.displayName };
}
function userRow(r: { id: string; orgId: string; email: string; displayName: string | null; externalSub: string | null; passwordHash?: string | null; emailVerified?: boolean | null; active?: boolean | null; isOrgAdmin?: boolean | null; authVersion?: number | null }): User {
  return {
    id: r.id,
    org_id: r.orgId,
    email: r.email,
    display_name: r.displayName ?? undefined,
    external_sub: r.externalSub ?? undefined,
    password_hash: r.passwordHash ?? undefined,
    email_verified: !!r.emailVerified,
    active: r.active !== false,
    is_org_admin: !!r.isOrgAdmin,
    auth_version: Number(r.authVersion) || 0,
  };
}
/** Strip credential material before a user row is serialized to a client. */
export function publicUser(user: User): Omit<User, 'password_hash'> {
  const { password_hash: _ignored, ...rest } = user;
  // Normalize defaults so the in-memory backend and Postgres return the same
  // shape. A missing `active` means active; a missing `is_org_admin` means not.
  return { ...rest, active: user.active !== false, is_org_admin: !!user.is_org_admin };
}
function roleRow(r: { id: string; accountId: string; slug: string; description: string | null }): Role {
  return { id: r.id, account_id: r.accountId, slug: r.slug, description: r.description ?? '' };
}
function policyRow(r: { id: string; accountId: string; slug: string; description: string | null; document: Record<string, any> }): Policy {
  return { id: r.id, account_id: r.accountId, slug: r.slug, description: r.description ?? '', document: r.document as PolicyDoc };
}

export function hashSecret(s: string): string {
  const pepper = process.env.IAM_API_KEY_PEPPER || '';
  if (pepper) return createHmac('sha256', pepper).update(s).digest('hex');
  if (!hashSecret.warned) {
    hashSecret.warned = true;
    console.warn('[iam][security] IAM_API_KEY_PEPPER not set — API keys hashed with plain SHA-256 (dev default). Set a pepper in production.');
  }
  return createHash('sha256').update(s).digest('hex');
}
hashSecret.warned = false as boolean;

/** Legacy plain-SHA-256 hash (for verifying keys created before a pepper was set). */
export function hashSecretLegacy(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Candidate hashes to try on verify: peppered first, then legacy (rotation-safe). */
export function hashCandidates(s: string): string[] {
  const pepper = process.env.IAM_API_KEY_PEPPER || '';
  if (pepper) return [hashSecret(s), hashSecretLegacy(s)];
  return [hashSecretLegacy(s)];
}

/** Constant-time string compare (hash-then-compare to hide length via timing). */
export function secretsEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- high-level CRUD that works on both pg + memory ----------

export async function createOrganization(slug: string, display_name: string, kind = 'tenant'): Promise<Organization> {
  const reserved = (process.env.PLATFORM_ORG_SLUG || 'synapseone-platform').trim().toLowerCase();
  if (kind !== 'platform' && slug.toLowerCase() === reserved) {
    throw Object.assign(new Error('reserved platform organization slug'), {
      status: 403,
      code: 'reserved_org_slug',
    });
  }
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.organizations)
      .values({ slug, displayName: display_name, kind })
      .returning({ id: schema.organizations.id, slug: schema.organizations.slug, displayName: schema.organizations.displayName, kind: schema.organizations.kind });
    return orgRow(rows[0]);
  }
  if (mem.orgsBySlug.has(slug)) throw Object.assign(new Error('org exists'), { status: 409 });
  const o: Organization = { id: randomUUID(), slug, display_name, kind, status: 'active' };
  mem.orgs.set(o.id, o); mem.orgsBySlug.set(slug, o);
  return o;
}

export async function createOrganizationWithAdmin(
  slug: string,
  display_name: string,
  adminEmail: string,
  adminDisplayName?: string,
): Promise<{ organization: Organization; admin: User }> {
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const orgRows = await tx.insert(schema.organizations)
        .values({ slug, displayName: display_name, kind: 'tenant' })
        .returning({
          id: schema.organizations.id,
          slug: schema.organizations.slug,
          displayName: schema.organizations.displayName,
          kind: schema.organizations.kind,
          createdAt: schema.organizations.createdAt,
        });
      const org = orgRow(orgRows[0]);
      const userRows = await tx.insert(schema.users)
        .values({
          orgId: org.id,
          email: adminEmail,
          displayName: adminDisplayName || adminEmail,
          isOrgAdmin: true,
        })
        .returning({
          id: schema.users.id,
          orgId: schema.users.orgId,
          email: schema.users.email,
          displayName: schema.users.displayName,
          externalSub: schema.users.externalSub,
          active: schema.users.active,
          isOrgAdmin: schema.users.isOrgAdmin,
        });
      return { organization: org, admin: userRow(userRows[0]) };
    });
  }
  const organization = await createOrganization(slug, display_name);
  const admin = await upsertUser(organization.id, adminEmail, adminDisplayName);
  const updated = (await setOrgAdmin(admin.id, true)) || admin;
  return { organization, admin: updated };
}

export async function listOrganizations(): Promise<Organization[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
      kind: schema.organizations.kind,
      status: schema.organizations.status,
      suspendedAt: schema.organizations.suspendedAt,
      suspendedBy: schema.organizations.suspendedBy,
      suspendReason: schema.organizations.suspendReason,
      createdAt: schema.organizations.createdAt,
    }).from(schema.organizations).orderBy(asc(schema.organizations.createdAt));
    return rows.map(orgRow);
  }
  return [...mem.orgs.values()];
}

export async function getOrgBySlug(slug: string): Promise<Organization | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
      kind: schema.organizations.kind,
      status: schema.organizations.status,
      suspendedAt: schema.organizations.suspendedAt,
      suspendedBy: schema.organizations.suspendedBy,
      suspendReason: schema.organizations.suspendReason,
    }).from(schema.organizations).where(eq(schema.organizations.slug, slug)).limit(1);
    return rows[0] ? orgRow(rows[0]) : null;
  }
  return mem.orgsBySlug.get(slug) || null;
}

export async function getOrgById(id: string): Promise<Organization | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
      kind: schema.organizations.kind,
      status: schema.organizations.status,
      suspendedAt: schema.organizations.suspendedAt,
      suspendedBy: schema.organizations.suspendedBy,
      suspendReason: schema.organizations.suspendReason,
    }).from(schema.organizations).where(eq(schema.organizations.id, id)).limit(1);
    return rows[0] ? orgRow(rows[0]) : null;
  }
  return mem.orgs.get(id) || null;
}

export async function createAccount(orgId: string, slug: string, display_name: string): Promise<Account> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.accounts)
      .values({ orgId, slug, displayName: display_name })
      .returning({ id: schema.accounts.id, orgId: schema.accounts.orgId, slug: schema.accounts.slug, displayName: schema.accounts.displayName });
    return accountRow(rows[0]);
  }
  const dup = [...mem.accounts.values()].find((a) => a.org_id === orgId && a.slug === slug);
  if (dup) throw Object.assign(new Error('account exists'), { status: 409 });
  const a: Account = { id: randomUUID(), org_id: orgId, slug, display_name };
  mem.accounts.set(a.id, a);
  return a;
}

export async function listAccounts(orgId: string): Promise<Account[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.accounts.id,
      orgId: schema.accounts.orgId,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    }).from(schema.accounts).where(eq(schema.accounts.orgId, orgId)).orderBy(asc(schema.accounts.slug));
    return rows.map(accountRow);
  }
  return [...mem.accounts.values()].filter((a) => a.org_id === orgId);
}

export async function upsertUser(orgId: string, email: string, displayName?: string, externalSub?: string): Promise<User> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.users)
      .values({ orgId, email, displayName: displayName || email, externalSub: externalSub || null })
      .onConflictDoUpdate({
        target: [schema.users.orgId, schema.users.email],
        set: { displayName: sql`excluded.display_name` },
      })
      .returning({
        id: schema.users.id,
        orgId: schema.users.orgId,
        email: schema.users.email,
        displayName: schema.users.displayName,
        externalSub: schema.users.externalSub,
        active: schema.users.active,
        isOrgAdmin: schema.users.isOrgAdmin,
      });
    return userRow(rows[0]);
  }
  const existing = [...mem.users.values()].find((u) => u.org_id === orgId && u.email === email);
  if (existing) { existing.display_name = displayName || existing.display_name; return existing; }
  const u: User = { id: randomUUID(), org_id: orgId, email, display_name: displayName, external_sub: externalSub, is_org_admin: false };
  mem.users.set(u.id, u);
  return u;
}

export async function createRole(accountId: string, slug: string, description = ''): Promise<Role> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.roles)
      .values({ accountId, slug, description })
      .returning({
        id: schema.roles.id,
        accountId: schema.roles.accountId,
        slug: schema.roles.slug,
        description: schema.roles.description,
      });
    return roleRow(rows[0]);
  }
  const dup = [...mem.roles.values()].find((r) => r.account_id === accountId && r.slug === slug);
  if (dup) throw Object.assign(new Error('role exists'), { status: 409 });
  const r: Role = { id: randomUUID(), account_id: accountId, slug, description };
  mem.roles.set(r.id, r);
  return r;
}

export async function createPolicy(accountId: string, slug: string, description: string, document: PolicyDoc): Promise<Policy> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.policies)
      .values({ accountId, slug, description, document })
      .returning({
        id: schema.policies.id,
        accountId: schema.policies.accountId,
        slug: schema.policies.slug,
        description: schema.policies.description,
        document: schema.policies.document,
      });
    return policyRow(rows[0]);
  }
  const dup = [...mem.policies.values()].find((p) => p.account_id === accountId && p.slug === slug);
  if (dup) throw Object.assign(new Error('policy exists'), { status: 409 });
  const p: Policy = { id: randomUUID(), account_id: accountId, slug, description, document };
  mem.policies.set(p.id, p);
  return p;
}

export async function attachPolicy(roleId: string, policyId: string): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.rolePolicies).values({ roleId, policyId }).onConflictDoNothing();
    return;
  }
  if (!mem.rolePolicies.has(roleId)) mem.rolePolicies.set(roleId, new Set());
  mem.rolePolicies.get(roleId)!.add(policyId);
}

export async function assignRole(userId: string, roleId: string): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.userRoles).values({ userId, roleId }).onConflictDoNothing();
    return;
  }
  if (!mem.userRoles.has(userId)) mem.userRoles.set(userId, new Set());
  mem.userRoles.get(userId)!.add(roleId);
}

/** Idempotent removals (true when a row existed). */
export async function detachPolicy(roleId: string, policyId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.rolePolicies).where(and(
      eq(schema.rolePolicies.roleId, roleId),
      eq(schema.rolePolicies.policyId, policyId),
    )).returning({ policyId: schema.rolePolicies.policyId });
    return rows.length > 0;
  }
  const set = mem.rolePolicies.get(roleId);
  if (!set) return false;
  return set.delete(policyId);
}

export async function unassignRole(userId: string, roleId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.userRoles).where(and(
      eq(schema.userRoles.userId, userId),
      eq(schema.userRoles.roleId, roleId),
    )).returning({ roleId: schema.userRoles.roleId });
    return rows.length > 0;
  }
  const set = mem.userRoles.get(userId);
  if (!set) return false;
  return set.delete(roleId);
}

export async function policiesForUser(userId: string): Promise<PolicyDoc[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ document: schema.policies.document })
      .from(schema.policies)
      .innerJoin(schema.rolePolicies, eq(schema.rolePolicies.policyId, schema.policies.id))
      .innerJoin(schema.userRoles, eq(schema.userRoles.roleId, schema.rolePolicies.roleId))
      .where(eq(schema.userRoles.userId, userId));
    return rows.map((x) => x.document as PolicyDoc);
  }
  const roleIds = mem.userRoles.get(userId) || new Set();
  const docs: PolicyDoc[] = [];
  for (const rid of roleIds) {
    const pids = mem.rolePolicies.get(rid) || new Set();
    for (const pid of pids) {
      const p = mem.policies.get(pid);
      if (p) docs.push(p.document);
    }
  }
  return docs;
}

export async function listRoles(accountId: string): Promise<Role[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles).where(eq(schema.roles.accountId, accountId)).orderBy(asc(schema.roles.slug));
    return rows.map(roleRow);
  }
  return [...mem.roles.values()].filter((r) => r.account_id === accountId);
}

export async function listPolicies(accountId: string): Promise<Policy[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.policies.id,
      accountId: schema.policies.accountId,
      slug: schema.policies.slug,
      description: schema.policies.description,
      document: schema.policies.document,
    }).from(schema.policies).where(eq(schema.policies.accountId, accountId)).orderBy(asc(schema.policies.slug));
    return rows.map(policyRow);
  }
  return [...mem.policies.values()].filter((p) => p.account_id === accountId);
}

export async function listUsers(orgId: string): Promise<User[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
      active: schema.users.active,
      isOrgAdmin: schema.users.isOrgAdmin,
      authVersion: schema.users.authVersion,
    }).from(schema.users).where(eq(schema.users.orgId, orgId)).orderBy(asc(schema.users.email));
    return rows.map(userRow).map(publicUser);
  }
  return [...mem.users.values()].filter((u) => u.org_id === orgId).map(publicUser);
}

export async function getUserById(id: string): Promise<User | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
      passwordHash: schema.users.passwordHash,
      emailVerified: schema.users.emailVerified,
      active: schema.users.active,
      isOrgAdmin: schema.users.isOrgAdmin,
      authVersion: schema.users.authVersion,
    }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return rows[0] ? userRow(rows[0]) : null;
  }
  return mem.users.get(id) || null;
}

/** Membership check by (org, email) — used by the OIDC callback before letting
 *  an IdP identity join an EXISTING org (no auto-join across tenants, #9). */
export async function findUserByOrgEmail(orgId: string, email: string): Promise<User | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
      passwordHash: schema.users.passwordHash,
      emailVerified: schema.users.emailVerified,
      active: schema.users.active,
      isOrgAdmin: schema.users.isOrgAdmin,
      authVersion: schema.users.authVersion,
    }).from(schema.users).where(and(
      eq(schema.users.orgId, orgId),
      eq(schema.users.email, email),
    )).limit(1);
    return rows[0] ? userRow(rows[0]) : null;
  }
  return [...mem.users.values()].find((u) => u.org_id === orgId && u.email === email) || null;
}

/** Existence checks for FK-safe attach/assign (404 thay vì 500 khi id lạ). */
export async function roleExists(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.id, id)).limit(1);
    return rows.length > 0;
  }
  return mem.roles.has(id);
}

export async function policyExists(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ id: schema.policies.id }).from(schema.policies).where(eq(schema.policies.id, id)).limit(1);
    return rows.length > 0;
  }
  return mem.policies.has(id);
}

/** Policies attached to a role / roles assigned to a user (for management UI). */
export async function policiesForRole(roleId: string): Promise<Policy[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.policies.id,
      accountId: schema.policies.accountId,
      slug: schema.policies.slug,
      description: schema.policies.description,
      document: schema.policies.document,
    }).from(schema.policies)
      .innerJoin(schema.rolePolicies, eq(schema.rolePolicies.policyId, schema.policies.id))
      .where(eq(schema.rolePolicies.roleId, roleId))
      .orderBy(asc(schema.policies.slug));
    return rows.map(policyRow);
  }
  const out: Policy[] = [];
  for (const pid of mem.rolePolicies.get(roleId) || []) {
    const p = mem.policies.get(pid);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function rolesForUser(userId: string): Promise<Role[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles)
      .innerJoin(schema.userRoles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(eq(schema.userRoles.userId, userId))
      .orderBy(asc(schema.roles.slug));
    return rows.map(roleRow);
  }
  const out: Role[] = [];
  for (const rid of mem.userRoles.get(userId) || []) {
    const role = mem.roles.get(rid);
    if (role) out.push(role);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Full-row lookups for cross-tenant scoping (attach/assign/mint). */
export async function getRoleById(id: string): Promise<Role | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles).where(eq(schema.roles.id, id)).limit(1);
    return rows[0] ? roleRow(rows[0]) : null;
  }
  return mem.roles.get(id) || null;
}

export async function getPolicyById(id: string): Promise<Policy | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.policies.id,
      accountId: schema.policies.accountId,
      slug: schema.policies.slug,
      description: schema.policies.description,
      document: schema.policies.document,
    }).from(schema.policies).where(eq(schema.policies.id, id)).limit(1);
    return rows[0] ? policyRow(rows[0]) : null;
  }
  return mem.policies.get(id) || null;
}

export async function getAccountById(id: string): Promise<Account | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.accounts.id,
      orgId: schema.accounts.orgId,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    }).from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1);
    return rows[0] ? accountRow(rows[0]) : null;
  }
  return mem.accounts.get(id) || null;
}

/** Account ids where the user holds at least one role (tenant membership). */
export async function accountsForUser(userId: string): Promise<string[]> {
  if (db) {
    await ensureTables();
    const rows = await db.selectDistinct({ accountId: schema.roles.accountId })
      .from(schema.roles)
      .innerJoin(schema.userRoles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(eq(schema.userRoles.userId, userId));
    return rows.map((x) => x.accountId);
  }
  const out = new Set<string>();
  for (const rid of mem.userRoles.get(userId) || []) {
    const role = mem.roles.get(rid);
    if (role) out.add(role.account_id);
  }
  return [...out];
}

export async function deleteRole(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.roles).where(eq(schema.roles.id, id)).returning({ id: schema.roles.id });
    return rows.length > 0;
  }
  return mem.roles.delete(id);
}

export async function deletePolicy(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.policies).where(eq(schema.policies.id, id)).returning({ id: schema.policies.id });
    return rows.length > 0;
  }
  return mem.policies.delete(id);
}

export interface AuditEntry {
  id?: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource: string;
  decision: boolean;
  org_id?: string | null;
  context?: any;
}

function auditOrgId(e: AuditEntry): string | null {
  const raw = e.org_id ?? e.context?.org ?? e.context?.callerOrg ?? null;
  return typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

export async function logAudit(e: AuditEntry): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.auditLog).values({
      actorType: e.actor_type,
      actorId: e.actor_id,
      action: e.action,
      resource: e.resource || '',
      decision: !!e.decision,
      orgId: auditOrgId(e),
      context: e.context || {},
    });
    return;
  }
  if (!(__mem as any).audit) (__mem as any).audit = [];
  ((__mem as any).audit as any[]).push({ id: randomUUID(), created_at: new Date().toISOString(), org_id: auditOrgId(e), ...e });
  if (((__mem as any).audit as any[]).length > 1000) ((__mem as any).audit as any[]).splice(0, 100);
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  actor?: string;
  allowed?: boolean;
  orgId?: string;
  action?: string;
  resource?: string;
  from?: Date;
  to?: Date;
}

/** Audit query with filters + pagination (#32). Tenant scoping stays mandatory:
 *  callers pass their resolved orgId and can never read another tenant's rows. */
export async function queryAudit(q: AuditQuery = {}): Promise<any[]> {
  const lim = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const off = Math.min(Math.max(Number(q.offset) || 0, 0), 100_000);
  const dec = q.allowed === undefined ? undefined : !!q.allowed;
  if (db) {
    await ensureTables();
    const conds = [];
    if (q.actor) conds.push(eq(schema.auditLog.actorId, q.actor));
    if (dec !== undefined) conds.push(eq(schema.auditLog.decision, dec));
    if (q.action) conds.push(eq(schema.auditLog.action, q.action));
    if (q.resource) conds.push(eq(schema.auditLog.resource, q.resource));
    if (q.from) conds.push(sql`${schema.auditLog.createdAt} >= ${q.from}`);
    if (q.to) conds.push(sql`${schema.auditLog.createdAt} <= ${q.to}`);
    if (q.orgId) {
      const fallback = sql`(${schema.auditLog.context}->>'org' = ${q.orgId} OR ${schema.auditLog.context}->>'callerOrg' = ${q.orgId})`;
      conds.push(or(eq(schema.auditLog.orgId, q.orgId), and(isNull(schema.auditLog.orgId), fallback))!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select({
      id: schema.auditLog.id,
      createdAt: schema.auditLog.createdAt,
      actorType: schema.auditLog.actorType,
      actorId: schema.auditLog.actorId,
      action: schema.auditLog.action,
      resource: schema.auditLog.resource,
      decision: schema.auditLog.decision,
      orgId: schema.auditLog.orgId,
      context: schema.auditLog.context,
    }).from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.createdAt)).limit(lim).offset(off);
    return rows.map((r) => ({
      id: r.id,
      created_at: iso(r.createdAt),
      actor_type: r.actorType,
      actor_id: r.actorId,
      action: r.action,
      resource: r.resource,
      decision: r.decision,
      org_id: r.orgId,
      context: r.context,
    }));
  }
  const all: any[] = (((__mem as any).audit as any[]) || []).slice().reverse();
  const fromMs = q.from ? q.from.getTime() : -Infinity;
  const toMs = q.to ? q.to.getTime() : Infinity;
  const filtered = all.filter((a) => {
    const at = Date.parse(String(a.created_at || '')) || 0;
    return (!q.actor || a.actor_id === q.actor)
      && (dec === undefined || !!a.decision === dec)
      && (!q.action || a.action === q.action)
      && (!q.resource || a.resource === q.resource)
      && (!q.orgId || a.org_id === q.orgId || a.context?.org === q.orgId || a.context?.callerOrg === q.orgId)
      && at >= fromMs
      && at <= toMs;
  });
  return filtered.slice(off, off + lim);
}

export async function listAudit(limit = 50, actorId?: string, allowed?: boolean, orgId?: string): Promise<any[]> {
  return queryAudit({ limit, actor: actorId, allowed, orgId });
}

/** Small aggregate used by the platform overview. */
export async function platformAuditStats(from: Date, to: Date): Promise<{
  denied: number; platformActions: number; failedLogins: number;
}> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      denied: sql<number>`count(*) filter (where ${schema.auditLog.decision} = false)::int`,
      platformActions: sql<number>`count(*) filter (where ${schema.auditLog.actorType} = 'platform-admin')::int`,
      failedLogins: sql<number>`count(*) filter (where ${schema.auditLog.action} = 'iam:auth:login' and ${schema.auditLog.decision} = false)::int`,
    }).from(schema.auditLog).where(and(
      sql`${schema.auditLog.createdAt} >= ${from}`,
      sql`${schema.auditLog.createdAt} <= ${to}`,
    ));
    return {
      denied: Number(rows[0]?.denied) || 0,
      platformActions: Number(rows[0]?.platformActions) || 0,
      failedLogins: Number(rows[0]?.failedLogins) || 0,
    };
  }
  const all: any[] = ((__mem as any).audit as any[]) || [];
  const rows = all.filter((a) => {
    const t = Date.parse(String(a.created_at || '')) || 0;
    return t >= from.getTime() && t <= to.getTime();
  });
  return {
    denied: rows.filter((a) => !a.decision).length,
    platformActions: rows.filter((a) => a.actor_type === 'platform-admin').length,
    failedLogins: rows.filter((a) => a.action === 'iam:auth:login' && !a.decision).length,
  };
}

/** Retention purge: delete audit rows older than `olderThanDays` (batched).
 *  Non-positive input is a no-op (retention disabled by default). */
export async function purgeAudit(olderThanDays: number, batch = 1000): Promise<number> {
  if (!(olderThanDays > 0) || !Number.isFinite(olderThanDays)) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  const lim = Math.min(Math.max(Math.floor(batch) || 1000, 1), 10000);
  if (db) {
    await ensureTables();
    // Postgres has no DELETE..LIMIT: batch via id sub-select.
    const ids = await db.select({ id: schema.auditLog.id }).from(schema.auditLog)
      .where(lt(schema.auditLog.createdAt, cutoff))
      .limit(lim);
    if (ids.length === 0) return 0;
    const rows = await db.delete(schema.auditLog)
      .where(inArray(schema.auditLog.id, ids.map((x) => x.id)))
      .returning({ id: schema.auditLog.id });
    return rows.length;
  }
  const arr: any[] = ((__mem as any).audit as any[]) || [];
  const kept = arr.filter((a) => String(a.created_at || '') >= cutoff.toISOString()).slice(-10000);
  const removed = arr.length - kept.length;
  (__mem as any).audit = kept;
  return removed;
}

export interface ServiceAccount { id: string; account_id: string; slug: string; description?: string; revoked_at?: string | null }

export async function createServiceAccount(accountId: string, slug: string, description = ''): Promise<ServiceAccount> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.serviceAccounts)
      .values({ accountId, slug, description })
      .returning({
        id: schema.serviceAccounts.id,
        accountId: schema.serviceAccounts.accountId,
        slug: schema.serviceAccounts.slug,
        description: schema.serviceAccounts.description,
        revokedAt: schema.serviceAccounts.revokedAt,
      });
    return { id: rows[0].id, account_id: rows[0].accountId, slug: rows[0].slug, description: rows[0].description ?? '', revoked_at: rows[0].revokedAt ? iso(rows[0].revokedAt) : null };
  }
  const dup = [...__mem.serviceAccounts.values()].find((s: any) => s.account_id === accountId && s.slug === slug);
  if (dup) throw Object.assign(new Error('service account exists'), { status: 409 });
  const sa: ServiceAccount = { id: randomUUID(), account_id: accountId, slug, description };
  __mem.serviceAccounts.set(sa.id, sa);
  return sa;
}

export async function listServiceAccounts(accountId: string): Promise<ServiceAccount[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.serviceAccounts.id,
      accountId: schema.serviceAccounts.accountId,
      slug: schema.serviceAccounts.slug,
      description: schema.serviceAccounts.description,
      revokedAt: schema.serviceAccounts.revokedAt,
    }).from(schema.serviceAccounts).where(eq(schema.serviceAccounts.accountId, accountId)).orderBy(asc(schema.serviceAccounts.slug));
    return rows.map((r) => ({ id: r.id, account_id: r.accountId, slug: r.slug, description: r.description ?? '', revoked_at: r.revokedAt ? iso(r.revokedAt) : null }));
  }
  return [...__mem.serviceAccounts.values()]
    .filter((s: any) => s.account_id === accountId)
    .map((s: any) => ({ ...s, revoked_at: s.revoked_at || null }));
}

export async function getServiceAccount(id: string): Promise<ServiceAccount | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.serviceAccounts.id,
      accountId: schema.serviceAccounts.accountId,
      slug: schema.serviceAccounts.slug,
      description: schema.serviceAccounts.description,
      revokedAt: schema.serviceAccounts.revokedAt,
    }).from(schema.serviceAccounts).where(eq(schema.serviceAccounts.id, id)).limit(1);
    return rows[0]
      ? { id: rows[0].id, account_id: rows[0].accountId, slug: rows[0].slug, description: rows[0].description ?? '', revoked_at: rows[0].revokedAt ? iso(rows[0].revokedAt) : null }
      : null;
  }
  const sa: any = __mem.serviceAccounts.get(id);
  return sa ? { ...sa, revoked_at: sa.revoked_at || null } : null;
}

/** Set/replace a user's password hash (never returns the hash to callers). */
export async function setUserPassword(userId: string, hash: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.users)
      .set({ passwordHash: hash, passwordUpdatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id });
    return rows.length > 0;
  }
  const u = mem.users.get(userId);
  if (!u) return false;
  u.password_hash = hash;
  return true;
}

export async function updateUserProfile(userId: string, patch: { displayName?: string; externalSub?: string | null }): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.users).set({
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.externalSub !== undefined ? { externalSub: patch.externalSub } : {}),
    }).where(eq(schema.users.id, userId)).returning({ id: schema.users.id });
    return rows.length > 0;
  }
  const user = mem.users.get(userId);
  if (!user) return false;
  if (patch.displayName !== undefined) user.display_name = patch.displayName;
  if (patch.externalSub !== undefined) user.external_sub = patch.externalSub || undefined;
  return true;
}

/** Bump the per-user credential epoch. Every access JWT carries the epoch it
 *  was issued with; a mismatch is rejected by IAM and the gateway. */
export async function bumpAuthVersion(userId: string): Promise<number> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.users)
      .set({ authVersion: sql`${schema.users.authVersion} + 1` })
      .where(eq(schema.users.id, userId))
      .returning({ version: schema.users.authVersion });
    return Number(rows[0]?.version) || 0;
  }
  const user = mem.users.get(userId);
  if (!user) return 0;
  user.auth_version = (Number(user.auth_version) || 0) + 1;
  return user.auth_version;
}

export async function setUserActive(userId: string, active: boolean): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.users).set({ active }).where(eq(schema.users.id, userId)).returning({ id: schema.users.id });
    return rows.length > 0;
  }
  const user = mem.users.get(userId);
  if (!user) return false;
  user.active = active;
  return true;
}

export async function markEmailVerified(userId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id });
    return rows.length > 0;
  }
  const u = mem.users.get(userId);
  if (!u) return false;
  u.email_verified = true;
  return true;
}

/** Store a hashed single-use token (password reset or email verification). */
export async function storeOneTimeToken(
  userId: string,
  tokenHash: string,
  purpose: 'reset' | 'verify' | 'invite',
  expiresAt: Date,
): Promise<void> {
  if (db) {
    await ensureTables();
    // Invalidate any outstanding token of the same purpose for this user.
    await db.update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(schema.passwordResetTokens.userId, userId),
        eq(schema.passwordResetTokens.purpose, purpose),
        sql`${schema.passwordResetTokens.usedAt} is null`,
      ));
    await db.insert(schema.passwordResetTokens).values({ userId, tokenHash, purpose, expiresAt });
    return;
  }
  for (const rec of mem.passwordResets.values()) {
    if (rec.user_id === userId && rec.purpose === purpose && !rec.used_at) rec.used_at = new Date().toISOString();
  }
  mem.passwordResets.set(tokenHash, { user_id: userId, purpose, expires_at: expiresAt.toISOString(), used_at: null });
}

/** Atomically consume a single-use token. Returns the owning user id. */
export async function consumeOneTimeToken(
  tokenHash: string,
  purpose: 'reset' | 'verify' | 'invite',
): Promise<string | null> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(schema.passwordResetTokens.tokenHash, tokenHash),
        eq(schema.passwordResetTokens.purpose, purpose),
        sql`${schema.passwordResetTokens.usedAt} is null`,
        sql`${schema.passwordResetTokens.expiresAt} > now()`,
      ))
      .returning({ userId: schema.passwordResetTokens.userId });
    return rows[0]?.userId ?? null;
  }
  const rec = mem.passwordResets.get(tokenHash);
  if (!rec || rec.used_at || rec.purpose !== purpose) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;
  rec.used_at = new Date().toISOString();
  return rec.user_id;
}

// ---------- Org administrators ----------

/** Grant/revoke org-admin (AWS root-like, scoped to the user's own org). */
export async function setOrgAdmin(userId: string, isAdmin: boolean): Promise<User | null> {
  if (db) {
    await ensureTables();
    await db.update(schema.users).set({ isOrgAdmin: isAdmin }).where(eq(schema.users.id, userId));
    return getUserById(userId);
  }
  const u = mem.users.get(userId);
  if (!u) return null;
  u.is_org_admin = isAdmin;
  return u;
}

/** Does the org already have at least one administrator? (bootstrap rule) */
export async function orgHasAdmin(orgId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.isOrgAdmin, true))).limit(1);
    return rows.length > 0;
  }
  return [...mem.users.values()].some((u) => u.org_id === orgId && u.is_org_admin);
}

// ---------- Service-account roles ----------

export async function assignRoleToServiceAccount(serviceAccountId: string, roleId: string): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.serviceAccountRoles).values({ serviceAccountId, roleId }).onConflictDoNothing();
    return;
  }
  if (!mem.serviceAccountRoles.has(serviceAccountId)) mem.serviceAccountRoles.set(serviceAccountId, new Set());
  mem.serviceAccountRoles.get(serviceAccountId)!.add(roleId);
}

export async function unassignRoleFromServiceAccount(serviceAccountId: string, roleId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.serviceAccountRoles)
      .where(and(eq(schema.serviceAccountRoles.serviceAccountId, serviceAccountId), eq(schema.serviceAccountRoles.roleId, roleId)))
      .returning({ roleId: schema.serviceAccountRoles.roleId });
    return rows.length > 0;
  }
  return mem.serviceAccountRoles.get(serviceAccountId)?.delete(roleId) || false;
}

export async function rolesForServiceAccount(serviceAccountId: string): Promise<Role[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles)
      .innerJoin(schema.serviceAccountRoles, eq(schema.serviceAccountRoles.roleId, schema.roles.id))
      .where(eq(schema.serviceAccountRoles.serviceAccountId, serviceAccountId))
      .orderBy(asc(schema.roles.slug));
    return rows.map(roleRow);
  }
  const out: Role[] = [];
  for (const rid of mem.serviceAccountRoles.get(serviceAccountId) || []) {
    const role = mem.roles.get(rid);
    if (role) out.push(role);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function policiesForServiceAccount(serviceAccountId: string): Promise<PolicyDoc[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ document: schema.policies.document })
      .from(schema.policies)
      .innerJoin(schema.rolePolicies, eq(schema.rolePolicies.policyId, schema.policies.id))
      .innerJoin(schema.serviceAccountRoles, eq(schema.serviceAccountRoles.roleId, schema.rolePolicies.roleId))
      .where(eq(schema.serviceAccountRoles.serviceAccountId, serviceAccountId));
    return rows.map((x) => x.document as PolicyDoc);
  }
  const docs: PolicyDoc[] = [];
  for (const rid of mem.serviceAccountRoles.get(serviceAccountId) || []) {
    for (const pid of mem.rolePolicies.get(rid) || []) {
      const p = mem.policies.get(pid);
      if (p) docs.push(p.document);
    }
  }
  return docs;
}

// ---------- platform administrators / cross-tenant read models ----------

function platformAdminRow(r: any): PlatformAdmin {
  return {
    user_id: String(r.userId ?? r.user_id),
    role: (r.role || 'auditor') as PlatformAdmin['role'],
    granted_by: r.grantedBy ?? r.granted_by ?? null,
    granted_at: iso(r.grantedAt ?? r.granted_at),
    revoked_at: iso(r.revokedAt ?? r.revoked_at) ?? null,
    reason: r.reason || '',
  };
}

export async function getPlatformAdmin(userId: string): Promise<PlatformAdmin | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(schema.platformAdmins)
      .where(eq(schema.platformAdmins.userId, userId)).limit(1);
    return rows[0] ? platformAdminRow(rows[0]) : null;
  }
  return mem.platformAdmins.get(userId) || null;
}

export async function listPlatformAdmins(): Promise<PlatformAdmin[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(schema.platformAdmins).orderBy(asc(schema.platformAdmins.grantedAt));
    return rows.map(platformAdminRow);
  }
  return [...mem.platformAdmins.values()].sort((a, b) => String(a.granted_at || '').localeCompare(String(b.granted_at || '')));
}

export async function grantPlatformAdmin(input: {
  userId: string; role: PlatformAdmin['role']; grantedBy?: string | null; reason?: string;
}): Promise<PlatformAdmin> {
  const role = ['owner', 'operator', 'auditor'].includes(input.role) ? input.role : 'auditor';
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.platformAdmins).values({
      userId: input.userId,
      role,
      grantedBy: input.grantedBy ?? null,
      reason: (input.reason || '').slice(0, 500),
    }).onConflictDoUpdate({
      target: schema.platformAdmins.userId,
      set: {
        role,
        grantedBy: input.grantedBy ?? null,
        grantedAt: sql`now()`,
        revokedAt: null,
        reason: (input.reason || '').slice(0, 500),
      },
    }).returning();
    return platformAdminRow(rows[0]);
  }
  const rec: PlatformAdmin = {
    user_id: input.userId,
    role,
    granted_by: input.grantedBy ?? null,
    granted_at: new Date().toISOString(),
    revoked_at: null,
    reason: (input.reason || '').slice(0, 500),
  };
  mem.platformAdmins.set(input.userId, rec);
  return rec;
}

export async function revokePlatformAdmin(userId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.platformAdmins)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(schema.platformAdmins.userId, userId), isNull(schema.platformAdmins.revokedAt)))
      .returning({ userId: schema.platformAdmins.userId });
    return rows.length > 0;
  }
  const rec = mem.platformAdmins.get(userId);
  if (!rec || rec.revoked_at) return false;
  rec.revoked_at = new Date().toISOString();
  return true;
}

/** Count owners that can actually sign in (active user rows). An owner row for
 *  an unclaimed/inactive account must not satisfy last-owner protection. */
export async function countActivePlatformOwners(): Promise<number> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.platformAdmins)
      .innerJoin(schema.users, eq(schema.users.id, schema.platformAdmins.userId))
      .where(and(
        eq(schema.platformAdmins.role, 'owner'),
        isNull(schema.platformAdmins.revokedAt),
        eq(schema.users.active, true),
      ));
    return Number(rows[0]?.n) || 0;
  }
  return [...mem.platformAdmins.values()].filter((r) => {
    if (r.role !== 'owner' || r.revoked_at) return false;
    return mem.users.get(r.user_id)?.active !== false;
  }).length;
}

export async function registerPlatformStepUp(input: {
  jti: string; userId: string; sessionJti: string; action: string; expiresAt: Date;
}): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.platformStepUps).values({
      jti: input.jti,
      userId: input.userId,
      sessionJti: input.sessionJti,
      action: input.action,
      expiresAt: input.expiresAt,
    });
    // Best-effort cleanup; never blocks issuance of a fresh proof.
    await db.delete(schema.platformStepUps).where(lt(schema.platformStepUps.expiresAt, new Date())).catch(() => undefined);
    return;
  }
  mem.platformStepUps.set(input.jti, {
    user_id: input.userId,
    session_jti: input.sessionJti,
    action: input.action,
    expires_at: input.expiresAt.toISOString(),
    used_at: null,
  });
}

/** Atomically consume a step-up proof. False means missing, wrong session,
 *  wrong action, expired, or already used. */
export async function consumePlatformStepUp(input: {
  jti: string; userId: string; sessionJti: string; action: string;
}): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.platformStepUps)
      .set({ usedAt: new Date() })
      .where(and(
        eq(schema.platformStepUps.jti, input.jti),
        eq(schema.platformStepUps.userId, input.userId),
        eq(schema.platformStepUps.sessionJti, input.sessionJti),
        eq(schema.platformStepUps.action, input.action),
        isNull(schema.platformStepUps.usedAt),
        sql`${schema.platformStepUps.expiresAt} > now()`,
      ))
      .returning({ jti: schema.platformStepUps.jti });
    return rows.length > 0;
  }
  const rec = mem.platformStepUps.get(input.jti);
  if (!rec || rec.used_at) return false;
  if (rec.user_id !== input.userId || rec.session_jti !== input.sessionJti || rec.action !== input.action) return false;
  if (new Date(rec.expires_at).getTime() <= Date.now()) return false;
  rec.used_at = new Date().toISOString();
  return true;
}

export interface PlatformOrgCounts {
  accounts: number;
  users: number;
  activeUsers: number;
  orgAdmins: number;
}

export interface PlatformOrgListItem extends Organization {
  counts: PlatformOrgCounts;
}

export async function listPlatformOrganizations(opts: {
  q?: string; limit?: number; offset?: number;
} = {}): Promise<{ items: PlatformOrgListItem[]; total: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
  const offset = Math.min(Math.max(Math.floor(Number(opts.offset) || 0), 0), 100_000);
  const q = String(opts.q || '').trim().slice(0, 200);
  if (db) {
    await ensureTables();
    const where = and(
      eq(schema.organizations.kind, 'tenant'),
      q ? or(ilike(schema.organizations.slug, `%${q}%`), ilike(schema.organizations.displayName, `%${q}%`)) : undefined,
    );
    const totalRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.organizations).where(where);
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
      kind: schema.organizations.kind,
      status: schema.organizations.status,
      suspendedAt: schema.organizations.suspendedAt,
      suspendedBy: schema.organizations.suspendedBy,
      suspendReason: schema.organizations.suspendReason,
      createdAt: schema.organizations.createdAt,
    }).from(schema.organizations).where(where)
      .orderBy(desc(schema.organizations.createdAt)).limit(limit).offset(offset);
    const ids = rows.map((r) => r.id);
    const counts = new Map<string, PlatformOrgCounts>();
    for (const id of ids) counts.set(id, { accounts: 0, users: 0, activeUsers: 0, orgAdmins: 0 });
    if (ids.length) {
      const accRows = await db.select({
        orgId: schema.accounts.orgId, n: sql<number>`count(*)::int`,
      }).from(schema.accounts).where(inArray(schema.accounts.orgId, ids)).groupBy(schema.accounts.orgId);
      for (const r of accRows) {
        const c = counts.get(r.orgId);
        if (c) c.accounts = Number(r.n) || 0;
      }
      const userRows = await db.select({
        orgId: schema.users.orgId,
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${schema.users.active})::int`,
        admins: sql<number>`count(*) filter (where ${schema.users.isOrgAdmin})::int`,
      }).from(schema.users).where(inArray(schema.users.orgId, ids)).groupBy(schema.users.orgId);
      for (const r of userRows) {
        const c = counts.get(r.orgId);
        if (c) {
          c.users = Number(r.total) || 0;
          c.activeUsers = Number(r.active) || 0;
          c.orgAdmins = Number(r.admins) || 0;
        }
      }
    }
    return {
      items: rows.map((r) => ({ ...orgRow(r), counts: counts.get(r.id)! })),
      total: Number(totalRows[0]?.n) || 0,
    };
  }
  const all = [...mem.orgs.values()]
    .filter((o) => (o.kind || 'tenant') === 'tenant')
    .filter((o) => !q || o.slug.includes(q) || o.display_name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const page = all.slice(offset, offset + limit);
  return {
    items: page.map((o) => {
      const users = [...mem.users.values()].filter((u) => u.org_id === o.id);
      return {
        ...o,
        counts: {
          accounts: [...mem.accounts.values()].filter((a) => a.org_id === o.id).length,
          users: users.length,
          activeUsers: users.filter((u) => u.active !== false).length,
          orgAdmins: users.filter((u) => u.is_org_admin).length,
        },
      };
    }),
    total: all.length,
  };
}

export async function getPlatformOrganization(orgId: string): Promise<{
  organization: Organization; accounts: Account[]; counts: PlatformOrgCounts; admins: User[];
} | null> {
  const org = await getOrgById(orgId);
  if (!org || (org.kind || 'tenant') !== 'tenant') return null;
  const accounts = await listAccounts(orgId);
  const users = await listUsers(orgId);
  return {
    organization: org,
    accounts,
    admins: users.filter((u) => u.is_org_admin),
    counts: {
      accounts: accounts.length,
      users: users.length,
      activeUsers: users.filter((u) => u.active !== false).length,
      orgAdmins: users.filter((u) => u.is_org_admin).length,
    },
  };
}


/** Reversible organization lifecycle. Returns the updated row or null. */
export async function setOrganizationStatus(
  orgId: string,
  status: 'active' | 'suspended',
  actorId: string,
  reason = '',
): Promise<Organization | null> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.organizations).set({
      status,
      suspendedAt: status === 'suspended' ? new Date() : null,
      suspendedBy: status === 'suspended' ? actorId : null,
      suspendReason: status === 'suspended' ? reason.slice(0, 500) : null,
    }).where(and(eq(schema.organizations.id, orgId), eq(schema.organizations.kind, 'tenant'))).returning({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
      kind: schema.organizations.kind,
      status: schema.organizations.status,
      suspendedAt: schema.organizations.suspendedAt,
      suspendedBy: schema.organizations.suspendedBy,
      suspendReason: schema.organizations.suspendReason,
      createdAt: schema.organizations.createdAt,
    });
    return rows[0] ? orgRow(rows[0]) : null;
  }
  const org = mem.orgs.get(orgId);
  if (!org || (org.kind || 'tenant') !== 'tenant') return null;
  org.status = status;
  org.suspended_at = status === 'suspended' ? new Date().toISOString() : undefined;
  org.suspended_by = status === 'suspended' ? actorId : undefined;
  org.suspend_reason = status === 'suspended' ? reason.slice(0, 500) : undefined;
  return org;
}

/** Identity metadata for context discovery. Load the full user separately to authenticate. */
export async function listUserRowsByEmail(email: string): Promise<Array<User & { org_slug: string; org_name: string; org_kind: string; org_status: string }>> {
  const normalized = email.trim().toLowerCase();
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
      active: schema.users.active,
      isOrgAdmin: schema.users.isOrgAdmin,
      authVersion: schema.users.authVersion,
      orgSlug: schema.organizations.slug,
      orgName: schema.organizations.displayName,
      orgKind: schema.organizations.kind,
      orgStatus: schema.organizations.status,
    }).from(schema.users)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
      .where(sql`lower(${schema.users.email}) = ${normalized}`)
      .orderBy(asc(schema.organizations.slug));
    return rows.map((r) => ({
      ...userRow(r),
      org_slug: r.orgSlug,
      org_name: r.orgName,
      org_kind: r.orgKind,
      org_status: r.orgStatus,
    }));
  }
  const out: any[] = [];
  for (const u of mem.users.values()) {
    if (u.email.toLowerCase() !== normalized) continue;
    const org = mem.orgs.get(u.org_id);
    if (!org) continue;
    out.push({ ...publicUser(u), org_slug: org.slug, org_name: org.display_name, org_kind: org.kind || 'tenant', org_status: org.status || 'active' });
  }
  return out.sort((a, b) => a.org_slug.localeCompare(b.org_slug));
}

/** Platform control-plane view of all administrative resources in one org. */
export async function getPlatformOrganizationResources(orgId: string): Promise<any | null> {
  const org = await getOrgById(orgId);
  if (!org || (org.kind || 'tenant') !== 'tenant') return null;
  const accounts = await listAccounts(orgId);
  const users = await listUsers(orgId);
  const accountIds = accounts.map((a) => a.id);
  const roles: any[] = [];
  const policies: any[] = [];
  const keys: any[] = [];
  const serviceAccounts: any[] = [];
  if (db) {
    await ensureTables();
    if (accountIds.length) {
      const roleRows = await db.select().from(schema.roles).where(inArray(schema.roles.accountId, accountIds)).orderBy(asc(schema.roles.slug));
      roles.push(...roleRows.map((r: any) => ({ id: r.id, account_id: r.accountId, slug: r.slug, description: r.description || '' })));
      const policyRows = await db.select().from(schema.policies).where(inArray(schema.policies.accountId, accountIds)).orderBy(asc(schema.policies.slug));
      policies.push(...policyRows.map((r: any) => ({ id: r.id, account_id: r.accountId, slug: r.slug, description: r.description || '', document: r.document })));
      const keyRows = await db.select({
        id: schema.apiKeys.id, accountId: schema.apiKeys.accountId, name: schema.apiKeys.name,
        prefix: schema.apiKeys.keyPrefix, scopes: schema.apiKeys.scopes, userId: schema.apiKeys.userId,
        expiresAt: schema.apiKeys.expiresAt, revokedAt: schema.apiKeys.revokedAt, lastUsedAt: schema.apiKeys.lastUsedAt,
      }).from(schema.apiKeys).where(inArray(schema.apiKeys.accountId, accountIds)).orderBy(desc(schema.apiKeys.createdAt));
      keys.push(...keyRows.map((r: any) => ({
        id: r.id, account_id: r.accountId, name: r.name, prefix: r.prefix, scopes: r.scopes || [],
        user_id: r.userId, expires_at: iso(r.expiresAt), revoked_at: iso(r.revokedAt), last_used_at: iso(r.lastUsedAt),
      })));
      const saRows = await db.select().from(schema.serviceAccounts).where(inArray(schema.serviceAccounts.accountId, accountIds)).orderBy(asc(schema.serviceAccounts.slug));
      serviceAccounts.push(...saRows.map((r: any) => ({ id: r.id, account_id: r.accountId, slug: r.slug, description: r.description || '', revoked_at: iso(r.revokedAt) })));
    }
  } else {
    for (const a of accounts) {
      roles.push(...[...mem.roles.values()].filter((r) => r.account_id === a.id));
      policies.push(...[...mem.policies.values()].filter((p) => p.account_id === a.id));
      keys.push(...[...mem.apiKeys.values()]
        .filter((k: any) => k.account_id === a.id)
        .map((k: any) => ({
          id: k.id,
          account_id: k.account_id,
          name: k.name,
          prefix: k.key_prefix,
          scopes: k.scopes || [],
          user_id: k.user_id || null,
          expires_at: k.expires_at || null,
          revoked_at: k.revoked_at || null,
          last_used_at: k.last_used_at || null,
        })));
      serviceAccounts.push(...[...__mem.serviceAccounts.values()]
        .filter((s: any) => s.account_id === a.id)
        .map((s: any) => ({ ...s, revoked_at: s.revoked_at || null })));
    }
  }
  const accountSlug = new Map(accounts.map((a) => [a.id, a.slug]));
  for (const r of [...roles, ...policies, ...keys, ...serviceAccounts]) r.account_slug = accountSlug.get(r.account_id) || '';
  return {
    organization: org,
    accounts,
    users,
    admins: users.filter((u) => u.is_org_admin),
    roles,
    policies,
    keys,
    serviceAccounts,
    counts: {
      accounts: accounts.length, users: users.length,
      activeUsers: users.filter((u) => u.active !== false).length,
      orgAdmins: users.filter((u) => u.is_org_admin).length,
    },
  };
}

/** Revoke a service account without deleting its audit history. */
export async function revokeServiceAccount(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.update(schema.serviceAccounts)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.serviceAccounts.id, id), isNull(schema.serviceAccounts.revokedAt)))
      .returning({ id: schema.serviceAccounts.id });
    return rows.length > 0;
  }
  const sa: any = __mem.serviceAccounts.get(id);
  if (!sa || sa.revoked_at) return false;
  sa.revoked_at = new Date().toISOString();
  return true;
}


export interface PlatformAccountRow {
  id: string; org_id: string; org_slug: string; org_name: string; slug: string; display_name: string; created_at?: string;
}

export async function listPlatformAccounts(opts: { q?: string; orgId?: string; limit?: number; offset?: number } = {}): Promise<{ items: PlatformAccountRow[]; total: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
  const offset = Math.min(Math.max(Math.floor(Number(opts.offset) || 0), 0), 100_000);
  const q = String(opts.q || '').trim().slice(0, 200);
  if (db) {
    await ensureTables();
    const conds = [eq(schema.organizations.kind, 'tenant')];
    if (opts.orgId) conds.push(eq(schema.accounts.orgId, opts.orgId));
    if (q) conds.push(or(ilike(schema.accounts.slug, `%${q}%`), ilike(schema.accounts.displayName, `%${q}%`))!);
    const where = and(...conds);
    const total = await db.select({ n: sql<number>`count(*)::int` }).from(schema.accounts)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accounts.orgId)).where(where);
    const rows = await db.select({
      id: schema.accounts.id, orgId: schema.accounts.orgId, orgSlug: schema.organizations.slug,
      orgName: schema.organizations.displayName, slug: schema.accounts.slug,
      displayName: schema.accounts.displayName, createdAt: schema.accounts.createdAt,
    }).from(schema.accounts).innerJoin(schema.organizations, eq(schema.organizations.id, schema.accounts.orgId))
      .where(where).orderBy(asc(schema.organizations.slug), asc(schema.accounts.slug)).limit(limit).offset(offset);
    return {
      items: rows.map((r) => ({ id: r.id, org_id: r.orgId, org_slug: r.orgSlug, org_name: r.orgName, slug: r.slug, display_name: r.displayName, created_at: iso(r.createdAt) })),
      total: Number(total[0]?.n) || 0,
    };
  }
  const rows = [...mem.accounts.values()]
    .filter((a) => (mem.orgs.get(a.org_id)?.kind || 'tenant') === 'tenant')
    .map((a) => {
      const org = mem.orgs.get(a.org_id);
      return { id: a.id, org_id: a.org_id, org_slug: org?.slug || '', org_name: org?.display_name || '', slug: a.slug, display_name: a.display_name };
    })
    .filter((a) => (!opts.orgId || a.org_id === opts.orgId) && (!q || a.slug.includes(q) || a.display_name.toLowerCase().includes(q.toLowerCase())));
  return { items: rows.slice(offset, offset + limit), total: rows.length };
}

export interface PlatformUserRow {
  id: string;
  email: string;
  display_name?: string;
  org_id: string;
  org_slug?: string;
  active: boolean;
  is_org_admin: boolean;
  mfa_enabled: boolean;
  created_at?: string;
}

export async function listPlatformUsers(opts: {
  q?: string; orgId?: string; active?: boolean; isOrgAdmin?: boolean; limit?: number; offset?: number;
} = {}): Promise<{ items: PlatformUserRow[]; total: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
  const offset = Math.min(Math.max(Math.floor(Number(opts.offset) || 0), 0), 100_000);
  const q = String(opts.q || '').trim().slice(0, 200);
  if (db) {
    await ensureTables();
    const conds = [eq(schema.organizations.kind, 'tenant')];
    if (opts.orgId) conds.push(eq(schema.users.orgId, opts.orgId));
    if (opts.active !== undefined) conds.push(eq(schema.users.active, opts.active));
    if (opts.isOrgAdmin !== undefined) conds.push(eq(schema.users.isOrgAdmin, opts.isOrgAdmin));
    if (q) conds.push(or(ilike(schema.users.email, `%${q}%`), ilike(schema.users.displayName, `%${q}%`))!);
    const where = and(...conds);
    const totalRows = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.users).innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
      .where(where);
    const rows = await db.select({
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      orgId: schema.users.orgId,
      orgSlug: schema.organizations.slug,
      active: schema.users.active,
      isOrgAdmin: schema.users.isOrgAdmin,
      authVersion: schema.users.authVersion,
      createdAt: schema.users.createdAt,
    }).from(schema.users).innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
      .where(where).orderBy(asc(schema.users.email)).limit(limit).offset(offset);
    const ids = rows.map((r) => r.id);
    const mfaIds = new Set<string>();
    if (ids.length) {
      const mfaRows = await db.select({ userId: schema.userMfa.userId }).from(schema.userMfa)
        .where(and(inArray(schema.userMfa.userId, ids), eq(schema.userMfa.enabled, true)));
      for (const r of mfaRows) mfaIds.add(r.userId);
    }
    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        display_name: r.displayName ?? undefined,
        org_id: r.orgId,
        org_slug: r.orgSlug,
        active: r.active !== false,
        is_org_admin: !!r.isOrgAdmin,
        mfa_enabled: mfaIds.has(r.id),
        created_at: iso(r.createdAt),
      })),
      total: Number(totalRows[0]?.n) || 0,
    };
  }
  const orgById = new Map([...mem.orgs.values()].map((o) => [o.id, o]));
  const all = [...mem.users.values()]
    .filter((u) => (orgById.get(u.org_id)?.kind || 'tenant') === 'tenant')
    .filter((u) => !opts.orgId || u.org_id === opts.orgId)
    .filter((u) => opts.active === undefined || (u.active !== false) === opts.active)
    .filter((u) => opts.isOrgAdmin === undefined || !!u.is_org_admin === opts.isOrgAdmin)
    .filter((u) => !q || u.email.toLowerCase().includes(q.toLowerCase()) || String(u.display_name || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.email.localeCompare(b.email));
  return {
    items: all.slice(offset, offset + limit).map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      org_id: u.org_id,
      org_slug: orgById.get(u.org_id)?.slug,
      active: u.active !== false,
      is_org_admin: !!u.is_org_admin,
      mfa_enabled: !!((__mem as any).mfa?.get?.(u.id)?.enabled),
    })),
    total: all.length,
  };
}

export async function getPlatformOverviewCounts(): Promise<{
  organizations: number; accounts: number; users: number; activeUsers: number;
  orgAdmins: number; mfaEnabledUsers: number; activeApiKeys: number; serviceAccounts: number;
}> {
  if (db) {
    await ensureTables();
    const orgRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.organizations)
      .where(eq(schema.organizations.kind, 'tenant'));
    const accRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.accounts)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accounts.orgId))
      .where(eq(schema.organizations.kind, 'tenant'));
    const userRows = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${schema.users.active})::int`,
      admins: sql<number>`count(*) filter (where ${schema.users.isOrgAdmin})::int`,
    }).from(schema.users).innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
      .where(eq(schema.organizations.kind, 'tenant'));
    const mfaRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.userMfa)
      .innerJoin(schema.users, eq(schema.users.id, schema.userMfa.userId))
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
      .where(and(eq(schema.organizations.kind, 'tenant'), eq(schema.userMfa.enabled, true)));
    const keyRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.apiKeys)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.apiKeys.accountId))
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accounts.orgId))
      .where(and(eq(schema.organizations.kind, 'tenant'), isNull(schema.apiKeys.revokedAt)));
    const saRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.serviceAccounts)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.serviceAccounts.accountId))
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accounts.orgId))
      .where(eq(schema.organizations.kind, 'tenant'));
    return {
      organizations: Number(orgRows[0]?.n) || 0,
      accounts: Number(accRows[0]?.n) || 0,
      users: Number(userRows[0]?.total) || 0,
      activeUsers: Number(userRows[0]?.active) || 0,
      orgAdmins: Number(userRows[0]?.admins) || 0,
      mfaEnabledUsers: Number(mfaRows[0]?.n) || 0,
      activeApiKeys: Number(keyRows[0]?.n) || 0,
      serviceAccounts: Number(saRows[0]?.n) || 0,
    };
  }
  const tenantOrgs = new Set([...mem.orgs.values()].filter((o) => (o.kind || 'tenant') === 'tenant').map((o) => o.id));
  const accounts = [...mem.accounts.values()].filter((a) => tenantOrgs.has(a.org_id));
  const users = [...mem.users.values()].filter((u) => tenantOrgs.has(u.org_id));
  return {
    organizations: tenantOrgs.size,
    accounts: accounts.length,
    users: users.length,
    activeUsers: users.filter((u) => u.active !== false).length,
    orgAdmins: users.filter((u) => u.is_org_admin).length,
    mfaEnabledUsers: users.filter((u) => !!((__mem as any).mfa?.get?.(u.id)?.enabled)).length,
    activeApiKeys: [...mem.apiKeys.values()].filter((k) => !k.revoked_at && accounts.some((a) => a.id === k.account_id)).length,
    serviceAccounts: [...mem.serviceAccounts.values()].filter((sa) => accounts.some((a) => a.id === sa.account_id)).length,
  };
}

export const __mem = mem;
