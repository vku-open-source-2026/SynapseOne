# Notifications service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseNotifications is the durable delivery primitive: enqueue email, SMS,
webhook, push, or development log notifications; render inline variables or
stored templates; apply recipient preferences; and track retries/dead letters.

See [Notifications guide](../notifications.md), [Workflow](workflow.md),
[Queue](queue.md), and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/notifications` | Enqueue one record per channel (`202`). |
| GET | `/v1/notifications?status=&limit=` | List tenant notifications. |
| GET | `/v1/notifications/:id` | Status and attempt history. |
| POST | `/v1/notifications/:id/cancel` | Cancel a queued/failed delivery. |
| POST | `/v1/notifications/:id/retry` | Retry failed/dead with a fresh attempt budget. |
| GET/POST | `/v1/notifications/templates` | List/search or create templates. |
| GET/PATCH/DELETE | `/v1/notifications/templates/:id` | Read, versioned update, or archive. |
| POST | `/v1/notifications/templates/:id/preview` | Render with sample data. |
| GET/PUT | `/v1/notifications/preferences/:recipient` | Read/update channel preferences. |
| POST | `/v1/notifications/unsubscribe` | Unsubscribe a recipient. |

## Important semantics and limits

- **Asynchronous acceptance:** enqueue returns `202 {notifications:[...]}`. It
  does not mean the channel provider has delivered the message; poll the record.
- **Fan-out:** `channels` creates one notification record per channel. Supply
  `channel` for a single channel.
- **Recipients:** channel-specific fields include `email`, `phone`, `userId`,
  `url`/`webhookUrl`, and `pushToken`.
- **Inline rendering:** `{{var}}` placeholders are filled from `data`; missing
  inline keys remain intact.
- **Templates:** send `templateId` or `templateSlug` instead of `body`. Missing
  template variables return `400 missing_template_variables`. Content is
  rendered and persisted at enqueue time, so later edits do not change queued
  notifications.
- **Idempotency:** `idempotencyKey` is scoped per tenant and channel. Repeating
  the enqueue returns the existing record instead of sending twice.
- **Delivery:** outbox delivery is at-least-once. Failures retry with
  exponential backoff up to `NOTIFICATIONS_MAX_ATTEMPTS` (default 5), then become
  `dead` with a reason.
- **Manual retry:** only `failed`/`dead` rows can be retried; retry resets the
  attempt budget. Invalid states return `409`.
- **Rate limit:** default `NOTIFICATIONS_RATE_LIMIT_PER_MIN` is 120 per tenant;
  excess sends return `429` with `Retry-After`.
- **Preferences:** allowed channels can narrow fan-out. `unsubscribed:true`
  cancels pending deliveries and blocks future sends to that recipient.
- **Providers:** email/SMS/push use configured HTTPS relays; webhook posts
  directly. The `log` channel is development-only and rejected in production.
- **Archive:** deleting a template archives it. Enqueueing from an archived
  template returns `409`.

## Authentication and scopes

Notifications accepts a Bearer JWT or API key:

- List/get/preferences/templates reads: `notifications:read`.
- Send/cancel/retry/template/preference mutations: `notifications:write`.
- Template deletion: `notifications:delete`.
- `notifications:*` covers the namespace.

IAM policies are additional in enforce mode. Recipient preference identifiers
should be stable, non-secret tenant-scoped identifiers; the SDK URL-encodes them
in path routes.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});
const accepted = await client.notifications.send({
  channel: 'email',
  recipient: { email: 'user@example.com' },
  subject: 'Welcome {{name}}',
  body: 'Hello {{name}}',
  data: { name: 'Example User' },
  idempotencyKey: 'welcome:user@example.com',
});
const record = await client.notifications.get(accepted.notifications[0].id);
console.log(record.status, record.attempts);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
accepted = client.notifications.send(
    recipient={"email": "user@example.com"},
    channel="email",
    subject="Welcome {{name}}",
    body="Hello {{name}}",
    data={"name": "Example User"},
    idempotency_key="welcome:user@example.com",
)
record = client.notifications.get(accepted["notifications"][0]["id"])
print(record["status"], record["attempts"])
```

### Go

```go
package main

import (
    "fmt"
    "os"

    synapseone "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"
)

func main() {
    client := synapseone.New(os.Getenv("SYNAPSEONE_BASE_URL"))
    client.SetAPIKey(os.Getenv("SYNAPSEONE_API_KEY"))

    accepted, err := client.SendNotification(synapseone.SendNotificationInput{
        Channel: "email",
        Recipient: synapseone.NotificationRecipient{Email: "user@example.com"},
        Subject: "Welcome {{name}}",
        Body: "Hello {{name}}",
        Data: map[string]any{"name": "Example User"},
        IdempotencyKey: "welcome:user@example.com",
    })
    if err != nil {
        panic(err)
    }
    notifications := accepted["notifications"].([]any)
    id := notifications[0].(map[string]any)["id"].(string)
    record, err := client.GetNotification(id)
    if err != nil {
        panic(err)
    }
    fmt.Println(record["status"], record["attempts"])
}
```

### Rust

```rust
use synapseone::{Credentials, SynapseOneClient};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = SynapseOneClient::new(
        std::env::var("SYNAPSEONE_BASE_URL")
            .unwrap_or_else(|_| "https://api.synapseone.space".to_string()),
        Credentials::api_key(std::env::var("SYNAPSEONE_API_KEY")?),
    )?;
    let accepted = client.notifications().send(
        json!({"email": "user@example.com"}),
        "Hello {{name}}",
        Some("email"),
        None,
        "Welcome {{name}}",
        Some(json!({"name": "Example User"})),
        Some("welcome:user@example.com"),
    ).await?;
    let id = accepted["notifications"][0]["id"].as_str().ok_or("missing notification id")?;
    let record = client.notifications().get(id).await?;
    println!("{} {}", record["status"], record["attempts"]);
    Ok(())
}
```
