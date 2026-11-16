// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase query engine: filter tree, ordering, pagination and projection.
//! Queries are evaluated over collection documents by the service; the response
//! always reports the effective limit/offset and a next cursor.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::error::QueryError;
use crate::mapping::{data_to_object, get_path_opt, BaseMapping};
use crate::store::StoredDocument;
use crate::util::{
    compare_values, encode_base64url_json, js_number, js_string, json_equal, parse_cursor_json,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Nin,
    Contains,
    StartsWith,
    EndsWith,
    Exists,
    Text,
    Near,
    Within,
}

impl QueryOp {
    pub fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "eq" => Self::Eq,
            "ne" => Self::Ne,
            "gt" => Self::Gt,
            "gte" => Self::Gte,
            "lt" => Self::Lt,
            "lte" => Self::Lte,
            "in" => Self::In,
            "nin" => Self::Nin,
            "contains" => Self::Contains,
            "startsWith" => Self::StartsWith,
            "endsWith" => Self::EndsWith,
            "exists" => Self::Exists,
            "text" => Self::Text,
            "near" => Self::Near,
            "within" => Self::Within,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "eq",
            Self::Ne => "ne",
            Self::Gt => "gt",
            Self::Gte => "gte",
            Self::Lt => "lt",
            Self::Lte => "lte",
            Self::In => "in",
            Self::Nin => "nin",
            Self::Contains => "contains",
            Self::StartsWith => "startsWith",
            Self::EndsWith => "endsWith",
            Self::Exists => "exists",
            Self::Text => "text",
            Self::Near => "near",
            Self::Within => "within",
        }
    }
}

#[derive(Debug, Clone)]
pub enum FilterNode {
    And(Vec<FilterNode>),
    Or(Vec<FilterNode>),
    Not(Box<FilterNode>),
    Leaf {
        field: String,
        op: QueryOp,
        value: Option<Value>,
    },
}

