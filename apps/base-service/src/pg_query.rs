// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase Postgres query compiler (#29).
//!
//! Filter trees, ordering and pagination compile to parameterised SQL so the
//! database does the filtering instead of the API process scanning a
//! collection. Every value is a bind parameter; only whitelisted identifiers
//! (metadata column names, asc/desc) are ever interpolated.

use serde_json::{Map, Value};

use crate::query::{FilterNode, QueryOp, QuerySpec};
use crate::util::{js_number, js_string};

#[derive(Debug, Clone)]
pub enum SqlParam {
    Text(String),
    Json(Value),
    I64(i64),
    F64(f64),
    Bool(bool),
}

const NUMERIC_PATTERN: &str = r"^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$";

fn meta_column(field: &str) -> Option<&'static str> {
    match field {
        "$id" => Some("id"),
        "$version" => Some("version"),
        "$createdAt" => Some("created_at"),
        "$updatedAt" => Some("updated_at"),
        _ => None,
    }
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

struct Builder {
    params: Vec<SqlParam>,
}

impl Builder {
    fn new() -> Self {
        Self { params: Vec::new() }
    }

    fn param(&mut self, value: SqlParam) -> String {
        self.params.push(value);
        format!("${}", self.params.len())
    }

    fn text_param(&mut self, value: impl Into<String>) -> String {
        self.param(SqlParam::Text(value.into()))
    }

    fn jsonb_expr(&mut self, field: &str) -> String {
        if let Some(column) = meta_column(field) {
            return format!("to_jsonb({})", ident(column));
        }
        let args: Vec<String> = field
            .split('.')
            .map(|segment| self.text_param(segment))
            .collect();
        format!("jsonb_extract_path(data, {})", args.join(", "))
    }

    fn text_expr(&mut self, field: &str) -> String {
        if let Some(column) = meta_column(field) {
            return format!("{}::text", ident(column));
        }
        let args: Vec<String> = field
            .split('.')
            .map(|segment| self.text_param(segment))
            .collect();
        format!("jsonb_extract_path_text(data, {})", args.join(", "))
    }

    fn numeric_expr(&mut self, text_expr: &str) -> String {
        let pattern = self.text_param(NUMERIC_PATTERN);
        format!("(CASE WHEN {text_expr} ~ {pattern} THEN ({text_expr})::float8 END)")
    }

    fn lat_expr(&mut self, field: &str) -> String {
        let segments: Vec<String> = field.split('.').map(str::to_string).collect();
        let base = |builder: &mut Builder, extra: &[&str]| {
            let mut args: Vec<String> = segments
                .iter()
                .map(|segment| builder.text_param(segment.clone()))
                .collect();
            for item in extra {
                args.push(builder.text_param(*item));
            }
            format!("jsonb_extract_path_text(data, {})", args.join(", "))
        };
        let lat_path = base(self, &["lat"]);
        let lat = self.numeric_expr(&lat_path);
        let latitude_path = base(self, &["latitude"]);
        let latitude = self.numeric_expr(&latitude_path);
        let array_path = base(self, &["1"]);
        let array_lat = self.numeric_expr(&array_path);
        let path_args: Vec<String> = segments
            .iter()
            .map(|segment| self.text_param(segment.clone()))
            .collect();
        format!(
            "(CASE WHEN jsonb_typeof(jsonb_extract_path(data, {})) = 'array' THEN {array_lat} ELSE coalesce({lat}, {latitude}) END)",
            path_args.join(", ")
        )
    }

    fn lng_expr(&mut self, field: &str) -> String {
        let segments: Vec<String> = field.split('.').map(str::to_string).collect();
        let base = |builder: &mut Builder, extra: &[&str]| {
            let mut args: Vec<String> = segments
                .iter()
                .map(|segment| builder.text_param(segment.clone()))
                .collect();
            for item in extra {
                args.push(builder.text_param(*item));
            }
            format!("jsonb_extract_path_text(data, {})", args.join(", "))
        };
        let lng_path = base(self, &["lng"]);
        let lng = self.numeric_expr(&lng_path);
        let lon_path = base(self, &["lon"]);
        let lon = self.numeric_expr(&lon_path);
        let longitude_path = base(self, &["longitude"]);
        let longitude = self.numeric_expr(&longitude_path);
        let array_path = base(self, &["0"]);
        let array_lng = self.numeric_expr(&array_path);
        let path_args: Vec<String> = segments
            .iter()
            .map(|segment| self.text_param(segment.clone()))
            .collect();
        format!(
            "(CASE WHEN jsonb_typeof(jsonb_extract_path(data, {})) = 'array' THEN {array_lng} ELSE coalesce({lng}, {lon}, {longitude}) END)",
            path_args.join(", ")
        )
    }

