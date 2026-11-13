// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! DuckDB-backed, tenant-scoped OLAP store.
//!
//! Each tenant gets an independent DuckDB database file. Dataset metadata and
//! ETL jobs live in the same file, so there is no cross-tenant query surface.
//! In-memory mode creates one database per tenant too.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, TimeZone, Utc};
use duckdb::arrow::datatypes::DataType as ArrowType;
use duckdb::types::{TimeUnit, ToSqlOutput, ValueRef};
use duckdb::{params_from_iter, Connection, ToSql};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::error::{internal_error, WarehouseError};
use crate::sql::{
    assert_read_only_sql, duck_type, from_duck_type, limited_sql, quote_ident, table_name,
};
use crate::types::{DatasetMeta, JobMeta, NewDataset, NewJob, QueryResult, StreamEventRows};
use crate::util::{iso, js_string, number_value, truthy};

const DATASET_COLUMNS: &str =
    "id, name, description, columns_json, mode, stream_topic, created_at, updated_at";
const JOB_COLUMNS: &str = "id, name, mode, status, target_dataset_id, sql, stream_topic, stream_group, batch_size, interval_ms, write_mode, created_at, updated_at, last_run_at, last_error";

/// Bind values used by the store. All dynamic SQL is parameterised.
#[derive(Debug, Clone)]
pub enum Param {
    Null,
    Text(String),
    Int(i64),
    Double(f64),
    Bool(bool),
}

impl ToSql for Param {
    fn to_sql(&self) -> duckdb::Result<ToSqlOutput<'_>> {
        Ok(match self {
            Param::Null => ToSqlOutput::Owned(duckdb::types::Value::Null),
            Param::Text(text) => ToSqlOutput::Owned(duckdb::types::Value::Text(text.clone())),
            Param::Int(value) => ToSqlOutput::Owned(duckdb::types::Value::BigInt(*value)),
            Param::Double(value) => ToSqlOutput::Owned(duckdb::types::Value::Double(*value)),
            Param::Bool(value) => ToSqlOutput::Owned(duckdb::types::Value::Boolean(*value)),
        })
    }
}

#[derive(Debug, Default)]
pub struct QueryRows {
    pub columns: Vec<String>,
    pub types: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
}

