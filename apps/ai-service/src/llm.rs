// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! OpenAI-compatible chat client. The API key stays server-side — it is NEVER
//! sent to the browser.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct LlmError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout_ms: u64,
    pub retries: u32,
}

#[derive(Debug, Clone)]
pub struct ChatCall {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
}

const RETRY_DELAY_MS: u64 = 500;
const MAX_ATTEMPTS: u32 = 4;
/// Never buffer more than this from the LLM: a misbehaving provider must not
/// be able to OOM the service before validation even runs.
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

fn fenced_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)```(?:json)?\s*(.*?)```").expect("fence regex"))
}

fn whole_fence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)^```(?:json)?\s*(.*?)```$").expect("fence regex"))
}

/// Strip markdown fences some models wrap JSON in.
pub fn extract_json(raw: &str) -> String {
    let trimmed = raw.trim();
    match fenced_re().captures(trimmed) {
        Some(caps) => caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_else(|| trimmed.to_string()),
        None => trimmed.to_string(),
    }
}

/// Strip fences ONLY when the whole reply is fenced (guide answers may
/// legitimately contain fenced examples mid-text — those must be kept).
pub fn strip_fences(raw: &str) -> String {
    let trimmed = raw.trim();
    match whole_fence_re().captures(trimmed) {
        Some(caps) => caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_else(|| trimmed.to_string()),
        None => trimmed.to_string(),
    }
}

fn max_attempts(cfg: &LlmConfig) -> u32 {
    (1 + cfg.retries).clamp(1, MAX_ATTEMPTS)
}

fn is_retryable(error: &LlmError) -> bool {
    error.status >= 500 || error.status == 429 || error.status == 408
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client")
    })
}

async fn chat_complete_once(cfg: &LlmConfig, call: &ChatCall) -> Result<String, LlmError> {
    let url = format!(
        "{}/chat/completions",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": call.system },
            { "role": "user", "content": call.user },
        ],
        "temperature": 0.2,
        "max_tokens": call.max_tokens,
    });
    let response = client()
        .post(&url)
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&body)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if error.is_timeout() {
                return Err(LlmError {
                    status: 504,
                    message: format!("LLM timed out after {}ms", cfg.timeout_ms),
                });
            }
            return Err(LlmError {
                status: 502,
                message: format!("LLM unreachable: {error}"),
            });
        }
    };

    let status = response.status();
    if let Some(declared) = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if declared > MAX_RESPONSE_BYTES {
            return Err(LlmError {
                status: 502,
                message: format!(
                    "LLM response declares {declared} bytes (cap {MAX_RESPONSE_BYTES}) — dropped"
                ),
            });
        }
    }
    let text = response.text().await.map_err(|error| LlmError {
        status: 502,
        message: format!("LLM unreachable: {error}"),
    })?;
    if !status.is_success() {
        let mut message = text.chars().take(200).collect::<String>();
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(detail) = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
            {
                message = detail.to_string();
            }
        }
        return Err(LlmError {
            status: status.as_u16(),
            message: format!("LLM {}: {message}", status.as_u16()),
        });
    }
    if text.len() > MAX_RESPONSE_BYTES {
        return Err(LlmError {
            status: 502,
            message: format!("LLM response exceeds {MAX_RESPONSE_BYTES} bytes — dropped before parsing"),
        });
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|_| LlmError {
        status: 502,
        message: "LLM returned invalid JSON".into(),
    })?;
    let content = parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if content.is_empty() {
        return Err(LlmError {
            status: 502,
            message: "LLM returned no content".into(),
        });
    }
    Ok(content.to_string())
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

pub async fn chat_complete(cfg: &LlmConfig, call: &ChatCall) -> Result<String, LlmError> {
    let attempts = max_attempts(cfg);
    let mut last = LlmError {
        status: 502,
        message: "LLM returned no content".into(),
    };
    for index in 0..attempts {
        if index > 0 {
            sleep_ms(RETRY_DELAY_MS * index as u64).await;
        }
        match chat_complete_once(cfg, call).await {
            Ok(content) if !content.trim().is_empty() => return Ok(content),
            Ok(_) => {
                last = LlmError {
                    status: 502,
                    message: "LLM returned no content".into(),
                };
            }
            Err(error) => {
                if !is_retryable(&error) {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    Err(last)
}

/// chatComplete + strict JSON-object parse (models must reply with JSON).
pub async fn chat_json(cfg: &LlmConfig, call: &ChatCall) -> Result<Value, LlmError> {
    let attempts = max_attempts(cfg);
    let mut last = LlmError {
        status: 502,
        message: "LLM did not return valid JSON".into(),
    };
    for index in 0..attempts {
        if index > 0 {
            sleep_ms(RETRY_DELAY_MS * index as u64).await;
        }
        match chat_complete_once(cfg, call).await {
            Ok(raw) => match serde_json::from_str::<Value>(&extract_json(&raw)) {
                Ok(value) if value.is_object() => return Ok(value),
                _ => {
                    last = LlmError {
                        status: 502,
                        message: "LLM did not return valid JSON".into(),
                    };
                }
            },
            Err(error) => {
                if !is_retryable(&error) {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_strips_fences() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(extract_json("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_fences("```\nhello\n```"), "hello");
        assert_eq!(strip_fences("text ```x``` text"), "text ```x``` text");
    }
}
