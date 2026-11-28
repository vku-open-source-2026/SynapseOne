// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { createControlApp } from './api';
import { loadServerConfig, type ServerConfig, type ServerMode } from './config';
import { attachTunnelWebSocket, createIngressApp } from './ingress';
import { createLogger, type Logger } from './logger';
import { TunnelRegistry } from './registry';
import { JsonStore } from './store';

export interface TunnelService {
  config: ServerConfig;
  store: JsonStore;
  registry: TunnelRegistry;
  logger: Logger;
  apiServer?: HttpServer;
  ingressServer?: HttpServer;
  apiUrl?: string;
  ingressUrl?: string;
  close: () => Promise<void>;
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function serverUrl(server: HttpServer): string {
  const address = server.address() as AddressInfo;
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 10000);
    timer.unref();
    server.close(() => { clearTimeout(timer); resolve(); });
  });
}

export async function startTunnelService(config: ServerConfig): Promise<TunnelService> {
  const logger = createLogger(config.logLevel, 'server');
  const store = await JsonStore.open(config.dataFile, config.mode !== 'combined');
  const registry = new TunnelRegistry(store, config, logger);
  let apiServer: HttpServer | undefined;
  let ingressServer: HttpServer | undefined;
  let closing: Promise<void> | undefined;
  try {
    if (config.mode !== 'ingress') {
      const app = createControlApp({ store, registry, config, logger });
      apiServer = require('http').createServer(app) as HttpServer;
      apiServer.requestTimeout = 65000;
      apiServer.headersTimeout = 15000;
      await listen(apiServer, config.apiPort, config.host);
    }
    if (config.mode !== 'api') {
      const options = { store, registry, config, logger };
      const app = createIngressApp(options);
      ingressServer = require('http').createServer(app) as HttpServer;
      ingressServer.requestTimeout = 0;
      ingressServer.headersTimeout = 15000;
      attachTunnelWebSocket(ingressServer, options);
      await listen(ingressServer, config.ingressPort, config.host);
    }
  } catch (error) {
    registry.close();
    if (ingressServer) await closeHttpServer(ingressServer);
    if (apiServer) await closeHttpServer(apiServer);
    await store.close();
    throw error;
  }
  logger.info('service_started', {
    mode: config.mode,
    apiPort: apiServer ? (apiServer.address() as AddressInfo).port : null,
    ingressPort: ingressServer ? (ingressServer.address() as AddressInfo).port : null,
    storage: store.persistent ? 'json' : 'memory',
  });
  return {
    config, store, registry, logger, apiServer, ingressServer,
    apiUrl: apiServer ? serverUrl(apiServer) : undefined,
    ingressUrl: ingressServer ? serverUrl(ingressServer) : undefined,
    close: () => {
      if (!closing) {
        closing = (async () => {
          logger.info('service_stopping');
          registry.close();
          if (ingressServer) await closeHttpServer(ingressServer);
          if (apiServer) await closeHttpServer(apiServer);
          await store.close();
          logger.info('service_stopped');
        })();
      }
      return closing;
    },
  };
}

export async function runEntrypoint(mode: ServerMode): Promise<void> {
  const config = loadServerConfig(mode);
  const service = await startTunnelService(config);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await service.close();
}
