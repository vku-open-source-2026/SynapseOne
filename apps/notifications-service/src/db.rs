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
}

#[derive(Default)]
struct MemoryStore {
    notifications: HashMap<String, NotificationRecord>,
    preferences: HashMap<String, PreferenceRecord>,
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
        };
        match &self.backend {
            Backend::Postgres(pool) => {
                let record_id: Uuid = record.id.parse().map_err(|_| "invalid uuid")?;
                let row = sqlx::query(
                    r#"
                    INSERT INTO notifications
                      (id, tenant, channel, recipient, subject, body, status, attempts, idempotency_key, metadata, created_at, updated_at, next_attempt_at)
                    VALUES ($1,$2,$3,$4,$5,$6,'queued','[]'::jsonb,$7,$8,now(),now(),now())
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

    /// Claim due notifications for delivery (single replica-safe on Postgres).
    pub async fn claim_due(&self, limit: i64) -> Result<Vec<NotificationRecord>, String> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
                    UPDATE notifications SET status='sending', updated_at=now()
                    WHERE id IN (
                      SELECT id FROM notifications
                      WHERE status IN ('queued','failed') AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      LIMIT $1 FOR UPDATE SKIP LOCKED
                    ) RETURNING *
                    "#,
                )
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
                        matches!(n.status.as_str(), "queued" | "failed")
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
                let mem = memory.lock().await;
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

    #[allow(dead_code)]
    pub async fn clear_memory(&self) {
        if let Backend::Memory(memory) = &self.backend {
            let mut mem = memory.lock().await;
            mem.notifications.clear();
            mem.preferences.clear();
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
