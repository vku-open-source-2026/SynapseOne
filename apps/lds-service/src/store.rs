// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseLDS persistence — Postgres with an in-memory fallback (dev/test).
//!
//! The production tables are the same ones the Drizzle migrations created;
//! startup only runs idempotent `CREATE TABLE IF NOT EXISTS` statements so a
//! rolling deploy never fights the TypeScript migrator over the journal.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, QueryBuilder, Row};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::projector::{RegistryAttribute, StoredRecord};

#[derive(Debug, Clone)]
pub struct StoredDatasource {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub entity_type: String,
    pub license: String,
    pub license_url: Option<String>,
    pub contexts: Vec<String>,
    pub default_visibility: String,
    pub description: Option<String>,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewDatasource {
    pub slug: String,
    pub name: String,
    pub entity_type: String,
    pub license: String,
    pub license_url: Option<String>,
    pub contexts: Vec<String>,
    pub default_visibility: String,
    pub description: Option<String>,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DatasourcePatch {
    pub slug: Option<String>,
    pub name: Option<String>,
    pub entity_type: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<Option<String>>,
    pub contexts: Option<Vec<String>>,
    pub default_visibility: Option<String>,
    pub description: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct StoreError {
    pub conflict: bool,
    pub message: String,
}

impl StoreError {
    fn conflict(message: impl Into<String>) -> Self {
        Self {
            conflict: true,
            message: message.into(),
        }
    }

    fn other(message: impl Into<String>) -> Self {
        Self {
            conflict: false,
            message: message.into(),
        }
    }
}

#[derive(Default)]
struct Memory {
    datasources: HashMap<String, StoredDatasource>,
    attributes: HashMap<String, HashMap<String, RegistryAttribute>>,
    records: HashMap<String, HashMap<String, StoredRecord>>,
}

#[derive(Clone)]
enum Backend {
    Postgres(PgPool),
    Memory(Arc<Mutex<Memory>>),
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
                backend: Backend::Memory(Arc::new(Mutex::new(Memory::default()))),
            }),
        }
    }

    pub fn uses_postgres(&self) -> bool {
        matches!(self.backend, Backend::Postgres(_))
    }

    async fn ensure_tables(&self) -> Result<(), String> {
        let Backend::Postgres(pool) = &self.backend else {
            return Ok(());
        };
        let statements = [
            r#"
            CREATE TABLE IF NOT EXISTS lds_datasources (
              id text PRIMARY KEY,
              slug text NOT NULL,
              name text NOT NULL,
              entity_type text NOT NULL,
              license text NOT NULL,
              license_url text,
              contexts jsonb NOT NULL DEFAULT '[]'::jsonb,
              default_visibility text NOT NULL DEFAULT 'internal',
              description text,
              org_id text,
              account_id text,
              created_by text,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now()
            )
            "#,
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_lds_datasources_scope_slug ON lds_datasources (coalesce(org_id, ''), slug)",
            "CREATE INDEX IF NOT EXISTS idx_lds_datasources_tenant ON lds_datasources (org_id, account_id)",
            r#"
            CREATE TABLE IF NOT EXISTS lds_attributes (
              datasource_id text NOT NULL REFERENCES lds_datasources(id) ON DELETE CASCADE,
              name text NOT NULL,
              ngsi_ld_type text NOT NULL DEFAULT 'Property',
              visibility text NOT NULL DEFAULT 'internal',
              description text,
              source_field text,
              updated_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (datasource_id, name)
            )
            "#,
            r#"
            CREATE TABLE IF NOT EXISTS lds_records (
              datasource_id text NOT NULL REFERENCES lds_datasources(id) ON DELETE CASCADE,
              entity_id text NOT NULL,
              source_record_id text,
              version integer NOT NULL DEFAULT 1,
              core jsonb NOT NULL DEFAULT '{}'::jsonb,
              entity jsonb NOT NULL DEFAULT '{}'::jsonb,
              attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (datasource_id, entity_id)
            )
            "#,
            "CREATE INDEX IF NOT EXISTS idx_lds_records_ds ON lds_records (datasource_id, updated_at DESC)",
        ];
        for statement in statements {
            sqlx::query(statement)
                .execute(pool)
                .await
                .map_err(|e| format!("ensure tables: {e}"))?;
        }
        Ok(())
    }

    pub async fn create_datasource(
        &self,
        input: NewDatasource,
    ) -> Result<StoredDatasource, StoreError> {
        let record = StoredDatasource {
            id: Uuid::new_v4().to_string(),
            slug: input.slug,
            name: input.name,
            entity_type: input.entity_type,
            license: input.license,
            license_url: input.license_url,
            contexts: input.contexts,
            default_visibility: input.default_visibility,
            description: input.description,
            org_id: input.org_id,
            account_id: input.account_id,
            created_by: input.created_by,
            created_at: iso(Utc::now()),
            updated_at: iso(Utc::now()),
        };
        match &self.backend {
            Backend::Postgres(pool) => {
                let result = sqlx::query(
                    r#"
                    INSERT INTO lds_datasources
                      (id, slug, name, entity_type, license, license_url, contexts, default_visibility, description, org_id, account_id, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                    RETURNING *
                    "#,
                )
                .bind(&record.id)
                .bind(&record.slug)
                .bind(&record.name)
                .bind(&record.entity_type)
                .bind(&record.license)
                .bind(&record.license_url)
                .bind(json!(record.contexts))
                .bind(&record.default_visibility)
                .bind(&record.description)
                .bind(&record.org_id)
                .bind(&record.account_id)
                .bind(&record.created_by)
                .fetch_one(pool)
                .await;
                match result {
                    Ok(row) => row_to_datasource(&row).map_err(StoreError::other),
                    Err(error) if is_unique_violation(&error) => Err(StoreError::conflict(format!(
                        "datasource slug '{}' already exists in this scope",
                        record.slug
                    ))),
                    Err(error) => Err(StoreError::other(error.to_string())),
                }
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                if mem.datasources.values().any(|existing| {
                    existing.org_id.clone().unwrap_or_default()
                        == record.org_id.clone().unwrap_or_default()
                        && existing.slug == record.slug
                }) {
                    return Err(StoreError::conflict(format!(
                        "datasource slug '{}' already exists in this scope",
                        record.slug
                    )));
                }
                mem.datasources.insert(record.id.clone(), record.clone());
                Ok(record)
            }
        }
    }

    pub async fn get_datasource(&self, id: &str) -> Result<Option<StoredDatasource>, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query("SELECT * FROM lds_datasources WHERE id = $1 LIMIT 1")
                    .bind(id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| StoreError::other(e.to_string()))?;
                row.as_ref()
                    .map(row_to_datasource)
                    .transpose()
                    .map_err(StoreError::other)
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                Ok(mem.datasources.get(id).cloned())
            }
        }
    }

    pub async fn list_datasources(&self) -> Result<Vec<StoredDatasource>, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT * FROM lds_datasources ORDER BY created_at ASC",
                )
                .fetch_all(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                rows.iter()
                    .map(row_to_datasource)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StoreError::other)
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                let mut items: Vec<StoredDatasource> =
                    mem.datasources.values().cloned().collect();
                items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
                Ok(items)
            }
        }
    }

    pub async fn update_datasource(
        &self,
        id: &str,
        patch: DatasourcePatch,
    ) -> Result<Option<StoredDatasource>, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let mut builder: QueryBuilder<sqlx::Postgres> =
                    QueryBuilder::new("UPDATE lds_datasources SET updated_at = now()");
                if let Some(slug) = &patch.slug {
                    builder.push(", slug = ").push_bind(slug.clone());
                }
                if let Some(name) = &patch.name {
                    builder.push(", name = ").push_bind(name.clone());
                }
                if let Some(entity_type) = &patch.entity_type {
                    builder.push(", entity_type = ").push_bind(entity_type.clone());
                }
                if let Some(license) = &patch.license {
                    builder.push(", license = ").push_bind(license.clone());
                }
                if let Some(license_url) = &patch.license_url {
                    builder
                        .push(", license_url = ")
                        .push_bind(license_url.clone());
                }
                if let Some(contexts) = &patch.contexts {
                    builder.push(", contexts = ").push_bind(json!(contexts));
                }
                if let Some(visibility) = &patch.default_visibility {
                    builder
                        .push(", default_visibility = ")
                        .push_bind(visibility.clone());
                }
                if let Some(description) = &patch.description {
                    builder
                        .push(", description = ")
                        .push_bind(description.clone());
                }
                builder.push(" WHERE id = ").push_bind(id.to_string());
                builder.push(" RETURNING *");
                let result = builder.build().fetch_optional(pool).await;
                match result {
                    Ok(Some(row)) => row_to_datasource(&row)
                        .map(Some)
                        .map_err(StoreError::other),
                    Ok(None) => Ok(None),
                    Err(error) if is_unique_violation(&error) => Err(StoreError::conflict(
                        format!(
                            "datasource slug '{}' already exists in this scope",
                            patch.slug.unwrap_or_default()
                        ),
                    )),
                    Err(error) => Err(StoreError::other(error.to_string())),
                }
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let Some(current) = mem.datasources.get(id).cloned() else {
                    return Ok(None);
                };
                let mut next = current;
                if let Some(slug) = patch.slug {
                    next.slug = slug;
                }
                if let Some(name) = patch.name {
                    next.name = name;
                }
                if let Some(entity_type) = patch.entity_type {
                    next.entity_type = entity_type;
                }
                if let Some(license) = patch.license {
                    next.license = license;
                }
                if let Some(license_url) = patch.license_url {
                    next.license_url = license_url;
                }
                if let Some(contexts) = patch.contexts {
                    next.contexts = contexts;
                }
                if let Some(visibility) = patch.default_visibility {
                    next.default_visibility = visibility;
                }
                if let Some(description) = patch.description {
                    next.description = description;
                }
                next.updated_at = iso(Utc::now());
                mem.datasources.insert(id.to_string(), next.clone());
                Ok(Some(next))
            }
        }
    }

    pub async fn delete_datasource(&self, id: &str) -> Result<bool, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query("DELETE FROM lds_datasources WHERE id = $1 RETURNING id")
                    .bind(id)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| StoreError::other(e.to_string()))?;
                Ok(!rows.is_empty())
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let existed = mem.datasources.remove(id).is_some();
                mem.attributes.remove(id);
                mem.records.remove(id);
                Ok(existed)
            }
        }
    }

    pub async fn get_attributes(
        &self,
        datasource_id: &str,
    ) -> Result<Vec<RegistryAttribute>, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT * FROM lds_attributes WHERE datasource_id = $1 ORDER BY name ASC",
                )
                .bind(datasource_id)
                .fetch_all(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                rows.iter()
                    .map(row_to_attribute)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StoreError::other)
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                let mut items: Vec<RegistryAttribute> = mem
                    .attributes
                    .get(datasource_id)
                    .map(|map| map.values().cloned().collect())
                    .unwrap_or_default();
                items.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(items)
            }
        }
    }

    pub async fn replace_attributes(
        &self,
        datasource_id: &str,
        attributes: Vec<RegistryAttribute>,
    ) -> Result<Vec<RegistryAttribute>, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let mut tx = pool
                    .begin()
                    .await
                    .map_err(|e| StoreError::other(e.to_string()))?;
                sqlx::query("DELETE FROM lds_attributes WHERE datasource_id = $1")
                    .bind(datasource_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StoreError::other(e.to_string()))?;
                for attribute in &attributes {
                    sqlx::query(
                        r#"
                        INSERT INTO lds_attributes
                          (datasource_id, name, ngsi_ld_type, visibility, description, source_field)
                        VALUES ($1,$2,$3,$4,$5,$6)
                        "#,
                    )
                    .bind(datasource_id)
                    .bind(&attribute.name)
                    .bind(&attribute.ngsi_ld_type)
                    .bind(&attribute.visibility)
                    .bind(&attribute.description)
                    .bind(&attribute.source_field)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StoreError::other(e.to_string()))?;
                }
                tx.commit()
                    .await
                    .map_err(|e| StoreError::other(e.to_string()))?;
                self.get_attributes(datasource_id).await
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let map: HashMap<String, RegistryAttribute> = attributes
                    .into_iter()
                    .map(|attribute| (attribute.name.clone(), attribute))
                    .collect();
                mem.attributes.insert(datasource_id.to_string(), map);
                let mut items: Vec<RegistryAttribute> = mem
                    .attributes
                    .get(datasource_id)
                    .map(|map| map.values().cloned().collect())
                    .unwrap_or_default();
                items.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(items)
            }
        }
    }

    pub async fn upsert_record(
        &self,
        record: StoredRecord,
    ) -> Result<(StoredRecord, bool), StoreError> {
        let mut stored = record;
        let mut core = stored.core.as_object().cloned().unwrap_or_default();
        if core.get("internalId").is_none() {
            core.insert("internalId".into(), Value::String(Uuid::new_v4().to_string()));
        }
        stored.core = Value::Object(core);
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    INSERT INTO lds_records
                      (datasource_id, entity_id, source_record_id, version, core, entity, attributes, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
                    ON CONFLICT (datasource_id, entity_id) DO UPDATE SET
                      source_record_id = excluded.source_record_id,
                      version = lds_records.version + 1,
                      core = excluded.core || jsonb_build_object(
                        'internalId', lds_records.core->>'internalId',
                        'createdAt', lds_records.core->>'createdAt'),
                      entity = excluded.entity,
                      attributes = excluded.attributes,
                      updated_at = now()
                    RETURNING *, (xmax = 0) AS inserted
                    "#,
                )
                .bind(&stored.datasource_id)
                .bind(&stored.entity_id)
                .bind(&stored.source_record_id)
                .bind(stored.version)
                .bind(&stored.core)
                .bind(&stored.entity)
                .bind(&stored.attributes)
                .fetch_one(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                let inserted: bool = row
                    .try_get("inserted")
                    .map_err(|e| StoreError::other(e.to_string()))?;
                let saved = row_to_record(&row).map_err(StoreError::other)?;
                Ok((saved, inserted))
            }
            Backend::Memory(memory) => {
                let mut mem = memory.lock().await;
                let records = mem.records.entry(stored.datasource_id.clone()).or_default();
                let created = !records.contains_key(&stored.entity_id);
                if let Some(previous) = records.get(&stored.entity_id) {
                    let mut core = stored.core.as_object().cloned().unwrap_or_default();
                    core.insert("version".into(), json!(previous.version + 1));
                    if let Some(internal_id) = previous.core.get("internalId") {
                        core.insert("internalId".into(), internal_id.clone());
                    }
                    if let Some(created_at) = previous.core.get("createdAt") {
                        core.insert("createdAt".into(), created_at.clone());
                    }
                    stored.core = Value::Object(core);
                    stored.version = previous.version + 1;
                }
                records.insert(stored.entity_id.clone(), stored.clone());
                Ok((stored, created))
            }
        }
    }

    pub async fn get_record(
        &self,
        datasource_id: &str,
        entity_id: &str,
    ) -> Result<Option<StoredRecord>, StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    "SELECT * FROM lds_records WHERE datasource_id = $1 AND entity_id = $2 LIMIT 1",
                )
                .bind(datasource_id)
                .bind(entity_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                row.as_ref()
                    .map(row_to_record)
                    .transpose()
                    .map_err(StoreError::other)
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                Ok(mem
                    .records
                    .get(datasource_id)
                    .and_then(|records| records.get(entity_id))
                    .cloned())
            }
        }
    }

    pub async fn list_records(
        &self,
        datasource_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<StoredRecord>, i64), StoreError> {
        match &self.backend {
            Backend::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT * FROM lds_records WHERE datasource_id = $1 ORDER BY entity_id ASC LIMIT $2 OFFSET $3",
                )
                .bind(datasource_id)
                .bind(limit)
                .bind(offset)
                .fetch_all(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*)::bigint FROM lds_records WHERE datasource_id = $1",
                )
                .bind(datasource_id)
                .fetch_one(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                let items = rows
                    .iter()
                    .map(row_to_record)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StoreError::other)?;
                Ok((items, count))
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                let mut all: Vec<StoredRecord> = mem
                    .records
                    .get(datasource_id)
                    .map(|records| records.values().cloned().collect())
                    .unwrap_or_default();
                all.sort_by(|a, b| a.entity_id.cmp(&b.entity_id));
                let total = all.len() as i64;
                let items = all
                    .into_iter()
                    .skip(offset.max(0) as usize)
                    .take(limit.max(0) as usize)
                    .collect();
                Ok((items, total))
            }
        }
    }

    pub async fn stats(
        &self,
        datasource_id: &str,
    ) -> Result<(i64, Option<String>), StoreError> {
        let attributes = self.get_attributes(datasource_id).await?;
        let _ = attributes;
        match &self.backend {
            Backend::Postgres(pool) => {
                let row = sqlx::query(
                    "SELECT count(*)::bigint AS n, max(updated_at) AS last FROM lds_records WHERE datasource_id = $1",
                )
                .bind(datasource_id)
                .fetch_one(pool)
                .await
                .map_err(|e| StoreError::other(e.to_string()))?;
                let count: i64 = row.try_get("n").map_err(|e| StoreError::other(e.to_string()))?;
                let last: Option<DateTime<Utc>> = row
                    .try_get("last")
                    .map_err(|e| StoreError::other(e.to_string()))?;
                Ok((count, last.map(iso)))
            }
            Backend::Memory(memory) => {
                let mem = memory.lock().await;
                let all: Vec<StoredRecord> = mem
                    .records
                    .get(datasource_id)
                    .map(|records| records.values().cloned().collect())
                    .unwrap_or_default();
                let mut last: Option<String> = None;
                for record in &all {
                    if let Some(updated) = record.core.get("updatedAt").and_then(Value::as_str) {
                        if last.as_deref().map(|current| updated > current).unwrap_or(true) {
                            last = Some(updated.to_string());
                        }
                    }
                }
                Ok((all.len() as i64, last))
            }
        }
    }

    #[allow(dead_code)]
    pub async fn clear_memory(&self) {
        if let Backend::Memory(memory) = &self.backend {
            *memory.lock().await = Memory::default();
        }
    }
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(database) => database.code().as_deref() == Some("23505"),
        _ => false,
    }
}

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn row_to_datasource(row: &PgRow) -> Result<StoredDatasource, String> {
    let contexts: Value = row.try_get("contexts").map_err(|e| e.to_string())?;
    Ok(StoredDatasource {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        slug: row.try_get("slug").map_err(|e| e.to_string())?,
        name: row.try_get("name").map_err(|e| e.to_string())?,
        entity_type: row.try_get("entity_type").map_err(|e| e.to_string())?,
        license: row.try_get("license").map_err(|e| e.to_string())?,
        license_url: row.try_get("license_url").map_err(|e| e.to_string())?,
        contexts: contexts
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        default_visibility: row
            .try_get("default_visibility")
            .map_err(|e| e.to_string())?,
        description: row.try_get("description").map_err(|e| e.to_string())?,
        org_id: row.try_get("org_id").map_err(|e| e.to_string())?,
        account_id: row.try_get("account_id").map_err(|e| e.to_string())?,
        created_by: row.try_get("created_by").map_err(|e| e.to_string())?,
        created_at: row
            .try_get::<DateTime<Utc>, _>("created_at")
            .map_err(|e| e.to_string())
            .map(iso)?,
        updated_at: row
            .try_get::<DateTime<Utc>, _>("updated_at")
            .map_err(|e| e.to_string())
            .map(iso)?,
    })
}

