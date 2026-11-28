#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import WebSocket from 'ws';
import { loadConnectorConfig, type ConnectorConfig } from './config';
import { createLogger, type Logger } from './logger';
import {
  BODY_CHUNK_BYTES, PROTOCOL_VERSION, ProtocolError, decodeBody, encodeBody,
  headerMapFromHeaders, parseServerMessage, type ServerMessage,
} from './protocol';
import { createSocketSender, type SocketSender } from './socket-sender';
import type { HeaderMap } from './types';
import { normalizeUpstreamUrl, sanitizeRequestHeaders, sanitizeResponseHeaders } from './validation';

interface Limits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrentRequests: number;
}

interface ActiveRequest {
  requestId: string;
  method: string;
  path: string;
  headers: HeaderMap;
  maxResponseBytes: number;
  bodyLength: number;
  body: Buffer[];
  bodyBytes: number;
  complete: boolean;
  started: boolean;
  aborted: boolean;
  controller: AbortController;
  timer: NodeJS.Timeout;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function websocketUrl(config: ConnectorConfig): string {
  const base = new URL(config.serverUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(config.wsPath, base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function upstreamTarget(upstream: string, requestPath: string): string {
  const base = new URL(upstream);
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  // Concatenate onto the origin instead of resolving a scheme-relative path;
   // an incoming path beginning with // must never select a different host.
  return new URL(`${base.origin}${basePath}${requestPath}`).href;
}

function requestHeaders(input: HeaderMap, upstream: URL): Headers {
  const raw: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(input)) raw[name] = values;
  const safe = sanitizeRequestHeaders(raw, true);
  const headers = new Headers();
  for (const [name, values] of Object.entries(safe)) for (const value of values) headers.append(name, value);
  headers.set('host', upstream.host);
  // Node fetch transparently decodes compressed bodies. Request identity
  // encoding and normalize response transfer headers to avoid stale lengths.
  headers.set('accept-encoding', 'identity');
  return headers;
}

class ConnectorRuntime {
  private socket?: WebSocket;
  private sender?: SocketSender;
  private upstreamUrl?: string;
  private limits?: Limits;
  private readonly active = new Map<string, ActiveRequest>();
  private messageQueue: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(private readonly config: ConnectorConfig, private readonly logger: Logger) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.connectOnce(signal);
      if (signal.aborted) return;
      const exponential = this.config.reconnectDelayMs * (2 ** Math.min(this.failures, 5));
      const delay = Math.floor(exponential * (0.5 + Math.random() * 0.5));
      await abortableDelay(delay, signal);
    }
  }

  private connectOnce(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = new WebSocket(websocketUrl(this.config), {
        headers: { Authorization: `Bearer ${this.config.token}` },
        maxPayload: this.config.wsMaxPayloadBytes,
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      });
      this.socket = socket;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.cleanupActive();
        this.socket = undefined;
        this.sender = undefined;
        this.upstreamUrl = undefined;
        this.limits = undefined;
        resolve();
      };
      const onAbort = (): void => {
        socket.close(1001, 'shutdown');
        const timer = setTimeout(() => socket.terminate(), 2000);
        timer.unref();
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }

      socket.once('open', () => {
        this.failures += 1;
        this.sender = createSocketSender(socket, 4 * 1024 * 1024);
        this.logger.info('connector_socket_open');
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) { this.protocolError(socket); return; }
        this.messageQueue = this.messageQueue.then(async () => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
          await this.handleMessage(parseServerMessage(data.toString()));
        }).catch(() => {
          this.logger.warn('connector_protocol_error');
          this.protocolError(socket);
        });
      });
      socket.on('unexpected-response', (_request, response) => {
        this.failures += 1;
        this.logger.warn('connector_handshake_rejected', { status: response.statusCode ?? 0 });
        socket.terminate();
        finish();
      });
      socket.on('error', () => {
        this.failures += 1;
        this.logger.warn('connector_connection_error');
      });
      socket.on('close', (code) => {
        this.logger.info('connector_socket_closed', { code });
        finish();
      });
    });
  }

  private async send(socket: WebSocket, message: unknown): Promise<void> {
    if (!this.sender) throw new Error('Connector is not ready');
    await this.sender(message);
  }

  private protocolError(socket: WebSocket): void {
    socket.close(1008, 'protocol_error');
  }

  private async handleMessage(message: ServerMessage): Promise<void> {
    if (message.type === 'welcome') {
      if (this.upstreamUrl || message.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('Invalid welcome');
      this.upstreamUrl = normalizeUpstreamUrl(message.connector.upstreamUrl);
      this.limits = message.limits;
      this.failures = 0;
      this.logger.info('connector_ready', { connectorId: message.connector.id });
      return;
    }
    if (!this.upstreamUrl || !this.limits || !this.socket) throw new ProtocolError('Welcome required');
    if (message.type === 'request') {
      await this.startRequest(message);
      return;
    }
    if (message.type === 'request_abort') {
      const active = this.active.get(message.requestId);
      if (!active) return;
      active.aborted = true;
      clearTimeout(active.timer);
      active.controller.abort();
      if (!active.started) this.active.delete(message.requestId);
      return;
    }
    const active = this.active.get(message.requestId);
    if (!active || active.complete || active.started) throw new ProtocolError('Unexpected body chunk');
    const chunk = decodeBody(message.data);
    active.bodyBytes += chunk.length;
    if (active.bodyBytes > active.bodyLength || active.bodyBytes > this.limits.maxRequestBytes) throw new ProtocolError('Request body too large');
    active.body.push(chunk);
    if (message.final) {
      if (active.bodyBytes !== active.bodyLength) throw new ProtocolError('Incomplete request body');
      active.complete = true;
      void this.executeRequest(active);
    }
  }

  private async startRequest(message: Extract<ServerMessage, { type: 'request' }>): Promise<void> {
    if (!this.limits || !this.socket || !this.upstreamUrl) throw new ProtocolError('Welcome required');
    if (this.active.has(message.requestId)) throw new ProtocolError('Duplicate request id');
    if (message.bodyLength > this.limits.maxRequestBytes || ((message.method === 'GET' || message.method === 'HEAD') && message.bodyLength > 0)) {
      throw new ProtocolError('Invalid request body length');
    }
    if (this.active.size >= this.limits.maxConcurrentRequests) {
      await this.send(this.socket, { type: 'response_error', requestId: message.requestId, status: 503, code: 'connector_busy' });
      return;
    }
    const controller = new AbortController();
    const active: ActiveRequest = {
      requestId: message.requestId,
      method: message.method,
      path: message.path,
      headers: message.headers,
      maxResponseBytes: message.maxResponseBytes,
      bodyLength: message.bodyLength,
      body: [],
      bodyBytes: 0,
      complete: message.bodyLength === 0,
      started: false,
      aborted: false,
      controller,
      timer: setTimeout(() => {
        active.controller.abort();
        if (!active.started) {
          void this.send(this.socket!, { type: 'response_error', requestId: active.requestId, status: 504, code: 'upstream_timeout' }).catch(() => undefined);
          this.active.delete(active.requestId);
        }
      }, message.timeoutMs),
    };
    active.timer.unref();
    this.active.set(message.requestId, active);
    if (active.complete) void this.executeRequest(active);
  }

  private async executeRequest(active: ActiveRequest): Promise<void> {
    if (!this.socket || !this.sender || !this.upstreamUrl || !this.limits) return;
    active.started = true;
    const socket = this.socket;
    const upstream = new URL(this.upstreamUrl);
    const target = upstreamTarget(this.upstreamUrl, active.path);
    const body = Buffer.concat(active.body, active.bodyBytes);
    try {
      const response = await fetch(target, {
        method: active.method,
        headers: requestHeaders(active.headers, upstream),
        body: active.method === 'GET' || active.method === 'HEAD' ? undefined : new Uint8Array(body),
        redirect: 'manual',
        signal: active.controller.signal,
      });
      clearTimeout(active.timer);
      if (active.aborted) { await response.body?.cancel(); return; }
      await this.send(socket, {
        type: 'response',
        requestId: active.requestId,
        status: response.status,
        headers: sanitizeResponseHeaders(headerMapFromHeaders(response.headers)),
      });
      if (!response.body) {
        await this.send(socket, { type: 'response_chunk', requestId: active.requestId, data: '', final: true });
        return;
      }
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          const value = Buffer.from(result.value);
          if (bytes + value.length > active.maxResponseBytes) {
            await reader.cancel();
            await this.send(socket, { type: 'response_chunk', requestId: active.requestId, data: '', final: true, error: 'response_too_large' });
            return;
          }
          bytes += value.length;
          for (let offset = 0; offset < value.length; offset += BODY_CHUNK_BYTES) {
            await this.send(socket, {
              type: 'response_chunk', requestId: active.requestId,
              data: encodeBody(value.subarray(offset, offset + BODY_CHUNK_BYTES)), final: false,
            });
          }
        }
        await this.send(socket, { type: 'response_chunk', requestId: active.requestId, data: '', final: true });
      } catch {
        if (!active.aborted) {
          await this.send(socket, { type: 'response_chunk', requestId: active.requestId, data: '', final: true, error: 'upstream_stream_error' }).catch(() => undefined);
        }
      }
    } catch {
      clearTimeout(active.timer);
      if (!active.aborted) {
        const timedOut = active.controller.signal.aborted;
        await this.send(socket, {
          type: 'response_error', requestId: active.requestId,
          status: timedOut ? 504 : 502,
          code: timedOut ? 'upstream_timeout' : 'upstream_error',
        }).catch(() => undefined);
      }
    } finally {
      clearTimeout(active.timer);
      this.active.delete(active.requestId);
    }
  }

  private cleanupActive(): void {
    for (const active of this.active.values()) {
      active.aborted = true;
      clearTimeout(active.timer);
      active.controller.abort();
    }
    this.active.clear();
  }
}

export async function runConnector(config: ConnectorConfig, logger: Logger, signal: AbortSignal): Promise<void> {
  await new ConnectorRuntime(config, logger).run(signal);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: synapse-tunnel-connector [--server-url URL] [--token TOKEN] [--reconnect-delay-ms MS]\n');
    return;
  }
  const config = loadConnectorConfig(process.env, args);
  const logger = createLogger(config.logLevel, 'connector');
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runConnector(config, logger, controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Connector failed';
    process.stderr.write(`${JSON.stringify({ level: 'error', component: 'connector', event: 'startup_failed', message })}\n`);
    process.exitCode = 1;
  });
}
