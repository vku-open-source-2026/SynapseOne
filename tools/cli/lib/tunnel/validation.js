// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTOR_TOKEN = /^st_[A-Za-z0-9_-]{43}$/;

const HOP_BY_HOP_HEADERS = new Set([
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateConnectorToken(value) {
  return typeof value === 'string' && CONNECTOR_TOKEN.test(value);
}

function validateConnectorId(value) {
  return value === undefined || (typeof value === 'string' && UUID.test(value));
}

function normalizeHttpUrl(value, label) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error(`Invalid ${label}`);
  }
  return url;
}

function normalizeServerUrl(value) {
  return normalizeHttpUrl(value, 'connector server URL').href;
}

function normalizeHostname(value) {
  let hostname = value.trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!hostname || hostname.length > 253 || /[\u0000-\u001f\u007f\s/@?#\\]/.test(hostname)) throw new Error('Invalid hostname');
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (!hostname) throw new Error('Invalid hostname');
  if (isIP(hostname)) return hostname;
  const ascii = domainToASCII(hostname);
  if (!ascii || ascii.length > 253) throw new Error('Invalid hostname');
  const labels = ascii.split('.');
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('Invalid hostname');
  }
  return ascii;
}

function normalizeUpstreamUrl(value) {
  const url = normalizeHttpUrl(value, 'upstream URL');
  try {
    normalizeHostname(url.hostname);
  } catch {
    throw new Error('Invalid upstream URL');
  }
  if (/%0[0-9a-f]/i.test(url.pathname)) throw new Error('Invalid upstream URL');
  return url.href;
}

function normalizeWsPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 128 || /[?#\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid SYNAPSETUNNEL_WS_PATH');
  }
  return value;
}

function connectionHeaders(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(values.flatMap((item) => String(item).split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)));
}

function assertHeaderMap(value) {
  if (!isRecord(value)) throw new Error('Invalid headers');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('Too many headers');
  let bytes = 0;
  for (const [name, values] of entries) {
    if (!HEADER_NAME.test(name) || !Array.isArray(values) || values.length > 32) throw new Error('Invalid headers');
    for (const item of values) {
      if (typeof item !== 'string' || item.length > 16384 || /[\r\n\u0000]/.test(item)) throw new Error('Invalid headers');
      bytes += Buffer.byteLength(item);
    }
  }
  if (bytes > 131072) throw new Error('Headers too large');
  return value;
}

function sanitizeRequestHeaders(input, preserveForwarded = false) {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders(input.connection)]);
  const entries = [];
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined || blocked.has(name) || name === 'host' || name === 'content-length') continue;
    if (name.startsWith('x-synapseone-') || name.startsWith('x-synapsedx-')) continue;
    if (!preserveForwarded && (name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-real-ip' || name === 'x-request-id')) continue;
    entries.push([name, Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)]]);
  }
  return assertHeaderMap(Object.fromEntries(entries));
}

function sanitizeResponseHeaders(input) {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders(input.connection?.[0])]);
  const entries = [];
  for (const [rawName, values] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (blocked.has(name) || name === 'content-length' || name === 'content-encoding') continue;
    entries.push([name, values]);
  }
  return assertHeaderMap(Object.fromEntries(entries));
}

function upstreamTarget(upstream, requestPath) {
  const base = new URL(upstream);
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  // Concatenate onto the origin. Resolving a path beginning with // as a URL
  // reference would let the incoming request select a different upstream host.
  const target = new URL(`${base.origin}${basePath}${requestPath}`);
  if (target.origin !== base.origin || target.username || target.password) throw new Error('Invalid upstream target');
  return target.href;
}

module.exports = {
  assertHeaderMap,
  hasExactKeys,
  isRecord,
  normalizeServerUrl,
  normalizeUpstreamUrl,
  normalizeWsPath,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  upstreamTarget,
  validateConnectorId,
  validateConnectorToken,
};
