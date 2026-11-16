// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseNotifications — tenant-scoped notification delivery (#25).
 *
 * Outbox + templates + preferences + retries/DLQ. Delivery adapters are HTTP
 * relays (email/SMS/push) plus direct webhooks, so no provider SDK is bundled.
 * With NOTIFICATIONS_QUEUE_URL set, delivery jobs travel through SynapseQueue
 * for at-least-once processing across replicas.
 */
import './env-compat';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import {
  createNotification, getNotification, listNotifications, cancelNotification,
  updateNotification, getPreference, setPreference, ensureTables, useDb, claimDue,
  type Channel, type NotificationRecord,
} from './db';
import { backoffSeconds, deliver, renderTemplate } from './delivery';

dotenv.config();

const PORT = Number(process.env.PORT || 4011);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_ATTEMPTS = Math.min(Math.max(Number(process.env.NOTIFICATIONS_MAX_ATTEMPTS || 5), 1), 20);
const RATE_LIMIT = Math.min(Math.max(Number(process.env.NOTIFICATIONS_RATE_LIMIT_PER_MIN || 120), 1), 100_000);
const CHANNELS: Channel[] = ['email', 'sms', 'webhook', 'push', 'log'];
const QUEUE_URL = (process.env.NOTIFICATIONS_QUEUE_URL || '').replace(/\/$/, '');
const QUEUE_NAME = process.env.NOTIFICATIONS_QUEUE_NAME || 'notifications';
const USE_QUEUE = QUEUE_URL !== '' && (process.env.NOTIFICATIONS_USE_QUEUE ?? 'true') !== 'false';

