// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseObjectStorage: tenant-scoped object/file storage (#24).
package synapseone

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// StoredObject is object metadata returned by the storage service.
type StoredObject struct {
	Key            string `json:"key"`
	Size           int64  `json:"size"`
	ContentType    string `json:"contentType"`
	ETag           string `json:"etag"`
	ChecksumSHA256 string `json:"checksumSha256,omitempty"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

// PutObject uploads raw bytes (upsert).
func (c *Client) PutObject(key string, body []byte, contentType, checksumSHA256 string) (map[string]any, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	path := "/v1/storage/objects/" + objectKeyPath(key)
	// Build the request manually to add the optional checksum header.
	reqHeaders := httpHeader{"x-object-checksum-sha256", checksumSHA256}
	b, _, err := c.doRawWithHeaders("PUT", path, body, contentType, reqHeaders)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

type httpHeader struct{ key, value string }

func (c *Client) doRawWithHeaders(method, path string, body []byte, contentType string, h httpHeader) ([]byte, map[string][]string, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, r)
	if err != nil {
		return nil, nil, err
	}
	if h.key != "" && h.value != "" {
		req.Header.Set(h.key, h.value)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := c.HTTP
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("synapseone network %s: %w", path, err)
	}
	defer resp.Body.Close()
	b := make([]byte, 0)
	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			b = append(b, buf[:n]...)
		}
		if rerr != nil {
			break
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.Header, &APIError{StatusCode: resp.StatusCode, Path: path, Body: string(b)}
	}
	return b, resp.Header, nil
}

func objectKeyPath(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// GetObject downloads raw bytes.
func (c *Client) GetObject(key string) ([]byte, error) {
	b, _, err := c.doRaw("GET", "/v1/storage/objects/"+objectKeyPath(key), nil, "", 0)
	return b, err
}

// HeadObject returns metadata, or nil when the object does not exist.
func (c *Client) HeadObject(key string) (map[string]any, error) {
	_, headers, err := c.doRaw("HEAD", "/v1/storage/objects/"+objectKeyPath(key), nil, "", 0)
	if err != nil {
		if api, ok := err.(*APIError); ok && api.StatusCode == 404 {
			return nil, nil
		}
		return nil, err
	}
	return map[string]any{
		"key":         headers.Get("x-object-key"),
		"size":        headers.Get("Content-Length"),
		"contentType": headers.Get("Content-Type"),
		"etag":        strings.Trim(headers.Get("ETag"), "\""),
	}, nil
}

// DeleteObject removes an object.
func (c *Client) DeleteObject(key string) (map[string]any, error) {
	b, err := c.do("DELETE", "/v1/storage/objects/"+objectKeyPath(key), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListObjects lists objects under a prefix.
func (c *Client) ListObjects(prefix string, limit int, cursor string) (map[string]any, error) {
	if limit <= 0 {
		limit = 100
	}
	q := url.Values{}
	q.Set("limit", fmt.Sprint(limit))
	if prefix != "" {
		q.Set("prefix", prefix)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	b, err := c.do("GET", "/v1/storage/objects?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Presign returns a presigned URL (S3 backend only).
func (c *Client) Presign(key, method string, expiresIn int) (map[string]any, error) {
	if method == "" {
		method = "GET"
	}
	if expiresIn == 0 {
		expiresIn = 900
	}
	b, err := c.do("POST", "/v1/storage/presign", map[string]any{"key": key, "method": method, "expiresIn": expiresIn})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateMultipart starts a multipart upload.
func (c *Client) CreateMultipart(key, contentType string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/storage/uploads", map[string]any{"key": key, "contentType": contentType})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UploadPart uploads one part.
func (c *Client) UploadPart(uploadID, key string, partNumber int, body []byte) (map[string]any, error) {
	path := fmt.Sprintf("/v1/storage/uploads/%s/parts/%d?key=%s", url.PathEscape(uploadID), partNumber, url.QueryEscape(key))
	b, _, err := c.doRaw("PUT", path, body, "application/octet-stream", 0)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CompleteMultipart completes an upload.
func (c *Client) CompleteMultipart(uploadID, key string, parts []map[string]any) (map[string]any, error) {
	path := fmt.Sprintf("/v1/storage/uploads/%s/complete", url.PathEscape(uploadID))
	b, err := c.do("POST", path, map[string]any{"key": key, "parts": parts})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AbortMultipart aborts an upload.
func (c *Client) AbortMultipart(uploadID, key string) error {
	path := fmt.Sprintf("/v1/storage/uploads/%s?key=%s", url.PathEscape(uploadID), url.QueryEscape(key))
	_, err := c.do("DELETE", path, nil)
	return err
}

// ensure encoding/json stays referenced if the file is trimmed in future.
var _ = json.Marshal
