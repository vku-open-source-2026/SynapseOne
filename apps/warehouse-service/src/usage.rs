// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Internal usage-analytics rollups (#usage).
//!
//! IAM periodically pushes two pre-aggregated shapes into each tenant's DuckDB
//! file. They are internal: never listed as datasets and not reachable through
//! the read-only SQL API.

use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

use crate::error::WarehouseError;
use crate::store::{
    execute, json_number, millis_to_iso, num_or_zero, read_all, value_i64, Param, WarehouseStore,
};
use crate::util::{clean_text, iso, js_string, number_value, parse_date};

/// Inclusive upper bounds (ms) for the latency histogram; the last bucket is overflow.
pub const USAGE_LATENCY_BOUNDS: [i64; 29] = [
    1, 2, 5, 10, 20, 30, 40, 50, 60, 75, 90, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 750,
    1000, 1500, 2000, 3000, 5000, 10000, 30000,
];
pub const USAGE_LATENCY_BUCKETS: usize = USAGE_LATENCY_BOUNDS.len() + 1;

const HOUR_MS: i64 = 3_600_000;
const MAX_ROLLUP_HOURS: i64 = 48;
const MAX_HOURLY_ROWS: usize = 20_000;
const MAX_USER_ROWS: usize = 50_000;

fn lat_columns() -> &'static Vec<String> {
    static COLUMNS: OnceLock<Vec<String>> = OnceLock::new();
    COLUMNS.get_or_init(|| {
        let mut columns = USAGE_LATENCY_BOUNDS
            .iter()
            .map(|bound| format!("lat_{bound}"))
            .collect::<Vec<_>>();
        columns.push("lat_inf".into());
        columns
    })
}

fn hourly_columns() -> &'static Vec<String> {
    static COLUMNS: OnceLock<Vec<String>> = OnceLock::new();
    COLUMNS.get_or_init(|| {
        let mut columns = vec![
            "bucket",
            "feature",
            "route",
            "method",
            "status_class",
            "auth_kind",
            "account_id",
            "model",
            "requests",
            "success",
            "client_errors",
            "server_errors",
            "duration_sum",
            "duration_max",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        columns.extend(lat_columns().iter().cloned());
        columns.extend(
            [
                "prompt_tokens",
                "completion_tokens",
                "total_tokens",
                "last_request_at",
            ]
            .into_iter()
            .map(str::to_string),
        );
        columns
    })
}

fn user_columns() -> &'static Vec<String> {
    static COLUMNS: OnceLock<Vec<String>> = OnceLock::new();
    COLUMNS.get_or_init(|| {
        [
            "bucket",
            "feature",
            "method",
            "status_class",
            "account_id",
            "user_id",
            "requests",
            "first_seen",
            "last_seen",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    })
}

#[derive(Debug, Clone, Default)]
pub struct UsageStatsFilter {
    pub from: String,
    pub to: String,
    pub feature: Option<String>,
    pub account_id: Option<String>,
    pub method: Option<String>,
    pub status_class: Option<i64>,
}

fn ensure_usage_tables(conn: &duckdb::Connection) -> Result<(), WarehouseError> {
    let lat_definitions = lat_columns()
        .iter()
        .map(|column| format!("{column} BIGINT NOT NULL"))
        .collect::<Vec<_>>()
        .join(",\n    ");
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS _usage_hourly (
            bucket TIMESTAMP NOT NULL,
            feature VARCHAR NOT NULL,
            route VARCHAR NOT NULL,
            method VARCHAR NOT NULL,
            status_class INTEGER NOT NULL,
            auth_kind VARCHAR NOT NULL,
            account_id VARCHAR,
            model VARCHAR,
            requests BIGINT NOT NULL,
            success BIGINT NOT NULL,
            client_errors BIGINT NOT NULL,
            server_errors BIGINT NOT NULL,
            duration_sum BIGINT NOT NULL,
            duration_max INTEGER NOT NULL,
            {lat_definitions},
            prompt_tokens BIGINT NOT NULL,
            completion_tokens BIGINT NOT NULL,
            total_tokens BIGINT NOT NULL,
            last_request_at TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _usage_hourly_user (
            bucket TIMESTAMP NOT NULL,
            feature VARCHAR NOT NULL,
            method VARCHAR NOT NULL,
            status_class INTEGER NOT NULL,
            account_id VARCHAR,
            user_id VARCHAR NOT NULL,
            requests BIGINT NOT NULL,
            first_seen TIMESTAMP NOT NULL,
            last_seen TIMESTAMP NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _usage_rollup_state (
            id VARCHAR PRIMARY KEY,
            covered_from TIMESTAMP,
            covered_until TIMESTAMP NOT NULL
        );"
    ))
    .map_err(|error| crate::error::internal_error(format!("ensure usage tables: {error}")))?;
    // Migration for warehouses created before covered_from existed.
    let state_columns = read_all(conn, "DESCRIBE _usage_rollup_state", &[])
        .map_err(|error| crate::error::internal_error(format!("describe usage state: {error}")))?;
    if !state_columns
        .rows
        .iter()
        .any(|row| row.get("column_name").and_then(Value::as_str) == Some("covered_from"))
    {
        conn.execute_batch(
            "ALTER TABLE _usage_rollup_state ADD COLUMN covered_from TIMESTAMP;
             UPDATE _usage_rollup_state
                SET covered_from = covered_until - INTERVAL 30 DAY
              WHERE covered_from IS NULL;",
        )
        .map_err(|error| crate::error::internal_error(format!("migrate usage state: {error}")))?;
    }
    Ok(())
}

