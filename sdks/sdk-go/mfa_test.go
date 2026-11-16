// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
package synapseone

import (
	"encoding/json"
	"testing"
)

func TestMFAMethods(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	c.SetToken("T")

	check := func(method, path string, wantBody map[string]any) {
		t.Helper()
		if seen["method"] != method || seen["path"] != path {
			t.Fatalf("got %s %s, want %s %s", seen["method"], seen["path"], method, path)
		}
		if wantBody == nil {
			return
		}
		var got map[string]any
		if err := json.Unmarshal([]byte(seen["body"]), &got); err != nil {
			t.Fatalf("body %q: %v", seen["body"], err)
		}
		if len(got) != len(wantBody) {
			t.Fatalf("body %v, want %v", got, wantBody)
		}
		for k, v := range wantBody {
			if got[k] != v {
				t.Fatalf("body[%s]=%v, want %v", k, got[k], v)
			}
		}
	}

	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.VerifyMFA("m", "123456", ""))
	check("POST", "/v1/auth/mfa/verify", map[string]any{"mfaToken": "m", "code": "123456"})
	must(c.VerifyMFA("m", "", "abcd-efgh"))
	check("POST", "/v1/auth/mfa/verify", map[string]any{"mfaToken": "m", "recoveryCode": "abcd-efgh"})
	must(c.MFAStatus())
	check("GET", "/v1/auth/mfa", nil)
	must(c.SetupTOTP())
	check("POST", "/v1/auth/mfa/totp/setup", map[string]any{})
	must(c.EnableTOTP("111111"))
	check("POST", "/v1/auth/mfa/totp/enable", map[string]any{"code": "111111"})
	must(c.RegenerateRecoveryCodes("222222"))
	check("POST", "/v1/auth/mfa/recovery-codes", map[string]any{"code": "222222"})
	must(c.DisableMFA("333333", ""))
	check("POST", "/v1/auth/mfa/disable", map[string]any{"code": "333333"})
	must(c.ResetUserMFA("u1"))
	check("DELETE", "/v1/users/u1/mfa", nil)
	must(c.UnlockUser("u1"))
	check("POST", "/v1/users/u1/unlock", map[string]any{})
}
