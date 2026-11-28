// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import type { ServerConfig } from './config';
import { TunnelError } from './errors';
import type { Logger } from './logger';
import {
  BODY_CHUNK_BYTES, PROTOCOL_VERSION, ProtocolError, decodeBody, encodeBody,
  parseConnectorMessage, type ConnectorMessage, type ServerMessage,
} from './protocol';
import { createSocketSender } from './socket-sender';
import { JsonStore } from './store';
import type { ConnectorRecord, ConnectorStatus, HeaderMap, RouteRecord } from './types';

export interface DispatchInput {
  method: string;
  path: string;
  headers: HeaderMap;
  body: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  onBody: (chunk: Buffer, error?: 'response_too_large' | 'upstream_stream_error') => Promise<void>;
}

export interface DispatchedRequest {
  requestId: string;
  head: { status: number; headers: HeaderMap };
  done: Promise<void>;
  startBody: () => void;
  abort: () => void;
}

interface PendingRequest {
  active: boolean;
  headSent: boolean;
  bytes: number;
  timer: NodeJS.Timeout;
  input: DispatchInput;
  resolveHead: (head: { status: number; headers: HeaderMap }) => void;
  rejectHead: (error: unknown) => void;
  resolveDone: () => void;
  rejectDone: (error: unknown) => void;
  failure?: TunnelError;
  bodyReady: Promise<void>;
  releaseBody: () => void;
}

function asTunnelError(error: unknown): TunnelError {
  if (error instanceof TunnelError) return error;
  return new TunnelError(502, 'connector_offline', 'Connector is unavailable');
}

class ConnectorSession {
  readonly pending = new Map<string, PendingRequest>();
  readonly connectedAt = new Date().toISOString();
  ready = false;
  private disposed = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private readonly send: ReturnType<typeof createSocketSender>;
  private heartbeat?: NodeJS.Timeout;
  private awaitingPong = true;

  constructor(
    readonly socket: WebSocket,
    readonly connector: ConnectorRecord,
    private readonly config: ServerConfig,
    private readonly logger: Logger,
    private readonly onClose: (session: ConnectorSession) => void,
  ) {
    this.send = createSocketSender(socket, config.maxBufferedAmount);
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.protocolError();
        return;
      }
      const raw = data.toString();
      this.messageQueue = this.messageQueue.then(async () => {
        if (this.disposed) return;
        await this.handleMessage(raw);
      }).catch(() => {
        this.logger.warn('connector_protocol_error', { connectorId: connector.id });
        this.protocolError();
      });
    });
    socket.on('close', (code) => {
      this.logger.info('connector_disconnected', { connectorId: connector.id, code });
      this.dispose();
      this.onClose(this);
    });
    socket.on('error', () => {
      this.logger.warn('connector_socket_error', { connectorId: connector.id });
    });
    socket.on('pong', () => { this.awaitingPong = true; });
  }

  async start(): Promise<void> {
    const welcome: ServerMessage = {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      connector: { id: this.connector.id, name: this.connector.name, upstreamUrl: this.connector.upstreamUrl },
      limits: {
        maxRequestBytes: this.config.maxRequestBytes,
        maxResponseBytes: this.config.maxResponseBytes,
        maxConcurrentRequests: this.config.maxConcurrentRequests,
      },
    };
    try {
      await this.send(welcome);
      this.ready = true;
      this.logger.info('connector_connected', { connectorId: this.connector.id });
      this.heartbeat = setInterval(() => {
        if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return;
        if (!this.awaitingPong) {
          this.logger.warn('connector_heartbeat_timeout', { connectorId: this.connector.id });
          this.socket.terminate();
          return;
        }
        this.awaitingPong = false;
        this.socket.ping();
      }, this.config.heartbeatIntervalMs);
      this.heartbeat.unref();
    } catch {
      this.dispose();
      this.socket.close(1011, 'welcome_failed');
    }
  }

  async sendMessage(message: ServerMessage): Promise<void> {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) throw new TunnelError(502, 'connector_offline', 'Connector is unavailable');
    if (Buffer.byteLength(JSON.stringify(message)) > this.config.wsMaxPayloadBytes) throw new ProtocolError('Message too large');
    await this.send(message);
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = parseConnectorMessage(raw);
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      // A response can race an abort/timeout. Ignore unknown ids rather than
      // punishing the whole multiplexed connection for a cancelled request.
      if (!pending || !pending.active || pending.headSent) return;
      pending.headSent = true;
      clearTimeout(pending.timer);
      pending.resolveHead({ status: message.status, headers: message.headers });
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending || !pending.active) return;
    if (message.type === 'response_error') {
      const status = message.code === 'upstream_timeout' ? 504 : message.code === 'connector_busy' ? 503 : 502;
      const error = new TunnelError(status, message.code, message.code === 'upstream_timeout' ? 'Upstream request timed out' : 'Upstream request failed');
      if (pending.headSent) {
        await pending.bodyReady;
        await pending.input.onBody(Buffer.alloc(0), 'upstream_stream_error');
      }
      this.failPending(message.requestId, pending, error);
      return;
    }
    if (!pending.headSent) throw new ProtocolError('Chunk before response headers');
    await pending.bodyReady;
    const chunk = decodeBody(message.data);
    if (message.error === 'response_too_large' || pending.bytes + chunk.length > pending.input.maxResponseBytes) {
      await pending.input.onBody(Buffer.alloc(0), 'response_too_large');
      this.failPending(message.requestId, pending, new TunnelError(502, 'response_too_large', 'Upstream response exceeded the size limit'));
      return;
    }
    pending.bytes += chunk.length;
    await pending.input.onBody(chunk);
    if (message.final) {
      pending.active = false;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.resolveDone();
    }
  }

  failPending(requestId: string, pending: PendingRequest, error: TunnelError): void {
    if (!pending.active) return;
    pending.active = false;
    pending.failure = error;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (!pending.headSent) pending.rejectHead(error);
    pending.rejectDone(error);
    if (!this.disposed && this.socket.readyState === WebSocket.OPEN) {
      void this.sendMessage({ type: 'request_abort', requestId }).catch(() => undefined);
    }
  }

  protocolError(): void {
    if (this.disposed) return;
    this.socket.close(1008, 'protocol_error');
    this.dispose();
    this.onClose(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [requestId, pending] of this.pending) {
      this.failPending(requestId, pending, new TunnelError(502, 'connector_offline', 'Connector is unavailable'));
    }
  }
}