    fn json_param(&mut self, value: Value) -> String {
        self.param(SqlParam::Json(value))
    }

    fn containment(&mut self, field: &str, value: &Value) -> Option<String> {
        if meta_column(field).is_some() {
            return None;
        }
        let segments: Vec<&str> = field.split('.').collect();
        if segments
            .iter()
            .any(|segment| segment.chars().all(|c| c.is_ascii_digit()))
        {
            return None;
        }
        let mut nested = value.clone();
        for segment in segments.iter().rev() {
            let mut object = Map::new();
            object.insert((*segment).to_string(), nested);
            nested = Value::Object(object);
        }
        Some(self.json_param(nested))
    }

    fn condition(&mut self, node: &FilterNode) -> String {
        match node {
            FilterNode::And(items) => {
                let parts: Vec<String> = items.iter().map(|item| self.condition(item)).collect();
                format!("({})", parts.join(" AND "))
            }
            FilterNode::Or(items) => {
                let parts: Vec<String> = items.iter().map(|item| self.condition(item)).collect();
                format!("({})", parts.join(" OR "))
            }
            FilterNode::Not(inner) => format!("(NOT {})", self.condition(inner)),
            FilterNode::Leaf { field, op, value } => {
                self.leaf_condition(field, *op, value.as_ref())
            }
        }
    }

