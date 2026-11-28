// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { isIP } from 'net';
import { domainToASCII } from 'url';
import { z } from 'zod';
import type { HeaderMap } from './types';

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeHostname(value: string): string {
  let hostname = value.trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!hostname || hostname.length > 253 || CONTROL_CHARS.test(hostname) || /[\s/@?#\\]/.test(hostname)) {
    throw new Error('Invalid hostname');
  }
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (!hostname) throw new Error('Invalid hostname');
  if (isIP(hostname)) return hostname;
  const ascii = domainToASCII(hostname);
  if (!ascii || ascii.length > 253 || isIP(ascii) === 0) {
    const labels = ascii.split('.');
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new Error('Invalid hostname');
    }
  }
  return ascii;
}

export function parseHostHeader(value: string | undefined): string {
  if (!value || value.length > 255 || CONTROL_CHARS.test(value) || /[\s/@?#\\]/.test(value)) {
    throw new Error('Invalid Host header');
  }
  let hostname = value;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) throw new Error('Invalid Host header');
    hostname = value.slice(1, end);
    const remainder = value.slice(end + 1);
    if (remainder && !/^:\d{1,5}$/.test(remainder)) throw new Error('Invalid Host header');
    if (remainder && !validPort(remainder.slice(1))) throw new Error('Invalid Host header');
    return normalizeHostname(hostname);
  }
  const colon = value.indexOf(':');
  if (colon >= 0) {
    if (value.indexOf(':', colon + 1) >= 0) throw new Error('Invalid Host header');
    const port = value.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port) || !validPort(port)) throw new Error('Invalid Host header');
    hostname = value.slice(0, colon);
  }
  return normalizeHostname(hostname);
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function normalizeUpstreamUrl(value: string): string {
  if (!value || value.length > 2048 || CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new Error('Invalid upstream URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid upstream URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error('Invalid upstream URL');
  }
  normalizeHostname(url.hostname);
  if (/%0[0-9a-f]/i.test(url.pathname)) throw new Error('Invalid upstream URL');
  return url.href;
}

export function normalizePathPrefix(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  if (value.length > 512 || !value.startsWith('/') || CONTROL_CHARS.test(value) || /[?#\\]/.test(value)) {
    throw new Error('Invalid path prefix');
  }
  if (value === '/') return '';
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid path prefix');
  }
  return normalized;
}

function connectionHeaders(connection: string | string[] | undefined): Set<string> {
  const values = Array.isArray(connection) ? connection : connection ? [connection] : [];
  return new Set(values.flatMap((value) => value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)));
}

function assertHeaderBudget(headers: HeaderMap): HeaderMap {
  const entries = Object.entries(headers);
  if (entries.length > 100) throw new Error('Too many headers');
  let total = 0;
  for (const [name, values] of entries) {
    if (!HEADER_NAME.test(name) || values.length > 32) throw new Error('Invalid headers');
    for (const value of values) {
      if (typeof value !== 'string' || value.length > 16384 || /[\r\n\u0000]/.test(value)) throw new Error('Invalid headers');
      total += Buffer.byteLength(value);
    }
  }
  if (total > 131072) throw new Error('Headers too large');
  return headers;
}

export function sanitizeRequestHeaders(input: Record<string, string | string[] | undefined>, preserveForwarded = false): HeaderMap {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders(input.connection)]);
  const output: HeaderMap = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined || blocked.has(name) || name === 'host' || name === 'content-length') continue;
    if (name.startsWith('x-synapseone-') || name.startsWith('x-synapsedx-')) continue;
    if (!preserveForwarded && (name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-real-ip' || name === 'x-request-id')) continue;
    output[name] = Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)];
  }
  return assertHeaderBudget(output);
}

export function sanitizeResponseHeaders(input: HeaderMap): HeaderMap {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders(input.connection?.[0])]);
  const output: HeaderMap = {};
  for (const [rawName, values] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (blocked.has(name) || name === 'content-length' || name === 'content-encoding') continue;
    output[name] = values;
  }
  return assertHeaderBudget(output);
}

export const connectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(80).refine((value) => !CONTROL_CHARS.test(value), 'Invalid name'),
  upstreamUrl: z.string().transform((value, ctx) => {
    try { return normalizeUpstreamUrl(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid upstream URL' }); return z.NEVER; }
  }),
  // Ownership comes only from the authenticated principal. Accept and discard
  // this field so a caller cannot use it to select another organization.
  orgId: z.unknown().optional(),
}).strict().transform(({ orgId: _orgId, ...connector }) => connector);

export const connectorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).refine((value) => !CONTROL_CHARS.test(value), 'Invalid name').optional(),
  upstreamUrl: z.string().transform((value, ctx) => {
    try { return normalizeUpstreamUrl(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid upstream URL' }); return z.NEVER; }
  }).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'No fields to update');

export const routeCreateSchema = z.object({
  name: z.string().trim().min(1).max(80).refine((value) => !CONTROL_CHARS.test(value), 'Invalid name').optional(),
  hostname: z.string().transform((value, ctx) => {
    try { return normalizeHostname(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid hostname' }); return z.NEVER; }
  }),
  pathPrefix: z.string().optional().transform((value, ctx) => {
    try { return normalizePathPrefix(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid path prefix' }); return z.NEVER; }
  }),
  connectorId: z.string().uuid(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(300000).optional(),
  maxResponseBytes: z.number().int().min(1024).max(104857600).optional(),
  rateLimitPerMinute: z.number().int().min(0).max(1000000).optional(),
}).strict();

export const routeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).refine((value) => !CONTROL_CHARS.test(value), 'Invalid name').optional(),
  hostname: z.string().transform((value, ctx) => {
    try { return normalizeHostname(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid hostname' }); return z.NEVER; }
  }).optional(),
  pathPrefix: z.string().transform((value, ctx) => {
    try { return normalizePathPrefix(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid path prefix' }); return z.NEVER; }
  }).optional(),
  connectorId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(300000).optional(),
  maxResponseBytes: z.number().int().min(1024).max(104857600).optional(),
  rateLimitPerMinute: z.number().int().min(0).max(1000000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'No fields to update');
