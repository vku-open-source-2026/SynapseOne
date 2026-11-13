// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse AI assistant (`/v1/ai`).

use crate::client::Client;
use crate::error::Result;
use serde_json::{json, Value};

/// AI service handle.
#[derive(Clone)]
pub struct AiService {
    client: Client,
}

impl AiService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    /// Ask the API-docs assistant a question (1..2000 chars).
    pub async fn agent(&self, question: &str, history: Option<Value>) -> Result<Value> {
        let mut body = json!({ "question": question });
        if let Some(history) = history {
            body["history"] = history;
        }
        self.client.post("/v1/ai/agent", body).await
    }
}
