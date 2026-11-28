// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';
import { z } from 'zod';
import type { ConnectorRecord, PublicConnector, RouteRecord, StoreSnapshot } from './types';

const tokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const orgIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable();
const legacyConnectorSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  upstreamUrl: z.string().min(1).max(2048),
  tokenHash: tokenHashSchema,
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const connectorSchema = legacyConnectorSchema.extend({ orgId: orgIdSchema });

const routeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  hostname: z.string().min(1).max(253),
  pathPrefix: z.string().max(512),
  connectorId: z.string().uuid(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(100).max(300000).optional(),
  maxResponseBytes: z.number().int().min(1024).max(104857600).optional(),
  rateLimitPerMinute: z.number().int().min(0).max(1000000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const storeSchema = z.object({
  version: z.literal(2),
  connectors: z.array(connectorSchema).max(10000),
  routes: z.array(routeSchema).max(10000),
}).strict();

const legacyStoreSchema = z.object({
  version: z.literal(1),
  connectors: z.array(legacyConnectorSchema).max(10000),
  routes: z.array(routeSchema).max(10000),
}).strict();

interface StoreReadResult {
  data: StoreSnapshot;
  migrated: boolean;
}

function emptyStore(): StoreSnapshot {
  return { version: 2, connectors: [], routes: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function publicConnector(connector: ConnectorRecord): PublicConnector {
  const { tokenHash: _tokenHash, ...safe } = connector;
  return safe;
}

async function readStoreFile(filePath: string, allowMissing: boolean): Promise<StoreReadResult> {
  let raw: string;
  try {
    const info = await stat(filePath);
    if (info.size > 8 * 1024 * 1024) throw new Error('Tunnel data file is too large');
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { data: emptyStore(), migrated: false };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Tunnel data file contains invalid JSON'); }
  const result = storeSchema.safeParse(parsed);
  if (result.success) return { data: result.data, migrated: false };

  const legacy = legacyStoreSchema.safeParse(parsed);
  if (!legacy.success) throw new Error('Tunnel data file has an invalid schema');
  return {
    data: {
      version: 2,
      connectors: legacy.data.connectors.map((connector) => ({ ...connector, orgId: null })),
      routes: legacy.data.routes,
    },
    migrated: true,
  };
}

export function hashConnectorToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function atomicWrite(filePath: string, data: StoreSnapshot): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class JsonStore {
  private data: StoreSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(data: StoreSnapshot, private readonly filePath: string | null, private readonly refreshFromDisk: boolean) {
    this.data = data;
  }

  static async open(filePath: string | null, refreshFromDisk = true): Promise<JsonStore> {
    if (!filePath) return new JsonStore(emptyStore(), null, refreshFromDisk);
    const result = await readStoreFile(filePath, true);
    // Persist migrations through the same write/fsync/rename path as normal
    // mutations so a v1 file is never partially rewritten in place.
    if (result.migrated) await atomicWrite(filePath, result.data);
    return new JsonStore(result.data, filePath, refreshFromDisk);
  }

  get ready(): boolean { return !this.closed; }
  get persistent(): boolean { return this.filePath !== null; }

  private async reloadFromDisk(): Promise<void> {
    if (!this.filePath) return;
    // A missing file represents an empty store. Atomic replacement means readers
    // never observe partial JSON; malformed existing files still fail closed.
    const result = await readStoreFile(this.filePath, true);
    if (result.migrated) await atomicWrite(this.filePath, result.data);
    this.data = result.data;
  }

  private async refresh(): Promise<void> {
    if (!this.refreshFromDisk || !this.filePath) return;
    if (this.closed) throw new Error('Store is closed');
    const result = this.queue.then(() => this.reloadFromDisk());
    this.queue = result.catch(() => undefined);
    await result;
  }

  private mutate<T>(operation: (draft: StoreSnapshot) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Store is closed'));
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('Store is closed');
      if (this.refreshFromDisk) await this.reloadFromDisk();
      const draft = clone(this.data);
      const value = operation(draft);
      if (this.filePath) await atomicWrite(this.filePath, draft);
      this.data = draft;
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async listConnectors(): Promise<PublicConnector[]> {
    await this.refresh();
    return this.data.connectors.map(publicConnector);
  }

  async getConnector(id: string): Promise<PublicConnector | null> {
    await this.refresh();
    const connector = this.data.connectors.find((item) => item.id === id);
    return connector ? publicConnector(connector) : null;
  }

  async getConnectorRecord(id: string): Promise<ConnectorRecord | null> {
    await this.refresh();
    const connector = this.data.connectors.find((item) => item.id === id);
    return connector ? clone(connector) : null;
  }

  async findByToken(token: string): Promise<ConnectorRecord | null> {
    await this.refresh();
    if (!/^st_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const candidate = Buffer.from(hashConnectorToken(token), 'hex');
    for (const connector of this.data.connectors) {
      const stored = Buffer.from(connector.tokenHash, 'hex');
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return clone(connector);
    }
    return null;
  }

  async createConnector(input: { name: string; upstreamUrl: string; orgId: string | null }, token: string): Promise<ConnectorRecord> {
    if (!orgIdSchema.safeParse(input.orgId).success) throw new Error('Invalid connector organization ID');
    return this.mutate((draft) => {
      const now = new Date().toISOString();
      const connector: ConnectorRecord = {
        id: randomUUID(), name: input.name, upstreamUrl: input.upstreamUrl, orgId: input.orgId,
        tokenHash: hashConnectorToken(token), enabled: true, createdAt: now, updatedAt: now,
      };
      draft.connectors.push(connector);
      return clone(connector);
    });
  }

  async updateConnector(id: string, patch: Partial<Pick<ConnectorRecord, 'name' | 'upstreamUrl' | 'enabled'>>): Promise<ConnectorRecord | null> {
    return this.mutate((draft) => {
      const connector = draft.connectors.find((item) => item.id === id);
      if (!connector) return null;
      Object.assign(connector, patch, { updatedAt: new Date().toISOString() });
      return clone(connector);
    });
  }

  async rotateConnectorToken(id: string, token: string): Promise<ConnectorRecord | null> {
    return this.mutate((draft) => {
      const connector = draft.connectors.find((item) => item.id === id);
      if (!connector) return null;
      connector.tokenHash = hashConnectorToken(token);
      connector.updatedAt = new Date().toISOString();
      return clone(connector);
    });
  }

  async deleteConnector(id: string): Promise<boolean> {
    return this.mutate((draft) => {
      const index = draft.connectors.findIndex((item) => item.id === id);
      if (index < 0) return false;
      draft.connectors.splice(index, 1);
      return true;
    });
  }

  async listRoutes(): Promise<RouteRecord[]> {
    await this.refresh();
    return clone(this.data.routes);
  }

  async getRoute(id: string): Promise<RouteRecord | null> {
    await this.refresh();
    const route = this.data.routes.find((item) => item.id === id);
    return route ? clone(route) : null;
  }

  async createRoute(input: Omit<RouteRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<RouteRecord> {
    return this.mutate((draft) => {
      const now = new Date().toISOString();
      const route: RouteRecord = { ...clone(input), id: randomUUID(), createdAt: now, updatedAt: now };
      draft.routes.push(route);
      return clone(route);
    });
  }

  async updateRoute(id: string, patch: Partial<Omit<RouteRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<RouteRecord | null> {
    return this.mutate((draft) => {
      const route = draft.routes.find((item) => item.id === id);
      if (!route) return null;
      Object.assign(route, patch, { updatedAt: new Date().toISOString() });
      return clone(route);
    });
  }

  async deleteRoute(id: string): Promise<boolean> {
    return this.mutate((draft) => {
      const index = draft.routes.findIndex((item) => item.id === id);
      if (index < 0) return false;
      draft.routes.splice(index, 1);
      return true;
    });
  }

  async routesForConnector(connectorId: string): Promise<RouteRecord[]> {
    await this.refresh();
    return clone(this.data.routes.filter((route) => route.connectorId === connectorId));
  }

  async matchRoute(hostname: string, pathname: string): Promise<RouteRecord | null> {
    await this.refresh();
    let best: RouteRecord | null = null;
    for (const route of this.data.routes) {
      if (!route.enabled || route.hostname !== hostname) continue;
      const matches = !route.pathPrefix || pathname === route.pathPrefix || pathname.startsWith(`${route.pathPrefix}/`);
      if (matches && (!best || route.pathPrefix.length > best.pathPrefix.length)) best = route;
    }
    return best ? clone(best) : null;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
