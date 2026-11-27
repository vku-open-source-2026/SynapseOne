// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Authentication: local HS256 JWT verification, IAM session revocation check,
//! and fail-closed API-key verification against IAM.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, StatusCode};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::routes::{AuthMode, RouteRule};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Principal {
    /// `jwt` or `apikey`.
    pub r#type: String,
    pub kind: Option<String>,
    pub sub: Option<String>,
    /// Authorization scope. Service accounts deliberately keep this None.
    pub org: Option<String>,
    /// Verified owning org used only for quota/usage attribution and trusted
    /// downstream quota checks; never stamped as authorization scope.
    pub attribution_org: Option<String>,
    pub account: Option<String>,
    pub scopes: Vec<String>,
    pub key_id: Option<String>,
    #[allow(dead_code)]
    pub owner: Option<String>,
    /// Platform-runner machine credentials are bound to one registration.
    /// For `exec-delegated` JWTs this is the runner claim.
    pub runner_id: Option<String>,
    /// Per-execution delegated grant id (`jti`) and bounds.
    pub jti: Option<String>,
    pub exec: Option<String>,
    pub instance: Option<String>,
    /// `act.sub` for delegated tokens (service/runner that acted for the user).
    pub act_sub: Option<String>,
    /// Org-administrator snapshot from the IAM session (JWT `adm`).
    pub org_admin: bool,
    /// Role slugs snapshot from the IAM session (JWT `roles`).
    pub roles: Vec<String>,
}

impl Principal {
    pub fn kind_or_user(&self) -> String {
        self.kind.clone().unwrap_or_else(|| "user".into())
    }
}

#[derive(Clone, Debug)]
pub struct AuthFailure {
    pub status: StatusCode,
    pub error: String,
    pub message: String,
}

