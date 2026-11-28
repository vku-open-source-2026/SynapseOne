// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import DNS from 'dns2';
import type { AddressInfo } from 'node:net';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import type { ZoneStore } from './store';
import type { DnsRecord, RecordType, Zone } from './types';
import { isWithinZone, normalizeDnsName, recordRdataKey } from './validation';

const TYPE_CODES: Record<RecordType, number> = {
  A: DNS.Packet.TYPE.A,
  AAAA: DNS.Packet.TYPE.AAAA,
  CNAME: DNS.Packet.TYPE.CNAME,
  MX: DNS.Packet.TYPE.MX,
  TXT: DNS.Packet.TYPE.TXT,
  NS: DNS.Packet.TYPE.NS,
  SOA: DNS.Packet.TYPE.SOA,
  SRV: DNS.Packet.TYPE.SRV,
  CAA: DNS.Packet.TYPE.CAA,
  PTR: DNS.Packet.TYPE.PTR,
};

// dns2 3.0 exposes the wire constants but not the newer Packet.RCODE/typeName
// helpers. Keep the RFC values local so the service stays on Node 20.
export const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  REFUSED: 5,
  NOTAUTH: 9,
} as const;

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([name, code]) => [code, name]),
);

export interface DnsBindOptions {
  host: string;
  port: number;
}

export interface DnsAddresses {
  udp: AddressInfo;
  tcp: AddressInfo;
}

function responseFor(request: DNS.Packet, rcode: number, authoritative: boolean): DNS.Packet {
  const response = DNS.Packet.createResponseFromRequest(request);
  response.header.rcode = rcode;
  response.header.aa = authoritative ? 1 : 0;
  response.header.ra = 0;
  return response;
}

function resource(record: DnsRecord, owner = record.name): DNS.Packet.Resource {
  const result = new DNS.Packet.Resource({
    name: owner,
    type: TYPE_CODES[record.type],
    class: DNS.Packet.CLASS.IN,
    ttl: record.ttl,
  });
  switch (record.type) {
    case 'A':
    case 'AAAA':
      Object.assign(result, { address: record.address });
      break;
    case 'CNAME':
    case 'PTR':
      Object.assign(result, { domain: record.target });
      break;
    case 'NS':
      Object.assign(result, { ns: record.target });
      break;
    case 'MX':
      Object.assign(result, { priority: record.priority, exchange: record.target });
      break;
    case 'TXT':
      Object.assign(result, { data: record.data });
      break;
    case 'SOA':
      Object.assign(result, {
        primary: record.primary,
        admin: record.admin,
        serial: record.serial,
        refresh: record.refresh,
        retry: record.retry,
        expiration: record.expiration,
        minimum: record.minimum,
      });
      break;
    case 'SRV':
      Object.assign(result, {
        priority: record.priority,
        weight: record.weight,
        port: record.port,
        target: record.target,
      });
      break;
    case 'CAA':
      Object.assign(result, { flags: record.flags, tag: record.tag, value: record.value });
      break;
  }
  return result;
}

function nodeExists(zone: Pick<Zone, 'name' | 'records'>, name: string): boolean {
  return zone.records.some((record) => record.name === name || record.name.endsWith(`.${name}`));
}

interface Selection {
  records: DnsRecord[];
  exists: boolean;
}

/** RFC 4592 closest-encloser wildcard lookup, including empty non-terminals. */
function selectRecords(zone: Pick<Zone, 'name' | 'records'>, name: string): Selection {
  const exact = zone.records.filter((record) => record.name === name);
  if (exact.length) return { records: exact, exists: true };

  let closest = zone.name;
  let candidate = name;
  while (candidate !== zone.name) {
    if (nodeExists(zone, candidate)) {
      closest = candidate;
      break;
    }
    const dot = candidate.indexOf('.');
    candidate = dot < 0 ? zone.name : candidate.slice(dot + 1);
  }
  const wildcardName = `*.${closest}`;
  const wildcard = zone.records.filter((record) => record.name === wildcardName);
  // The wildcard replaces at least one label; it never synthesizes the
  // closest-encloser name itself (for example, *.foo does not answer foo).
  if (wildcard.length && closest !== name) return { records: wildcard, exists: true };
  return { records: [], exists: nodeExists(zone, name) };
}

