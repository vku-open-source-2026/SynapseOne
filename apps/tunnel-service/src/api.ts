// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, type ZodType } from 'zod';
import type { ServerConfig } from './config';
import { TunnelError, sendError } from './errors';
import type { Logger } from './logger';
import type { TunnelRegistry } from './registry';
import { JsonStore } from './store';
import type { ConnectorRecord, ManagementPrincipal, PublicConnector, RouteRecord } from './types';
import { connectorCreateSchema, connectorUpdateSchema, routeCreateSchema, routeUpdateSchema } from './validation';

export interface ControlAppOptions {
  store: JsonStore;
  registry: TunnelRegistry;
  config: ServerConfig;
  logger: Logger;
}

const ORG_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function authenticateManagement(config: ServerConfig, req: Request, res: Response, next: NextFunction): void {
  const authorization = singleHeader(req.headers.authorization) ?? '';
  const match = /^Bearer (.+)$/.exec(authorization);
  if (config.adminToken && match && secureEqual(match[1], config.adminToken)) {
    res.locals.principal = { orgId: null } satisfies ManagementPrincipal;
    return next();
  }

  const internalSecret = config.internalSecret?.trim() ? config.internalSecret : undefined;
  if (!internalSecret) {
    res.status(503).json({
      error: 'internal_auth_unavailable',
      message: 'Internal management authentication is not configured',
    });
    return;
  }

  const suppliedSecret = singleHeader(req.headers['x-synapseone-internal']);
  if (!suppliedSecret || !secureEqual(suppliedSecret, internalSecret)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({
      error: 'unauthorized',
      message: 'A valid admin bearer token or internal gateway credential is required',
    });
    return;
  }

  // Service-account principals may have no direct organization. The gateway
  // stamps their verified attribution separately; either header is usable only
  // after the shared internal credential has been validated.
  const orgId = singleHeader(req.headers['x-synapseone-org']) || singleHeader(req.headers['x-synapseone-owner-org']);
  if (!orgId || !ORG_ID_PATTERN.test(orgId)) {
    res.status(403).json({
      error: 'forbidden',
      message: 'A valid organization header is required',
    });
    return;
  }

  res.locals.principal = { orgId } satisfies ManagementPrincipal;
  next();
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    throw new TunnelError(400, 'validation_error', `Invalid ${field}: ${issue?.message ?? 'invalid value'}`);
  }
  return result.data;
}

function principal(res: Response): ManagementPrincipal {
  const value = res.locals.principal as ManagementPrincipal | undefined;
  if (!value) throw new TunnelError(401, 'unauthorized', 'Authentication is required');
  return value;
}

function canAccess(principal: ManagementPrincipal, connector: Pick<ConnectorRecord, 'orgId'>): boolean {
  return principal.orgId === null || connector.orgId === principal.orgId;
}

async function ownedConnector(store: JsonStore, id: string, principal: ManagementPrincipal): Promise<ConnectorRecord> {
  const connector = await store.getConnectorRecord(id);
  if (!connector || !canAccess(principal, connector)) {
    throw new TunnelError(404, 'connector_not_found', 'Connector not found');
  }
  return connector;
}

async function ownedRoute(store: JsonStore, id: string, principal: ManagementPrincipal): Promise<RouteRecord> {
  const route = await store.getRoute(id);
  if (!route) throw new TunnelError(404, 'route_not_found', 'Route not found');
  const connector = await store.getConnectorRecord(route.connectorId);
  if (!connector || !canAccess(principal, connector)) {
    throw new TunnelError(404, 'route_not_found', 'Route not found');
  }
  return route;
}

async function visibleRoutes(store: JsonStore, principal: ManagementPrincipal): Promise<RouteRecord[]> {
  const [connectors, routes] = await Promise.all([store.listConnectors(), store.listRoutes()]);
  if (principal.orgId === null) return routes;
  const connectorIds = new Set(connectors.filter((connector) => connector.orgId === principal.orgId).map((connector) => connector.id));
  return routes.filter((route) => connectorIds.has(route.connectorId));
}

function withStatus(connector: PublicConnector, registry: TunnelRegistry): PublicConnector & { connected: boolean; connectedAt?: string } {
  return { ...connector, ...registry.status(connector.id) };
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => { void handler(req, res).catch(next); };
}