impl AuthFailure {
    fn new(status: StatusCode, error: &str, message: &str) -> Self {
        Self {
            status,
            error: error.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiKeyInfo {
    pub id: Option<String>,
    pub account_id: Option<String>,
    pub org_id: Option<String>,
    pub user_id: Option<String>,
    pub scopes: Vec<String>,
    /// `platform-runner` for owner-scoped system compute keys; absent for
    /// ordinary tenant API keys.
    pub kind: Option<String>,
    pub runner_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRejection {
    pub status: u16,
    pub error: String,
}

#[derive(Default)]
pub struct SessionValidation {
    pub rejection: Option<SessionRejection>,
    /// Returned directly for this request, independent of authorization cache TTL.
    pub attribution_org: Option<String>,
}

struct SessionCacheEntry {
    expires: Instant,
    status: u16,
    error: String,
    attribution_org: Option<String>,
}

pub struct AuthService {
    pub jwt_secret: String,
    pub issuers: Vec<String>,
    pub iam_base: String,
    pub internal_secret: String,
    pub verify_api_key: bool,
    pub is_prod: bool,
    pub session_cache_ttl: Duration,
    client: reqwest::Client,
    session_cache: Mutex<HashMap<String, SessionCacheEntry>>,
}

impl AuthService {
    pub fn new(config: &Config, client: reqwest::Client) -> Self {
        Self {
            jwt_secret: config.jwt_secret.clone(),
            issuers: config.jwt_issuers.clone(),
            iam_base: config.iam_service_url.trim_end_matches('/').to_string(),
            internal_secret: config.internal_secret.clone(),
            verify_api_key: config.verify_api_key,
            is_prod: config.is_prod,
            session_cache_ttl: config.session_cache_ttl,
            client,
            session_cache: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    pub fn clear_session_cache(&self) {
        self.session_cache.lock().expect("session cache").clear();
    }

    fn verified_principal(&self, claims: &Value, attribution_org: Option<String>) -> Principal {
        let mut principal = principal_from_claims(claims);
        if principal.kind.as_deref() == Some("service-account") {
            // Machine identities remain account-bound for authorization. The
            // owning org is attribution-only and must never widen access.
            principal.org = None;
        }
        principal.attribution_org = attribution_org;
        principal
    }

    /// Verify the JWT and IAM session, then return the verified principal.
    /// Revoked/absent optional credentials on a `none` route stay anonymous;
    /// required credentials fail closed.
    pub async fn authenticate(
        &self,
        route: &RouteRule,
        headers: &HeaderMap,
    ) -> Result<Option<Principal>, AuthFailure> {
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let has_bearer = authorization.starts_with("Bearer ");
        let bearer = if has_bearer {
            &authorization["Bearer ".len()..]
        } else {
            ""
        };
        let mut api_key = headers
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();

        match route.auth {
            AuthMode::None => {
                // Optional auth: invalid/revoked credentials do not downgrade the
                // request below anonymous, but never grant tenant access either.
                if !bearer.is_empty() {
                    if let Ok(claims) = self.verify_jwt(bearer) {
                        if claims.get("kind").and_then(Value::as_str) == Some("platform-step-up") {
                            return Err(AuthFailure::new(
                                StatusCode::UNAUTHORIZED,
                                "invalid_token",
                                "step-up token is not an access token",
                            ));
                        }
                        // A revoked token falls back to anonymous and must not
                        // then be re-used as an API key.
                        let validation = self.validate_jwt_session_detailed(bearer, &claims).await;
                        return if validation.rejection.is_none() {
                            Ok(Some(self.verified_principal(&claims, validation.attribution_org)))
                        } else {
                            Ok(None)
                        };
                    }
                }
                if api_key.is_empty() {
                    api_key = bearer.to_string();
                }
                if !api_key.is_empty() && self.verify_api_key {
                    if let Ok(Some(info)) = self.verify_api_key_upstream(&api_key).await {
                        return Ok(Some(principal_from_api_key(info)));
                    }
                }
                Ok(None)
            }
            AuthMode::Jwt | AuthMode::Either => {
                if api_key.is_empty() && has_bearer && route.auth == AuthMode::Either {
                    // MCP/CLI clients often only support Authorization: Bearer.
                    // For `either` routes, Bearer <api-key> is the key fallback.
                    api_key = bearer.to_string();
                }
                if has_bearer {
                    match self.verify_jwt(bearer) {
                        Ok(claims) => {
                            if claims.get("kind").and_then(Value::as_str)
                                == Some("platform-step-up")
                            {
                                return Err(AuthFailure::new(
                                    StatusCode::UNAUTHORIZED,
                                    "invalid_token",
                                    "step-up token is not an access token",
                                ));
                            }
                            let validation = self.validate_jwt_session_detailed(bearer, &claims).await;
                            if let Some(rejected) = validation.rejection {
                                let message = match rejected.error.as_str() {
                                    "iam_unavailable" => "IAM session check unavailable",
                                    "org_suspended" => "This organization is suspended.",
                                    "service_account_revoked" => {
                                        "This service account was revoked."
                                    }
                                    _ => "This session was revoked. Sign in again.",
                                };
                                return Err(AuthFailure::new(
                                    StatusCode::from_u16(rejected.status)
                                        .unwrap_or(StatusCode::UNAUTHORIZED),
                                    &rejected.error,
                                    message,
                                ));
                            }
                            return Ok(Some(self.verified_principal(&claims, validation.attribution_org)));
                        }
                        Err(_) => {
                            if route.auth == AuthMode::Jwt {
                                return Err(AuthFailure::new(
                                    StatusCode::UNAUTHORIZED,
                                    "invalid_token",
                                    "JWT invalid or expired",
                                ));
                            }
                            // `either`: fallthrough to API-key verification.
                        }
                    }
                }
                if route.auth == AuthMode::Jwt {
                    return Err(AuthFailure::new(
                        StatusCode::UNAUTHORIZED,
                        "unauthorized",
                        "Provide Bearer JWT and/or X-API-Key",
                    ));
                }
                self.authenticate_api_key(route, &api_key).await
            }
            AuthMode::ApiKey => {
                // Runner/CLI credentials may be presented as Bearer <api-key>.
                // This remains API-key-only: a JWT is sent to IAM key
                // verification and rejected, never accepted as a user session.
                if api_key.is_empty() {
                    api_key = bearer.to_string();
                }
                self.authenticate_api_key(route, &api_key).await
            }
        }
    }

    async fn authenticate_api_key(
        &self,
        route: &RouteRule,
        api_key: &str,
    ) -> Result<Option<Principal>, AuthFailure> {
        if !api_key.is_empty() {
            // Fail-closed by default: verify API keys against IAM.
            if self.verify_api_key {
                return match self.verify_api_key_upstream(api_key).await {
                    Ok(Some(info)) => Ok(Some(principal_from_api_key(info))),
                    Ok(None) => Err(AuthFailure::new(
                        StatusCode::UNAUTHORIZED,
                        "invalid_api_key",
                        "",
                    )),
                    Err(_) => Err(AuthFailure::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "iam_unavailable",
                        "",
                    )),
                };
            }
            if self.is_prod {
                return Err(AuthFailure::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "misconfigured",
                    "GATEWAY_VERIFY_APIKEY=false is forbidden in production",
                ));
            }
            tracing::warn!(
                "[gateway][security] accepting unverified X-API-Key (GATEWAY_VERIFY_APIKEY=false, dev only)"
            );
            return Ok(Some(Principal {
                r#type: "apikey".into(),
                ..Principal::default()
            }));
        }
        if route.auth == AuthMode::ApiKey {
            return Err(AuthFailure::new(
                StatusCode::UNAUTHORIZED,
                "missing_api_key",
                "X-API-Key required",
            ));
        }
        Err(AuthFailure::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Provide Bearer JWT and/or X-API-Key",
        ))
    }

    pub fn verify_jwt(&self, token: &str) -> Result<Value, ()> {
        let issuers = self.issuers.iter().map(String::as_str).collect::<Vec<_>>();
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&issuers);
        // Node's jsonwebtoken verifies exp/nbf when present but does not require
        // an exp claim; keep that behaviour, with zero leeway. The issuer stays
        // required (set_issuer inserted `iss`).
        validation.required_spec_claims.remove("exp");
        validation.required_spec_claims.insert("iss".to_string());
        validation.leeway = 0;
        validation.validate_aud = false;
        let data = decode::<Value>(
            token,
            &DecodingKey::from_secret(self.jwt_secret.as_bytes()),
            &validation,
        )
        .map_err(|_| ())?;
        Ok(data.claims)
    }

    /// Ask IAM whether this exact access token is still valid. Positive and
    /// negative results are cached for a very short window. IAM/network
    /// failures fail closed for routes that require authentication.
    pub async fn validate_jwt_session(
        &self,
        token: &str,
        decoded: &Value,
    ) -> Option<SessionRejection> {
        self.validate_jwt_session_detailed(token, decoded).await.rejection
    }

    /// Validate the session and return attribution metadata for this exact
    /// request. At TTL=0 no authorization cache entry is created, but the
    /// verified org is still returned directly to the caller.
    pub async fn validate_jwt_session_detailed(
        &self,
        token: &str,
        decoded: &Value,
    ) -> SessionValidation {
        let claimed_org = claim_text(decoded, "org");
        let kind = decoded.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind == "platform-step-up" || kind == "exec-delegated" {
            return SessionValidation { attribution_org: claimed_org, rejection: None };
        }
        if claim_text(decoded, "sub").filter(|value| !value.is_empty()).is_none() {
            return SessionValidation {
                attribution_org: None,
                rejection: Some(SessionRejection { status: 401, error: "invalid_token".into() }),
            };
        }
        let ttl = self.session_cache_ttl;
        let key = sha256_hex(token);
        let now = Instant::now();
        {
            let mut cache = self.session_cache.lock().expect("session cache");
            if let Some(hit) = cache.get(&key) {
                if hit.expires > now {
                    return SessionValidation {
                        attribution_org: if hit.status == 200 { hit.attribution_org.clone() } else { None },
                        rejection: if hit.status == 200 {
                            None
                        } else {
                            Some(SessionRejection { status: hit.status, error: hit.error.clone() })
                        },
                    };
                }
                cache.remove(&key);
            }
            if cache.len() > 20_000 {
                cache.clear();
            }
        }
        let url = format!("{}/v1/auth/verify", self.iam_base);
        let response = self.client.get(url).bearer_auth(token)
            .timeout(Duration::from_millis(2_500)).send().await;
        match response {
            Ok(response) if response.status().is_success() => {
                let org_id = response.json::<Value>().await.ok().and_then(|body| {
                    body.get("org_id").and_then(Value::as_str).map(str::to_string)
                }).or(claimed_org);
                self.put_session(&key, ttl, 200, "", org_id.clone());
                SessionValidation { attribution_org: org_id, rejection: None }
            }
            Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
                self.put_session(&key, ttl, 401, "token_revoked", None);
                SessionValidation {
                    attribution_org: None,
                    rejection: Some(SessionRejection { status: 401, error: "token_revoked".into() }),
                }
            }
            Ok(response) if response.status() == StatusCode::FORBIDDEN => {
                let error = response.json::<Value>().await.ok().and_then(|body| {
                    body.get("error").and_then(Value::as_str).map(str::to_string)
                }).unwrap_or_else(|| "org_suspended".into());
                self.put_session(&key, ttl, 403, &error, None);
                SessionValidation {
                    attribution_org: None,
                    rejection: Some(SessionRejection { status: 403, error }),
                }
            }
            _ => {
                self.put_session(&key, Duration::from_millis(500), 503, "iam_unavailable", None);
                SessionValidation {
                    attribution_org: None,
                    rejection: Some(SessionRejection { status: 503, error: "iam_unavailable".into() }),
                }
            }
        }
    }

    fn put_session(&self, key: &str, ttl: Duration, status: u16, error: &str, attribution_org: Option<String>) {
        if ttl.is_zero() {
            return;
        }
        let mut cache = self.session_cache.lock().expect("session cache");
        cache.insert(key.to_string(), SessionCacheEntry {
            expires: Instant::now() + ttl,
            status,
            error: error.to_string(),
            attribution_org,
        });
    }

    /// Verify a per-execution delegated grant against IAM on **every** request.
    /// IAM owns the `execution_delegations` row and must return 401/403 once the
    /// execution completes/releases or the runner is revoked. This deliberately
    /// never uses the JWT session cache.
    pub async fn verify_execution_grant(&self, token: &str) -> Result<(), AuthFailure> {
        if token.is_empty() {
            return Err(AuthFailure::new(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "execution grant token is missing",
            ));
        }
        let url = format!("{}/v1/auth/verify", self.iam_base.trim_end_matches('/'));
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_millis(2_500))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                // IAM must positively confirm the grant. Missing/malformed
                // `valid`, or anything other than `true`, fails closed.
                let body = response.json::<Value>().await;
                match body {
                    Ok(body) if body.get("valid").and_then(Value::as_bool) == Some(true) => Ok(()),
                    Ok(body) if body.get("valid").and_then(Value::as_bool) == Some(false) => {
                        Err(AuthFailure::new(
                            StatusCode::UNAUTHORIZED,
                            "execution_grant_inactive",
                            "execution grant is inactive or revoked",
                        ))
                    }
                    _ => Err(AuthFailure::new(
                        StatusCode::UNAUTHORIZED,
                        "execution_grant_invalid",
                        "IAM returned an invalid grant verification response",
                    )),
                }
            }
            Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
                Err(AuthFailure::new(
                    StatusCode::UNAUTHORIZED,
                    "execution_grant_inactive",
                    "execution grant is inactive or revoked",
                ))
            }
            Ok(response) if response.status() == StatusCode::FORBIDDEN => {
                let error = response
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| "execution_grant_forbidden".into());
                Err(AuthFailure::new(
                    StatusCode::FORBIDDEN,
                    &error,
                    "execution grant is no longer valid",
                ))
            }
            _ => Err(AuthFailure::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "iam_unavailable",
                "IAM grant check unavailable",
            )),
        }
    }

    pub async fn verify_api_key_upstream(
        &self,
        api_key: &str,
    ) -> Result<Option<ApiKeyInfo>, String> {
        verify_api_key_upstream(&self.client, &self.iam_base, api_key, &self.internal_secret).await
    }
}

