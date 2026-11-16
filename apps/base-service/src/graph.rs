// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase Graph — tenant-scoped property graph stored in Postgres with an
//! in-memory fallback. Traversal is a bounded BFS/recursive CTE so a malicious
//! request cannot walk the whole database.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::store::{GraphEdge, GraphNode, Store};
use crate::util::{iso, js_string, now_iso};

fn id_regex() -> &'static Regex {
    static ID_RE: OnceLock<Regex> = OnceLock::new();
    ID_RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_@.:+-]{1,256}$").expect("id regex"))
}

fn label_regex() -> &'static Regex {
    static LABEL_RE: OnceLock<Regex> = OnceLock::new();
    LABEL_RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_:-]{1,64}$").expect("label regex"))
}

pub fn clean_id(value: Option<&Value>) -> Option<String> {
    let id = match value {
        Some(Value::Null) | None => String::new(),
        Some(value) => js_string(value).trim().to_string(),
    };
    id_regex().is_match(&id).then_some(id)
}

pub fn clean_labels(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let label = js_string(item).trim().to_string();
        if label_regex().is_match(&label) && seen.insert(label.clone()) {
            out.push(label);
            if out.len() == 16 {
                break;
            }
        }
    }
    out
}

fn as_object(value: Option<&Value>) -> Value {
    match value {
        Some(value) if value.is_object() => value.clone(),
        _ => Value::Object(Map::new()),
    }
}

