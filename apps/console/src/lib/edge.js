// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export const EDGE_ROOT = '/v1';

/** Tenant management routes exposed by the gateway. The standalone services
 * use the same resource suffixes on their own origins without this prefix. */
export function edgePath(service, path = '') {
  if (!['dns', 'tunnel'].includes(service)) throw new Error('Unknown edge service');
  const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  // Management resources already include the service's /v1 prefix. Health and
  // readiness paths do not. The gateway strips only /v1/<service>.
  return `${EDGE_ROOT}/${service}${suffix}`;
}

export function normalizeHostname(value) {
  const input = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!input || input.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(input)) {
    throw new Error('Enter a valid fully-qualified hostname, for example app.example.com');
  }
  return input;
}

export function zoneForHostname(hostname, zones = []) {
  const host = normalizeHostname(hostname);
  return (zones || [])
    .map((zone) => String(zone.name || '').toLowerCase().replace(/\.$/, ''))
    .filter((zone) => host === zone || host.endsWith(`.${zone}`))
    .sort((a, b) => b.length - a.length)[0] || null;
}

export function absoluteRecordName(value, zone) {
  const apex = String(zone || '').toLowerCase().replace(/\.$/, '');
  const name = String(value || '').trim().toLowerCase();
  if (!apex) throw new Error('A zone is required');
  if (!name || name === '@') return `${apex}.`;
  if (name.endsWith('.')) return name;
  if (name === apex || name.endsWith(`.${apex}`)) return `${name}.`;
  return `${name}.${apex}.`;
}

export function recordValue(record) {
  if (!record) return '';
  switch (record.type) {
    case 'A': case 'AAAA': return record.address;
    case 'CNAME': case 'NS': case 'PTR': return record.target;
    case 'MX': return `${record.priority} ${record.target}`;
    case 'TXT': return (record.data || []).join('\n');
    case 'SRV': return `${record.priority} ${record.weight} ${record.port} ${record.target}`;
    case 'CAA': return `${record.flags} ${record.tag} ${record.value}`;
    case 'SOA': return `${record.primary} ${record.admin} ${record.serial} ${record.refresh} ${record.retry} ${record.expiration} ${record.minimum}`;
    default: return '';
  }
}

function integer(value, fallback, min = 0, max = 65535) {
  const parsed = value === '' || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return parsed;
}

export function buildRecordInput(form, zone) {
  const type = String(form.type || 'A').toUpperCase();
  const name = absoluteRecordName(form.name, zone);
  const ttl = integer(form.ttl, 300, 1, 86400);
  const value = String(form.value || '').trim();
  if (!value) throw new Error('Record value is required');
  switch (type) {
    case 'A': case 'AAAA': return { type, name, ttl, address: value };
    case 'CNAME': case 'NS': case 'PTR': return { type, name, ttl, target: value };
    case 'MX': {
      const [priority, target] = value.split(/\s+/, 2);
      if (!target) throw new Error('MX requires a priority and target hostname');
      return { type, name, ttl, priority: integer(priority, 10, 0, 65535), target };
    }
    case 'TXT': return { type, name, ttl, data: value.split('\n').map((line) => line.trim()).filter(Boolean) };
    case 'SRV': {
      const [priority, weight, port, target] = value.split(/\s+/, 4);
      if (!target) throw new Error('SRV requires priority, weight, port and target');
      return { type, name, ttl, priority: integer(priority, 0), weight: integer(weight, 0), port: integer(port, 0), target };
    }
    case 'CAA': {
      const [flags, tag, ...rest] = value.split(/\s+/);
      if (!tag || !rest.length) throw new Error('CAA requires flags, tag and value');
      return { type, name, ttl, flags: integer(flags, 0, 0, 255), tag, value: rest.join(' ') };
    }
    default: throw new Error(`Unsupported record type ${type}`);
  }
}

/** Return `same` for an idempotent reuse, `conflict` when an address record
 * already occupies the owner name, or null when a new record can be created. */
export function addressRecordConflict(records, name, type, value) {
  const owner = String(name || '').toLowerCase();
  const existing = (records || []).filter((record) => String(record.name || '').toLowerCase() === owner);
  const address = existing.find((record) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (!address) return null;
  const sameType = address.type === type;
  const sameValue = sameType && String(address.address ?? address.target ?? '').replace(/\.$/, '').toLowerCase()
    === String(value || '').replace(/\.$/, '').toLowerCase();
  return sameValue ? 'same' : 'conflict';
}

export function publicHostname(origin) {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname : '';
  } catch {
    return '';
  }
}

export function defaultAddressRecord(origin) {
  const hostname = publicHostname(origin);
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) return { type: 'A', target: bare };
  if (bare.includes(':')) return { type: 'AAAA', target: bare };
  return { type: 'CNAME', target: hostname };
}

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function connectorScript(connectorId, publicOrigin) {
  if (!/^[0-9a-f-]{36}$/i.test(String(connectorId))) throw new Error('Invalid connector id');
  const url = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('A public ingress origin is required before running the connector');
  }
  return [
    '# Install once (Node.js 20+)',
    'npm install -g @synapseone/cli@latest',
    '',
    '# Paste the one-time token at the hidden prompt (not shell history)',
    'read -rsp "Connector token: " SYNAPSETUNNEL_CONNECTOR_TOKEN; echo',
    'export SYNAPSETUNNEL_CONNECTOR_TOKEN',
    `synapseone tunnel run ${shellQuote(connectorId)} --server-url ${shellQuote(url.origin)}`,
  ].join('\n');
}