function addSoa(response: DNS.Packet, zone: Pick<Zone, 'records'>): void {
  const soa = zone.records.find((record) => record.type === 'SOA');
  if (soa) response.authorities.push(resource(soa));
}

function addGlue(response: DNS.Packet, zone: Pick<Zone, 'name' | 'records'>, nsRecords: DnsRecord[]): void {
  const seen = new Set<string>();
  for (const ns of nsRecords) {
    if (ns.type !== 'NS' || !isWithinZone(ns.target, zone.name)) continue;
    for (const glue of zone.records) {
      if ((glue.type === 'A' || glue.type === 'AAAA') && glue.name === ns.target) {
        const key = `${glue.name}\0${recordRdataKey(glue)}`;
        if (!seen.has(key)) {
          seen.add(key);
          response.additionals.push(resource(glue));
        }
      }
    }
  }
}

function findDelegation(zone: Pick<Zone, 'name' | 'records'>, qname: string): DnsRecord[] | undefined {
  if (qname === zone.name) return undefined;
  const owners = [...new Set(zone.records
    .filter((record) => record.type === 'NS' && record.name !== zone.name && !record.name.startsWith('*.'))
    .map((record) => record.name))]
    .sort((a, b) => b.length - a.length);
  for (const owner of owners) {
    if (isWithinZone(qname, owner)) return zone.records.filter((record) => record.type === 'NS' && record.name === owner);
  }
  return undefined;
}

type CnameRecord = Extract<DnsRecord, { type: 'CNAME' }>;

function isCname(record: DnsRecord): record is CnameRecord {
  return record.type === 'CNAME';
}

function addCnameChain(
  response: DNS.Packet,
  zone: Pick<Zone, 'name' | 'records'>,
  first: CnameRecord,
  firstOwner: string,
  qtype: number,
): void {
  let current = first;
  let owner = firstOwner;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current.name)) return;
    seen.add(current.name);
    response.answers.push(resource(current, owner));
    if (qtype === DNS.Packet.TYPE.CNAME || qtype === DNS.Packet.TYPE.ANY) return;
    if (!isWithinZone(current.target, zone.name)) return;

    const target = selectRecords(zone, current.target).records;
    const cname = target.find(isCname);
    if (cname) {
      owner = current.target;
      current = cname;
      continue;
    }
    for (const record of target) {
      if (TYPE_CODES[record.type] === qtype) response.answers.push(resource(record, current.target));
    }
    return;
  }
}

/** Shared by UDP and TCP so both transports have identical DNS semantics. */
export function answerDnsRequest(request: DNS.Packet, store: ZoneStore): DNS.Packet {
  if (request.header.qr !== 0) return responseFor(request, RCODE.FORMERR, false);
  if (request.header.opcode !== 0 || request.questions.length !== 1 || ((request as DNS.Packet & { errors?: unknown[] }).errors?.length ?? 0) > 0) {
    return responseFor(request, RCODE.FORMERR, false);
  }
  const question = request.questions[0];
  if (question.class !== DNS.Packet.CLASS.IN) return responseFor(request, RCODE.REFUSED, false);

  let qname: string;
  try {
    qname = normalizeDnsName(question.name, { root: true, wildcard: true, underscores: true });
  } catch {
    return responseFor(request, RCODE.FORMERR, false);
  }
  const zone = store.lookupZone(qname);
  if (!zone) return responseFor(request, RCODE.REFUSED, false);
  if (question.type === DNS.Packet.TYPE.AXFR) return responseFor(request, RCODE.NOTAUTH, true);

  const delegation = findDelegation(zone, qname);
  if (delegation && qname !== delegation[0].name) {
    const referral = responseFor(request, RCODE.NOERROR, false);
    referral.authorities.push(...delegation.map((record) => resource(record)));
    addGlue(referral, zone, delegation);
    return referral;
  }
  if (delegation && question.type !== DNS.Packet.TYPE.NS && question.type !== DNS.Packet.TYPE.ANY) {
    const referral = responseFor(request, RCODE.NOERROR, false);
    referral.authorities.push(...delegation.map((record) => resource(record)));
    addGlue(referral, zone, delegation);
    return referral;
  }

  const selection = selectRecords(zone, qname);
  if (!selection.records.length) {
    const negative = responseFor(request, selection.exists ? RCODE.NOERROR : RCODE.NXDOMAIN, true);
    addSoa(negative, zone);
    return negative;
  }

  const response = responseFor(request, RCODE.NOERROR, true);
  if (question.type === DNS.Packet.TYPE.ANY) {
    response.answers.push(...selection.records.map((record) => resource(record, qname)));
  } else {
    const cname = selection.records.find(isCname);
    if (cname && question.type !== DNS.Packet.TYPE.CNAME) {
      addCnameChain(response, zone, cname, qname, question.type);
    } else {
      for (const record of selection.records) {
        if (TYPE_CODES[record.type] === question.type) response.answers.push(resource(record, qname));
      }
    }
  }

  const nsAnswers = response.answers.filter((answer) => answer.type === DNS.Packet.TYPE.NS);
  if (nsAnswers.length) {
    addGlue(response, zone, selection.records.filter((record) => record.type === 'NS'));
  }
  if (!response.answers.length && !response.authorities.length) addSoa(response, zone);
  return response;
}

