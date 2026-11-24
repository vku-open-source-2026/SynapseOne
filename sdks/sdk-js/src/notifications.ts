// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseNotifications client: outbox, templates, preferences and delivery.
 */

import { HttpClient } from './_http';

const P = '/v1/notifications';

export type NotificationChannel = 'email' | 'sms' | 'webhook' | 'push' | 'log';
export type NotificationStatus = 'queued' | 'sending' | 'delivered' | 'failed' | 'dead' | 'cancelled';

export interface NotificationRecipient {
  email?: string;
  phone?: string;
  userId?: string;
  url?: string;
  webhookUrl?: string;
  pushToken?: string;
  [key: string]: string | undefined;
}

export interface SendNotificationInput {
  /** One channel, or several at once (fan-out creates one record per channel). */
  channel?: NotificationChannel;
  channels?: NotificationChannel[];
  recipient: NotificationRecipient;
  subject?: string;
  /** Inline body with `{{var}}` placeholders filled from `data`. */
  body?: string;
  /** Stored template id or slug; mutually exclusive with `body`. */
  templateId?: string;
  templateSlug?: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface NotificationRecord {
  id: string;
  tenant: string;
  channel: NotificationChannel;
  recipient: NotificationRecipient;
  subject: string;
  body: string;
  status: NotificationStatus;
  attempts: Array<{ at: string; ok: boolean; error?: string }>;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  deadReason: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
}

export interface NotificationTemplate {
  id: string;
  tenant: string;
  slug: string;
  name: string;
  subject: string;
  body: string;
  variables: string[];
  version: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreference {
  tenant: string;
  recipient: string;
  channels: NotificationChannel[];
  unsubscribed: boolean;
  updatedAt?: string;
}

export class NotificationsService {
  constructor(private readonly http: HttpClient) {}

  /** Queue one notification per channel (202). */
  send(input: SendNotificationInput) {
    return this.http.req<{ notifications: NotificationRecord[] }>(P, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  get(id: string): Promise<NotificationRecord> {
    return this.http.req(`${P}/${encodeURIComponent(id)}`);
  }

  list(opts: { status?: NotificationStatus; limit?: number } = {}): Promise<NotificationRecord[]> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const s = qs.toString();
    return this.http.req(`${P}${s ? `?${s}` : ''}`);
  }

  cancel(id: string): Promise<NotificationRecord> {
    return this.http.req(`${P}/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  }

  createTemplate(input: {
    slug: string;
    name: string;
    subject?: string;
    body: string;
  }): Promise<NotificationTemplate> {
    return this.http.req(`${P}/templates`, { method: 'POST', body: JSON.stringify(input) });
  }

  listTemplates(opts: { q?: string; includeArchived?: boolean; limit?: number; offset?: number } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return this.http.req<{ items: NotificationTemplate[]; total: number }>(`${P}/templates${s ? `?${s}` : ''}`);
  }

  getTemplate(id: string): Promise<NotificationTemplate> {
    return this.http.req(`${P}/templates/${encodeURIComponent(id)}`);
  }

  updateTemplate(id: string, patch: { name?: string; subject?: string; body?: string }): Promise<NotificationTemplate> {
    return this.http.req(`${P}/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  deleteTemplate(id: string): Promise<{ ok: boolean; archived: boolean }> {
    return this.http.req(`${P}/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  previewTemplate(id: string, data: Record<string, unknown> = {}) {
    return this.http.req<{ subject: string; body: string; variables: string[]; missing: string[]; version: number }>(
      `${P}/templates/${encodeURIComponent(id)}/preview`,
      { method: 'POST', body: JSON.stringify({ data }) },
    );
  }

  retry(id: string): Promise<NotificationRecord> {
    return this.http.req(`${P}/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' });
  }

  getPreference(recipient: string): Promise<NotificationPreference> {
    return this.http.req(`${P}/preferences/${encodeURIComponent(recipient)}`);
  }

  setPreference(recipient: string, prefs: { channels?: NotificationChannel[]; unsubscribed?: boolean }) {
    return this.http.req<NotificationPreference>(`${P}/preferences/${encodeURIComponent(recipient)}`, {
      method: 'PUT',
      body: JSON.stringify(prefs),
    });
  }

  unsubscribe(recipient: string) {
    return this.http.req<NotificationPreference>(`${P}/unsubscribe`, {
      method: 'POST',
      body: JSON.stringify({ recipient }),
    });
  }
}
