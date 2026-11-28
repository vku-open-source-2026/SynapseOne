// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { z } from 'zod';
import type { HeaderMap } from './types';

export const PROTOCOL_VERSION = 1 as const;
export const BODY_CHUNK_BYTES = 65536;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const headerMapSchema = z.record(z.string(), z.array(z.string().max(16384)).max(32)).superRefine((headers, ctx) => {
  const entries = Object.entries(headers);
  if (entries.length > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many headers' });
  let bytes = 0;
  for (const [name, values] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || values.length > 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid headers' });
    }
    for (const value of values) {
      if (/[\r\n\u0000]/.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid headers' });
      bytes += Buffer.byteLength(value);
    }
  }
  if (bytes > 131072) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Headers too large' });
});

const requestIdSchema = z.string().uuid();
const methodSchema = z.string().max(32).regex(/^[A-Z!#$%&'*+.^_`|~0-9-]+$/).refine((method) => method !== 'CONNECT');
const pathSchema = z.string().min(1).max(16384).startsWith('/').refine((path) => !/[\r\n\u0000]/.test(path));
const chunkSchema = z.string().max(87400).regex(/^[A-Za-z0-9_-]*$/);

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    connector: z.object({ id: z.string().uuid(), name: z.string().max(80), upstreamUrl: z.string().max(2048) }).strict(),
    limits: z.object({
      maxRequestBytes: z.number().int().min(1024).max(104857600),
      maxResponseBytes: z.number().int().min(1024).max(104857600),
      maxConcurrentRequests: z.number().int().min(1).max(10000),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('request'),
    requestId: requestIdSchema,
    method: methodSchema,
    path: pathSchema,
    headers: headerMapSchema,
    bodyLength: z.number().int().min(0).max(104857600),
    timeoutMs: z.number().int().min(100).max(300000),
    maxResponseBytes: z.number().int().min(1024).max(104857600),
  }).strict(),
  z.object({ type: z.literal('request_body'), requestId: requestIdSchema, data: chunkSchema, final: z.boolean() }).strict(),
  z.object({ type: z.literal('request_abort'), requestId: requestIdSchema }).strict(),
]);

export const connectorMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('response'),
    requestId: requestIdSchema,
    status: z.number().int().min(200).max(599),
    headers: headerMapSchema,
  }).strict(),
  z.object({
    type: z.literal('response_chunk'),
    requestId: requestIdSchema,
    data: chunkSchema,
    final: z.boolean(),
    error: z.enum(['response_too_large', 'upstream_stream_error']).optional(),
  }).strict(),
  z.object({
    type: z.literal('response_error'),
    requestId: requestIdSchema,
    status: z.number().int().min(400).max(599),
    code: z.enum(['connector_busy', 'upstream_error', 'upstream_timeout']),
  }).strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ConnectorMessage = z.infer<typeof connectorMessageSchema>;

export function encodeBody(data: Buffer): string {
  return data.toString('base64url');
}

export function decodeBody(data: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(data) || data.length % 4 === 1) throw new ProtocolError('Invalid body encoding');
  const decoded = Buffer.from(data, 'base64url');
  if (decoded.toString('base64url') !== data) throw new ProtocolError('Invalid body encoding');
  return decoded;
}

export function parseServerMessage(raw: string): ServerMessage {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError('Invalid JSON message'); }
  const result = serverMessageSchema.safeParse(value);
  if (!result.success) throw new ProtocolError('Invalid server message');
  return result.data;
}

export function parseConnectorMessage(raw: string): ConnectorMessage {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError('Invalid JSON message'); }
  const result = connectorMessageSchema.safeParse(value);
  if (!result.success) throw new ProtocolError('Invalid connector message');
  return result.data;
}

export function headerMapFromHeaders(headers: Headers): HeaderMap {
  const output: HeaderMap = {};
  for (const [name, value] of headers.entries()) {
    const values = name === 'set-cookie' ? headers.getSetCookie() : [value];
    if (values.length) output[name] = values;
  }
  return output;
}