    fn leaf_condition(&mut self, field: &str, op: QueryOp, value: Option<&Value>) -> String {
        let raw_value = value.cloned().unwrap_or(Value::Null);
        if op == QueryOp::Text {
            let tsquery = self.text_param(js_string(&raw_value));
            if field == "$text" {
                return format!(
                    "to_tsvector('simple', synapseone_base_doc_text(data)) @@ plainto_tsquery('simple', {tsquery})"
                );
            }
            let text = self.text_expr(field);
            return format!(
                "to_tsvector('simple', coalesce({text}, '')) @@ plainto_tsquery('simple', {tsquery})"
            );
        }
        if op == QueryOp::Exists {
            let want = matches!(value, Some(Value::Bool(true)));
            if meta_column(field).is_some() {
                return if want { "TRUE" } else { "FALSE" }.to_string();
            }
            let jsonb = self.jsonb_expr(field);
            let param = self.param(SqlParam::Bool(want));
            return format!("({jsonb} IS NOT NULL) = {param}");
        }
        if op == QueryOp::Eq {
            if let Some(column) = meta_column(field) {
                if column == "version" {
                    let number = js_number(&raw_value).unwrap_or(f64::NAN) as i64;
                    return format!(
                        "{} = {}::int",
                        ident("version"),
                        self.param(SqlParam::I64(number))
                    );
                }
                if column == "created_at" || column == "updated_at" {
                    return format!(
                        "{} = {}::timestamptz",
                        ident(column),
                        self.text_param(js_string(&raw_value))
                    );
                }
                return format!(
                    "{} = {}",
                    ident("id"),
                    self.text_param(js_string(&raw_value))
                );
            }
            if let Some(containment) = self.containment(field, &raw_value) {
                return format!("data @> {containment}::jsonb");
            }
            let jsonb = self.jsonb_expr(field);
            let param = self.json_param(raw_value.clone());
            return format!("{jsonb} = {param}::jsonb");
        }
        if op == QueryOp::Ne {
            if meta_column(field).is_some() {
                let jsonb = self.jsonb_expr(field);
                let equality = self.leaf_condition(field, QueryOp::Eq, value);
                return format!("{jsonb} IS NOT NULL AND NOT ({equality})");
            }
            let jsonb = self.jsonb_expr(field);
            let not_equal = match self.containment(field, &raw_value) {
                Some(containment) => format!("data @> {containment}::jsonb"),
                None => {
                    let param = self.json_param(raw_value.clone());
                    format!("{jsonb} = {param}::jsonb")
                }
            };
            return format!("{jsonb} IS NOT NULL AND NOT ({not_equal})");
        }
        if op == QueryOp::In || op == QueryOp::Nin {
            let items = value.and_then(Value::as_array).cloned().unwrap_or_default();
            let any_match = if items.is_empty() {
                "FALSE".to_string()
            } else {
                let parts: Vec<String> = items
                    .iter()
                    .map(|item| self.leaf_condition(field, QueryOp::Eq, Some(item)))
                    .collect();
                format!("({})", parts.join(" OR "))
            };
            if op == QueryOp::In {
                return any_match;
            }
            let jsonb = self.jsonb_expr(field);
            return format!("{jsonb} IS NOT NULL AND NOT {any_match}");
        }
        if matches!(op, QueryOp::Gt | QueryOp::Gte | QueryOp::Lt | QueryOp::Lte) {
            let sql_op = match op {
                QueryOp::Gt => ">",
                QueryOp::Gte => ">=",
                QueryOp::Lt => "<",
                _ => "<=",
            };
            let jsonb = self.jsonb_expr(field);
            if raw_value.is_number() {
                let text = self.text_expr(field);
                let numeric = self.numeric_expr(&text);
                let param = self.param(SqlParam::F64(js_number(&raw_value).unwrap_or(f64::NAN)));
                return format!(
                    "jsonb_typeof({jsonb}) = 'number' AND {numeric} {sql_op} {param}::float8"
                );
            }
            if raw_value.is_boolean() {
                let text = self.text_expr(field);
                let param = self.param(SqlParam::Bool(raw_value.as_bool().unwrap_or(false)));
                return format!(
                    "jsonb_typeof({jsonb}) = 'boolean' AND ({text})::boolean {sql_op} {param}::boolean"
                );
            }
            let text = self.text_expr(field);
            let param = self.text_param(js_string(&raw_value));
            return format!(
                "jsonb_typeof({jsonb}) = 'string' AND {text} COLLATE \"C\" {sql_op} {param}"
            );
        }
        if op == QueryOp::Contains {
            let jsonb = self.jsonb_expr(field);
            let text = self.text_expr(field);
            let string_param = self.text_param(match value {
                None | Some(Value::Null) => String::new(),
                Some(value) => js_string(value),
            });
            let element_param = self.json_param(raw_value.clone());
            return format!(
                "(jsonb_typeof({jsonb}) = 'string' AND strpos({text}, {string_param}) > 0)
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof({jsonb}) = 'array' THEN {jsonb} ELSE '[]'::jsonb END
          ) e WHERE e = {element_param}::jsonb
        )"
            );
        }
        if op == QueryOp::StartsWith || op == QueryOp::EndsWith {
            let text = self.text_expr(field);
            let value_param = self.text_param(match value {
                None | Some(Value::Null) => String::new(),
                Some(value) => js_string(value),
            });
            return if op == QueryOp::StartsWith {
                format!("left({text}, length({value_param})) = {value_param}")
            } else {
                format!("right({text}, length({value_param})) = {value_param}")
            };
        }
        if op == QueryOp::Near {
            let object = value
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let lat = self.lat_expr(field);
            let lng = self.lng_expr(field);
            let q_lat = self.param(SqlParam::F64(
                object.get("lat").and_then(js_number).unwrap_or(f64::NAN),
            ));
            let q_lng = self.param(SqlParam::F64(
                object.get("lng").and_then(js_number).unwrap_or(f64::NAN),
            ));
            let max_km = match object.get("maxDistanceKm") {
                Some(Value::Null) | None => match object.get("radiusKm") {
                    Some(Value::Null) | None => 1.0,
                    Some(raw) => js_number(raw).unwrap_or(f64::NAN),
                },
                Some(raw) => js_number(raw).unwrap_or(f64::NAN),
            };
            let max_km = self.param(SqlParam::F64(max_km));
            let d_lat = format!("radians({lat} - {q_lat})");
            let d_lng = format!("radians({lng} - {q_lng})");
            let haversine = format!(
                "(6371.0088 * 2 * asin(least(1, sqrt(
        power(sin({d_lat} / 2), 2)
        + cos(radians({q_lat})) * cos(radians({lat})) * power(sin({d_lng} / 2), 2)
      ))))"
            );
            return format!("{lat} IS NOT NULL AND {lng} IS NOT NULL AND {haversine} <= {max_km}");
        }
        if op == QueryOp::Within {
            let object = value
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let lat = self.lat_expr(field);
            let lng = self.lng_expr(field);
            if let Some(bbox) = object.get("bbox").and_then(Value::as_array) {
                if bbox.len() == 4 {
                    let numbers: Vec<f64> = bbox.iter().filter_map(js_number).collect();
                    if numbers.len() == 4 {
                        let (min_lng, min_lat, max_lng, max_lat) =
                            (numbers[0], numbers[1], numbers[2], numbers[3]);
                        let min_lat_param = self.param(SqlParam::F64(min_lat));
                        let max_lat_param = self.param(SqlParam::F64(max_lat));
                        let min_lng_param = self.param(SqlParam::F64(min_lng));
                        let max_lng_param = self.param(SqlParam::F64(max_lng));
                        return format!(
                            "{lat} IS NOT NULL AND {lng} IS NOT NULL
          AND {lat} BETWEEN {min_lat_param} AND {max_lat_param}
          AND {lng} BETWEEN {min_lng_param} AND {max_lng_param}"
                        );
                    }
                }
            }
            let ring = if object
                .get("type")
                .map(|item| matches!(item, Value::String(text) if !text.is_empty()))
                .unwrap_or(false)
            {
                object
                    .get("coordinates")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(Value::as_array)
                    .cloned()
            } else {
                object.get("ring").and_then(Value::as_array).cloned()
            };
            let Some(ring) = ring else {
                return "FALSE".to_string();
            };
            if ring.len() < 3 {
                return "FALSE".to_string();
            }
            let mut crossings = Vec::with_capacity(ring.len());
            for index in 0..ring.len() {
                let previous = (index + ring.len() - 1) % ring.len();
                let point = ring[index].as_array();
                let previous_point = ring[previous].as_array();
                let number_at = |values: Option<&Vec<Value>>, at: usize| {
                    values
                        .and_then(|items| items.get(at))
                        .and_then(js_number)
                        .unwrap_or(f64::NAN)
                };
                let xi = self.param(SqlParam::F64(number_at(point, 0)));
                let yi = self.param(SqlParam::F64(number_at(point, 1)));
                let xj = self.param(SqlParam::F64(number_at(previous_point, 0)));
                let yj = self.param(SqlParam::F64(number_at(previous_point, 1)));
                crossings.push(format!(
                    "(CASE WHEN ({yi} > {lat}) <> ({yj} > {lat})
          AND {lng} < ({xj} - {xi}) * ({lat} - {yi}) / NULLIF(({yj} - {yi}), 0) + {xi}
          THEN 1 ELSE 0 END)"
                ));
            }
            return format!(
                "{lat} IS NOT NULL AND {lng} IS NOT NULL AND (({}) % 2) = 1",
                crossings.join(" + ")
            );
        }
        "FALSE".to_string()
    }
}