/// Execute a query and normalise DuckDB values to the JSON shapes the TS
/// service produced (big integers become strings when not JS-safe, timestamps
/// become ISO strings, non-finite floats become null).
pub fn read_all(conn: &Connection, sql: &str, params: &[Param]) -> duckdb::Result<QueryRows> {
    let mut statement = conn.prepare(sql)?;
    let mut result = statement.query(params_from_iter(params.iter()))?;
    let (columns, types) = if let Some(statement) = result.as_ref() {
        (
            statement.column_names(),
            (0..statement.column_count())
                .map(|index| type_name(&statement.column_type(index)))
                .collect::<Vec<_>>(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let mut rows = Vec::new();
    while let Some(row) = result.next()? {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            let value = row
                .get_ref(index)
                .map(value_ref_to_json)
                .unwrap_or(Value::Null);
            object.insert(name.clone(), value);
        }
        rows.push(object);
    }
    Ok(QueryRows {
        columns,
        types,
        rows,
    })
}

pub fn execute(conn: &Connection, sql: &str, params: &[Param]) -> duckdb::Result<usize> {
    conn.execute(sql, params_from_iter(params.iter()))
}

fn type_name(data_type: &ArrowType) -> String {
    let simple = match data_type {
        ArrowType::Null => Some("NULL"),
        ArrowType::Boolean => Some("BOOLEAN"),
        ArrowType::Int8 => Some("TINYINT"),
        ArrowType::Int16 => Some("SMALLINT"),
        ArrowType::Int32 => Some("INTEGER"),
        ArrowType::Int64 => Some("BIGINT"),
        ArrowType::UInt8 => Some("UTINYINT"),
        ArrowType::UInt16 => Some("USMALLINT"),
        ArrowType::UInt32 => Some("UINTEGER"),
        ArrowType::UInt64 => Some("UBIGINT"),
        ArrowType::Float16 | ArrowType::Float32 => Some("FLOAT"),
        ArrowType::Float64 => Some("DOUBLE"),
        ArrowType::Decimal128(_, _)
        | ArrowType::Decimal256(_, _)
        | ArrowType::Decimal32(_, _)
        | ArrowType::Decimal64(_, _) => Some("DECIMAL"),
        ArrowType::Timestamp(_, _) => Some("TIMESTAMP"),
        ArrowType::Date32 | ArrowType::Date64 => Some("DATE"),
        ArrowType::Time32(_) | ArrowType::Time64(_) => Some("TIME"),
        ArrowType::Interval(_) => Some("INTERVAL"),
        ArrowType::Utf8 | ArrowType::LargeUtf8 | ArrowType::Utf8View => Some("VARCHAR"),
        ArrowType::Binary
        | ArrowType::LargeBinary
        | ArrowType::BinaryView
        | ArrowType::FixedSizeBinary(_) => Some("BLOB"),
        _ => None,
    };
    if let Some(simple) = simple {
        return simple.to_string();
    }
    match data_type {
        ArrowType::List(field)
        | ArrowType::LargeList(field)
        | ArrowType::FixedSizeList(field, _) => format!("{}[]", type_name(field.data_type())),
        ArrowType::Struct(_) => "STRUCT".into(),
        ArrowType::Map(_, _) => "MAP".into(),
        ArrowType::Dictionary(_, value) => type_name(value),
        other => format!("{other:?}").to_uppercase(),
    }
}

fn safe_i128(value: i128) -> Value {
    if value.unsigned_abs() <= 9_007_199_254_740_991u128 {
        Value::Number(Number::from(value as i64))
    } else {
        Value::String(value.to_string())
    }
}

fn safe_u64(value: u64) -> Value {
    if value <= 9_007_199_254_740_991 {
        Value::Number(Number::from(value))
    } else {
        Value::String(value.to_string())
    }
}

fn float_value(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    // JavaScript has a single number type: integral doubles stringify without
    // a trailing `.0` (`JSON.stringify(1275.0) === "1275"`).
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        return Value::Number(Number::from(value as i64));
    }
    match Number::from_f64(value) {
        Some(number) => Value::Number(number),
        None => Value::Null,
    }
}

fn timestamp_micros(unit: TimeUnit, value: i64) -> Option<i64> {
    Some(unit.to_micros(value))
}

fn value_ref_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Boolean(flag) => Value::Bool(flag),
        ValueRef::TinyInt(value) => Value::Number(Number::from(value)),
        ValueRef::SmallInt(value) => Value::Number(Number::from(value)),
        ValueRef::Int(value) => Value::Number(Number::from(value)),
        ValueRef::BigInt(value) => {
            if value.unsigned_abs() <= 9_007_199_254_740_991 {
                Value::Number(Number::from(value))
            } else {
                Value::String(value.to_string())
            }
        }
        ValueRef::HugeInt(value) => safe_i128(value),
        ValueRef::UHugeInt(value) => {
            if value <= 9_007_199_254_740_991u128 {
                Value::Number(Number::from(value as u64))
            } else {
                Value::String(value.to_string())
            }
        }
        ValueRef::UTinyInt(value) => Value::Number(Number::from(value)),
        ValueRef::USmallInt(value) => Value::Number(Number::from(value)),
        ValueRef::UInt(value) => Value::Number(Number::from(value)),
        ValueRef::UBigInt(value) => safe_u64(value),
        ValueRef::Float(value) => float_value(value as f64),
        ValueRef::Double(value) => float_value(value),
        ValueRef::Decimal(value) => value
            .to_string()
            .parse::<f64>()
            .map(float_value)
            .unwrap_or_else(|_| Value::String(value.to_string())),
        ValueRef::Timestamp(unit, value) => timestamp_micros(unit, value)
            .and_then(chrono::DateTime::from_timestamp_micros)
            .map(|stamp: chrono::DateTime<Utc>| {
                Value::String(stamp.to_rfc3339_opts(SecondsFormat::Millis, true))
            })
            .unwrap_or(Value::Null),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) | ValueRef::Geometry(bytes) => Value::Array(
            bytes
                .iter()
                .map(|byte| Value::Number(Number::from(*byte)))
                .collect(),
        ),
        ValueRef::Date32(days) => chrono::DateTime::from_timestamp(days as i64 * 86_400, 0)
            .map(|stamp: chrono::DateTime<Utc>| {
                Value::String(stamp.to_rfc3339_opts(SecondsFormat::Millis, true))
            })
            .unwrap_or(Value::Null),
        ValueRef::Time64(unit, value) => {
            let micros = unit.to_micros(value);
            let seconds = micros.div_euclid(1_000_000) as u32;
            let nanos = (micros.rem_euclid(1_000_000) * 1_000) as u32;
            chrono::NaiveTime::from_num_seconds_from_midnight_opt(seconds, nanos)
                .map(|time| Value::String(time.format("%H:%M:%S%.f").to_string()))
                .unwrap_or(Value::Null)
        }
        ValueRef::Interval {
            months,
            days,
            nanos,
        } => Value::String(format!("{months} months {days} days {nanos} ns")),
        // Complex nested values are intentionally not exposed as JSON objects:
        // the service contract only promises scalar query output.
        ValueRef::List(_, _)
        | ValueRef::Enum(_, _)
        | ValueRef::Struct(_, _)
        | ValueRef::Array(_, _)
        | ValueRef::Map(_, _)
        | ValueRef::Union(_, _) => Value::Null,
        _ => Value::Null,
    }
}

pub fn value_i64(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or_else(|| {
            number
                .as_f64()
                .map(|value| value as i64)
                .unwrap_or_default()
        }),
        Some(Value::String(text)) => text.trim().parse::<i64>().unwrap_or_default(),
        _ => 0,
    }
}

fn value_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::String(_)) | None | Some(Value::Null) => None,
        Some(other) => Some(js_string(Some(other))),
    }
}

fn to_dataset(row: &Map<String, Value>, row_count: i64) -> DatasetMeta {
    let columns = row
        .get("columns_json")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Vec<crate::types::WarehouseColumn>>(raw).ok())
        .unwrap_or_default();
    DatasetMeta {
        id: js_string(row.get("id")),
        name: js_string(row.get("name")),
        description: row
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        columns,
        mode: if row.get("mode").and_then(Value::as_str) == Some("stream") {
            "stream".into()
        } else {
            "batch".into()
        },
        stream_topic: value_text(row.get("stream_topic")),
        row_count,
        created_at: js_string(row.get("created_at")),
        updated_at: js_string(row.get("updated_at")),
    }
}

fn to_job(row: &Map<String, Value>) -> JobMeta {
    JobMeta {
        id: js_string(row.get("id")),
        name: js_string(row.get("name")),
        mode: if row.get("mode").and_then(Value::as_str) == Some("stream") {
            "stream".into()
        } else {
            "batch".into()
        },
        status: if row.get("status").and_then(Value::as_str) == Some("paused") {
            "paused".into()
        } else {
            "running".into()
        },
        target_dataset_id: js_string(row.get("target_dataset_id")),
        sql: value_text(row.get("sql")),
        stream_topic: value_text(row.get("stream_topic")),
        stream_group: value_text(row.get("stream_group")),
        batch_size: value_i64(row.get("batch_size")),
        interval_ms: value_i64(row.get("interval_ms")),
        write_mode: if row.get("write_mode").and_then(Value::as_str) == Some("replace") {
            "replace".into()
        } else {
            "append".into()
        },
        created_at: js_string(row.get("created_at")),
        updated_at: js_string(row.get("updated_at")),
        last_run_at: value_text(row.get("last_run_at")),
        last_error: value_text(row.get("last_error")),
    }
}

