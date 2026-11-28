// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const {
  assertHeaderMap,
  hasExactKeys,
  isRecord,
  normalizeUpstreamUrl,
  validateConnectorId,
} = require('./validation');

const PROTOCOL_VERSION = 1;
const BODY_CHUNK_BYTES = 65536;
const MAX_CHUNK_CHARS = 87400;
const MAX_BODY_BYTES = 104857600;
const METHOD = /^[A-Z!#$%&'*+.^_`|~0-9-]+$/;

class ProtocolError extends Error {
  constructor(message = 'Invalid server message') {
    super(message);
    this.name = 'ProtocolError';
  }
}

function exact(value, keys) {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new ProtocolError();
}

function boundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateWelcome(message) {
  exact(message, ['type', 'protocolVersion', 'connector', 'limits']);
  if (message.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('Unsupported protocol version');
  exact(message.connector, ['id', 'name', 'upstreamUrl']);
  if (!validateConnectorId(message.connector.id) || message.connector.id === undefined) throw new ProtocolError('Invalid welcome');
  if (typeof message.connector.name !== 'string' || message.connector.name.length > 80) throw new ProtocolError('Invalid welcome');
  normalizeUpstreamUrl(message.connector.upstreamUrl);
  exact(message.limits, ['maxRequestBytes', 'maxResponseBytes', 'maxConcurrentRequests']);
  if (!boundedInteger(message.limits.maxRequestBytes, 1024, MAX_BODY_BYTES)
    || !boundedInteger(message.limits.maxResponseBytes, 1024, MAX_BODY_BYTES)
    || !boundedInteger(message.limits.maxConcurrentRequests, 1, 10000)) {
    throw new ProtocolError('Invalid welcome limits');
  }
  return message;
}

function validateRequest(message) {
  exact(message, ['type', 'requestId', 'method', 'path', 'headers', 'bodyLength', 'timeoutMs', 'maxResponseBytes']);
  if (!validateConnectorId(message.requestId) || message.requestId === undefined) throw new ProtocolError('Invalid request id');
  if (typeof message.method !== 'string' || message.method.length > 32 || !METHOD.test(message.method) || message.method === 'CONNECT') {
    throw new ProtocolError('Invalid request method');
  }
  if (typeof message.path !== 'string' || message.path.length < 1 || message.path.length > 16384
    || !message.path.startsWith('/') || /[\r\n\u0000]/.test(message.path)) {
    throw new ProtocolError('Invalid request path');
  }
  assertHeaderMap(message.headers);
  if (!boundedInteger(message.bodyLength, 0, MAX_BODY_BYTES)) throw new ProtocolError('Invalid request body length');
  if (!boundedInteger(message.timeoutMs, 100, 300000)) throw new ProtocolError('Invalid request timeout');
  if (!boundedInteger(message.maxResponseBytes, 1024, MAX_BODY_BYTES)) throw new ProtocolError('Invalid response limit');
  return message;
}

function validateBody(message) {
  exact(message, ['type', 'requestId', 'data', 'final']);
  if (!validateConnectorId(message.requestId) || message.requestId === undefined) throw new ProtocolError('Invalid request id');
  if (typeof message.data !== 'string' || message.data.length > MAX_CHUNK_CHARS || typeof message.final !== 'boolean') {
    throw new ProtocolError('Invalid body chunk');
  }
  decodeBody(message.data);
  return message;
}

function validateAbort(message) {
  exact(message, ['type', 'requestId']);
  if (!validateConnectorId(message.requestId) || message.requestId === undefined) throw new ProtocolError('Invalid request id');
  return message;
}

function parseServerMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new ProtocolError('Invalid JSON message');
  }
  try {
    if (!isRecord(message) || typeof message.type !== 'string') throw new ProtocolError();
    if (message.type === 'welcome') return validateWelcome(message);
    if (message.type === 'request') return validateRequest(message);
    if (message.type === 'request_body') return validateBody(message);
    if (message.type === 'request_abort') return validateAbort(message);
    throw new ProtocolError('Unknown server message type');
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(error instanceof Error ? error.message : 'Invalid server message');
  }
}

function encodeBody(data) {
  return Buffer.from(data).toString('base64url');
}

function decodeBody(data) {
  if (typeof data !== 'string' || data.length > MAX_CHUNK_CHARS || !/^[A-Za-z0-9_-]*$/.test(data) || data.length % 4 === 1) {
    throw new ProtocolError('Invalid body encoding');
  }
  const decoded = Buffer.from(data, 'base64url');
  if (decoded.toString('base64url') !== data) throw new ProtocolError('Invalid body encoding');
  return decoded;
}

module.exports = {
  BODY_CHUNK_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeBody,
  encodeBody,
  parseServerMessage,
};
