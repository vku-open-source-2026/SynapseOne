// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Notification persistence: Postgres in production, in-memory for dev/tests.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const CHANNELS: &[&str] = &["email", "sms", "webhook", "push", "log"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    pub tenant: String,
    pub channel: String,
    pub recipient: Value,
    pub subject: String,
    pub body: String,
    pub status: String,
    pub attempts: Value,
    pub idempotency_key: Option<String>,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
    pub next_attempt_at: String,
    pub dead_reason: Option<String>,
    /// Set once the notification was successfully handed to SynapseQueue.
    /// Rows left NULL are drained by the local worker (publish failed/queue off).
    pub published_at: Option<String>,
    /// Template used at enqueue time (content is already rendered/immutable).
    pub template_id: Option<String>,
    pub template_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRecord {
    pub id: String,
    pub tenant: String,
    pub slug: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub variables: Vec<String>,
    pub version: i64,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewTemplate {
    pub tenant: String,
    pub slug: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub variables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceRecord {
    pub tenant: String,
    pub recipient: String,
    pub channels: Vec<String>,
    pub unsubscribed: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewNotification {
    pub tenant: String,
    pub channel: String,
    pub recipient: Value,
    pub subject: String,
    pub body: String,
    pub idempotency_key: Option<String>,
    pub metadata: Value,
    pub template_id: Option<String>,
    pub template_version: Option<i64>,
}

#[derive(Default)]
struct MemoryStore {
    notifications: HashMap<String, NotificationRecord>,
    preferences: HashMap<String, PreferenceRecord>,
    templates: HashMap<String, TemplateRecord>,
    /// Test-only: when set, the next call to the matching method returns a
    /// simulated store error once, so handler fail-closed paths can be
    /// exercised without a real database.
    #[cfg(test)]
    fail_next: Option<&'static str>,
}

/// Consume a test-injected failure for `method`, if armed for it.
#[cfg(test)]
fn take_injected_failure(mem: &mut MemoryStore, method: &str) -> Option<String> {
    if mem.fail_next.as_deref() == Some(method) {
        mem.fail_next = None;
        return Some(format!("simulated {method} failure"));
    }
    None
}

#[cfg(not(test))]
fn take_injected_failure(_mem: &mut MemoryStore, _method: &str) -> Option<String> {
    None
}

#[derive(Clone)]
enum Backend {
    Postgres(PgPool),
    Memory(Arc<Mutex<MemoryStore>>),
}

#[derive(Clone)]
pub struct Store {
    backend: Backend,
}

impl Store {
    pub async fn connect(database_url: Option<&str>) -> Result<Self, String> {
        match database_url.filter(|url| !url.trim().is_empty()) {
            Some(url) => {
                let pool = PgPoolOptions::new()
                    .max_connections(10)
                    .connect(url)
                    .await
                    .map_err(|e| format!("connect: {e}"))?;
                let store = Self {
                    backend: Backend::Postgres(pool),
                };
                store.ensure_tables().await?;
                Ok(store)
            }
            None => Ok(Self {
                backend: Backend::Memory(Arc::new(Mutex::new(MemoryStore::default()))),
            }),
        }
    }

    pub fn uses_postgres(&self) -> bool {
        matches!(self.backend, Backend::Postgres(_))
    }

    pub async fn ensure_tables(&self) -> Result<(), String> {
        let Backend::Postgres(pool) = &self.backend else {
            return Ok(());
        };
        let statements = [
            r#"
            CREATE TABLE IF NOT EXISTS notifications (
              id uuid PRIMARY KEY,
              tenant text NOT NULL,
              channel text NOT NULL,
              recipient jsonb NOT NULL,
              subject text NOT NULL DEFAULT '',
              body text NOT NULL,
              status text NOT NULL DEFAULT 'queued',
              attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
              idempotency_key text,
              metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now(),
              next_attempt_at timestamptz NOT NULL DEFAULT now(),
              dead_reason text
            )
            "#,
            "CREATE UNIQUE INDEX IF NOT EXISTS notifications_idem_key ON notifications (tenant, idempotency_key) WHERE idempotency_key IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS notifications_tenant_created ON notifications (tenant, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS notifications_due ON notifications (status, next_attempt_at)",
            "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS published_at timestamptz",
            "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS template_id uuid",
            "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS template_version integer",
            "CREATE INDEX IF NOT EXISTS notifications_unpublished ON notifications (status, next_attempt_at) WHERE published_at IS NULL",
            r#"
            CREATE TABLE IF NOT EXISTS notification_templates (
              id uuid PRIMARY KEY,
              tenant text NOT NULL,
              slug text NOT NULL,
              name text NOT NULL,
              subject text NOT NULL DEFAULT '',
              body text NOT NULL,
              variables jsonb NOT NULL DEFAULT '[]'::jsonb,
              version integer NOT NULL DEFAULT 1,
              archived_at timestamptz,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now()
            )
            "#,
            "CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_tenant_slug ON notification_templates (tenant, slug)",
            "CREATE INDEX IF NOT EXISTS notification_templates_tenant ON notification_templates (tenant, created_at DESC)",
            r#"
            CREATE TABLE IF NOT EXISTS notification_preferences (
              tenant text NOT NULL,
              recipient text NOT NULL,
              channels jsonb NOT NULL DEFAULT '[]'::jsonb,
              unsubscribed boolean NOT NULL DEFAULT false,
              updated_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (tenant, recipient)
            )
            "#,
        ];
        for statement in statements {
            sqlx::query(statement)
                .execute(pool)
                .await
                .map_err(|e| format!("ensure tables: {e}"))?;
        }
        Ok(())
    }

    pub async fn create(&self, input: NewNotification) -> Result<NotificationRecord, String> {
        let now = iso(Utc::now());
        let record = NotificationRecord {
            id: Uuid::new_v4().to_string(),
            tenant: input.tenant,
            channel: input.channel,
            recipient: input.recipient,
            subject: input.subject,
            body: input.body,
            status: "queued".into(),
            attempts: json!([]),
            idempotency_key: input.idempotency_key,
            metadata: input.metadata,
            created_at: now.clone(),
            updated_at: now.clone(),
            next_attempt_at: now,
            dead_reason: None,
            published_at: None,
            template_id: input.template_id,
            template_version: input.template_version,
        };
        match &self.backend {
            Backend::Postgres(pool) => {
                let record_id: Uuid = record.id.parse().map_err(|_| "invalid uuid")?;
                let row = sqlx::query(
                    r#"
                    INSERT INTO notifications
                      (id, tenant, channel, recipient, subject, body, status, attempts, idempotency_key, metadata, created_at, updated_at, next_attempt_at, template_id, template_version)
                    VALUES ($1,$2,$3,$4,$5,$6,'queued','[]'::jsonb,$7,$8,now(),now(),now(),$9,$10)
                    ON CONFLICT (tenant, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
                    RETURNING *
                    "#,
                )
                .bind(record_id)
                .bind(&record.tenant)
                .bind(&record.channel)
                .bind(&record.recipient)
                .bind(&record.subject)
                .bind(&record.body)
                .bind(&record.idempotency_key)
                .bind(&record.metadata)
                .bind(record.template_id.as_ref().and_then(|v| v.parse::<Uuid>().ok()))
                .bind(record.template_version)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("insert notification: {e}"))?;

                if let Some(row) = row {
                    return row_to_record(&row);
                }
                let existing = sqlx::query(
                    "SELECT * FROM notifications WHERE tenant=$1 AND idempotency_key=$2 LIMIT 1",
                )
                .bind(&record.tenant)
                .bind(&record.idempotency_key)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("select idempotent: {e}"))?;
                match existing {
                    Some(row) => row_to_record(&row),
                    None => Err("idempotent insert produced no row".into()),
                }
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if let Some(key) = &record.idempotency_key {
                    if let Some(existing) = mem
                        .notifications
                        .values()
                        .find(|n| n.tenant == record.tenant && n.idempotency_key.as_deref() == Some(key))
                    {
                        return Ok(existing.clone());
                    }
                }
                mem.notifications
                    .insert(record.id.clone(), record.clone());
                Ok(record)
            }
        }
    }

    pub async fn get(&self, tenant: &str, id: &str) -> Result<Option<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query("SELECT * FROM notifications WHERE tenant=$1 AND id=$2::uuid")
                    .bind(tenant)
                    .bind(id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("get notification: {e}"))?;
                row.as_ref().map(row_to_record).transpose()
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                Ok(mem
                    .notifications
                    .get(id)
                    .filter(|n| n.tenant == tenant)
                    .cloned())
            }
        }
    }

    pub async fn list(
        &self,
        tenant: &str,
        status: Option<&str>,
        limit: i64,
    ) -> Result<Vec<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = match status {
                    Some(status) => {
                        sqlx::query("SELECT * FROM notifications WHERE tenant=$1 AND status=$2 ORDER BY created_at DESC LIMIT $3")
                            .bind(tenant)
                            .bind(status)
                            .bind(limit)
                            .fetch_all(pool)
                            .await
                    }
                    None => {
                        sqlx::query("SELECT * FROM notifications WHERE tenant=$1 ORDER BY created_at DESC LIMIT $2")
                            .bind(tenant)
                            .bind(limit)
                            .fetch_all(pool)
                            .await
                    }
                }
                .map_err(|e| format!("list notifications: {e}"))?;
                rows.iter().map(row_to_record).collect()
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                let mut items: Vec<NotificationRecord> = mem
                    .notifications
                    .values()
                    .filter(|n| {
                        n.tenant == tenant && status.map(|s| n.status == s).unwrap_or(true)
                    })
                    .cloned()
                    .collect();
                items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                items.truncate(limit.max(0) as usize);
                Ok(items)
            }
        }
    }

    pub async fn update(
        &self,
        id: &str,
        status: Option<&str>,
        attempts: Option<Value>,
        next_attempt_at: Option<&str>,
        dead_reason: Option<&str>,
    ) -> Result<(), String> {
        let updated_at = iso(Utc::now());
        match &self.backend {
            Backend::Postgres(pool) => {
                let next: Option<DateTime<Utc>> = next_attempt_at.and_then(parse_ts);
                sqlx::query(
                    r#"
                    UPDATE notifications
                    SET status=COALESCE($2,status),
                        attempts=COALESCE($3,attempts),
                        next_attempt_at=COALESCE($4,next_attempt_at),
                        dead_reason=COALESCE($5,dead_reason),
                        updated_at=$6
                    WHERE id=$1::uuid
                    "#,
                )
                .bind(id)
                .bind(status)
                .bind(attempts)
                .bind(next)
                .bind(dead_reason)
                .bind(parse_ts(&updated_at))
                .execute(pool)
                .await
                .map_err(|e| format!("update notification: {e}"))?;
                Ok(())
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if let Some(error) = take_injected_failure(&mut mem, "update") {
                    return Err(error);
                }
                if let Some(n) = mem.notifications.get_mut(id) {
                    if let Some(status) = status {
                        n.status = status.to_string();
                    }
                    if let Some(attempts) = attempts {
                        n.attempts = attempts;
                    }
                    if let Some(next) = next_attempt_at {
                        n.next_attempt_at = next.to_string();
                    }
                    if let Some(reason) = dead_reason {
                        n.dead_reason = Some(reason.to_string());
                    }
                    n.updated_at = updated_at;
                }
                Ok(())
            }
        }
    }

    /// Mark a notification as successfully published to SynapseQueue. If this
    /// write fails, the local worker may deliver a duplicate (at-least-once)
    /// but the notification is never lost.
    pub async fn mark_published(&self, id: &str) -> Result<(), String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                sqlx::query("UPDATE notifications SET published_at=now(), updated_at=now() WHERE id=$1::uuid")
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("mark published: {e}"))?;
                Ok(())
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if let Some(n) = mem.notifications.get_mut(id) {
                    n.published_at = Some(iso(Utc::now()));
                    n.updated_at = iso(Utc::now());
                }
                Ok(())
            }
        }
    }

    /// Clear the queue-published marker so the local outbox can retry after a
    /// failed delivery/ack. At-least-once may duplicate, never lose.
    pub async fn clear_published(&self, id: &str) -> Result<(), String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                sqlx::query("UPDATE notifications SET published_at=NULL, updated_at=now() WHERE id=$1::uuid")
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("clear published: {e}"))?;
                Ok(())
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if let Some(n) = mem.notifications.get_mut(id) {
                    n.published_at = None;
                    n.updated_at = iso(Utc::now());
                }
                Ok(())
            }
        }
    }

    /// Claim records that were persisted but never published (queue outage or
    /// queue disabled). The local worker drains these independently of the
    /// queue consumer, so an accepted notification cannot silently disappear.
    pub async fn claim_pending(&self, limit: i64) -> Result<Vec<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
                    UPDATE notifications SET status='sending', updated_at=now()
                    WHERE id IN (
                      SELECT id FROM notifications
                      WHERE status IN ('queued','failed') AND published_at IS NULL AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      LIMIT $1 FOR UPDATE SKIP LOCKED
                    ) RETURNING *
                    "#,
                )
                .bind(limit)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("claim pending: {e}"))?;
                rows.iter().map(row_to_record).collect()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let now = Utc::now();
                let mut due: Vec<NotificationRecord> = mem
                    .notifications
                    .values()
                    .filter(|n| {
                        n.published_at.is_none()
                            && matches!(n.status.as_str(), "queued" | "failed")
                            && parse_ts(&n.next_attempt_at)
                                .map(|t| t <= now)
                                .unwrap_or(true)
                    })
                    .cloned()
                    .collect();
                due.sort_by(|a, b| a.next_attempt_at.cmp(&b.next_attempt_at));
                due.truncate(limit.max(0) as usize);
                for n in &due {
                    if let Some(stored) = mem.notifications.get_mut(&n.id) {
                        stored.status = "sending".into();
                        stored.updated_at = iso(now);
                    }
                }
                Ok(due)
            }
        }
    }

    /// Atomically claim one notification consumed from the queue. Returns None
    /// when another consumer already delivered/cancelled it.
    pub async fn claim_one(&self, tenant: &str, id: &str) -> Result<Option<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    UPDATE notifications SET status='sending', updated_at=now()
                    WHERE tenant=$1 AND id=$2::uuid AND status IN ('queued','failed')
                    RETURNING *
                    "#,
                )
                .bind(tenant)
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("claim notification: {e}"))?;
                row.as_ref().map(row_to_record).transpose()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if let Some(error) = take_injected_failure(&mut mem, "claim_one") {
                    return Err(error);
                }
                let Some(n) = mem.notifications.get_mut(id) else {
                    return Ok(None);
                };
                if n.tenant != tenant || !matches!(n.status.as_str(), "queued" | "failed") {
                    return Ok(None);
                }
                n.status = "sending".into();
                n.updated_at = iso(Utc::now());
                Ok(Some(n.clone()))
            }
        }
    }

    /// Re-claim one notification stuck in 'sending' after its worker died
    /// between claim and terminal update (queue redelivery path). Only rows
    /// whose updated_at is older than the visibility timeout are
    /// re-claimable; anything fresher still belongs to an in-flight
    /// consumer and must be treated as a dedupe, not re-delivered.
    pub async fn reclaim_stale_sending(
        &self,
        tenant: &str,
        id: &str,
        visibility_seconds: i64,
    ) -> Result<Option<NotificationRecord>, String> {
        let cutoff = Utc::now() - chrono::Duration::seconds(visibility_seconds.max(0));
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    UPDATE notifications SET status='sending', updated_at=now()
                    WHERE tenant=$1 AND id=$2::uuid AND status='sending' AND updated_at <= $3
                    RETURNING *
                    "#,
                )
                .bind(tenant)
                .bind(id)
                .bind(cutoff)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("reclaim sending: {e}"))?;
                row.as_ref().map(row_to_record).transpose()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let Some(n) = mem.notifications.get_mut(id) else {
                    return Ok(None);
                };
                if n.tenant != tenant || n.status != "sending" {
                    return Ok(None);
                }
                let stale =
                    parse_ts(&n.updated_at).map(|t| t <= cutoff).unwrap_or(true);
                if !stale {
                    return Ok(None);
                }
                n.updated_at = iso(Utc::now());
                Ok(Some(n.clone()))
            }
        }
    }

    /// Sweep 'sending' rows stranded by a crashed worker and re-claim the
    /// ones older than the visibility timeout for delivery. At-least-once
    /// allows a duplicate delivery, never a lost notification.
    pub async fn claim_stale_sending(
        &self,
        limit: i64,
        visibility_seconds: i64,
    ) -> Result<Vec<NotificationRecord>, String> {
        let cutoff = Utc::now() - chrono::Duration::seconds(visibility_seconds.max(0));
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
                    UPDATE notifications SET status='sending', updated_at=now()
                    WHERE id IN (
                      SELECT id FROM notifications
                      WHERE status='sending' AND updated_at <= $1
                      ORDER BY updated_at
                      LIMIT $2 FOR UPDATE SKIP LOCKED
                    ) RETURNING *
                    "#,
                )
                .bind(cutoff)
                .bind(limit)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("claim stale sending: {e}"))?;
                rows.iter().map(row_to_record).collect()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let now = Utc::now();
                let mut stale: Vec<NotificationRecord> = mem
                    .notifications
                    .values()
                    .filter(|n| {
                        n.status == "sending"
                            && parse_ts(&n.updated_at)
                                .map(|t| t <= cutoff)
                                .unwrap_or(true)
                    })
                    .cloned()
                    .collect();
                stale.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
                stale.truncate(limit.max(0) as usize);
                for n in &stale {
                    if let Some(stored) = mem.notifications.get_mut(&n.id) {
                        stored.updated_at = iso(now);
                    }
                }
                Ok(stale)
            }
        }
    }

    /// Manual retry for a failed or dead notification. It starts a fresh
    /// attempt budget and clears the publish marker so the durable outbox
    /// republishes it; only failed/dead rows are eligible.
    pub async fn retry(
        &self,
        tenant: &str,
        id: &str,
    ) -> Result<Option<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    UPDATE notifications
                    SET status='queued', attempts='[]'::jsonb, next_attempt_at=now(),
                        dead_reason=NULL, published_at=NULL, updated_at=now()
                    WHERE tenant=$1 AND id=$2::uuid AND status IN ('failed','dead')
                    RETURNING *
                    "#,
                )
                .bind(tenant)
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("retry notification: {e}"))?;
                row.as_ref().map(row_to_record).transpose()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let Some(n) = mem.notifications.get_mut(id) else {
                    return Ok(None);
                };
                if n.tenant != tenant || !matches!(n.status.as_str(), "failed" | "dead") {
                    return Ok(None);
                }
                n.status = "queued".into();
                n.attempts = json!([]);
                n.next_attempt_at = iso(Utc::now());
                n.dead_reason = None;
                n.published_at = None;
                n.updated_at = iso(Utc::now());
                Ok(Some(n.clone()))
            }
        }
    }

    pub async fn cancel(&self, tenant: &str, id: &str) -> Result<Option<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    "UPDATE notifications SET status='cancelled', updated_at=now() WHERE tenant=$1 AND id=$2::uuid AND status IN ('queued','failed') RETURNING *",
                )
                .bind(tenant)
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("cancel notification: {e}"))?;
                row.as_ref().map(row_to_record).transpose()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let Some(n) = mem.notifications.get_mut(id) else {
                    return Ok(None);
                };
                if n.tenant != tenant || !matches!(n.status.as_str(), "queued" | "failed") {
                    return Ok(None);
                }
                n.status = "cancelled".into();
                n.updated_at = iso(Utc::now());
                Ok(Some(n.clone()))
            }
        }
    }

    /// Claim due notifications for delivery (single replica-safe on
    /// Postgres). Also re-claims 'sending' rows older than the visibility
    /// timeout so a crashed worker cannot strand an accepted notification.
    #[allow(dead_code)]
    pub async fn claim_due(
        &self,
        limit: i64,
        sending_visibility_seconds: i64,
    ) -> Result<Vec<NotificationRecord>, String> {
        let sending_cutoff =
            Utc::now() - chrono::Duration::seconds(sending_visibility_seconds.max(0));
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
                    UPDATE notifications SET status='sending', updated_at=now()
                    WHERE id IN (
                      SELECT id FROM notifications
                      WHERE (status IN ('queued','failed') AND next_attempt_at <= now())
                         OR (status='sending' AND updated_at <= $1)
                      ORDER BY next_attempt_at
                      LIMIT $2 FOR UPDATE SKIP LOCKED
                    ) RETURNING *
                    "#,
                )
                .bind(sending_cutoff)
                .bind(limit)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("claim due: {e}"))?;
                rows.iter().map(row_to_record).collect()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let now = Utc::now();
                let mut due: Vec<NotificationRecord> = mem
                    .notifications
                    .values()
                    .filter(|n| {
                        (matches!(n.status.as_str(), "queued" | "failed")
                            && parse_ts(&n.next_attempt_at)
                                .map(|t| t <= now)
                                .unwrap_or(true))
                            || (n.status == "sending"
                                && parse_ts(&n.updated_at)
                                    .map(|t| t <= sending_cutoff)
                                    .unwrap_or(true))
                    })
                    .cloned()
                    .collect();
                due.sort_by(|a, b| a.next_attempt_at.cmp(&b.next_attempt_at));
                due.truncate(limit.max(0) as usize);
                for n in &due {
                    if let Some(stored) = mem.notifications.get_mut(&n.id) {
                        stored.status = "sending".into();
                        stored.updated_at = iso(now);
                    }
                }
                Ok(due)
            }
        }
    }

    pub async fn get_preference(
        &self,
        tenant: &str,
        recipient: &str,
    ) -> Result<Option<PreferenceRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    "SELECT * FROM notification_preferences WHERE tenant=$1 AND recipient=$2",
                )
                .bind(tenant)
                .bind(recipient)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("get preference: {e}"))?;
                row.as_ref().map(row_to_preference).transpose()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if let Some(error) = take_injected_failure(&mut mem, "get_preference") {
                    return Err(error);
                }
                Ok(mem
                    .preferences
                    .get(&format!("{tenant}\u{0}{recipient}"))
                    .cloned())
            }
        }
    }

    pub async fn set_preference(
        &self,
        tenant: &str,
        recipient: &str,
        channels: Vec<String>,
        unsubscribed: bool,
    ) -> Result<PreferenceRecord, String> {
        let record = PreferenceRecord {
            tenant: tenant.to_string(),
            recipient: recipient.to_string(),
            channels,
            unsubscribed,
            updated_at: iso(Utc::now()),
        };
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    INSERT INTO notification_preferences (tenant, recipient, channels, unsubscribed, updated_at)
                    VALUES ($1,$2,$3,$4,now())
                    ON CONFLICT (tenant, recipient) DO UPDATE SET channels=$3, unsubscribed=$4, updated_at=now()
                    RETURNING *
                    "#,
                )
                .bind(&record.tenant)
                .bind(&record.recipient)
                .bind(json!(record.channels))
                .bind(record.unsubscribed)
                .fetch_one(pool)
                .await
                .map_err(|e| format!("set preference: {e}"))?;
                row_to_preference(&row)
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                mem.preferences.insert(
                    format!("{tenant}\u{0}{recipient}"),
                    record.clone(),
                );
                Ok(record)
            }
        }
    }

    pub async fn create_template(&self, input: NewTemplate) -> Result<TemplateRecord, String> {
        let now = iso(Utc::now());
        let record = TemplateRecord {
            id: Uuid::new_v4().to_string(),
            tenant: input.tenant,
            slug: input.slug,
            name: input.name,
            subject: input.subject,
            body: input.body,
            variables: input.variables,
            version: 1,
            archived_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        match &self.backend {
            Backend::Postgres(pool) => {
                let id: Uuid = record.id.parse().map_err(|_| "invalid uuid")?;
                let row = sqlx::query(
                    r#"
                    INSERT INTO notification_templates
                      (id, tenant, slug, name, subject, body, variables, version)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,1)
                    RETURNING *
                    "#,
                )
                .bind(id)
                .bind(&record.tenant)
                .bind(&record.slug)
                .bind(&record.name)
                .bind(&record.subject)
                .bind(&record.body)
                .bind(json!(record.variables))
                .fetch_one(pool)
                .await
                .map_err(|e| {
                    if e.to_string().contains("duplicate key") {
                        "template slug exists".to_string()
                    } else {
                        format!("insert template: {e}")
                    }
                })?;
                row_to_template(&row)
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if mem
                    .templates
                    .values()
                    .any(|t| t.tenant == record.tenant && t.slug == record.slug)
                {
                    return Err("template slug exists".into());
                }
                mem.templates.insert(record.id.clone(), record.clone());
                Ok(record)
            }
        }
    }

    pub async fn get_template(
        &self,
        tenant: &str,
        id: &str,
    ) -> Result<Option<TemplateRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let id: Uuid = id.parse().map_err(|_| "invalid template id")?;
                let row = sqlx::query(
                    "SELECT * FROM notification_templates WHERE tenant=$1 AND id=$2 LIMIT 1",
                )
                .bind(tenant)
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("get template: {e}"))?;
                row.as_ref().map(row_to_template).transpose()
            }
            Backend::Memory(memory) => Ok(memory
                .lock()
                .await
                .templates
                .get(id)
                .filter(|t| t.tenant == tenant)
                .cloned()),
        }
    }

    pub async fn get_template_by_slug(
        &self,
        tenant: &str,
        slug: &str,
    ) -> Result<Option<TemplateRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    "SELECT * FROM notification_templates WHERE tenant=$1 AND slug=$2 LIMIT 1",
                )
                .bind(tenant)
                .bind(slug)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("get template: {e}"))?;
                row.as_ref().map(row_to_template).transpose()
            }
            Backend::Memory(memory) => Ok(memory
                .lock()
                .await
                .templates
                .values()
                .find(|t| t.tenant == tenant && t.slug == slug)
                .cloned()),
        }
    }

    pub async fn list_templates(
        &self,
        tenant: &str,
        q: &str,
        include_archived: bool,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<TemplateRecord>, i64), String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let needle = format!("%{q}%");
                let total = sqlx::query(
                    r#"
                    SELECT count(*)::bigint AS n FROM notification_templates
                    WHERE tenant=$1 AND ($3 OR archived_at IS NULL)
                      AND ($2='' OR slug ILIKE $4 OR name ILIKE $4)
                    "#,
                )
                .bind(tenant)
                .bind(q)
                .bind(include_archived)
                .bind(&needle)
                .fetch_one(pool)
                .await
                .map_err(|e| format!("count templates: {e}"))?
                .try_get::<i64, _>("n")
                .map_err(err)?;
                let rows = sqlx::query(
                    r#"
                    SELECT * FROM notification_templates
                    WHERE tenant=$1 AND ($3 OR archived_at IS NULL)
                      AND ($2='' OR slug ILIKE $4 OR name ILIKE $4)
                    ORDER BY created_at DESC, id
                    LIMIT $5 OFFSET $6
                    "#,
                )
                .bind(tenant)
                .bind(q)
                .bind(include_archived)
                .bind(&needle)
                .bind(limit)
                .bind(offset)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("list templates: {e}"))?;
                let items = rows.iter().map(row_to_template).collect::<Result<Vec<_>, _>>()?;
                Ok((items, total))
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                let needle = q.to_lowercase();
                let mut rows: Vec<TemplateRecord> = mem
                    .templates
                    .values()
                    .filter(|t| t.tenant == tenant)
                    .filter(|t| include_archived || t.archived_at.is_none())
                    .filter(|t| {
                        needle.is_empty()
                            || t.slug.to_lowercase().contains(&needle)
                            || t.name.to_lowercase().contains(&needle)
                    })
                    .cloned()
                    .collect();
                rows.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
                let total = rows.len() as i64;
                let page = rows
                    .into_iter()
                    .skip(offset.max(0) as usize)
                    .take(limit.max(0) as usize)
                    .collect();
                Ok((page, total))
            }
        }
    }

    pub async fn update_template(
        &self,
        tenant: &str,
        id: &str,
        name: Option<String>,
        subject: Option<String>,
        body: Option<String>,
        variables: Option<Vec<String>>,
    ) -> Result<Option<TemplateRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let id: Uuid = id.parse().map_err(|_| "invalid template id")?;
                let row = sqlx::query(
                    r#"
                    UPDATE notification_templates
                    SET name=COALESCE($3,name), subject=COALESCE($4,subject),
                        body=COALESCE($5,body), variables=COALESCE($6,variables),
                        version=version+1, updated_at=now()
                    WHERE tenant=$1 AND id=$2
                    RETURNING *
                    "#,
                )
                .bind(tenant)
                .bind(id)
                .bind(name)
                .bind(subject)
                .bind(body)
                .bind(variables.map(|v| json!(v)))
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("update template: {e}"))?;
                row.as_ref().map(row_to_template).transpose()
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let Some(t) = mem.templates.get_mut(id) else {
                    return Ok(None);
                };
                if t.tenant != tenant {
                    return Ok(None);
                }
                if let Some(v) = name { t.name = v; }
                if let Some(v) = subject { t.subject = v; }
                if let Some(v) = body { t.body = v; }
                if let Some(v) = variables { t.variables = v; }
                t.version += 1;
                t.updated_at = iso(Utc::now());
                Ok(Some(t.clone()))
            }
        }
    }

    pub async fn archive_template(&self, tenant: &str, id: &str) -> Result<bool, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let id: Uuid = id.parse().map_err(|_| "invalid template id")?;
                let result = sqlx::query(
                    "UPDATE notification_templates SET archived_at=now(), updated_at=now() WHERE tenant=$1 AND id=$2 AND archived_at IS NULL",
                )
                .bind(tenant)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| format!("archive template: {e}"))?;
                Ok(result.rows_affected() > 0)
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let Some(t) = mem.templates.get_mut(id) else {
                    return Ok(false);
                };
                if t.tenant != tenant || t.archived_at.is_some() {
                    return Ok(false);
                }
                t.archived_at = Some(iso(Utc::now()));
                t.updated_at = iso(Utc::now());
                Ok(true)
            }
        }
    }

    #[allow(dead_code)]
    pub async fn clear_memory(&self) {
        if let Backend::Memory(memory) = &self.backend {
            let mut mem = memory.lock().await;
            mem.notifications.clear();
            mem.preferences.clear();
        }
    }

    /// Test-only: make the next call to `method` (e.g. "claim_one",
    /// "get_preference", "update") fail once, to exercise fail-closed
    /// handler paths against a simulated store outage.
    #[cfg(test)]
    pub async fn simulate_failure(&self, method: &'static str) {
        if let Backend::Memory(memory) = &self.backend {
            memory.lock().await.fail_next = Some(method);
        }
    }
}