#[derive(Debug, Clone)]
pub struct StoreOptions {
    pub memory: bool,
    pub data_dir: PathBuf,
    pub threads: u32,
}

impl StoreOptions {
    pub fn from_env() -> Self {
        let data_dir = std::env::var("WAREHOUSE_DATA_DIR")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/data/warehouse".into());
        let memory =
            std::env::var("WAREHOUSE_IN_MEMORY").as_deref() == Ok("1") || data_dir == ":memory:";
        let threads = std::env::var("WAREHOUSE_THREADS")
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|value| *value != 0)
            .unwrap_or(2)
            .clamp(1, 16);
        Self {
            memory,
            data_dir: PathBuf::from(data_dir),
            threads,
        }
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Self {
            memory: true,
            data_dir: PathBuf::from(":memory:"),
            threads: 2,
        }
    }

    #[cfg(test)]
    pub fn file(data_dir: PathBuf) -> Self {
        Self {
            memory: false,
            data_dir,
            threads: 2,
        }
    }
}

struct TenantDb {
    conn: Mutex<Connection>,
}

struct StoreInner {
    dbs: Mutex<HashMap<String, Arc<TenantDb>>>,
    tenants_lock: Mutex<()>,
    options: StoreOptions,
}

#[derive(Clone)]
pub struct WarehouseStore {
    inner: Arc<StoreInner>,
}

impl WarehouseStore {
    pub fn new(options: StoreOptions) -> Self {
        Self {
            inner: Arc::new(StoreInner {
                dbs: Mutex::new(HashMap::new()),
                tenants_lock: Mutex::new(()),
                options,
            }),
        }
    }

    /// Create the data directory at boot so a bad production volume fails
    /// closed before the service reports healthy.
    pub fn preflight(&self) -> Result<(), String> {
        if self.inner.options.memory {
            return Ok(());
        }
        fs::create_dir_all(&self.inner.options.data_dir).map_err(|error| {
            format!(
                "[warehouse] cannot create WAREHOUSE_DATA_DIR '{}': {error}",
                self.inner.options.data_dir.display()
            )
        })
    }

    fn remember_tenant(&self, tenant: &str) -> Result<(), WarehouseError> {
        if self.inner.options.memory {
            return Ok(());
        }
        let _guard = self
            .inner
            .tenants_lock
            .lock()
            .map_err(|_| internal_error("tenant index poisoned"))?;
        let file = self.inner.options.data_dir.join("tenants.json");
        let mut tenants = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default();
        let tenant = tenant.to_string();
        if !tenants.contains(&tenant) {
            tenants.push(tenant);
            let payload = serde_json::to_vec(&tenants)
                .map_err(|error| internal_error(format!("tenants.json encode: {error}")))?;
            fs::write(&file, payload)
                .map_err(|error| internal_error(format!("tenants.json write: {error}")))?;
        }
        Ok(())
    }

    pub fn list_tenants(&self) -> Vec<String> {
        if self.inner.options.memory {
            return self
                .inner
                .dbs
                .lock()
                .map(|dbs| dbs.keys().cloned().collect())
                .unwrap_or_default();
        }
        let Ok(_guard) = self.inner.tenants_lock.lock() else {
            return Vec::new();
        };
        let file = self.inner.options.data_dir.join("tenants.json");
        fs::read_to_string(file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default()
    }

    fn open(&self, tenant: &str) -> Result<Arc<TenantDb>, WarehouseError> {
        let path = if self.inner.options.memory {
            ":memory:".to_string()
        } else {
            fs::create_dir_all(&self.inner.options.data_dir)
                .map_err(|error| internal_error(format!("create data dir: {error}")))?;
            let mut hasher = Sha256::new();
            hasher.update(tenant.as_bytes());
            let hash = hex::encode(hasher.finalize());
            self.inner
                .options
                .data_dir
                .join(format!("{}.duckdb", &hash[..32]))
                .to_string_lossy()
                .to_string()
        };
        self.remember_tenant(tenant)?;
        let conn = Connection::open(&path)
            .map_err(|error| internal_error(format!("open duckdb {path}: {error}")))?;
        conn.execute_batch(&format!("SET threads={}", self.inner.options.threads))
            .map_err(|error| internal_error(format!("set duckdb threads: {error}")))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _datasets (
                id VARCHAR PRIMARY KEY,
                name VARCHAR NOT NULL,
                description VARCHAR,
                columns_json VARCHAR NOT NULL,
                mode VARCHAR NOT NULL,
                stream_topic VARCHAR,
                created_at VARCHAR NOT NULL,
                updated_at VARCHAR NOT NULL
            );
            CREATE TABLE IF NOT EXISTS _ingest_events (
                event_id VARCHAR NOT NULL,
                dataset_id VARCHAR NOT NULL,
                job_id VARCHAR,
                applied_at VARCHAR NOT NULL,
                PRIMARY KEY (event_id, dataset_id)
            );
            CREATE TABLE IF NOT EXISTS _jobs (
                id VARCHAR PRIMARY KEY,
                name VARCHAR NOT NULL,
                mode VARCHAR NOT NULL,
                status VARCHAR NOT NULL,
                target_dataset_id VARCHAR NOT NULL,
                sql VARCHAR,
                stream_topic VARCHAR,
                stream_group VARCHAR,
                batch_size INTEGER,
                interval_ms INTEGER,
                write_mode VARCHAR,
                created_at VARCHAR NOT NULL,
                updated_at VARCHAR NOT NULL,
                last_run_at VARCHAR,
                last_error VARCHAR
            );",
        )
        .map_err(|error| internal_error(format!("ensure duckdb metadata: {error}")))?;
        Ok(Arc::new(TenantDb {
            conn: Mutex::new(conn),
        }))
    }