pub struct CompiledQuery {
    pub where_sql: String,
    pub where_params: Vec<SqlParam>,
    pub order_sql: String,
    pub all_params: Vec<SqlParam>,
}

fn order_expression(builder: &mut Builder, field: &str) -> String {
    match meta_column(field) {
        Some(column) => ident(column),
        None => builder.jsonb_expr(field),
    }
}

/// Compile a parsed QuerySpec into a WHERE clause and ORDER BY list.
pub fn compile_query(collection_id: &str, spec: &QuerySpec) -> CompiledQuery {
    let mut builder = Builder::new();
    let mut conditions = vec![format!(
        "collection_id = {}",
        builder.text_param(collection_id)
    )];
    if let Some(where_) = &spec.where_ {
        conditions.push(builder.condition(where_));
    }
    let where_params = builder.params.clone();
    let mut order: Vec<String> = spec
        .order_by
        .iter()
        .map(|item| {
            let expression = order_expression(&mut builder, &item.field);
            let direction = if item.direction == "desc" {
                "DESC"
            } else {
                "ASC"
            };
            format!("{expression} {direction} NULLS LAST")
        })
        .collect();
    order.push(format!("{} ASC", ident("id")));
    CompiledQuery {
        where_sql: conditions.join(" AND "),
        where_params,
        order_sql: order.join(", "),
        all_params: builder.params.clone(),
    }
}
