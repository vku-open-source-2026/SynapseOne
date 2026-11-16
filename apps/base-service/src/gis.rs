// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase GIS — GeoJSON features stored as PostGIS geometry(4326) with an
//! in-memory fallback. Bounding-box, radius (metres) and polygon queries run
//! inside Postgres with a GiST index; property payloads stay in JSONB.

use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::query::{geo_point, haversine_km, point_in_ring};
use crate::store::{GeoFeatureRecord, Store};
use crate::util::{js_number, js_string, now_iso};

const ALLOWED_GEOMETRY: [&str; 7] = [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
];

async fn ensure_geo_tables(store: &Store) -> Result<(), String> {
    if !store.uses_postgres() {
        return Ok(());
    }
    let Some(pool) = store.pool() else {
        return Ok(());
    };
    store
        .geo_ready
        .get_or_try_init(|| async {
            sqlx::raw_sql("CREATE EXTENSION IF NOT EXISTS postgis")
                .execute(pool)
                .await
                .map_err(|error| error.to_string())?;
            let statements = [
                r#"CREATE TABLE IF NOT EXISTS synapseone_base_geo_features (
                     collection_id text NOT NULL REFERENCES synapseone_base_collections(id) ON DELETE CASCADE,
                     id text NOT NULL,
                     properties jsonb NOT NULL DEFAULT '{}'::jsonb,
                     geom geometry(Geometry, 4326) NOT NULL,
                     created_at timestamptz NOT NULL DEFAULT now(),
                     updated_at timestamptz NOT NULL DEFAULT now(),
                     PRIMARY KEY (collection_id, id)
                   )"#,
                "CREATE INDEX IF NOT EXISTS idx_base_geo_features_geom ON synapseone_base_geo_features USING GIST (geom)",
                "CREATE INDEX IF NOT EXISTS idx_base_geo_features_collection ON synapseone_base_geo_features(collection_id)",
            ];
            for statement in statements {
                sqlx::raw_sql(statement)
                    .execute(pool)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        })
        .await
        .map(|_| ())
}

fn clean_id(value: Option<&Value>) -> Option<String> {
    let id = match value {
        Some(Value::Null) | None => String::new(),
        Some(value) => js_string(value).trim().to_string(),
    };
    crate::graph::clean_id(Some(&Value::String(id)))
}

fn as_object(value: Option<&Value>) -> Value {
    match value {
        Some(value) if value.is_object() => value.clone(),
        _ => Value::Object(Map::new()),
    }
}

fn feature_rows(feature: &Value) -> Option<(String, Value, Value)> {
    let item = feature.as_object()?;
    let geometry = as_object(item.get("geometry"));
    let geometry_object = geometry.as_object()?;
    let geometry_type = geometry_object
        .get("type")
        .map(js_string)
        .unwrap_or_default();
    if !ALLOWED_GEOMETRY.contains(&geometry_type.as_str()) {
        return None;
    }
    let properties = as_object(item.get("properties"));
    let id_value = item
        .get("id")
        .filter(|value| !value.is_null())
        .or_else(|| properties.get("id").filter(|value| !value.is_null()))
        .or_else(|| {
            properties
                .get("feature_id")
                .filter(|value| !value.is_null())
        });
    let id = clean_id(id_value)?;
    let mut normalized = Map::new();
    normalized.insert("type".into(), Value::String(geometry_type));
    if let Some(coordinates) = geometry_object.get("coordinates") {
        normalized.insert("coordinates".into(), coordinates.clone());
    }
    if let Some(geometries) = geometry_object.get("geometries") {
        normalized.insert("geometries".into(), geometries.clone());
    }
    Some((id, properties, Value::Object(normalized)))
}

fn feature_from_row(row: &sqlx::postgres::PgRow) -> Value {
    let geometry: Value = row
        .try_get("geometry")
        .unwrap_or_else(|_| Value::Object(Map::new()));
    json!({
        "type": "Feature",
        "id": row.try_get::<String, _>("id").unwrap_or_default(),
        "properties": row
            .try_get::<Value, _>("properties")
            .unwrap_or_else(|_| Value::Object(Map::new())),
        "geometry": geometry,
    })
}

fn memory_feature(record: &GeoFeatureRecord) -> Value {
    json!({
        "type": "Feature",
        "id": record.id,
        "properties": record.properties,
        "geometry": record.geometry,
    })
}

