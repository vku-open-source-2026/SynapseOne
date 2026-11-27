// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");

package synapseone

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestDefaultBaseURLIsGateway(t *testing.T) {
	if DefaultBaseURL != "https://api.synapseone.space" {
		t.Fatalf("default base URL must be the API gateway, got %s", DefaultBaseURL)
	}
}

func TestHTML2xxIsTypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("<!doctype html><html>console</html>"))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	_, err := c.do("GET", "/v1/orgs", nil)
	var api *APIError
	if !errors.As(err, &api) {
		t.Fatalf("expected APIError, got %v", err)
	}
	if api.Code != "non_json_response" {
		t.Fatalf("expected non_json_response, got %q", api.Code)
	}
	if api.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", api.StatusCode)
	}
}

func TestRetriesIdempotentRequests(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&n, 1) < 3 {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":"unavailable"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 3
	c.RetryBase = time.Millisecond
	if _, err := c.do("GET", "/v1/flaky", nil); err != nil {
		t.Fatalf("expected retry success, got %v", err)
	}
	if got := atomic.LoadInt32(&n); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

func TestDoesNotRetryPostsByDefault(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&n, 1)
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 3
	c.RetryBase = time.Millisecond
	_, err := c.do("POST", "/v1/x", map[string]any{"a": 1})
	var api *APIError
	if !errors.As(err, &api) || api.StatusCode != 503 {
		t.Fatalf("expected 503 APIError, got %v", err)
	}
	if got := atomic.LoadInt32(&n); got != 1 {
		t.Fatalf("expected a single POST attempt, got %d", got)
	}
}

func TestPerCallTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	started := time.Now()
	_, err := c.doWithTimeout("GET", "/slow", nil, 40*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("timeout override not applied: %s", time.Since(started))
	}
}

func TestReadyReturnsDegradedPayload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok","service":"gateway","version":"0"}`))
		case "/ready":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(503)
			_, _ = fmt.Fprint(w, `{"status":"degraded","service":"gateway","version":"0","upstreams":[{"name":"base","ok":false}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	ready, err := c.Ready()
	if err != nil {
		t.Fatalf("Ready must return the degraded payload, got %v", err)
	}
	if ready["status"] != "degraded" {
		t.Fatalf("expected degraded, got %v", ready["status"])
	}
	if _, err := c.ReadyStrict(); err == nil {
		t.Fatal("ReadyStrict must fail on 503")
	}
}

func TestSameOriginRedirectKeepsCredentials(t *testing.T) {
	var auth, key, tenant string
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/start", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/v1/final", http.StatusFound)
	})
	mux.HandleFunc("/v1/final", func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		key = r.Header.Get("X-API-Key")
		tenant = r.Header.Get("x-synapseone-tenant")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := New(srv.URL)
	c.MaxAttempts = 1
	c.SetToken("jwt-1")
	c.SetAPIKey("key-1")
	c.SetTenant("acme")
	if _, err := c.do("GET", "/v1/start", nil); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer jwt-1" || key != "key-1" || tenant != "acme" {
		t.Fatalf("same-origin redirect lost credentials: auth=%q key=%q tenant=%q", auth, key, tenant)
	}
}

func TestUntrustedCrossOriginRedirectIsRefused(t *testing.T) {
	var otherHits int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&otherHits, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer other.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/capture", http.StatusFound)
	}))
	defer source.Close()

	c := New(source.URL)
	c.MaxAttempts = 1
	c.SetToken("jwt-1")
	c.SetAPIKey("key-1")
	_, err := c.ListOrgs()
	var api *APIError
	if !errors.As(err, &api) || api.Code != "redirect_not_allowed" {
		t.Fatalf("expected redirect_not_allowed, got %v", err)
	}
	if got := atomic.LoadInt32(&otherHits); got != 0 {
		t.Fatalf("untrusted target received %d requests", got)
	}
}

func TestTrustedCrossOriginRedirectStripsCredentials(t *testing.T) {
	var otherHits int32
	var auth, key, tenant string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&otherHits, 1)
		auth = r.Header.Get("Authorization")
		key = r.Header.Get("X-API-Key")
		tenant = r.Header.Get("x-synapseone-tenant")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer other.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/capture", http.StatusFound)
	}))
	defer source.Close()

	c := New(source.URL)
	c.MaxAttempts = 1
	c.SetToken("jwt-1")
	c.SetAPIKey("key-1")
	c.SetTenant("acme")
	c.TrustedRedirectOrigins = []string{other.URL}
	if _, err := c.ListOrgs(); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&otherHits); got != 1 {
		t.Fatalf("trusted target received %d requests", got)
	}
	if auth != "" || key != "" || tenant != "" {
		t.Fatalf("credentials crossed origins: auth=%q key=%q tenant=%q", auth, key, tenant)
	}
}

func TestRedirectLoopIsBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/loop", http.StatusFound)
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	c.MaxRedirects = 2
	_, err := c.ListOrgs()
	var api *APIError
	if !errors.As(err, &api) || api.Code != "too_many_redirects" {
		t.Fatalf("expected too_many_redirects, got %v", err)
	}
}

func TestBinaryExactBytes(t *testing.T) {
	want := []byte{0, 1, 2, 254, 255}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(want)
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	got, err := c.GetBytes("/v1/bytes")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("binary body changed: %v", got)
	}
}

func TestBinaryLimitOverflowIsExplicit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("x"), 100))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	c.MaxBinaryBytes = 4
	_, err := c.GetBytes("/v1/bytes")
	var tooLarge *ResponseTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("expected ResponseTooLargeError, got %v", err)
	}
}

func TestTruncatedBodyIsNotSilentlyAccepted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("short"))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	if _, err := c.GetBytes("/v1/bytes"); err == nil {
		t.Fatal("expected a read error for a truncated body")
	}
}

func TestTimeoutCoversStalledBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(200)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(400 * time.Millisecond)
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.MaxAttempts = 1
	c.Timeout = 40 * time.Millisecond
	started := time.Now()
	if _, err := c.GetBytes("/v1/stall"); err == nil {
		t.Fatal("expected a timeout for a stalled body")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("timeout not applied while reading body: %s", time.Since(started))
	}
}
