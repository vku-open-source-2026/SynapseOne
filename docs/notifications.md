# SynapseNotifications — outbox, inline variables and delivery

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

SynapseNotifications is the Tier-1 delivery primitive: products store a
notification, Tier 1 owns the outbox, retries, preferences and delivery status.
It is tenant-scoped like every other service (`org:` → `account:` → `user:`).

## API (`/v1/notifications`)

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/notifications` | Queue one notification per channel |
| GET | `/v1/notifications?status=&limit=` | List recent notifications |
| GET | `/v1/notifications/:id` | Status + attempt history |
| POST | `/v1/notifications/:id/cancel` | Cancel queued/failed delivery |
| POST | `/v1/notifications/:id/retry` | Retry a failed/dead delivery with a fresh attempt budget |
| POST | `/v1/notifications/templates` | Create a tenant-owned template |
| GET | `/v1/notifications/templates?q=&includeArchived=&limit=&offset=` | List/search templates |
| GET | `/v1/notifications/templates/:id` | Template + variables/version |
| PATCH | `/v1/notifications/templates/:id` | Update content (version increments) |
| POST | `/v1/notifications/templates/:id/preview` | Render with data |
| DELETE | `/v1/notifications/templates/:id` | Archive |
| GET | `/v1/notifications/preferences/:recipient` | Read preferences |
| PUT | `/v1/notifications/preferences/:recipient` | Set channels/unsubscribe |
| POST | `/v1/notifications/unsubscribe` | Unsubscribe a recipient |

Send body:

```json
{
  "channels": ["email", "webhook"],
  "recipient": { "email": "ops@example.com", "userId": "u1", "url": "https://hooks.example.com/x" },
  "subject": "Flood alert in {{city}}",
  "body": "Level {{level}}m at {{station}}",
  "data": { "city": "Hanoi", "level": 2.5, "station": "S1" },
  "idempotencyKey": "alert-2026-11-04-s1"
}
```

`{{var}}` placeholders are replaced from `data`; missing keys are left intact.
Templates are a first-class tenant resource: `POST/GET/PATCH/DELETE
/v1/notifications/templates` and `POST .../preview`. Variables are derived from
`{{name}}` placeholders, validated at write time, and checked against `data` at
enqueue time (missing → `400 missing_template_variables`). Enqueue with
`templateId` or `templateSlug` instead of `body`; the rendered subject/body are
stored with `templateId`/`templateVersion`, so editing or archiving a template
never changes an already queued notification. Inline `body` rendering remains
fully supported. Fan-out creates one record per channel and
returns `202` with `{notifications: [...]}`. `idempotencyKey` is scoped per
tenant and channel: a retry returns the existing record instead of sending
twice. Manual retry is only valid for `failed`/`dead` rows; it resets the
attempt budget and clears the outbox publish marker.

## Channels and provider adapters

| Channel | Adapter |
| --- | --- |
| `webhook` | Direct HTTPS POST to `recipient.url` / `recipient.webhookUrl` |
| `email` | HTTPS relay configured with `NOTIFICATIONS_EMAIL_RELAY_URL` |
| `sms` | HTTPS relay configured with `NOTIFICATIONS_SMS_RELAY_URL` |
| `push` | HTTPS relay configured with `NOTIFICATIONS_PUSH_RELAY_URL` |
| `log` | Dev-only console sink (rejected in production) |

Relays receive `{to|token, subject, body, notificationId}`, so operators can
front SES, Twilio, Mailgun, an SMTP bridge, FCM, etc. without putting provider
secrets or SDKs in tenant data.

## Delivery guarantees

* The outbox row is durable (`DATABASE_URL` required in production).
* With `NOTIFICATIONS_QUEUE_URL` set (default in Compose/K8s), jobs travel
  through SynapseQueue and consumers ack on success / nack on failure, giving
  at-least-once delivery across replicas. Queue retries and the dead-letter
  queue apply.
* Without a queue (dev/tests) an in-process worker claims due rows.
* Failures retry with exponential backoff (`NOTIFICATIONS_RETRY_BASE_SECONDS`)
  up to `NOTIFICATIONS_MAX_ATTEMPTS` (default 5), then move to `dead` with a
  `deadReason`. Attempts (timestamp, ok, error) are recorded per notification.
* `NOTIFICATIONS_RATE_LIMIT_PER_MIN` (default 120) caps sends per tenant and
  returns `429` + `Retry-After`.
* Preferences can allow only specific channels; `unsubscribed: true` cancels
  pending deliveries and blocks future sends to that recipient.
* Health (`/health`) reports the store (`postgres`/`memory`) and delivery mode
  (`queue`/`local`).

## Tier-2/Tier-3 guidance

Tier 2 owns templates/preferences if its products need richer workflows; it
should call this API instead of writing inert rows. Tier 3 stores only
notification metadata and reads status from `/v1/notifications/:id`.