fn validate_range(
    from_raw: &str,
    to_raw: &str,
    max_hours: i64,
    too_large: &str,
) -> Result<(DateTime<Utc>, DateTime<Utc>), WarehouseError> {
    let from = parse_date(from_raw).ok_or_else(|| {
        WarehouseError::bad_request("invalid_range", "from/to must be ISO timestamps")
    })?;
    let to = parse_date(to_raw).ok_or_else(|| {
        WarehouseError::bad_request("invalid_range", "from/to must be ISO timestamps")
    })?;
    if to <= from {
        return Err(WarehouseError::bad_request(
            "invalid_range",
            "to must be after from",
        ));
    }
    if to.signed_duration_since(from).num_milliseconds() > max_hours * HOUR_MS {
        return Err(WarehouseError::bad_request("range_too_large", too_large));
    }
    Ok((from, to))
}

fn iso_timestamp(value: Option<&Value>) -> Result<String, WarehouseError> {
    let raw = js_string(value);
    parse_date(&raw).map(iso).ok_or_else(|| {
        WarehouseError::bad_request("invalid_timestamp", "invalid timestamp in usage rollup")
    })
}

/// Bind timestamps in DuckDB's canonical literal shape. JSON output keeps the
/// `toISOString` shape; the database only needs an unambiguous instant.
fn timestamp_param(value: &str) -> Param {
    match parse_date(value) {
        Some(stamp) => Param::Text(stamp.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
        None => Param::Text(value.to_string()),
    }
}

fn rollup_count(value: Option<&Value>, max: f64) -> f64 {
    let numeric = number_value(value).filter(|value| value.is_finite());
    match numeric {
        Some(number) if number >= 0.0 => number.floor().min(max),
        _ => 0.0,
    }
}

fn nullable_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = clean_text(value, max).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn normalize_hourly(
    row: Option<&Value>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<Param>, WarehouseError> {
    let object = row.and_then(Value::as_object);
    let bucket = iso_timestamp(object.and_then(|row| row.get("bucket")))?;
    let when = parse_date(&bucket).unwrap_or(from);
    if when < from || when >= to {
        return Err(WarehouseError::bad_request(
            "invalid_bucket",
            "hourly bucket must be inside [from, to)",
        ));
    }
    let mut latency = object
        .and_then(|row| row.get("latency"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| rollup_count(Some(item), 9_007_199_254_740_991.0))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    latency.resize(USAGE_LATENCY_BUCKETS, 0.0);
    let mut params = vec![
        timestamp_param(&bucket),
        Param::Text({
            let text = clean_text(object.and_then(|row| row.get("feature")), 64);
            if text.is_empty() {
                "other".into()
            } else {
                text
            }
        }),
        Param::Text({
            let text = clean_text(object.and_then(|row| row.get("route")), 200);
            if text.is_empty() {
                "/".into()
            } else {
                text
            }
        }),
        Param::Text({
            let text = clean_text(object.and_then(|row| row.get("method")), 16).to_uppercase();
            if text.is_empty() {
                "GET".into()
            } else {
                text
            }
        }),
        Param::Int(rollup_count(object.and_then(|row| row.get("statusClass")), 5.0) as i64),
        Param::Text({
            let text = clean_text(object.and_then(|row| row.get("authKind")), 32);
            if text.is_empty() {
                "unknown".into()
            } else {
                text
            }
        }),
        nullable_text(object.and_then(|row| row.get("accountId")), 64)
            .map_or(Param::Null, Param::Text),
        nullable_text(object.and_then(|row| row.get("model")), 200)
            .map_or(Param::Null, Param::Text),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("requests")),
            9_007_199_254_740_991.0,
        ) as i64),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("success")),
            9_007_199_254_740_991.0,
        ) as i64),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("clientErrors")),
            9_007_199_254_740_991.0,
        ) as i64),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("serverErrors")),
            9_007_199_254_740_991.0,
        ) as i64),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("durationSum")),
            9_007_199_254_740_991.0,
        ) as i64),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("durationMax")),
            9_007_199_254_740_991.0,
        ) as i64),
    ];
    for count in latency.into_iter().take(USAGE_LATENCY_BUCKETS) {
        params.push(Param::Int(count as i64));
    }
    params.push(Param::Int(rollup_count(
        object.and_then(|row| row.get("promptTokens")),
        9_007_199_254_740_991.0,
    ) as i64));
    params.push(Param::Int(rollup_count(
        object.and_then(|row| row.get("completionTokens")),
        9_007_199_254_740_991.0,
    ) as i64));
    params.push(Param::Int(rollup_count(
        object.and_then(|row| row.get("totalTokens")),
        9_007_199_254_740_991.0,
    ) as i64));
    let last_request_at = iso_timestamp(object.and_then(|row| row.get("lastRequestAt")))?;
    params.push(timestamp_param(&last_request_at));
    Ok(params)
}