export function principalFromHeaders(req: express.Request): { sub?: string; org?: string; account?: string } | null {
  const h = (n: string): string => {
    const legacy = n.replace('x-synapseone-', 'x-synapsedx-');
    const v = req.headers[n] ?? req.headers[legacy];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const user = h('x-synapseone-user');
  const org = h('x-synapseone-org') || undefined;
  const account = h('x-synapseone-account') || undefined;
  if (user) return { sub: user, org, account };
  if (org || account) return { sub: account ? `apikey:${account}` : 'service', org, account };
  return null;
}

export function resolveTenant(req: express.Request): string | null {
  const p = principalFromHeaders(req);
  if (p?.org) return `org:${p.org}`;
  if (p?.account) return `account:${p.account}`;
  if (p?.sub) return `user:${p.sub}`;
  const raw = (req.headers['x-synapseone-tenant'] ?? req.headers['x-synapsedx-tenant'] ?? req.query.tenant) as string | string[] | undefined;
  const explicit = Array.isArray(raw) ? raw[0] : raw;
  if (explicit && /^[A-Za-z0-9_:.-]{1,128}$/.test(explicit)) return explicit;
  return null;
}

function verifyInternal(req: express.Request): boolean {
  const secret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  if (!secret) return false;
  const h = req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal'];
  const val = (Array.isArray(h) ? h[0] : h || '').trim();
  if (!val || val.length !== secret.length) return false;
  try { return timingSafeEqual(Buffer.from(val), Buffer.from(secret)); } catch { return false; }
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (!env.SYNAPSEONE_INTERNAL_SECRET) throw new Error('[notifications] SYNAPSEONE_INTERNAL_SECRET must be set in production.');
  if (!env.DATABASE_URL) throw new Error('[notifications] DATABASE_URL must be set in production (in-memory outbox would split-brain).');
  const origins = (env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length) throw new Error('[notifications] CORS_ORIGIN must be set in production.');
}

function recipientKey(recipient: Record<string, string>): string {
  return recipient.userId ? `user:${recipient.userId}` : (recipient.email || recipient.phone || recipient.url || recipient.webhookUrl || recipient.pushToken || 'unknown');
}

function renderBody(body: string, data: Record<string, unknown>): string {
  // Templates are plain `{{var}}`; keep the raw body when no data is supplied.
  return Object.keys(data || {}).length ? renderTemplate(body, data) : renderTemplate(body, {});
}

/** Delivery worker: claims due rows, honours preferences, retries with backoff. */
export async function processDueOnce(limit = 20): Promise<{ processed: number; delivered: number; failed: number }> {
  const due = await claimDue(limit);
  let delivered = 0;
  let failed = 0;
  for (const n of due) {
    const pref = await getPreference(n.tenant, recipientKey(n.recipient));
    if (pref?.unsubscribed || (pref && pref.channels.length && !pref.channels.includes(n.channel))) {
      await updateNotification(n.id, { status: 'cancelled', deadReason: 'recipient_unsubscribed' });
      continue;
    }
    const result = await deliver(n);
    const attempts = [...n.attempts, { at: new Date().toISOString(), ok: result.ok, ...(result.error ? { error: result.error } : {}) }];
    if (result.ok) {
      delivered++;
      await updateNotification(n.id, { status: 'delivered', attempts });
    } else {
      failed++;
      const dead = attempts.length >= MAX_ATTEMPTS;
      await updateNotification(n.id, {
        status: dead ? 'dead' : 'failed',
        attempts,
        nextAttemptAt: new Date(Date.now() + backoffSeconds(attempts.length) * 1000).toISOString(),
        deadReason: dead ? result.error || 'max attempts exceeded' : null,
      });
    }
  }
  return { processed: due.length, delivered, failed };
}

async function queueCall(path: string, body: unknown, tenant = 'notifications-outbox'): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-synapseone-tenant': tenant };
  if (process.env.SYNAPSEONE_INTERNAL_SECRET) headers['x-synapseone-internal'] = process.env.SYNAPSEONE_INTERNAL_SECRET;
  const r = await fetch(`${QUEUE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`queue ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function publishToQueue(n: NotificationRecord): Promise<boolean> {
  if (!USE_QUEUE) return false;
  try {
    await queueCall(`/v1/queue/queues/${encodeURIComponent(QUEUE_NAME)}/messages`, {
      payload: { notificationId: n.id, tenant: n.tenant },
      headers: { notificationId: n.id },
    });
    return true;
  } catch (e: any) {
    console.error('[notifications] queue publish failed, falling back to local worker:', e?.message || e);
    return false;
  }
}

async function consumeFromQueue(consumer: string): Promise<void> {
  let page: any;
  try {
    page = await queueCall(`/v1/queue/queues/${encodeURIComponent(QUEUE_NAME)}/consume`, {
      maxMessages: 20,
      visibilityTimeoutSeconds: 60,
      consumer,
    });
  } catch (e: any) {
    console.error('[notifications] queue consume failed:', e?.message || e);
    return;
  }
  for (const item of page.messages || []) {
    const receipt = item.receipt;
    // SynapseQueue returns apiMessage() fields at the top level (payload,
    // headers, ...). Accept the legacy nested shape too so a rolling deploy
    // cannot silently drop deliveries.
    const payload = item.payload ?? item.message?.payload ?? {};
    const notification = await getNotification(payload.tenant, payload.notificationId);
    if (!notification) {
      await queueCall(`/v1/queue/queues/${encodeURIComponent(QUEUE_NAME)}/ack`, { receipt }).catch(() => undefined);
      continue;
    }
    const pref = await getPreference(notification.tenant, recipientKey(notification.recipient));
    if (pref?.unsubscribed) {
      await updateNotification(notification.id, { status: 'cancelled', deadReason: 'recipient_unsubscribed' });
      await queueCall(`/v1/queue/queues/${encodeURIComponent(QUEUE_NAME)}/ack`, { receipt }).catch(() => undefined);
      continue;
    }
    const result = await deliver(notification);
    const attempts = [...notification.attempts, { at: new Date().toISOString(), ok: result.ok, ...(result.error ? { error: result.error } : {}) }];
    if (result.ok) {
      await updateNotification(notification.id, { status: 'delivered', attempts });
      await queueCall(`/v1/queue/queues/${encodeURIComponent(QUEUE_NAME)}/ack`, { receipt }).catch(() => undefined);
    } else {
      await updateNotification(notification.id, { status: 'failed', attempts, deadReason: null });
      await queueCall(`/v1/queue/queues/${encodeURIComponent(QUEUE_NAME)}/nack`, {
        receipt, error: result.error || 'delivery failed', requeue: true,
      }).catch(() => undefined);
    }
  }
}

export function createApp(): express.Express {
  assertProductionConfig();
  const app = express();
  app.disable('x-powered-by');
  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length && !IS_PROD) console.warn('[notifications][security] CORS_ORIGIN not set — allowing all origins (dev default).');
  app.use(cors(origins.length ? { origin: origins } : undefined));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({
    service: 'notifications',
    status: 'ok',
    version: VERSION,
    store: useDb() ? 'postgres' : 'memory',
    delivery: USE_QUEUE ? 'queue' : 'local',
    channels: CHANNELS,
    time: new Date().toISOString(),
  }));
  app.get('/metrics', (_req, res) => {
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.send('# HELP synapseone_notifications_up Service up status\n# TYPE synapseone_notifications_up gauge\nsynapseone_notifications_up 1\n');
  });

  app.use('/v1/notifications', (req, res, next) => {
    if (IS_PROD && !verifyInternal(req)) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
    const tenant = resolveTenant(req);
    if (!tenant) return res.status(401).json({ error: 'tenant_required', message: 'Authenticated principal or x-synapseone-tenant required' });
    (req as any).tenant = tenant;
    next();
  });

  const rate = new Map<string, { n: number; reset: number }>();
  function rateLimited(tenant: string): boolean {
    const now = Date.now();
    const cur = rate.get(tenant);
    if (!cur || cur.reset < now) { rate.set(tenant, { n: 1, reset: now + 60_000 }); return false; }
    cur.n++;
    return cur.n > RATE_LIMIT;
  }

  app.post('/v1/notifications', async (req, res) => {
    const tenant = (req as any).tenant as string;
    if (rateLimited(tenant)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'rate_limited', message: `limit is ${RATE_LIMIT} notifications/minute` });
    }
    const b = (req.body || {}) as any;
    const recipient = b.recipient && typeof b.recipient === 'object' ? b.recipient : {};
    const channels: Channel[] = Array.isArray(b.channels)
      ? b.channels.map((c: any) => String(c).toLowerCase())
      : [b.channel ? String(b.channel).toLowerCase() : inferChannel(recipient)];
    if (!channels.length || channels.some((c) => !CHANNELS.includes(c as Channel))) {
      return res.status(400).json({ error: 'invalid_channels', message: `channels must be one of ${CHANNELS.join(',')}` });
    }
    const body = String(b.body ?? b.text ?? '').slice(0, 100_000);
    if (!body) return res.status(400).json({ error: 'body_required', message: 'body (or template) is required' });
    const subject = String(b.subject ?? '').slice(0, 500);
    const idempotencyKey = b.idempotencyKey ? String(b.idempotencyKey).slice(0, 200) : null;
    const out: NotificationRecord[] = [];
    for (const channel of channels as Channel[]) {
      const record = await createNotification({
        tenant,
        channel,
        recipient,
        subject,
        body: renderBody(body, b.data || {}),
        idempotencyKey: idempotencyKey ? `${channel}:${idempotencyKey}` : null,
        metadata: (b.data && typeof b.data === 'object' ? b.data : {}),
      });
      out.push(record);
      if (USE_QUEUE) await publishToQueue(record);
    }
    res.status(202).json({ notifications: out });
  });

  app.get('/v1/notifications', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'invalid_limit' });
    res.json(await listNotifications(tenant, { status, limit }));
  });

  app.get('/v1/notifications/:id', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const n = await getNotification(tenant, String(req.params.id));
    if (!n) return res.status(404).json({ error: 'not_found' });
    res.json(n);
  });

  app.post('/v1/notifications/:id/cancel', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const n = await cancelNotification(tenant, String(req.params.id));
    if (!n) return res.status(409).json({ error: 'not_cancellable', message: 'notification is not queued/failed or does not exist' });
    res.json(n);
  });

  // ---- preferences / unsubscribe ----
  app.get('/v1/notifications/preferences/:recipient', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const pref = await getPreference(tenant, String(req.params.recipient));
    res.json(pref || { tenant, recipient: String(req.params.recipient), channels: [], unsubscribed: false });
  });

  app.put('/v1/notifications/preferences/:recipient', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const b = (req.body || {}) as any;
    const channels = Array.isArray(b.channels) ? b.channels.map((c: any) => String(c).toLowerCase()) : [];
    if (channels.some((c: string) => !CHANNELS.includes(c as Channel))) return res.status(400).json({ error: 'invalid_channels' });
    res.json(await setPreference(tenant, String(req.params.recipient), channels as Channel[], !!b.unsubscribed));
  });

  app.post('/v1/notifications/unsubscribe', async (req, res) => {
    const tenant = (req as any).tenant as string;
    const recipient = String((req.body || {}).recipient || '');
    if (!recipient) return res.status(400).json({ error: 'recipient_required' });
    const prev = await getPreference(tenant, recipient);
    res.json(await setPreference(tenant, recipient, prev?.channels || [], true));
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[notifications] unhandled:', err?.message || err);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

function inferChannel(recipient: Record<string, string>): Channel {
  if (recipient.email) return 'email';
  if (recipient.phone) return 'sms';
  if (recipient.url || recipient.webhookUrl) return 'webhook';
  if (recipient.pushToken) return 'push';
  return 'log';
}

if (require.main === module) {
  ensureTables().then(() => {
    const app = createApp();
    const server = app.listen(PORT, () => console.log(`[notifications] listening on :${PORT} store=${useDb() ? 'postgres' : 'memory'} delivery=${USE_QUEUE ? 'queue' : 'local'}`));
    const tickMs = Math.max(500, Number(process.env.NOTIFICATIONS_TICK_MS || 2000));
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (USE_QUEUE) await consumeFromQueue(`notifications-${process.pid}`);
        else await processDueOnce();
      } catch (e: any) {
        console.error('[notifications] worker error:', e?.message || e);
      } finally {
        busy = false;
      }
    }, tickMs);
    timer.unref?.();
    const shutdown = () => { clearInterval(timer); server.close(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}