impl FilterNode {
    pub fn leaf_value(&self) -> Option<&Value> {
        match self {
            Self::Leaf { value, .. } => value.as_ref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsView {
    Data,
    Object,
}

impl AsView {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "data" => Some(Self::Data),
            "object" => Some(Self::Object),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorMetric {
    Cosine,
    L2,
    Ip,
}

impl VectorMetric {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.to_lowercase().as_str() {
            "cosine" => Some(Self::Cosine),
            "l2" => Some(Self::L2),
            "ip" => Some(Self::Ip),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cosine => "cosine",
            Self::L2 => "l2",
            Self::Ip => "ip",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OrderBy {
    pub field: String,
    pub direction: &'static str,
}

#[derive(Debug, Clone)]
pub struct VectorSearchSpec {
    pub vector: Vec<f64>,
    pub field: Option<String>,
    pub limit: i64,
    pub metric: VectorMetric,
    pub where_: Option<FilterNode>,
    pub select: Option<Vec<String>>,
    pub as_view: AsView,
}

#[derive(Debug, Clone)]
pub struct QuerySpec {
    pub where_: Option<FilterNode>,
    pub order_by: Vec<OrderBy>,
    pub limit: i64,
    pub offset: i64,
    pub select: Option<Vec<String>>,
    pub as_view: AsView,
    pub vector_search: Option<VectorSearchSpec>,
}

fn field_regex() -> &'static Regex {
    static FIELD_RE: OnceLock<Regex> = OnceLock::new();
    FIELD_RE.get_or_init(|| Regex::new(r"^[A-Za-z_$][A-Za-z0-9_$.-]{0,255}$").expect("field regex"))
}

fn banned_segment(segment: &str) -> bool {
    matches!(segment, "__proto__" | "prototype" | "constructor")
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn string_or_default(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => js_string(value),
        _ => String::new(),
    }
}

fn assert_field(field: Option<&Value>) -> Result<String, QueryError> {
    let raw = string_or_default(field);
    if !field_regex().is_match(&raw) || raw.split('.').any(banned_segment) {
        let preview: String = raw.chars().take(100).collect();
        return Err(QueryError::new(format!("invalid field '{preview}'")));
    }
    Ok(raw)
}

fn resolve_field(field: String, mapping: Option<&BaseMapping>) -> String {
    if !field.starts_with('$') {
        if let Some(map) = mapping {
            if let Some(spec) = map.fields.get(&field) {
                return spec.path.clone();
            }
        }
    }
    field
}

fn parse_filter(
    input: &Value,
    depth: usize,
    mapping: Option<&BaseMapping>,
) -> Result<FilterNode, QueryError> {
    if depth > 8 {
        return Err(QueryError::new("filter nesting exceeds 8 levels"));
    }
    if let Some(items) = input.as_array() {
        if items.is_empty() {
            return Err(QueryError::new("filter array cannot be empty"));
        }
        let mut nodes = Vec::with_capacity(items.len());
        for item in items {
            nodes.push(parse_filter(item, depth + 1, mapping)?);
        }
        return Ok(FilterNode::And(nodes));
    }
    let Some(object) = input.as_object() else {
        return Err(QueryError::new("where must be a filter object or array"));
    };

    if let Some(Value::Array(items)) = object.get("and") {
        if items.is_empty() {
            return Err(QueryError::new("and[] cannot be empty"));
        }
        let mut nodes = Vec::with_capacity(items.len());
        for item in items {
            nodes.push(parse_filter(item, depth + 1, mapping)?);
        }
        return Ok(FilterNode::And(nodes));
    }
    if let Some(Value::Array(items)) = object.get("or") {
        if items.is_empty() {
            return Err(QueryError::new("or[] cannot be empty"));
        }
        let mut nodes = Vec::with_capacity(items.len());
        for item in items {
            nodes.push(parse_filter(item, depth + 1, mapping)?);
        }
        return Ok(FilterNode::Or(nodes));
    }
    if let Some(not) = object.get("not") {
        return Ok(FilterNode::Not(Box::new(parse_filter(
            not,
            depth + 1,
            mapping,
        )?)));
    }

    if object.contains_key("field") {
        let field = resolve_field(assert_field(object.get("field"))?, mapping);
        let op_raw = match object.get("op") {
            Some(value) if truthy(value) => js_string(value),
            _ => "eq".to_string(),
        };
        let op = QueryOp::from_str(&op_raw)
            .ok_or_else(|| QueryError::new(format!("unsupported operator '{op_raw}'")))?;
        let value = object.get("value").cloned();
        match op {
            QueryOp::In | QueryOp::Nin => match &value {
                Some(Value::Array(items)) if !items.is_empty() && items.len() <= 1000 => {}
                _ => {
                    return Err(QueryError::new(format!(
                        "{} expects a non-empty array (max 1000)",
                        op.as_str()
                    )))
                }
            },
            QueryOp::Exists => {
                if !matches!(value, Some(Value::Bool(_))) {
                    return Err(QueryError::new("exists expects a boolean"));
                }
            }
            QueryOp::Text => match &value {
                Some(Value::String(text)) if !text.trim().is_empty() => {}
                _ => return Err(QueryError::new("text expects a non-empty string")),
            },
            QueryOp::Near => {
                let Some(value) = value.as_ref().and_then(Value::as_object) else {
                    return Err(QueryError::new("near expects {lat,lng,maxDistanceKm?}"));
                };
                let lat = value.get("lat").and_then(js_number);
                let lng = value.get("lng").and_then(js_number);
                if lat.is_none() || lng.is_none() {
                    return Err(QueryError::new("near expects {lat,lng,maxDistanceKm?}"));
                }
                if let Some(max) = value.get("maxDistanceKm") {
                    match js_number(max) {
                        Some(number) if number >= 0.0 => {}
                        _ => {
                            return Err(QueryError::new(
                                "near.maxDistanceKm must be a non-negative number",
                            ))
                        }
                    }
                }
            }
            QueryOp::Within => {
                let Some(value) = value.as_ref().and_then(Value::as_object) else {
                    return Err(QueryError::new(
                        "within expects {bbox:[minLng,minLat,maxLng,maxLat]} or a GeoJSON Polygon",
                    ));
                };
                let bbox_ok = value
                    .get("bbox")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items.len() == 4 && items.iter().all(|item| js_number(item).is_some())
                    })
                    .unwrap_or(false);
                let poly_ok = value
                    .get("type")
                    .map(|item| js_string(item).to_lowercase() == "polygon")
                    .unwrap_or(false)
                    && value
                        .get("coordinates")
                        .map(Value::is_array)
                        .unwrap_or(false);
                let ring_ok = value.get("ring").map(Value::is_array).unwrap_or(false);
                if !bbox_ok && !poly_ok && !ring_ok {
                    return Err(QueryError::new(
                        "within expects {bbox:[minLng,minLat,maxLng,maxLat]} or a GeoJSON Polygon",
                    ));
                }
                let ring = if value.get("type").map(truthy).unwrap_or(false) {
                    value
                        .get("coordinates")
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(Value::as_array)
                        .cloned()
                } else {
                    value.get("ring").and_then(Value::as_array).cloned()
                };
                if let Some(ring) = ring {
                    if ring.len() > 500 {
                        return Err(QueryError::new(
                            "within polygon supports at most 500 vertices",
                        ));
                    }
                }
            }
            _ => {}
        }
        return Ok(FilterNode::Leaf { field, op, value });
    }

    if object.is_empty() {
        return Err(QueryError::new("where cannot be empty"));
    }
    let mut nodes = Vec::new();
    for (key, value) in object {
        if matches!(key.as_str(), "field" | "op" | "value") {
            return Err(QueryError::new("leaf filters need field/op/value"));
        }
        let field = resolve_field(assert_field(Some(&Value::String(key.clone())))?, mapping);
        if let Some(inner) = value.as_object() {
            if inner.len() == 1 {
                let (op_raw, op_value) = inner.iter().next().expect("one entry");
                if QueryOp::from_str(op_raw).is_some() {
                    let constructed = json!({
                        "field": field,
                        "op": op_raw,
                        "value": op_value,
                    });
                    nodes.push(parse_filter(&constructed, depth + 1, mapping)?);
                    continue;
                }
            }
        }
        nodes.push(FilterNode::Leaf {
            field,
            op: QueryOp::Eq,
            value: Some(value.clone()),
        });
    }
    Ok(if nodes.len() == 1 {
        nodes.remove(0)
    } else {
        FilterNode::And(nodes)
    })
}

fn parse_order_by(
    input: Option<&Value>,
    mapping: Option<&BaseMapping>,
) -> Result<Vec<OrderBy>, QueryError> {
    let Some(input) = input else {
        return Ok(Vec::new());
    };
    if input.is_null() {
        return Ok(Vec::new());
    }
    let raw: Vec<&Value> = match input {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    if raw.len() > 3 {
        return Err(QueryError::new("at most 3 orderBy fields"));
    }
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        if let Value::String(field) = item {
            out.push(OrderBy {
                field: resolve_field(assert_field(Some(&Value::String(field.clone())))?, mapping),
                direction: "asc",
            });
            continue;
        }
        let Some(object) = item.as_object() else {
            return Err(QueryError::new(
                "orderBy entries must be strings or {field,direction}",
            ));
        };
        let direction = match object.get("direction") {
            Some(value) if truthy(value) => js_string(value).to_lowercase(),
            _ => "asc".to_string(),
        };
        if direction != "asc" && direction != "desc" {
            return Err(QueryError::new("orderBy direction must be 'asc' or 'desc'"));
        }
        out.push(OrderBy {
            field: resolve_field(assert_field(object.get("field"))?, mapping),
            direction: if direction == "desc" { "desc" } else { "asc" },
        });
    }
    Ok(out)
}

fn parse_select(
    input: Option<&Value>,
    mapping: Option<&BaseMapping>,
) -> Result<Option<Vec<String>>, QueryError> {
    let Some(input) = input else {
        return Ok(None);
    };
    if input.is_null() {
        return Ok(None);
    }
    let list: Vec<&Value> = match input {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    if list.is_empty() || list.len() > 100 {
        return Err(QueryError::new("select must contain 1..100 paths"));
    }
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        out.push(resolve_field(assert_field(Some(item))?, mapping));
    }
    Ok(Some(out))
}

fn parse_cursor(input: Option<&Value>) -> Result<Option<i64>, QueryError> {
    let Some(input) = input else {
        return Ok(None);
    };
    if input.is_null() {
        return Ok(None);
    }
    let raw = js_string(input);
    if raw.is_empty() {
        return Ok(None);
    }
    let Some(decoded) = parse_cursor_json(&raw) else {
        return Err(QueryError::new("invalid cursor"));
    };
    let offset = decoded.get("offset").and_then(js_number);
    match offset {
        Some(value) if value.fract() == 0.0 && value >= 0.0 => Ok(Some(value as i64)),
        _ => Err(QueryError::new("invalid cursor")),
    }
}

pub fn encode_cursor(offset: i64) -> String {
    encode_base64url_json(&json!({"v": 1, "offset": offset}))
}

fn count_filters(node: &FilterNode) -> usize {
    match node {
        FilterNode::And(items) | FilterNode::Or(items) => items.iter().map(count_filters).sum(),
        FilterNode::Not(inner) => count_filters(inner),
        FilterNode::Leaf { .. } => 1,
    }
}

pub fn parse_query_spec(
    body: &Value,
    mapping: Option<&BaseMapping>,
) -> Result<QuerySpec, QueryError> {
    let empty = Map::new();
    let object = body.as_object().unwrap_or(&empty);
    let where_ = match object.get("where") {
        Some(value) => Some(parse_filter(value, 0, mapping)?),
        None => None,
    };
    if let Some(node) = &where_ {
        let count = count_filters(node);
        if count > 50 {
            return Err(QueryError::new("at most 50 filters per query"));
        }
    }
    let order_by = parse_order_by(object.get("orderBy"), mapping)?;
    let mut limit = match object.get("limit") {
        Some(value) => js_number(value),
        None => Some(100.0),
    }
    .ok_or_else(|| QueryError::new("limit must be an integer 1..1000"))?;
    if limit.fract() != 0.0 || !(1.0..=1000.0).contains(&limit) {
        return Err(QueryError::new("limit must be an integer 1..1000"));
    }
    let cursor_offset = parse_cursor(object.get("cursor"))?;
    let raw_offset = match object.get("offset") {
        Some(value) => js_number(value),
        None => Some(0.0),
    }
    .ok_or_else(|| QueryError::new("offset must be an integer >= 0"))?;
    if raw_offset.fract() != 0.0 || raw_offset < 0.0 || raw_offset > 10_000_000.0 {
        return Err(QueryError::new("offset must be an integer >= 0"));
    }
    if cursor_offset.is_some() && object.contains_key("offset") {
        return Err(QueryError::new("use either cursor or offset, not both"));
    }
    let as_view = match object.get("as") {
        Some(value) => {
            let raw = js_string(value);
            AsView::parse(&raw).ok_or_else(|| QueryError::new("as must be 'data' or 'object'"))?
        }
        None => AsView::Data,
    };
    let mut vector_search = None;
    if let Some(raw_vector) = object.get("vectorSearch") {
        let spec = parse_vector_search_spec(raw_vector, mapping)?;
        if !object.contains_key("limit") {
            if let Some(raw_object) = raw_vector.as_object() {
                if raw_object.contains_key("limit") {
                    limit = spec.limit as f64;
                }
            }
        }
        vector_search = Some(spec);
    }
    Ok(QuerySpec {
        where_,
        order_by,
        limit: limit as i64,
        offset: cursor_offset.unwrap_or(raw_offset as i64),
        select: parse_select(object.get("select"), mapping)?,
        as_view,
        vector_search,
    })
}

pub fn parse_vector_search_spec(
    body: &Value,
    mapping: Option<&BaseMapping>,
) -> Result<VectorSearchSpec, QueryError> {
    let Some(object) = body.as_object() else {
        return Err(QueryError::new("vector search body must be an object"));
    };
    let raw_vector = match object.get("vector") {
        Some(value) if !value.is_null() => value,
        _ => match object.get("embedding") {
            Some(value) if !value.is_null() => value,
            _ => {
                return Err(QueryError::new(
                    "vector must be a non-empty array of numbers",
                ))
            }
        },
    };
    let Some(items) = raw_vector.as_array() else {
        return Err(QueryError::new(
            "vector must be a non-empty array of numbers",
        ));
    };
    if items.is_empty() {
        return Err(QueryError::new(
            "vector must be a non-empty array of numbers",
        ));
    }
    let mut vector = Vec::with_capacity(items.len());
    for item in items {
        match item.as_f64() {
            Some(number) if number.is_finite() => vector.push(number),
            _ => return Err(QueryError::new("vector elements must be finite numbers")),
        }
    }
    let raw_limit = if let Some(value) = object.get("limit") {
        js_number(value)
    } else if let Some(value) = object.get("k") {
        js_number(value)
    } else {
        Some(10.0)
    }
    .ok_or_else(|| QueryError::new("limit must be an integer 1..1000"))?;
    if raw_limit.fract() != 0.0 || !(1.0..=1000.0).contains(&raw_limit) {
        return Err(QueryError::new("limit must be an integer 1..1000"));
    }
    let metric = match object.get("metric") {
        Some(value) => {
            let raw = js_string(value);
            VectorMetric::parse(&raw)
                .ok_or_else(|| QueryError::new("metric must be 'cosine', 'l2' or 'ip'"))?
        }
        None => VectorMetric::Cosine,
    };
    let field = match object.get("field") {
        Some(value) => Some(resolve_field(assert_field(Some(value))?, mapping)),
        None => None,
    };
    let where_raw = match object.get("where") {
        Some(value) => Some(value),
        None => object.get("filter"),
    };
    let where_ = match where_raw {
        Some(value) if !value.is_null() => Some(parse_filter(value, 0, mapping)?),
        _ => None,
    };
    let as_view = if matches!(object.get("as"), Some(Value::String(raw)) if raw == "object") {
        AsView::Object
    } else {
        AsView::Data
    };
    Ok(VectorSearchSpec {
        vector,
        field,
        limit: raw_limit as i64,
        metric,
        where_,
        select: parse_select(object.get("select"), mapping)?,
        as_view,
    })
}

fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    (value + 0.5).floor()
}

pub fn round6(value: f64) -> f64 {
    js_round(value * 1e6) / 1e6
}

pub fn number_value(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

pub fn calculate_vector_distance(a: &[f64], b: &[f64], metric: VectorMetric) -> (f64, f64) {
    let len = a.len().min(b.len());
    if len == 0 {
        return (1.0, 0.0);
    }
    match metric {
        VectorMetric::L2 => {
            let mut sum = 0.0;
            for index in 0..len {
                let delta = a[index] - b[index];
                sum += delta * delta;
            }
            let distance = sum.sqrt();
            (round6(distance), round6(1.0 / (1.0 + distance)))
        }
        VectorMetric::Ip => {
            let mut dot = 0.0;
            for index in 0..len {
                dot += a[index] * b[index];
            }
            (round6(-dot), round6(dot))
        }
        VectorMetric::Cosine => {
            let mut dot = 0.0;
            let mut norm_a = 0.0;
            let mut norm_b = 0.0;
            for index in 0..len {
                dot += a[index] * b[index];
                norm_a += a[index] * a[index];
                norm_b += b[index] * b[index];
            }
            if norm_a <= 0.0 || norm_b <= 0.0 {
                return (1.0, 0.0);
            }
            let cos = dot / (norm_a.sqrt() * norm_b.sqrt());
            let bounded = cos.clamp(-1.0, 1.0);
            (round6(1.0 - bounded), round6(bounded))
        }
    }
}

fn field_value(doc: &StoredDocument, field: &str) -> Option<Value> {
    match field {
        "$id" => Some(Value::String(doc.id.clone())),
        "$version" => Some(json!(doc.version)),
        "$createdAt" => Some(Value::String(doc.created_at.clone())),
        "$updatedAt" => Some(Value::String(doc.updated_at.clone())),
        _ => get_path_opt(&doc.data, field),
    }
}

fn eq_helper(value: Option<&Value>, expected: Option<&Value>) -> bool {
    match (value, expected) {
        (Some(left), Some(right)) => json_equal(left, right),
        (None, None) => true,
        _ => false,
    }
}

fn nullish_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

pub fn js_lower(value: &str) -> String {
    value.to_lowercase()
}

pub fn matches(node: &FilterNode, doc: &StoredDocument) -> bool {
    match node {
        FilterNode::And(items) => items.iter().all(|item| matches(item, doc)),
        FilterNode::Or(items) => items.iter().any(|item| matches(item, doc)),
        FilterNode::Not(inner) => !matches(inner, doc),
        FilterNode::Leaf { field, op, value } => {
            let current = field_value(doc, field);
            match op {
                QueryOp::Exists => {
                    let want = matches!(value, Some(Value::Bool(true)));
                    current.is_some() == want
                }
                QueryOp::Eq => eq_helper(current.as_ref(), value.as_ref()),
                QueryOp::Ne => current.is_some() && !eq_helper(current.as_ref(), value.as_ref()),
                QueryOp::In => match value.as_ref().and_then(Value::as_array) {
                    Some(items) => items
                        .iter()
                        .any(|item| eq_helper(current.as_ref(), Some(item))),
                    None => false,
                },
                QueryOp::Nin => {
                    if current.is_none() {
                        return false;
                    }
                    match value.as_ref().and_then(Value::as_array) {
                        Some(items) => !items
                            .iter()
                            .any(|item| eq_helper(current.as_ref(), Some(item))),
                        None => false,
                    }
                }
                QueryOp::Gt | QueryOp::Gte | QueryOp::Lt | QueryOp::Lte => {
                    let Some(current) = current.as_ref() else {
                        return false;
                    };
                    let Some(expected) = value.as_ref() else {
                        return false;
                    };
                    let Some(ordering) = compare_values(current, expected) else {
                        return false;
                    };
                    match op {
                        QueryOp::Gt => ordering > 0,
                        QueryOp::Gte => ordering >= 0,
                        QueryOp::Lt => ordering < 0,
                        QueryOp::Lte => ordering <= 0,
                        _ => false,
                    }
                }
                QueryOp::Contains => match current.as_ref() {
                    Some(Value::String(text)) => text.contains(&nullish_string(value.as_ref())),
                    Some(Value::Array(items)) => value
                        .as_ref()
                        .map(|expected| items.iter().any(|item| json_equal(item, expected)))
                        .unwrap_or(false),
                    _ => false,
                },
                QueryOp::StartsWith => match current.as_ref() {
                    Some(Value::String(text)) => text.starts_with(&nullish_string(value.as_ref())),
                    _ => false,
                },
                QueryOp::EndsWith => match current.as_ref() {
                    Some(Value::String(text)) => text.ends_with(&nullish_string(value.as_ref())),
                    _ => false,
                },
                QueryOp::Text => {
                    let haystack = if field == "$text" {
                        js_lower(&collect_string_values(&doc.data))
                    } else {
                        match current.as_ref() {
                            Some(Value::String(text)) => js_lower(text),
                            _ => String::new(),
                        }
                    };
                    if haystack.is_empty() {
                        return false;
                    }
                    let query = value.as_ref().and_then(Value::as_str).unwrap_or("");
                    let tokens: Vec<String> = js_lower(query)
                        .split_whitespace()
                        .filter(|token| !token.is_empty())
                        .map(str::to_string)
                        .collect();
                    !tokens.is_empty() && tokens.iter().all(|token| haystack.contains(token))
                }
                QueryOp::Near => {
                    let Some(point) = current.as_ref().and_then(geo_point) else {
                        return false;
                    };
                    let Some(value) = value.as_ref().and_then(Value::as_object) else {
                        return false;
                    };
                    let Some(lat) = value.get("lat").and_then(js_number) else {
                        return false;
                    };
                    let Some(lng) = value.get("lng").and_then(js_number) else {
                        return false;
                    };
                    let max = match value.get("maxDistanceKm") {
                        Some(Value::Null) | None => match value.get("radiusKm") {
                            Some(Value::Null) | None => 1.0,
                            Some(raw) => js_number(raw).unwrap_or(f64::NAN),
                        },
                        Some(raw) => js_number(raw).unwrap_or(f64::NAN),
                    };
                    haversine_km(point, (lat, lng)) <= max
                }
                QueryOp::Within => {
                    let Some(point) = current.as_ref().and_then(geo_point) else {
                        return false;
                    };
                    let Some(value) = value.as_ref().and_then(Value::as_object) else {
                        return false;
                    };
                    if let Some(bbox) = value.get("bbox").and_then(Value::as_array) {
                        if bbox.len() == 4 {
                            let numbers: Vec<f64> = bbox.iter().filter_map(js_number).collect();
                            if numbers.len() == 4 {
                                let (min_lng, min_lat, max_lng, max_lat) =
                                    (numbers[0], numbers[1], numbers[2], numbers[3]);
                                return point.1 >= min_lng
                                    && point.1 <= max_lng
                                    && point.0 >= min_lat
                                    && point.0 <= max_lat;
                            }
                        }
                    }
                    let ring = if value.get("type").map(truthy).unwrap_or(false) {
                        value
                            .get("coordinates")
                            .and_then(Value::as_array)
                            .and_then(|items| items.first())
                            .and_then(Value::as_array)
                            .cloned()
                    } else {
                        value.get("ring").and_then(Value::as_array).cloned()
                    };
                    let Some(ring) = ring else {
                        return false;
                    };
                    if ring.len() < 3 {
                        return false;
                    }
                    let ring: Vec<(f64, f64)> = ring
                        .iter()
                        .map(|item| {
                            let values = item.as_array();
                            let lng = values
                                .and_then(|values| values.first())
                                .and_then(js_number)
                                .unwrap_or(f64::NAN);
                            let lat = values
                                .and_then(|values| values.get(1))
                                .and_then(js_number)
                                .unwrap_or(f64::NAN);
                            (lng, lat)
                        })
                        .collect();
                    point_in_ring(point, &ring)
                }
            }
        }
    }
}

/// Join every string value in a document (keys excluded) for `$text`.
fn collect_string_values(value: &Value) -> String {
    fn collect(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => {
                if !text.is_empty() {
                    out.push(text.clone());
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, out);
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    collect(item, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    collect(value, &mut out);
    out.join(" ")
}

/// Read a geo point from `{lat,lng}`, `{latitude,longitude}` or `[lng,lat]`.
pub fn geo_point(value: &Value) -> Option<(f64, f64)> {
    if let Some(items) = value.as_array() {
        if items.len() >= 2 {
            let lng = js_number(&items[0])?;
            let lat = js_number(&items[1])?;
            if lat.is_finite() && lng.is_finite() {
                return Some((lat, lng));
            }
            return None;
        }
    }
    let object = value.as_object()?;
    let lat = match object.get("lat") {
        Some(Value::Null) | None => object.get("latitude").and_then(js_number),
        Some(raw) => js_number(raw),
    };
    let lng = match object.get("lng") {
        Some(Value::Null) | None => match object.get("lon") {
            Some(Value::Null) | None => object.get("longitude").and_then(js_number),
            Some(raw) => js_number(raw),
        },
        Some(raw) => js_number(raw),
    };
    match (lat, lng) {
        (Some(lat), Some(lng)) if lat.is_finite() && lng.is_finite() => Some((lat, lng)),
        _ => None,
    }
}

/// Great-circle distance in kilometres.
pub fn haversine_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    const R: f64 = 6371.0088;
    let to_rad = |degrees: f64| degrees * std::f64::consts::PI / 180.0;
    let delta_lat = to_rad(b.0 - a.0);
    let delta_lng = to_rad(b.1 - a.1);
    let s = (delta_lat / 2.0).sin().powi(2)
        + to_rad(a.0).cos() * to_rad(b.0).cos() * (delta_lng / 2.0).sin().powi(2);
    2.0 * R * s.sqrt().min(1.0).asin()
}

/// Ray-casting point-in-polygon. Ring points are GeoJSON `[lng,lat]`.
pub fn point_in_ring(point: (f64, f64), ring: &[(f64, f64)]) -> bool {
    let mut inside = false;
    if ring.is_empty() {
        return false;
    }
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (xi, yi) = ring[i];
        let (xj, yj) = ring[j];
        if [xi, yi, xj, yj].iter().all(|value| value.is_finite()) {
            let intersect = (yi > point.0) != (yj > point.0)
                && point.1 < (xj - xi) * (point.0 - yi) / (yj - yi) + xi;
            if intersect {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

pub fn project_document_data(data: &Value, select: Option<&Vec<String>>) -> Value {
    let Some(select) = select else {
        return data.clone();
    };
    let mut out = Value::Object(Map::new());
    for path in select {
        if let Some(value) = get_path_opt(data, path) {
            set_projected(&mut out, path, value);
        }
    }
    out
}

fn set_projected(target: &mut Value, path: &str, value: Value) {
    let segments: Vec<&str> = path.split('.').collect();
    let mut current = target;
    for key in &segments[..segments.len().saturating_sub(1)] {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
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
        if let Some(last) = segments.last() {
            object.insert((*last).to_string(), value);
        }
    }
}

fn item_for_document(
    doc: &StoredDocument,
    spec: &QuerySpec,
    mapping: Option<&BaseMapping>,
) -> Value {
    let data = project_document_data(&doc.data, spec.select.as_ref());
    let mut item = Map::new();
    item.insert("id".into(), Value::String(doc.id.clone()));
    item.insert("version".into(), json!(doc.version));
    item.insert("createdAt".into(), Value::String(doc.created_at.clone()));
    item.insert("updatedAt".into(), Value::String(doc.updated_at.clone()));
    if spec.as_view == AsView::Object {
        item.insert("object".into(), data_to_object(&data, mapping));
    } else {
        item.insert("data".into(), data);
    }
    Value::Object(item)
}

pub fn format_query_page(
    page: &[StoredDocument],
    spec: &QuerySpec,
    mapping: Option<&BaseMapping>,
    total: usize,
) -> Value {
    let items: Vec<Value> = page
        .iter()
        .map(|doc| item_for_document(doc, spec, mapping))
        .collect();
    let next_offset = spec.offset + page.len() as i64;
    let next_cursor = if next_offset < total as i64 {
        Value::String(encode_cursor(next_offset))
    } else {
        Value::Null
    };
    json!({
        "items": items,
        "total": total,
        "limit": spec.limit,
        "offset": spec.offset,
        "nextCursor": next_cursor,
    })
}

pub fn apply_query(
    docs: &[StoredDocument],
    spec: &QuerySpec,
    mapping: Option<&BaseMapping>,
) -> Value {
    if let Some(vector) = &spec.vector_search {
        let effective_limit = vector.limit;
        let effective = VectorSearchSpec {
            vector: vector.vector.clone(),
            field: vector.field.clone(),
            limit: effective_limit,
            metric: vector.metric,
            where_: spec.where_.clone().or_else(|| vector.where_.clone()),
            select: vector.select.clone(),
            as_view: spec.as_view,
        };
        let result = apply_vector_search(docs, &effective, mapping);
        let items = result.get("items").cloned().unwrap_or_else(|| json!([]));
        return json!({
            "items": items,
            "total": result.get("total").cloned().unwrap_or_else(|| json!(0)),
            "limit": effective_limit,
            "offset": spec.offset,
            "nextCursor": Value::Null,
        });
    }
    let mut filtered: Vec<&StoredDocument> = docs
        .iter()
        .filter(|doc| match &spec.where_ {
            Some(node) => matches(node, doc),
            None => true,
        })
        .collect();
    if !spec.order_by.is_empty() {
        filtered.sort_by(|left, right| {
            for order in &spec.order_by {
                let left_value = field_value(left, &order.field);
                let right_value = field_value(right, &order.field);
                let comparison = match (left_value.as_ref(), right_value.as_ref()) {
                    (Some(left_value), Some(right_value)) => {
                        compare_values(left_value, right_value)
                    }
                    _ => None,
                };
                match comparison {
                    Some(value) if value != 0 => {
                        return if order.direction == "asc" {
                            value.cmp(&0)
                        } else {
                            0.cmp(&value)
                        };
                    }
                    Some(_) => {}
                    None => {
                        if left_value.is_none() && right_value.is_none() {
                            continue;
                        }
                        if left_value.is_none() {
                            return std::cmp::Ordering::Greater;
                        }
                        if right_value.is_none() {
                            return std::cmp::Ordering::Less;
                        }
                    }
                }
            }
            left.id.cmp(&right.id)
        });
    } else {
        filtered.sort_by(|left, right| left.id.cmp(&right.id));
    }
    let total = filtered.len();
    let start = (spec.offset.max(0) as usize).min(total);
    let end = (start + spec.limit.max(0) as usize).min(total);
    let page: Vec<StoredDocument> = filtered[start..end]
        .iter()
        .map(|doc| (*doc).clone())
        .collect();
    format_query_page(&page, spec, mapping, total)
}

fn vector_values(doc: &StoredDocument, target: Option<&str>) -> Option<Vec<f64>> {
    let raw = if let Some(target) = target {
        get_path_opt(&doc.data, target)?
    } else {
        let candidate = get_path_opt(&doc.data, "embedding")
            .filter(|value| !value.is_null())
            .or_else(|| get_path_opt(&doc.data, "vector").filter(|value| !value.is_null()))
            .or_else(|| get_path_opt(&doc.data, "vec").filter(|value| !value.is_null()));
        match candidate {
            Some(Value::Array(items)) => Value::Array(items),
            _ => {
                let object = doc.data.as_object()?;
                let mut found = Value::Null;
                for value in object.values() {
                    if let Some(items) = value.as_array() {
                        if !items.is_empty() && items[0].is_number() {
                            found = value.clone();
                            break;
                        }
                    }
                }
                if found.is_null() {
                    return None;
                }
                found
            }
        }
    };
    let items = raw.as_array()?;
    if items.is_empty() || !items[0].is_number() {
        return None;
    }
    Some(items.iter().filter_map(|item| item.as_f64()).collect())
}

pub fn apply_vector_search(
    docs: &[StoredDocument],
    spec: &VectorSearchSpec,
    mapping: Option<&BaseMapping>,
) -> Value {
    let filtered: Vec<&StoredDocument> = docs
        .iter()
        .filter(|doc| match &spec.where_ {
            Some(node) => matches(node, doc),
            None => true,
        })
        .collect();

    let mut target = spec.field.clone();
    if target.is_none() {
        if let Some(map) = mapping {
            for field in map.fields.values() {
                if field.field_type.as_deref() == Some("vector") {
                    target = Some(field.path.clone());
                    break;
                }
            }
        }
    }
    // The TypeScript engine reports `spec.metric || defaultMetric`, and
    // parseVectorSearchSpec always supplies a metric, so the mapping metric is
    // informational. Keep that behaviour.
    let effective_metric = spec.metric;

    let mut scored: Vec<(&StoredDocument, f64, f64)> = Vec::new();
    for doc in filtered {
        let Some(vector) = vector_values(doc, target.as_deref()) else {
            continue;
        };
        let (distance, similarity) =
            calculate_vector_distance(&spec.vector, &vector, effective_metric);
        scored.push((doc, similarity, distance));
    }
    scored.sort_by(|left, right| {
        if effective_metric == VectorMetric::L2 {
            if left.2 != right.2 {
                return left
                    .2
                    .partial_cmp(&right.2)
                    .unwrap_or(std::cmp::Ordering::Equal);
            }
        } else if left.1 != right.1 {
            return right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal);
        }
        left.0.id.cmp(&right.0.id)
    });
    let total = scored.len();
    let limit = spec.limit.max(0) as usize;
    let items: Vec<Value> = scored
        .iter()
        .take(limit)
        .map(|(doc, similarity, distance)| {
            let data = project_document_data(&doc.data, spec.select.as_ref());
            let mut item = Map::new();
            item.insert("id".into(), Value::String(doc.id.clone()));
            item.insert("similarity".into(), number_value(*similarity));
            item.insert("distance".into(), number_value(*distance));
            item.insert("version".into(), json!(doc.version));
            item.insert("createdAt".into(), Value::String(doc.created_at.clone()));
            item.insert("updatedAt".into(), Value::String(doc.updated_at.clone()));
            if spec.as_view == AsView::Object {
                item.insert("object".into(), data_to_object(&data, mapping));
            } else {
                item.insert("data".into(), data);
            }
            Value::Object(item)
        })
        .collect();
    json!({
        "items": items,
        "total": total,
        "limit": spec.limit,
        "metric": effective_metric.as_str(),
    })
}