fn normalize_user(
    row: Option<&Value>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<Param>, WarehouseError> {
    let object = row.and_then(Value::as_object);
    let bucket = iso_timestamp(object.and_then(|row| row.get("bucket")))?;
    let when = parse_date(&bucket).unwrap_or(from);
    if when < from || when >= to {
        return Err(WarehouseError::bad_request(
            "invalid_bucket",
            "user bucket must be inside [from, to)",
        ));
    }
    let first_seen = iso_timestamp(object.and_then(|row| row.get("firstSeen")))?;
    let last_seen = iso_timestamp(object.and_then(|row| row.get("lastSeen")))?;
    Ok(vec![
        timestamp_param(&bucket),
        Param::Text({
            let text = clean_text(object.and_then(|row| row.get("feature")), 64);
            if text.is_empty() {
                "other".into()
            } else {
                text
            }
        }),
        Param::Text({
            let text = clean_text(object.and_then(|row| row.get("method")), 16).to_uppercase();
            if text.is_empty() {
                "GET".into()
            } else {
                text
            }
        }),
        Param::Int(rollup_count(object.and_then(|row| row.get("statusClass")), 5.0) as i64),
        nullable_text(object.and_then(|row| row.get("accountId")), 64)
            .map_or(Param::Null, Param::Text),
        Param::Text(clean_text(object.and_then(|row| row.get("userId")), 64)),
        Param::Int(rollup_count(
            object.and_then(|row| row.get("requests")),
            9_007_199_254_740_991.0,
        ) as i64),
        timestamp_param(&first_seen),
        timestamp_param(&last_seen),
    ])
}

fn placeholders(rows: usize, column_count: usize, timestamp_indexes: &[usize]) -> String {
    let one = (0..column_count)
        .map(|index| {
            if timestamp_indexes.contains(&index) {
                "?::TIMESTAMP"
            } else {
                "?"
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    (0..rows)
        .map(|_| format!("({one})"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn insert_chunks(
    conn: &duckdb::Connection,
    table: &str,
    columns: &[String],
    values: Vec<Vec<Param>>,
    chunk_size: usize,
    timestamp_indexes: &[usize],
) -> Result<(), WarehouseError> {
    let mut values = values.into_iter();
    loop {
        let chunk = values.by_ref().take(chunk_size).collect::<Vec<_>>();
        if chunk.is_empty() {
            break;
        }
        let placeholders = placeholders(chunk.len(), columns.len(), timestamp_indexes);
        let params = chunk.into_iter().flatten().collect::<Vec<_>>();
        execute(
            conn,
            &format!(
                "INSERT INTO {table} ({}) VALUES {placeholders}",
                columns.join(", ")
            ),
            &params,
        )
        .map_err(|error| crate::error::internal_error(format!("insert usage rollup: {error}")))?;
    }
    Ok(())
}

/// Replace one [from, to) rollup range atomically. Idempotent per range.
pub async fn replace_usage_rollup(
    store: &WarehouseStore,
    tenant: &str,
    input: &Value,
) -> Result<(usize, usize), WarehouseError> {
    let from_raw = js_string(input.get("from"));
    let to_raw = js_string(input.get("to"));
    let (from, to) = validate_range(
        &from_raw,
        &to_raw,
        MAX_ROLLUP_HOURS,
        &format!("usage rollup range is limited to {MAX_ROLLUP_HOURS}h"),
    )?;
    let hourly_input = input
        .get("hourly")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let users_input = input
        .get("users")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if hourly_input.len() > MAX_HOURLY_ROWS {
        return Err(WarehouseError::new(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_rows",
            format!("hourly rollup is limited to {MAX_HOURLY_ROWS} rows"),
        ));
    }
    if users_input.len() > MAX_USER_ROWS {
        return Err(WarehouseError::new(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_rows",
            format!("user rollup is limited to {MAX_USER_ROWS} rows"),
        ));
    }
    let hourly_values = hourly_input
        .iter()
        .map(|row| normalize_hourly(Some(row), from, to))
        .collect::<Result<Vec<_>, _>>()?;
    let user_values = users_input
        .iter()
        .map(|row| normalize_user(Some(row), from, to))
        .collect::<Result<Vec<_>, _>>()?;
    let hourly_count = hourly_values.len();
    let user_count = user_values.len();
    let from_millis = from.timestamp_millis();
    let to_millis = to.timestamp_millis();
    let from_iso = iso(from);
    let to_iso = iso(to);
    let hourly_ts = [0, hourly_columns().len() - 1];
    let user_ts = [0, 7, 8];
    let hourly_columns = hourly_columns().clone();
    let user_columns = user_columns().clone();

    store
        .with_conn(tenant, move |conn| {
            ensure_usage_tables(conn)?;
            conn.execute_batch("BEGIN").map_err(|error| {
                crate::error::internal_error(format!("begin usage rollup: {error}"))
            })?;
            let outcome = (|| -> Result<(), WarehouseError> {
                execute(
                    conn,
                    "DELETE FROM _usage_hourly WHERE bucket >= ?::TIMESTAMP AND bucket < ?::TIMESTAMP",
                    &[
                        timestamp_param(&from_iso),
                        timestamp_param(&to_iso),
                    ],
                )
                .map_err(|error| crate::error::internal_error(format!("clear hourly rollup: {error}")))?;
                execute(
                    conn,
                    "DELETE FROM _usage_hourly_user WHERE bucket >= ?::TIMESTAMP AND bucket < ?::TIMESTAMP",
                    &[timestamp_param(&from_iso), timestamp_param(&to_iso)],
                )
                .map_err(|error| crate::error::internal_error(format!("clear user rollup: {error}")))?;
                insert_chunks(
                    conn,
                    "_usage_hourly",
                    &hourly_columns,
                    hourly_values,
                    100,
                    &hourly_ts,
                )?;
                insert_chunks(
                    conn,
                    "_usage_hourly_user",
                    &user_columns,
                    user_values,
                    200,
                    &user_ts,
                )?;
                let previous = read_all(
                    conn,
                    "SELECT epoch_ms(covered_from) AS covered_from, epoch_ms(covered_until) AS covered_until FROM _usage_rollup_state WHERE id = 'usage'",
                    &[],
                )
                .map_err(|error| crate::error::internal_error(format!("read usage state: {error}")))?;
                let previous = previous.rows.first();
                let prev_from = previous
                    .and_then(|row| row.get("covered_from"))
                    .and_then(Value::as_i64);
                let prev_until = previous
                    .and_then(|row| row.get("covered_until"))
                    .and_then(Value::as_i64);
                let next_from = prev_from
                    .filter(|value| *value < from_millis)
                    .map(millis_to_iso)
                    .unwrap_or_else(|| from_iso.clone());
                let next_until = prev_until
                    .filter(|value| *value > to_millis)
                    .map(millis_to_iso)
                    .unwrap_or_else(|| to_iso.clone());
                execute(conn, "DELETE FROM _usage_rollup_state WHERE id = 'usage'", &[])
                    .map_err(|error| crate::error::internal_error(format!("clear usage state: {error}")))?;
                execute(
                    conn,
                    "INSERT INTO _usage_rollup_state (id, covered_from, covered_until) VALUES ('usage', ?::TIMESTAMP, ?::TIMESTAMP)",
                    &[
                        timestamp_param(&next_from),
                        timestamp_param(&next_until),
                    ],
                )
                .map_err(|error| crate::error::internal_error(format!("write usage state: {error}")))?;
                Ok(())
            })();
            if let Err(error) = outcome {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
            conn.execute_batch("COMMIT").map_err(|error| {
                crate::error::internal_error(format!("commit usage rollup: {error}"))
            })?;
            Ok(())
        })
        .await?;
    Ok((hourly_count, user_count))
}

fn where_clause(filter: &UsageStatsFilter) -> (String, Vec<Param>) {
    let mut conditions = vec![
        "bucket >= ?::TIMESTAMP".to_string(),
        "bucket < ?::TIMESTAMP".to_string(),
    ];
    let mut params = vec![
        Param::Text(filter.from.clone()),
        Param::Text(filter.to.clone()),
    ];
    if let Some(feature) = &filter.feature {
        conditions.push("feature = ?".into());
        params.push(Param::Text(feature.clone()));
    }
    if let Some(method) = &filter.method {
        conditions.push("method = ?".into());
        params.push(Param::Text(method.clone()));
    }
    if let Some(status_class) = filter.status_class.filter(|value| *value != 0) {
        conditions.push("status_class = ?".into());
        params.push(Param::Int(status_class));
    }
    if let Some(account_id) = &filter.account_id {
        conditions.push("account_id = ?".into());
        params.push(Param::Text(account_id.clone()));
    }
    // The first two parameters are the bucket bounds.
    params[0] = timestamp_param(&filter.from);
    params[1] = timestamp_param(&filter.to);
    (conditions.join(" AND "), params)
}

fn aggregate_select() -> String {
    let lat = lat_columns()
        .iter()
        .map(|column| format!("coalesce(sum({column}), 0) AS {column}"))
        .collect::<Vec<_>>()
        .join(",\n  ");
    format!(
        "coalesce(sum(requests), 0) AS requests,
  coalesce(sum(success), 0) AS success,
  coalesce(sum(client_errors), 0) AS client_errors,
  coalesce(sum(server_errors), 0) AS server_errors,
  coalesce(sum(duration_sum), 0) AS duration_sum,
  {lat},
  coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
  coalesce(sum(completion_tokens), 0) AS completion_tokens,
  coalesce(sum(total_tokens), 0) AS total_tokens,
  epoch_ms(max(last_request_at)) AS last_request_at"
    )
}

fn aggregate_from_row(row: Option<&Map<String, Value>>) -> Value {
    let last_request_at = row
        .and_then(|row| row.get("last_request_at"))
        .and_then(Value::as_i64)
        .map(millis_to_iso);
    json!({
        "requests": json_number(num_or_zero(row.and_then(|row| row.get("requests")))),
        "success": json_number(num_or_zero(row.and_then(|row| row.get("success")))),
        "clientErrors": json_number(num_or_zero(row.and_then(|row| row.get("client_errors")))),
        "serverErrors": json_number(num_or_zero(row.and_then(|row| row.get("server_errors")))),
        "durationSum": json_number(num_or_zero(row.and_then(|row| row.get("duration_sum")))),
        "latency": lat_columns()
            .iter()
            .map(|column| json_number(num_or_zero(row.and_then(|row| row.get(column)))))
            .collect::<Vec<_>>(),
        "promptTokens": json_number(num_or_zero(row.and_then(|row| row.get("prompt_tokens")))),
        "completionTokens": json_number(num_or_zero(row.and_then(|row| row.get("completion_tokens")))),
        "totalTokens": json_number(num_or_zero(row.and_then(|row| row.get("total_tokens")))),
        "lastRequestAt": last_request_at,
    })
}

fn empty_summary(
    from: &str,
    to: &str,
    min_bucket: Option<String>,
    coverage_start: Option<String>,
    coverage_end: Option<String>,
) -> Value {
    json!({
        "from": from,
        "to": to,
        "minBucket": min_bucket,
        "coverageStart": coverage_start,
        "coverageEnd": coverage_end,
        "totals": {
            "requests": 0,
            "success": 0,
            "clientErrors": 0,
            "serverErrors": 0,
            "durationSum": 0,
            "latency": vec![0; USAGE_LATENCY_BUCKETS],
            "promptTokens": 0,
            "completionTokens": 0,
            "totalTokens": 0,
            "lastRequestAt": null,
            "userIds": [],
            "accountIds": [],
        },
        "features": [],
        "series": [],
        "statusClasses": [],
        "authKinds": [],
        "topRoutes": [],
        "models": [],
    })
}

/// Read pre-aggregated usage for one tenant. Internal endpoint only.
pub async fn usage_stats_summary(
    store: &WarehouseStore,
    tenant: &str,
    filter: UsageStatsFilter,
) -> Result<Value, WarehouseError> {
    let (from, to) = validate_range(
        &filter.from,
        &filter.to,
        366 * 24,
        "usage summary range is limited to 366 days",
    )?;
    let from_millis = from.timestamp_millis();
    let to_millis = to.timestamp_millis();
    let bounded = UsageStatsFilter {
        from: iso(from),
        to: iso(to),
        feature: filter.feature,
        account_id: filter.account_id,
        method: filter.method,
        status_class: filter
            .status_class
            .filter(|value| *value != 0)
            .map(|value| value.clamp(0, 5)),
    };
    let from_iso = bounded.from.clone();
    let to_iso = bounded.to.clone();
    store
        .with_conn(tenant, move |conn| {
            ensure_usage_tables(conn)?;
            let bounds = read_all(
                conn,
                "SELECT epoch_ms(min(bucket)) AS min_bucket FROM _usage_hourly",
                &[],
            )
            .map_err(|error| crate::error::internal_error(format!("usage bounds: {error}")))?;
            let state = read_all(
                conn,
                "SELECT epoch_ms(covered_from) AS covered_from, epoch_ms(covered_until) AS covered_until FROM _usage_rollup_state WHERE id = 'usage'",
                &[],
            )
            .map_err(|error| crate::error::internal_error(format!("usage state: {error}")))?;
            let min_bucket = bounds
                .rows
                .first()
                .and_then(|row| row.get("min_bucket"))
                .and_then(Value::as_i64)
                .map(millis_to_iso);
            let coverage_start = state
                .rows
                .first()
                .and_then(|row| row.get("covered_from"))
                .and_then(Value::as_i64)
                .map(millis_to_iso);
            let coverage_end = state
                .rows
                .first()
                .and_then(|row| row.get("covered_until"))
                .and_then(Value::as_i64)
                .map(millis_to_iso);
            let Some(coverage_end) = coverage_end else {
                return Ok(empty_summary(
                    &from_iso,
                    &to_iso,
                    None,
                    None,
                    None,
                ));
            };
            let coverage_end_millis = parse_date(&coverage_end)
                .map(|value| value.timestamp_millis())
                .unwrap_or_default();
            let query_to = if to_millis < coverage_end_millis {
                to_iso.clone()
            } else {
                coverage_end.clone()
            };
            let query_to_millis = coverage_end_millis.min(to_millis);
            if from_millis >= query_to_millis {
                return Ok(empty_summary(
                    &from_iso,
                    &to_iso,
                    min_bucket,
                    coverage_start,
                    Some(coverage_end),
                ));
            }
            let scoped = UsageStatsFilter {
                from: from_iso.clone(),
                to: query_to,
                ..bounded.clone()
            };
            let (where_sql, where_params) = where_clause(&scoped);
            let aggregate = aggregate_select();

            let totals = read_all(
                conn,
                &format!("SELECT {aggregate} FROM _usage_hourly WHERE {where_sql}"),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage totals: {error}")))?;
            let feature_rows = read_all(
                conn,
                &format!("SELECT feature, {aggregate} FROM _usage_hourly WHERE {where_sql} GROUP BY feature ORDER BY sum(requests) DESC"),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage features: {error}")))?;
            let series_rows = read_all(
                conn,
                &format!(
                    "SELECT epoch_ms(bucket) AS ts, coalesce(sum(requests), 0) AS requests,
                            coalesce(sum(client_errors + server_errors), 0) AS errors,
                            coalesce(sum(duration_sum), 0) AS duration_sum
                       FROM _usage_hourly WHERE {where_sql} GROUP BY bucket ORDER BY bucket"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage series: {error}")))?;
            let status_rows = read_all(
                conn,
                &format!(
                    "SELECT status_class, coalesce(sum(requests), 0) AS requests
                       FROM _usage_hourly WHERE {where_sql} GROUP BY status_class ORDER BY status_class"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage status: {error}")))?;
            let auth_rows = read_all(
                conn,
                &format!(
                    "SELECT auth_kind, coalesce(sum(requests), 0) AS requests
                       FROM _usage_hourly WHERE {where_sql} GROUP BY auth_kind ORDER BY sum(requests) DESC"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage auth: {error}")))?;
            let route_rows = read_all(
                conn,
                &format!(
                    "SELECT feature, route, method, coalesce(sum(requests), 0) AS requests,
                            coalesce(sum(client_errors + server_errors), 0) AS errors,
                            coalesce(sum(duration_sum), 0) AS duration_sum
                       FROM _usage_hourly WHERE {where_sql}
                      GROUP BY feature, route, method ORDER BY sum(requests) DESC LIMIT 10"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage routes: {error}")))?;
            let model_rows = read_all(
                conn,
                &format!(
                    "SELECT model, coalesce(sum(requests), 0) AS requests,
                            coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
                            coalesce(sum(completion_tokens), 0) AS completion_tokens,
                            coalesce(sum(total_tokens), 0) AS total_tokens
                       FROM _usage_hourly WHERE {where_sql} AND model IS NOT NULL AND model <> ''
                      GROUP BY model ORDER BY sum(total_tokens) DESC LIMIT 20"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage models: {error}")))?;
            let user_rows = read_all(
                conn,
                &format!(
                    "SELECT DISTINCT user_id FROM _usage_hourly_user WHERE {where_sql} AND user_id <> ''"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage users: {error}")))?;
            let account_rows = read_all(
                conn,
                &format!(
                    "SELECT DISTINCT account_id FROM _usage_hourly WHERE {where_sql} AND account_id IS NOT NULL AND account_id <> ''"
                ),
                &where_params,
            )
            .map_err(|error| crate::error::internal_error(format!("usage accounts: {error}")))?;

            let totals_row = totals.rows.first();
            let mut totals_json = aggregate_from_row(totals_row);
            if let Some(object) = totals_json.as_object_mut() {
                object.insert(
                    "userIds".into(),
                    Value::Array(
                        user_rows
                            .rows
                            .iter()
                            .map(|row| row.get("user_id"))
                            .filter(|value| value.and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
                            .map(|value| js_string(value).into())
                            .collect(),
                    ),
                );
                object.insert(
                    "accountIds".into(),
                    Value::Array(
                        account_rows
                            .rows
                            .iter()
                            .filter_map(|row| row.get("account_id").and_then(Value::as_str))
                            .filter(|value| !value.is_empty())
                            .map(|value| Value::String(value.to_string()))
                            .collect(),
                    ),
                );
            }
            let features = feature_rows
                .rows
                .iter()
                .map(|row| {
                    let mut value = aggregate_from_row(Some(row));
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "feature".into(),
                            Value::String(js_string(row.get("feature"))),
                        );
                    }
                    value
                })
                .collect::<Vec<_>>();
            let series = series_rows
                .rows
                .iter()
                .map(|row| {
                    json!({
                        "ts": millis_to_iso(value_i64(row.get("ts"))),
                        "requests": json_number(num_or_zero(row.get("requests"))),
                        "errors": json_number(num_or_zero(row.get("errors"))),
                        "durationSum": json_number(num_or_zero(row.get("duration_sum"))),
                    })
                })
                .collect::<Vec<_>>();
            let status_classes = status_rows
                .rows
                .iter()
                .map(|row| {
                    json!({
                        "class": format!("{}xx", value_i64(row.get("status_class"))),
                        "count": json_number(num_or_zero(row.get("requests"))),
                    })
                })
                .collect::<Vec<_>>();
            let auth_kinds = auth_rows
                .rows
                .iter()
                .map(|row| {
                    json!({
                        "kind": js_string(row.get("auth_kind")),
                        "requests": json_number(num_or_zero(row.get("requests"))),
                    })
                })
                .collect::<Vec<_>>();
            let top_routes = route_rows
                .rows
                .iter()
                .map(|row| {
                    json!({
                        "feature": js_string(row.get("feature")),
                        "route": js_string(row.get("route")),
                        "method": js_string(row.get("method")),
                        "requests": json_number(num_or_zero(row.get("requests"))),
                        "errors": json_number(num_or_zero(row.get("errors"))),
                        "durationSum": json_number(num_or_zero(row.get("duration_sum"))),
                    })
                })
                .collect::<Vec<_>>();
            let models = model_rows
                .rows
                .iter()
                .map(|row| {
                    json!({
                        "model": js_string(row.get("model")),
                        "requests": json_number(num_or_zero(row.get("requests"))),
                        "promptTokens": json_number(num_or_zero(row.get("prompt_tokens"))),
                        "completionTokens": json_number(num_or_zero(row.get("completion_tokens"))),
                        "totalTokens": json_number(num_or_zero(row.get("total_tokens"))),
                    })
                })
                .collect::<Vec<_>>();

            Ok(json!({
                "from": from_iso,
                "to": to_iso,
                "minBucket": min_bucket,
                "coverageStart": coverage_start,
                "coverageEnd": Some(coverage_end),
                "totals": totals_json,
                "features": features,
                "series": series,
                "statusClasses": status_classes,
                "authKinds": auth_kinds,
                "topRoutes": top_routes,
                "models": models,
            }))
        })
        .await
}

/// Coverage watermark for a tenant (null when no completed rollup yet).
pub async fn usage_watermark(
    store: &WarehouseStore,
    tenant: &str,
) -> Result<Value, WarehouseError> {
    store
        .with_conn(tenant, move |conn| {
            ensure_usage_tables(conn)?;
            let rows = read_all(
                conn,
                "SELECT epoch_ms(min(bucket)) AS min_bucket, epoch_ms(max(bucket)) AS max_bucket FROM _usage_hourly",
                &[],
            )
            .map_err(|error| crate::error::internal_error(format!("usage watermark: {error}")))?;
            let state = read_all(
                conn,
                "SELECT epoch_ms(covered_from) AS covered_from, epoch_ms(covered_until) AS covered_until FROM _usage_rollup_state WHERE id = 'usage'",
                &[],
            )
            .map_err(|error| crate::error::internal_error(format!("usage watermark state: {error}")))?;
            let row = rows.rows.first();
            let state_row = state.rows.first();
            Ok(json!({
                "minBucket": row.and_then(|row| row.get("min_bucket")).and_then(Value::as_i64).map(millis_to_iso),
                "maxBucket": row.and_then(|row| row.get("max_bucket")).and_then(Value::as_i64).map(millis_to_iso),
                "coveredFrom": state_row.and_then(|row| row.get("covered_from")).and_then(Value::as_i64).map(millis_to_iso),
                "coveredUntil": state_row.and_then(|row| row.get("covered_until")).and_then(Value::as_i64).map(millis_to_iso),
            }))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_shape_matches_typescript() {
        assert_eq!(USAGE_LATENCY_BUCKETS, 30);
        assert_eq!(lat_columns().len(), 30);
        assert_eq!(hourly_columns().len(), 48);
        assert_eq!(user_columns().len(), 9);
        assert_eq!(hourly_columns()[0], "bucket");
        assert_eq!(hourly_columns()[47], "last_request_at");
        assert_eq!(user_columns()[8], "last_seen");
    }

    #[test]
    fn counts_are_non_negative_and_capped() {
        assert_eq!(rollup_count(Some(&json!(-5)), 5.0), 0.0);
        assert_eq!(rollup_count(Some(&json!("3.9")), 5.0), 3.0);
        assert_eq!(rollup_count(Some(&json!(9)), 5.0), 5.0);
        assert_eq!(rollup_count(Some(&json!(null)), 5.0), 0.0);
    }

    #[test]
    fn ranges_are_bounded() {
        assert!(validate_range(
            "2026-11-12T10:00:00Z",
            "2026-11-12T12:00:00Z",
            48,
            "too big"
        )
        .is_ok());
        assert!(validate_range(
            "2026-11-12T12:00:00Z",
            "2026-11-12T10:00:00Z",
            48,
            "too big"
        )
        .is_err());
        assert!(validate_range("bad", "2026-11-12T10:00:00Z", 48, "too big").is_err());
        assert!(validate_range(
            "2026-11-10T00:00:00Z",
            "2026-11-13T00:00:00Z",
            48,
            "too big"
        )
        .is_err());
    }

    #[test]
    fn empty_summary_has_the_full_shape() {
        let summary = empty_summary("a", "b", None, None, None);
        assert_eq!(summary["totals"]["latency"].as_array().unwrap().len(), 30);
        assert_eq!(summary["totals"]["userIds"].as_array().unwrap().len(), 0);
        assert!(summary["features"].as_array().unwrap().is_empty());
    }

    #[test]
    fn aggregate_reads_iso_timestamps() {
        let mut row = Map::new();
        row.insert("requests".into(), json!(8));
        row.insert("last_request_at".into(), json!(1_762_944_900_000i64));
        let aggregate = aggregate_from_row(Some(&row));
        assert_eq!(aggregate["requests"], 8);
        assert_eq!(aggregate["lastRequestAt"], "2025-11-12T10:55:00.000Z");
    }
}
