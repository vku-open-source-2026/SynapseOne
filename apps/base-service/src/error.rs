// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Typed errors shared by the store, query engine and HTTP layer.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreErrorCode {
    Conflict,
    VersionConflict,
    NotFound,
    Invalid,
}

#[derive(Debug, Clone)]
pub struct StoreError {
    pub code: StoreErrorCode,
    pub message: String,
}

impl StoreError {
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: StoreErrorCode::Conflict,
            message: message.into(),
        }
    }

    pub fn version_conflict(message: impl Into<String>) -> Self {
        Self {
            code: StoreErrorCode::VersionConflict,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: StoreErrorCode::NotFound,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: StoreErrorCode::Invalid,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone)]
pub struct MappingError {
    pub message: String,
    pub details: Option<Box<Value>>,
}

impl MappingError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(message: impl Into<String>, details: Value) -> Self {
        Self {
            message: message.into(),
            details: Some(Box::new(details)),
        }
    }
}

impl std::fmt::Display for MappingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<MappingError> for ApiError {
    fn from(value: MappingError) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, "mapping_error", value.message)
            .with_details_opt(value.details.map(|details| *details))
    }
}

#[derive(Debug, Clone)]
pub struct QueryError {
    pub message: String,
}

impl QueryError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<QueryError> for ApiError {
    fn from(value: QueryError) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid_query", value.message)
    }
}

/// Database/unexpected failure: handlers never leak internal messages.
#[derive(Debug, Clone)]
pub struct InternalError(pub String);

impl std::fmt::Display for InternalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<sqlx::Error> for InternalError {
    fn from(value: sqlx::Error) -> Self {
        InternalError(value.to_string())
    }
}

impl From<StoreError> for InternalError {
    fn from(value: StoreError) -> Self {
        InternalError(value.message)
    }
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub error: String,
    pub message: Option<String>,
    pub details: Option<Box<Value>>,
}

impl ApiError {
    pub fn new(status: StatusCode, error: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            error: error.to_string(),
            message: Some(message.into()),
            details: None,
        }
    }

    pub fn code(status: StatusCode, error: &str) -> Self {
        Self {
            status,
            error: error.to_string(),
            message: None,
            details: None,
        }
    }

    pub fn with_details_opt(mut self, details: Option<Value>) -> Self {
        self.details = details.map(Box::new);
        self
    }

    pub fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error: "internal".into(),
            message: Some("unexpected error".into()),
            details: None,
        }
    }

    pub fn unauthorized_internal() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Missing or invalid internal credential",
        )
    }

    pub fn auth_required() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "SynapseBase requires an authenticated caller",
        )
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn body(&self) -> Value {
        let mut body = serde_json::Map::new();
        body.insert("error".into(), Value::String(self.error.clone()));
        if let Some(message) = &self.message {
            body.insert("message".into(), Value::String(message.clone()));
        }
        if let Some(details) = &self.details {
            body.insert("details".into(), (**details).clone());
        }
        Value::Object(body)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body())).into_response()
    }
}

impl From<String> for ApiError {
    fn from(value: String) -> Self {
        ApiError::from(InternalError(value))
    }
}

impl From<InternalError> for ApiError {
    fn from(value: InternalError) -> Self {
        tracing::error!("[base] internal error: {}", value.0);
        ApiError::internal()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(value: sqlx::Error) -> Self {
        ApiError::from(InternalError(value.to_string()))
    }
}
