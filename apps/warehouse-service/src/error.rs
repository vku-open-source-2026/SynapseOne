// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Stable error envelope shared by every route.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct WarehouseError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl WarehouseError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_request(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for WarehouseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WarehouseError {}

impl IntoResponse for WarehouseError {
    fn into_response(self) -> Response {
        let mut body = json!({
            "error": self.code,
            "message": self.message,
        });
        if let (Some(details), Some(object)) = (self.details, body.as_object_mut()) {
            object.insert("details".into(), details);
        }
        (self.status, Json(body)).into_response()
    }
}

/// Hide implementation details from clients, matching the TS 500 envelope.
pub fn internal_error(context: impl std::fmt::Display) -> WarehouseError {
    tracing::error!("[warehouse] {context}");
    WarehouseError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "internal error",
    )
}
