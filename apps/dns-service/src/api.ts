// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { timingSafeEqual, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { SERVICE_NAME, SERVICE_VERSION, type ServiceConfig } from './config';
import { notFound, ServiceError } from './errors';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import type { ZoneStore } from './store';
import type { CreateZoneInput, Principal, RecordInput } from './types';
import { isValidOrgId, normalizeZoneName, parseRecordPatch } from './validation';

export interface CreateAppOptions {
  store: ZoneStore;
  config: ServiceConfig;
  logger?: Logger;
  isReady?: () => boolean;
}

const RECORD_ID = z.string().uuid();
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type AuthenticatedRequest = Request & { principal: Principal };

function principal(req: Request): Principal {
  const value = (req as AuthenticatedRequest).principal;
  if (!value) throw new ServiceError(401, 'unauthorized', 'Authentication is required');
  return value;
}

function requireZone(store: ZoneStore, name: string, orgId: string | null) {
  const zone = store.getZone(name, orgId);
  if (!zone) notFound('Zone');
  return zone;
}

function recordId(value: string): string {
  const parsed = RECORD_ID.safeParse(value);
  if (!parsed.success) throw new ServiceError(400, 'validation_error', 'recordId must be a UUID');
  return parsed.data;
}

function tokenMatches(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function hasGatewayHeaders(req: Request): boolean {
  return Object.keys(req.headers).some((name) => name.startsWith('x-synapseone-'));
}

function managementAuth(config: ServiceConfig): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const authorization = singleHeader(req, 'authorization');
    const bearer = typeof authorization === 'string' ? /^Bearer[ \t]+(.+)$/i.exec(authorization) : undefined;
    if (config.adminToken && bearer && tokenMatches(bearer[1], config.adminToken)) {
      // A direct platform-admin credential always wins over gateway identity headers.
      (req as AuthenticatedRequest).principal = { orgId: null };
      next();
      return;
    }

    const gatewayAuthenticated = hasGatewayHeaders(req);
    if (!config.adminToken && config.allowInsecure && !gatewayAuthenticated) {
      // Preserve the explicit non-production direct API opt-in.
      (req as AuthenticatedRequest).principal = { orgId: null };
      next();
      return;
    }
    if (!config.internalSecret) {
      if (gatewayAuthenticated) {
        throw new ServiceError(503, 'internal_auth_unavailable', 'Internal gateway authentication is not configured');
      }
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new ServiceError(401, 'unauthorized', 'A valid admin bearer token is required');
    }

    const internal = singleHeader(req, 'x-synapseone-internal');
    if (!internal || !tokenMatches(internal, config.internalSecret)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new ServiceError(401, 'unauthorized', 'A valid admin bearer token or internal gateway credential is required');
    }
    // Service-account principals may have no principal.org; the gateway then
    // supplies their verified attribution organization as owner-org instead.
    const orgId = singleHeader(req, 'x-synapseone-org') || singleHeader(req, 'x-synapseone-owner-org');
    if (!orgId || !isValidOrgId(orgId)) {
      throw new ServiceError(403, 'forbidden', 'A valid organization ID is required');
    }
    (req as AuthenticatedRequest).principal = { orgId };
    next();
  };
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createApp(options: CreateAppOptions): express.Express {
  const { store, config } = options;
  const logger = options.logger ?? silentLogger;
  const isReady = options.isReady ?? (() => store.isHealthy);
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('http_request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      });
    });
    next();
  });

  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, version: SERVICE_VERSION });
  });

  app.get('/ready', (_req, res) => {
    const ready = isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      service: SERVICE_NAME,
      store: config.memoryStore ? 'memory' : 'persistent',
      dns: ready ? 'listening' : 'starting',
    });
  });

  app.use('/v1', managementAuth(config));

  app.get('/v1/zones', (req, res) => {
    res.json({ zones: store.listZones(principal(req).orgId) });
  });

  app.post('/v1/zones', asyncRoute(async (req, res) => {
    const zone = await store.createZone(req.body as CreateZoneInput, principal(req).orgId);
    res.status(201).location(`/v1/zones/${encodeURIComponent(zone.name)}`).json(zone);
  }));

  app.get('/v1/zones/:zone', (req, res) => {
    res.json(requireZone(store, req.params.zone, principal(req).orgId));
  });

  app.delete('/v1/zones/:zone', asyncRoute(async (req, res) => {
    await store.deleteZone(req.params.zone, principal(req).orgId);
    res.status(204).end();
  }));

  app.get('/v1/zones/:zone/records', (req, res) => {
    res.json({ records: requireZone(store, req.params.zone, principal(req).orgId).records });
  });

  app.post('/v1/zones/:zone/records', asyncRoute(async (req, res) => {
    const owner = principal(req).orgId;
    requireZone(store, req.params.zone, owner);
    const record = await store.createRecord(req.params.zone, req.body as RecordInput, owner);
    const zoneName = normalizeZoneName(req.params.zone);
    res.status(201).location(`/v1/zones/${encodeURIComponent(zoneName)}/records/${record.id}`).json(record);
  }));

  app.patch('/v1/zones/:zone/records/:recordId', asyncRoute(async (req, res) => {
    const owner = principal(req).orgId;
    requireZone(store, req.params.zone, owner);
    const patch = parseRecordPatch(req.body);
    const record = await store.patchRecord(req.params.zone, recordId(req.params.recordId), patch, owner);
    res.json(record);
  }));

  app.delete('/v1/zones/:zone/records/:recordId', asyncRoute(async (req, res) => {
    const owner = principal(req).orgId;
    requireZone(store, req.params.zone, owner);
    await store.deleteRecord(req.params.zone, recordId(req.params.recordId), owner);
    res.status(204).end();
  }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Route not found', requestId: res.locals.requestId });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId;
    if (error instanceof ServiceError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        requestId,
      });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON', requestId });
      return;
    }
    if ((error as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds 32 KiB', requestId });
      return;
    }
    logger.error('http_request_failed', { requestId, error: error instanceof Error ? error.name : 'Error' });
    res.status(500).json({ error: 'internal_error', message: 'Internal server error', requestId });
  });

  return app;
}

