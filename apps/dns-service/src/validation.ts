// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';
import { conflict, invalid, ServiceError } from './errors';
import { RECORD_TYPES, type CreateZoneInput, type DnsRecord, type RecordInput, type RecordPatch } from './types';

export const MAX_TTL = 0x7fffffff;
export const MAX_U32 = 0xffffffff;
export const MAX_RECORDS_PER_ZONE = 10_000;
export const MAX_ZONES = 1_000;

export const orgIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);

export function isValidOrgId(value: unknown): value is string {
  return orgIdSchema.safeParse(value).success;
}

const nameSchema = z.string().min(1).max(255);
const ttlSchema = z.number().int().min(0).max(MAX_TTL);
const u16Schema = z.number().int().min(0).max(0xffff);
const u32Schema = z.number().int().min(0).max(MAX_U32);
const timerSchema = z.number().int().min(0).max(MAX_U32);

export const createZoneSchema = z.object({
  name: nameSchema,
  nameservers: z.array(nameSchema).min(1).max(8).optional(),
  ttl: ttlSchema.optional(),
  // Ownership comes from the authenticated principal, never the request body.
  // Accept and discard this field so client-supplied orgId cannot affect ownership.
  orgId: z.unknown().optional(),
}).strict();

const recordSchemas = [
  z.object({ type: z.literal('A'), name: nameSchema, ttl: ttlSchema.optional(), address: z.string().max(64) }).strict(),
  z.object({ type: z.literal('AAAA'), name: nameSchema, ttl: ttlSchema.optional(), address: z.string().max(64) }).strict(),
  z.object({ type: z.literal('CNAME'), name: nameSchema, ttl: ttlSchema.optional(), target: nameSchema }).strict(),
  z.object({ type: z.literal('MX'), name: nameSchema, ttl: ttlSchema.optional(), priority: u16Schema, target: nameSchema }).strict(),
  z.object({
    type: z.literal('TXT'),
    name: nameSchema,
    ttl: ttlSchema.optional(),
    data: z.union([z.string().max(4096), z.array(z.string().max(4096)).min(1).max(32)]),
  }).strict(),
  z.object({ type: z.literal('NS'), name: nameSchema, ttl: ttlSchema.optional(), target: nameSchema }).strict(),
  z.object({
    type: z.literal('SOA'),
    name: nameSchema,
    ttl: ttlSchema.optional(),
    primary: nameSchema,
    admin: nameSchema,
    serial: z.number().int().min(1).max(MAX_U32),
    refresh: timerSchema,
    retry: timerSchema,
    expiration: timerSchema,
    minimum: ttlSchema,
  }).strict(),
  z.object({
    type: z.literal('SRV'),
    name: nameSchema,
    ttl: ttlSchema.optional(),
    priority: u16Schema,
    weight: u16Schema,
    port: u16Schema,
    target: nameSchema,
  }).strict(),
  z.object({
    type: z.literal('CAA'),
    name: nameSchema,
    ttl: ttlSchema.optional(),
    flags: z.number().int().min(0).max(0xff),
    tag: z.string().regex(/^[A-Za-z0-9]{1,15}$/),
    value: z.string().max(1024),
  }).strict(),
  z.object({ type: z.literal('PTR'), name: nameSchema, ttl: ttlSchema.optional(), target: nameSchema }).strict(),
] as const;

export const recordInputSchema = z.discriminatedUnion('type', recordSchemas);

