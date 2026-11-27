// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { randomUUID } from 'crypto';
import { and, count, desc, eq, ilike, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { hackathonRegistrations } from './schema';
import { getDb, useDb } from './db';

export type HackathonRegistration = typeof hackathonRegistrations.$inferSelect;
export type HackathonStatus = 'pending' | 'approved' | 'rejected';

export interface HackathonRegistrationInput {
  registrationType: 'team' | 'individual';
  teamName: string;
  captainName: string;
  captainEmail: string;
  captainPhone: string;
  captainStudentId: string;
  members: string[];
  memberYears: number[];
  memberSkills: string[][];
  projectIdea?: string;
}

const memory = new Map<string, HackathonRegistration>();

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function publicRow(row: HackathonRegistration) {
  return {
    id: row.id,
    teamName: row.teamName,
    registrationType: row.registrationType || 'team',
    captainName: row.captainName,
    captainEmail: row.captainEmail,
    captainPhone: row.captainPhone,
    captainStudentId: row.captainStudentId,
    memberNames: Array.isArray(row.memberNames) ? row.memberNames : [],
    memberYears: Array.isArray(row.memberYears) ? row.memberYears : [],
    memberSkills: Array.isArray(row.memberSkills) ? row.memberSkills : [],
    projectIdea: row.projectIdea || '',
    status: row.status,
    reviewNote: row.reviewNote || '',
    reviewedBy: row.reviewedBy || null,
    reviewedAt: iso(row.reviewedAt),
    apiKeySentAt: iso(row.apiKeySentAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function normalize(input: HackathonRegistrationInput) {
  const captainName = input.captainName.trim();
  return {
    teamName: input.registrationType === 'team' ? input.teamName.trim() : null,
    registrationType: input.registrationType,
    captainName,
    captainEmail: input.captainEmail.trim().toLowerCase(),
    captainPhone: input.captainPhone.trim(),
    captainStudentId: input.captainStudentId.trim().toUpperCase(),
    memberNames: input.registrationType === 'team'
      ? [captainName, ...input.members.map((name) => name.trim())]
      : [captainName],
    memberYears: input.memberYears.map((year) => Number(year)),
    memberSkills: input.memberSkills.map((skills) => [...new Set(skills)]),
    projectIdea: input.projectIdea?.trim() || null,
  };
}

export async function createHackathonRegistration(input: HackathonRegistrationInput, maxRegistrations?: number) {
  const values = normalize(input);
  if (useDb()) {
    const insert = async (tx: any) => {
      if (maxRegistrations != null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('synapseone_hackathon_registration'))`);
        const [current] = await tx.select({ value: count() }).from(hackathonRegistrations);
        if (Number(current?.value || 0) >= maxRegistrations) {
          throw Object.assign(new Error('hackathon registration capacity reached'), { code: 'hackathon_full' });
        }
      }
      const [row] = await tx.insert(hackathonRegistrations).values(values).returning();
      return publicRow(row);
    };
    return maxRegistrations == null
      ? insert(getDb()!)
      : getDb()!.transaction(insert);
  }
  if (maxRegistrations != null && memory.size >= maxRegistrations) {
    throw Object.assign(new Error('hackathon registration capacity reached'), { code: 'hackathon_full' });
  }
  const duplicate = [...memory.values()].some(
    (row) => (values.teamName != null && row.teamName?.toLowerCase() === values.teamName.toLowerCase())
      || row.captainEmail.toLowerCase() === values.captainEmail,
  );
  if (duplicate) throw Object.assign(new Error('duplicate hackathon registration'), { code: '23505' });
  const now = new Date();
  const row: HackathonRegistration = {
    id: randomUUID(),
    ...values,
    status: 'pending',
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    apiKeySentAt: null,
    createdAt: now,
    updatedAt: now,
  };
  memory.set(row.id, row);
  return publicRow(row);
}

export async function getHackathonRegistration(id: string) {
  if (!useDb()) {
    const row = memory.get(id);
    return row ? publicRow(row) : null;
  }
  const [row] = await getDb()!.select().from(hackathonRegistrations).where(eq(hackathonRegistrations.id, id)).limit(1);
  return row ? publicRow(row) : null;
}

export async function listHackathonRegistrations(opts: {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), 100_000);
  const conditions: SQL[] = [];
  if (opts.status) conditions.push(eq(hackathonRegistrations.status, opts.status));
  if (opts.q) {
    const needle = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(or(
      ilike(hackathonRegistrations.teamName, needle),
      ilike(hackathonRegistrations.captainName, needle),
      ilike(hackathonRegistrations.captainEmail, needle),
      ilike(hackathonRegistrations.captainStudentId, needle),
    )!);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  if (!useDb()) {
    const rows = [...memory.values()]
      .filter((row) => (!opts.status || row.status === opts.status)
        && (!opts.q || [row.teamName || '', row.captainName, row.captainEmail, row.captainStudentId]
          .some((value) => value.toLowerCase().includes(opts.q!.toLowerCase()))))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const counts = {
      pending: [...memory.values()].filter((row) => row.status === 'pending').length,
      approved: [...memory.values()].filter((row) => row.status === 'approved').length,
      rejected: [...memory.values()].filter((row) => row.status === 'rejected').length,
      apiKeySent: [...memory.values()].filter((row) => row.apiKeySentAt != null).length,
      individuals: [...memory.values()].filter((row) => row.registrationType === 'individual' && row.status !== 'rejected').length,
    };
    return { items: rows.slice(offset, offset + limit).map(publicRow), total: rows.length, counts };
  }

  const [rows, totals, statusRows] = await Promise.all([
    getDb()!.select().from(hackathonRegistrations).where(where)
      .orderBy(desc(hackathonRegistrations.createdAt)).limit(limit).offset(offset),
    getDb()!.select({ value: count() }).from(hackathonRegistrations).where(where),
    getDb()!.select({ status: hackathonRegistrations.status, value: count() })
      .from(hackathonRegistrations).groupBy(hackathonRegistrations.status),
  ]);
  const byStatus = (status: string) => Number(statusRows.find((row) => row.status === status)?.value || 0);
  const [sent] = await getDb()!.select({ value: count() }).from(hackathonRegistrations)
    .where(isNotNull(hackathonRegistrations.apiKeySentAt));
  const [individuals] = await getDb()!.select({ value: count() }).from(hackathonRegistrations)
    .where(and(eq(hackathonRegistrations.registrationType, 'individual'), ne(hackathonRegistrations.status, 'rejected')));
  return {
    items: rows.map(publicRow),
    total: Number(totals[0]?.value || 0),
    counts: {
      pending: byStatus('pending'),
      approved: byStatus('approved'),
      rejected: byStatus('rejected'),
      apiKeySent: Number(sent?.value || 0),
      individuals: Number(individuals?.value || 0),
    },
  };
}

export async function countHackathonRegistrations(): Promise<number> {
  if (!useDb()) return memory.size;
  const [row] = await getDb()!.select({ value: count() }).from(hackathonRegistrations);
  return Number(row?.value || 0);
}

export async function reviewHackathonRegistration(input: {
  id: string;
  status: HackathonStatus;
  reviewNote?: string;
  reviewedBy: string;
}) {
  const now = new Date();
  const values = {
    status: input.status,
    reviewNote: input.reviewNote?.trim() || null,
    reviewedBy: input.reviewedBy,
    reviewedAt: now,
    updatedAt: now,
    ...(input.status === 'rejected' ? { apiKeySentAt: null } : {}),
  };
  if (!useDb()) {
    const row = memory.get(input.id);
    if (!row) return null;
    const next = { ...row, ...values };
    memory.set(row.id, next);
    return publicRow(next);
  }
  const [row] = await getDb()!.update(hackathonRegistrations).set(values)
    .where(eq(hackathonRegistrations.id, input.id)).returning();
  return row ? publicRow(row) : null;
}

export async function markHackathonApiKeySent(id: string) {
  const now = new Date();
  if (!useDb()) {
    const row = memory.get(id);
    if (!row) return null;
    const next = { ...row, apiKeySentAt: row.apiKeySentAt || now, updatedAt: now };
    memory.set(row.id, next);
    return publicRow(next);
  }
  const [row] = await getDb()!.update(hackathonRegistrations)
    .set({ apiKeySentAt: now, updatedAt: now })
    .where(and(eq(hackathonRegistrations.id, id), isNull(hackathonRegistrations.apiKeySentAt)))
    .returning();
  if (row) return publicRow(row);
  return getHackathonRegistration(id);
}

/** Deterministic, non-mutating team suggestions for individual players. */
export async function suggestHackathonTeams() {
  let rows: HackathonRegistration[];
  if (useDb()) {
    rows = await getDb()!.select().from(hackathonRegistrations)
      .where(and(eq(hackathonRegistrations.registrationType, 'individual'), ne(hackathonRegistrations.status, 'rejected')))
      .orderBy(hackathonRegistrations.createdAt);
  } else {
    rows = [...memory.values()]
      .filter((row) => row.registrationType === 'individual' && row.status !== 'rejected')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  const remaining = [...rows];
  const used = new Set<string>();
  const suggestions: Array<Record<string, any>> = [];
  while (remaining.length >= 3) {
    const anchorIndex = remaining.findIndex((row) => row.memberYears?.[0] === 2 || (row.memberSkills?.[0]?.length || 0) > 0);
    if (anchorIndex < 0) break;
    const [anchor] = remaining.splice(anchorIndex, 1);
    const members = [anchor];
    const firstYearIndexes = remaining
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.memberYears?.[0] === 1)
      .slice(0, 2);
    for (const { index } of firstYearIndexes.reverse()) members.push(remaining.splice(index, 1)[0]);
    while (members.length < 3 && remaining.length) members.push(remaining.shift()!);
    if (members.length < 3) break;
    for (const member of members) used.add(member.id);
    const hasSkills = (anchor.memberSkills?.[0]?.length || 0) > 0;
    suggestions.push({
      id: `suggestion-${suggestions.length + 1}`,
      pattern: anchor.memberYears?.[0] === 2
        ? (hasSkills ? '1 sinh viên năm 2 có kỹ năng nâng cao + 2 thành viên' : '1 sinh viên năm 2 + 2 thành viên')
        : '1 thành viên có kỹ năng nâng cao + 2 thành viên',
      registrationIds: members.map((member) => member.id),
      members: members.map((member) => ({
        id: member.id,
        name: member.captainName,
        year: member.memberYears?.[0] || null,
        skills: member.memberSkills?.[0] || [],
        email: member.captainEmail,
        studentId: member.captainStudentId,
        status: member.status,
      })),
    });
  }
  return {
    suggestions,
    unmatched: rows.filter((row) => !used.has(row.id)).map(publicRow),
    summary: {
      individuals: rows.length,
      suggestedTeams: suggestions.length,
      matched: used.size,
      unmatched: rows.length - used.size,
    },
  };
}
