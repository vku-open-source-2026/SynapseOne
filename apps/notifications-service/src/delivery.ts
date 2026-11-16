// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Notification rendering + provider adapters + retry loop.
 */
import type { NotificationRecord } from './db';
import { assertWebhookUrlAllowed } from './ssrf';

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

/** Render `{{var}}` placeholders from the notification data. Unknown keys stay. */
export function renderTemplate(template: string, data: Record<string, unknown> = {}): string {
  return String(template || '').replace(/\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g, (m, key) => {
    const value = key.split('.').reduce((acc: any, part: string) => (acc && typeof acc === 'object' ? acc[part] : undefined), data as any);
    return value === undefined || value === null ? m : String(value);
  });
}

function timeoutFetch(
  url: string,
  body: unknown,
  timeoutMs = 10_000,
  init: { redirect?: RequestRedirect } = {},
): Promise<Response> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctl.signal,
    ...(init.redirect ? { redirect: init.redirect } : {}),
  }).finally(() => clearTimeout(to));
}

/** Deliver one notification through the configured provider adapter.
 *  Email/SMS/push are HTTP relays so operators can point them at SES, Twilio,
 *  Mailgun, an SMTP webhook, etc. without embedding provider SDKs. */
export async function deliver(notification: NotificationRecord): Promise<DeliveryResult> {
  const text = renderTemplate(notification.body, notification.metadata);
  const subject = renderTemplate(notification.subject, notification.metadata);
  try {
    switch (notification.channel) {
      case 'webhook': {
        const url = notification.recipient.url || notification.recipient.webhookUrl;
        if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'webhook recipient.url must be an http(s) URL' };
        // Tenant-controlled URL: block private/internal targets (SSRF) and
        // never follow redirects (a public URL could redirect into the VPC).
        // The private-target bypass exists for offline tests only and is
        // ignored in production.
        const allowPrivate = process.env.NOTIFICATIONS_WEBHOOK_ALLOW_PRIVATE === 'true'
          && process.env.NODE_ENV !== 'production';
        if (!allowPrivate) {
          try {
            await assertWebhookUrlAllowed(url);
          } catch (error) {
            return { ok: false, error: (error as Error).message.slice(0, 300) };
          }
        }
        const r = await timeoutFetch(url, {
          id: notification.id,
          subject,
          body: text,
          data: notification.metadata,
          tenant: notification.tenant,
        }, 10_000, { redirect: 'manual' });
        if (r.status >= 300 && r.status < 400) {
          return { ok: false, error: `webhook redirect rejected (${r.status})` };
        }
        return r.ok ? { ok: true } : { ok: false, error: `webhook ${r.status}` };
      }
      case 'email': {
        const relay = process.env.NOTIFICATIONS_EMAIL_RELAY_URL || '';
        if (!relay) return { ok: false, error: 'NOTIFICATIONS_EMAIL_RELAY_URL is not configured' };
        const to = notification.recipient.email;
        if (!to) return { ok: false, error: 'email recipient missing' };
        const r = await timeoutFetch(relay, { to, subject, body: text, notificationId: notification.id });
        return r.ok ? { ok: true } : { ok: false, error: `email relay ${r.status}` };
      }
      case 'sms': {
        const relay = process.env.NOTIFICATIONS_SMS_RELAY_URL || '';
        if (!relay) return { ok: false, error: 'NOTIFICATIONS_SMS_RELAY_URL is not configured' };
        const to = notification.recipient.phone;
        if (!to) return { ok: false, error: 'sms recipient missing' };
        const r = await timeoutFetch(relay, { to, body: text, notificationId: notification.id });
        return r.ok ? { ok: true } : { ok: false, error: `sms relay ${r.status}` };
      }
      case 'push': {
        const relay = process.env.NOTIFICATIONS_PUSH_RELAY_URL || '';
        const token = notification.recipient.pushToken || notification.recipient.token;
        if (!relay || !token) return { ok: false, error: 'push relay/token not configured' };
        const r = await timeoutFetch(relay, { token, subject, body: text, notificationId: notification.id });
        return r.ok ? { ok: true } : { ok: false, error: `push relay ${r.status}` };
      }
      case 'log':
        if (process.env.NODE_ENV === 'production') return { ok: false, error: 'log channel is disabled in production' };
        console.log(`[notifications][log] ${notification.tenant} ${subject}: ${text}`);
        return { ok: true };
      default:
        return { ok: false, error: `unknown channel '${notification.channel}'` };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

export function backoffSeconds(attempt: number): number {
  const base = Math.max(1, Number(process.env.NOTIFICATIONS_RETRY_BASE_SECONDS || 5));
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 3600);
}