export function createControlApp(options: ControlAppOptions): express.Express {
  const { store, registry, config, logger } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'synapse-tunnel', component: 'control-plane' });
  });
  app.get('/ready', (_req, res) => {
    if (!store.ready) return res.status(503).json({ status: 'not_ready', service: 'synapse-tunnel' });
    res.json({ status: 'ready', service: 'synapse-tunnel', storage: store.persistent ? 'json' : 'memory' });
  });

  app.use('/v1', (req, res, next) => authenticateManagement(config, req, res, next));

  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/v1/config', (_req, res) => {
    res.json({
      publicOrigin: config.publicOrigin || null,
      connectorPath: config.wsPath,
      protocolVersion: 1,
    });
  });

  app.get('/v1/connectors', asyncRoute(async (_req, res) => {
    const caller = principal(res);
    const connectors = (await store.listConnectors()).filter((connector) => canAccess(caller, connector));
    res.json({ connectors: connectors.map((connector) => withStatus(connector, registry)) });
  }));

  app.post('/v1/connectors', asyncRoute(async (req, res) => {
    const input = parseBody(connectorCreateSchema, req.body);
    const token = `st_${randomBytes(32).toString('base64url')}`;
    const connector = await store.createConnector({ ...input, orgId: principal(res).orgId }, token);
    const { tokenHash: _tokenHash, ...safe } = connector;
    logger.info('connector_created', { connectorId: connector.id });
    res.status(201).json({ connector: withStatus(safe, registry), token });
  }));

  app.get('/v1/connectors/:id', asyncRoute(async (req, res) => {
    const connector = await ownedConnector(store, req.params.id, principal(res));
    const { tokenHash: _tokenHash, ...safe } = connector;
    res.json({ connector: withStatus(safe, registry) });
  }));

  app.patch('/v1/connectors/:id', asyncRoute(async (req, res) => {
    const caller = principal(res);
    await ownedConnector(store, req.params.id, caller);
    const patch = parseBody(connectorUpdateSchema, req.body);
    const connector = await store.updateConnector(req.params.id, patch);
    if (!connector) throw new TunnelError(404, 'connector_not_found', 'Connector not found');
    if (patch.upstreamUrl !== undefined || patch.enabled === false) registry.disconnect(connector.id);
    const { tokenHash: _tokenHash, ...safe } = connector;
    res.json({ connector: withStatus(safe, registry) });
  }));

  app.delete('/v1/connectors/:id', asyncRoute(async (req, res) => {
    const caller = principal(res);
    await ownedConnector(store, req.params.id, caller);
    if ((await store.routesForConnector(req.params.id)).length > 0) {
      throw new TunnelError(409, 'connector_in_use', 'Delete the connector routes before deleting the connector');
    }
    await store.deleteConnector(req.params.id);
    registry.disconnect(req.params.id);
    logger.info('connector_deleted', { connectorId: req.params.id });
    res.status(204).end();
  }));

  app.get('/v1/routes', asyncRoute(async (_req, res) => {
    res.json({ routes: await visibleRoutes(store, principal(res)) });
  }));

  app.post('/v1/routes', asyncRoute(async (req, res) => {
    const caller = principal(res);
    const input = parseBody(routeCreateSchema, req.body);
    const connector = await ownedConnector(store, input.connectorId, caller);
    if (!connector.enabled) throw new TunnelError(409, 'connector_disabled', 'Connector is disabled');
    if ((await store.listRoutes()).some((route) => route.hostname === input.hostname && route.pathPrefix === (input.pathPrefix ?? ''))) {
      throw new TunnelError(409, 'route_exists', 'A route already exists for this hostname and path prefix');
    }
    const route = await store.createRoute({
      name: input.name ?? `${input.hostname}${input.pathPrefix ?? ''}`,
      hostname: input.hostname,
      pathPrefix: input.pathPrefix ?? '',
      connectorId: input.connectorId,
      enabled: input.enabled ?? true,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      rateLimitPerMinute: input.rateLimitPerMinute,
    });
    logger.info('route_created', { routeId: route.id, connectorId: route.connectorId });
    res.status(201).json({ route });
  }));

  app.get('/v1/routes/:id', asyncRoute(async (req, res) => {
    res.json({ route: await ownedRoute(store, req.params.id, principal(res)) });
  }));

  app.patch('/v1/routes/:id', asyncRoute(async (req, res) => {
    const caller = principal(res);
    const existing = await ownedRoute(store, req.params.id, caller);
    const patch = parseBody(routeUpdateSchema, req.body);
    if (patch.connectorId) {
      const connector = await ownedConnector(store, patch.connectorId, caller);
      if (!connector.enabled) throw new TunnelError(409, 'connector_disabled', 'Connector is disabled');
    }
    const candidate = { ...existing, ...patch };
    if ((await store.listRoutes()).some((route) => route.id !== existing.id && route.hostname === candidate.hostname && route.pathPrefix === candidate.pathPrefix)) {
      throw new TunnelError(409, 'route_exists', 'A route already exists for this hostname and path prefix');
    }
    const route = await store.updateRoute(req.params.id, patch);
    if (!route) throw new TunnelError(404, 'route_not_found', 'Route not found');
    res.json({ route });
  }));

  app.delete('/v1/routes/:id', asyncRoute(async (req, res) => {
    await ownedRoute(store, req.params.id, principal(res));
    await store.deleteRoute(req.params.id);
    res.status(204).end();
  }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { type?: string })?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request_too_large', message: 'Management request body is too large' });
    }
    if ((error as { type?: string })?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON' });
    }
    if (!(error instanceof TunnelError)) logger.error('control_request_failed', { code: 'internal_error' });
    sendError(res, error);
  });
  return app;
}
