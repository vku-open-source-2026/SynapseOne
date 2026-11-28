// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import DNS from 'dns2';

interface StartedProcess {
  child: ChildProcess;
  apiPort: number;
  dnsPort: number;
  output: string;
}

async function waitForStart(child: ChildProcess, timeoutMs = 5000): Promise<StartedProcess> {
  let output = '';
  return new Promise((resolveStarted, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for service startup: ${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.message !== 'service_started') continue;
        const dnsMatch = /127\.0\.0\.1:(\d+)\/udp/.exec(String(event.dns));
        const apiMatch = /127\.0\.0\.1:(\d+)$/.exec(String(event.api));
        if (!dnsMatch || !apiMatch) continue;
        cleanup();
        resolveStarted({ child, apiPort: Number(apiMatch[1]), dnsPort: Number(dnsMatch[1]), output });
        return;
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Service exited before startup (${code ?? signal}): ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', onExit);
  });
}

test('production runtime starts both listeners, serves API/DNS, and shuts down cleanly', async (t) => {
  const directory = await mkdtemp(join(process.cwd(), '.test-data-'));
  const token = `runtime-test-${'x'.repeat(32)}`;
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SYNAPSEONE_ENV: '',
      SYNAPSEDX_ENV: '',
      APP_ENV: '',
      ENVIRONMENT: '',
      SYNAPSEDNS_ALLOW_INSECURE: 'false',
      SYNAPSEDNS_ADMIN_TOKEN: token,
      SYNAPSEDNS_DNS_HOST: '127.0.0.1',
      SYNAPSEDNS_DNS_PORT: '0',
      SYNAPSEDNS_API_HOST: '127.0.0.1',
      SYNAPSEDNS_API_PORT: '0',
      SYNAPSEDNS_DATA_FILE: join(directory, 'synapsedns.json'),
      SYNAPSEDNS_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });

  const started = await waitForStart(child);
  assert.equal(started.output.includes(token), false);
  const base = `http://127.0.0.1:${started.apiPort}`;
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  assert.equal((await fetch(`${base}/v1/zones`)).status, 401);
  const createdZone = await fetch(`${base}/v1/zones`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'runtime.test' }),
  });
  assert.equal(createdZone.status, 201);
  const createdRecord = await fetch(`${base}/v1/zones/runtime.test/records`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'A', name: 'www.runtime.test', address: '192.0.2.42' }),
  });
  assert.equal(createdRecord.status, 201);

  const query = DNS.UDPClient({ dns: '127.0.0.1', port: started.dnsPort, timeout: 3000 });
  const answer = await query('www.runtime.test', 'A');
  assert.equal(answer.header.aa, 1);
  assert.equal(answer.header.ra, 0);
  assert.equal(answer.answers[0].address, '192.0.2.42');

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('production runtime without an admin token exits before opening listeners', async () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SYNAPSEONE_ENV: '',
      SYNAPSEDX_ENV: '',
      APP_ENV: '',
      ENVIRONMENT: '',
      SYNAPSEDNS_ALLOW_INSECURE: 'false',
      SYNAPSEDNS_ADMIN_TOKEN: '',
      SYNAPSEDNS_DNS_PORT: '0',
      SYNAPSEDNS_API_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /configuration_error/);
  assert.match(output, /SYNAPSEDNS_ADMIN_TOKEN/);
});
