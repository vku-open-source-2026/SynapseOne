// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Workflow: templates, workflows, executions, runners, human tasks,
//! credentials, secrets and public inbound webhooks.

use crate::client::{query_string, segment, Client, Request};
use crate::error::{Error, Result};
use http::Method;
use serde_json::{json, Value};
use std::time::Duration;

/// Workflow service handle.
#[derive(Clone)]
pub struct WorkflowService {
    client: Client,
}

impl WorkflowService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    // ---- templates -----------------------------------------------------

    pub async fn list_templates(&self) -> Result<Value> {
        self.client.get("/v1/templates").await
    }

    pub async fn get_template(&self, name: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/templates/{}", segment(name)))
            .await
    }

    // ---- workflows -----------------------------------------------------

    pub async fn list_workflows(&self) -> Result<Value> {
        self.client.get("/v1/workflows").await
    }

    pub async fn get_workflow(&self, workflow_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/workflows/{}", segment(workflow_id)))
            .await
    }

    pub async fn create_workflow_from_template(
        &self,
        template: &str,
        name: Option<&str>,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/workflows",
                json!({ "template": template, "name": name }),
            )
            .await
    }

    pub async fn create_workflow(
        &self,
        name: &str,
        definition: Value,
        settings: Option<Value>,
    ) -> Result<Value> {
        let mut body = json!({ "name": name, "definition": definition });
        if let Some(settings) = settings {
            body["settings"] = settings;
        }
        self.client.post("/v1/workflows", body).await
    }

    pub async fn update_workflow(
        &self,
        workflow_id: &str,
        name: Option<&str>,
        definition: Option<Value>,
        settings: Option<Value>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".to_string(), json!(name));
        }
        if let Some(definition) = definition {
            body.insert("definition".to_string(), definition);
        }
        if let Some(settings) = settings {
            body.insert("settings".to_string(), settings);
        }
        self.client
            .put(
                format!("/v1/workflows/{}", segment(workflow_id)),
                Value::Object(body),
            )
            .await
    }

    pub async fn delete_workflow(&self, workflow_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/workflows/{}", segment(workflow_id)))
            .await
    }

    pub async fn activate_workflow(&self, workflow_id: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/workflows/{}/activate", segment(workflow_id)),
                json!({}),
            )
            .await
    }

    pub async fn deactivate_workflow(&self, workflow_id: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/workflows/{}/deactivate", segment(workflow_id)),
                json!({}),
            )
            .await
    }

    pub async fn execute_workflow(
        &self,
        workflow_id: &str,
        payload: Option<Value>,
        wait: bool,
        timeout_ms: u32,
    ) -> Result<Value> {
        let path = if wait {
            let bounded = timeout_ms.clamp(1_000, 300_000);
            format!(
                "/v1/workflows/{}/execute?{}",
                segment(workflow_id),
                query_string(&[
                    ("wait", "1".to_string()),
                    ("timeoutMs", bounded.to_string()),
                ])
            )
        } else {
            format!("/v1/workflows/{}/execute", segment(workflow_id))
        };
        self.client
            .post(path, payload.unwrap_or_else(|| json!({})))
            .await
    }

    /// Poll an execution until it leaves `queued`/`running`.
    pub async fn wait_for_execution(
        &self,
        execution_id: &str,
        timeout_ms: u64,
        poll_ms: u64,
    ) -> Result<Value> {
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(timeout_ms.clamp(1_000, 300_000));
        let mut current = self.get_execution(execution_id, true).await?;
        loop {
            let status = current.get("status").and_then(Value::as_str).unwrap_or("");
            if status != "queued" && status != "running" {
                return Ok(current);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(current);
            }
            tokio::time::sleep(Duration::from_millis(poll_ms.clamp(100, 5_000))).await;
            current = self.get_execution(execution_id, true).await?;
        }
    }

    // ---- self-hosted runners ------------------------------------------

    pub async fn list_workflow_runners(&self) -> Result<Value> {
        self.client.get("/v1/workflow-runners").await
    }

    pub async fn get_workflow_runner_options(&self) -> Result<Value> {
        self.client.get("/v1/workflow-runners/options").await
    }

    pub async fn get_workflow_runner(&self, runner_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/workflow-runners/{}", segment(runner_id)))
            .await
    }

    pub async fn update_workflow_runner(
        &self,
        runner_id: &str,
        name: Option<&str>,
        mode: Option<&str>,
        queue: Option<&str>,
        metadata: Option<Value>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".to_string(), json!(name));
        }
        if let Some(mode) = mode {
            body.insert("mode".to_string(), json!(mode));
        }
        if let Some(queue) = queue {
            body.insert("queue".to_string(), json!(queue));
        }
        if let Some(metadata) = metadata {
            body.insert("metadata".to_string(), metadata);
        }
        self.client
            .patch(
                format!("/v1/workflow-runners/{}", segment(runner_id)),
                Value::Object(body),
            )
            .await
    }

    pub async fn create_workflow_runner(
        &self,
        name: &str,
        mode: &str,
        queue: Option<&str>,
        api_key_id: Option<&str>,
        key_prefix: Option<&str>,
        scopes: Option<Vec<String>>,
        metadata: Option<Value>,
    ) -> Result<Value> {
        let mut body = json!({ "name": name, "mode": mode });
        if let Some(queue) = queue {
            body["queue"] = json!(queue);
        }
        if let Some(api_key_id) = api_key_id {
            body["apiKeyId"] = json!(api_key_id);
        }
        if let Some(key_prefix) = key_prefix {
            body["keyPrefix"] = json!(key_prefix);
        }
        if let Some(scopes) = scopes {
            body["scopes"] = json!(scopes);
        }
        if let Some(metadata) = metadata {
            body["metadata"] = metadata;
        }
        self.client.post("/v1/workflow-runners", body).await
    }

    pub async fn get_workflow_runner_connection(&self, runner_id: &str) -> Result<Value> {
        self.client
            .get(format!(
                "/v1/workflow-runners/{}/connection",
                segment(runner_id)
            ))
            .await
    }

    pub async fn get_workflow_runner_command(
        &self,
        runner_id: &str,
        api_key: Option<&str>,
    ) -> Result<Value> {
        let body = match api_key {
            Some(api_key) => json!({ "apiKey": api_key }),
            None => json!({}),
        };
        self.client
            .post(
                format!("/v1/workflow-runners/{}/command", segment(runner_id)),
                body,
            )
            .await
    }

    pub async fn delete_workflow_runner(&self, runner_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/workflow-runners/{}", segment(runner_id)))
            .await
    }

    pub async fn delete_workflow_runner_instance(
        &self,
        runner_id: &str,
        instance_id: &str,
    ) -> Result<Value> {
        self.client
            .delete(format!(
                "/v1/workflow-runners/{}/instances/{}",
                segment(runner_id),
                segment(instance_id)
            ))
            .await
    }

    // ---- executions ----------------------------------------------------

    pub async fn list_executions(&self, query: Option<&str>) -> Result<Value> {
        let path = match query {
            Some(query) if !query.is_empty() => {
                if query.starts_with('?') {
                    format!("/v1/executions{query}")
                } else {
                    format!("/v1/executions?{query}")
                }
            }
            _ => "/v1/executions".to_string(),
        };
        self.client.get(path).await
    }

    pub async fn get_execution(&self, execution_id: &str, include_data: bool) -> Result<Value> {
        let path = if include_data {
            format!(
                "/v1/executions/{}?{}",
                segment(execution_id),
                query_string(&[("includeData", "true".to_string())])
            )
        } else {
            format!("/v1/executions/{}", segment(execution_id))
        };
        self.client.get(path).await
    }

    pub async fn test_run(
        &self,
        definition: Value,
        input: Option<Value>,
        workflow_id: Option<&str>,
    ) -> Result<Value> {
        let mut body =
            json!({ "definition": definition, "input": input.unwrap_or_else(|| json!({})) });
        if let Some(workflow_id) = workflow_id {
            body["workflowId"] = json!(workflow_id);
        }
        self.client.post("/v1/workflows/test-run", body).await
    }

    // ---- credentials ---------------------------------------------------

    pub async fn create_credential(
        &self,
        account_id: &str,
        name: &str,
        kind: &str,
        secret: &str,
        expires_at: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "accountId": account_id,
            "name": name,
            "kind": kind,
            "secret": secret,
        });
        if let Some(expires_at) = expires_at {
            body["expiresAt"] = json!(expires_at);
        }
        self.client.post("/v1/credentials", body).await
    }

    pub async fn list_credentials(&self, account_id: Option<&str>) -> Result<Value> {
        let path = match account_id {
            Some(account_id) => format!(
                "/v1/credentials?{}",
                query_string(&[("accountId", account_id.to_string())])
            ),
            None => "/v1/credentials".to_string(),
        };
        self.client.get(path).await
    }

    pub async fn get_credential(&self, credential_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/credentials/{}", segment(credential_id)))
            .await
    }

    pub async fn rotate_credential(&self, credential_id: &str, secret: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/credentials/{}/rotate", segment(credential_id)),
                json!({ "secret": secret }),
            )
            .await
    }

    pub async fn delete_credential(&self, credential_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/credentials/{}", segment(credential_id)))
            .await
    }

    // ---- human tasks ---------------------------------------------------

    pub async fn create_human_task(
        &self,
        title: &str,
        description: &str,
        assignee: Option<&str>,
        candidate_roles: Option<Vec<String>>,
        deadline: Option<&str>,
        decision_schema: Option<Value>,
        payload: Option<Value>,
        workflow_id: Option<&str>,
        execution_id: Option<&str>,
        node: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "title": title,
            "description": description,
            "candidateRoles": candidate_roles.unwrap_or_default(),
            "decisionSchema": decision_schema.unwrap_or_else(|| json!({})),
            "payload": payload.unwrap_or_else(|| json!({})),
        });
        if let Some(assignee) = assignee {
            body["assignee"] = json!(assignee);
        }
        if let Some(deadline) = deadline {
            body["deadline"] = json!(deadline);
        }
        if let Some(workflow_id) = workflow_id {
            body["workflowId"] = json!(workflow_id);
        }
        if let Some(execution_id) = execution_id {
            body["executionId"] = json!(execution_id);
        }
        if let Some(node) = node {
            body["node"] = json!(node);
        }
        self.client.post("/v1/human-tasks", body).await
    }

    pub async fn list_human_tasks(&self, query: Option<&str>) -> Result<Value> {
        let path = match query {
            Some(query) if !query.is_empty() => format!("/v1/human-tasks?{query}"),
            _ => "/v1/human-tasks".to_string(),
        };
        self.client.get(path).await
    }

    pub async fn get_human_task(&self, task_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/human-tasks/{}", segment(task_id)))
            .await
    }

    pub async fn claim_human_task(&self, task_id: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/human-tasks/{}/claim", segment(task_id)),
                json!({}),
            )
            .await
    }

    pub async fn complete_human_task(
        &self,
        task_id: &str,
        decision: Option<Value>,
        note: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "decision": decision.unwrap_or_else(|| json!({})) });
        if let Some(note) = note {
            body["note"] = json!(note);
        }
        self.client
            .post(
                format!("/v1/human-tasks/{}/complete", segment(task_id)),
                body,
            )
            .await
    }

    pub async fn reject_human_task(
        &self,
        task_id: &str,
        note: &str,
        decision: Option<Value>,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/human-tasks/{}/reject", segment(task_id)),
                json!({ "note": note, "decision": decision.unwrap_or_else(|| json!({})) }),
            )
            .await
    }

    pub async fn expire_human_task(&self, task_id: &str, force: bool) -> Result<Value> {
        self.client
            .post(
                format!("/v1/human-tasks/{}/expire", segment(task_id)),
                json!({ "force": force }),
            )
            .await
    }

    // ---- secrets -------------------------------------------------------

    pub async fn create_secret(
        &self,
        name: &str,
        value: &str,
        description: &str,
        scope: &str,
        account_id: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "name": name,
            "value": value,
            "description": description,
            "scope": scope,
        });
        if let Some(account_id) = account_id {
            body["accountId"] = json!(account_id);
        }
        self.client.post("/v1/secrets", body).await
    }

    pub async fn list_secrets(&self) -> Result<Value> {
        self.client.get("/v1/secrets").await
    }

    pub async fn get_secret(&self, name: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/secrets/{}", segment(name)))
            .await
    }

    pub async fn read_secret(&self, name: &str, version: Option<i64>) -> Result<Value> {
        let body = match version {
            Some(version) => json!({ "version": version }),
            None => json!({}),
        };
        self.client
            .post(format!("/v1/secrets/{}/read", segment(name)), body)
            .await
    }

    pub async fn rotate_secret(
        &self,
        name: &str,
        value: &str,
        grace_seconds: u64,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/secrets/{}/rotate", segment(name)),
                json!({ "value": value, "graceSeconds": grace_seconds }),
            )
            .await
    }

    pub async fn revoke_secret(&self, name: &str, version: Option<i64>) -> Result<Value> {
        let body = match version {
            Some(version) => json!({ "version": version }),
            None => json!({}),
        };
        self.client
            .post(format!("/v1/secrets/{}/revoke", segment(name)), body)
            .await
    }

    pub async fn delete_secret(&self, name: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/secrets/{}", segment(name)))
            .await
    }

    // ---- public inbound webhooks --------------------------------------

    /// Fire a public inbound webhook through the gateway: `ANY /webhook/:path`.
    pub async fn trigger_webhook(
        &self,
        path: &str,
        payload: Option<Value>,
        method: Option<&str>,
    ) -> Result<Value> {
        let clean = path.trim_matches('/').split('?').next().unwrap_or("");
        if clean.is_empty() {
            return Err(Error::Config(
                "synapseone webhook: path required".to_string(),
            ));
        }
        let verb = method.map(str::to_ascii_uppercase).unwrap_or_else(|| {
            if payload.is_none() {
                "GET".to_string()
            } else {
                "POST".to_string()
            }
        });
        let method = Method::from_bytes(verb.as_bytes())
            .map_err(|error| Error::Config(format!("invalid webhook method: {error}")))?;
        let request = Request::new(method, format!("/webhook/{clean}"))
            .json(payload)
            .timeout(Duration::from_secs(300))
            .retryable(true);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }
}

/// Fire a webhook against an arbitrary base URL (helper mirroring the Python SDK).
pub async fn trigger_webhook(
    webhook_base_url: &str,
    path: &str,
    payload: Option<Value>,
    method: Option<&str>,
    timeout: Duration,
) -> Result<Value> {
    let client = Client::builder(webhook_base_url).build()?;
    let clean = path.trim_matches('/').split('?').next().unwrap_or("");
    if clean.is_empty() {
        return Err(Error::Config(
            "synapseone webhook: path required".to_string(),
        ));
    }
    let verb = method.map(str::to_ascii_uppercase).unwrap_or_else(|| {
        if payload.is_none() {
            "GET".to_string()
        } else {
            "POST".to_string()
        }
    });
    let method = Method::from_bytes(verb.as_bytes())
        .map_err(|error| Error::Config(format!("invalid webhook method: {error}")))?;
    let request = Request::new(method, format!("/webhook/{clean}"))
        .json(payload)
        .timeout(timeout)
        .retryable(true);
    client.send(request).await.map(|response| response.body)
}
