// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SQL safety and identifier helpers.
//!
//! Queries run inside a per-tenant DuckDB database, so tenants cannot see each
//! other's tables. The remaining boundary is preventing a query from reading
//! files, extensions or writing to the warehouse. Only a single SELECT/WITH
//! statement is allowed; DDL/DML, file readers and internal tables are rejected.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::types::{WarehouseColumn, COLUMN_TYPES};
use crate::util::js_string;

const FORBIDDEN_KEYWORDS: &[&str] = &[
    "attach",
    "detach",
    "copy",
    "install",
    "load",
    "pragma",
    "export",
    "import",
    "create",
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "grant",
    "revoke",
    "call",
    "set",
    "reset",
    "vacuum",
    "checkpoint",
    "read_csv",
    "read_csv_auto",
    "read_parquet",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_ndjson_auto",
    "sqlite_scan",
    "postgres_scan",
    "mysql_scan",
    "iceberg_scan",
    "delta_scan",
    "parquet_scan",
    "csv_scan",
    "json_scan",
    "ndjson_scan",
    "avro_scan",
    "glob",
    "getenv",
    "query_table",
    "query",
    "duckdb_",
    "sniff_csv",
    "parquet_metadata",
    "parquet_schema",
];

fn dataset_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9_]{1,40}$").unwrap())
}

fn column_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9_]{0,62}$").unwrap())
}

fn forbidden_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"(?i)\b({})\b", FORBIDDEN_KEYWORDS.join("|"))).unwrap())
}

fn read_function_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bread_[a-z0-9_]*\s*\(").unwrap())
}

fn internal_table_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\b(?:from|join)\s+"?_[a-z0-9_]+"?"#).unwrap())
}

pub fn is_valid_dataset_id(id: &str) -> bool {
    dataset_id_re().is_match(id)
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Dataset ids are lower-case slugs and cannot start with `_`, so using the id
/// directly keeps SQL natural and cannot collide with the metadata tables.
pub fn table_name(dataset_id: &str) -> String {
    dataset_id.to_string()
}

pub fn duck_type(column_type: &str) -> &'static str {
    match column_type {
        "number" => "DOUBLE",
        "boolean" => "BOOLEAN",
        "timestamp" => "TIMESTAMP",
        "json" => "JSON",
        _ => "VARCHAR",
    }
}

pub fn from_duck_type(column_type: &str) -> String {
    let upper = column_type.to_uppercase();
    if [
        "DOUBLE", "REAL", "FLOAT", "DECIMAL", "NUMERIC", "INTEGER", "BIGINT", "SMALLINT",
        "TINYINT", "HUGEINT", "UBIGINT",
    ]
    .iter()
    .any(|prefix| upper.starts_with(prefix))
    {
        return "number".into();
    }
    if upper == "BOOLEAN" {
        return "boolean".into();
    }
    if upper.contains("TIMESTAMP") || upper.contains("DATE") || upper.contains("TIME") {
        return "timestamp".into();
    }
    if upper == "JSON" {
        return "json".into();
    }
    "string".into()
}

pub fn slugify_dataset_id(value: Option<&Value>) -> String {
    let lowered = js_string(value).trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut previous_underscore = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            previous_underscore = false;
        } else if !previous_underscore {
            out.push('_');
            previous_underscore = true;
        }
    }
    out.trim_matches('_').chars().take(40).collect()
}

