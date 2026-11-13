// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse IAM: auth, MFA, OIDC, orgs/accounts/users, authorization, API keys,
//! credentials, roles, policies, service accounts and SCIM tokens.

use crate::client::{query_string, segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

/// IAM service handle.
#[derive(Clone)]
pub struct IamService {
    client: Client,
}

impl IamService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    // ---- auth ----------------------------------------------------------

    pub async fn login(&self, email: &str, org_slug: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/login",
                json!({ "email": email, "orgSlug": org_slug }),
            )
            .await
    }

    pub async fn register(
        &self,
        email: &str,
        password: &str,
        org_slug: &str,
        display_name: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "email": email,
            "password": password,
            "orgSlug": org_slug,
        });
        if let Some(display_name) = display_name {
            body["displayName"] = json!(display_name);
        }
        self.client.post("/v1/auth/register", body).await
    }

    pub async fn login_with_password(
        &self,
        email: &str,
        password: &str,
        org_slug: &str,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/login",
                json!({ "email": email, "password": password, "orgSlug": org_slug }),
            )
            .await
    }

    pub async fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/password/change",
                json!({ "currentPassword": current_password, "newPassword": new_password }),
            )
            .await
    }

    pub async fn request_password_reset(&self, email: &str, org_slug: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/password/forgot",
                json!({ "email": email, "orgSlug": org_slug }),
            )
            .await
    }

    pub async fn reset_password(&self, token: &str, new_password: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/password/reset",
                json!({ "token": token, "newPassword": new_password }),
            )
            .await
    }

    pub async fn verify_email(&self, token: &str) -> Result<Value> {
        self.client
            .post("/v1/auth/email/verify", json!({ "token": token }))
            .await
    }

    pub async fn request_email_verification(&self) -> Result<Value> {
        self.client
            .post("/v1/auth/email/verify/request", json!({}))
            .await
    }

    pub async fn list_sessions(&self) -> Result<Value> {
        self.client.get("/v1/auth/sessions").await
    }

    pub async fn revoke_session(&self, session_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/auth/sessions/{}", segment(session_id)))
            .await
    }

    // ---- MFA -----------------------------------------------------------

    pub async fn verify_mfa(
        &self,
        mfa_token: &str,
        code: Option<&str>,
        recovery_code: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "mfaToken": mfa_token });
        if let Some(code) = code {
            body["code"] = json!(code);
        }
        if let Some(recovery_code) = recovery_code {
            body["recoveryCode"] = json!(recovery_code);
        }
        self.client.post("/v1/auth/mfa/verify", body).await
    }

    pub async fn mfa_status(&self) -> Result<Value> {
        self.client.get("/v1/auth/mfa").await
    }

    pub async fn setup_totp(&self) -> Result<Value> {
        self.client.post("/v1/auth/mfa/totp/setup", json!({})).await
    }

    pub async fn enable_totp(&self, code: &str) -> Result<Value> {
        self.client
            .post("/v1/auth/mfa/totp/enable", json!({ "code": code }))
            .await
    }

    pub async fn regenerate_recovery_codes(&self) -> Result<Value> {
        self.client
            .post("/v1/auth/mfa/recovery-codes", json!({}))
            .await
    }

    pub async fn disable_mfa(&self, code: &str) -> Result<Value> {
        self.client
            .post("/v1/auth/mfa/disable", json!({ "code": code }))
            .await
    }

    pub async fn reset_user_mfa(&self, user_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/users/{}/mfa", segment(user_id)))
            .await
    }

    pub async fn unlock_user(&self, user_id: &str) -> Result<Value> {
        self.client
            .post(format!("/v1/users/{}/unlock", segment(user_id)), json!({}))
            .await
    }

    // ---- token exchange / sessions ------------------------------------

    pub async fn exchange_token(
        &self,
        user_id: &str,
        account_id: Option<&str>,
        org_id: Option<&str>,
        scopes: Option<Vec<String>>,
        audience: Option<&str>,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "userId": user_id });
        if let Some(account_id) = account_id {
            body["accountId"] = json!(account_id);
        }
        if let Some(org_id) = org_id {
            body["orgId"] = json!(org_id);
        }
        if let Some(scopes) = scopes {
            body["scopes"] = json!(scopes);
        }
        if let Some(audience) = audience {
            body["audience"] = json!(audience);
        }
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client.post("/v1/auth/exchange", body).await
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<Value> {
        self.client
            .post("/v1/auth/refresh", json!({ "refreshToken": refresh_token }))
            .await
    }

    pub async fn logout(&self, refresh_token: &str) -> Result<Value> {
        self.client
            .post("/v1/auth/logout", json!({ "refreshToken": refresh_token }))
            .await
    }

    pub async fn logout_all(&self, refresh_token: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/logout-all",
                json!({ "refreshToken": refresh_token }),
            )
            .await
    }

    pub async fn verify(&self) -> Result<Value> {
        self.client.get("/v1/auth/verify").await
    }

    pub async fn me(&self) -> Result<Value> {
        self.client.get("/v1/auth/me").await
    }

    // ---- OIDC ----------------------------------------------------------

    pub async fn oidc_config(&self) -> Result<Value> {
        self.client.get("/v1/auth/oidc/config").await
    }

    pub async fn oidc_start(&self, org: &str) -> Result<Value> {
        self.client
            .get(format!(
                "/v1/auth/oidc/start?{}",
                query_string(&[("org", org.to_string())])
            ))
            .await
    }

    pub async fn oidc_callback(&self, code: &str, state: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/auth/oidc/callback",
                json!({ "code": code, "state": state }),
            )
            .await
    }

    // ---- orgs / accounts / users --------------------------------------

    pub async fn list_orgs(&self) -> Result<Value> {
        self.client.get("/v1/orgs").await
    }

    pub async fn create_org(&self, slug: &str, display_name: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/orgs",
                json!({ "slug": slug, "displayName": display_name }),
            )
            .await
    }

    pub async fn create_account(
        &self,
        org_id: &str,
        slug: &str,
        display_name: &str,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/orgs/{}/accounts", segment(org_id)),
                json!({ "slug": slug, "displayName": display_name }),
            )
            .await
    }

    pub async fn list_accounts(&self, org_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/orgs/{}/accounts", segment(org_id)))
            .await
    }

    pub async fn create_user(
        &self,
        org_id: &str,
        email: &str,
        display_name: Option<&str>,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/orgs/{}/users", segment(org_id)),
                json!({ "email": email, "displayName": display_name }),
            )
            .await
    }

    pub async fn list_users(&self, org_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/orgs/{}/users", segment(org_id)))
            .await
    }

    pub async fn user_policies(&self, user_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/users/{}/policies", segment(user_id)))
            .await
    }

    // ---- authorization -------------------------------------------------

    pub async fn authorize(
        &self,
        user_id: &str,
        action: &str,
        resource: &str,
        context: Option<Value>,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/authorize",
                json!({
                    "userId": user_id,
                    "action": action,
                    "resource": resource,
                    "context": context,
                }),
            )
            .await
    }

    pub async fn attach_policy(&self, role_id: &str, policy_id: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/roles/{}/attach", segment(role_id)),
                json!({ "policyId": policy_id }),
            )
            .await
    }

    pub async fn detach_policy(&self, role_id: &str, policy_id: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "/v1/roles/{}/policies/{}",
                segment(role_id),
                segment(policy_id)
            ))
            .await
    }

    pub async fn role_policies(&self, role_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/roles/{}/policies", segment(role_id)))
            .await
    }

    pub async fn assign_role(&self, user_id: &str, role_id: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/users/{}/assign", segment(user_id)),
                json!({ "roleId": role_id }),
            )
            .await
    }

    pub async fn unassign_role(&self, user_id: &str, role_id: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "/v1/users/{}/roles/{}",
                segment(user_id),
                segment(role_id)
            ))
            .await
    }

    pub async fn user_roles(&self, user_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/users/{}/roles", segment(user_id)))
            .await
    }

    pub async fn simulate(
        &self,
        documents: Value,
        action: &str,
        resource: &str,
        context: Option<Value>,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/authorize/dry-run",
                json!({
                    "documents": documents,
                    "action": action,
                    "resource": resource,
                    "context": context,
                }),
            )
            .await
    }

    // ---- audit ---------------------------------------------------------

    pub async fn list_audit(
        &self,
        limit: u32,
        actor: Option<&str>,
        offset: Option<u32>,
        allowed: Option<bool>,
        action: Option<&str>,
        resource: Option<&str>,
        from_time: Option<&str>,
        to_time: Option<&str>,
    ) -> Result<Value> {
        let mut params = vec![("limit", limit.to_string())];
        if let Some(actor) = actor {
            params.push(("actor", actor.to_string()));
        }
        if let Some(offset) = offset {
            params.push(("offset", offset.to_string()));
        }
        if let Some(allowed) = allowed {
            params.push(("allowed", allowed.to_string()));
        }
        if let Some(action) = action {
            params.push(("action", action.to_string()));
        }
        if let Some(resource) = resource {
            params.push(("resource", resource.to_string()));
        }
        if let Some(from_time) = from_time {
            params.push(("from", from_time.to_string()));
        }
        if let Some(to_time) = to_time {
            params.push(("to", to_time.to_string()));
        }
        self.client
            .get(format!("/v1/audit?{}", query_string(&params)))
            .await
    }

    // ---- API keys ------------------------------------------------------

    pub async fn create_api_key(
        &self,
        account_id: &str,
        name: &str,
        scopes: Option<Vec<String>>,
        user_id: Option<&str>,
        expires_in_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({
            "name": name,
            "scopes": scopes.unwrap_or_else(|| vec!["*:read".to_string()]),
        });
        if let Some(user_id) = user_id {
            body["userId"] = json!(user_id);
        }
        if let Some(expires_in_seconds) = expires_in_seconds {
            body["expiresInSeconds"] = json!(expires_in_seconds);
        }
        self.client
            .post(format!("/v1/accounts/{}/keys", segment(account_id)), body)
            .await
    }

    pub async fn revoke_api_key(&self, key_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/keys/{}", segment(key_id)))
            .await
    }

    pub async fn list_api_keys(&self, account_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/accounts/{}/keys", segment(account_id)))
            .await
    }

    pub async fn verify_api_key(&self, api_key: &str) -> Result<Value> {
        self.client
            .post("/v1/keys/verify", json!({ "apiKey": api_key }))
            .await
    }

    pub async fn rotate_api_key(&self, key_id: &str, grace_seconds: u64) -> Result<Value> {
        self.client
            .post(
                format!("/v1/keys/{}/rotate", segment(key_id)),
                json!({ "graceSeconds": grace_seconds }),
            )
            .await
    }

    // ---- org admins / managed policies --------------------------------

    pub async fn set_org_admin(&self, user_id: &str, is_org_admin: bool) -> Result<Value> {
        self.client
            .put(
                format!("/v1/users/{}/org-admin", segment(user_id)),
                json!({ "isOrgAdmin": is_org_admin }),
            )
            .await
    }

    pub async fn managed_policies(&self) -> Result<Value> {
        self.client.get("/v1/managed-policies").await
    }

    pub async fn create_managed_policy(
        &self,
        account_id: &str,
        slug: &str,
        managed: &str,
        description: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "slug": slug, "managed": managed });
        if let Some(description) = description {
            body["description"] = json!(description);
        }
        self.client
            .post(
                format!("/v1/accounts/{}/policies", segment(account_id)),
                body,
            )
            .await
    }

    // ---- credentials ---------------------------------------------------

    pub async fn create_credential(
        &self,
        account_id: &str,
        name: &str,
        credential_type: &str,
        secret: &str,
        expires_at: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "name": name, "type": credential_type, "secret": secret });
        if let Some(expires_at) = expires_at {
            body["expiresAt"] = json!(expires_at);
        }
        self.client
            .post(
                format!("/v1/accounts/{}/credentials", segment(account_id)),
                body,
            )
            .await
    }

    pub async fn list_credentials(&self, account_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/accounts/{}/credentials", segment(account_id)))
            .await
    }

    pub async fn get_credential(&self, credential_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/credentials/{}", segment(credential_id)))
            .await
    }

    pub async fn delete_credential(&self, credential_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/credentials/{}", segment(credential_id)))
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

    // ---- roles / policies / service accounts --------------------------

    pub async fn create_service_account(
        &self,
        account_id: &str,
        slug: &str,
        description: &str,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/accounts/{}/service-accounts", segment(account_id)),
                json!({ "slug": slug, "description": description }),
            )
            .await
    }

    pub async fn list_service_accounts(&self, account_id: &str) -> Result<Value> {
        self.client
            .get(format!(
                "/v1/accounts/{}/service-accounts",
                segment(account_id)
            ))
            .await
    }

    pub async fn list_roles(&self, account_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/accounts/{}/roles", segment(account_id)))
            .await
    }

    pub async fn create_scim_token(
        &self,
        description: &str,
        scopes: Option<Vec<String>>,
        ttl_seconds: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "description": description });
        if let Some(scopes) = scopes {
            body["scopes"] = json!(scopes);
        }
        if let Some(ttl_seconds) = ttl_seconds {
            body["ttlSeconds"] = json!(ttl_seconds);
        }
        self.client.post("/v1/scim/tokens", body).await
    }

    pub async fn list_scim_tokens(&self) -> Result<Value> {
        self.client.get("/v1/scim/tokens").await
    }

    pub async fn revoke_scim_token(&self, token_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/scim/tokens/{}", segment(token_id)))
            .await
    }

    pub async fn create_role(
        &self,
        account_id: &str,
        slug: &str,
        description: &str,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/accounts/{}/roles", segment(account_id)),
                json!({ "slug": slug, "description": description }),
            )
            .await
    }

    pub async fn delete_role(&self, role_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/roles/{}", segment(role_id)))
            .await
    }

    pub async fn list_policies(&self, account_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/accounts/{}/policies", segment(account_id)))
            .await
    }

    pub async fn create_policy(
        &self,
        account_id: &str,
        slug: &str,
        document: Value,
        description: &str,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/accounts/{}/policies", segment(account_id)),
                json!({ "slug": slug, "document": document, "description": description }),
            )
            .await
    }

    pub async fn delete_policy(&self, policy_id: &str) -> Result<Value> {
        self.client
            .delete(format!("/v1/policies/{}", segment(policy_id)))
            .await
    }

    pub async fn service_account_token(
        &self,
        service_account_id: &str,
        scopes: Option<Vec<String>>,
    ) -> Result<Value> {
        let body = match scopes {
            Some(scopes) => json!({ "scopes": scopes }),
            None => json!({}),
        };
        self.client
            .post(
                format!("/v1/service-accounts/{}/token", segment(service_account_id)),
                body,
            )
            .await
    }

    pub async fn service_account_roles(&self, service_account_id: &str) -> Result<Value> {
        self.client
            .get(format!(
                "/v1/service-accounts/{}/roles",
                segment(service_account_id)
            ))
            .await
    }

    pub async fn assign_service_account_role(
        &self,
        service_account_id: &str,
        role_id: &str,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/service-accounts/{}/roles", segment(service_account_id)),
                json!({ "roleId": role_id }),
            )
            .await
    }

    pub async fn unassign_service_account_role(
        &self,
        service_account_id: &str,
        role_id: &str,
    ) -> Result<Value> {
        self.client
            .delete(format!(
                "/v1/service-accounts/{}/roles/{}",
                segment(service_account_id),
                segment(role_id)
            ))
            .await
    }
}
