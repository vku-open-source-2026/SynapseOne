// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// Token management (AWS-style): API-key rotation, sessions, organization
// administrators, managed policies and service-account roles.
package synapseone

func (c *Client) doMap(method, path string, body any) (map[string]any, error) {
	b, err := c.do(method, path, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) doList(method, path string, body any) ([]any, error) {
	b, err := c.do(method, path, body)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RotateAPIKey mints a successor key (secret returned once) with the same
// owner, scopes and expiry. The old key stays valid for graceSeconds
// (0 revokes it immediately; max 7 days).
func (c *Client) RotateAPIKey(keyID string, graceSeconds int) (map[string]any, error) {
	return c.doMap("POST", "/v1/keys/"+pathEscape(keyID)+"/rotate", map[string]any{"graceSeconds": graceSeconds})
}

// SetOrgAdmin grants or revokes organization administrator (org admins only).
func (c *Client) SetOrgAdmin(userID string, isOrgAdmin bool) (map[string]any, error) {
	return c.doMap("PUT", "/v1/users/"+pathEscape(userID)+"/org-admin", map[string]any{"isOrgAdmin": isOrgAdmin})
}

// ManagedPolicies lists the AWS-style managed policies (AdministratorAccess, ReadOnlyAccess, ...).
func (c *Client) ManagedPolicies() ([]any, error) {
	return c.doList("GET", "/v1/managed-policies", nil)
}

// CreateManagedPolicy instantiates a managed policy (e.g. "ReadOnlyAccess") in an account.
func (c *Client) CreateManagedPolicy(accountID, slug, managed string) (map[string]any, error) {
	return c.doMap("POST", "/v1/accounts/"+pathEscape(accountID)+"/policies", map[string]any{"slug": slug, "managed": managed})
}

// ServiceAccountRoles lists the roles granted to a service account.
func (c *Client) ServiceAccountRoles(saID string) ([]any, error) {
	return c.doList("GET", "/v1/service-accounts/"+pathEscape(saID)+"/roles", nil)
}

// AssignServiceAccountRole grants a role (same account) to a service account.
func (c *Client) AssignServiceAccountRole(saID, roleID string) error {
	_, err := c.do("POST", "/v1/service-accounts/"+pathEscape(saID)+"/roles", map[string]any{"roleId": roleID})
	return err
}

// UnassignServiceAccountRole removes a role from a service account.
func (c *Client) UnassignServiceAccountRole(saID, roleID string) error {
	_, err := c.do("DELETE", "/v1/service-accounts/"+pathEscape(saID)+"/roles/"+pathEscape(roleID), nil)
	return err
}

// VerifyMFA finishes a login that failed with 401 mfa_required. Pass the
// mfaToken from that error body plus a TOTP code or a recovery code.
func (c *Client) VerifyMFA(mfaToken, code, recoveryCode string) (map[string]any, error) {
	body := map[string]any{"mfaToken": mfaToken}
	if code != "" {
		body["code"] = code
	}
	if recoveryCode != "" {
		body["recoveryCode"] = recoveryCode
	}
	return c.doMap("POST", "/v1/auth/mfa/verify", body)
}

// MFAStatus returns the current user's MFA status.
func (c *Client) MFAStatus() (map[string]any, error) {
	return c.doMap("GET", "/v1/auth/mfa", nil)
}

// SetupTOTP starts TOTP enrolment (secret + otpauth URL).
func (c *Client) SetupTOTP() (map[string]any, error) {
	return c.doMap("POST", "/v1/auth/mfa/totp/setup", map[string]any{})
}

// EnableTOTP confirms enrolment and returns recovery codes (shown once).
func (c *Client) EnableTOTP(code string) (map[string]any, error) {
	return c.doMap("POST", "/v1/auth/mfa/totp/enable", map[string]any{"code": code})
}

// RegenerateRecoveryCodes replaces the recovery codes (needs a TOTP code).
func (c *Client) RegenerateRecoveryCodes(code string) (map[string]any, error) {
	return c.doMap("POST", "/v1/auth/mfa/recovery-codes", map[string]any{"code": code})
}

// DisableMFA turns MFA off with a TOTP code or a recovery code.
func (c *Client) DisableMFA(code, recoveryCode string) (map[string]any, error) {
	body := map[string]any{}
	if code != "" {
		body["code"] = code
	}
	if recoveryCode != "" {
		body["recoveryCode"] = recoveryCode
	}
	return c.doMap("POST", "/v1/auth/mfa/disable", body)
}

// ResetUserMFA removes a user's second factor (org admins only).
func (c *Client) ResetUserMFA(userID string) (map[string]any, error) {
	return c.doMap("DELETE", "/v1/users/"+pathEscape(userID)+"/mfa", nil)
}

// UnlockUser clears a sign-in lockout (org admins only).
func (c *Client) UnlockUser(userID string) (map[string]any, error) {
	return c.doMap("POST", "/v1/users/"+pathEscape(userID)+"/unlock", map[string]any{})
}
