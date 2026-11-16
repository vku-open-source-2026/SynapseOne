// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase object <-> data mapping and document validation.
//!
//! A mapping declares logical field names and their dot paths inside the stored
//! JSON document. Writes may send `object` (logical keys) and reads may ask
//! `as=object`; the mapping is also the validation contract.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::MappingError;
use crate::util::{js_string, parse_js_date};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappingField {
    pub path: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub field_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimension: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseMapping {
    #[serde(default)]
    pub additional: bool,
    #[serde(default)]
    pub fields: IndexMap<String, MappingField>,
}

impl Default for BaseMapping {
    fn default() -> Self {
        Self {
            additional: false,
            fields: IndexMap::new(),
        }
    }
}

impl BaseMapping {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({"additional": false, "fields": {}}))
    }

    pub fn from_value(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }
}

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn field_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0] as char;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    bytes[1..].iter().all(|byte| {
        let c = *byte as char;
        c.is_ascii_alphanumeric() || c == '_' || c == '-'
    })
}

fn path_segment_ok(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 64
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '-')
}

fn banned_segment(segment: &str) -> bool {
    matches!(segment, "__proto__" | "prototype" | "constructor")
}

/// Accepts the canonical `{fields:{...}}` form or a shorthand `{name: path}`.
pub fn normalize_mapping(input: Option<&Value>) -> Result<BaseMapping, MappingError> {
    let Some(input) = input else {
        return Ok(BaseMapping::default());
    };
    if input.is_null() {
        return Ok(BaseMapping::default());
    }
    let Some(object) = input.as_object() else {
        return Err(MappingError::new("mapping must be an object"));
    };
    let raw_fields = match object.get("fields") {
        Some(Value::Object(fields)) => fields.clone(),
        _ => object.clone(),
    };
    if raw_fields.len() > 100 {
        return Err(MappingError::new("mapping supports at most 100 fields"));
    }
    let mut fields: IndexMap<String, MappingField> = IndexMap::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    for (name, spec) in &raw_fields {
        if !field_name_ok(name) {
            return Err(MappingError::new(format!(
                "invalid mapping field name '{name}' (want [A-Za-z_][A-Za-z0-9_-]{{0,63}})"
            )));
        }
        let mut field = MappingField {
            path: String::new(),
            field_type: None,
            required: None,
            dimension: None,
            metric: None,
        };
        match spec {
            Value::String(path) => field.path = path.clone(),
            Value::Object(spec) => {
                field.path = match spec.get("path") {
                    Some(value) if js_truthy(value) => js_string(value),
                    _ => String::new(),
                };
                if let Some(type_value) = spec.get("type") {
                    let type_name = js_string(type_value);
                    if !matches!(
                        type_name.as_str(),
                        "string"
                            | "number"
                            | "boolean"
                            | "date"
                            | "array"
                            | "object"
                            | "vector"
                            | "any"
                    ) {
                        return Err(MappingError::new(format!(
                            "invalid type '{type_name}' for mapping field '{name}'"
                        )));
                    }
                    field.field_type = Some(type_name);
                }
                if let Some(dimension) = spec.get("dimension") {
                    let number = crate::util::js_number(dimension);
                    let valid = number
                        .map(|n| n.fract() == 0.0 && (1.0..=4096.0).contains(&n))
                        .unwrap_or(false);
                    if !valid {
                        return Err(MappingError::new(format!(
                            "invalid dimension for mapping field '{name}' (want positive integer <= 4096)"
                        )));
                    }
                    field.dimension = Some(number.unwrap_or(0.0) as i64);
                }
                if let Some(metric) = spec.get("metric") {
                    let metric = js_string(metric).to_lowercase();
                    if !matches!(metric.as_str(), "cosine" | "l2" | "ip") {
                        return Err(MappingError::new(format!(
                            "invalid metric '{}' for mapping field '{name}' (want cosine, l2, or ip)",
                            js_string(metric_value(spec))
                        )));
                    }
                    field.metric = Some(metric);
                }
                if let Some(required) = spec.get("required") {
                    field.required = Some(js_truthy(required));
                }
            }
            _ => {
                return Err(MappingError::new(format!(
                    "mapping field '{name}' must be a path string or {{path,type,required}}"
                )))
            }
        }
        if field.path.is_empty() {
            return Err(MappingError::new(format!(
                "mapping field '{name}' requires a path"
            )));
        }
        let segments: Vec<&str> = field.path.split('.').collect();
        if segments.len() > 16
            || segments
                .iter()
                .any(|segment| !path_segment_ok(segment) || banned_segment(segment))
        {
            return Err(MappingError::new(format!(
                "invalid path '{}' for mapping field '{name}'",
                field.path
            )));
        }
        if seen_paths.contains(&field.path) {
            return Err(MappingError::new(format!(
                "duplicate mapping path '{}'",
                field.path
            )));
        }
        seen_paths.insert(field.path.clone());
        fields.insert(name.clone(), field);
    }
    let additional = object.get("additional").map(js_truthy).unwrap_or(false);
    Ok(BaseMapping { additional, fields })
}