    fn db(&self, tenant: &str) -> Result<Arc<TenantDb>, WarehouseError> {
        if let Some(existing) = self
            .inner
            .dbs
            .lock()
            .map_err(|_| internal_error("tenant map poisoned"))?
            .get(tenant)
            .cloned()
        {
            return Ok(existing);
        }
        let opened = self.open(tenant)?;
        let mut dbs = self
            .inner
            .dbs
            .lock()
            .map_err(|_| internal_error("tenant map poisoned"))?;
        Ok(dbs
            .entry(tenant.to_string())
            .or_insert_with(|| opened.clone())
            .clone())
    }

    /// Serialise every statement per tenant (DuckDB connections are not
    /// concurrent-safe). Blocking DuckDB work runs on the blocking pool.
    pub async fn with_conn<T, F>(&self, tenant: &str, operation: F) -> Result<T, WarehouseError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, WarehouseError> + Send + 'static,
    {
        let db = self.db(tenant)?;
        tokio::task::spawn_blocking(move || {
            let conn = db
                .conn
                .lock()
                .map_err(|_| internal_error("duckdb connection poisoned"))?;
            operation(&conn)
        })
        .await
        .map_err(|error| internal_error(format!("duckdb worker failed: {error}")))?
    }

    pub async fn list_datasets(&self, tenant: &str) -> Result<Vec<DatasetMeta>, WarehouseError> {
        self.with_conn(tenant, |conn| {
            let result = read_all(
                conn,
                &format!("SELECT {DATASET_COLUMNS} FROM _datasets ORDER BY created_at"),
                &[],
            )
            .map_err(|error| internal_error(format!("list datasets: {error}")))?;
            let mut out = Vec::with_capacity(result.rows.len());
            for row in &result.rows {
                let id = js_string(row.get("id"));
                let count = read_all(
                    conn,
                    &format!(
                        "SELECT count(*) AS n FROM {}",
                        quote_ident(&table_name(&id))
                    ),
                    &[],
                )
                .map_err(|error| internal_error(format!("count dataset rows: {error}")))?;
                let row_count = value_i64(count.rows.first().and_then(|row| row.get("n")));
                out.push(to_dataset(row, row_count));
            }
            Ok(out)
        })
        .await
    }

    pub async fn get_dataset(
        &self,
        tenant: &str,
        id: &str,
    ) -> Result<Option<DatasetMeta>, WarehouseError> {
        let id = id.to_string();
        self.with_conn(tenant, move |conn| {
            let result = read_all(
                conn,
                &format!("SELECT {DATASET_COLUMNS} FROM _datasets WHERE id = ?"),
                &[Param::Text(id.clone())],
            )
            .map_err(|error| internal_error(format!("get dataset: {error}")))?;
            let Some(row) = result.rows.first() else {
                return Ok(None);
            };
            let count = read_all(
                conn,
                &format!(
                    "SELECT count(*) AS n FROM {}",
                    quote_ident(&table_name(&id))
                ),
                &[],
            )
            .map_err(|error| internal_error(format!("count dataset rows: {error}")))?;
            let row_count = value_i64(count.rows.first().and_then(|row| row.get("n")));
            Ok(Some(to_dataset(row, row_count)))
        })
        .await
    }