/// Validate and normalise `columns` from a request body.
pub fn normalize_columns(input: Option<&Value>) -> Result<Vec<WarehouseColumn>, String> {
    let Some(Value::Array(items)) = input else {
        return Err("columns must be an array of 1..64 column definitions".into());
    };
    if items.is_empty() || items.len() > 64 {
        return Err("columns must be an array of 1..64 column definitions".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut columns = Vec::with_capacity(items.len());
    for raw in items {
        let entry = raw.as_object();
        let name = js_string(entry.and_then(|entry| entry.get("name")))
            .trim()
            .to_lowercase();
        let column_type = {
            let raw_type = match entry.and_then(|entry| entry.get("type")) {
                Some(value) if !value.is_null() => value.clone(),
                _ => Value::String("string".into()),
            };
            js_string(Some(&raw_type)).trim().to_lowercase()
        };
        if !column_name_re().is_match(&name) {
            return Err(format!(
                "invalid column name '{name}' (lower-case letter, then letters/digits/underscore; max 63)"
            ));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("duplicate column '{name}'"));
        }
        if !COLUMN_TYPES.contains(&column_type.as_str()) {
            return Err(format!(
                "invalid column type '{column_type}' ({})",
                COLUMN_TYPES.join(", ")
            ));
        }
        columns.push(WarehouseColumn { name, column_type });
    }
    Ok(columns)
}

/// Blank SQL string/identifier literals so keyword checks do not reject data
/// values such as `WHERE operation = 'delete'`.
fn mask_literals(sql: &str) -> String {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut out = String::with_capacity(sql.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch != '\'' && ch != '"' {
            out.push(ch);
            index += 1;
            continue;
        }
        let quote = ch;
        out.push(' ');
        index += 1;
        while index < chars.len() {
            if chars[index] == quote {
                if chars.get(index + 1) == Some(&quote) {
                    out.push(' ');
                    index += 2;
                    continue;
                }
                out.push(' ');
                index += 1;
                break;
            }
            out.push(' ');
            index += 1;
        }
    }
    out
}

/// Return a safe single-statement SELECT/WITH query, or a stable error string.
pub fn assert_read_only_sql(raw: Option<&Value>) -> Result<String, String> {
    let Some(Value::String(raw)) = raw else {
        return Err("sql must be a string".into());
    };
    let sql = raw.trim();
    if sql.is_empty() {
        return Err("sql is required".into());
    }
    if sql.chars().count() > 100_000 {
        return Err("sql exceeds 100KB".into());
    }
    let without_trailing = sql.trim_end_matches(';').trim_end();
    let without_trailing = without_trailing.to_string();
    let masked = mask_literals(&without_trailing);
    if masked.contains(';') {
        return Err("only one SQL statement is allowed".into());
    }
    if without_trailing.contains("--") || without_trailing.contains("/*") {
        return Err("SQL comments are not allowed".into());
    }
    let start_re = Regex::new(r"(?i)^(select|with)\b").unwrap();
    if !start_re.is_match(&masked) {
        return Err("only read-only SELECT/WITH queries are allowed".into());
    }
    if let Some(captures) = forbidden_re().captures(&masked) {
        let keyword = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        return Err(format!("SQL contains a forbidden keyword: {keyword}"));
    }
    if read_function_re().is_match(&masked) {
        return Err("file-reading functions are not allowed".into());
    }
    // Underscore-prefixed tables are service internals (dataset/job metadata
    // and usage rollups). Dataset ids cannot start with `_`.
    if internal_table_re().is_match(&masked) {
        return Err("internal warehouse tables are not queryable".into());
    }
    Ok(without_trailing)
}

/// Limit a user query without trusting the caller's LIMIT clause.
pub fn limited_sql(sql: &str, limit: i64) -> String {
    format!(
        "SELECT * FROM ({sql}) AS \"__synapse_q\" LIMIT {}",
        (limit + 1).clamp(1, 10_001)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_read_only_queries_and_literals() {
        assert_eq!(
            assert_read_only_sql(Some(&json!("SELECT 'delete' AS word, 1 AS n"))).unwrap(),
            "SELECT 'delete' AS word, 1 AS n"
        );
        assert_eq!(
            assert_read_only_sql(Some(&json!("WITH x AS (SELECT 1) SELECT * FROM x"))).unwrap(),
            "WITH x AS (SELECT 1) SELECT * FROM x"
        );
        assert_eq!(
            assert_read_only_sql(Some(&json!("SELECT ';' AS s"))).unwrap(),
            "SELECT ';' AS s"
        );
    }

    #[test]
    fn rejects_writes_files_and_internal_tables() {
        for sql in [
            "DROP TABLE city_incidents",
            "DELETE FROM city_incidents",
            "SELECT * FROM read_csv('/etc/passwd')",
            "SELECT 1; DELETE FROM city_incidents",
            "-- comment\nSELECT 1",
            "SELECT * FROM _usage_hourly",
            "SELECT * FROM _datasets",
            "SELECT * FROM query_table('_usage_hourly')",
            "SELECT * FROM query('SELECT * FROM _datasets')",
            "SELECT * FROM sniff_csv('/etc/passwd')",
        ] {
            assert!(assert_read_only_sql(Some(&json!(sql))).is_err(), "{sql}");
        }
    }

    #[test]
    fn slug_and_columns_match_the_contract() {
        assert_eq!(
            slugify_dataset_id(Some(&json!("City Incidents!"))),
            "city_incidents"
        );
        assert_eq!(slugify_dataset_id(Some(&json!("__x__"))), "x");
        let columns = normalize_columns(Some(&json!([
            {"name": "Event_ID", "type": "string"},
            {"name": "value", "type": "number"}
        ])))
        .unwrap();
        assert_eq!(columns[0].name, "event_id");
        assert!(normalize_columns(Some(&json!([]))).is_err());
        assert!(normalize_columns(Some(&json!([{"name": "x", "type": "blob"}]))).is_err());
        assert!(normalize_columns(Some(&json!([
            {"name": "x"},
            {"name": "x"}
        ])))
        .is_err());
    }
}