async fn ensure_graph_tables(store: &Store) -> Result<(), String> {
    if !store.uses_postgres() {
        return Ok(());
    }
    let Some(pool) = store.pool() else {
        return Ok(());
    };
    store
        .graph_ready
        .get_or_try_init(|| async {
            let statements = [
                r#"CREATE TABLE IF NOT EXISTS synapseone_base_graph_nodes (
                     collection_id text NOT NULL REFERENCES synapseone_base_collections(id) ON DELETE CASCADE,
                     id text NOT NULL,
                     labels text[] NOT NULL DEFAULT '{}',
                     properties jsonb NOT NULL DEFAULT '{}'::jsonb,
                     created_at timestamptz NOT NULL DEFAULT now(),
                     updated_at timestamptz NOT NULL DEFAULT now(),
                     PRIMARY KEY (collection_id, id)
                   )"#,
                r#"CREATE TABLE IF NOT EXISTS synapseone_base_graph_edges (
                     collection_id text NOT NULL,
                     id text NOT NULL,
                     from_id text NOT NULL,
                     to_id text NOT NULL,
                     type text NOT NULL,
                     properties jsonb NOT NULL DEFAULT '{}'::jsonb,
                     created_at timestamptz NOT NULL DEFAULT now(),
                     updated_at timestamptz NOT NULL DEFAULT now(),
                     PRIMARY KEY (collection_id, id),
                     FOREIGN KEY (collection_id, from_id) REFERENCES synapseone_base_graph_nodes(collection_id, id) ON DELETE CASCADE,
                     FOREIGN KEY (collection_id, to_id) REFERENCES synapseone_base_graph_nodes(collection_id, id) ON DELETE CASCADE
                   )"#,
                "CREATE INDEX IF NOT EXISTS idx_base_graph_edges_from ON synapseone_base_graph_edges(collection_id, from_id)",
                "CREATE INDEX IF NOT EXISTS idx_base_graph_edges_to ON synapseone_base_graph_edges(collection_id, to_id)",
                "CREATE INDEX IF NOT EXISTS idx_base_graph_edges_type ON synapseone_base_graph_edges(collection_id, type)",
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

fn node_from_row(row: &sqlx::postgres::PgRow, collection_id: &str) -> GraphNode {
    let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
    let updated_at: Option<DateTime<Utc>> = row.try_get("updated_at").ok();
    let labels: Vec<String> = row.try_get("labels").unwrap_or_default();
    GraphNode {
        collection_id: collection_id.to_string(),
        id: row.try_get("id").unwrap_or_default(),
        labels,
        properties: row
            .try_get("properties")
            .unwrap_or_else(|_| Value::Object(Map::new())),
        created_at: created_at.map(|value| iso(&value)).unwrap_or_default(),
        updated_at: updated_at.map(|value| iso(&value)).unwrap_or_default(),
    }
}

fn edge_from_row(row: &sqlx::postgres::PgRow, collection_id: &str) -> GraphEdge {
    let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
    let updated_at: Option<DateTime<Utc>> = row.try_get("updated_at").ok();
    GraphEdge {
        collection_id: collection_id.to_string(),
        id: row.try_get("id").unwrap_or_default(),
        from: row.try_get("from").unwrap_or_default(),
        to: row.try_get("to").unwrap_or_default(),
        edge_type: row.try_get("type").unwrap_or_default(),
        properties: row
            .try_get("properties")
            .unwrap_or_else(|_| Value::Object(Map::new())),
        created_at: created_at.map(|value| iso(&value)).unwrap_or_default(),
        updated_at: updated_at.map(|value| iso(&value)).unwrap_or_default(),
    }
}

pub async fn upsert_nodes(
    store: &Store,
    collection_id: &str,
    input: &Value,
) -> Result<Vec<GraphNode>, String> {
    ensure_graph_tables(store).await?;
    let Some(items) = input.as_array() else {
        return Ok(Vec::new());
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if items.len() > 1000 {
        return Err("at most 1000 nodes per request".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for raw in items {
        let item = raw.as_object().cloned().unwrap_or_default();
        let raw_id = js_string(item.get("id").unwrap_or(&Value::Null));
        let id = clean_id(item.get("id")).ok_or_else(|| {
            format!(
                "invalid node id: {}",
                raw_id.chars().take(40).collect::<String>()
            )
        })?;
        let labels = clean_labels(item.get("labels"));
        let properties = as_object(item.get("properties"));
        if let Some(pool) = store.pool() {
            let row = sqlx::query(
                r#"INSERT INTO synapseone_base_graph_nodes (collection_id, id, labels, properties)
                   VALUES ($1, $2, $3::text[], $4::jsonb)
                   ON CONFLICT (collection_id, id) DO UPDATE
                     SET labels = EXCLUDED.labels, properties = EXCLUDED.properties, updated_at = now()
                   RETURNING id, labels, properties, created_at, updated_at"#,
            )
            .bind(collection_id)
            .bind(&id)
            .bind(&labels)
            .bind(&properties)
            .fetch_one(pool)
            .await
            .map_err(|error| error.to_string())?;
            out.push(node_from_row(&row, collection_id));
        } else {
            let mut memory = store.memory().await.expect("memory store");
            let key = (collection_id.to_string(), id.clone());
            let now = now_iso();
            let node = match memory.graph_nodes.get(&key).cloned() {
                Some(existing) => GraphNode {
                    collection_id: collection_id.to_string(),
                    id: existing.id,
                    labels,
                    properties,
                    created_at: existing.created_at,
                    updated_at: now,
                },
                None => GraphNode {
                    collection_id: collection_id.to_string(),
                    id,
                    labels,
                    properties,
                    created_at: now.clone(),
                    updated_at: now,
                },
            };
            memory.graph_nodes.insert(key, node.clone());
            out.push(node);
        }
    }
    Ok(out)
}

pub async fn upsert_edges(
    store: &Store,
    collection_id: &str,
    input: &Value,
) -> Result<Vec<GraphEdge>, String> {
    ensure_graph_tables(store).await?;
    let Some(items) = input.as_array() else {
        return Ok(Vec::new());
    };
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if items.len() > 2000 {
        return Err("at most 2000 edges per request".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for raw in items {
        let item = raw.as_object().cloned().unwrap_or_default();
        let from = item
            .get("from")
            .filter(|value| !value.is_null())
            .or_else(|| item.get("from_id"));
        let to = item
            .get("to")
            .filter(|value| !value.is_null())
            .or_else(|| item.get("to_id"));
        let from = clean_id(from).ok_or("edge requires from/to node ids")?;
        let to = clean_id(to).ok_or("edge requires from/to node ids")?;
        let edge_type = match item.get("type") {
            Some(Value::Null) | None => String::new(),
            Some(value) => js_string(value).trim().to_string(),
        };
        if !label_regex().is_match(&edge_type) {
            return Err("edge type must match [A-Za-z0-9_:-]{1,64}".into());
        }
        let id = clean_id(item.get("id")).unwrap_or_else(|| format!("{from}->{edge_type}->{to}"));
        let properties = as_object(item.get("properties"));
        if let Some(pool) = store.pool() {
            let row = sqlx::query(
                r#"INSERT INTO synapseone_base_graph_edges (collection_id, id, from_id, to_id, type, properties)
                   VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                   ON CONFLICT (collection_id, id) DO UPDATE
                     SET type = EXCLUDED.type, properties = EXCLUDED.properties, updated_at = now()
                   RETURNING id, from_id AS "from", to_id AS "to", type, properties, created_at, updated_at"#,
            )
            .bind(collection_id)
            .bind(&id)
            .bind(&from)
            .bind(&to)
            .bind(&edge_type)
            .bind(&properties)
            .fetch_one(pool)
            .await
            .map_err(|error| error.to_string())?;
            out.push(edge_from_row(&row, collection_id));
        } else {
            let mut memory = store.memory().await.expect("memory store");
            let from_key = (collection_id.to_string(), from.clone());
            let to_key = (collection_id.to_string(), to.clone());
            if !memory.graph_nodes.contains_key(&from_key)
                || !memory.graph_nodes.contains_key(&to_key)
            {
                return Err("edge endpoints must exist".into());
            }
            let key = (collection_id.to_string(), id.clone());
            let now = now_iso();
            let edge = match memory.graph_edges.get(&key).cloned() {
                Some(existing) => GraphEdge {
                    collection_id: collection_id.to_string(),
                    id: existing.id,
                    from: existing.from,
                    to: existing.to,
                    edge_type,
                    properties,
                    created_at: existing.created_at,
                    updated_at: now,
                },
                None => GraphEdge {
                    collection_id: collection_id.to_string(),
                    id,
                    from,
                    to,
                    edge_type,
                    properties,
                    created_at: now.clone(),
                    updated_at: now,
                },
            };
            memory.graph_edges.insert(key, edge.clone());
            out.push(edge);
        }
    }
    Ok(out)
}

pub async fn get_node(
    store: &Store,
    collection_id: &str,
    id: &str,
) -> Result<Option<GraphNode>, String> {
    ensure_graph_tables(store).await?;
    if let Some(pool) = store.pool() {
        let row = sqlx::query(
            r#"SELECT id, labels, properties, created_at, updated_at
               FROM synapseone_base_graph_nodes WHERE collection_id = $1 AND id = $2"#,
        )
        .bind(collection_id)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?;
        return Ok(row.as_ref().map(|row| node_from_row(row, collection_id)));
    }
    let memory = store.memory().await.expect("memory store");
    Ok(memory
        .graph_nodes
        .get(&(collection_id.to_string(), id.to_string()))
        .cloned())
}

pub struct Subgraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub next: bool,
}

pub async fn subgraph(
    store: &Store,
    collection_id: &str,
    start_ids: &[String],
    depth: f64,
    edge_types: &[String],
    limit: f64,
) -> Result<Subgraph, String> {
    ensure_graph_tables(store).await?;
    let starts: Vec<String> = start_ids
        .iter()
        .filter_map(|id| clean_id(Some(&Value::String(id.clone()))))
        .collect();
    if starts.is_empty() {
        return Ok(Subgraph {
            nodes: Vec::new(),
            edges: Vec::new(),
            next: false,
        });
    }
    let max_depth = depth.trunc().clamp(1.0, 5.0) as i64;
    let capped = limit.trunc().clamp(1.0, 1000.0) as usize;
    let types: Vec<String> = edge_types
        .iter()
        .filter(|value| label_regex().is_match(value))
        .cloned()
        .collect();
    if let Some(pool) = store.pool() {
        let rows = sqlx::query(
            r#"WITH RECURSIVE reach(id, depth) AS (
                 SELECT unnest($2::text[])::text, 0
                 UNION
                 SELECT CASE WHEN e.from_id = r.id THEN e.to_id ELSE e.from_id END, r.depth + 1
                 FROM synapseone_base_graph_edges e
                 JOIN reach r ON (e.from_id = r.id OR e.to_id = r.id)
                 WHERE r.depth < $3 AND e.collection_id = $1
                   AND ($4::text[] = '{}' OR e.type = ANY($4::text[]))
               )
               SELECT DISTINCT n.id, n.labels, n.properties, n.created_at, n.updated_at
               FROM synapseone_base_graph_nodes n
               JOIN reach r ON r.id = n.id
               WHERE n.collection_id = $1
               LIMIT $5"#,
        )
        .bind(collection_id)
        .bind(&starts)
        .bind(max_depth)
        .bind(&types)
        .bind((capped + 1) as i64)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
        let mut nodes: Vec<GraphNode> = rows
            .iter()
            .map(|row| node_from_row(row, collection_id))
            .collect();
        let truncated = nodes.len() > capped;
        if truncated {
            nodes.truncate(capped);
        }
        let ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
        let edges = if ids.is_empty() {
            Vec::new()
        } else {
            let edge_rows = sqlx::query(
                r#"SELECT id, from_id AS "from", to_id AS "to", type, properties, created_at, updated_at
                   FROM synapseone_base_graph_edges
                   WHERE collection_id = $1 AND from_id = ANY($2::text[]) AND to_id = ANY($2::text[])"#,
            )
            .bind(collection_id)
            .bind(&ids)
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?;
            edge_rows
                .iter()
                .map(|row| edge_from_row(row, collection_id))
                .collect()
        };
        return Ok(Subgraph {
            nodes,
            edges,
            next: truncated,
        });
    }
    let memory = store.memory().await.expect("memory store");
    let mut reached: HashMap<String, usize> = HashMap::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    for start in &starts {
        reached.insert(start.clone(), 0);
        queue.push_back((start.clone(), 0));
    }
    while let Some((id, current_depth)) = queue.pop_front() {
        if current_depth as i64 >= max_depth {
            continue;
        }
        for edge in memory.graph_edges.values() {
            if edge.collection_id != collection_id {
                continue;
            }
            if !types.is_empty() && !types.contains(&edge.edge_type) {
                continue;
            }
            let other = if edge.from == id {
                Some(edge.to.clone())
            } else if edge.to == id {
                Some(edge.from.clone())
            } else {
                None
            };
            if let Some(other) = other {
                let next_depth = current_depth + 1;
                let should_visit = reached
                    .get(&other)
                    .map(|value| next_depth < *value)
                    .unwrap_or(true);
                if should_visit {
                    reached.insert(other.clone(), next_depth);
                    queue.push_back((other, next_depth));
                }
            }
        }
    }
    let mut nodes: Vec<GraphNode> = memory
        .graph_nodes
        .values()
        .filter(|node| node.collection_id == collection_id && reached.contains_key(&node.id))
        .cloned()
        .collect();
    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    let truncated = nodes.len() > capped;
    if truncated {
        nodes.truncate(capped);
    }
    let ids: HashSet<String> = nodes.iter().map(|node| node.id.clone()).collect();
    let mut edges: Vec<GraphEdge> = memory
        .graph_edges
        .values()
        .filter(|edge| {
            edge.collection_id == collection_id
                && ids.contains(&edge.from)
                && ids.contains(&edge.to)
        })
        .cloned()
        .collect();
    edges.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(Subgraph {
        nodes,
        edges,
        next: truncated,
    })
}

pub async fn delete_node(store: &Store, collection_id: &str, id: &str) -> Result<bool, String> {
    ensure_graph_tables(store).await?;
    if let Some(pool) = store.pool() {
        let result = sqlx::query(
            "DELETE FROM synapseone_base_graph_nodes WHERE collection_id = $1 AND id = $2",
        )
        .bind(collection_id)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?;
        return Ok(result.rows_affected() > 0);
    }
    let mut memory = store.memory().await.expect("memory store");
    let removed = memory
        .graph_nodes
        .remove(&(collection_id.to_string(), id.to_string()))
        .is_some();
    if removed {
        memory.graph_edges.retain(|_, edge| {
            !(edge.collection_id == collection_id && (edge.from == id || edge.to == id))
        });
    }
    Ok(removed)
}

pub async fn graph_stats(store: &Store, collection_id: &str) -> Result<Value, String> {
    ensure_graph_tables(store).await?;
    if let Some(pool) = store.pool() {
        let node_row = sqlx::query(
            "SELECT count(*)::text AS count FROM synapseone_base_graph_nodes WHERE collection_id = $1",
        )
        .bind(collection_id)
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
        let edge_row = sqlx::query(
            "SELECT count(*)::text AS count FROM synapseone_base_graph_edges WHERE collection_id = $1",
        )
        .bind(collection_id)
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
        let nodes: String = node_row.try_get("count").unwrap_or_default();
        let edges: String = edge_row.try_get("count").unwrap_or_default();
        return Ok(json!({
            "nodes": nodes.parse::<i64>().unwrap_or(0),
            "edges": edges.parse::<i64>().unwrap_or(0),
        }));
    }
    let memory = store.memory().await.expect("memory store");
    let nodes = memory
        .graph_nodes
        .values()
        .filter(|node| node.collection_id == collection_id)
        .count();
    let edges = memory
        .graph_edges
        .values()
        .filter(|edge| edge.collection_id == collection_id)
        .count();
    Ok(json!({"nodes": nodes, "edges": edges}))
}
