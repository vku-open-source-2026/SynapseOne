// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Faststore: KV, hashes, lists, sets, sorted sets and locks.

use crate::client::{query_string, segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

/// Faststore service handle.
#[derive(Clone)]
pub struct FaststoreService {
    client: Client,
}

impl FaststoreService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn key_path(kind: &str, key: &str) -> String {
        format!("/v1/faststore/{kind}/{}", segment(key))
    }

    // ---- generic keys --------------------------------------------------

    pub async fn stats(&self) -> Result<Value> {
        self.client.get("/v1/faststore/stats").await
    }

    pub async fn list_keys(
        &self,
        prefix: Option<&str>,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(prefix) = prefix {
            params.push(("prefix", prefix.to_string()));
        }
        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor.to_string()));
        }
        let path = if params.is_empty() {
            "/v1/faststore/keys".to_string()
        } else {
            format!("/v1/faststore/keys?{}", query_string(&params))
        };
        self.client.get(path).await
    }

    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self.client.get(Self::key_path("keys", key)).await {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub async fn get(&self, key: &str) -> Result<Value> {
        self.client.get(Self::key_path("keys", key)).await
    }

    pub async fn set(
        &self,
        key: &str,
        value: Value,
        ttl_seconds: Option<i64>,
        if_not_exists: bool,
        if_exists: bool,
    ) -> Result<Value> {
        let mut body = json!({ "value": value });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        if if_not_exists {
            body["ifNotExists"] = json!(true);
        }
        if if_exists {
            body["ifExists"] = json!(true);
        }
        self.client.put(Self::key_path("keys", key), body).await
    }

    pub async fn delete(&self, key: &str) -> Result<Value> {
        self.client.delete(Self::key_path("keys", key)).await
    }

    pub async fn ttl(&self, key: &str) -> Result<Value> {
        self.client
            .get(format!("{}/ttl", Self::key_path("keys", key)))
            .await
    }

    pub async fn expire(&self, key: &str, ttl_seconds: i64) -> Result<Value> {
        self.client
            .post(
                format!("{}/expire", Self::key_path("keys", key)),
                json!({ "ttlSeconds": ttl_seconds }),
            )
            .await
    }

    pub async fn incr(&self, key: &str, by: i64, ttl_seconds: Option<i64>) -> Result<Value> {
        let mut body = json!({ "by": by });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/incr", Self::key_path("keys", key)), body)
            .await
    }

    pub async fn batch(&self, operations: Value) -> Result<Value> {
        self.client
            .post("/v1/faststore/batch", json!({ "operations": operations }))
            .await
    }

    // ---- hashes --------------------------------------------------------

    pub async fn hash_get(&self, key: &str) -> Result<Value> {
        self.client.get(Self::key_path("hashes", key)).await
    }

    pub async fn hash_set(
        &self,
        key: &str,
        values: Value,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "values": values });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client.put(Self::key_path("hashes", key), body).await
    }

    pub async fn hash_delete(&self, key: &str) -> Result<Value> {
        self.client.delete(Self::key_path("hashes", key)).await
    }

    pub async fn hash_length(&self, key: &str) -> Result<Value> {
        self.client
            .get(format!("{}/length", Self::key_path("hashes", key)))
            .await
    }

    pub async fn hash_get_field(&self, key: &str, field: &str) -> Result<Value> {
        self.client
            .get(format!(
                "{}?{}",
                Self::key_path("hashes", key),
                query_string(&[("field", field.to_string())])
            ))
            .await
    }

    pub async fn hash_set_field(
        &self,
        key: &str,
        field: &str,
        value: Value,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "field": field, "value": value });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/field", Self::key_path("hashes", key)), body)
            .await
    }

    pub async fn hash_delete_field(&self, key: &str, field: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "{}/field?{}",
                Self::key_path("hashes", key),
                query_string(&[("field", field.to_string())])
            ))
            .await
    }

    pub async fn hash_incr(
        &self,
        key: &str,
        field: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "field": field, "by": by });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/incr", Self::key_path("hashes", key)), body)
            .await
    }

    // ---- lists ---------------------------------------------------------

    pub async fn list_range(&self, key: &str, start: i64, stop: i64) -> Result<Value> {
        self.client
            .get(format!(
                "{}?{}",
                Self::key_path("lists", key),
                query_string(&[("start", start.to_string()), ("stop", stop.to_string()),])
            ))
            .await
    }

    pub async fn list_delete(&self, key: &str) -> Result<Value> {
        self.client.delete(Self::key_path("lists", key)).await
    }

    pub async fn list_push(
        &self,
        key: &str,
        values: Value,
        side: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "values": values, "side": side });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/push", Self::key_path("lists", key)), body)
            .await
    }

    pub async fn list_pop(&self, key: &str, side: &str, count: u32) -> Result<Value> {
        self.client
            .post(
                format!("{}/pop", Self::key_path("lists", key)),
                json!({ "side": side, "count": count }),
            )
            .await
    }

    pub async fn list_trim(&self, key: &str, start: i64, stop: i64) -> Result<Value> {
        self.client
            .post(
                format!("{}/trim", Self::key_path("lists", key)),
                json!({ "start": start, "stop": stop }),
            )
            .await
    }

    pub async fn list_length(&self, key: &str) -> Result<Value> {
        self.client
            .get(format!("{}/length", Self::key_path("lists", key)))
            .await
    }

    // ---- sets ----------------------------------------------------------

    pub async fn set_members(&self, key: &str) -> Result<Value> {
        self.client.get(Self::key_path("sets", key)).await
    }

    pub async fn set_delete(&self, key: &str) -> Result<Value> {
        self.client.delete(Self::key_path("sets", key)).await
    }

    pub async fn set_add(
        &self,
        key: &str,
        members: Value,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "members": members });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/add", Self::key_path("sets", key)), body)
            .await
    }

    pub async fn set_remove(&self, key: &str, members: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/remove", Self::key_path("sets", key)),
                json!({ "members": members }),
            )
            .await
    }

    pub async fn set_contains(&self, key: &str, member: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/contains", Self::key_path("sets", key)),
                json!({ "member": member }),
            )
            .await
    }

    pub async fn set_card(&self, key: &str) -> Result<Value> {
        self.client
            .get(format!("{}/card", Self::key_path("sets", key)))
            .await
    }

    // ---- sorted sets ---------------------------------------------------

    pub async fn zset_range(
        &self,
        key: &str,
        start: i64,
        stop: i64,
        rev: bool,
        with_scores: bool,
    ) -> Result<Value> {
        let mut params = vec![("start", start.to_string()), ("stop", stop.to_string())];
        if rev {
            params.push(("rev", "true".to_string()));
        }
        if with_scores {
            params.push(("withScores", "true".to_string()));
        }
        self.client
            .get(format!(
                "{}?{}",
                Self::key_path("zsets", key),
                query_string(&params)
            ))
            .await
    }

    pub async fn zset_delete(&self, key: &str) -> Result<Value> {
        self.client.delete(Self::key_path("zsets", key)).await
    }

    pub async fn zset_add(
        &self,
        key: &str,
        members: Value,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "members": members });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/add", Self::key_path("zsets", key)), body)
            .await
    }

    pub async fn zset_incr(
        &self,
        key: &str,
        member: Value,
        by: f64,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "member": member, "by": by });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(format!("{}/incr", Self::key_path("zsets", key)), body)
            .await
    }

    pub async fn zset_remove(&self, key: &str, members: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/remove", Self::key_path("zsets", key)),
                json!({ "members": members }),
            )
            .await
    }

    pub async fn zset_score(&self, key: &str, member: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/score", Self::key_path("zsets", key)),
                json!({ "member": member }),
            )
            .await
    }

    pub async fn zset_rank(&self, key: &str, member: Value, rev: bool) -> Result<Value> {
        let mut body = json!({ "member": member });
        if rev {
            body["rev"] = json!(true);
        }
        self.client
            .post(format!("{}/rank", Self::key_path("zsets", key)), body)
            .await
    }

    pub async fn zset_card(&self, key: &str) -> Result<Value> {
        self.client
            .get(format!("{}/card", Self::key_path("zsets", key)))
            .await
    }

    // ---- locks ---------------------------------------------------------

    pub async fn lock_acquire(
        &self,
        name: &str,
        ttl_seconds: Option<i64>,
        wait_ms: u64,
        token: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "waitMs": wait_ms });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        if let Some(token) = token {
            body["token"] = json!(token);
        }
        self.client
            .post(
                format!("/v1/faststore/locks/{}/acquire", segment(name)),
                body,
            )
            .await
    }

    pub async fn lock_release(&self, name: &str, token: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/faststore/locks/{}/release", segment(name)),
                json!({ "token": token }),
            )
            .await
    }

    pub async fn lock_extend(
        &self,
        name: &str,
        token: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "token": token });
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client
            .post(
                format!("/v1/faststore/locks/{}/extend", segment(name)),
                body,
            )
            .await
    }
}