pub async fn upsert_features(
    store: &Store,
    collection_id: &str,
    input: &Value,
) -> Result<Vec<Value>, String> {
    ensure_geo_tables(store).await?;
    let Some(items) = input.as_array() else {
        return Ok(Vec::new());
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if items.len() > 1000 {
        return Err("at most 1000 features per request".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for raw in items {
        let Some((id, properties, geometry)) = feature_rows(raw) else {
            return Err("each feature needs an id and a GeoJSON geometry".into());
        };
        let geometry_text = serde_json::to_string(&geometry).unwrap_or_default();
        if let Some(pool) = store.pool() {
            let row = sqlx::query(
                r#"INSERT INTO synapseone_base_geo_features (collection_id, id, properties, geom)
                   VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
                   ON CONFLICT (collection_id, id) DO UPDATE
                     SET properties = EXCLUDED.properties, geom = EXCLUDED.geom, updated_at = now()
                   RETURNING id, properties, ST_AsGeoJSON(geom)::json AS geometry"#,
            )
            .bind(collection_id)
            .bind(&id)
            .bind(&properties)
            .bind(geometry_text)
            .fetch_one(pool)
            .await
            .map_err(|error| error.to_string())?;
            out.push(feature_from_row(&row));
        } else {
            let mut memory = store.memory().await.expect("memory store");
            let key = (collection_id.to_string(), id.clone());
            let now = now_iso();
            let record = match memory.geo_features.get(&key).cloned() {
                Some(existing) => GeoFeatureRecord {
                    collection_id: collection_id.to_string(),
                    id: existing.id,
                    properties,
                    geometry,
                    created_at: existing.created_at,
                    updated_at: now,
                },
                None => GeoFeatureRecord {
                    collection_id: collection_id.to_string(),
                    id,
                    properties,
                    geometry,
                    created_at: now.clone(),
                    updated_at: now,
                },
            };
            memory.geo_features.insert(key, record.clone());
            out.push(memory_feature(&record));
        }
    }
    Ok(out)
}

fn bbox_param(raw: Option<&str>) -> Option<(f64, f64, f64, f64)> {
    let raw = raw?;
    let parts: Vec<Option<f64>> = raw.split(',').map(js_number_string).collect();
    if parts.len() != 4 {
        return None;
    }
    let mut numbers = Vec::with_capacity(4);
    for part in parts {
        numbers.push(part?);
    }
    let (min_lng, min_lat, max_lng, max_lat) = (numbers[0], numbers[1], numbers[2], numbers[3]);
    if min_lat < -90.0
        || max_lat > 90.0
        || min_lng < -180.0
        || max_lng > 180.0
        || min_lat > max_lat
        || min_lng > max_lng
    {
        return None;
    }
    Some((min_lng, min_lat, max_lng, max_lat))
}

fn js_number_string(raw: &str) -> Option<f64> {
    let text = raw.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    text.parse::<f64>().ok()
}

fn collect_points(value: &Value, out: &mut Vec<(f64, f64)>) {
    let Some(items) = value.as_array() else {
        return;
    };
    if items.len() >= 2 && items[0].is_number() && items[1].is_number() {
        if let (Some(lng), Some(lat)) = (js_number(&items[0]), js_number(&items[1])) {
            out.push((lng, lat));
        }
        return;
    }
    for item in items {
        collect_points(item, out);
    }
}

fn geometry_points(geometry: &Value) -> Vec<(f64, f64)> {
    let mut points = Vec::new();
    if let Some(object) = geometry.as_object() {
        if let Some(coordinates) = object.get("coordinates") {
            collect_points(coordinates, &mut points);
        }
        if let Some(Value::Array(geometries)) = object.get("geometries") {
            for item in geometries {
                points.extend(geometry_points(item));
            }
        }
    }
    points
}

fn geometry_bbox(geometry: &Value) -> Option<(f64, f64, f64, f64)> {
    let points = geometry_points(geometry);
    if points.is_empty() {
        return None;
    }
    let mut min_lng = f64::INFINITY;
    let mut min_lat = f64::INFINITY;
    let mut max_lng = f64::NEG_INFINITY;
    let mut max_lat = f64::NEG_INFINITY;
    for (lng, lat) in points {
        min_lng = min_lng.min(lng);
        min_lat = min_lat.min(lat);
        max_lng = max_lng.max(lng);
        max_lat = max_lat.max(lat);
    }
    Some((min_lng, min_lat, max_lng, max_lat))
}

pub async fn list_features(
    store: &Store,
    collection_id: &str,
    bbox: Option<&str>,
    limit: f64,
) -> Result<Vec<Value>, String> {
    ensure_geo_tables(store).await?;
    let limit = if limit.is_finite() {
        limit.trunc().clamp(1.0, 1000.0)
    } else {
        200.0
    } as i64;
    let box_ = bbox_param(bbox);
    if let Some(pool) = store.pool() {
        let rows = if let Some((min_lng, min_lat, max_lng, max_lat)) = box_ {
            sqlx::query(
                r#"SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
                   FROM synapseone_base_geo_features
                   WHERE collection_id = $1
                     AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
                   ORDER BY updated_at DESC LIMIT $6"#,
            )
            .bind(collection_id)
            .bind(min_lng)
            .bind(min_lat)
            .bind(max_lng)
            .bind(max_lat)
            .bind(limit)
            .fetch_all(pool)
            .await
        } else {
            sqlx::query(
                r#"SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
                   FROM synapseone_base_geo_features
                   WHERE collection_id = $1
                   ORDER BY updated_at DESC LIMIT $2"#,
            )
            .bind(collection_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        .map_err(|error| error.to_string())?;
        return Ok(rows.iter().map(feature_from_row).collect());
    }
    let memory = store.memory().await.expect("memory store");
    let mut records: Vec<&GeoFeatureRecord> = memory
        .geo_features
        .values()
        .filter(|record| record.collection_id == collection_id)
        .filter(|record| match box_ {
            Some((min_lng, min_lat, max_lng, max_lat)) => geometry_bbox(&record.geometry)
                .map(|(a, b, c, d)| a <= max_lng && c >= min_lng && b <= max_lat && d >= min_lat)
                .unwrap_or(false),
            None => true,
        })
        .collect();
    records.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    records.truncate(limit as usize);
    Ok(records
        .iter()
        .map(|record| memory_feature(record))
        .collect())
}

pub async fn near(
    store: &Store,
    collection_id: &str,
    lat: f64,
    lng: f64,
    radius_meters: f64,
    limit: f64,
) -> Result<Vec<Value>, String> {
    ensure_geo_tables(store).await?;
    if !lat.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !lng.is_finite()
        || !(-180.0..=180.0).contains(&lng)
    {
        return Err("lat/lng out of range".into());
    }
    if !radius_meters.is_finite() || radius_meters <= 0.0 || radius_meters > 200_000.0 {
        return Err("radiusMeters must be between 1 and 200000".into());
    }
    let capped = if limit.is_finite() {
        limit.trunc().clamp(1.0, 1000.0)
    } else {
        200.0
    } as i64;
    if let Some(pool) = store.pool() {
        let rows = sqlx::query(
            r#"SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry,
                      ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS distance_m
               FROM synapseone_base_geo_features
               WHERE collection_id = $1
                 AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
               ORDER BY distance_m ASC LIMIT $5"#,
        )
        .bind(collection_id)
        .bind(lng)
        .bind(lat)
        .bind(radius_meters)
        .bind(capped)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
        return Ok(rows
            .iter()
            .map(|row| {
                let mut feature = feature_from_row(row);
                if let Some(object) = feature.as_object_mut() {
                    object.insert(
                        "distanceMeters".into(),
                        crate::query::number_value(
                            row.try_get::<f64, _>("distance_m").unwrap_or(0.0),
                        ),
                    );
                }
                feature
            })
            .collect());
    }
    let memory = store.memory().await.expect("memory store");
    let mut scored: Vec<(f64, &GeoFeatureRecord)> = Vec::new();
    for record in memory
        .geo_features
        .values()
        .filter(|record| record.collection_id == collection_id)
    {
        let Some((feature_lng, feature_lat)) = geometry_points(&record.geometry).first().copied()
        else {
            continue;
        };
        let distance = haversine_km((lat, lng), (feature_lat, feature_lng)) * 1000.0;
        if distance <= radius_meters {
            scored.push((distance, record));
        }
    }
    scored.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.1.id.cmp(&right.1.id))
    });
    scored.truncate(capped as usize);
    Ok(scored
        .iter()
        .map(|(distance, record)| {
            let mut feature = memory_feature(record);
            if let Some(object) = feature.as_object_mut() {
                object.insert(
                    "distanceMeters".into(),
                    crate::query::number_value(*distance),
                );
            }
            feature
        })
        .collect())
}

fn polygon_rings(geometry: &Value) -> Vec<Vec<(f64, f64)>> {
    let Some(object) = geometry.as_object() else {
        return Vec::new();
    };
    if object.get("type").map(js_string).as_deref() == Some("Polygon") {
        let Some(rings) = object.get("coordinates").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for ring in rings.iter().take(1) {
            let mut points = Vec::new();
            collect_ring(ring, &mut points);
            out.push(points);
        }
        return out;
    }
    if object.get("type").map(js_string).as_deref() == Some("MultiPolygon") {
        let Some(polygons) = object.get("coordinates").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for polygon in polygons {
            if let Some(rings) = polygon.as_array() {
                if let Some(ring) = rings.first() {
                    let mut points = Vec::new();
                    collect_ring(ring, &mut points);
                    out.push(points);
                }
            }
        }
        return out;
    }
    Vec::new()
}

fn collect_ring(value: &Value, out: &mut Vec<(f64, f64)>) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        if let Some(point) = geo_point(item) {
            out.push((point.1, point.0));
        }
    }
}