    pub async fn create_dataset(
        &self,
        tenant: &str,
        input: NewDataset,
    ) -> Result<DatasetMeta, WarehouseError> {
        let now = iso(Utc::now());
        self.with_conn(tenant, move |conn| {
            let existing = read_all(
                conn,
                "SELECT id FROM _datasets WHERE id = ?",
                &[Param::Text(input.id.clone())],
            )
            .map_err(|error| internal_error(format!("check dataset: {error}")))?;
            if !existing.rows.is_empty() {
                return Err(WarehouseError::new(
                    axum::http::StatusCode::CONFLICT,
                    "dataset_exists",
                    format!("dataset '{}' already exists", input.id),
                ));
            }
            let definitions = input
                .columns
                .iter()
                .map(|column| {
                    format!(
                        "{} {}",
                        quote_ident(&column.name),
                        duck_type(&column.column_type)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            execute(
                conn,
                &format!(
                    "CREATE TABLE {} ({definitions})",
                    quote_ident(&table_name(&input.id))
                ),
                &[],
            )
            .map_err(|error| internal_error(format!("create dataset table: {error}")))?;
            let columns_json = serde_json::to_string(&input.columns)
                .map_err(|error| internal_error(format!("encode columns: {error}")))?;
            execute(
                conn,
                &format!(
                    "INSERT INTO _datasets ({DATASET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                ),
                &[
                    Param::Text(input.id.clone()),
                    Param::Text(input.name.clone()),
                    Param::Text(input.description.clone()),
                    Param::Text(columns_json),
                    Param::Text(input.mode.clone()),
                    input.stream_topic.clone().map_or(Param::Null, Param::Text),
                    Param::Text(now.clone()),
                    Param::Text(now.clone()),
                ],
            )
            .map_err(|error| internal_error(format!("insert dataset metadata: {error}")))?;
            Ok(DatasetMeta {
                id: input.id,
                name: input.name,
                description: input.description,
                columns: input.columns,
                mode: input.mode,
                stream_topic: input.stream_topic,
                row_count: 0,
                created_at: now.clone(),
                updated_at: now,
            })
        })
        .await
    }

    pub async fn delete_dataset(&self, tenant: &str, id: &str) -> Result<bool, WarehouseError> {
        let id = id.to_string();
        self.with_conn(tenant, move |conn| {
            let existing = read_all(
                conn,
                "SELECT id FROM _datasets WHERE id = ?",
                &[Param::Text(id.clone())],
            )
            .map_err(|error| internal_error(format!("check dataset: {error}")))?;
            if existing.rows.is_empty() {
                return Ok(false);
            }
            execute(
                conn,
                &format!("DROP TABLE IF EXISTS {}", quote_ident(&table_name(&id))),
                &[],
            )
            .map_err(|error| internal_error(format!("drop dataset table: {error}")))?;
            execute(
                conn,
                "DELETE FROM _jobs WHERE target_dataset_id = ?",
                &[Param::Text(id.clone())],
            )
            .map_err(|error| internal_error(format!("delete dataset jobs: {error}")))?;
            execute(
                conn,
                "DELETE FROM _ingest_events WHERE dataset_id = ?",
                &[Param::Text(id.clone())],
            )
            .map_err(|error| internal_error(format!("delete dataset markers: {error}")))?;
            execute(
                conn,
                "DELETE FROM _datasets WHERE id = ?",
                &[Param::Text(id)],
            )
            .map_err(|error| internal_error(format!("delete dataset: {error}")))?;
            Ok(true)
        })
        .await
    }

    fn insert_rows_on_conn(
        conn: &Connection,
        dataset: &DatasetMeta,
        rows: &[Value],
    ) -> Result<usize, WarehouseError> {
        if rows.is_empty() || rows.len() > 5000 {
            return Err(WarehouseError::bad_request(
                "invalid_rows",
                "rows must be an array of 1..5000 objects",
            ));
        }
        let mut tuples = Vec::with_capacity(rows.len());
        let mut values = Vec::with_capacity(rows.len() * dataset.columns.len());
        for raw in rows {
            let Some(row) = raw.as_object() else {
                return Err(WarehouseError::bad_request(
                    "invalid_rows",
                    "every row must be a JSON object",
                ));
            };
            let mut placeholders = Vec::with_capacity(dataset.columns.len());
            for column in &dataset.columns {
                let cast = match column.column_type.as_str() {
                    "json" => "?::JSON",
                    "timestamp" => "?::TIMESTAMP",
                    _ => "?",
                };
                placeholders.push(cast);
                let raw_value = row.get(&column.name).unwrap_or(&Value::Null);
                if raw_value.is_null() {
                    values.push(Param::Null);
                    continue;
                }
                let param = match column.column_type.as_str() {
                    "json" => match raw_value {
                        Value::String(text) => Param::Text(text.clone()),
                        other => Param::Text(serde_json::to_string(other).unwrap_or_default()),
                    },
                    "timestamp" => {
                        let raw = js_string(Some(raw_value));
                        Param::Text(
                            crate::util::parse_date(&raw)
                                .map(|stamp| stamp.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
                                .unwrap_or(raw),
                        )
                    }
                    "boolean" => Param::Bool(truthy(raw_value)),
                    "number" => match number_value(Some(raw_value)) {
                        Some(value) if value.is_finite() => Param::Double(value),
                        _ => {
                            return Err(WarehouseError::bad_request(
                                "invalid_rows",
                                format!("column '{}' must be numeric", column.name),
                            ))
                        }
                    },
                    _ => match raw_value {
                        Value::String(text) => Param::Text(text.clone()),
                        Value::Object(_) | Value::Array(_) => {
                            Param::Text(serde_json::to_string(raw_value).unwrap_or_default())
                        }
                        other => Param::Text(js_string(Some(other))),
                    },
                };
                values.push(param);
            }
            tuples.push(format!("({})", placeholders.join(", ")));
        }
        execute(
            conn,
            &format!(
                "INSERT INTO {} VALUES {}",
                quote_ident(&table_name(&dataset.id)),
                tuples.join(", ")
            ),
            &values,
        )
        .map_err(|error| internal_error(format!("insert rows: {error}")))?;
        execute(
            conn,
            "UPDATE _datasets SET updated_at = ? WHERE id = ?",
            &[
                Param::Text(iso(Utc::now())),
                Param::Text(dataset.id.clone()),
            ],
        )
        .map_err(|error| internal_error(format!("touch dataset: {error}")))?;
        Ok(rows.len())
    }

    pub async fn insert_rows(
        &self,
        tenant: &str,
        dataset: &DatasetMeta,
        rows: &[Value],
    ) -> Result<usize, WarehouseError> {
        let dataset = dataset.clone();
        let rows = rows.to_vec();
        self.with_conn(tenant, move |conn| {
            Self::insert_rows_on_conn(conn, &dataset, &rows)
        })
        .await
    }

    /// Durable stream materialisation: rows + event-id marker commit together.
    /// A crash before ack leaves the marker, so redelivery is a no-op.
    pub async fn ingest_stream_events(
        &self,
        tenant: &str,
        dataset: &DatasetMeta,
        job_id: &str,
        events: Vec<StreamEventRows>,
    ) -> Result<(i64, i64), WarehouseError> {
        if events.is_empty() {
            return Ok((0, 0));
        }
        let dataset = dataset.clone();
        let job_id = job_id.to_string();
        self.with_conn(tenant, move |conn| {
            let mut inserted = 0i64;
            let mut duplicates = 0i64;
            conn.execute_batch("BEGIN")
                .map_err(|error| internal_error(format!("begin stream ingest: {error}")))?;
            let result = (|| -> Result<(), WarehouseError> {
                for event in &events {
                    let existing = read_all(
                        conn,
                        "SELECT event_id FROM _ingest_events WHERE event_id = ? AND dataset_id = ?",
                        &[
                            Param::Text(event.event_id.clone()),
                            Param::Text(dataset.id.clone()),
                        ],
                    )
                    .map_err(|error| internal_error(format!("check event marker: {error}")))?;
                    if !existing.rows.is_empty() {
                        duplicates += 1;
                        continue;
                    }
                    if !event.rows.is_empty() {
                        inserted += Self::insert_rows_on_conn(conn, &dataset, &event.rows)? as i64;
                    }
                    execute(
                        conn,
                        "INSERT INTO _ingest_events (event_id, dataset_id, job_id, applied_at) VALUES (?, ?, ?, ?)",
                        &[
                            Param::Text(event.event_id.clone()),
                            Param::Text(dataset.id.clone()),
                            Param::Text(job_id.clone()),
                            Param::Text(iso(Utc::now())),
                        ],
                    )
                    .map_err(|error| internal_error(format!("insert event marker: {error}")))?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
            conn.execute_batch("COMMIT")
                .map_err(|error| internal_error(format!("commit stream ingest: {error}")))?;
            Ok((inserted, duplicates))
        })
        .await
    }

    pub async fn query(
        &self,
        tenant: &str,
        raw_sql: Option<&Value>,
        limit: i64,
    ) -> Result<QueryResult, WarehouseError> {
        let safe_sql = assert_read_only_sql(raw_sql)
            .map_err(|error| WarehouseError::bad_request("invalid_sql", error))?;
        let bounded = limit.clamp(1, 5000);
        let started = Instant::now();
        self.with_conn(tenant, move |conn| {
            let timeout_ms = std::env::var("WAREHOUSE_QUERY_TIMEOUT_MS")
                .ok()
                .and_then(|value| value.trim().parse::<i64>().ok())
                .filter(|value| *value != 0)
                .unwrap_or(15_000)
                .clamp(1_000, 120_000);
            let handle = conn.interrupt_handle();
            let (sender, receiver) = std::sync::mpsc::channel::<()>();
            let watcher = std::thread::spawn(move || {
                if receiver
                    .recv_timeout(Duration::from_millis(timeout_ms as u64))
                    .is_err()
                {
                    handle.interrupt();
                }
            });
            let outcome = read_all(conn, &limited_sql(&safe_sql, bounded), &[]);
            let _ = sender.send(());
            let _ = watcher.join();
            let result = match outcome {
                Ok(result) => result,
                Err(error) => {
                    let message = error.to_string();
                    let lowered = message.to_lowercase();
                    if lowered.contains("interrupt") || lowered.contains("cancel") {
                        return Err(WarehouseError::new(
                            axum::http::StatusCode::REQUEST_TIMEOUT,
                            "query_timeout",
                            format!("query exceeded {timeout_ms}ms"),
                        ));
                    }
                    return Err(WarehouseError::bad_request(
                        "query_failed",
                        message.chars().take(500).collect::<String>(),
                    ));
                }
            };
            let truncated = result.rows.len() > bounded as usize;
            let rows = if truncated {
                result
                    .rows
                    .into_iter()
                    .take(bounded as usize)
                    .collect::<Vec<_>>()
            } else {
                result.rows
            };
            let payload = serde_json::to_string(
                &rows
                    .iter()
                    .map(|row| Value::Object(row.clone()))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default();
            if payload.encode_utf16().count() > 5 * 1024 * 1024 {
                return Err(WarehouseError::new(
                    axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                    "result_too_large",
                    "query result exceeds 5MB; add filters or aggregates",
                ));
            }
            let row_count = rows.len();
            Ok(QueryResult {
                columns: result.columns,
                types: result.types,
                rows: rows.into_iter().map(Value::Object).collect(),
                row_count,
                truncated,
                duration_ms: started.elapsed().as_millis() as u64,
            })
        })
        .await
    }

    pub async fn list_jobs(&self, tenant: &str) -> Result<Vec<JobMeta>, WarehouseError> {
        self.with_conn(tenant, |conn| {
            let result = read_all(
                conn,
                &format!("SELECT {JOB_COLUMNS} FROM _jobs ORDER BY created_at"),
                &[],
            )
            .map_err(|error| internal_error(format!("list jobs: {error}")))?;
            Ok(result.rows.iter().map(to_job).collect())
        })
        .await
    }

    pub async fn get_job(&self, tenant: &str, id: &str) -> Result<Option<JobMeta>, WarehouseError> {
        let id = id.to_string();
        self.with_conn(tenant, move |conn| {
            let result = read_all(
                conn,
                &format!("SELECT {JOB_COLUMNS} FROM _jobs WHERE id = ?"),
                &[Param::Text(id)],
            )
            .map_err(|error| internal_error(format!("get job: {error}")))?;
            Ok(result.rows.first().map(to_job))
        })
        .await
    }

    pub async fn find_job_by_name(
        &self,
        tenant: &str,
        name: &str,
    ) -> Result<Option<JobMeta>, WarehouseError> {
        let name = name.to_string();
        self.with_conn(tenant, move |conn| {
            let result = read_all(
                conn,
                &format!(
                    "SELECT {JOB_COLUMNS} FROM _jobs WHERE name = ? ORDER BY created_at DESC LIMIT 1"
                ),
                &[Param::Text(name)],
            )
            .map_err(|error| internal_error(format!("find job: {error}")))?;
            Ok(result.rows.first().map(to_job))
        })
        .await
    }

    pub async fn create_job(&self, tenant: &str, input: NewJob) -> Result<JobMeta, WarehouseError> {
        let now = iso(Utc::now());
        let id = uuid::Uuid::new_v4().to_string();
        self.with_conn(tenant, move |conn| {
            execute(
                conn,
                &format!(
                    "INSERT INTO _jobs ({JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                ),
                &[
                    Param::Text(id.clone()),
                    Param::Text(input.name.clone()),
                    Param::Text(input.mode.clone()),
                    Param::Text("running".into()),
                    Param::Text(input.target_dataset_id.clone()),
                    input.sql.clone().map_or(Param::Null, Param::Text),
                    input.stream_topic.clone().map_or(Param::Null, Param::Text),
                    input.stream_group.clone().map_or(Param::Null, Param::Text),
                    Param::Int(input.batch_size),
                    Param::Int(input.interval_ms),
                    Param::Text(input.write_mode.clone()),
                    Param::Text(now.clone()),
                    Param::Text(now.clone()),
                    Param::Null,
                    Param::Null,
                ],
            )
            .map_err(|error| internal_error(format!("insert job: {error}")))?;
            Ok(JobMeta {
                id,
                name: input.name,
                mode: input.mode,
                status: "running".into(),
                target_dataset_id: input.target_dataset_id,
                sql: input.sql,
                stream_topic: input.stream_topic,
                stream_group: input.stream_group,
                batch_size: input.batch_size,
                interval_ms: input.interval_ms,
                write_mode: input.write_mode,
                created_at: now.clone(),
                updated_at: now,
                last_run_at: None,
                last_error: None,
            })
        })
        .await
    }

    pub async fn set_job_status(
        &self,
        tenant: &str,
        id: &str,
        status: &str,
    ) -> Result<Option<JobMeta>, WarehouseError> {
        let id = id.to_string();
        let status = status.to_string();
        self.with_conn(tenant, move |conn| {
            execute(
                conn,
                "UPDATE _jobs SET status = ?, updated_at = ? WHERE id = ?",
                &[
                    Param::Text(status),
                    Param::Text(iso(Utc::now())),
                    Param::Text(id.clone()),
                ],
            )
            .map_err(|error| internal_error(format!("set job status: {error}")))?;
            let result = read_all(
                conn,
                &format!("SELECT {JOB_COLUMNS} FROM _jobs WHERE id = ?"),
                &[Param::Text(id)],
            )
            .map_err(|error| internal_error(format!("read job: {error}")))?;
            Ok(result.rows.first().map(to_job))
        })
        .await
    }

    pub async fn record_job_run(
        &self,
        tenant: &str,
        id: &str,
        _rows: i64,
    ) -> Result<(), WarehouseError> {
        let id = id.to_string();
        self.with_conn(tenant, move |conn| {
            execute(
                conn,
                "UPDATE _jobs SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
                &[
                    Param::Text(iso(Utc::now())),
                    Param::Text(iso(Utc::now())),
                    Param::Text(id),
                ],
            )
            .map_err(|error| internal_error(format!("record job run: {error}")))?;
            Ok(())
        })
        .await
    }

    pub async fn record_job_error(
        &self,
        tenant: &str,
        id: &str,
        error: impl std::fmt::Display,
    ) -> Result<(), WarehouseError> {
        let message = error.to_string().chars().take(1000).collect::<String>();
        let id = id.to_string();
        self.with_conn(tenant, move |conn| {
            execute(
                conn,
                "UPDATE _jobs SET last_error = ?, updated_at = ? WHERE id = ?",
                &[
                    Param::Text(message),
                    Param::Text(iso(Utc::now())),
                    Param::Text(id),
                ],
            )
            .map_err(|error| internal_error(format!("record job error: {error}")))?;
            Ok(())
        })
        .await
    }

    pub async fn delete_job(&self, tenant: &str, id: &str) -> Result<bool, WarehouseError> {
        let id = id.to_string();
        self.with_conn(tenant, move |conn| {
            let existing = read_all(
                conn,
                "SELECT id FROM _jobs WHERE id = ?",
                &[Param::Text(id.clone())],
            )
            .map_err(|error| internal_error(format!("check job: {error}")))?;
            if existing.rows.is_empty() {
                return Ok(false);
            }
            execute(conn, "DELETE FROM _jobs WHERE id = ?", &[Param::Text(id)])
                .map_err(|error| internal_error(format!("delete job: {error}")))?;
            Ok(true)
        })
        .await
    }

    pub async fn running_stream_jobs(&self) -> Result<Vec<(String, JobMeta)>, WarehouseError> {
        let mut out = Vec::new();
        for tenant in self.list_tenants() {
            for job in self.list_jobs(&tenant).await? {
                if job.mode == "stream" && job.status == "running" && job.stream_topic.is_some() {
                    out.push((tenant.clone(), job));
                }
            }
        }
        Ok(out)
    }

    /// Apply a batch ETL query to the target dataset (append or replace).
    pub async fn run_batch_job(
        &self,
        tenant: &str,
        job: &JobMeta,
    ) -> Result<(i64, u128), WarehouseError> {
        let Some(raw_sql) = job.sql.clone() else {
            return Err(WarehouseError::bad_request(
                "invalid_job",
                "batch jobs require sql",
            ));
        };
        let sql = assert_read_only_sql(Some(&Value::String(raw_sql)))
            .map_err(|error| WarehouseError::bad_request("invalid_job", error))?;
        let started = Instant::now();
        let job = job.clone();
        self.with_conn(tenant, move |conn| {
            let target = read_all(
                conn,
                "SELECT id FROM _datasets WHERE id = ?",
                &[Param::Text(job.target_dataset_id.clone())],
            )
            .map_err(|error| internal_error(format!("check target dataset: {error}")))?;
            if target.rows.is_empty() {
                return Err(WarehouseError::new(
                    axum::http::StatusCode::NOT_FOUND,
                    "dataset_not_found",
                    format!("target dataset '{}' not found", job.target_dataset_id),
                ));
            }
            let target_table = quote_ident(&table_name(&job.target_dataset_id));
            let outcome = (|| -> Result<(), WarehouseError> {
                if job.write_mode == "replace" {
                    execute(
                        conn,
                        &format!("CREATE OR REPLACE TABLE {target_table} AS {sql}"),
                        &[],
                    )
                    .map_err(|error| {
                        WarehouseError::bad_request(
                            "etl_failed",
                            error.to_string().chars().take(500).collect::<String>(),
                        )
                    })?;
                    let described = read_all(conn, &format!("DESCRIBE {target_table}"), &[])
                        .map_err(|error| {
                            WarehouseError::bad_request(
                                "etl_failed",
                                error.to_string().chars().take(500).collect::<String>(),
                            )
                        })?;
                    let columns = described
                        .rows
                        .iter()
                        .map(|row| crate::types::WarehouseColumn {
                            name: js_string(row.get("column_name")),
                            column_type: from_duck_type(
                                row.get("column_type")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default(),
                            ),
                        })
                        .collect::<Vec<_>>();
                    let columns_json = serde_json::to_string(&columns)
                        .map_err(|error| internal_error(format!("encode etl columns: {error}")))?;
                    execute(
                        conn,
                        "UPDATE _datasets SET columns_json = ?, updated_at = ? WHERE id = ?",
                        &[
                            Param::Text(columns_json),
                            Param::Text(iso(Utc::now())),
                            Param::Text(job.target_dataset_id.clone()),
                        ],
                    )
                    .map_err(|error| internal_error(format!("update etl schema: {error}")))?;
                } else {
                    execute(conn, &format!("INSERT INTO {target_table} {sql}"), &[]).map_err(
                        |error| {
                            WarehouseError::bad_request(
                                "etl_failed",
                                error.to_string().chars().take(500).collect::<String>(),
                            )
                        },
                    )?;
                }
                Ok(())
            })();
            outcome?;
            let counted = read_all(
                conn,
                &format!("SELECT count(*) AS n FROM {target_table}"),
                &[],
            )
            .map_err(|error| internal_error(format!("count etl target: {error}")))?;
            execute(
                conn,
                "UPDATE _jobs SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
                &[
                    Param::Text(iso(Utc::now())),
                    Param::Text(iso(Utc::now())),
                    Param::Text(job.id.clone()),
                ],
            )
            .map_err(|error| internal_error(format!("record etl run: {error}")))?;
            Ok((
                value_i64(counted.rows.first().and_then(|row| row.get("n"))),
                started.elapsed().as_millis(),
            ))
        })
        .await
    }

    /// Tenant-scoped operational snapshot for the pipeline status API.
    pub async fn pipeline_status(&self, tenant: &str) -> Result<Value, WarehouseError> {
        self.with_conn(tenant, |conn| {
            let datasets = read_all(conn, "SELECT count(*) AS n FROM _datasets", &[])
                .map_err(|error| internal_error(format!("pipeline datasets: {error}")))?;
            let jobs = read_all(conn, "SELECT status, count(*) AS n FROM _jobs GROUP BY status", &[])
                .map_err(|error| internal_error(format!("pipeline jobs: {error}")))?;
            let last = read_all(
                conn,
                "SELECT max(last_run_at) AS last_run, max(updated_at) AS updated, max(last_error) AS last_error FROM _jobs",
                &[],
            )
            .map_err(|error| internal_error(format!("pipeline last run: {error}")))?;
            let applied = read_all(
                conn,
                "SELECT count(*) AS n FROM _ingest_events e JOIN _datasets d ON d.id = e.dataset_id",
                &[],
            )
            .map_err(|error| internal_error(format!("pipeline applied: {error}")))?;
            let total_jobs = jobs
                .rows
                .iter()
                .map(|row| value_i64(row.get("n")))
                .sum::<i64>();
            let running = jobs
                .rows
                .iter()
                .find(|row| row.get("status").and_then(Value::as_str) == Some("running"))
                .map(|row| value_i64(row.get("n")))
                .unwrap_or(0);
            let paused = jobs
                .rows
                .iter()
                .find(|row| row.get("status").and_then(Value::as_str) == Some("paused"))
                .map(|row| value_i64(row.get("n")))
                .unwrap_or(0);
            let last_row = last.rows.first();
            Ok(serde_json::json!({
                "datasets": value_i64(datasets.rows.first().and_then(|row| row.get("n"))),
                "jobs": total_jobs,
                "running": running,
                "paused": paused,
                "appliedEvents": value_i64(applied.rows.first().and_then(|row| row.get("n"))),
                "lastRunAt": last_row.and_then(|row| value_text(row.get("last_run"))),
                "updatedAt": last_row.and_then(|row| value_text(row.get("updated"))),
                "lastError": last_row.and_then(|row| value_text(row.get("last_error"))),
            }))
        })
        .await
    }

    /// Drop all open tenant handles (tests and process restart simulations).
    #[cfg(test)]
    pub async fn reset(&self) {
        let handles = self
            .inner
            .dbs
            .lock()
            .map(|mut dbs| dbs.drain().map(|(_, value)| value).collect::<Vec<_>>())
            .unwrap_or_default();
        drop(handles);
    }
}

pub fn millis_to_iso(millis: i64) -> String {
    Utc.timestamp_millis_opt(millis)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

pub fn num_or_zero(value: Option<&Value>) -> f64 {
    number_value(value)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

pub fn json_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Value::Number(Number::from(value as i64))
    } else {
        float_value(value)
    }
}