export const recordPatchSchema = z.object({
  name: nameSchema.optional(),
  ttl: ttlSchema.optional(),
  address: z.string().max(64).optional(),
  target: nameSchema.optional(),
  priority: u16Schema.optional(),
  data: z.union([z.string().max(4096), z.array(z.string().max(4096)).min(1).max(32)]).optional(),
  primary: nameSchema.optional(),
  admin: nameSchema.optional(),
  serial: z.number().int().min(1).max(MAX_U32).optional(),
  refresh: timerSchema.optional(),
  retry: timerSchema.optional(),
  expiration: timerSchema.optional(),
  minimum: ttlSchema.optional(),
  weight: u16Schema.optional(),
  port: u16Schema.optional(),
  flags: z.number().int().min(0).max(0xff).optional(),
  tag: z.string().regex(/^[A-Za-z0-9]{1,15}$/).optional(),
  value: z.string().max(1024).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWNER_LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?|\*)$/;

export interface NormalizeNameOptions {
  wildcard?: boolean;
  underscores?: boolean;
  root?: boolean;
}

/** Normalize to the canonical lower-case presentation form with a trailing dot. */
export function normalizeDnsName(value: string, options: NormalizeNameOptions = {}): string {
  if (typeof value !== 'string') invalid('DNS name must be a string');
  const trimmed = value.trim();
  if (!trimmed) invalid('DNS name must not be empty');
  if (trimmed.length > 255) invalid('DNS name is too long');

  const absolute = trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
  if (absolute === '.') {
    if (!options.root) invalid('The DNS root is not allowed here');
    return '.';
  }

  const labels = absolute.slice(0, -1).split('.');
  if (labels.some((label) => !label)) invalid('DNS name contains an empty label');
  if (labels.length > 127) invalid('DNS name has too many labels');

  const labelPattern = options.underscores ? OWNER_LABEL : HOST_LABEL;
  for (const [index, label] of labels.entries()) {
    const lower = label.toLowerCase();
    if (lower === '*') {
      if (!options.wildcard || index !== 0 || labels.length < 2) {
        invalid('A wildcard is allowed only as the complete left-most owner label');
      }
      continue;
    }
    if (!labelPattern.test(lower)) invalid(`Invalid DNS label: ${label}`);
  }

  const normalized = `${labels.map((label) => label.toLowerCase()).join('.')}.`;
  const wireLength = normalized === '.' ? 1 : normalized.slice(0, -1).split('.').reduce((sum, label) => sum + label.length + 1, 1);
  if (wireLength > 255) invalid('DNS name exceeds the 255-octet wire limit');
  return normalized;
}

export function normalizeZoneName(value: string): string {
  const normalized = normalizeDnsName(value);
  if (normalized.split('.').length - 1 < 2) invalid('A zone must have at least two labels');
  return normalized;
}

export function normalizeOwnerName(value: string): string {
  return normalizeDnsName(value, { wildcard: true, underscores: true });
}

export function normalizeTargetName(value: string, allowRoot = false): string {
  return normalizeDnsName(value, { root: allowRoot });
}

export function isWithinZone(name: string, zoneName: string): boolean {
  return name === zoneName || name.endsWith(`.${zoneName}`);
}

export function assertWithinZone(name: string, zoneName: string): void {
  if (!isWithinZone(name, zoneName)) invalid(`Record name ${name} is outside zone ${zoneName}`);
}

function parseZod(error: z.ZodError): never {
  const details = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.') || undefined,
    message: issue.message,
  }));
  throw new ServiceError(400, 'validation_error', 'Request validation failed', details);
}

function validateText(value: string, field: string, allowTab = false): void {
  const controls = allowTab ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (controls.test(value)) invalid(`${field} contains control characters`);
}

export function parseCreateZoneInput(input: unknown): CreateZoneInput {
  const parsed = createZoneSchema.safeParse(input);
  if (!parsed.success) parseZod(parsed.error);
  return {
    name: normalizeZoneName(parsed.data.name),
    nameservers: parsed.data.nameservers?.map((name) => normalizeTargetName(name)),
    ttl: parsed.data.ttl,
  };
}

export function parseRecordInput(input: unknown, zoneName?: string): RecordInput {
  const parsed = recordInputSchema.safeParse(input);
  if (!parsed.success) parseZod(parsed.error);
  const value = parsed.data;
  const name = normalizeOwnerName(value.name);
  if (zoneName) assertWithinZone(name, zoneName);
  const ttl = value.ttl;

  switch (value.type) {
    case 'A':
      if (!isIPv4(value.address)) invalid('A address must be a valid IPv4 address');
      return { type: 'A', name, ttl, address: value.address };
    case 'AAAA': {
      if (!isIPv6(value.address) || value.address.includes('%')) invalid('AAAA address must be a valid IPv6 address without a scope');
      try {
        // URL's IPv6 serializer canonicalizes equivalent expanded/compressed forms.
        const address = new URL(`http://[${value.address}]/`).hostname.slice(1, -1).toLowerCase();
        return { type: 'AAAA', name, ttl, address };
      } catch {
        invalid('AAAA address must be a valid IPv6 address');
      }
    }
    case 'CNAME': {
      const target = normalizeTargetName(value.target);
      if (target === name) invalid('A CNAME cannot point to itself');
      return { type: 'CNAME', name, ttl, target };
    }
    case 'MX':
      return { type: 'MX', name, ttl, priority: value.priority, target: normalizeTargetName(value.target, true) };
    case 'TXT': {
      const data = Array.isArray(value.data) ? [...value.data] : [value.data];
      for (const [index, chunk] of data.entries()) {
        if (Buffer.byteLength(chunk, 'utf8') > 255) invalid(`TXT data[${index}] exceeds 255 UTF-8 bytes; use multiple chunks`);
        validateText(chunk, `TXT data[${index}]`, true);
      }
      return { type: 'TXT', name, ttl, data };
    }
    case 'NS':
      return { type: 'NS', name, ttl, target: normalizeTargetName(value.target) };
    case 'SOA':
      if (name !== zoneName) invalid('SOA records are allowed only at the zone apex');
      return {
        type: 'SOA', name, ttl,
        primary: normalizeTargetName(value.primary),
        admin: normalizeTargetName(value.admin),
        serial: value.serial,
        refresh: value.refresh,
        retry: value.retry,
        expiration: value.expiration,
        minimum: value.minimum,
      };
    case 'SRV':
      return {
        type: 'SRV', name, ttl,
        priority: value.priority,
        weight: value.weight,
        port: value.port,
        target: normalizeTargetName(value.target, true),
      };
    case 'CAA':
      validateText(value.value, 'CAA value');
      if (Buffer.byteLength(value.value, 'utf8') > 255) invalid('CAA value exceeds 255 UTF-8 bytes');
      return { type: 'CAA', name, ttl, flags: value.flags, tag: value.tag.toLowerCase(), value: value.value };
    case 'PTR':
      return { type: 'PTR', name, ttl, target: normalizeTargetName(value.target) };
    default: {
      const exhaustive: never = value;
      invalid(`Unsupported record type; expected one of ${RECORD_TYPES.join(', ')}`, exhaustive);
    }
  }
}

