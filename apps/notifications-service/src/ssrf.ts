// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SSRF guard for tenant-controlled outbound webhook URLs.
 *
 * Mirrors the workflow engine guard: the host string is normalized and every
 * resolved address is checked (DNS rebinding), so neither literal private IPs
 * nor public names that resolve to internal addresses can reach the Docker
 * network or the cloud metadata endpoint.
 */
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

const BLOCKED_EXACT_HOSTS = new Set([
  'localhost', 'metadata.google.internal',
  'iam', 'gateway', 'workflow', 'postgres', 'valkey', 'redis', 'n8n', 's3', 'minio',
  'ocs', 'base', 'lds', 'faststore', 'queue', 'stream', 'notifications',
  'inference', 'ai', 'console', 'authentik-server', 'authentik-worker',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.cluster.local', '.invalid'];

function stripHost(host: string): string {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.$/, '');
}

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** RFC1918 + loopback + link-local (incl. cloud metadata) + CGNAT + reserved. */
function isPrivateIPv4Parts(p: number[]): boolean {
  const [a, b, c] = p;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  return !parts || isPrivateIPv4Parts(parts);
}

/** Expand the trailing dotted-quad of `::ffff:127.0.0.1` into hextets. */
function expandDottedIPv6(ip: string): string | null {
  const idx = ip.lastIndexOf(':');
  if (idx < 0) return null;
  const head = ip.slice(0, idx);
  const parts = ipv4Parts(ip.slice(idx + 1));
  if (!parts) return null;
  const h1 = (((parts[0] << 8) | parts[1]) >>> 0).toString(16);
  const h2 = (((parts[2] << 8) | parts[3]) >>> 0).toString(16);
  return `${head}:${h1}:${h2}`;
}

function ipv6Hextets(ip: string): number[] | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const side = (s: string): string[] | null => {
    if (!s) return [];
    const chunks = s.split(':');
    if (chunks.some((ch) => !/^[0-9a-f]{1,4}$/i.test(ch))) return null;
    return chunks;
  };
  const head = side(parts[0]);
  const tail = parts.length === 2 ? side(parts[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (parts.length === 2) {
    if (missing < 1) return null;
  } else if (head.length !== 8) {
    return null;
  }
  const all = [...head, ...new Array(Math.max(missing, 0)).fill('0'), ...tail];
  if (all.length !== 8) return null;
  return all.map((h) => parseInt(h, 16));
}

function isPrivateIPv6(raw: string): boolean {
  const ip = String(raw || '').toLowerCase();
  const normalized = ip.includes('.') ? expandDottedIPv6(ip) : ip;
  if (!normalized) return true;
  const h = ipv6Hextets(normalized);
  if (!h) return true; // unparseable IPv6 literal → block (fail closed)
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  if (h.every((x) => x === 0)) return true; // ::
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) return true; // ::1
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h0 === 0x2002) return true; // 2002::/16 6to4
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return isPrivateIPv4Parts([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isPrivateIPv4Parts([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true;
  return false;
}

/** True when the hostname is a literal private/reserved IP or internal name. */
export function isBlockedHost(host: string): boolean {
  const h = stripHost(host);
  if (!h) return true;
  const kind = isIP(h);
  if (kind === 4) return isPrivateIPv4(h);
  if (kind === 6) return isPrivateIPv6(h);
  if (BLOCKED_EXACT_HOSTS.has(h)) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  return BLOCKED_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

export function isBlockedUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (u.username || u.password) return true;
  return isBlockedHost(u.hostname);
}

export type HostResolver = (host: string) => Promise<string[]>;

async function defaultResolveHost(host: string): Promise<string[]> {
  const recs = await dns.lookup(host, { all: true });
  return recs.map((r) => r.address);
}

/** Runtime SSRF check: sync host guard + DNS resolution of the hostname. */
export async function assertWebhookUrlAllowed(raw: string, resolveHost: HostResolver = defaultResolveHost): Promise<void> {
  if (isBlockedUrl(raw)) throw new Error(`blocked internal webhook URL (${String(raw).slice(0, 120)})`);
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`invalid webhook URL (${String(raw).slice(0, 120)})`);
  }
  const host = stripHost(u.hostname);
  if (isIP(host)) return; // literal already checked
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    return; // NXDOMAIN/offline: fetch fails the same way
  }
  for (const a of addresses) {
    const ip = stripHost(a);
    if (isIP(ip) === 0 || isBlockedHost(ip)) {
      throw new Error(`blocked internal webhook URL (${host} resolved to ${ip})`);
    }
  }
}
