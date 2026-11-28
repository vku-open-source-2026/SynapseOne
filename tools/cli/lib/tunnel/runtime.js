// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const WebSocket = require('ws');
const { websocketUrl } = require('./config');
const { requestHeaders, responseHeaders } = require('./http');
const {
  BODY_CHUNK_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeBody,
  encodeBody,
  parseServerMessage,
} = require('./protocol');
const { createSocketSender } = require('./socket-sender');
const { upstreamTarget } = require('./validation');

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => finish();
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class TunnelRuntime {
  constructor(config, logger, options = {}) {
    this.config = config;
    this.logger = logger;
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.random = options.random || Math.random;
    this.socket = undefined;
    this.sender = undefined;
    this.upstreamUrl = undefined;
    this.limits = undefined;
    this.active = new Map();
    this.failures = 0;
    this.connectionReady = false;
  }

  async run(signal) {
    while (!signal.aborted) {
      const ready = await this.connectOnce(signal);
      if (signal.aborted) return;
      this.failures += 1;
      const exponential = this.config.reconnectDelayMs * (2 ** Math.min(this.failures - 1, 5));
      const delay = Math.min(30000, Math.floor(exponential * (0.5 + this.random() * 0.5)));
      this.logger.info('tunnel_reconnect', { delayMs: delay, previouslyReady: ready });
      await abortableDelay(delay, signal);
    }
  }

  connectOnce(signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      this.connectionReady = false;
      const socket = new this.WebSocketImpl(websocketUrl(this.config), {
        headers: { Authorization: `Bearer ${this.config.token}` },
        maxPayload: this.config.wsMaxPayloadBytes,
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      });
      this.socket = socket;
      let messageQueue = Promise.resolve();

      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.cleanupActive();
        if (this.socket === socket) {
          this.socket = undefined;
          this.sender = undefined;
          this.upstreamUrl = undefined;
          this.limits = undefined;
        }
        resolve(this.connectionReady);
      };
      const onAbort = () => {
        if (socket.readyState === this.WebSocketImpl.OPEN) {
          socket.close(1001, 'shutdown');
          const timer = setTimeout(() => socket.terminate(), 2000);
          timer.unref();
        } else {
          socket.terminate();
        }
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }

      socket.once('open', () => {
        if (settled || this.socket !== socket) return;
        this.sender = createSocketSender(socket, 4 * 1024 * 1024);
        this.logger.info('tunnel_socket_open');
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) { this.protocolError(socket); return; }
        messageQueue = messageQueue.then(async () => {
          if (settled || this.socket !== socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
          await this.handleMessage(socket, parseServerMessage(data.toString()));
        }).catch(() => {
          if (!settled && this.socket === socket) {
            this.logger.warn('tunnel_protocol_error');
            this.protocolError(socket);
          }
        });
      });
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        this.logger.warn('tunnel_handshake_rejected', { status: response.statusCode || 0 });
        socket.terminate();
        finish();
      });
      socket.on('error', () => {
        if (!settled) this.logger.warn('tunnel_connection_error');
      });
      socket.on('close', (code) => {
        if (!settled) this.logger.info('tunnel_socket_closed', { code });
        finish();
      });
    });
  }

  protocolError(socket) {
    if (socket === this.socket && socket.readyState === this.WebSocketImpl.OPEN) socket.close(1008, 'protocol_error');
  }

  async send(socket, message) {
    if (this.socket !== socket || !this.sender) throw new Error('Socket is closed');
    await this.sender(message);
  }

  async handleMessage(socket, message) {
    if (message.type === 'welcome') {
      if (this.upstreamUrl || message.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('Invalid welcome');
      this.upstreamUrl = message.connector.upstreamUrl;
      this.limits = message.limits;
      this.failures = 0;
      this.connectionReady = true;
      this.logger.info('tunnel_ready', {
        connectorId: message.connector.id,
        ...(this.config.connectorId ? { displayConnectorId: this.config.connectorId } : {}),
      });
      return;
    }
    if (!this.upstreamUrl || !this.limits || this.socket !== socket) throw new ProtocolError('Welcome required');
    if (message.type === 'request') {
      await this.startRequest(socket, message);
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
    await this.appendBody(message);
  }

  async startRequest(socket, message) {
    if (!this.limits || !this.upstreamUrl) throw new ProtocolError('Welcome required');
    if (this.active.has(message.requestId)) throw new ProtocolError('Duplicate request id');
    if (message.bodyLength > this.limits.maxRequestBytes
      || ((message.method === 'GET' || message.method === 'HEAD') && message.bodyLength > 0)) {
      throw new ProtocolError('Invalid request body length');
    }
    if (this.active.size >= this.limits.maxConcurrentRequests) {
      await this.send(socket, { type: 'response_error', requestId: message.requestId, status: 503, code: 'connector_busy' });
      return;
    }

    const controller = new AbortController();
    const active = {
      requestId: message.requestId,
      method: message.method,
      path: message.path,
      headers: message.headers,
      maxResponseBytes: Math.min(message.maxResponseBytes, this.limits.maxResponseBytes),
      bodyLength: message.bodyLength,
      body: [],
      bodyBytes: 0,
      complete: message.bodyLength === 0,
      started: false,
      aborted: false,
      timedOut: false,
      controller,
      timer: undefined,
    };
    active.timer = setTimeout(() => {
      active.timedOut = true;
      controller.abort();
      if (!active.started) {
        this.active.delete(active.requestId);
        void this.send(socket, {
          type: 'response_error', requestId: active.requestId, status: 504, code: 'upstream_timeout',
        }).catch(() => undefined);
      }
    }, message.timeoutMs);
    active.timer.unref();
    this.active.set(message.requestId, active);
    if (active.complete) void this.executeRequest(socket, active);
  }

  async appendBody(message) {
    const active = this.active.get(message.requestId);
    if (!active || active.complete || active.started) throw new ProtocolError('Unexpected body chunk');
    const chunk = decodeBody(message.data);
    active.bodyBytes += chunk.length;
    if (active.bodyBytes > active.bodyLength || active.bodyBytes > this.limits.maxRequestBytes) {
      throw new ProtocolError('Request body too large');
    }
    active.body.push(chunk);
    if (message.final) {
      if (active.bodyBytes !== active.bodyLength) throw new ProtocolError('Incomplete request body');
      active.complete = true;
      void this.executeRequest(this.socket, active);
    }
  }

  async executeRequest(socket, active) {
    if (this.socket !== socket || !this.sender || !this.upstreamUrl) return;
    active.started = true;
    const body = Buffer.concat(active.body, active.bodyBytes);
    try {
      const upstream = new URL(this.upstreamUrl);
      const target = upstreamTarget(this.upstreamUrl, active.path);
      const response = await this.fetchImpl(target, {
        method: active.method,
        headers: requestHeaders(active.headers, upstream),
        body: active.method === 'GET' || active.method === 'HEAD' ? undefined : new Uint8Array(body),
        redirect: 'manual',
        signal: active.controller.signal,
      });
      // The route timeout covers connection + upstream response headers. Once
      // headers arrive, SSE/long responses may continue until the client aborts.
      clearTimeout(active.timer);
      if (active.aborted) {
        try { await response.body?.cancel(); } catch { /* already closed */ }
        return;
      }
      await this.send(socket, {
        type: 'response',
        requestId: active.requestId,
        status: response.status,
        headers: responseHeaders(response.headers),
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
          if (active.aborted) {
            try { await reader.cancel(); } catch { /* already closed */ }
            return;
          }
          const value = Buffer.from(result.value);
          if (bytes + value.length > active.maxResponseBytes) {
            try { await reader.cancel(); } catch { /* already closed */ }
            await this.send(socket, {
              type: 'response_chunk', requestId: active.requestId, data: '', final: true, error: 'response_too_large',
            });
            return;
          }
          bytes += value.length;
          for (let offset = 0; offset < value.length; offset += BODY_CHUNK_BYTES) {
            await this.send(socket, {
              type: 'response_chunk',
              requestId: active.requestId,
              data: encodeBody(value.subarray(offset, offset + BODY_CHUNK_BYTES)),
              final: false,
            });
          }
        }
        await this.send(socket, { type: 'response_chunk', requestId: active.requestId, data: '', final: true });
      } catch {
        if (!active.aborted) {
          await this.send(socket, {
            type: 'response_chunk', requestId: active.requestId, data: '', final: true, error: 'upstream_stream_error',
          }).catch(() => undefined);
        }
      }
    } catch {
      if (!active.aborted) {
        await this.send(socket, {
          type: 'response_error',
          requestId: active.requestId,
          status: active.timedOut ? 504 : 502,
          code: active.timedOut ? 'upstream_timeout' : 'upstream_error',
        }).catch(() => undefined);
      }
    } finally {
      clearTimeout(active.timer);
      if (this.active.get(active.requestId) === active) this.active.delete(active.requestId);
    }
  }

  cleanupActive() {
    for (const active of this.active.values()) {
      active.aborted = true;
      clearTimeout(active.timer);
      active.controller.abort();
    }
    this.active.clear();
  }
}

async function runConnector(config, logger, signal, options) {
  await new TunnelRuntime(config, logger, options).run(signal);
}

module.exports = { TunnelRuntime, runConnector };
