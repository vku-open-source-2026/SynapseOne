// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Two-step agent for API testing:
//!   1. DECISION model (cheap/fast) picks the endpoint from the catalog.
//!   2. LLM generates the path params + JSON body for that endpoint.
//! Both outputs are UNTRUSTED: everything is validated against the catalog
//! before it leaves the service (fail-closed — a bad model reply becomes a
//! 502 error, never a malformed call).

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::llm::{chat_complete, chat_json, strip_fences, ChatCall, LlmConfig, LlmError};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CatalogEndpoint {
    pub method: String,
    pub path: String,
    pub auth: String,
    pub desc: String,
    #[serde(default)]
    pub body: Option<Value>,
}

pub fn catalog() -> &'static Vec<CatalogEndpoint> {
    static CATALOG: OnceLock<Vec<CatalogEndpoint>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("catalog.json")).expect("catalog.json is valid")
    })
}

#[derive(Debug, Clone)]
pub struct AgentError {
    pub code: String,
    pub message: String,
}

impl AgentError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub enum AgentFailure {
    Agent(AgentError),
    Llm(LlmError),
}

impl From<LlmError> for AgentFailure {
    fn from(error: LlmError) -> Self {
        AgentFailure::Llm(error)
    }
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub decision: LlmConfig,
    pub llm: LlmConfig,
    pub llm_fallback: Option<LlmConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub ok: bool,
    pub method: String,
    pub path: String,
    pub auth: String,
    pub path_values: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    pub explanation: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
}

const DECISION_SYSTEM: &str = concat!(
    "You are an API routing decision model for the SynapseOne PaaS. ",
    "Given the user question and the API catalog (JSON array), pick the SINGLE best endpoint to answer it. ",
    "Reply with ONLY a JSON object: {\"method\":\"GET|POST|PUT|DELETE\",\"path\":\"<exact catalog path>\",\"reason\":\"<one short sentence>\"}. ",
    "The method and path must match a catalog entry EXACTLY (including any :params and query string). ",
    "If no endpoint fits, reply {\"method\":null,\"path\":null,\"reason\":\"<why>\"}."
);

const GENERATE_SYSTEM: &str = concat!(
    "You are an API call generator for the SynapseOne PaaS. ",
    "Given the user question and the endpoint, generate the exact values to call it. ",
    "Reply with ONLY a JSON object: {\"pathValues\":{\"<param>\":\"<value>\"},\"body\":{...},\"explanation\":\"<one short sentence in the user's language>\"}. ",
    "pathValues keys must be exactly the :params in the path (empty object if none). Values must be non-empty strings, max 128 chars. ",
    "body must be a JSON object matching the endpoint schema (empty object if the endpoint takes no body). ",
    "Derive values from the question; use realistic placeholders (e.g. \"prod\", \"demo@acme.local\") when the question does not specify."
);

const GUIDE_SYSTEM: &str = concat!(
    "You are a helpful guide for the SynapseOne PaaS API. ",
    "The user asks a general how-to question that maps to NO single endpoint. ",
    "Given the API catalog (method, path, description per endpoint), answer concisely ",
    "in the user's language: which endpoints to call, in what order, one short line per step. ",
    "Reply with plain text (no JSON wrapper, no markdown fences around the whole answer)."
);

const MAX_QUESTION_LEN: usize = 2000;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_STR: usize = 128;
const MAX_EXPLANATION: usize = 1000;
const MAX_GUIDANCE: usize = 2000;

fn param_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r":([A-Za-z0-9_]+)").expect("param regex"))
}