fn row_to_record(row: &sqlx::postgres::PgRow) -> Result<NotificationRecord, String> {
    Ok(NotificationRecord {
        id: row.try_get::<Uuid, _>("id").map_err(err)?.to_string(),
        tenant: row.try_get("tenant").map_err(err)?,
        channel: row.try_get("channel").map_err(err)?,
        recipient: row.try_get::<Value, _>("recipient").map_err(err)?,
        subject: row.try_get("subject").map_err(err)?,
        body: row.try_get("body").map_err(err)?,
        status: row.try_get("status").map_err(err)?,
        attempts: row.try_get::<Value, _>("attempts").map_err(err)?,
        idempotency_key: row.try_get("idempotency_key").map_err(err)?,
        metadata: row.try_get::<Value, _>("metadata").map_err(err)?,
        created_at: row
            .try_get::<DateTime<Utc>, _>("created_at")
            .map_err(err)
            .map(iso)?,
        updated_at: row
            .try_get::<DateTime<Utc>, _>("updated_at")
            .map_err(err)
            .map(iso)?,
        next_attempt_at: row
            .try_get::<DateTime<Utc>, _>("next_attempt_at")
            .map_err(err)
            .map(iso)?,
        dead_reason: row.try_get("dead_reason").map_err(err)?,
        published_at: row
            .try_get::<Option<DateTime<Utc>>, _>("published_at")
            .map_err(err)?
            .map(iso),
        template_id: row
            .try_get::<Option<Uuid>, _>("template_id")
            .map_err(err)?
            .map(|v| v.to_string()),
        template_version: row.try_get("template_version").map_err(err)?,
    })
}