fn row_to_attribute(row: &PgRow) -> Result<RegistryAttribute, String> {
    let ngsi_ld_type: String = row.try_get("ngsi_ld_type").map_err(|e| e.to_string())?;
    let visibility: String = row.try_get("visibility").map_err(|e| e.to_string())?;
    Ok(RegistryAttribute {
        name: row.try_get("name").map_err(|e| e.to_string())?,
        ngsi_ld_type: if ["Property", "Relationship", "GeoProperty"].contains(&ngsi_ld_type.as_str()) {
            ngsi_ld_type
        } else {
            "Property".into()
        },
        visibility: if ["public", "restricted", "internal"].contains(&visibility.as_str()) {
            visibility
        } else {
            "internal".into()
        },
        description: row.try_get("description").map_err(|e| e.to_string())?,
        source_field: row.try_get("source_field").map_err(|e| e.to_string())?,
    })
}

fn row_to_record(row: &PgRow) -> Result<StoredRecord, String> {
    Ok(StoredRecord {
        datasource_id: row.try_get("datasource_id").map_err(|e| e.to_string())?,
        entity_id: row.try_get("entity_id").map_err(|e| e.to_string())?,
        source_record_id: row.try_get("source_record_id").map_err(|e| e.to_string())?,
        version: row
            .try_get::<i32, _>("version")
            .map_err(|e| e.to_string())? as i64,
        core: row.try_get("core").map_err(|e| e.to_string())?,
        entity: row.try_get("entity").map_err(|e| e.to_string())?,
        attributes: row.try_get("attributes").map_err(|e| e.to_string())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn datasource_slug_conflicts_per_org() {
        let store = Store::connect(None).await.unwrap();
        let input = || NewDatasource {
            slug: "registry".into(),
            name: "Business Registry".into(),
            entity_type: "Organization".into(),
            license: "CC-BY-4.0".into(),
            license_url: None,
            contexts: vec![],
            default_visibility: "public".into(),
            description: None,
            org_id: Some("org-a".into()),
            account_id: None,
            created_by: None,
        };
        store.create_datasource(input()).await.unwrap();
        assert!(store.create_datasource(input()).await.unwrap_err().conflict);
        let mut other = input();
        other.org_id = Some("org-b".into());
        assert!(store.create_datasource(other).await.is_ok());
    }

    #[tokio::test]
    async fn record_upsert_versions_and_stats() {
        let store = Store::connect(None).await.unwrap();
        let datasource = store
            .create_datasource(NewDatasource {
                slug: "ds".into(),
                name: "DS".into(),
                entity_type: "Organization".into(),
                license: "CC0-1.0".into(),
                license_url: None,
                contexts: vec![],
                default_visibility: "public".into(),
                description: None,
                org_id: Some("org-a".into()),
                account_id: None,
                created_by: None,
            })
            .await
            .unwrap();
        let record = StoredRecord {
            datasource_id: datasource.id.clone(),
            entity_id: "urn:ngsi-ld:Organization:1".into(),
            source_record_id: Some("1".into()),
            version: 1,
            core: json!({"version": 1}),
            entity: json!({"id": "urn:ngsi-ld:Organization:1", "type": "Organization"}),
            attributes: json!({"name": {"type": "Property", "value": "ACME"}}),
        };
        let (_, created) = store.upsert_record(record.clone()).await.unwrap();
        assert!(created);
        let (saved, created) = store.upsert_record(record).await.unwrap();
        assert!(!created);
        assert_eq!(saved.version, 2);
        assert!(saved.core.get("internalId").is_some());
        let (count, _) = store.stats(&datasource.id).await.unwrap();
        assert_eq!(count, 1);
    }
}
