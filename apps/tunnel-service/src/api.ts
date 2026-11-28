// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { type ZodType } from 'zod';
import {
  DEFAULT_BASE_DOMAIN,
  DEFAULT_MAX_DOMAINS_PER_ORG,
  DEFAULT_UNLIMITED_ORG_IDS,
  type ServerConfig,
} from './config';
import { TunnelError, sendError } from './errors';
import type { Logger } from './logger';
import type { TunnelRegistry } from './registry';
import { JsonStore } from './store';
import type { ConnectorRecord, DomainQuota, ManagementPrincipal, PublicConnector, RouteRecord } from './types';
import {
  connectorCreateSchema,
  connectorUpdateSchema,
  normalizeSubdomainLabel,
  quickTunnelSchema,
  routeCreateSchema,
  routeUpdateSchema,
  validateManagedDomainHostname,
} from './validation';

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

function resolveBaseDomain(config: ServerConfig): string {
  return config.baseDomain ?? DEFAULT_BASE_DOMAIN;
}

function resolveMaxDomainsPerOrg(config: ServerConfig): number {
  return config.maxDomainsPerOrg ?? DEFAULT_MAX_DOMAINS_PER_ORG;
}

function resolveUnlimitedOrgIds(config: ServerConfig): string[] {
  return config.unlimitedOrgIds ?? DEFAULT_UNLIMITED_ORG_IDS;
}

function isUnlimitedOrg(caller: ManagementPrincipal, config: ServerConfig): boolean {
  return caller.orgId === null || resolveUnlimitedOrgIds(config).includes(caller.orgId);
}

async function computeDomainQuota(store: JsonStore, caller: ManagementPrincipal, config: ServerConfig): Promise<DomainQuota> {
  const [connectors, routes] = await Promise.all([store.listConnectors(), store.listRoutes()]);
  const ownedIds = new Set(
    connectors
      .filter((connector) => canAccess(caller, connector))
      .map((connector) => connector.id),
  );
  const domainSet = new Set<string>();
  for (const route of routes) {
    if (ownedIds.has(route.connectorId)) domainSet.add(route.hostname);
  }
  const domains = Array.from(domainSet).sort();
  const unlimited = isUnlimitedOrg(caller, config);
  const maxDomains = unlimited ? null : resolveMaxDomainsPerOrg(config);
  const remainingDomains = unlimited || maxDomains === null ? null : Math.max(0, maxDomains - domains.length);
  return {
    orgId: caller.orgId,
    baseDomain: resolveBaseDomain(config),
    usedDomains: domains.length,
    maxDomains,
    remainingDomains,
    unlimited,
    domains,
  };
}

function resolveRouteHostname(hostnameInput: string | undefined, subdomainInput: string | undefined, config: ServerConfig): string {
  const baseDomain = resolveBaseDomain(config);
  let resolved = hostnameInput;
  if (subdomainInput !== undefined) {
    let label: string;
    try {
      label = normalizeSubdomainLabel(subdomainInput, baseDomain);
    } catch (error) {
      throw new TunnelError(400, 'invalid_subdomain', error instanceof Error ? error.message : 'Invalid subdomain');
    }
    const candidate = `${label}.${baseDomain}`;
    if (resolved && resolved !== candidate) {
      throw new TunnelError(400, 'validation_error', 'Conflicting hostname and subdomain values');
    }
    resolved = candidate;
  }
  if (!resolved) {
    throw new TunnelError(400, 'validation_error', 'Either hostname or subdomain is required');
  }
  try {
    validateManagedDomainHostname(resolved, baseDomain);
  } catch (error) {
    throw new TunnelError(400, 'invalid_subdomain', error instanceof Error ? error.message : 'Invalid subdomain');
  }
  return resolved;
}

async function assertDomainAllowed(
  store: JsonStore,
  caller: ManagementPrincipal,
  config: ServerConfig,
  hostname: string,
  ignoreRouteId?: string,
): Promise<void> {
  const [connectors, routes] = await Promise.all([store.listConnectors(), store.listRoutes()]);
  const connectorOrgById = new Map<string, string | null>(connectors.map((connector) => [connector.id, connector.orgId]));
  const ownedDomains = new Set<string>();
  for (const route of routes) {
    if (route.id === ignoreRouteId) continue;
    const ownerOrgId = connectorOrgById.get(route.connectorId) ?? null;
    if (route.hostname === hostname && caller.orgId !== null && ownerOrgId !== caller.orgId) {
      throw new TunnelError(409, 'hostname_taken', 'This domain or subdomain is already claimed by another organization');
    }
    if (caller.orgId !== null && ownerOrgId === caller.orgId) {
      ownedDomains.add(route.hostname);
    }
  }
  if (caller.orgId !== null && !isUnlimitedOrg(caller, config)) {
    const maxDomains = resolveMaxDomainsPerOrg(config);
    if (!ownedDomains.has(hostname) && ownedDomains.size >= maxDomains) {
      throw new TunnelError(
        409,
        'domain_limit_exceeded',
        `Organization domain limit reached (maximum ${maxDomains} domains per organization)`,
      );
    }
  }
}