fn row_to_template(row: &sqlx::postgres::PgRow) -> Result<TemplateRecord, String> {
    Ok(TemplateRecord {
        id: row.try_get::<Uuid, _>("id").map_err(err)?.to_string(),
        tenant: row.try_get("tenant").map_err(err)?,
        slug: row.try_get("slug").map_err(err)?,
        name: row.try_get("name").map_err(err)?,
        subject: row.try_get("subject").map_err(err)?,
        body: row.try_get("body").map_err(err)?,
        variables: row
            .try_get::<Value, _>("variables")
            .map_err(err)?
            .as_array()
            .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        version: row.try_get("version").map_err(err)?,
        archived_at: row
            .try_get::<Option<DateTime<Utc>>, _>("archived_at")
            .map_err(err)?
            .map(iso),
        created_at: row.try_get::<DateTime<Utc>, _>("created_at").map_err(err).map(iso)?,
        updated_at: row.try_get::<DateTime<Utc>, _>("updated_at").map_err(err).map(iso)?,
    })
}

fn row_to_preference(row: &sqlx::postgres::PgRow) -> Result<PreferenceRecord, String> {
    Ok(PreferenceRecord {
        tenant: row.try_get("tenant").map_err(err)?,
        recipient: row.try_get("recipient").map_err(err)?,
        channels: row.try_get::<Value, _>("channels").map_err(err)?.as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        unsubscribed: row.try_get("unsubscribed").map_err(err)?,
        updated_at: row
            .try_get::<DateTime<Utc>, _>("updated_at")
            .map_err(err)
            .map(iso)?,
    })
}

fn err(error: sqlx::Error) -> String {
    format!("row decode: {error}")
}

pub fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}
