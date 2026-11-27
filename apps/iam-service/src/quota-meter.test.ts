// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import {
  QuotaMeter, createQuotaRedis, quotaKeys, quotaWindows, validateQuotaCheck,
  type QuotaCheckInput,
} from './quota-meter';

const input: QuotaCheckInput = {
  subject: 'org:00000000-0000-4000-8000-000000000001',
  service: 'ai',
  limits: { minute: 100, fiveHour: 100, day: 100 },
};

describe('fixed quota windows', () => {
  it('uses epoch minute/five-hour buckets and UTC calendar-day buckets', () => {
    const now = Date.parse('2026-11-26T23:59:59.999Z');
    const windows = quotaWindows(now);
    assert.equal(windows[0].bucket, String(Math.floor(now / 1000 / 60) * 60));
    assert.equal(windows[1].bucket, String(Math.floor(now / 1000 / 18_000) * 18_000));
    assert.equal(windows[2].bucket, '2026-11-26');
    assert.equal(new Date(windows[2].resetAtSeconds * 1000).toISOString(), '2026-11-27T00:00:00.000Z');
    assert.equal(quotaWindows(Date.parse('2026-11-27T00:00:00.000Z'))[2].bucket, '2026-11-27');
    assert.ok(windows.every((window) => window.ttlSeconds > 0));
  });

  it('captures Date.now once across keys, TTLs, reset metadata and ARGV', async () => {
    const boundary = Date.parse('2026-11-26T13:00:00.000Z');
    const original = Date.now;
    let samples = 0;
    Date.now = () => (++samples === 1 ? boundary - 1 : boundary);
    let captured: { keys: string[]; args: string[] } | null = null;
    const fake = {
      status: 'ready',
      async eval(_script: string, _count: number, ...args: Array<string | number>) {
        const keys = args.slice(0, 3).map(String);
        const values = args.slice(3).map(String);
        captured = { keys, args: values };
        return [1, 0, 1, values[0], 0, values[6]];
      },
    };
    try {
      await new QuotaMeter(fake).check(input);
      assert.equal(samples, 1, 'production path must sample the clock exactly once');
      const value = captured as unknown as { keys: string[]; args: string[] };
      const minuteStart = Math.floor((boundary - 1) / 1000 / 60) * 60;
      assert.ok(value.keys[0].endsWith(`:minute:${minuteStart}`));
      assert.equal(value.args[3], '2', 'TTL includes the one-second expiry safety margin from the same captured instant');
      assert.equal(value.args[6], String(minuteStart + 60));
      assert.equal(value.args[9], String(Math.floor((boundary - 1) / 1000)));
    } finally {
      Date.now = original;
    }
  });

  it('uses the versioned service/subject/window namespace', () => {
    const keys = quotaKeys(input, Date.parse('2026-11-26T00:00:00.000Z'));
    assert.equal(keys[0], `quota:v1:ai:${input.subject}:minute:${quotaWindows(Date.parse('2026-11-26T00:00:00.000Z'))[0].bucket}`);
    assert.ok(keys[1].includes(':fiveHour:'));
    assert.ok(keys[2].endsWith(':day:2026-11-26'));
  });

  it('validates subject, service and all three positive integer limits', () => {
    assert.deepEqual(validateQuotaCheck(input), input);
    assert.equal(validateQuotaCheck({ ...input, subject: '../secret' }), null);
    assert.equal(validateQuotaCheck({ ...input, service: 'ocs' }), null);
    assert.equal(validateQuotaCheck({ ...input, limits: { minute: 1, fiveHour: 1.5, day: 10 } }), null);
    assert.equal(validateQuotaCheck({ ...input, limits: { minute: 1, fiveHour: 10 } }), null);
  });

  it('fails explicitly when Valkey is unavailable', async () => {
    await assert.rejects(() => new QuotaMeter(null).check(input), /quota_store_unavailable/);
  });
});

