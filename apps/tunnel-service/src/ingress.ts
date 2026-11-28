// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import express, { type NextFunction, type Request, type Response } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerConfig } from './config';
import { TunnelError, sendError } from './errors';
import type { Logger } from './logger';
import { RouteRateLimiter } from './rate-limit';
import type { TunnelRegistry } from './registry';
import { JsonStore } from './store';
import { parseHostHeader, sanitizeRequestHeaders } from './validation';

export interface IngressOptions {
  store: JsonStore;
  registry: TunnelRegistry;
  config: ServerConfig;
  logger: Logger;
}

async function readRequestBody(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new TunnelError(413, 'request_too_large', 'Request body is too large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > limit) throw new TunnelError(413, 'request_too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function writeBody(res: Response, chunk: Buffer): Promise<void> {
  if (!chunk.length || res.destroyed) return;
  if (res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
    };
    const finish = (): void => { cleanup(); resolve(); };
    const onDrain = (): void => finish();
    const onClose = (): void => finish();
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}

function requestTarget(req: Request): { pathname: string; query: string } {
  if (!req.url.startsWith('/') || req.url.length > 16384 || /[\r\n\u0000]/.test(req.url)) {
    throw new TunnelError(400, 'invalid_request_target', 'Invalid request target');
  }
  const queryIndex = req.url.indexOf('?');
  return {
    pathname: queryIndex >= 0 ? req.url.slice(0, queryIndex) : req.url,
    query: queryIndex >= 0 ? req.url.slice(queryIndex) : '',
  };
}

export function createIngressApp(options: IngressOptions): express.Express {
  const { store, registry, config, logger } = options;
  const limiter = new RouteRateLimiter();
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'synapse-tunnel', component: 'ingress' }));
  app.get('/ready', (_req, res) => {
    if (!store.ready) return res.status(503).json({ status: 'not_ready', service: 'synapse-tunnel' });
    res.json({ status: 'ready', service: 'synapse-tunnel', storage: store.persistent ? 'json' : 'memory' });
  });

  app.use(async (req, res, next) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    let routeId: string | undefined;
    let connectorId: string | undefined;
    let hostname: string | undefined;
    let responseBytes = 0;
    res.once('finish', () => {
      logger.info('ingress_request', { requestId, method: req.method, status: res.statusCode, responseBytes, routeId: routeId ?? null, connectorId: connectorId ?? null, hostname: hostname ?? null });
    });
    try {
      let hostHeader: string;
      let parsedHostname: string;
      try {
        hostHeader = req.headers.host ?? '';
        parsedHostname = parseHostHeader(hostHeader);
        hostname = parsedHostname;
      } catch {
        throw new TunnelError(404, 'unknown_host', 'No tunnel route matches this host');
      }
      const { pathname, query } = requestTarget(req);
      const route = await store.matchRoute(parsedHostname, pathname);
      if (!route) throw new TunnelError(404, 'unknown_host', 'No tunnel route matches this host');
      routeId = route.id;
      connectorId = route.connectorId;
      const clientKey = (config.trustProxy ? req.ip : req.socket.remoteAddress) ?? 'unknown';
      const limit = route.rateLimitPerMinute ?? config.defaultRateLimitPerMinute;
      const rate = limiter.check(route.id, clientKey, limit);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        throw new TunnelError(429, 'rate_limited', 'Route rate limit exceeded');
      }
      const body = await readRequestBody(req, config.maxRequestBytes);
      const headers = sanitizeRequestHeaders(req.headers);
      headers['x-forwarded-host'] = [hostHeader];
      headers['x-forwarded-proto'] = [config.publicScheme];
      headers['x-forwarded-for'] = [clientKey];
      headers['x-real-ip'] = [clientKey];
      headers['x-request-id'] = [requestId];
      let upstreamPath = pathname;
      if (route.pathPrefix) upstreamPath = pathname === route.pathPrefix ? '/' : pathname.slice(route.pathPrefix.length);
      const dispatched = await registry.dispatch(route.connectorId, route, {
        method: req.method,
        path: `${upstreamPath}${query}`,
        headers,
        body,
        timeoutMs: route.timeoutMs ?? config.requestTimeoutMs,
        maxResponseBytes: route.maxResponseBytes ?? config.maxResponseBytes,
        onBody: async (chunk, error) => {
          if (error) {
            res.destroy();
            return;
          }
          responseBytes += chunk.length;
          await writeBody(res, chunk);
        },
      });
      res.statusCode = dispatched.head.status;
      for (const [name, values] of Object.entries(dispatched.head.headers)) res.setHeader(name, values);
      res.flushHeaders();
      dispatched.startBody();
      const onClose = (): void => { dispatched.abort(); };
      res.once('close', onClose);
      try {
        await dispatched.done;
      } finally {
        res.off('close', onClose);
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'No tunnel route matches this host' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, error));
  return app;
}

function rejectUpgrade(socket: Duplex, status: number, wwwAuthenticate = false): void {
  const extra = wwwAuthenticate ? 'WWW-Authenticate: Bearer\r\n' : '';
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachTunnelWebSocket(server: HttpServer, options: IngressOptions): WebSocketServer {
  const { store, registry, config, logger } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.wsMaxPayloadBytes,
    perMessageDeflate: false,
    clientTracking: false,
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head) => {
    void (async () => {
      try {
        let pathname: string;
        try { pathname = new URL(req.url ?? '/', 'http://ingress').pathname; } catch { rejectUpgrade(socket, 404); return; }
        if (pathname !== config.wsPath) { rejectUpgrade(socket, 404); return; }
        // This is a machine-to-machine protocol, not a browser WebSocket API.
        if (req.headers.origin !== undefined) { rejectUpgrade(socket, 403); return; }
        const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
        const connector = match ? await store.findByToken(match[1]) : null;
        if (!connector?.enabled) { rejectUpgrade(socket, 401, true); return; }
        wss.handleUpgrade(req, socket, head, (ws) => registry.register(ws, connector));
      } catch (error) {
        logger.error('websocket_upgrade_failed', { code: error instanceof Error ? error.name : 'unknown_error' });
        rejectUpgrade(socket, 404);
      }
    })();
  });
  return wss;
}