export class TunnelRegistry {
  private readonly sessions = new Map<string, ConnectorSession>();

  constructor(private readonly store: JsonStore, private readonly config: ServerConfig, private readonly logger: Logger) {}

  register(socket: WebSocket, connector: ConnectorRecord): void {
    const previous = this.sessions.get(connector.id);
    const session = new ConnectorSession(socket, connector, this.config, this.logger, (closed) => {
      if (this.sessions.get(connector.id) === closed) this.sessions.delete(connector.id);
    });
    this.sessions.set(connector.id, session);
    if (previous) {
      previous.socket.close(1001, 'connection_replaced');
      previous.dispose();
    }
    void session.start();
  }

  status(connectorId: string): ConnectorStatus {
    const session = this.sessions.get(connectorId);
    if (!session || !session.ready || session.socket.readyState !== WebSocket.OPEN) return { connected: false };
    return { connected: true, connectedAt: session.connectedAt };
  }

  disconnect(connectorId: string): void {
    const session = this.sessions.get(connectorId);
    if (!session) return;
    session.socket.close(1001, 'disabled_by_admin');
    session.dispose();
    this.sessions.delete(connectorId);
  }

  async dispatch(connectorId: string, route: RouteRecord, input: DispatchInput): Promise<DispatchedRequest> {
    const connector = await this.store.getConnectorRecord(connectorId);
    const session = this.sessions.get(connectorId);
    if (!connector?.enabled || !session?.ready || session.socket.readyState !== WebSocket.OPEN) {
      throw new TunnelError(502, 'connector_offline', 'Connector is offline');
    }
    if (session.pending.size >= this.config.maxConcurrentRequests) {
      throw new TunnelError(503, 'connector_busy', 'Connector is at capacity');
    }
    if (input.body.length > this.config.maxRequestBytes) throw new TunnelError(413, 'request_too_large', 'Request body is too large');

    const requestId = randomUUID();
    let resolveHead!: (head: { status: number; headers: HeaderMap }) => void;
    let rejectHead!: (error: unknown) => void;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const head = new Promise<{ status: number; headers: HeaderMap }>((resolve, reject) => { resolveHead = resolve; rejectHead = reject; });
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    let releaseBody!: () => void;
    const bodyReady = new Promise<void>((resolve) => { releaseBody = resolve; });
    // The caller may still be sending the request body when an error settles.
    // Attach a handler now; the same promise is returned and awaited later.
    void done.catch(() => undefined);
    const pending: PendingRequest = {
      active: true, headSent: false, bytes: 0, input,
      timer: setTimeout(() => {
        session.failPending(requestId, pending, new TunnelError(504, 'request_timeout', 'Connector request timed out'));
      }, input.timeoutMs),
      resolveHead, rejectHead, resolveDone, rejectDone, bodyReady, releaseBody,
    };
    pending.timer.unref();
    session.pending.set(requestId, pending);
    try {
      await session.sendMessage({
        type: 'request', requestId, method: input.method, path: input.path,
        headers: input.headers, bodyLength: input.body.length,
        timeoutMs: input.timeoutMs, maxResponseBytes: input.maxResponseBytes,
      });
      for (let offset = 0; offset < input.body.length; offset += BODY_CHUNK_BYTES) {
        if (!pending.active) break;
        const chunk = input.body.subarray(offset, offset + BODY_CHUNK_BYTES);
        await session.sendMessage({ type: 'request_body', requestId, data: encodeBody(chunk), final: offset + chunk.length === input.body.length });
      }
      if (!pending.active) throw pending.failure ?? new TunnelError(502, 'connector_offline', 'Connector request was cancelled');
      const responseHead = await head;
      return {
        requestId,
        head: responseHead,
        done,
        startBody: releaseBody,
        abort: () => session.failPending(requestId, pending, new TunnelError(502, 'request_aborted', 'Request was aborted')),
      };
    } catch (error) {
      session.failPending(requestId, pending, asTunnelError(error));
      throw asTunnelError(error);
    }
  }

  close(): void {
    for (const session of this.sessions.values()) {
      session.socket.close(1001, 'server_shutdown');
      session.dispose();
    }
    this.sessions.clear();
  }
}
