// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Server } from 'node:http';
import { createApp } from './api';
import { loadConfig, SERVICE_NAME, SERVICE_VERSION } from './config';
import { AuthoritativeDnsServer } from './dns-server';
import { ServiceError } from './errors';
import { JsonLogger } from './logger';
import { ZoneStore } from './store';

export { createApp } from './api';

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger(undefined, config.logLevel);
  const store = new ZoneStore({
    filePath: config.dataFile,
    memory: config.memoryStore,
    logger,
  });
  let dns: AuthoritativeDnsServer | undefined;
  let api: Server | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });
    const force = setTimeout(() => {
      logger.error('shutdown_timeout');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();
    try {
      if (api) {
        await new Promise<void>((resolveClosed) => {
          api!.close(() => resolveClosed());
          api!.closeIdleConnections();
        });
        api = undefined;
      }
      if (dns) await dns.close();
      await store.close();
      logger.info('shutdown_complete');
      clearTimeout(force);
    } catch (error) {
      logger.error('shutdown_failed', { error: error instanceof Error ? error.name : 'Error' });
      clearTimeout(force);
      process.exitCode = 1;
    }
  };

  const onSignal = (signal: string) => {
    void shutdown(signal).finally(() => {
      if (!process.exitCode) process.exit(0);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  try {
    await store.initialize();
    dns = new AuthoritativeDnsServer(store, { host: config.dnsHost, port: config.dnsPort }, logger);
    const dnsAddresses = await dns.listen();
    if (shuttingDown) {
      await dns.close();
      await store.close();
      return;
    }
    const app = createApp({
      store,
      config,
      logger,
      isReady: () => !shuttingDown && store.isHealthy && (dns?.ready ?? false),
    });
    api = await new Promise<Server>((resolveListening, reject) => {
      const server = app.listen(config.apiPort, config.apiHost, () => resolveListening(server));
      server.once('error', reject);
    });
    if (shuttingDown) {
      await new Promise<void>((resolveClosed) => api!.close(() => resolveClosed()));
      api = undefined;
      await dns.close();
      await store.close();
      return;
    }
    const apiAddress = api.address();
    logger.info('service_started', {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      production: config.production,
      store: config.memoryStore ? 'memory' : 'persistent',
      dns: `${dnsAddresses.udp.address}:${dnsAddresses.udp.port}/udp, ${dnsAddresses.tcp.address}:${dnsAddresses.tcp.port}/tcp`,
      api: apiAddress && typeof apiAddress !== 'string' ? `${apiAddress.address}:${apiAddress.port}` : undefined,
    });
  } catch (error) {
    logger.error('startup_failed', {
      error: error instanceof Error ? error.name : 'Error',
      code: error instanceof ServiceError ? error.code : undefined,
      message: error instanceof Error ? error.message : undefined,
    });
    if (dns) await dns.close().catch(() => undefined);
    if (api) await new Promise<void>((resolveClosed) => api!.close(() => resolveClosed())).catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const logger = new JsonLogger();
    logger.error('startup_failed', {
      error: error instanceof Error ? error.name : 'Error',
      code: error instanceof ServiceError ? error.code : undefined,
      message: error instanceof Error ? error.message : undefined,
    });
    process.exitCode = 1;
  });
}
