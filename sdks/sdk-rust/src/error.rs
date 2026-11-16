// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Error type shared by every SynapseOne service.

use serde_json::Value;
use std::fmt;

/// Result alias used throughout the SDK.
pub type Result<T> = std::result::Result<T, Error>;

/// Every failure surfaced by the SDK.
///
/// HTTP errors retain the status code and the parsed response body so callers
/// can branch on platform error codes such as `not_found` or
/// `version_conflict`, exactly like the Python/JS/Go SDKs.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The gateway returned a non-success HTTP status.
    #[error("synapseone {status} {path}: {message} (base {base_url})")]
    Http {
        status: u16,
        path: String,
        message: String,
        code: Option<String>,
        body: Option<Value>,
        base_url: String,
        retry_after: Option<std::time::Duration>,
    },

    /// The request never produced an HTTP response (DNS, TLS, timeout, ...).
    #[error("synapseone network {path}: {source} (base {base_url})")]
    Network {
        path: String,
        base_url: String,
        #[source]
        source: reqwest::Error,
    },

    /// The upstream answered with HTML (usually a console host instead of the API).
    #[error(
        "synapseone expected JSON from {base_url}{path} but received HTML (status {status}); \
         the base URL looks like the console/marketing host"
    )]
    NonJsonResponse {
        status: u16,
        path: String,
        base_url: String,
        body: String,
    },

    /// The client was built with an invalid configuration.
    #[error("invalid synapseone configuration: {0}")]
    Config(String),

    /// Serializing a request body or parsing a response failed.
    #[error("synapseone JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// A header value could not be constructed.
    #[error("synapseone header error: {0}")]
    Header(#[from] http::header::InvalidHeaderValue),
}

impl Error {
    /// HTTP status code, when the error came from a response.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Http { status, .. } | Error::NonJsonResponse { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Machine-readable error code (`not_found`, `version_conflict`, ...).
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Http { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    /// Parsed error body, when one was returned.
    pub fn body(&self) -> Option<&Value> {
        match self {
            Error::Http { body, .. } => body.as_ref(),
            _ => None,
        }
    }

    /// Base URL the failed request was sent to.
    pub fn base_url(&self) -> Option<&str> {
        match self {
            Error::Http { base_url, .. }
            | Error::Network { base_url, .. }
            | Error::NonJsonResponse { base_url, .. } => Some(base_url),
            _ => None,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.status() == Some(404)
    }

    pub fn is_conflict(&self) -> bool {
        self.status() == Some(409)
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(401)
    }

    pub fn is_forbidden(&self) -> bool {
        self.status() == Some(403)
    }

    pub fn is_retryable_status(&self) -> bool {
        matches!(self.status(), Some(429 | 502 | 503 | 504))
    }
}

impl From<reqwest::Error> for Error {
    fn from(source: reqwest::Error) -> Self {
        Error::Network {
            path: String::new(),
            base_url: String::new(),
            source,
        }
    }
}

/// A compact, redacted view of an error for logs.
pub struct ErrorSummary<'a>(pub &'a Error);

impl fmt::Display for ErrorSummary<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Error::Http {
                status,
                path,
                code,
                base_url,
                ..
            } => write!(
                f,
                "http {status} {path} code={} base={base_url}",
                code.as_deref().unwrap_or("-")
            ),
            other => write!(f, "{other}"),
        }
    }
}