pub async fn verify_api_key_upstream(
    client: &reqwest::Client,
    iam_base: &str,
    api_key: &str,
    internal_secret: &str,
) -> Result<Option<ApiKeyInfo>, String> {
    let iam = iam_base.trim_end_matches('/');
    let mut request = client
        .post(format!("{iam}/v1/keys/verify"))
        .timeout(Duration::from_secs(5))
        .json(&serde_json::json!({ "apiKey": api_key }));
    if !internal_secret.is_empty() {
        request = request.header("x-synapseone-internal", internal_secret);
    }
    let response = request.send().await.map_err(|_| "iam_unreachable")?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await.map_err(|_| "iam_unreachable")?;
    if body.get("valid") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    Ok(Some(ApiKeyInfo {
        id: body.get("id").and_then(Value::as_str).map(str::to_string),
        account_id: body
            .get("account_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        org_id: body
            .get("org_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        user_id: body
            .get("user_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        scopes: body
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        kind: body.get("kind").and_then(Value::as_str).map(str::to_string),
        runner_id: body
            .get("runner_id")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

pub fn principal_from_claims(claims: &Value) -> Principal {
    Principal {
        r#type: "jwt".into(),
        kind: Some(
            claims
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .to_string(),
        ),
        sub: claim_text(claims, "sub"),
        org: claim_text(claims, "org"),
        attribution_org: claim_text(claims, "org"),
        account: claim_text(claims, "account"),
        scopes: claim_string_list(claims, "scopes"),
        key_id: None,
        owner: None,
        runner_id: claim_text(claims, "runner"),
        jti: claim_text(claims, "jti"),
        exec: claim_text(claims, "exec"),
        instance: claim_text(claims, "instance"),
        act_sub: claims
            .get("act")
            .and_then(|act| act.get("sub"))
            .and_then(Value::as_str)
            .map(str::to_string),
        org_admin: claims.get("adm") == Some(&Value::Bool(true)),
        roles: claim_string_list(claims, "roles"),
    }
}

fn principal_from_api_key(info: ApiKeyInfo) -> Principal {
    Principal {
        r#type: "apikey".into(),
        kind: info.kind,
        sub: None,
        org: info.org_id.clone(),
        attribution_org: info.org_id,
        account: info.account_id,
        scopes: info.scopes,
        key_id: info.id,
        owner: info.user_id,
        runner_id: info.runner_id,
        jti: None,
        exec: None,
        instance: None,
        act_sub: None,
        org_admin: false,
        roles: Vec::new(),
    }
}

fn claim_text(claims: &Value, key: &str) -> Option<String> {
    match claims.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn claim_string_list(claims: &Value, key: &str) -> Vec<String> {
    claims
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}
