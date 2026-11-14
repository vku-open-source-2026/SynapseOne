// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase persistence: Postgres (sqlx) with an in-memory fallback for
//! dev/tests. Tables, indexes and JSONB shapes mirror the Drizzle schema.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgArguments, PgPoolOptions, PgRow};
use sqlx::{PgPool, Postgres, Row};
use tokio::sync::{Mutex, MutexGuard, OnceCell};

use crate::error::{StoreError, StoreErrorCode};
use crate::mapping::{deep_merge, get_path_opt, set_path, BaseMapping};
use crate::pg_query::{compile_query, SqlParam};
use crate::query::{format_query_page, QuerySpec};
use crate::util::{iso, now_iso, parse_js_date};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredDatabase {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCollection {
    pub id: String,
    pub database_id: String,
    pub database_name: String,
    pub name: String,
    pub description: Option<String>,
    pub mapping: BaseMapping,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct StoredDocument {
    pub collection_id: String,
    pub id: String,
    pub data: Value,
    pub version: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct OutboxEvent {
    pub event_id: String,
    pub payload: Value,
    pub attempts: i64,
}

#[derive(Debug, Clone)]
pub struct StoredSearchRecord {
    pub id: String,
    pub collection_id: String,
    pub collection_name: String,
    pub document_id: String,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub title: String,
    pub body: String,
    pub acl: Vec<String>,
    pub embedding: Vec<f64>,
    pub metadata: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    #[serde(skip)]
    pub collection_id: String,
    pub id: String,
    pub labels: Vec<String>,
    pub properties: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    #[serde(skip)]
    pub collection_id: String,
    pub id: String,
    #[serde(rename = "from")]
    pub from: String,
    #[serde(rename = "to")]
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub properties: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct GeoFeatureRecord {
    pub collection_id: String,
    pub id: String,
    pub properties: Value,
    pub geometry: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct MemoryOutbox {
    pub event_id: String,
    pub payload: Value,
    pub published_at: Option<String>,
    pub attempts: i64,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct MemoryState {
    pub databases: HashMap<String, StoredDatabase>,
    pub collections: HashMap<String, StoredCollection>,
    pub documents: HashMap<(String, String), StoredDocument>,
    pub outbox: Vec<MemoryOutbox>,
    pub search: HashMap<String, StoredSearchRecord>,
    pub graph_nodes: HashMap<(String, String), GraphNode>,
    pub graph_edges: HashMap<(String, String), GraphEdge>,
    pub geo_features: HashMap<(String, String), GeoFeatureRecord>,
}

#[derive(Clone)]
enum Backend {
    Postgres(PgPool),
    Memory(Arc<Mutex<MemoryState>>),
}

#[derive(Clone)]
pub struct Store {
    backend: Backend,
    pub(crate) vector_ready: Arc<OnceCell<bool>>,
    pub(crate) graph_ready: Arc<OnceCell<()>>,
    pub(crate) geo_ready: Arc<OnceCell<()>>,
}

#[derive(Debug, Clone, Default)]
pub struct CollectionScope {
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub platform: bool,
}

#[derive(Debug, Clone)]
pub struct CreateDatabaseInput {
    pub name: String,
    pub description: Option<String>,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DatabasePatch {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct CreateCollectionInput {
    pub database_id: String,
    pub database_name: String,
    pub name: String,
    pub description: Option<String>,
    pub mapping: BaseMapping,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CollectionPatch {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub mapping: Option<BaseMapping>,
}

#[derive(Debug, Clone, Default)]
pub struct ListDocumentsOptions {
    pub since: Option<String>,
    pub scan_limit: Option<i64>,
    pub after_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SetDocumentOptions {
    pub merge: bool,
    pub if_version: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct SetDocumentResult {
    pub doc: StoredDocument,
    pub created: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DocumentStats {
    pub documents: i64,
    pub bytes: i64,
    pub last_updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DatabaseStats {
    pub collections: i64,
    pub documents: i64,
    pub bytes: i64,
    pub last_updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChangesPage {
    pub events: Vec<Value>,
    pub next_since: String,
    pub next_after: Option<String>,
}

const MIGRATIONS: &[(i64, &str)] = &[
    (
        1_792_553_614_991,
        include_str!("../drizzle/0000_productive_gorgon.sql"),
    ),
    (
        1_792_555_762_818,
        include_str!("../drizzle/0001_colossal_timeslip.sql"),
    ),
    (
        1_792_556_800_000,
        include_str!("../drizzle/0002_vector_store.sql"),
    ),
    (
        1_794_000_000_000,
        include_str!("../drizzle/0003_rebrand_synapseone.sql"),
    ),
    (
        1_795_000_000_000,
        include_str!("../drizzle/0004_query_indexes.sql"),
    ),
    (
        1_796_000_000_000,
        include_str!("../drizzle/0005_broad_tyrannus.sql"),
    ),
    (
        1_796_000_000_001,
        include_str!("../drizzle/0006_lying_makkari.sql"),
    ),
    (
        1_796_000_000_002,
        include_str!("../drizzle/0007_tricky_maelstrom.sql"),
    ),
    (
        1_797_000_000_000,
        include_str!("../drizzle/0008_base_databases.sql"),
    ),
];

/// Migration 0007 has no IF NOT EXISTS in Drizzle's output; the bootstrap
/// needs it to be replay-safe alongside the other idempotent statements.
const MIGRATION_OUTBOX_IDEMPOTENT: &str = r#"
CREATE TABLE IF NOT EXISTS "synapseone_base_outbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"account_id" text,
	"collection_id" text NOT NULL,
	"collection_name" text DEFAULT '' NOT NULL,
	"document_id" text NOT NULL,
	"operation" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
CREATE INDEX IF NOT EXISTS "idx_base_outbox_unpublished" ON "synapseone_base_outbox" USING btree ("published_at","occurred_at");
CREATE INDEX IF NOT EXISTS "idx_base_outbox_collection" ON "synapseone_base_outbox" USING btree ("collection_id","occurred_at");
"#;

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

async fn migrate_pool(pool: &PgPool) -> Result<(), String> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("migration connection: {error}"))?;
    sqlx::raw_sql("SELECT pg_advisory_lock(hashtext('synapseone_base_migrations'))")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("migration lock: {error}"))?;
    let result = async {
        sqlx::raw_sql(
            r#"CREATE TABLE IF NOT EXISTS "__drizzle_migrations_base" (
                id SERIAL PRIMARY KEY,
                hash text NOT NULL,
                created_at bigint
            )"#,
        )
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("migration bookkeeping: {error}"))?;
        for (when, sql) in MIGRATIONS {
            // Drizzle's journal is authoritative. Re-running a historical
            // migration can recreate indexes that a later migration removed
            // (0000 still knows the old collection-name index), so skip any
            // migration already recorded for this database.
            let applied: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM "__drizzle_migrations_base" WHERE created_at = $1"#,
            )
            .bind(*when)
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| format!("migration bookkeeping check: {error}"))?;
            if applied > 0 {
                continue;
            }
            let body = if *when == 1_796_000_000_002 {
                MIGRATION_OUTBOX_IDEMPOTENT
            } else {
                sql
            };
            sqlx::raw_sql(body)
                .execute(&mut *connection)
                .await
                .map_err(|error| format!("migration {when}: {error}"))?;
            let mut hasher = Sha256::new();
            hasher.update(body.as_bytes());
            let hash = hex(&hasher.finalize());
            sqlx::query(
                r#"INSERT INTO "__drizzle_migrations_base" (hash, created_at)
                   SELECT $1, $2
                   WHERE NOT EXISTS (
                     SELECT 1 FROM "__drizzle_migrations_base" WHERE created_at = $2
                   )"#,
            )
            .bind(hash)
            .bind(*when)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("migration bookkeeping insert: {error}"))?;
        }
        Ok(())
    }
    .await;
    let _ = sqlx::raw_sql("SELECT pg_advisory_unlock(hashtext('synapseone_base_migrations'))")
        .execute(&mut *connection)
        .await;
    result
}

impl Store {
    pub async fn connect(database_url: Option<&str>) -> Result<Self, String> {
        Self::connect_with_direct(database_url, None).await
    }

    /// `database_url` is the runtime pool (may point at PgBouncer);
    /// `direct_url` is used only for the migration advisory lock/session.
    pub async fn connect_with_direct(
        database_url: Option<&str>,
        direct_url: Option<&str>,
    ) -> Result<Self, String> {
        match database_url.filter(|url| !url.trim().is_empty()) {
            Some(url) => {
                let pool = PgPoolOptions::new()
                    .max_connections(10)
                    .connect(url)
                    .await
                    .map_err(|error| format!("connect: {error}"))?;
                let store = Self {
                    backend: Backend::Postgres(pool.clone()),
                    vector_ready: Arc::new(OnceCell::new()),
                    graph_ready: Arc::new(OnceCell::new()),
                    geo_ready: Arc::new(OnceCell::new()),
                };
                let direct = direct_url
                    .filter(|value| !value.trim().is_empty())
                    .filter(|value| *value != url);
                match direct {
                    Some(direct) => {
                        let migration_pool = PgPoolOptions::new()
                            .max_connections(2)
                            .connect(direct)
                            .await
                            .map_err(|error| format!("direct connect: {error}"))?;
                        migrate_pool(&migration_pool).await?;
                        migration_pool.close().await;
                    }
                    None => migrate_pool(&pool).await?,
                }
                Ok(store)
            }
            None => Ok(Self {
                backend: Backend::Memory(Arc::new(Mutex::new(MemoryState::default()))),
                vector_ready: Arc::new(OnceCell::new()),
                graph_ready: Arc::new(OnceCell::new()),
                geo_ready: Arc::new(OnceCell::new()),
            }),
        }
    }

    pub fn uses_postgres(&self) -> bool {
        matches!(self.backend, Backend::Postgres(_))
    }

    pub fn pool(&self) -> Option<&PgPool> {
        match &self.backend {
            Backend::Postgres(pool) => Some(pool),
            Backend::Memory(_) => None,
        }
    }

    pub async fn memory(&self) -> Option<MutexGuard<'_, MemoryState>> {
        match &self.backend {
            Backend::Memory(memory) => Some(memory.lock().await),
            Backend::Postgres(_) => None,
        }
    }

    pub async fn clear_memory(&self) {
        if let Some(mut memory) = self.memory().await {
            *memory = MemoryState::default();
        }
    }

    // ---------- databases ----------

    pub async fn create_database(
        &self,
        input: CreateDatabaseInput,
    ) -> Result<StoredDatabase, StoreError> {
        let id = crate::util::random_id();
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"INSERT INTO synapseone_base_databases
                     (id, name, description, org_id, account_id, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6)
                   ON CONFLICT DO NOTHING
                   RETURNING id, name, description, org_id, account_id, created_by, created_at, updated_at"#,
            )
            .bind(&id)
            .bind(&input.name)
            .bind(&input.description)
            .bind(&input.org_id)
            .bind(&input.account_id)
            .bind(&input.created_by)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let Some(row) = row else {
                return Err(StoreError::conflict(format!(
                    "database '{}' already exists in this scope",
                    input.name
                )));
            };
            return database_from_row(&row);
        }
        let mut memory = self.memory().await.expect("memory store");
        if memory.databases.values().any(|database| {
            database.name == input.name
                && same_scope(
                    database.org_id.as_deref(),
                    database.account_id.as_deref(),
                    input.org_id.as_deref(),
                    input.account_id.as_deref(),
                )
        }) {
            return Err(StoreError::conflict(format!(
                "database '{}' already exists in this scope",
                input.name
            )));
        }
        let now = now_iso();
        let record = StoredDatabase {
            id,
            name: input.name,
            description: input.description,
            org_id: input.org_id,
            account_id: input.account_id,
            created_by: input.created_by,
            created_at: now.clone(),
            updated_at: now,
        };
        memory.databases.insert(record.id.clone(), record.clone());
        Ok(record)
    }

    pub async fn find_database(
        &self,
        name: &str,
        scope: &CollectionScope,
    ) -> Result<Option<StoredDatabase>, StoreError> {
        if let Some(pool) = self.pool() {
            let row = if scope.platform && scope.org_id.is_none() && scope.account_id.is_none() {
                sqlx::query(
                    r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                       FROM synapseone_base_databases
                       WHERE name = $1 AND org_id IS NULL AND account_id IS NULL
                       ORDER BY created_at ASC LIMIT 1"#,
                )
                .bind(name)
                .fetch_optional(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?
            } else if let Some(org_id) = &scope.org_id {
                if let Some(account_id) = &scope.account_id {
                    let exact = sqlx::query(
                        r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                           FROM synapseone_base_databases
                           WHERE name = $1 AND org_id = $2 AND account_id = $3
                           ORDER BY created_at ASC LIMIT 1"#,
                    )
                    .bind(name)
                    .bind(org_id)
                    .bind(account_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|error| StoreError::invalid(error.to_string()))?;
                    if exact.is_some() {
                        exact
                    } else {
                        let org_wide = sqlx::query(
                            r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                               FROM synapseone_base_databases
                               WHERE name = $1 AND org_id = $2 AND account_id IS NULL
                               ORDER BY created_at ASC LIMIT 1"#,
                        )
                        .bind(name)
                        .bind(org_id)
                        .fetch_optional(pool)
                        .await
                        .map_err(|error| StoreError::invalid(error.to_string()))?;
                        if org_wide.is_some() {
                            org_wide
                        } else {
                            let rows = sqlx::query(
                                r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                                   FROM synapseone_base_databases
                                   WHERE name = $1 AND org_id = $2
                                   ORDER BY created_at ASC LIMIT 2"#,
                            )
                            .bind(name)
                            .bind(org_id)
                            .fetch_all(pool)
                            .await
                            .map_err(|error| StoreError::invalid(error.to_string()))?;
                            if rows.len() > 1 {
                                return Err(StoreError::conflict(format!(
                                    "database '{name}' is ambiguous in this org; add accountId to disambiguate"
                                )));
                            }
                            rows.into_iter().next()
                        }
                    }
                } else {
                    sqlx::query(
                        r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                           FROM synapseone_base_databases
                           WHERE name = $1 AND org_id = $2 AND account_id IS NULL
                           ORDER BY created_at ASC LIMIT 1"#,
                    )
                    .bind(name)
                    .bind(org_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|error| StoreError::invalid(error.to_string()))?
                }
            } else {
                sqlx::query(
                    r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                       FROM synapseone_base_databases
                       WHERE name = $1 AND org_id IS NULL AND account_id = $2
                       ORDER BY created_at ASC LIMIT 1"#,
                )
                .bind(name)
                .bind(scope.account_id.clone().unwrap_or_default())
                .fetch_optional(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?
            };
            return row.as_ref().map(database_from_row).transpose();
        }
        let memory = self.memory().await.expect("memory store");
        let candidates: Vec<&StoredDatabase> = memory
            .databases
            .values()
            .filter(|database| database.name == name)
            .collect();
        if scope.platform && scope.org_id.is_none() && scope.account_id.is_none() {
            return Ok(candidates
                .into_iter()
                .find(|database| database.org_id.is_none() && database.account_id.is_none())
                .cloned());
        }
        if let Some(org_id) = &scope.org_id {
            if let Some(account_id) = &scope.account_id {
                if let Some(exact) = candidates.iter().find(|database| {
                    database.org_id.as_deref() == Some(org_id.as_str())
                        && database.account_id.as_deref() == Some(account_id.as_str())
                }) {
                    return Ok(Some((*exact).clone()));
                }
                if let Some(org_wide) = candidates.iter().find(|database| {
                    database.org_id.as_deref() == Some(org_id.as_str())
                        && database.account_id.is_none()
                }) {
                    return Ok(Some((*org_wide).clone()));
                }
            } else if let Some(org_wide) = candidates.iter().find(|database| {
                database.org_id.as_deref() == Some(org_id.as_str()) && database.account_id.is_none()
            }) {
                return Ok(Some((*org_wide).clone()));
            }
            let org_matches: Vec<&StoredDatabase> = candidates
                .into_iter()
                .filter(|database| database.org_id.as_deref() == Some(org_id.as_str()))
                .collect();
            if org_matches.len() > 1 {
                return Err(StoreError::conflict(format!(
                    "database '{name}' is ambiguous in this org; add accountId to disambiguate"
                )));
            }
            return Ok(org_matches.first().map(|database| (*database).clone()));
        }
        Ok(candidates
            .into_iter()
            .find(|database| {
                database.org_id.is_none()
                    && database.account_id.as_deref()
                        == Some(scope.account_id.as_deref().unwrap_or(""))
            })
            .cloned())
    }

    pub async fn find_default_database(
        &self,
        scope: &CollectionScope,
    ) -> Result<Option<StoredDatabase>, StoreError> {
        self.find_database("default", scope).await
    }

    /// Exact `(org, account)` lookup. Unlike [`find_database`], this never
    /// falls back to another account's database in the same org; it is used
    /// when creating the per-scope `default` database.
    pub async fn find_database_exact(
        &self,
        name: &str,
        org_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<Option<StoredDatabase>, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                   FROM synapseone_base_databases
                   WHERE name = $1
                     AND org_id IS NOT DISTINCT FROM $2
                     AND account_id IS NOT DISTINCT FROM $3
                   ORDER BY created_at ASC LIMIT 1"#,
            )
            .bind(name)
            .bind(org_id)
            .bind(account_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return row.as_ref().map(database_from_row).transpose();
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory
            .databases
            .values()
            .find(|database| {
                database.name == name
                    && database.org_id.as_deref() == org_id
                    && database.account_id.as_deref() == account_id
            })
            .cloned())
    }

    /// Return the tenant's `default` database, creating it on first use. Legacy
    /// `/v1/base/collections` routes call this so the pre-namespace API keeps
    /// working without an explicit database.
    pub async fn ensure_default_database(
        &self,
        scope: &CollectionScope,
    ) -> Result<StoredDatabase, StoreError> {
        let (org_id, account_id) =
            if scope.platform && scope.org_id.is_none() && scope.account_id.is_none() {
                (None, None)
            } else if let Some(org_id) = &scope.org_id {
                (Some(org_id.clone()), scope.account_id.clone())
            } else {
                (None, scope.account_id.clone())
            };
        if let Some(database) = self
            .find_database_exact("default", org_id.as_deref(), account_id.as_deref())
            .await?
        {
            return Ok(database);
        }
        match self
            .create_database(CreateDatabaseInput {
                name: "default".into(),
                description: None,
                org_id: org_id.clone(),
                account_id: account_id.clone(),
                created_by: None,
            })
            .await
        {
            Ok(database) => Ok(database),
            Err(error) if error.code == StoreErrorCode::Conflict => self
                .find_database_exact("default", org_id.as_deref(), account_id.as_deref())
                .await?
                .ok_or(error),
            Err(error) => Err(error),
        }
    }

    pub async fn get_database(&self, id: &str) -> Result<Option<StoredDatabase>, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                   FROM synapseone_base_databases WHERE id = $1 LIMIT 1"#,
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return row.as_ref().map(database_from_row).transpose();
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory.databases.get(id).cloned())
    }

    pub async fn list_databases(&self) -> Result<Vec<StoredDatabase>, StoreError> {
        if let Some(pool) = self.pool() {
            let rows = sqlx::query(
                r#"SELECT id, name, description, org_id, account_id, created_by, created_at, updated_at
                   FROM synapseone_base_databases
                   ORDER BY name ASC, created_at ASC"#,
            )
            .fetch_all(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return rows.iter().map(database_from_row).collect();
        }
        let memory = self.memory().await.expect("memory store");
        let mut databases: Vec<StoredDatabase> = memory.databases.values().cloned().collect();
        databases.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.created_at.cmp(&right.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(databases)
    }

    pub async fn update_database(
        &self,
        id: &str,
        patch: DatabasePatch,
    ) -> Result<Option<StoredDatabase>, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"UPDATE synapseone_base_databases SET
                     name = CASE WHEN $2::boolean THEN $3::text ELSE name END,
                     description = CASE WHEN $4::boolean THEN $5::text ELSE description END,
                     updated_at = now()
                   WHERE id = $1
                   RETURNING id, name, description, org_id, account_id, created_by, created_at, updated_at"#,
            )
            .bind(id)
            .bind(patch.name.is_some())
            .bind(&patch.name)
            .bind(patch.description.is_some())
            .bind(patch.description.clone().flatten())
            .fetch_optional(pool)
            .await;
            return match row {
                Ok(row) => row.as_ref().map(database_from_row).transpose(),
                Err(error) if is_unique_violation(&error) => Err(StoreError::conflict(
                    "database name already exists in this scope",
                )),
                Err(error) => Err(StoreError::invalid(error.to_string())),
            };
        }
        let mut memory = self.memory().await.expect("memory store");
        let Some(current) = memory.databases.get(id).cloned() else {
            return Ok(None);
        };
        if let Some(name) = &patch.name {
            if name != &current.name
                && memory.databases.values().any(|database| {
                    database.id != id
                        && database.name == *name
                        && same_scope(
                            database.org_id.as_deref(),
                            database.account_id.as_deref(),
                            current.org_id.as_deref(),
                            current.account_id.as_deref(),
                        )
                })
            {
                return Err(StoreError::conflict(
                    "database name already exists in this scope",
                ));
            }
        }
        let mut next = current;
        if let Some(name) = patch.name {
            next.name = name;
        }
        if let Some(description) = patch.description {
            next.description = description;
        }
        next.updated_at = now_iso();
        memory.databases.insert(id.to_string(), next.clone());
        for collection in memory.collections.values_mut() {
            if collection.database_id == id {
                collection.database_name = next.name.clone();
            }
        }
        Ok(Some(next))
    }

    pub async fn delete_database(&self, id: &str) -> Result<bool, StoreError> {
        if let Some(pool) = self.pool() {
            sqlx::query(
                r#"DELETE FROM synapseone_search_index
                   WHERE collection_id IN (
                     SELECT id FROM synapseone_base_collections WHERE database_id = $1
                   )"#,
            )
            .bind(id)
            .execute(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let result = sqlx::query("DELETE FROM synapseone_base_databases WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(result.rows_affected() > 0);
        }
        let mut memory = self.memory().await.expect("memory store");
        let collection_ids: Vec<String> = memory
            .collections
            .values()
            .filter(|collection| collection.database_id == id)
            .map(|collection| collection.id.clone())
            .collect();
        for collection_id in &collection_ids {
            memory
                .documents
                .retain(|(current, _), _| current != collection_id);
            memory
                .graph_nodes
                .retain(|(current, _), _| current != collection_id);
            memory
                .graph_edges
                .retain(|(current, _), _| current != collection_id);
            memory
                .geo_features
                .retain(|(current, _), _| current != collection_id);
            memory
                .search
                .retain(|_, record| record.collection_id != *collection_id);
            memory.collections.remove(collection_id);
        }
        Ok(memory.databases.remove(id).is_some())
    }

    pub async fn database_stats(&self, id: &str) -> Result<DatabaseStats, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT
                     (SELECT count(*) FROM synapseone_base_collections WHERE database_id = $1)::bigint AS collections,
                     count(d.id)::bigint AS documents,
                     coalesce(sum(octet_length(d.data::text)), 0)::bigint AS bytes,
                     max(d.updated_at) AS last_updated_at
                   FROM synapseone_base_documents d
                   JOIN synapseone_base_collections c ON c.id = d.collection_id
                   WHERE c.database_id = $1"#,
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let last_updated_at = row
                .try_get::<Option<DateTime<Utc>>, _>("last_updated_at")
                .ok()
                .flatten()
                .map(|value| iso(&value));
            return Ok(DatabaseStats {
                collections: row.try_get("collections").unwrap_or(0),
                documents: row.try_get("documents").unwrap_or(0),
                bytes: row.try_get("bytes").unwrap_or(0),
                last_updated_at,
            });
        }
        let memory = self.memory().await.expect("memory store");
        let collection_ids: Vec<&str> = memory
            .collections
            .values()
            .filter(|collection| collection.database_id == id)
            .map(|collection| collection.id.as_str())
            .collect();
        let mut documents = 0_i64;
        let mut bytes = 0_i64;
        let mut last_updated_at: Option<String> = None;
        for ((collection_id, _), document) in &memory.documents {
            if collection_ids.contains(&collection_id.as_str()) {
                documents += 1;
                bytes += serde_json::to_string(&document.data)
                    .map(|value| value.len() as i64)
                    .unwrap_or(0);
                last_updated_at = Some(match last_updated_at {
                    Some(current) if current >= document.updated_at => current,
                    _ => document.updated_at.clone(),
                });
            }
        }
        Ok(DatabaseStats {
            collections: collection_ids.len() as i64,
            documents,
            bytes,
            last_updated_at,
        })
    }

    // ---------- collections ----------

    pub async fn create_collection(
        &self,
        input: CreateCollectionInput,
    ) -> Result<StoredCollection, StoreError> {
        let id = crate::util::random_id();
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"INSERT INTO synapseone_base_collections
                     (id, database_id, name, description, mapping, org_id, account_id, created_by)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
                   ON CONFLICT DO NOTHING
                   RETURNING id, database_id, name, description, mapping, org_id, account_id, created_by, created_at, updated_at"#,
            )
            .bind(&id)
            .bind(&input.database_id)
            .bind(&input.name)
            .bind(&input.description)
            .bind(input.mapping.to_value())
            .bind(&input.org_id)
            .bind(&input.account_id)
            .bind(&input.created_by)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let Some(row) = row else {
                return Err(StoreError::conflict(format!(
                    "collection '{}' already exists in this database",
                    input.name
                )));
            };
            let mut collection = collection_from_row(&row)?;
            collection.database_name = input.database_name;
            return Ok(collection);
        }
        let mut memory = self.memory().await.expect("memory store");
        if !memory.databases.contains_key(&input.database_id) {
            return Err(StoreError::invalid(format!(
                "database '{}' not found",
                input.database_name
            )));
        }
        if memory.collections.values().any(|collection| {
            collection.database_id == input.database_id && collection.name == input.name
        }) {
            return Err(StoreError::conflict(format!(
                "collection '{}' already exists in this database",
                input.name
            )));
        }
        let now = now_iso();
        let record = StoredCollection {
            id,
            database_id: input.database_id,
            database_name: input.database_name,
            name: input.name,
            description: input.description,
            mapping: input.mapping,
            org_id: input.org_id,
            account_id: input.account_id,
            created_by: input.created_by,
            created_at: now.clone(),
            updated_at: now,
        };
        memory.collections.insert(record.id.clone(), record.clone());
        Ok(record)
    }

    pub async fn find_collection(
        &self,
        name: &str,
        scope: &CollectionScope,
        database: Option<&str>,
    ) -> Result<Option<StoredCollection>, StoreError> {
        let Some(database) = (match database {
            Some(database) => self.find_database(database, scope).await?,
            None => self.find_default_database(scope).await?,
        }) else {
            return Ok(None);
        };
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT c.id, c.database_id, c.name, c.description, c.mapping, c.org_id,
                          c.account_id, c.created_by, c.created_at, c.updated_at,
                          d.name AS database_name
                   FROM synapseone_base_collections c
                   JOIN synapseone_base_databases d ON d.id = c.database_id
                   WHERE c.database_id = $1 AND c.name = $2
                   LIMIT 1"#,
            )
            .bind(&database.id)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return row.as_ref().map(collection_from_row).transpose();
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory
            .collections
            .values()
            .find(|collection| collection.database_id == database.id && collection.name == name)
            .cloned())
    }

    pub async fn get_collection(&self, id: &str) -> Result<Option<StoredCollection>, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT c.id, c.database_id, c.name, c.description, c.mapping, c.org_id,
                          c.account_id, c.created_by, c.created_at, c.updated_at,
                          d.name AS database_name
                   FROM synapseone_base_collections c
                   JOIN synapseone_base_databases d ON d.id = c.database_id
                   WHERE c.id = $1 LIMIT 1"#,
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return row.as_ref().map(collection_from_row).transpose();
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory.collections.get(id).cloned())
    }

    pub async fn list_collections(&self) -> Result<Vec<StoredCollection>, StoreError> {
        if let Some(pool) = self.pool() {
            let rows = sqlx::query(
                r#"SELECT c.id, c.database_id, c.name, c.description, c.mapping, c.org_id,
                          c.account_id, c.created_by, c.created_at, c.updated_at,
                          d.name AS database_name
                   FROM synapseone_base_collections c
                   JOIN synapseone_base_databases d ON d.id = c.database_id
                   ORDER BY d.name ASC, c.name ASC, c.created_at ASC"#,
            )
            .fetch_all(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return rows.iter().map(collection_from_row).collect();
        }
        let memory = self.memory().await.expect("memory store");
        let mut collections: Vec<StoredCollection> = memory.collections.values().cloned().collect();
        collections.sort_by(|left, right| {
            left.database_name
                .cmp(&right.database_name)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.created_at.cmp(&right.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(collections)
    }

    pub async fn update_collection(
        &self,
        id: &str,
        patch: CollectionPatch,
    ) -> Result<Option<StoredCollection>, StoreError> {
        if let Some(pool) = self.pool() {
            let mapping_value = patch.mapping.as_ref().map(BaseMapping::to_value);
            let row = sqlx::query(
                r#"UPDATE synapseone_base_collections SET
                     name = CASE WHEN $2::boolean THEN $3::text ELSE name END,
                     description = CASE WHEN $4::boolean THEN $5::text ELSE description END,
                     mapping = CASE WHEN $6::boolean THEN $7::jsonb ELSE mapping END,
                     updated_at = now()
                   WHERE id = $1
                   RETURNING id, database_id, name, description, mapping, org_id, account_id, created_by, created_at, updated_at"#,
            )
            .bind(id)
            .bind(patch.name.is_some())
            .bind(&patch.name)
            .bind(patch.description.is_some())
            .bind(patch.description.clone().flatten())
            .bind(mapping_value.is_some())
            .bind(mapping_value)
            .fetch_optional(pool)
            .await;
            return match row {
                Ok(Some(row)) => {
                    let mut collection = collection_from_row(&row)?;
                    if let Some(database) = self.get_database(&collection.database_id).await? {
                        collection.database_name = database.name;
                    }
                    Ok(Some(collection))
                }
                Ok(None) => Ok(None),
                Err(error) if is_unique_violation(&error) => Err(StoreError::conflict(
                    "collection name already exists in this database",
                )),
                Err(error) => Err(StoreError::invalid(error.to_string())),
            };
        }
        let mut memory = self.memory().await.expect("memory store");
        let Some(current) = memory.collections.get(id).cloned() else {
            return Ok(None);
        };
        if let Some(name) = &patch.name {
            if name != &current.name
                && memory.collections.values().any(|collection| {
                    collection.id != id
                        && collection.database_id == current.database_id
                        && collection.name == *name
                })
            {
                return Err(StoreError::conflict(
                    "collection name already exists in this database",
                ));
            }
        }
        let mut next = current;
        if let Some(name) = patch.name {
            next.name = name;
        }
        if let Some(description) = patch.description {
            next.description = description;
        }
        if let Some(mapping) = patch.mapping {
            next.mapping = mapping;
        }
        next.updated_at = now_iso();
        memory.collections.insert(id.to_string(), next.clone());
        Ok(Some(next))
    }

    pub async fn delete_collection(&self, id: &str) -> Result<bool, StoreError> {
        if let Some(pool) = self.pool() {
            sqlx::query("DELETE FROM synapseone_search_index WHERE collection_id = $1")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            let result = sqlx::query("DELETE FROM synapseone_base_collections WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(result.rows_affected() > 0);
        }
        let mut memory = self.memory().await.expect("memory store");
        memory
            .documents
            .retain(|(collection_id, _), _| collection_id != id);
        memory
            .graph_nodes
            .retain(|(collection_id, _), _| collection_id != id);
        memory
            .graph_edges
            .retain(|(collection_id, _), _| collection_id != id);
        memory
            .geo_features
            .retain(|(collection_id, _), _| collection_id != id);
        memory.search.retain(|_, record| record.collection_id != id);
        Ok(memory.collections.remove(id).is_some())
    }

    // ---------- documents ----------

    pub async fn create_document(
        &self,
        collection_id: &str,
        id: &str,
        data: Value,
    ) -> Result<StoredDocument, StoreError> {
        if let Some(pool) = self.pool() {
            let mut transaction = pool
                .begin()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            let row = sqlx::query(
                r#"INSERT INTO synapseone_base_documents (collection_id, id, data, version)
                   VALUES ($1,$2,$3::jsonb,1)
                   ON CONFLICT DO NOTHING
                   RETURNING collection_id, id, data, version, created_at, updated_at"#,
            )
            .bind(collection_id)
            .bind(id)
            .bind(&data)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let Some(row) = row else {
                return Err(StoreError::conflict(format!(
                    "document '{id}' already exists"
                )));
            };
            let document = document_from_row(&row)?;
            enqueue_outbox_tx(&mut transaction, collection_id, &document, "create", None).await?;
            transaction
                .commit()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(document);
        }
        let mut memory = self.memory().await.expect("memory store");
        if memory
            .documents
            .contains_key(&(collection_id.to_string(), id.to_string()))
        {
            return Err(StoreError::conflict(format!(
                "document '{id}' already exists"
            )));
        }
        let now = now_iso();
        let document = StoredDocument {
            collection_id: collection_id.to_string(),
            id: id.to_string(),
            data,
            version: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        memory.documents.insert(
            (collection_id.to_string(), id.to_string()),
            document.clone(),
        );
        enqueue_outbox_mem(&mut memory, collection_id, &document, "create", None);
        Ok(document)
    }

    pub async fn get_document(
        &self,
        collection_id: &str,
        id: &str,
    ) -> Result<Option<StoredDocument>, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT collection_id, id, data, version, created_at, updated_at
                   FROM synapseone_base_documents
                   WHERE collection_id = $1 AND id = $2 LIMIT 1"#,
            )
            .bind(collection_id)
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return row.as_ref().map(document_from_row).transpose();
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory
            .documents
            .get(&(collection_id.to_string(), id.to_string()))
            .cloned())
    }

    pub async fn list_documents(
        &self,
        collection_id: &str,
        options: ListDocumentsOptions,
    ) -> Result<Vec<StoredDocument>, StoreError> {
        let limit = options
            .scan_limit
            .filter(|value| *value != 0)
            .unwrap_or(10_001)
            .clamp(1, 50_001);
        if let Some(pool) = self.pool() {
            let mut sql = String::from(
                "SELECT collection_id, id, data, version, created_at, updated_at
                 FROM synapseone_base_documents WHERE collection_id = $1",
            );
            let mut index = 1;
            let mut since_param = None;
            if let Some(since) = &options.since {
                index += 1;
                sql.push_str(&format!(" AND updated_at > ${index}::timestamptz"));
                since_param = parse_js_date(since);
            }
            let mut after_param = None;
            if let Some(after) = &options.after_id {
                index += 1;
                sql.push_str(&format!(" AND id > ${index}"));
                after_param = Some(after.clone());
            }
            if options.since.is_some() {
                sql.push_str(" ORDER BY updated_at ASC, id ASC");
            } else {
                sql.push_str(" ORDER BY id ASC");
            }
            sql.push_str(&format!(" LIMIT ${}", index + 1));
            let mut query = sqlx::query(&sql).bind(collection_id);
            if options.since.is_some() {
                query = query.bind(since_param.unwrap_or_else(Utc::now));
            }
            if let Some(after) = after_param {
                query = query.bind(after);
            }
            let rows = query
                .bind(limit)
                .fetch_all(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return rows.iter().map(document_from_row).collect();
        }
        let memory = self.memory().await.expect("memory store");
        let mut documents: Vec<StoredDocument> = memory
            .documents
            .values()
            .filter(|document| document.collection_id == collection_id)
            .cloned()
            .collect();
        if let Some(since) = &options.since {
            if let Some(since) = parse_js_date(since) {
                documents.retain(|document| {
                    parse_js_date(&document.updated_at)
                        .map(|updated| updated > since)
                        .unwrap_or(false)
                });
            }
            documents.sort_by(|left, right| {
                left.updated_at
                    .cmp(&right.updated_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
        } else {
            documents.sort_by(|left, right| left.id.cmp(&right.id));
        }
        if let Some(after) = &options.after_id {
            documents.retain(|document| document.id > *after);
        }
        documents.truncate(limit as usize);
        Ok(documents)
    }

    pub async fn list_all_documents(
        &self,
        collection_id: &str,
        max: Option<i64>,
        page_size: Option<i64>,
    ) -> Result<Vec<StoredDocument>, StoreError> {
        let max = max
            .filter(|value| *value != 0)
            .unwrap_or(200_000)
            .clamp(1, 1_000_000);
        let page_size = page_size
            .filter(|value| *value != 0)
            .unwrap_or(5_000)
            .clamp(1, 20_000);
        let mut out = Vec::new();
        let mut after_id: Option<String> = None;
        while (out.len() as i64) < max {
            let page = self
                .list_documents(
                    collection_id,
                    ListDocumentsOptions {
                        since: None,
                        scan_limit: Some(page_size.min(max - out.len() as i64)),
                        after_id: after_id.clone(),
                    },
                )
                .await?;
            if page.is_empty() {
                break;
            }
            let count = page.len() as i64;
            after_id = page.last().map(|document| document.id.clone());
            out.extend(page);
            if count < page_size {
                break;
            }
        }
        Ok(out)
    }

    pub async fn list_documents_page(
        &self,
        collection_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<StoredDocument>, StoreError> {
        let limit = if limit == 0 { 100 } else { limit }.clamp(1, 1_000);
        let offset = offset.max(0);
        if let Some(pool) = self.pool() {
            let rows = sqlx::query(
                r#"SELECT collection_id, id, data, version, created_at, updated_at
                   FROM synapseone_base_documents
                   WHERE collection_id = $1
                   ORDER BY id ASC
                   LIMIT $2 OFFSET $3"#,
            )
            .bind(collection_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return rows.iter().map(document_from_row).collect();
        }
        let documents = self
            .list_documents(
                collection_id,
                ListDocumentsOptions {
                    since: None,
                    scan_limit: Some(offset + limit),
                    after_id: None,
                },
            )
            .await?;
        Ok(documents
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect())
    }

    pub async fn count_documents(&self, collection_id: &str) -> Result<i64, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                "SELECT count(*)::int AS n FROM synapseone_base_documents WHERE collection_id = $1",
            )
            .bind(collection_id)
            .fetch_one(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(row.try_get::<i32, _>("n").unwrap_or(0) as i64);
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory
            .documents
            .values()
            .filter(|document| document.collection_id == collection_id)
            .count() as i64)
    }

    pub async fn query_documents(
        &self,
        collection_id: &str,
        spec: &QuerySpec,
        mapping: Option<&BaseMapping>,
    ) -> Result<Value, StoreError> {
        let Some(pool) = self.pool() else {
            return Err(StoreError::invalid("queryDocumentRecs requires Postgres"));
        };
        let compiled = compile_query(collection_id, spec);
        let count_sql = format!(
            "SELECT count(*)::int AS n FROM synapseone_base_documents WHERE {}",
            compiled.where_sql
        );
        let count_row = bind_params(&count_sql, &compiled.where_params)
            .fetch_one(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
        let total = count_row.try_get::<i32, _>("n").unwrap_or(0) as usize;
        let page_sql = format!(
            "SELECT collection_id, id, data, version, created_at, updated_at
               FROM synapseone_base_documents
              WHERE {}
              ORDER BY {}
              LIMIT ${} OFFSET ${}",
            compiled.where_sql,
            compiled.order_sql,
            compiled.all_params.len() + 1,
            compiled.all_params.len() + 2
        );
        let mut params = compiled.all_params.clone();
        params.push(SqlParam::I64(spec.limit));
        params.push(SqlParam::I64(spec.offset));
        let rows = bind_params(&page_sql, &params)
            .fetch_all(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
        let documents: Vec<StoredDocument> = rows
            .iter()
            .map(document_from_row)
            .collect::<Result<_, _>>()?;
        Ok(format_query_page(&documents, spec, mapping, total))
    }

    pub async fn set_document(
        &self,
        collection_id: &str,
        id: &str,
        data: Value,
        options: SetDocumentOptions,
    ) -> Result<SetDocumentResult, StoreError> {
        if let Some(pool) = self.pool() {
            let mut transaction = pool
                .begin()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            let current = sqlx::query(
                r#"SELECT collection_id, id, data, version, created_at, updated_at
                   FROM synapseone_base_documents
                   WHERE collection_id = $1 AND id = $2
                   FOR UPDATE LIMIT 1"#,
            )
            .bind(collection_id)
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            if current.is_none() {
                if let Some(version) = options.if_version {
                    if version != 0 {
                        return Err(StoreError::version_conflict(format!(
                            "document '{id}' does not exist"
                        )));
                    }
                }
                let row = sqlx::query(
                    r#"INSERT INTO synapseone_base_documents (collection_id, id, data, version)
                       VALUES ($1,$2,$3::jsonb,1)
                       RETURNING collection_id, id, data, version, created_at, updated_at"#,
                )
                .bind(collection_id)
                .bind(id)
                .bind(&data)
                .fetch_one(&mut *transaction)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
                let document = document_from_row(&row)?;
                enqueue_outbox_tx(&mut transaction, collection_id, &document, "create", None)
                    .await?;
                transaction
                    .commit()
                    .await
                    .map_err(|error| StoreError::invalid(error.to_string()))?;
                return Ok(SetDocumentResult {
                    doc: document,
                    created: true,
                });
            }
            let previous = document_from_row(current.as_ref().expect("row"))?;
            if let Some(version) = options.if_version {
                if previous.version != version {
                    return Err(StoreError::version_conflict(format!(
                        "document version is {}, expected {version}",
                        previous.version
                    )));
                }
            }
            let next_data = if options.merge {
                deep_merge(&previous.data, &data)
            } else {
                data
            };
            let row = sqlx::query(
                r#"UPDATE synapseone_base_documents
                   SET data = $3::jsonb, version = version + 1, updated_at = now()
                   WHERE collection_id = $1 AND id = $2
                   RETURNING collection_id, id, data, version, created_at, updated_at"#,
            )
            .bind(collection_id)
            .bind(id)
            .bind(&next_data)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let document = document_from_row(&row)?;
            enqueue_outbox_tx(&mut transaction, collection_id, &document, "update", None).await?;
            transaction
                .commit()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(SetDocumentResult {
                doc: document,
                created: false,
            });
        }
        let mut memory = self.memory().await.expect("memory store");
        let key = (collection_id.to_string(), id.to_string());
        let current = memory.documents.get(&key).cloned();
        let Some(current) = current else {
            if let Some(version) = options.if_version {
                if version != 0 {
                    return Err(StoreError::version_conflict(format!(
                        "document '{id}' does not exist"
                    )));
                }
            }
            let now = now_iso();
            let document = StoredDocument {
                collection_id: collection_id.to_string(),
                id: id.to_string(),
                data,
                version: 1,
                created_at: now.clone(),
                updated_at: now,
            };
            memory.documents.insert(key, document.clone());
            enqueue_outbox_mem(&mut memory, collection_id, &document, "create", None);
            return Ok(SetDocumentResult {
                doc: document,
                created: true,
            });
        };
        if let Some(version) = options.if_version {
            if current.version != version {
                return Err(StoreError::version_conflict(format!(
                    "document version is {}, expected {version}",
                    current.version
                )));
            }
        }
        let document = StoredDocument {
            collection_id: collection_id.to_string(),
            id: id.to_string(),
            data: if options.merge {
                deep_merge(&current.data, &data)
            } else {
                data
            },
            version: current.version + 1,
            created_at: current.created_at.clone(),
            updated_at: now_iso(),
        };
        memory.documents.insert(key, document.clone());
        enqueue_outbox_mem(&mut memory, collection_id, &document, "update", None);
        Ok(SetDocumentResult {
            doc: document,
            created: false,
        })
    }

    pub async fn delete_document(
        &self,
        collection_id: &str,
        id: &str,
        if_version: Option<i32>,
    ) -> Result<bool, StoreError> {
        if let Some(pool) = self.pool() {
            let mut transaction = pool
                .begin()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            if let Some(version) = if_version {
                let row = sqlx::query(
                    r#"DELETE FROM synapseone_base_documents
                       WHERE collection_id = $1 AND id = $2 AND version = $3
                       RETURNING collection_id, id, data, version, created_at, updated_at"#,
                )
                .bind(collection_id)
                .bind(id)
                .bind(version)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
                if let Some(row) = row {
                    let document = document_from_row(&row)?;
                    enqueue_outbox_tx(&mut transaction, collection_id, &document, "delete", None)
                        .await?;
                    transaction
                        .commit()
                        .await
                        .map_err(|error| StoreError::invalid(error.to_string()))?;
                    return Ok(true);
                }
                let existing = sqlx::query(
                    "SELECT version FROM synapseone_base_documents WHERE collection_id = $1 AND id = $2 LIMIT 1",
                )
                .bind(collection_id)
                .bind(id)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
                if let Some(existing) = existing {
                    let actual: i32 = existing.try_get("version").unwrap_or(0);
                    return Err(StoreError::version_conflict(format!(
                        "document version is {actual}, expected {version}"
                    )));
                }
                return Err(StoreError::not_found(format!("document '{id}' not found")));
            }
            let row = sqlx::query(
                r#"DELETE FROM synapseone_base_documents
                   WHERE collection_id = $1 AND id = $2
                   RETURNING collection_id, id, data, version, created_at, updated_at"#,
            )
            .bind(collection_id)
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let Some(row) = row else {
                return Ok(false);
            };
            let document = document_from_row(&row)?;
            enqueue_outbox_tx(&mut transaction, collection_id, &document, "delete", None).await?;
            transaction
                .commit()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(true);
        }
        let mut memory = self.memory().await.expect("memory store");
        let key = (collection_id.to_string(), id.to_string());
        let Some(current) = memory.documents.get(&key).cloned() else {
            return Err(StoreError::not_found(format!("document '{id}' not found")));
        };
        if let Some(version) = if_version {
            if current.version != version {
                return Err(StoreError::version_conflict(format!(
                    "document version is {}, expected {version}",
                    current.version
                )));
            }
        }
        memory.documents.remove(&key);
        enqueue_outbox_mem(&mut memory, collection_id, &current, "delete", None);
        Ok(true)
    }

    pub async fn increment_document(
        &self,
        collection_id: &str,
        id: &str,
        field: &str,
        by: f64,
        if_version: Option<i32>,
    ) -> Result<StoredDocument, StoreError> {
        if let Some(pool) = self.pool() {
            let mut transaction = pool
                .begin()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            let current = sqlx::query(
                r#"SELECT collection_id, id, data, version, created_at, updated_at
                   FROM synapseone_base_documents
                   WHERE collection_id = $1 AND id = $2
                   FOR UPDATE LIMIT 1"#,
            )
            .bind(collection_id)
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let (previous, created) = match current {
                Some(row) => {
                    let document = document_from_row(&row)?;
                    if let Some(version) = if_version {
                        if document.version != version {
                            return Err(StoreError::version_conflict(format!(
                                "document version is {}, expected {version}",
                                document.version
                            )));
                        }
                    }
                    (document, false)
                }
                None => {
                    if let Some(version) = if_version {
                        if version != 0 {
                            return Err(StoreError::version_conflict(format!(
                                "document '{id}' does not exist"
                            )));
                        }
                    }
                    (
                        StoredDocument {
                            collection_id: collection_id.to_string(),
                            id: id.to_string(),
                            data: Value::Object(Map::new()),
                            version: 0,
                            created_at: now_iso(),
                            updated_at: now_iso(),
                        },
                        true,
                    )
                }
            };
            let current_value = get_path_opt(&previous.data, field);
            if let Some(value) = &current_value {
                match value.as_f64() {
                    Some(number) if number.is_finite() => {}
                    _ => {
                        return Err(StoreError::invalid(format!(
                            "field '{field}' is not numeric"
                        )))
                    }
                }
            }
            let mut data = deep_merge(&previous.data, &json!({}));
            let base = current_value
                .as_ref()
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            set_path(&mut data, field, crate::query::number_value(base + by));
            if created {
                let row = sqlx::query(
                    r#"INSERT INTO synapseone_base_documents (collection_id, id, data, version)
                       VALUES ($1,$2,$3::jsonb,1)
                       RETURNING collection_id, id, data, version, created_at, updated_at"#,
                )
                .bind(collection_id)
                .bind(id)
                .bind(&data)
                .fetch_one(&mut *transaction)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
                let document = document_from_row(&row)?;
                enqueue_outbox_tx(&mut transaction, collection_id, &document, "create", None)
                    .await?;
                transaction
                    .commit()
                    .await
                    .map_err(|error| StoreError::invalid(error.to_string()))?;
                return Ok(document);
            }
            let row = sqlx::query(
                r#"UPDATE synapseone_base_documents
                   SET data = $3::jsonb, version = version + 1, updated_at = now()
                   WHERE collection_id = $1 AND id = $2
                   RETURNING collection_id, id, data, version, created_at, updated_at"#,
            )
            .bind(collection_id)
            .bind(id)
            .bind(&data)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let document = document_from_row(&row)?;
            enqueue_outbox_tx(&mut transaction, collection_id, &document, "update", None).await?;
            transaction
                .commit()
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(document);
        }
        let mut memory = self.memory().await.expect("memory store");
        let key = (collection_id.to_string(), id.to_string());
        let current = memory.documents.get(&key).cloned();
        if let Some(current) = &current {
            if let Some(version) = if_version {
                if current.version != version {
                    return Err(StoreError::version_conflict(format!(
                        "document version is {}, expected {version}",
                        current.version
                    )));
                }
            }
        }
        let current_value = current
            .as_ref()
            .and_then(|document| get_path_opt(&document.data, field));
        if let Some(value) = &current_value {
            match value.as_f64() {
                Some(number) if number.is_finite() => {}
                _ => {
                    return Err(StoreError::invalid(format!(
                        "field '{field}' is not numeric"
                    )))
                }
            }
        }
        let mut data = match current.as_ref() {
            Some(document) => deep_merge(&document.data, &json!({})),
            None => deep_merge(&Value::Object(Map::new()), &json!({})),
        };
        let base = current_value
            .as_ref()
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0);
        set_path(&mut data, field, crate::query::number_value(base + by));
        let document = match current {
            Some(current) => StoredDocument {
                collection_id: collection_id.to_string(),
                id: id.to_string(),
                data,
                version: current.version + 1,
                created_at: current.created_at,
                updated_at: now_iso(),
            },
            None => StoredDocument {
                collection_id: collection_id.to_string(),
                id: id.to_string(),
                data,
                version: 1,
                created_at: now_iso(),
                updated_at: now_iso(),
            },
        };
        let operation = if document.version == 1 {
            "create"
        } else {
            "update"
        };
        memory.documents.insert(key, document.clone());
        enqueue_outbox_mem(&mut memory, collection_id, &document, operation, None);
        Ok(document)
    }

    pub async fn document_stats(&self, collection_id: &str) -> Result<DocumentStats, StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT count(*)::int AS documents,
                          coalesce(sum(octet_length(data::text)), 0)::bigint AS bytes,
                          max(updated_at) AS last_updated_at
                   FROM synapseone_base_documents WHERE collection_id = $1"#,
            )
            .bind(collection_id)
            .fetch_one(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let documents: i32 = row.try_get("documents").unwrap_or(0);
            let bytes: i64 = row.try_get("bytes").unwrap_or(0);
            let last: Option<DateTime<Utc>> = row.try_get("last_updated_at").ok().flatten();
            return Ok(DocumentStats {
                documents: documents as i64,
                bytes,
                last_updated_at: last.map(|value| iso(&value)),
            });
        }
        let memory = self.memory().await.expect("memory store");
        let documents: Vec<&StoredDocument> = memory
            .documents
            .values()
            .filter(|document| document.collection_id == collection_id)
            .collect();
        let mut bytes = 0i64;
        let mut last: Option<String> = None;
        for document in &documents {
            bytes += serde_json::to_string(&document.data)
                .unwrap_or_default()
                .len() as i64;
            if last
                .as_ref()
                .map(|value| &document.updated_at > value)
                .unwrap_or(true)
            {
                last = Some(document.updated_at.clone());
            }
        }
        Ok(DocumentStats {
            documents: documents.len() as i64,
            bytes,
            last_updated_at: last,
        })
    }

    pub async fn list_documents_matching(
        &self,
        collection_id: &str,
        where_: Option<crate::query::FilterNode>,
        max: i64,
    ) -> Result<Vec<StoredDocument>, StoreError> {
        let limit = if max == 0 { 200_000 } else { max }.clamp(1, 1_000_000);
        let Some(pool) = self.pool() else {
            return self
                .list_all_documents(collection_id, Some(limit), None)
                .await;
        };
        let spec = QuerySpec {
            where_,
            order_by: Vec::new(),
            limit,
            offset: 0,
            select: None,
            as_view: crate::query::AsView::Data,
            vector_search: None,
        };
        let compiled = compile_query(collection_id, &spec);
        let sql = format!(
            "SELECT collection_id, id, data, version, created_at, updated_at
               FROM synapseone_base_documents
              WHERE {}
              ORDER BY id ASC
              LIMIT ${}",
            compiled.where_sql,
            compiled.all_params.len() + 1
        );
        let mut params = compiled.all_params.clone();
        params.push(SqlParam::I64(limit));
        let rows = bind_params(&sql, &params)
            .fetch_all(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
        rows.iter().map(document_from_row).collect()
    }

    // ---------- outbox ----------

    pub async fn enqueue_backfill(
        &self,
        collection_id: &str,
        documents: &[StoredDocument],
    ) -> Result<usize, StoreError> {
        if documents.is_empty() {
            return Ok(0);
        }
        if let Some(pool) = self.pool() {
            let collection = self.get_collection(collection_id).await?;
            let mut inserted = 0usize;
            for document in documents {
                let event_id = format!(
                    "backfill:{collection_id}:{}:{}",
                    document.id, document.version
                );
                let payload = outbox_payload(
                    collection.as_ref(),
                    document,
                    "create",
                    Some(event_id.clone()),
                );
                let occurred = payload
                    .get("occurred_at")
                    .and_then(Value::as_str)
                    .and_then(parse_js_date)
                    .unwrap_or_else(Utc::now);
                let row = sqlx::query(
                    r#"INSERT INTO synapseone_base_outbox
                         (event_id, org_id, account_id, collection_id, collection_name,
                          document_id, operation, version, occurred_at, payload)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
                       ON CONFLICT DO NOTHING
                       RETURNING event_id"#,
                )
                .bind(&event_id)
                .bind(payload.get("organization_id").and_then(Value::as_str))
                .bind(payload.get("account_id").and_then(Value::as_str))
                .bind(collection_id)
                .bind(
                    payload
                        .get("collection_name")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )
                .bind(&document.id)
                .bind("create")
                .bind(document.version)
                .bind(occurred)
                .bind(&payload)
                .fetch_optional(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
                if row.is_some() {
                    inserted += 1;
                }
            }
            return Ok(inserted);
        }
        let mut memory = self.memory().await.expect("memory store");
        let mut existing: HashSet<String> = memory
            .outbox
            .iter()
            .map(|event| event.event_id.clone())
            .collect();
        let mut inserted = 0usize;
        let collection = memory.collections.get(collection_id).cloned();
        for document in documents {
            let event_id = format!(
                "backfill:{collection_id}:{}:{}",
                document.id, document.version
            );
            if existing.contains(&event_id) {
                continue;
            }
            let payload = outbox_payload(
                collection.as_ref(),
                document,
                "create",
                Some(event_id.clone()),
            );
            memory.outbox.push(MemoryOutbox {
                event_id: event_id.clone(),
                payload,
                published_at: None,
                attempts: 0,
                last_error: None,
            });
            existing.insert(event_id);
            inserted += 1;
        }
        Ok(inserted)
    }

    pub async fn list_changes(
        &self,
        collection_id: &str,
        since: &str,
        after_id: Option<&str>,
        limit: i64,
    ) -> Result<ChangesPage, StoreError> {
        let limit = limit.clamp(1, 1_000);
        if let Some(pool) = self.pool() {
            let since_date = parse_js_date(since).unwrap_or_else(Utc::now);
            let sql = if after_id.is_some() {
                r#"SELECT event_id, occurred_at, payload FROM synapseone_base_outbox
                   WHERE collection_id = $1 AND occurred_at >= $2
                     AND (occurred_at > $2 OR event_id > $3)
                   ORDER BY occurred_at ASC, event_id ASC LIMIT $4"#
            } else {
                r#"SELECT event_id, occurred_at, payload FROM synapseone_base_outbox
                   WHERE collection_id = $1 AND occurred_at >= $2
                   ORDER BY occurred_at ASC, event_id ASC LIMIT $3"#
            };
            let mut query = sqlx::query(sql).bind(collection_id).bind(since_date);
            if let Some(after_id) = after_id {
                query = query.bind(after_id);
            }
            let rows = query
                .bind(limit)
                .fetch_all(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            let mut events = Vec::with_capacity(rows.len());
            let mut next_since = since.to_string();
            let mut next_after = after_id.map(str::to_string);
            for row in &rows {
                let payload: Value = row.try_get("payload").unwrap_or(Value::Null);
                let occurred: Option<DateTime<Utc>> = row.try_get("occurred_at").ok();
                let event_id: String = row.try_get("event_id").unwrap_or_default();
                if let Some(occurred) = occurred {
                    next_since = iso(&occurred);
                }
                next_after = Some(event_id);
                events.push(payload);
            }
            return Ok(ChangesPage {
                events,
                next_since,
                next_after,
            });
        }
        let memory = self.memory().await.expect("memory store");
        let mut filtered: Vec<&MemoryOutbox> = memory
            .outbox
            .iter()
            .filter(|event| {
                let occurred = event
                    .payload
                    .get("occurred_at")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                event.payload.get("collection_id").and_then(Value::as_str) == Some(collection_id)
                    && (occurred > since
                        || (occurred == since
                            && after_id
                                .map(|after| event.event_id.as_str() > after)
                                .unwrap_or(true)))
            })
            .collect();
        filtered.sort_by(|left, right| {
            let left_occurred = left
                .payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            let right_occurred = right
                .payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            left_occurred
                .cmp(right_occurred)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        filtered.truncate(limit as usize);
        let mut next_since = since.to_string();
        let mut next_after = after_id.map(str::to_string);
        let events: Vec<Value> = filtered.iter().map(|event| event.payload.clone()).collect();
        if let Some(last) = filtered.last() {
            next_since = last
                .payload
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or(since)
                .to_string();
            next_after = Some(last.event_id.clone());
        }
        Ok(ChangesPage {
            events,
            next_since,
            next_after,
        })
    }

    pub async fn outbox_stats(&self) -> Result<(i64, Option<String>), StoreError> {
        if let Some(pool) = self.pool() {
            let row = sqlx::query(
                r#"SELECT count(*) filter (where published_at is null)::int AS pending,
                          min(occurred_at) filter (where published_at is null) AS oldest
                   FROM synapseone_base_outbox"#,
            )
            .fetch_one(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            let pending: i32 = row.try_get("pending").unwrap_or(0);
            let oldest: Option<DateTime<Utc>> = row.try_get("oldest").ok().flatten();
            return Ok((pending as i64, oldest.map(|value| iso(&value))));
        }
        let memory = self.memory().await.expect("memory store");
        let pending: Vec<&MemoryOutbox> = memory
            .outbox
            .iter()
            .filter(|event| event.published_at.is_none())
            .collect();
        Ok((
            pending.len() as i64,
            pending.first().and_then(|event| {
                event
                    .payload
                    .get("occurred_at")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        ))
    }

    pub async fn list_unpublished(&self, limit: i64) -> Result<Vec<OutboxEvent>, StoreError> {
        let limit = limit.clamp(1, 500);
        if let Some(pool) = self.pool() {
            let rows = sqlx::query(
                r#"SELECT event_id, payload, attempts FROM synapseone_base_outbox
                   WHERE published_at IS NULL
                   ORDER BY occurred_at ASC, event_id ASC LIMIT $1"#,
            )
            .bind(limit)
            .fetch_all(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(rows
                .iter()
                .map(|row| OutboxEvent {
                    event_id: row.try_get("event_id").unwrap_or_default(),
                    payload: row.try_get("payload").unwrap_or(Value::Null),
                    attempts: row.try_get::<i32, _>("attempts").unwrap_or(0) as i64,
                })
                .collect());
        }
        let memory = self.memory().await.expect("memory store");
        Ok(memory
            .outbox
            .iter()
            .filter(|event| event.published_at.is_none())
            .take(limit as usize)
            .map(|event| OutboxEvent {
                event_id: event.event_id.clone(),
                payload: event.payload.clone(),
                attempts: event.attempts,
            })
            .collect())
    }

    pub async fn mark_published(&self, event_ids: &[String]) -> Result<(), StoreError> {
        if event_ids.is_empty() {
            return Ok(());
        }
        if let Some(pool) = self.pool() {
            for event_id in event_ids {
                sqlx::query(
                    "UPDATE synapseone_base_outbox SET published_at = now(), last_error = NULL WHERE event_id = $1",
                )
                .bind(event_id)
                .execute(pool)
                .await
                .map_err(|error| StoreError::invalid(error.to_string()))?;
            }
            return Ok(());
        }
        let mut memory = self.memory().await.expect("memory store");
        for event in &mut memory.outbox {
            if event_ids.contains(&event.event_id) {
                event.published_at = Some(now_iso());
            }
        }
        Ok(())
    }

    pub async fn record_failure(&self, event_id: &str, error: &str) -> Result<(), StoreError> {
        let message: String = error.chars().take(1000).collect();
        if let Some(pool) = self.pool() {
            sqlx::query(
                "UPDATE synapseone_base_outbox SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1",
            )
            .bind(event_id)
            .bind(message)
            .execute(pool)
            .await
            .map_err(|error| StoreError::invalid(error.to_string()))?;
            return Ok(());
        }
        let mut memory = self.memory().await.expect("memory store");
        if let Some(event) = memory
            .outbox
            .iter_mut()
            .find(|event| event.event_id == event_id)
        {
            event.attempts += 1;
            event.last_error = Some(message);
        }
        Ok(())
    }
}

fn same_scope(
    left_org: Option<&str>,
    left_account: Option<&str>,
    right_org: Option<&str>,
    right_account: Option<&str>,
) -> bool {
    left_org.unwrap_or("") == right_org.unwrap_or("")
        && left_account.unwrap_or("") == right_account.unwrap_or("")
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .map(|database| database.is_unique_violation())
        .unwrap_or(false)
}

fn database_from_row(row: &PgRow) -> Result<StoredDatabase, StoreError> {
    let created_at: DateTime<Utc> = row
        .try_get("created_at")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    let updated_at: DateTime<Utc> = row
        .try_get("updated_at")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    Ok(StoredDatabase {
        id: row.try_get("id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        description: row.try_get("description").ok().flatten(),
        org_id: row.try_get("org_id").ok().flatten(),
        account_id: row.try_get("account_id").ok().flatten(),
        created_by: row.try_get("created_by").ok().flatten(),
        created_at: iso(&created_at),
        updated_at: iso(&updated_at),
    })
}

fn collection_from_row(row: &PgRow) -> Result<StoredCollection, StoreError> {
    let mapping: Value = row
        .try_get("mapping")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    let created_at: DateTime<Utc> = row
        .try_get("created_at")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    let updated_at: DateTime<Utc> = row
        .try_get("updated_at")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    Ok(StoredCollection {
        id: row.try_get("id").unwrap_or_default(),
        database_id: row.try_get("database_id").unwrap_or_default(),
        database_name: row.try_get("database_name").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        description: row.try_get("description").ok().flatten(),
        mapping: BaseMapping::from_value(&mapping),
        org_id: row.try_get("org_id").ok().flatten(),
        account_id: row.try_get("account_id").ok().flatten(),
        created_by: row.try_get("created_by").ok().flatten(),
        created_at: iso(&created_at),
        updated_at: iso(&updated_at),
    })
}

fn document_from_row(row: &PgRow) -> Result<StoredDocument, StoreError> {
    let data: Value = row
        .try_get("data")
        .unwrap_or_else(|_| Value::Object(Map::new()));
    let created_at: DateTime<Utc> = row
        .try_get("created_at")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    let updated_at: DateTime<Utc> = row
        .try_get("updated_at")
        .map_err(|error| StoreError::invalid(error.to_string()))?;
    let data = if data.is_object() {
        data
    } else {
        Value::Object(Map::new())
    };
    Ok(StoredDocument {
        collection_id: row.try_get("collection_id").unwrap_or_default(),
        id: row.try_get("id").unwrap_or_default(),
        data,
        version: row.try_get::<i32, _>("version").unwrap_or(1),
        created_at: iso(&created_at),
        updated_at: iso(&updated_at),
    })
}

fn outbox_payload(
    collection: Option<&StoredCollection>,
    document: &StoredDocument,
    operation: &str,
    event_id: Option<String>,
) -> Value {
    let event_id = event_id.unwrap_or_else(crate::util::random_id);
    let mut payload = Map::new();
    payload.insert("event_id".into(), Value::String(event_id));
    payload.insert("schema_version".into(), json!(1));
    payload.insert("source".into(), Value::String("synapsebase".into()));
    payload.insert("resource_type".into(), Value::String("document".into()));
    payload.insert(
        "organization_id".into(),
        collection
            .and_then(|collection| collection.org_id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "account_id".into(),
        collection
            .and_then(|collection| collection.account_id.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "database_id".into(),
        collection
            .map(|collection| Value::String(collection.database_id.clone()))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "database_name".into(),
        collection
            .map(|collection| Value::String(collection.database_name.clone()))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "collection_id".into(),
        Value::String(document.collection_id.clone()),
    );
    payload.insert(
        "collection_name".into(),
        Value::String(
            collection
                .map(|collection| collection.name.clone())
                .unwrap_or_default(),
        ),
    );
    payload.insert("document_id".into(), Value::String(document.id.clone()));
    payload.insert("operation".into(), Value::String(operation.into()));
    payload.insert("version".into(), json!(document.version));
    payload.insert(
        "occurred_at".into(),
        Value::String(document.updated_at.clone()),
    );
    if operation != "delete" {
        payload.insert("data".into(), document.data.clone());
    }
    Value::Object(payload)
}

fn enqueue_outbox_mem(
    memory: &mut MemoryState,
    collection_id: &str,
    document: &StoredDocument,
    operation: &str,
    event_id: Option<String>,
) {
    let collection = memory.collections.get(collection_id).cloned();
    let payload = outbox_payload(collection.as_ref(), document, operation, event_id);
    let event_id = payload
        .get("event_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    memory.outbox.push(MemoryOutbox {
        event_id,
        payload,
        published_at: None,
        attempts: 0,
        last_error: None,
    });
}

async fn enqueue_outbox_tx(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    collection_id: &str,
    document: &StoredDocument,
    operation: &str,
    event_id: Option<String>,
) -> Result<(), StoreError> {
    let collection_row = sqlx::query(
        "SELECT c.id, c.database_id, c.name, c.description, c.mapping, c.org_id,
                c.account_id, c.created_by, c.created_at, c.updated_at,
                d.name AS database_name
         FROM synapseone_base_collections c
         JOIN synapseone_base_databases d ON d.id = c.database_id
         WHERE c.id = $1 LIMIT 1",
    )
    .bind(collection_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| StoreError::invalid(error.to_string()))?;
    let collection = collection_row
        .as_ref()
        .map(collection_from_row)
        .transpose()?;
    let payload = outbox_payload(collection.as_ref(), document, operation, event_id);
    let occurred = payload
        .get("occurred_at")
        .and_then(Value::as_str)
        .and_then(parse_js_date)
        .unwrap_or_else(Utc::now);
    sqlx::query(
        r#"INSERT INTO synapseone_base_outbox
             (event_id, org_id, account_id, collection_id, collection_name,
              document_id, operation, version, occurred_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)"#,
    )
    .bind(payload.get("event_id").and_then(Value::as_str))
    .bind(payload.get("organization_id").and_then(Value::as_str))
    .bind(payload.get("account_id").and_then(Value::as_str))
    .bind(collection_id)
    .bind(
        payload
            .get("collection_name")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .bind(&document.id)
    .bind(operation)
    .bind(document.version)
    .bind(occurred)
    .bind(&payload)
    .execute(&mut **transaction)
    .await
    .map_err(|error| StoreError::invalid(error.to_string()))?;
    Ok(())
}

fn bind_params<'a>(
    sql: &'a str,
    params: &'a [SqlParam],
) -> sqlx::query::Query<'a, Postgres, PgArguments> {
    let mut query = sqlx::query(sql);
    for param in params {
        query = match param {
            SqlParam::Text(value) => query.bind(value),
            SqlParam::Json(value) => query.bind(value),
            SqlParam::I64(value) => query.bind(*value),
            SqlParam::F64(value) => query.bind(*value),
            SqlParam::Bool(value) => query.bind(*value),
        };
    }
    query
}
