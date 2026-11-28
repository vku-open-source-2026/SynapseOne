// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import DNS from 'dns2';
import { answerDnsRequest, AuthoritativeDnsServer, RCODE } from './dns-server';
import { silentLogger } from './logger';
import { ZoneStore } from './store';

test('authoritative DNS semantics are identical over real UDP and TCP', async (t) => {
  const store = new ZoneStore({ memory: true });
  const zone = await store.createZone({ name: 'Example.Test' });
  const reverse = await store.createZone({ name: '2.0.192.in-addr.arpa' });
  const inputs = [
    { type: 'A', name: 'www.example.test', address: '192.0.2.10', ttl: 60 },
    { type: 'AAAA', name: 'www.example.test', address: '2001:db8::10', ttl: 60 },
    { type: 'CNAME', name: 'alias.example.test', target: 'www.example.test' },
    { type: 'CNAME', name: 'chain.example.test', target: 'alias.example.test' },
    { type: 'CNAME', name: 'outside.example.test', target: 'www.external.test' },
    { type: 'MX', name: 'example.test', priority: 10, target: 'mail.external.test' },
    { type: 'TXT', name: 'txt.example.test', data: ['v=spf1 -all', 'second-string'] },
    { type: 'SRV', name: '_sip._tcp.example.test', priority: 1, weight: 2, port: 5060, target: 'sip.example.test' },
    { type: 'CAA', name: 'example.test', flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    { type: 'A', name: '*.wild.example.test', address: '192.0.2.50' },
    { type: 'CNAME', name: '*.cname.example.test', target: 'www.example.test' },
    { type: 'TXT', name: 'blocked.wild.example.test', data: 'blocks-wildcard' },
    { type: 'A', name: 'branch.wild.example.test', address: '192.0.2.60' },
    { type: 'A', name: 'www.tenant.example.test', address: '192.0.2.70' },
    { type: 'NS', name: 'sub.example.test', target: 'ns.sub.example.test' },
    { type: 'A', name: 'ns.sub.example.test', address: '192.0.2.80' },
  ] as const;
  for (const input of inputs) await store.createRecord(zone.name, input as never);
  await store.createRecord(reverse.name, { type: 'PTR', name: '10.2.0.192.in-addr.arpa', target: 'www.example.test' });
  for (let index = 0; index < 40; index++) {
    await store.createRecord(zone.name, { type: 'A', name: 'many.example.test', address: `192.0.2.${100 + index}` });
  }

  const server = new AuthoritativeDnsServer(store, { host: '127.0.0.1', port: 0 }, silentLogger);
  const addresses = await server.listen();
  t.after(() => server.close());
  assert.equal(addresses.udp.port, addresses.tcp.port);
  assert.ok(addresses.udp.port > 0);

  const clients = [
    { transport: 'UDP', query: DNS.UDPClient({ dns: '127.0.0.1', port: addresses.udp.port, timeout: 3000 }) },
    { transport: 'TCP', query: DNS.TCPClient({ dns: '127.0.0.1', port: addresses.tcp.port }) },
  ];

  for (const client of clients) {
    const exact = await client.query('WWW.Example.Test.', 'A');
    assert.equal(exact.header.aa, 1, client.transport);
    assert.equal(exact.header.ra, 0, client.transport);
    assert.equal(exact.header.rd, 1, client.transport);
    assert.equal(exact.header.rcode, RCODE.NOERROR);
    assert.equal(exact.answers.length, 1);
    assert.equal(exact.answers[0].name.toLowerCase(), 'www.example.test');
    assert.equal(exact.answers[0].address, '192.0.2.10');
    assert.equal(exact.answers[0].ttl, 60);

    const ipv6 = await client.query('www.example.test', 'AAAA');
    assert.equal(ipv6.answers[0].address, '2001:db8::10');

    const wildcard = await client.query('one.two.wild.example.test', 'A');
    assert.equal(wildcard.header.rcode, RCODE.NOERROR);
    assert.equal(wildcard.answers[0].name, 'one.two.wild.example.test');
    assert.equal(wildcard.answers[0].address, '192.0.2.50');

    const wildcardCname = await client.query('host.cname.example.test', 'A');
    assert.deepEqual(wildcardCname.answers.map((answer) => answer.type), [DNS.Packet.TYPE.CNAME, DNS.Packet.TYPE.A]);
    assert.equal(wildcardCname.answers[0].name, 'host.cname.example.test');
    assert.equal(wildcardCname.answers[1].name, 'www.example.test');
    const wildcardOwner = await client.query('cname.example.test', 'A');
    assert.equal(wildcardOwner.header.rcode, RCODE.NOERROR);
    assert.equal(wildcardOwner.answers.length, 0, 'a wildcard does not synthesize its closest-encloser owner');

    const nxdomain = await client.query('missing.example.test', 'A');
    assert.equal(nxdomain.header.rcode, RCODE.NXDOMAIN);
    assert.equal(nxdomain.header.aa, 1);
    assert.equal(nxdomain.answers.length, 0);
    assert.equal(nxdomain.authorities.length, 1);
    assert.equal(nxdomain.authorities[0].type, DNS.Packet.TYPE.SOA);
    assert.equal(nxdomain.authorities[0].name, 'example.test');

    const nodata = await client.query('www.example.test', 'MX');
    assert.equal(nodata.header.rcode, RCODE.NOERROR);
    assert.equal(nodata.header.aa, 1);
    assert.equal(nodata.answers.length, 0);
    assert.equal(nodata.authorities[0].type, DNS.Packet.TYPE.SOA);

    const refused = await client.query('www.unknown.test', 'A');
    assert.equal(refused.header.rcode, RCODE.REFUSED);
    assert.equal(refused.header.aa, 0);
    assert.equal(refused.header.ra, 0);
    assert.equal(refused.answers.length, 0);

    const chain = await client.query('chain.example.test', 'A');
    assert.deepEqual(chain.answers.map((answer) => answer.type), [DNS.Packet.TYPE.CNAME, DNS.Packet.TYPE.CNAME, DNS.Packet.TYPE.A]);
    assert.deepEqual(chain.answers.map((answer) => answer.name), ['chain.example.test', 'alias.example.test', 'www.example.test']);
    const external = await client.query('outside.example.test', 'A');
    assert.equal(external.answers.length, 1);
    assert.equal(external.answers[0].type, DNS.Packet.TYPE.CNAME);

    const txt = await client.query('txt.example.test', 'TXT');
    assert.deepEqual(txt.answers[0].data, ['v=spf1 -all', 'second-string']);
    const mx = await client.query('example.test', 'MX');
    assert.equal(mx.answers[0].priority, 10);
    assert.equal(mx.answers[0].exchange, 'mail.external.test');
    const srv = await client.query('_sip._tcp.example.test', 'SRV');
    assert.equal(srv.answers[0].priority, 1);
    assert.equal(srv.answers[0].weight, 2);
    assert.equal(srv.answers[0].port, 5060);
    assert.equal(srv.answers[0].target, 'sip.example.test');
    const caa = await client.query('example.test', 'CAA');
    assert.equal(caa.answers[0].flags, 0);
    assert.equal(caa.answers[0].tag, 'issue');
    assert.equal(caa.answers[0].value, 'letsencrypt.org');
    const ptr = await client.query('10.2.0.192.in-addr.arpa', 'PTR');
    assert.equal(ptr.answers[0].domain, 'www.example.test');

    const apexNs = await client.query('example.test', 'NS');
    assert.equal(apexNs.header.aa, 1);
    assert.equal(apexNs.answers.length, 2);
    assert.ok(apexNs.answers.every((answer) => answer.type === DNS.Packet.TYPE.NS));
    const apexSoa = await client.query('example.test', 'SOA');
    assert.equal(apexSoa.header.aa, 1);
    assert.equal(apexSoa.answers[0].type, DNS.Packet.TYPE.SOA);

    const any = await client.query('example.test', 'ANY');
    assert.ok(any.answers.some((answer) => answer.type === DNS.Packet.TYPE.SOA));
    assert.ok(any.answers.some((answer) => answer.type === DNS.Packet.TYPE.NS));
    assert.ok(any.answers.some((answer) => answer.type === DNS.Packet.TYPE.CAA));
  }

  const udp = clients[0].query;
  const blocked = await udp('blocked.wild.example.test', 'A');
  assert.equal(blocked.header.rcode, RCODE.NOERROR);
  assert.equal(blocked.answers.length, 0, 'an exact next-closer name suppresses the wildcard');
  assert.equal(blocked.authorities[0].type, DNS.Packet.TYPE.SOA);
  const belowCloser = await udp('host.branch.wild.example.test', 'A');
  assert.equal(belowCloser.header.rcode, RCODE.NXDOMAIN);
  const emptyNonTerminal = await udp('tenant.example.test', 'A');
  assert.equal(emptyNonTerminal.header.rcode, RCODE.NOERROR);
  assert.equal(emptyNonTerminal.answers.length, 0);

  const nonIn = await udp('www.example.test', 'A', DNS.Packet.CLASS.CH);
  assert.equal(nonIn.header.rcode, RCODE.REFUSED);
  const transfer = await udp('example.test', 'AXFR');
  assert.equal(transfer.header.rcode, RCODE.NOTAUTH);

  const referral = await udp('host.sub.example.test', 'A');
  assert.equal(referral.header.aa, 0);
  assert.equal(referral.header.rcode, RCODE.NOERROR);
  assert.equal(referral.answers.length, 0);
  assert.equal(referral.authorities[0].type, DNS.Packet.TYPE.NS);
  assert.equal(referral.authorities[0].name, 'sub.example.test');
  assert.equal(referral.additionals[0].address, '192.0.2.80');
  const delegationNs = await udp('sub.example.test', 'NS');
  assert.equal(delegationNs.header.aa, 1);
  assert.equal(delegationNs.answers.length, 1);

  const udpWithoutRetry = DNS.UDPClient({ dns: '127.0.0.1', port: addresses.udp.port, retryOverTCP: false, timeout: 3000 });
  const truncated = await udpWithoutRetry('many.example.test', 'A');
  assert.equal(truncated.header.tc, 1);
  assert.equal(truncated.answers.length, 0);
  const tcpFull = await clients[1].query('many.example.test', 'A');
  assert.equal(tcpFull.header.tc, 0);
  assert.equal(tcpFull.answers.length, 40);

  const malformed = new DNS.Packet();
  malformed.header.id = 123;
  assert.equal(answerDnsRequest(malformed, store).header.rcode, RCODE.FORMERR);
});
