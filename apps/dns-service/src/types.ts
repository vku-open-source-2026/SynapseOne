// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export const RECORD_TYPES = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'NS',
  'SOA',
  'SRV',
  'CAA',
  'PTR',
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export interface RecordBase {
  id: string;
  /** Canonical lower-case fully-qualified name, including the trailing dot. */
  name: string;
  ttl: number;
  createdAt: string;
  updatedAt: string;
}

export type DnsRecord = RecordBase & (
  | { type: 'A'; address: string }
  | { type: 'AAAA'; address: string }
  | { type: 'CNAME'; target: string }
  | { type: 'MX'; priority: number; target: string }
  | { type: 'TXT'; data: string[] }
  | { type: 'NS'; target: string }
  | {
      type: 'SOA';
      primary: string;
      admin: string;
      serial: number;
      refresh: number;
      retry: number;
      expiration: number;
      minimum: number;
    }
  | { type: 'SRV'; priority: number; weight: number; port: number; target: string }
  | { type: 'CAA'; flags: number; tag: string; value: string }
  | { type: 'PTR'; target: string }
);

export interface Zone {
  id: string;
  /** Canonical lower-case fully-qualified zone apex, including the trailing dot. */
  name: string;
  createdAt: string;
  updatedAt: string;
  records: DnsRecord[];
}

export interface ZoneSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  recordCount: number;
}

export interface StoreSnapshot {
  version: 1;
  zones: Zone[];
}

export interface CreateZoneInput {
  name: string;
  nameservers?: string[];
  ttl?: number;
}

export interface RecordPatch {
  name?: string;
  ttl?: number;
  address?: string;
  target?: string;
  priority?: number;
  data?: string | string[];
  primary?: string;
  admin?: string;
  serial?: number;
  refresh?: number;
  retry?: number;
  expiration?: number;
  minimum?: number;
  weight?: number;
  port?: number;
  flags?: number;
  tag?: string;
  value?: string;
}

export type RecordInput =
  | { type: 'A'; name: string; ttl?: number; address: string }
  | { type: 'AAAA'; name: string; ttl?: number; address: string }
  | { type: 'CNAME'; name: string; ttl?: number; target: string }
  | { type: 'MX'; name: string; ttl?: number; priority: number; target: string }
  | { type: 'TXT'; name: string; ttl?: number; data: string | string[] }
  | { type: 'NS'; name: string; ttl?: number; target: string }
  | {
      type: 'SOA';
      name: string;
      ttl?: number;
      primary: string;
      admin: string;
      serial: number;
      refresh: number;
      retry: number;
      expiration: number;
      minimum: number;
    }
  | {
      type: 'SRV';
      name: string;
      ttl?: number;
      priority: number;
      weight: number;
      port: number;
      target: string;
    }
  | { type: 'CAA'; name: string; ttl?: number; flags: number; tag: string; value: string }
  | { type: 'PTR'; name: string; ttl?: number; target: string };
