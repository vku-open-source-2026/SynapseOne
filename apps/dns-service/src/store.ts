// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir, open, rename, unlink } from 'node:fs/promises';

import { dirname, basename, resolve } from 'node:path';
import { z } from 'zod';
import { conflict, invalid, notFound, ServiceError } from './errors';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import type { CreateZoneInput, DnsRecord, RecordInput, RecordPatch, StoreSnapshot, Zone, ZoneSummary } from './types';
import {
  assertZoneDefaults,
  assertRecordSetValid,
  bumpSoaSerial,
  mergeRecordPatch,
  normalizeZoneName,
  parseCreateZoneInput,
  parseRecordInput,
  recordInputSchema,
  MAX_ZONES,
} from './validation';

const DEFAULT_TTL = 300;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const isoDateTime = z.string().datetime();
const metadataSchema = z.object({
  id: z.string().uuid(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).passthrough();
const storedRecordSchema = z.intersection(recordInputSchema, metadataSchema);
const snapshotSchema = z.object({
  version: z.literal(1),
  zones: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    records: z.array(storedRecordSchema),
  }).strict()).max(MAX_ZONES),
}).strict();

export interface ZoneStoreOptions {
  /** Omit for the default persistent store. Tests can explicitly request memory. */
  filePath?: string;
  memory?: boolean;
  logger?: Logger;
}

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function materializeRecord(input: RecordInput, timestamp = now()): DnsRecord {
  return {
    ...input,
    ttl: input.ttl ?? DEFAULT_TTL,
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  } as DnsRecord;
}

function toSnapshot(zones: Map<string, Zone>): StoreSnapshot {
  return {
    version: 1,
    zones: [...zones.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((zone) => ({
        ...zone,
        records: [...zone.records].sort((a, b) =>
          a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id)),
      })),
  };
}

function decodeSnapshot(value: unknown): Map<string, Zone> {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error('DNS data file does not match snapshot schema version 1');

  const zones = new Map<string, Zone>();
  const zoneIds = new Set<string>();
  for (const rawZone of parsed.data.zones) {
    const zoneName = normalizeZoneName(rawZone.name);
    if (zones.has(zoneName)) throw new Error(`Duplicate zone ${zoneName} in DNS data file`);
    if (zoneIds.has(rawZone.id)) throw new Error('Duplicate zone ID in DNS data file');
    zoneIds.add(rawZone.id);

    const recordIds = new Set<string>();
    const records = rawZone.records.map((rawRecord) => {
      if (recordIds.has(rawRecord.id)) throw new Error(`Duplicate record ID in zone ${zoneName}`);
      recordIds.add(rawRecord.id);
      const { id, createdAt, updatedAt, ...input } = rawRecord;
      const normalized = parseRecordInput(input, zoneName);
      return {
        ...normalized,
        ttl: normalized.ttl ?? DEFAULT_TTL,
        id,
        createdAt,
        updatedAt,
      } as DnsRecord;
    });
    assertZoneDefaults(zoneName, records);
    zones.set(zoneName, {
      id: rawZone.id,
      name: zoneName,
      createdAt: rawZone.createdAt,
      updatedAt: rawZone.updatedAt,
      records,
    });
  }
  return zones;
}

/**
 * Single-process zone store. Mutations are serialized, written to a fsynced
 * temporary file, atomically renamed, and only then published to readers.
 */
export class ZoneStore {
  private zones: Map<string, Zone>;
  private readonly filePath?: string;
  private readonly logger: Logger;
  private writeQueue: Promise<void> = Promise.resolve();
  private healthy = true;