function slugifyPrefix(value: string | undefined): string {
  const cleaned = (value ?? 'app')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return cleaned || 'app';
}

function buildPublicUrls(config: ServerConfig, hostname: string, pathPrefix: string): { publicUrl: string; serverUrl: string } {
  const baseDomain = resolveBaseDomain(config);
  const serverUrl = config.publicOrigin || `${config.publicScheme}://${baseDomain}`;
  let scheme = config.publicScheme;
  let port = '';
  if (config.publicOrigin) {
    const parsed = new URL(config.publicOrigin);
    scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    port = parsed.port ? `:${parsed.port}` : '';
  }
  return {
    publicUrl: `${scheme}://${hostname}${port}${pathPrefix}`,
    serverUrl,
  };
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

  app.get('/v1/config', asyncRoute(async (_req, res) => {
    const caller = principal(res);
    const quota = await computeDomainQuota(store, caller, config);
    res.json({
      publicOrigin: config.publicOrigin || null,
      connectorPath: config.wsPath,
      protocolVersion: 1,
      baseDomain: resolveBaseDomain(config),
      quota,
    });
  }));

  app.get('/v1/quota', asyncRoute(async (_req, res) => {
    const quota = await computeDomainQuota(store, principal(res), config);
    res.json(quota);
  }));

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

  app.post('/v1/connectors/:id/rotate-token', asyncRoute(async (req, res) => {
    const caller = principal(res);
    await ownedConnector(store, req.params.id, caller);
    const token = `st_${randomBytes(32).toString('base64url')}`;
    const connector = await store.rotateConnectorToken(req.params.id, token);
    if (!connector) throw new TunnelError(404, 'connector_not_found', 'Connector not found');
    registry.disconnect(connector.id);
    const { tokenHash: _tokenHash, ...safe } = connector;
    logger.info('connector_token_rotated', { connectorId: connector.id });
    res.json({ connector: withStatus(safe, registry), token });
  }));

  app.delete('/v1/connectors/:id', asyncRoute(async (req, res) => {
    const caller = principal(res);
    await ownedConnector(store, req.params.id, caller);
    const routes = await store.routesForConnector(req.params.id);
    const force = req.query.force === 'true' || req.query.force === '1';
    if (routes.length > 0 && !force) {
      throw new TunnelError(409, 'connector_in_use', 'Delete the connector routes before deleting the connector');
    }
    if (force) {
      for (const route of routes) {
        await store.deleteRoute(route.id);
      }
    }
    await store.deleteConnector(req.params.id);
    registry.disconnect(req.params.id);
    logger.info('connector_deleted', { connectorId: req.params.id, forced: force });
    res.status(204).end();
  }));

  app.get('/v1/routes', asyncRoute(async (_req, res) => {
    res.json({ routes: await visibleRoutes(store, principal(res)) });
  }));

  app.post('/v1/routes', asyncRoute(async (req, res) => {
    const caller = principal(res);
    const input = parseBody(routeCreateSchema, req.body);
    const hostname = resolveRouteHostname(input.hostname, input.subdomain, config);
    const pathPrefix = input.pathPrefix ?? '';
    const connector = await ownedConnector(store, input.connectorId, caller);
    if (!connector.enabled) throw new TunnelError(409, 'connector_disabled', 'Connector is disabled');
    await assertDomainAllowed(store, caller, config, hostname);
    if ((await store.listRoutes()).some((route) => route.hostname === hostname && route.pathPrefix === pathPrefix)) {
      throw new TunnelError(409, 'route_exists', 'A route already exists for this hostname and path prefix');
    }
    const route = await store.createRoute({
      name: input.name ?? `${hostname}${pathPrefix}`,
      hostname,
      pathPrefix,
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
    const { subdomain, ...restPatch } = patch;
    const hostname = (patch.hostname !== undefined || subdomain !== undefined)
      ? resolveRouteHostname(patch.hostname, subdomain, config)
      : existing.hostname;
    const candidate = { ...existing, ...restPatch, hostname };
    await assertDomainAllowed(store, caller, config, candidate.hostname, existing.id);
    if ((await store.listRoutes()).some((route) => route.id !== existing.id && route.hostname === candidate.hostname && route.pathPrefix === candidate.pathPrefix)) {
      throw new TunnelError(409, 'route_exists', 'A route already exists for this hostname and path prefix');
    }
    const route = await store.updateRoute(req.params.id, { ...restPatch, hostname });
    if (!route) throw new TunnelError(404, 'route_not_found', 'Route not found');
    res.json({ route });
  }));

  app.delete('/v1/routes/:id', asyncRoute(async (req, res) => {
    await ownedRoute(store, req.params.id, principal(res));
    await store.deleteRoute(req.params.id);
    res.status(204).end();
  }));

  const handleQuickProvision = asyncRoute(async (req, res) => {
    const caller = principal(res);
    const input = parseBody(quickTunnelSchema, req.body);
    const baseDomain = resolveBaseDomain(config);
    const pathPrefix = input.pathPrefix ?? '';
    const reuseExisting = input.reuseExisting ?? true;

    let hostname: string;
    if (input.hostname !== undefined || input.subdomain !== undefined) {
      hostname = resolveRouteHostname(input.hostname, input.subdomain, config);
    } else {
      const existingRoutes = await store.listRoutes();
      const taken = new Set(existingRoutes.map((route) => route.hostname));
      const prefix = slugifyPrefix(input.name);
      let candidate = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const suffix = randomBytes(3).toString('hex');
        const label = `${prefix}-${suffix}`;
        const host = `${label}.${baseDomain}`;
        if (!taken.has(host)) {
          candidate = host;
          break;
        }
      }
      if (!candidate) throw new TunnelError(503, 'subdomain_allocation_failed', 'Unable to allocate an unused subdomain');
      hostname = candidate;
    }

    const existingRoute = (await store.listRoutes()).find(
      (route) => route.hostname === hostname && route.pathPrefix === pathPrefix,
    );
    if (existingRoute) {
      const existingConnector = await store.getConnectorRecord(existingRoute.connectorId);
      if (!existingConnector || !canAccess(caller, existingConnector)) {
        throw new TunnelError(409, 'hostname_taken', 'This domain or subdomain is already claimed by another organization');
      }
      if (!reuseExisting) {
        throw new TunnelError(409, 'route_exists', 'A route already exists for this hostname and path prefix');
      }
      const token = `st_${randomBytes(32).toString('base64url')}`;
      await store.updateConnector(existingConnector.id, {
        ...(input.name ? { name: input.name } : {}),
        upstreamUrl: input.upstreamUrl,
        enabled: true,
      });
      const updated = await store.rotateConnectorToken(existingConnector.id, token);
      if (!updated) throw new TunnelError(404, 'connector_not_found', 'Connector not found');
      registry.disconnect(updated.id);
      const { tokenHash: _tokenHash, ...safe } = updated;
      const quota = await computeDomainQuota(store, caller, config);
      const urls = buildPublicUrls(config, existingRoute.hostname, existingRoute.pathPrefix);
      logger.info('quick_tunnel_reused', { connectorId: updated.id, routeId: existingRoute.id, hostname });
      res.status(200).json({
        connector: withStatus(safe, registry),
        route: existingRoute,
        token,
        ...urls,
        baseDomain,
        reused: true,
        quota,
      });
      return;
    }

    await assertDomainAllowed(store, caller, config, hostname);
    const token = `st_${randomBytes(32).toString('base64url')}`;
    const connectorName = input.name ?? hostname.split('.')[0] ?? hostname;
    const connector = await store.createConnector({
      name: connectorName,
      upstreamUrl: input.upstreamUrl,
      orgId: caller.orgId,
    }, token);
    let route: RouteRecord;
    try {
      route = await store.createRoute({
        name: connectorName,
        hostname,
        pathPrefix,
        connectorId: connector.id,
        enabled: true,
      });
    } catch (error) {
      await store.deleteConnector(connector.id).catch(() => undefined);
      throw error;
    }
    const { tokenHash: _tokenHash, ...safe } = connector;
    const quota = await computeDomainQuota(store, caller, config);
    const urls = buildPublicUrls(config, route.hostname, route.pathPrefix);
    logger.info('quick_tunnel_created', { connectorId: connector.id, routeId: route.id, hostname });
    res.status(201).json({
      connector: withStatus(safe, registry),
      route,
      token,
      ...urls,
      baseDomain,
      reused: false,
      quota,
    });
  });

  app.post('/v1/quick', handleQuickProvision);
  app.post('/v1/provision', handleQuickProvision);

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
