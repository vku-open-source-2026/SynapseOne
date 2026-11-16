// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse inference proxy: chat completions, embeddings, decision and routing.

use crate::client::{Client, Request};
use crate::error::Result;
use serde_json::{json, Value};
use std::time::Duration;

const PREFIX: &str = "/v1/inference";
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(120);

/// Inference service handle.
#[derive(Clone)]
pub struct InferenceService {
    client: Client,
}

impl InferenceService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn health(&self) -> Result<Value> {
        let request = Request::get(format!("{PREFIX}/health")).timeout(INFERENCE_TIMEOUT);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn chat(
        &self,
        messages: Value,
        model: Option<&str>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
        extra: Option<Value>,
    ) -> Result<Value> {
        let mut body = extra.unwrap_or_else(|| json!({}));
        body["messages"] = messages;
        body["stream"] = json!(false);
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        if let Some(temperature) = temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        let request = Request::post(format!("{PREFIX}/chat/completions"))
            .json(Some(body))
            .timeout(INFERENCE_TIMEOUT);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    /// Stream raw SSE records (buffered into one value by the transport).
    ///
    /// Use [`Self::chat_text`] to extract the incremental assistant text.
    pub async fn chat_stream(
        &self,
        messages: Value,
        model: Option<&str>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
        extra: Option<Value>,
    ) -> Result<Value> {
        let mut body = extra.unwrap_or_else(|| json!({}));
        body["messages"] = messages;
        body["stream"] = json!(true);
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        if let Some(temperature) = temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        let request = Request::post(format!("{PREFIX}/chat/completions"))
            .json(Some(body))
            .timeout(INFERENCE_TIMEOUT);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    /// Extract incremental assistant text from an SSE chat stream.
    pub async fn chat_text(
        &self,
        messages: Value,
        model: Option<&str>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
        extra: Option<Value>,
    ) -> Result<String> {
        let raw = self
            .chat_stream(messages, model, temperature, max_tokens, extra)
            .await?;
        Ok(extract_sse_text(&raw))
    }

    pub async fn embeddings(&self, input: Value, model: Option<&str>) -> Result<Value> {
        let mut body = json!({ "input": input });
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        let request = Request::post(format!("{PREFIX}/embeddings"))
            .json(Some(body))
            .timeout(INFERENCE_TIMEOUT);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn decision(&self, state: &str, questions: Value) -> Result<Value> {
        let request = Request::post(format!("{PREFIX}/decision"))
            .json(Some(json!({ "state": state, "questions": questions })))
            .timeout(INFERENCE_TIMEOUT);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn route(
        &self,
        input_text: &str,
        choices: Value,
        instruction: &str,
    ) -> Result<Value> {
        let mut body = json!({ "input": input_text, "choices": choices });
        if !instruction.is_empty() {
            body["instruction"] = json!(instruction);
        }
        let request = Request::post(format!("{PREFIX}/decision/route"))
            .json(Some(body))
            .timeout(INFERENCE_TIMEOUT);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }
}

fn extract_sse_text(raw: &Value) -> String {
    let text = match raw {
        Value::String(text) => text.as_str(),
        _ => return String::new(),
    };
    let mut output = String::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim_start();
            if data == "[DONE]" {
                break;
            }
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(delta) = value
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|choices| choices.first())
                    .and_then(|choice| choice.get("delta"))
                    .and_then(|delta| delta.get("content"))
                    .and_then(Value::as_str)
                {
                    output.push_str(delta);
                }
            }
        }
    }
    output
}