pub async fn within(
    store: &Store,
    collection_id: &str,
    geometry: &Value,
    limit: f64,
) -> Result<Vec<Value>, String> {
    ensure_geo_tables(store).await?;
    let geometry_type = geometry.get("type").map(js_string).unwrap_or_default();
    if geometry_type != "Polygon" && geometry_type != "MultiPolygon" {
        return Err("geometry must be a Polygon or MultiPolygon".into());
    }
    let capped = if limit.is_finite() {
        limit.trunc().clamp(1.0, 1000.0)
    } else {
        200.0
    } as i64;
    if let Some(pool) = store.pool() {
        let payload = serde_json::to_string(geometry).unwrap_or_default();
        let rows = sqlx::query(
            r#"SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
               FROM synapseone_base_geo_features
               WHERE collection_id = $1
                 AND ST_Within(geom, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
               ORDER BY updated_at DESC LIMIT $3"#,
        )
        .bind(collection_id)
        .bind(payload)
        .bind(capped)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
        return Ok(rows.iter().map(feature_from_row).collect());
    }
    let rings = polygon_rings(geometry);
    if rings.is_empty() {
        return Ok(Vec::new());
    }
    let memory = store.memory().await.expect("memory store");
    let mut records: Vec<&GeoFeatureRecord> = memory
        .geo_features
        .values()
        .filter(|record| record.collection_id == collection_id)
        .filter(|record| {
            let points = geometry_points(&record.geometry);
            !points.is_empty()
                && points
                    .iter()
                    .all(|(lng, lat)| rings.iter().any(|ring| point_in_ring((*lat, *lng), ring)))
        })
        .collect();
    records.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    records.truncate(capped as usize);
    Ok(records
        .iter()
        .map(|record| memory_feature(record))
        .collect())
}

pub async fn delete_feature(store: &Store, collection_id: &str, id: &str) -> Result<bool, String> {
    ensure_geo_tables(store).await?;
    if let Some(pool) = store.pool() {
        let result = sqlx::query(
            "DELETE FROM synapseone_base_geo_features WHERE collection_id = $1 AND id = $2",
        )
        .bind(collection_id)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?;
        return Ok(result.rows_affected() > 0);
    }
    let mut memory = store.memory().await.expect("memory store");
    Ok(memory
        .geo_features
        .remove(&(collection_id.to_string(), id.to_string()))
        .is_some())
}

pub async fn geo_stats(store: &Store, collection_id: &str) -> Result<Value, String> {
    ensure_geo_tables(store).await?;
    if let Some(pool) = store.pool() {
        let row = sqlx::query(
            r#"SELECT count(*)::text AS count, ST_AsGeoJSON(ST_Extent(geom))::json AS extent
               FROM synapseone_base_geo_features WHERE collection_id = $1"#,
        )
        .bind(collection_id)
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
        let count: String = row.try_get("count").unwrap_or_default();
        let extent: Option<Value> = row.try_get("extent").ok().flatten();
        return Ok(json!({
            "features": count.parse::<i64>().unwrap_or(0),
            "extent": extent.unwrap_or(Value::Null),
        }));
    }
    let memory = store.memory().await.expect("memory store");
    let records: Vec<&GeoFeatureRecord> = memory
        .geo_features
        .values()
        .filter(|record| record.collection_id == collection_id)
        .collect();
    let mut bounds: Option<(f64, f64, f64, f64)> = None;
    for record in &records {
        if let Some((min_lng, min_lat, max_lng, max_lat)) = geometry_bbox(&record.geometry) {
            bounds = Some(match bounds {
                Some((a, b, c, d)) => (
                    a.min(min_lng),
                    b.min(min_lat),
                    c.max(max_lng),
                    d.max(max_lat),
                ),
                None => (min_lng, min_lat, max_lng, max_lat),
            });
        }
    }
    let extent = match bounds {
        Some((min_lng, min_lat, max_lng, max_lat)) => json!({
            "type": "Polygon",
            "coordinates": [[
                [min_lng, min_lat],
                [max_lng, min_lat],
                [max_lng, max_lat],
                [min_lng, max_lat],
                [min_lng, min_lat]
            ]]
        }),
        None => Value::Null,
    };
    Ok(json!({
        "features": records.len(),
        "extent": extent,
    }))
}