export class AuthoritativeDnsServer {
  private udp?: DNS.UDPServer;
  private tcp?: DNS.TCPServer;
  private readonly logger: Logger;
  private addresses?: DnsAddresses;

  constructor(
    private readonly store: ZoneStore,
    private readonly options: DnsBindOptions,
    logger: Logger = silentLogger,
  ) {
    this.logger = logger;
  }

  get ready(): boolean {
    return this.addresses !== undefined;
  }

  get boundAddresses(): DnsAddresses | undefined {
    return this.addresses;
  }

  async listen(): Promise<DnsAddresses> {
    const handle: DNS.DnsHandler = (request, send) => {
      let response: DNS.Packet;
      try {
        response = answerDnsRequest(request, this.store);
      } catch (error) {
        this.logger.error('dns_request_failed', { error: error instanceof Error ? error.name : 'Error' });
        response = responseFor(request, RCODE.SERVFAIL, false);
      }
      this.logger.debug('dns_query', {
        id: request.header.id,
        type: request.questions[0] ? TYPE_NAMES[request.questions[0].type] ?? String(request.questions[0].type) : undefined,
        rcode: response.header.rcode,
      });
      void send(response).catch(() => this.logger.warn('dns_response_failed'));
    };

    const udp = DNS.createUDPServer(handle);
    this.udp = udp;
    udp.on('requestError', (error) => this.logger.warn('dns_udp_request_error', { error: error.name }));
    udp.on('error', (error) => this.logger.error('dns_udp_error', { error: error.name }));
    await new Promise<void>((resolveListening, reject) => {
      const onError = (error: Error) => reject(error);
      udp.once('error', onError);
      udp.listen(this.options.port, this.options.host).then(resolveListening, reject).finally(() => udp.off('error', onError));
    });
    const udpAddress = udp.address();
    if (!udpAddress || typeof udpAddress === 'string') throw new Error('UDP server did not return an address');

    const tcp = DNS.createTCPServer(handle);
    this.tcp = tcp;
    tcp.on('requestError', (error) => this.logger.warn('dns_tcp_request_error', { error: error.name }));
    tcp.on('error', (error) => this.logger.error('dns_tcp_error', { error: error.name }));
    try {
      await new Promise<void>((resolveListening, reject) => {
        tcp.once('error', reject);
        tcp.listen(udpAddress.port, this.options.host, () => resolveListening());
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    const tcpAddress = tcp.address();
    if (!tcpAddress || typeof tcpAddress === 'string') {
      await this.close();
      throw new Error('TCP server did not return an address');
    }
    this.addresses = { udp: udpAddress, tcp: tcpAddress };
    return this.addresses;
  }

  async close(): Promise<void> {
    this.addresses = undefined;
    const udp = this.udp;
    const tcp = this.tcp;
    this.udp = undefined;
    this.tcp = undefined;
    await Promise.all([
      udp ? new Promise<void>((resolveClosed) => {
        udp.once('close', () => resolveClosed());
        try { udp.close(); } catch { resolveClosed(); }
      }) : Promise.resolve(),
      tcp ? new Promise<void>((resolveClosed) => {
        if (!tcp.listening) return resolveClosed();
        tcp.close(() => resolveClosed());
      }) : Promise.resolve(),
    ]);
  }
}