const valkeyUrl = process.env.IAM_TEST_VALKEY_URL;
describe('atomic Valkey multi-window admission', { skip: !valkeyUrl }, () => {
  let redis: Redis;
  let meter: QuotaMeter;
  const now = Date.parse('2026-11-26T12:34:56.000Z');
  const prefix = `quota-test-${randomUUID()}`;
  const ownedKeys = new Set<string>();
  const track = (...keys: string[]) => keys.forEach((key) => ownedKeys.add(key));

  before(async () => {
    redis = new Redis(valkeyUrl!, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        redis.once('ready', () => resolve());
        redis.once('error', reject);
      });
    }
    meter = new QuotaMeter(redis);
  });
  after(async () => {
    // Never FLUSHDB: an opt-in URL may be misconfigured. Delete only keys this
    // suite created, using its random per-run subject prefix.
    if (ownedKeys.size) await redis.del(...ownedKeys);
    await redis.quit();
  });

  it('rejects at the minute limit without incrementing any window', async () => {
    const check: QuotaCheckInput = { ...input, subject: `${prefix}:minute`, limits: { minute: 2, fiveHour: 10, day: 20 } };
    const keys = quotaKeys(check, now);
    track(...keys);
    assert.equal((await meter.check(check, now)).allowed, true);
    assert.equal((await meter.check(check, now)).allowed, true);
    const denied = await meter.check(check, now);
    assert.equal(denied.allowed, false);
    assert.equal(denied.window, 'minute');
    assert.equal(denied.count, 2);
    assert.equal(denied.limit, 2);
    assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60);
    assert.deepEqual(await Promise.all(keys.map((key) => redis.get(key))), ['2', '2', '2']);
  });

  it('binds five-hour and day denials and preserves all counters', async () => {
    const five: QuotaCheckInput = { ...input, subject: `${prefix}:five`, limits: { minute: 100, fiveHour: 2, day: 100 } };
    const fiveKeys = quotaKeys(five, now);
    track(...fiveKeys);
    await meter.check(five, now);
    await meter.check(five, now);
    const deniedFive = await meter.check(five, now);
    assert.equal(deniedFive.allowed, false);
    assert.equal(deniedFive.window, 'fiveHour');
    assert.ok(deniedFive.retryAfterSeconds > 60 && deniedFive.retryAfterSeconds <= 18_000);
    assert.deepEqual(await Promise.all(fiveKeys.map((key) => redis.get(key))), ['2', '2', '2']);

    const day: QuotaCheckInput = { ...input, subject: `${prefix}:day`, limits: { minute: 100, fiveHour: 100, day: 1 } };
    const dayKeys = quotaKeys(day, now);
    track(...dayKeys);
    await meter.check(day, now);
    const deniedDay = await meter.check(day, now);
    assert.equal(deniedDay.allowed, false);
    assert.equal(deniedDay.window, 'day');
    assert.ok(deniedDay.retryAfterSeconds > 0 && deniedDay.retryAfterSeconds <= 86_400);
    assert.deepEqual(await Promise.all(dayKeys.map((key) => redis.get(key))), ['1', '1', '1']);
  });

  it('admits exactly the limit under concurrent requests and sets TTLs', async () => {
    const check: QuotaCheckInput = { ...input, subject: `${prefix}:concurrent`, limits: { minute: 7, fiveHour: 100, day: 100 } };
    const keys = quotaKeys(check, now);
    track(...keys);
    const results = await Promise.all(Array.from({ length: 30 }, () => meter.check(check, now)));
    assert.equal(results.filter((result) => result.allowed).length, 7);
    assert.deepEqual(await Promise.all(keys.map((key) => redis.get(key))), ['7', '7', '7']);
    const ttls = await Promise.all(keys.map((key) => redis.ttl(key)));
    assert.ok(ttls[0] > 0 && ttls[0] <= 60);
    assert.ok(ttls[1] > 60 && ttls[1] <= 18_000);
    assert.ok(ttls[2] > 60 && ttls[2] <= 86_400);
  });

  it('atomically shares execution limits across normal and MCP admissions', async () => {
    const subject = `${prefix}:executions`;
    const hourKey = `quota:v1:workflow:${subject}:executionHour:${Math.floor(now / 1000 / 3600) * 3600}`;
    const concurrentKey = `quota:v1:workflow:${subject}:concurrent`;
    track(hourKey, concurrentKey);
    const limits = { hour: 3, concurrent: 1 };
    const normal = await meter.admitExecution({ subject, limits }, now);
    assert.equal(normal.allowed, true);
    assert.ok(normal.token);
    const mcpConcurrentDenied = await meter.admitExecution({ subject, limits }, now);
    assert.equal(mcpConcurrentDenied.allowed, false);
    assert.equal(mcpConcurrentDenied.window, 'concurrent');
    assert.equal(await meter.releaseExecution(subject, 'not-the-token'), false);
    assert.equal(await meter.releaseExecution(subject, normal.token!), true);
    const mcp = await meter.admitExecution({ subject, limits }, now);
    assert.equal(mcp.allowed, true);
    assert.equal(await meter.releaseExecution(subject, mcp.token!), true);
    const normalAgain = await meter.admitExecution({ subject, limits }, now);
    assert.equal(normalAgain.allowed, true);
    assert.equal(await meter.releaseExecution(subject, normalAgain.token!), true);
    const mcpHourlyDenied = await meter.admitExecution({ subject, limits }, now);
    assert.equal(mcpHourlyDenied.allowed, false);
    assert.equal(mcpHourlyDenied.window, 'hour');
  });

  it('reconnects after a transient connection loss and resumes admission', async () => {
    const recovering = createQuotaRedis(valkeyUrl!);
    const recoveryMeter = new QuotaMeter(recovering);
    try {
      await recovering.connect();
      const check: QuotaCheckInput = { ...input, subject: `${prefix}:recovery`, limits: { minute: 2, fiveHour: 10, day: 20 } };
      const firstNow = Date.now();
      track(...quotaKeys(check, firstNow));
      assert.equal((await recoveryMeter.check(check, firstNow)).allowed, true);
      recovering.stream.destroy();
      const deadline = Date.now() + 8_000;
      while ((recovering.status !== 'ready' || !recovering.stream.writable) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(recovering.status, 'ready', 'capped retry strategy must reconnect');
      assert.equal(recovering.stream.writable, true, 'reconnected stream is writable');
      const secondNow = Date.now();
      track(...quotaKeys(check, secondNow));
      let resumed = false;
      for (let attempt = 0; attempt < 20 && !resumed; attempt++) {
        try {
          resumed = (await recoveryMeter.check(check, secondNow)).allowed;
        } catch (e: any) {
          if (!/Stream isn't writeable/.test(String(e?.message))) throw e;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(resumed, true, 'admission resumes after reconnect');
      assert.ok(recoveryMeter.health().checks >= 2);
    } finally {
      recovering.disconnect();
    }
  });
});