/// Extract :param names from a path template.
pub fn path_params(path: &str) -> Vec<String> {
    param_re()
        .captures_iter(path)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

fn find_endpoint(method: &str, path: &str) -> Option<&'static CatalogEndpoint> {
    let clean = path.split('?').next().unwrap_or(path);
    catalog().iter().find(|entry| {
        entry.method == method
            && (entry.path == path
                || entry.path.split('?').next().unwrap_or(&entry.path) == clean)
    })
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn history_prefix(history: &[(String, String)]) -> String {
    if history.is_empty() {
        return String::new();
    }
    let lines = history
        .iter()
        .map(|(role, text)| format!("{}: {text}", if role == "user" { "user" } else { "ai" }))
        .collect::<Vec<_>>()
        .join("\n");
    format!("Conversation so far:\n{lines}\n\n")
}

async fn decide(
    cfg: &AgentConfig,
    call: &ChatCall,
) -> Result<Value, AgentFailure> {
    match chat_json(&cfg.decision, call).await {
        Ok(value) => Ok(value),
        Err(error) => {
            if cfg.llm.model == cfg.decision.model {
                return Err(AgentFailure::Llm(error));
            }
            tracing::error!("[ai] step 'decision' failed: {error}");
            Ok(chat_json(&cfg.llm, call).await?)
        }
    }
}

async fn gen_json(cfg: &AgentConfig, call: &ChatCall) -> Result<Value, AgentFailure> {
    match chat_json(&cfg.llm, call).await {
        Ok(value) => Ok(value),
        Err(error) => {
            tracing::error!("[ai] step 'generate' failed: {error}");
            let Some(fallback) = &cfg.llm_fallback else {
                return Err(AgentFailure::Llm(error));
            };
            Ok(chat_json(fallback, call).await?)
        }
    }
}

async fn gen_text(cfg: &AgentConfig, call: &ChatCall) -> Result<String, AgentFailure> {
    match chat_complete(&cfg.llm, call).await {
        Ok(value) => Ok(value),
        Err(error) => {
            tracing::error!("[ai] step 'guide' failed: {error}");
            let Some(fallback) = &cfg.llm_fallback else {
                return Err(AgentFailure::Llm(error));
            };
            Ok(chat_complete(fallback, call).await?)
        }
    }
}

pub async fn run_agent(
    question: &str,
    cfg: &AgentConfig,
    history: &[(String, String)],
) -> Result<AgentResult, AgentFailure> {
    if question.trim().is_empty() || question.chars().count() > MAX_QUESTION_LEN {
        return Err(AgentFailure::Agent(AgentError::new(
            "invalid_question",
            format!("question must be 1..{MAX_QUESTION_LEN} chars"),
        )));
    }
    let convo = history_prefix(history);
    let catalog_json =
        serde_json::to_string(catalog()).unwrap_or_else(|_| "[]".to_string());

    let decision_call = ChatCall {
        system: DECISION_SYSTEM.to_string(),
        user: format!("{convo}Catalog:\n{catalog_json}\n\nQuestion: {question}"),
        max_tokens: 2048,
    };
    let decision = decide(cfg, &decision_call).await?;
    let method = decision
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let path = decision
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let reason = truncate_chars(
        decision
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or(""),
        MAX_STR,
    );

    if method.is_empty() || path.is_empty() {
        let slim = catalog()
            .iter()
            .map(|entry| {
                json!({
                    "method": entry.method,
                    "path": entry.path,
                    "desc": entry.desc,
                })
            })
            .collect::<Vec<_>>();
        let slim_json = serde_json::to_string(&slim).unwrap_or_else(|_| "[]".into());
        let raw = gen_text(
            cfg,
            &ChatCall {
                system: GUIDE_SYSTEM.to_string(),
                user: format!("{convo}Catalog:\n{slim_json}\n\nQuestion: {question}"),
                max_tokens: 2048,
            },
        )
        .await?;
        let answer = truncate_chars(&strip_fences(&raw), MAX_GUIDANCE);
        if answer.trim().is_empty() {
            return Err(AgentFailure::Agent(AgentError::new(
                "invalid_output",
                "guide model returned no answer",
            )));
        }
        return Ok(AgentResult {
            ok: true,
            method: String::new(),
            path: String::new(),
            auth: String::new(),
            path_values: Map::new(),
            body: None,
            explanation: truncate_chars(&answer, MAX_EXPLANATION),
            reason,
            guidance: Some(answer),
        });
    }

    let Some(endpoint) = find_endpoint(&method, &path) else {
        return Err(AgentFailure::Agent(AgentError::new(
            "endpoint_not_found",
            format!(
                "no catalog endpoint matches {method} {path} — {}",
                if reason.is_empty() {
                    "decision model returned an unknown endpoint".to_string()
                } else {
                    reason.clone()
                }
            ),
        )));
    };

    let gen_call = ChatCall {
        system: GENERATE_SYSTEM.to_string(),
        user: [
            format!("{convo}Endpoint: {} {}", endpoint.method, endpoint.path),
            format!("Description: {}", endpoint.desc),
            format!(
                "Example body: {}",
                serde_json::to_string(endpoint.body.as_ref().unwrap_or(&json!({})))
                    .unwrap_or_else(|_| "{}".into())
            ),
            format!("Question: {question}"),
        ]
        .join("\n"),
        max_tokens: 2048,
    };
    let generated = gen_json(cfg, &gen_call).await?;

    let params = path_params(&endpoint.path);
    let path_values = generated.get("pathValues").ok_or_else(|| {
        AgentFailure::Agent(AgentError::new("invalid_output", "missing pathValues"))
    })?;
    if !path_values.is_object() {
        return Err(AgentFailure::Agent(AgentError::new(
            "invalid_output",
            "pathValues must be an object",
        )));
    }
    let mut values = Map::new();
    for (key, value) in path_values.as_object().unwrap() {
        if !params.contains(key) {
            return Err(AgentFailure::Agent(AgentError::new(
                "invalid_output",
                format!(
                    "pathValues key '{key}' is not a path param of {} (expected: {})",
                    endpoint.path,
                    if params.is_empty() {
                        "none".to_string()
                    } else {
                        params.join(", ")
                    }
                ),
            )));
        }
        let valid = value
            .as_str()
            .map(|text| !text.trim().is_empty() && text.chars().count() <= MAX_STR)
            .unwrap_or(false);
        if !valid {
            return Err(AgentFailure::Agent(AgentError::new(
                "invalid_output",
                format!("pathValues['{key}'] must be a non-empty string ≤{MAX_STR} chars"),
            )));
        }
        values.insert(
            key.clone(),
            Value::String(value.as_str().unwrap().trim().to_string()),
        );
    }
    let missing = params
        .iter()
        .filter(|param| !values.contains_key(param.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(AgentFailure::Agent(AgentError::new(
            "invalid_output",
            format!(
                "pathValues missing required params of {}: {}",
                endpoint.path,
                missing.join(", ")
            ),
        )));
    }

    let mut body_value: Option<Value> = None;
    if endpoint.method != "GET" || endpoint.body.is_some() {
        let raw_body = match generated.get("body") {
            None | Some(Value::Null) => json!({}),
            Some(value) => value.clone(),
        };
        if !raw_body.is_object() {
            return Err(AgentFailure::Agent(AgentError::new(
                "invalid_output",
                "body must be a JSON object",
            )));
        }
        let size = serde_json::to_string(&raw_body)
            .map(|text| text.len())
            .unwrap_or(0);
        if size > MAX_BODY_BYTES {
            return Err(AgentFailure::Agent(AgentError::new(
                "invalid_output",
                format!("body exceeds {MAX_BODY_BYTES} bytes"),
            )));
        }
        body_value = Some(raw_body);
    }

    let explanation = generated
        .get("explanation")
        .and_then(Value::as_str)
        .map(|text| truncate_chars(text, MAX_EXPLANATION))
        .unwrap_or_default();

    Ok(AgentResult {
        ok: true,
        method: endpoint.method.clone(),
        path: endpoint.path.clone(),
        auth: endpoint.auth.clone(),
        path_values: values,
        body: body_value,
        explanation,
        reason,
        guidance: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_the_typescript_source() {
        let catalog = catalog();
        assert_eq!(catalog.len(), 219);
        let first = &catalog[0];
        assert_eq!(first.method, "POST");
        assert_eq!(first.path, "/v1/auth/login");
        assert_eq!(catalog.last().unwrap().path, "/");
    }

    #[test]
    fn extracts_path_params() {
        assert_eq!(
            path_params("/v1/base/collections/:collection/documents/:id"),
            vec!["collection", "id"]
        );
        assert!(path_params("/v1/health").is_empty());
    }
}