export function parseRecordPatch(input: unknown): RecordPatch {
  const parsed = recordPatchSchema.safeParse(input);
  if (!parsed.success) parseZod(parsed.error);
  return parsed.data;
}

export function mergeRecordPatch(existing: DnsRecord, patch: RecordPatch, zoneName: string): RecordInput {
  const { id: _id, type: _type, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = existing;
  return parseRecordInput({ ...input, ...patch, type: existing.type }, zoneName);
}

/** TTL is deliberately not part of RR identity. */
export function recordRdataKey(record: DnsRecord): string {
  switch (record.type) {
    case 'A':
    case 'AAAA':
      return JSON.stringify([record.type, record.address]);
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return JSON.stringify([record.type, record.target]);
    case 'MX':
      return JSON.stringify([record.type, record.priority, record.target]);
    case 'TXT':
      return JSON.stringify([record.type, record.data]);
    case 'SOA':
      return JSON.stringify([record.type, record.primary, record.admin, record.serial, record.refresh, record.retry, record.expiration, record.minimum]);
    case 'SRV':
      return JSON.stringify([record.type, record.priority, record.weight, record.port, record.target]);
    case 'CAA':
      return JSON.stringify([record.type, record.flags, record.tag, record.value]);
  }
}

export function recordsDuplicate(a: DnsRecord, b: DnsRecord): boolean {
  return a.name === b.name && a.type === b.type && recordRdataKey(a) === recordRdataKey(b);
}

export function assertRecordSetValid(zoneName: string, records: DnsRecord[]): void {
  if (records.length > MAX_RECORDS_PER_ZONE) invalid(`A zone cannot contain more than ${MAX_RECORDS_PER_ZONE} records`);

  const byOwner = new Map<string, DnsRecord[]>();
  const identities = new Set<string>();
  for (const record of records) {
    assertWithinZone(record.name, zoneName);
    const ownerRecords = byOwner.get(record.name) ?? [];
    ownerRecords.push(record);
    byOwner.set(record.name, ownerRecords);
    const identity = `${record.name}\0${recordRdataKey(record)}`;
    if (identities.has(identity)) conflict('duplicate_record', `Duplicate ${record.type} record at ${record.name}`);
    identities.add(identity);
  }

  for (const [owner, ownerRecords] of byOwner) {
    const cname = ownerRecords.find((record) => record.type === 'CNAME');
    if (cname && ownerRecords.length !== 1) conflict('cname_conflict', `CNAME at ${owner} cannot coexist with other records`);
    if (owner === zoneName && cname) conflict('cname_conflict', 'A zone apex cannot be a CNAME');
  }

  const soa = records.filter((record) => record.type === 'SOA');
  if (soa.length > 1 || (soa.length === 1 && soa[0].name !== zoneName)) {
    invalid('Exactly one SOA record is allowed, at the zone apex');
  }

  // Reject CNAME cycles wholly contained in this zone. External targets are valid
  // and are not followed by this authoritative-only server.
  for (const record of records) {
    if (record.type !== 'CNAME') continue;
    const seen = new Set<string>([record.name]);
    let target = record.target;
    while (isWithinZone(target, zoneName)) {
      if (seen.has(target)) conflict('cname_loop', `CNAME at ${record.name} creates a loop`);
      seen.add(target);
      const next = records.find((candidate): candidate is Extract<DnsRecord, { type: 'CNAME' }> =>
        candidate.type === 'CNAME' && candidate.name === target);
      if (!next) break;
      target = next.target;
    }
  }
}

export function assertZoneDefaults(zoneName: string, records: DnsRecord[]): void {
  assertRecordSetValid(zoneName, records);
  if (!records.some((record) => record.type === 'SOA' && record.name === zoneName)) {
    invalid('Zone is missing its apex SOA record');
  }
  if (!records.some((record) => record.type === 'NS' && record.name === zoneName)) {
    invalid('Zone is missing its apex NS records');
  }
}

export function nextSoaSerial(current: number): number {
  return current >= MAX_U32 ? 1 : current + 1;
}

export function bumpSoaSerial(records: DnsRecord[]): void {
  const soa = records.find((record) => record.type === 'SOA');
  if (soa) soa.serial = nextSoaSerial(soa.serial);
}
