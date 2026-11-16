# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Synapse IAM service client: auth, orgs, accounts, users, roles, policies,
API keys, credentials and service accounts.

Access it through ``SynapseOneClient(...).iam`` or build it directly with a
:class:`~synapseone_sdk._http.HttpClient`.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from ._http import HttpClient


class IamService:
    """Typed methods for every ``/v1`` IAM endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    # ---- auth ----
    def login(self, email: str, org_slug: str = "acme") -> dict:
        """Exchange an email for access/refresh tokens (dev login)."""
        return self._req(
            "POST", "/v1/auth/login", {"email": email, "orgSlug": org_slug}
        )

    def register(
        self,
        email: str,
        password: str,
        org_slug: str = "acme",
        display_name: str | None = None,
    ) -> dict:
        """First-party registration (email + password)."""
        body: dict[str, Any] = {
            "email": email,
            "password": password,
            "orgSlug": org_slug,
        }
        if display_name is not None:
            body["displayName"] = display_name
        return self._req("POST", "/v1/auth/register", body)

    def login_with_password(
        self, email: str, password: str, org_slug: str = "acme"
    ) -> dict:
        """Email+password login (works in production)."""
        return self._req(
            "POST",
            "/v1/auth/login",
            {"email": email, "password": password, "orgSlug": org_slug},
        )

    def change_password(self, current_password: str, new_password: str) -> dict:
        """Change the current user's password and revoke other sessions."""
        return self._req(
            "POST",
            "/v1/auth/password/change",
            {"currentPassword": current_password, "newPassword": new_password},
        )

    def request_password_reset(self, email: str, org_slug: str = "acme") -> dict:
        """Request a reset token (always 202; no account enumeration)."""
        return self._req(
            "POST", "/v1/auth/password/forgot", {"email": email, "orgSlug": org_slug}
        )

    def reset_password(self, token: str, new_password: str) -> dict:
        """Consume a single-use reset token and set a new password."""
        return self._req(
            "POST",
            "/v1/auth/password/reset",
            {"token": token, "newPassword": new_password},
        )

    def verify_email(self, token: str) -> dict:
        """Consume an email verification token."""
        return self._req("POST", "/v1/auth/email/verify", {"token": token})

    def request_email_verification(self) -> dict:
        """Re-issue an email verification token for the current user."""
        return self._req("POST", "/v1/auth/email/verify/request", {})

    def list_sessions(self) -> list:
        """List the current user's refresh-token sessions."""
        return self._req("GET", "/v1/auth/sessions")

    def revoke_session(self, session_id: str) -> dict:
        """Revoke one session by id."""
        return self._req("DELETE", f"/v1/auth/sessions/{quote(session_id, safe='')}")

    # ---- multi-factor authentication (TOTP) ----
    def verify_mfa(
        self,
        mfa_token: str,
        code: str | None = None,
        recovery_code: str | None = None,
    ) -> dict:
        """Finish a login that failed with 401 ``mfa_required``."""
        body: dict = {"mfaToken": mfa_token}
        if code:
            body["code"] = code
        if recovery_code:
            body["recoveryCode"] = recovery_code
        return self._req("POST", "/v1/auth/mfa/verify", body)

    def mfa_status(self) -> dict:
        """Current user's MFA status."""
        return self._req("GET", "/v1/auth/mfa")

    def setup_totp(self) -> dict:
        """Start TOTP enrolment: returns ``secret`` and ``otpauthUrl``."""
        return self._req("POST", "/v1/auth/mfa/totp/setup", {})

    def enable_totp(self, code: str) -> dict:
        """Confirm enrolment; returns recovery codes (shown once)."""
        return self._req("POST", "/v1/auth/mfa/totp/enable", {"code": code})

    def regenerate_recovery_codes(self, code: str) -> dict:
        """Replace the recovery codes (needs a TOTP code)."""
        return self._req("POST", "/v1/auth/mfa/recovery-codes", {"code": code})

    def disable_mfa(
        self, code: str | None = None, recovery_code: str | None = None
    ) -> dict:
        """Turn MFA off with a TOTP or recovery code."""
        body: dict = {}
        if code:
            body["code"] = code
        if recovery_code:
            body["recoveryCode"] = recovery_code
        return self._req("POST", "/v1/auth/mfa/disable", body)

    def reset_user_mfa(self, user_id: str) -> dict:
        """Org admins: remove a user's second factor after a lost device."""
        return self._req("DELETE", f"/v1/users/{quote(user_id, safe='')}/mfa")

    def unlock_user(self, user_id: str) -> dict:
        """Org admins: clear a sign-in lockout."""
        return self._req("POST", f"/v1/users/{quote(user_id, safe='')}/unlock", {})

    def exchange_token(
        self,
        user_id: str,
        account_id: str | None = None,
        org_id: str | None = None,
        scopes: list | None = None,
        audience: str | None = None,
        ttl_seconds: int | None = None,
    ) -> dict:
        """Delegated token exchange (Tier 2 -> Tier 1).

        The client must present a service-account Bearer token or an API key.
        Returns a short-lived token bound to one user/org/account.
        """
        body: dict[str, Any] = {"userId": user_id}
        if account_id is not None:
            body["accountId"] = account_id
        if org_id is not None:
            body["orgId"] = org_id
        if scopes is not None:
            body["scopes"] = scopes
        if audience is not None:
            body["audience"] = audience
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", "/v1/auth/exchange", body)

    def refresh(self, refresh_token: str) -> dict:
        """Rotate a refresh token; returns a fresh token pair."""
        return self._req("POST", "/v1/auth/refresh", {"refreshToken": refresh_token})

    def logout(self, refresh_token: str) -> dict:
        """Revoke one refresh token."""
        return self._req("POST", "/v1/auth/logout", {"refreshToken": refresh_token})

    def logout_all(self, refresh_token: str) -> dict:
        """Revoke every refresh token of the token's user."""
        return self._req("POST", "/v1/auth/logout-all", {"refreshToken": refresh_token})

    def verify(self) -> dict:
        """Verify the current Bearer token is valid and unexpired."""
        return self._req("GET", "/v1/auth/verify")

    def me(self) -> dict:
        """Fetch the current user, org and account context."""
        return self._req("GET", "/v1/auth/me")

    # ---- OIDC (SSO authorization-code flow) ----
    def oidc_config(self) -> dict:
        """Fetch public OIDC discovery info (issuer, client id, enabled)."""
        return self._req("GET", "/v1/auth/oidc/config")

    def oidc_start(self, org: str = "acme") -> dict:
        """Begin the SSO flow; returns the provider authorization URL."""
        return self._req("GET", f"/v1/auth/oidc/start?org={quote(org, safe='')}")

    def oidc_callback(self, code: str, state: str) -> dict:
        """Finish the SSO flow and exchange code/state for tokens."""
        return self._req(
            "POST", "/v1/auth/oidc/callback", {"code": code, "state": state}
        )

    # ---- orgs / accounts / users ----
    def list_orgs(self) -> list:
        """List organizations visible to the caller."""
        return self._req("GET", "/v1/orgs")

    def create_org(self, slug: str, display_name: str) -> dict:
        """Create an organization."""
        return self._req(
            "POST", "/v1/orgs", {"slug": slug, "displayName": display_name}
        )

    def create_account(self, org_id: str, slug: str, display_name: str) -> dict:
        """Create an account inside an organization."""
        return self._req(
            "POST",
            f"/v1/orgs/{quote(org_id, safe='')}/accounts",
            {"slug": slug, "displayName": display_name},
        )

    def list_accounts(self, org_id: str) -> list:
        """List an organization's accounts."""
        return self._req("GET", f"/v1/orgs/{quote(org_id, safe='')}/accounts")

    def create_user(
        self, org_id: str, email: str, display_name: str | None = None
    ) -> dict:
        """Invite/create a user in an organization."""
        return self._req(
            "POST",
            f"/v1/orgs/{quote(org_id, safe='')}/users",
            {"email": email, "displayName": display_name},
        )

    def list_users(self, org_id: str) -> list:
        """List an organization's users."""
        return self._req("GET", f"/v1/orgs/{quote(org_id, safe='')}/users")

    def user_policies(self, user_id: str) -> list:
        """Effective policy documents of a user (debug helper for authorize)."""
        return self._req("GET", f"/v1/users/{quote(user_id, safe='')}/policies")

    # ---- authorization ----
    def authorize(
        self, user_id: str, action: str, resource: str, context: dict | None = None
    ) -> dict:
        """Ask the policy engine whether user/action/resource is allowed."""
        return self._req(
            "POST",
            "/v1/authorize",
            {
                "userId": user_id,
                "action": action,
                "resource": resource,
                "context": context,
            },
        )

    def attach_policy(self, role_id: str, policy_id: str) -> dict:
        """Attach a policy to a role."""
        return self._req(
            "POST",
            f"/v1/roles/{quote(role_id, safe='')}/attach",
            {"policyId": policy_id},
        )

    def detach_policy(self, role_id: str, policy_id: str) -> dict:
        """Detach a policy from a role."""
        return self._req(
            "DELETE",
            f"/v1/roles/{quote(role_id, safe='')}/policies/{quote(policy_id, safe='')}",
        )

    def role_policies(self, role_id: str) -> Any:
        """List the policies attached to a role."""
        return self._req("GET", f"/v1/roles/{quote(role_id, safe='')}/policies")

    def assign_role(self, user_id: str, role_id: str) -> dict:
        """Assign a role to a user."""
        return self._req(
            "POST", f"/v1/users/{quote(user_id, safe='')}/assign", {"roleId": role_id}
        )

    def unassign_role(self, user_id: str, role_id: str) -> dict:
        """Remove a role from a user."""
        return self._req(
            "DELETE",
            f"/v1/users/{quote(user_id, safe='')}/roles/{quote(role_id, safe='')}",
        )

    def user_roles(self, user_id: str) -> Any:
        """List a user's roles."""
        return self._req("GET", f"/v1/users/{quote(user_id, safe='')}/roles")

    def simulate(
        self, documents: list, action: str, resource: str, context: dict | None = None
    ) -> dict:
        """Dry-run the policy engine against candidate documents."""
        return self._req(
            "POST",
            "/v1/authorize/dry-run",
            {
                "documents": documents,
                "action": action,
                "resource": resource,
                "context": context,
            },
        )

    def list_audit(
        self,
        limit: int = 50,
        actor: str | None = None,
        *,
        offset: int | None = None,
        allowed: bool | None = None,
        action: str | None = None,
        resource: str | None = None,
        from_time: str | None = None,
        to_time: str | None = None,
    ) -> list:
        """Read the tenant-scoped audit log with action/resource/time filters."""
        params: dict[str, Any] = {"limit": limit}
        if actor:
            params["actor"] = actor
        if offset is not None:
            params["offset"] = offset
        if allowed is not None:
            params["allowed"] = "true" if allowed else "false"
        if action:
            params["action"] = action
        if resource:
            params["resource"] = resource
        if from_time:
            params["from"] = from_time
        if to_time:
            params["to"] = to_time
        return self._req("GET", f"/v1/audit?{urlencode(params)}")

    # ---- API keys ----
    def create_api_key(
        self,
        account_id: str,
        name: str = "default",
        scopes: list | None = None,
        user_id: str | None = None,
        expires_in_seconds: int | None = None,
    ) -> dict:
        """Mint an account API key (secret returned once).

        Scopes default to least-privilege ``["*:read"]``; pass ``["*"]``
        explicitly for a full administrator key.
        """
        body: dict[str, Any] = {"name": name, "scopes": scopes or ["*:read"]}
        if user_id is not None:
            body["userId"] = user_id
        if expires_in_seconds is not None:
            body["expiresInSeconds"] = expires_in_seconds
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/keys",
            body,
        )

    def revoke_api_key(self, key_id: str) -> dict:
        """Revoke an API key."""
        return self._req("DELETE", f"/v1/keys/{quote(key_id, safe='')}")

    def list_api_keys(self, account_id: str) -> Any:
        """List key metadata (id/prefix only — never secret values)."""
        return self._req("GET", f"/v1/accounts/{quote(account_id, safe='')}/keys")

    def verify_api_key(self, api_key: str) -> dict:
        """Check a raw API key via the internal verify endpoint."""
        return self._req("POST", "/v1/keys/verify", {"apiKey": api_key})

    def rotate_api_key(self, key_id: str, grace_seconds: int = 0) -> dict:
        """Rotate a key: the new secret is returned once; the old key stays
        valid for ``grace_seconds`` (0 = revoked immediately)."""
        return self._req(
            "POST",
            f"/v1/keys/{quote(key_id, safe='')}/rotate",
            {"graceSeconds": grace_seconds},
        )

    # ---- org administrators & managed policies ----
    def set_org_admin(self, user_id: str, is_org_admin: bool) -> dict:
        """Grant/revoke organization administrator (org admins only)."""
        return self._req(
            "PUT",
            f"/v1/users/{quote(user_id, safe='')}/org-admin",
            {"isOrgAdmin": is_org_admin},
        )

    def managed_policies(self) -> list:
        """AWS-style managed policy catalog (AdministratorAccess, ReadOnlyAccess, ...)."""
        return self._req("GET", "/v1/managed-policies")

    def create_managed_policy(
        self, account_id: str, slug: str, managed: str, description: str | None = None
    ) -> dict:
        """Instantiate a managed policy (e.g. ``ReadOnlyAccess``) in an account."""
        body: dict = {"slug": slug, "managed": managed}
        if description:
            body["description"] = description
        return self._req(
            "POST", f"/v1/accounts/{quote(account_id, safe='')}/policies", body
        )

    # ---- credentials (account-scoped secrets) ----
    # Secrets are encrypted at rest and NEVER returned — create/rotate accept a
    # ``secret`` once; list/get return metadata only:
    # {id, name, type, accountId, expiresAt, version}. ``type`` is one of
    # bearer|basic|apiKey|oauth2 (passed through, not validated client-side).
    def create_credential(
        self,
        account_id: str,
        name: str,
        type: str,
        secret: str,
        expires_at: str | None = None,
    ) -> dict:
        """Store an account credential (secret is write-only, never returned)."""
        body: dict = {"name": name, "type": type, "secret": secret}
        if expires_at:
            body["expiresAt"] = expires_at
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/credentials",
            body,
        )

    def list_credentials(self, account_id: str) -> list:
        """List credential metadata for an account (never secret values)."""
        return self._req(
            "GET", f"/v1/accounts/{quote(account_id, safe='')}/credentials"
        )

    def get_credential(self, cred_id: str) -> dict:
        """Fetch one credential's metadata (never the secret)."""
        return self._req("GET", f"/v1/credentials/{quote(cred_id, safe='')}")

    def delete_credential(self, cred_id: str) -> dict:
        """Delete a credential."""
        return self._req("DELETE", f"/v1/credentials/{quote(cred_id, safe='')}")

    def rotate_credential(self, cred_id: str, secret: str) -> dict:
        """Rotate a credential's secret (bumps version; old secret stops working)."""
        return self._req(
            "POST",
            f"/v1/credentials/{quote(cred_id, safe='')}/rotate",
            {"secret": secret},
        )

    # ---- roles / policies / service accounts ----
    def create_service_account(
        self, account_id: str, slug: str, description: str = ""
    ) -> dict:
        """Create a service account inside an account."""
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/service-accounts",
            {"slug": slug, "description": description},
        )

    def list_service_accounts(self, account_id: str) -> list:
        """List an account's service accounts."""
        return self._req(
            "GET", f"/v1/accounts/{quote(account_id, safe='')}/service-accounts"
        )

    def list_roles(self, account_id: str) -> list:
        """List an account's roles."""
        return self._req("GET", f"/v1/accounts/{quote(account_id, safe='')}/roles")

    # ---- SCIM provisioning (#48) ----
    def create_scim_token(
        self,
        description: str = "",
        scopes: list[str] | None = None,
        ttl_seconds: int | None = None,
    ) -> dict:
        body: dict[str, Any] = {"description": description}
        if scopes:
            body["scopes"] = scopes
        if ttl_seconds:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", "/v1/scim/tokens", body)

    def list_scim_tokens(self) -> list:
        raw = self._req("GET", "/v1/scim/tokens")
        return raw.get("items", []) if isinstance(raw, dict) else (raw or [])

    def revoke_scim_token(self, token_id: str) -> dict:
        return self._req("DELETE", f"/v1/scim/tokens/{quote(token_id, safe='')}")

    def create_role(self, account_id: str, slug: str, description: str = "") -> dict:
        """Create a role inside an account."""
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/roles",
            {"slug": slug, "description": description},
        )

    def delete_role(self, role_id: str) -> dict:
        """Delete a role."""
        return self._req("DELETE", f"/v1/roles/{quote(role_id, safe='')}")

    def list_policies(self, account_id: str) -> list:
        """List an account's policies."""
        return self._req("GET", f"/v1/accounts/{quote(account_id, safe='')}/policies")

    def create_policy(
        self, account_id: str, slug: str, document: dict, description: str = ""
    ) -> dict:
        """Create a policy document inside an account."""
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/policies",
            {"slug": slug, "document": document, "description": description},
        )

    def delete_policy(self, policy_id: str) -> dict:
        """Delete a policy."""
        return self._req("DELETE", f"/v1/policies/{quote(policy_id, safe='')}")

    def service_account_token(self, sa_id: str, scopes: list | None = None) -> dict:
        """Mint a scoped token for a service account.

        ``scopes`` omitted -> the server delegates the caller's own scopes
        (never widens to '*'). Pass an explicit list to narrow the minted token.
        """
        body = {} if scopes is None else {"scopes": scopes}
        return self._req(
            "POST",
            f"/v1/service-accounts/{quote(sa_id, safe='')}/token",
            body,
        )

    def service_account_roles(self, sa_id: str) -> list:
        """Roles granted to a service account."""
        return self._req("GET", f"/v1/service-accounts/{quote(sa_id, safe='')}/roles")

    def assign_service_account_role(self, sa_id: str, role_id: str) -> dict:
        """Grant a role (same account) to a service account."""
        return self._req(
            "POST",
            f"/v1/service-accounts/{quote(sa_id, safe='')}/roles",
            {"roleId": role_id},
        )

    def unassign_service_account_role(self, sa_id: str, role_id: str) -> dict:
        """Remove a role from a service account."""
        return self._req(
            "DELETE",
            f"/v1/service-accounts/{quote(sa_id, safe='')}/roles/{quote(role_id, safe='')}",
        )