  constructor(options: ZoneStoreOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.filePath = options.memory ? undefined : resolve(options.filePath ?? './data/synapsedns.json');
    this.zones = new Map();
    if (this.filePath) this.zones = this.loadSync();
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  async initialize(): Promise<void> {
    if (!this.filePath) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await access(dirname(this.filePath), constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (error) {
      this.healthy = false;
      this.logger.error('store_initialize_failed', { error: error instanceof Error ? error.name : 'Error' });
      throw new ServiceError(503, 'store_unavailable', 'DNS data directory is not readable and writable');
    }
  }

  private loadSync(): Map<string, Zone> {
    try {
      const contents = readFileSync(this.filePath!, 'utf8');
      if (Buffer.byteLength(contents, 'utf8') > MAX_STORE_BYTES) throw new Error('DNS data file is too large');
      return decodeSnapshot(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw new ServiceError(503, 'store_unavailable', 'Unable to load a valid DNS data file');
    }
  }

  listZones(): ZoneSummary[] {
    return [...this.zones.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name, createdAt, updatedAt, records }) => ({
        id, name, createdAt, updatedAt, recordCount: records.length,
      }));
  }

  getZone(name: string): Zone | undefined {
    const zone = this.zones.get(normalizeZoneName(name));
    return zone ? clone(zone) : undefined;
  }

  /** Internal read-only lookup for the DNS hot path; longest suffix wins. */
  lookupZone(name: string): Zone | undefined {
    let match: Zone | undefined;
    for (const zone of this.zones.values()) {
      if ((name === zone.name || name.endsWith(`.${zone.name}`)) &&
          (!match || zone.name.length > match.name.length)) {
        match = zone;
      }
    }
    return match;
  }

  async createZone(input: CreateZoneInput): Promise<Zone> {
    const parsed = parseCreateZoneInput(input);
    return this.enqueue((zones) => {
      if (zones.size >= MAX_ZONES) invalid(`The store cannot contain more than ${MAX_ZONES} zones`);
      if (zones.has(parsed.name)) conflict('zone_exists', `Zone ${parsed.name} already exists`);

      const timestamp = now();
      const ttl = parsed.ttl ?? DEFAULT_TTL;
      const nameservers = parsed.nameservers ?? [`ns1.${parsed.name}`, `ns2.${parsed.name}`];
      if (new Set(nameservers).size !== nameservers.length) invalid('nameservers must not contain duplicates');

      const zone: Zone = {
        id: randomUUID(),
        name: parsed.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        records: [
          materializeRecord({
            type: 'SOA',
            name: parsed.name,
            ttl,
            primary: nameservers[0],
            admin: `hostmaster.${parsed.name}`,
            serial: Math.floor(Date.now() / 1000),
            refresh: 3600,
            retry: 900,
            expiration: 604800,
            minimum: ttl,
          }, timestamp),
          ...nameservers.map((target) => materializeRecord({ type: 'NS', name: parsed.name, ttl, target }, timestamp)),
        ],
      };
      assertZoneDefaults(zone.name, zone.records);
      zones.set(zone.name, zone);
      return clone(zone);
    });
  }

  async deleteZone(name: string): Promise<void> {
    const zoneName = normalizeZoneName(name);
    await this.enqueue((zones) => {
      if (!zones.delete(zoneName)) notFound('Zone');
    });
  }

  async createRecord(zoneName: string, input: RecordInput): Promise<DnsRecord> {
    const normalizedZone = normalizeZoneName(zoneName);
    const parsed = parseRecordInput(input, normalizedZone);
    return this.enqueue((zones) => {
      const zone = requireZone(zones, normalizedZone);
      const timestamp = now();
      const record = materializeRecord(parsed, timestamp);
      const nextRecords = [...zone.records, record];
      assertRecordSetValid(zone.name, nextRecords);
      bumpSoaSerial(nextRecords);
      zone.records = nextRecords;
      zone.updatedAt = timestamp;
      return clone(record);
    });
  }

  async patchRecord(zoneName: string, recordId: string, patch: RecordPatch): Promise<DnsRecord> {
    const normalizedZone = normalizeZoneName(zoneName);
    return this.enqueue((zones) => {
      const zone = requireZone(zones, normalizedZone);
      const index = zone.records.findIndex((record) => record.id === recordId);
      if (index < 0) notFound('Record');
      const existing = zone.records[index];
      const parsed = mergeRecordPatch(existing, patch, zone.name);
      const timestamp = now();
      const updated: DnsRecord = {
        ...parsed,
        ttl: parsed.ttl ?? DEFAULT_TTL,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: timestamp,
      } as DnsRecord;
      const nextRecords = [...zone.records];
      nextRecords[index] = updated;
      assertRecordSetValid(zone.name, nextRecords);
      if (updated.type !== 'SOA') bumpSoaSerial(nextRecords);
      zone.records = nextRecords;
      zone.updatedAt = timestamp;
      return clone(updated);
    });
  }

  async deleteRecord(zoneName: string, recordId: string): Promise<void> {
    const normalizedZone = normalizeZoneName(zoneName);
    await this.enqueue((zones) => {
      const zone = requireZone(zones, normalizedZone);
      const index = zone.records.findIndex((record) => record.id === recordId);
      if (index < 0) notFound('Record');
      const existing = zone.records[index];
      if (existing.type === 'SOA') conflict('soa_required', 'The apex SOA record cannot be deleted');
      if (existing.type === 'NS' && existing.name === zone.name &&
          zone.records.filter((record) => record.type === 'NS' && record.name === zone.name).length === 1) {
        conflict('ns_required', 'At least one apex NS record is required');
      }
      const nextRecords = zone.records.filter((_, recordIndex) => recordIndex !== index);
      bumpSoaSerial(nextRecords);
      zone.records = nextRecords;
      zone.updatedAt = now();
    });
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  private async enqueue<T>(operation: (zones: Map<string, Zone>) => T): Promise<T> {
    if (!this.healthy) throw new ServiceError(503, 'store_unavailable', 'DNS store is unavailable');
    const run = this.writeQueue.then(async () => {
      const draft = clone(this.zones);
      const result = operation(draft);
      if (this.filePath) {
        const snapshot = toSnapshot(draft);
        const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
        if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
          conflict('store_limit', `DNS snapshot exceeds the ${MAX_STORE_BYTES}-byte persistence limit`);
        }
        try {
          await this.writeSnapshot(serialized);
        } catch (error) {
          this.healthy = false;
          this.logger.error('store_write_failed', { error: error instanceof Error ? error.name : 'Error' });
          throw new ServiceError(503, 'store_unavailable', 'Unable to persist DNS data');
        }
      }
      this.zones = draft;
      return clone(result);
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeSnapshot(serialized: string): Promise<void> {
    const filePath = this.filePath!;
    const directory = dirname(filePath);
    const temporary = resolve(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, filePath);
      // Persist the directory entry where the filesystem supports directory fsync.
      try {
        const dirHandle = await open(directory, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function requireZone(zones: Map<string, Zone>, name: string): Zone {
  const zone = zones.get(name);
  if (!zone) notFound('Zone');
  return zone;
}

// Loading is synchronous so corrupt production state aborts boot rather than
// serving an unexpectedly empty authoritative server.