fn metric_value(spec: &Map<String, Value>) -> &Value {
    spec.get("metric").unwrap_or(&Value::Null)
}

pub fn has_mapping(mapping: Option<&BaseMapping>) -> bool {
    mapping.map(|map| !map.fields.is_empty()).unwrap_or(false)
}

fn type_error(field: &str, expected: &str, got: &Value) -> MappingError {
    let actual = match got {
        Value::Null => "null",
        Value::Array(_) => "array",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Object(_) => "object",
    };
    MappingError::new(format!("field '{field}' must be {expected}, got {actual}"))
}

pub fn validate_typed(
    field: &str,
    spec: Option<&MappingField>,
    value: &Value,
) -> Result<(), MappingError> {
    let expected = spec
        .and_then(|item| item.field_type.as_deref())
        .unwrap_or("any");
    if expected == "any" || value.is_null() {
        return Ok(());
    }
    match expected {
        "string" => {
            if !value.is_string() {
                return Err(type_error(field, expected, value));
            }
        }
        "number" => match value.as_f64() {
            Some(number) if number.is_finite() => {}
            _ => return Err(type_error(field, expected, value)),
        },
        "boolean" => {
            if !value.is_boolean() {
                return Err(type_error(field, expected, value));
            }
        }
        "date" => match value.as_str() {
            Some(text) if parse_js_date(text).is_some() => {}
            _ => return Err(type_error(field, expected, value)),
        },
        "array" => {
            if !value.is_array() {
                return Err(type_error(field, expected, value));
            }
        }
        "object" => {
            if !value.is_object() {
                return Err(type_error(field, expected, value));
            }
        }
        "vector" => {
            let Some(items) = value.as_array() else {
                return Err(type_error(field, expected, value));
            };
            if items.is_empty() {
                return Err(MappingError::new(format!(
                    "field '{field}' vector cannot be empty"
                )));
            }
            for item in items {
                match item.as_f64() {
                    Some(number) if number.is_finite() => {}
                    _ => {
                        return Err(MappingError::new(format!(
                            "field '{field}' vector elements must be finite numbers"
                        )))
                    }
                }
            }
            if let Some(dimension) = spec.and_then(|item| item.dimension) {
                if items.len() as i64 != dimension {
                    return Err(MappingError::new(format!(
                        "field '{field}' vector dimension mismatch: expected {dimension}, got {}",
                        items.len()
                    )));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn get_path_opt(data: &Value, path: &str) -> Option<Value> {
    let mut current = data;
    for key in path.split('.') {
        let object = current.as_object()?;
        current = object.get(key)?;
    }
    Some(current.clone())
}

pub fn set_path(target: &mut Value, path: &str, value: Value) {
    let segments: Vec<&str> = path.split('.').collect();
    if segments.is_empty() {
        *target = value;
        return;
    }
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let mut current = target;
    for key in &segments[..segments.len() - 1] {
        let object = current.as_object_mut().expect("object");
        let child = object
            .entry((*key).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !child.is_object() {
            *child = Value::Object(Map::new());
        }
        current = child;
    }
    if let Some(object) = current.as_object_mut() {
        object.insert(segments[segments.len() - 1].to_string(), value);
    }
}

pub fn unset_path(target: &mut Value, path: &str) {
    let segments: Vec<&str> = path.split('.').collect();
    let mut current = target;
    for key in &segments[..segments.len().saturating_sub(1)] {
        let Some(object) = current.as_object_mut() else {
            return;
        };
        let Some(next) = object.get_mut(*key) else {
            return;
        };
        if !next.is_object() {
            return;
        }
        current = next;
    }
    if let Some(object) = current.as_object_mut() {
        if let Some(last) = segments.last() {
            object.remove(*last);
        }
    }
}

/// Deep clone of JSON-compatible data (numbers are already normalised).
pub fn clone_json(value: &Value) -> Value {
    value.clone()
}

/// Deep merge: objects merge recursively; arrays and scalars replace.
pub fn deep_merge(base: &Value, patch: &Value) -> Value {
    let mut out = clone_json(base);
    if !out.is_object() {
        out = Value::Object(Map::new());
    }
    if let Some(patch_object) = patch.as_object() {
        let out_object = out.as_object_mut().expect("object");
        for (key, value) in patch_object {
            if banned_segment(key) {
                continue;
            }
            let existing = out_object.get(key).cloned().unwrap_or(Value::Null);
            if value.is_object() && existing.is_object() {
                out_object.insert(key.clone(), deep_merge(&existing, value));
            } else {
                out_object.insert(key.clone(), clone_json(value));
            }
        }
    }
    out
}

/// Validate a raw stored document (size/depth/prototype-pollution guards).
pub fn validate_document_data(input: &Value, max_bytes: usize) -> Result<Value, MappingError> {
    if !is_plain_object(input) {
        return Err(MappingError::new("data must be a JSON object"));
    }
    let raw = serde_json::to_string(input).unwrap_or_default();
    if raw.len() > max_bytes {
        return Err(MappingError::new(format!(
            "document exceeds {}KB",
            max_bytes / 1024
        )));
    }
    walk_document(input, 0)?;
    Ok(clone_json(input))
}

fn walk_document(value: &Value, depth: usize) -> Result<(), MappingError> {
    if depth > 32 {
        return Err(MappingError::new("document nesting exceeds 32 levels"));
    }
    if let Some(items) = value.as_array() {
        if items.len() > 10_000 {
            return Err(MappingError::new("array exceeds 10000 items"));
        }
        for item in items {
            walk_document(item, depth + 1)?;
        }
        return Ok(());
    }
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            if banned_segment(key) {
                return Err(MappingError::new(format!("reserved object key '{key}'")));
            }
            walk_document(child, depth + 1)?;
        }
    }
    Ok(())
}

/// Convert a logical object (mapped keys) into stored data.
pub fn object_to_data(
    object: &Value,
    mapping: Option<&BaseMapping>,
    partial: bool,
) -> Result<Value, MappingError> {
    let Some(input) = object.as_object() else {
        return Err(MappingError::new("object must be a JSON object"));
    };
    let empty = BaseMapping::default();
    let map = mapping.unwrap_or(&empty);
    if !has_mapping(Some(map)) {
        if !map.additional {
            return Err(MappingError::new(
                "collection has no mapping; send data instead of object",
            ));
        }
        return validate_document_data(object, 256 * 1024);
    }
    if !map.additional {
        for key in input.keys() {
            if !map.fields.contains_key(key) {
                let allowed = Value::Array(
                    map.fields
                        .keys()
                        .map(|name| Value::String(name.clone()))
                        .collect(),
                );
                return Err(MappingError::with_details(
                    format!("unknown mapped field '{key}'"),
                    json!({ "allowed": allowed }),
                ));
            }
        }
    }
    let mut out = Value::Object(Map::new());
    for (name, field) in &map.fields {
        let Some(value) = input.get(name) else {
            if !partial && field.required == Some(true) {
                return Err(MappingError::new(format!(
                    "required field '{name}' is missing"
                )));
            }
            continue;
        };
        // JS keeps null present (typed validation allows null), so required is
        // satisfied by an explicit null.
        validate_typed(name, Some(field), value)?;
        set_path(&mut out, &field.path, clone_json(value));
    }
    if map.additional {
        for (key, value) in input {
            if !map.fields.contains_key(key) {
                set_path(&mut out, key, clone_json(value));
            }
        }
    }
    validate_document_data(&out, 256 * 1024)
}

/// Convert stored data into a logical object (mapped keys only).
pub fn data_to_object(data: &Value, mapping: Option<&BaseMapping>) -> Value {
    let empty = BaseMapping::default();
    let map = mapping.unwrap_or(&empty);
    if !has_mapping(Some(map)) {
        return clone_json(data);
    }
    let mut out = Map::new();
    for (name, field) in &map.fields {
        if let Some(value) = get_path_opt(data, &field.path) {
            out.insert(name.clone(), value);
        }
    }
    Value::Object(out)
}

/// Ensure a raw `data` write satisfies the mapping's required/typed fields.
pub fn validate_data_against_mapping(
    data: &Value,
    mapping: Option<&BaseMapping>,
    partial: bool,
) -> Result<(), MappingError> {
    let Some(map) = mapping else {
        return Ok(());
    };
    if !has_mapping(Some(map)) {
        return Ok(());
    }
    for (name, field) in &map.fields {
        match get_path_opt(data, &field.path) {
            None => {
                if field.required == Some(true) && !partial {
                    return Err(MappingError::new(format!(
                        "required field '{name}' is missing (path '{}')",
                        field.path
                    )));
                }
            }
            Some(value) => validate_typed(name, Some(field), &value)?,
        }
    }
    Ok(())
}

/// Validate a full stored doc after a raw write, without altering extra fields.
pub fn normalize_document_data(
    input: &Value,
    mapping: Option<&BaseMapping>,
    max_bytes: usize,
) -> Result<Value, MappingError> {
    let data = validate_document_data(input, max_bytes)?;
    validate_data_against_mapping(&data, mapping, false)?;
    Ok(data)
}
