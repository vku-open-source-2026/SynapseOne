// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseOCS: bucket-aware object cloud storage.
package synapseone

import (
	"fmt"
	"net/url"
)

func ocsKeyPath(key string) string {
	return objectKeyPath(key)
}

// CreateOcsBucket creates a named bucket in the caller's tenant.
func (c *Client) CreateOcsBucket(name string, quotaBytes int64) (map[string]any, error) {
	body := map[string]any{"name": name}
	if quotaBytes > 0 {
		body["quotaBytes"] = quotaBytes
	}
	b, err := c.do("POST", "/v1/ocs/buckets", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListOcsBuckets lists visible buckets. Set withStats for object/byte counts.
func (c *Client) ListOcsBuckets(withStats bool) (map[string]any, error) {
	path := "/v1/ocs/buckets"
	if withStats {
		path += "?withStats=1"
	}
	b, err := c.do("GET", path, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetOcsBucket returns one bucket with usage stats.
func (c *Client) GetOcsBucket(name string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/ocs/buckets/"+url.PathEscape(name), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// HeadOcsBucket returns bucket headers, or nil when the bucket does not exist.
func (c *Client) HeadOcsBucket(name string) (map[string][]string, error) {
	_, headers, err := c.doRaw("HEAD", "/v1/ocs/buckets/"+url.PathEscape(name), nil, "", 0)
	if err != nil {
		if api, ok := err.(*APIError); ok && api.StatusCode == 404 {
			return nil, nil
		}
		return nil, err
	}
	return headers, nil
}

// OcsBucketStats returns object/byte usage for a bucket.
func (c *Client) OcsBucketStats(name string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/ocs/buckets/"+url.PathEscape(name)+"/stats", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteOcsBucket deletes an empty bucket; force removes all objects first.
func (c *Client) DeleteOcsBucket(name string, force bool) (map[string]any, error) {
	path := "/v1/ocs/buckets/" + url.PathEscape(name)
	if force {
		path += "?force=true"
	}
	b, err := c.do("DELETE", path, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PutOcsObject uploads raw bytes into a bucket (upsert).
func (c *Client) PutOcsObject(bucket, key string, body []byte, contentType, checksumSHA256 string) (map[string]any, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/objects/" + ocsKeyPath(key)
	b, _, err := c.doRawWithHeaders("PUT", path, body, contentType, httpHeader{"x-object-checksum-sha256", checksumSHA256})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetOcsObject downloads bytes, optionally with a Range header.
func (c *Client) GetOcsObject(bucket, key, rangeHeader string) ([]byte, error) {
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/objects/" + ocsKeyPath(key)
	b, _, err := c.doRawWithHeaders("GET", path, nil, "", httpHeader{"Range", rangeHeader})
	return b, err
}

// HeadOcsObject returns object metadata, or nil when it does not exist.
func (c *Client) HeadOcsObject(bucket, key string) (map[string]any, error) {
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/objects/" + ocsKeyPath(key)
	_, headers, err := c.doRaw("HEAD", path, nil, "", 0)
	if err != nil {
		if api, ok := err.(*APIError); ok && api.StatusCode == 404 {
			return nil, nil
		}
		return nil, err
	}
	return map[string]any{
		"key":         headers.Get("x-object-key"),
		"bucket":      headers.Get("x-ocs-bucket"),
		"size":        headers.Get("Content-Length"),
		"contentType": headers.Get("Content-Type"),
		"etag":        trimQuotes(headers.Get("ETag")),
	}, nil
}

// DeleteOcsObject deletes one object.
func (c *Client) DeleteOcsObject(bucket, key string) (map[string]any, error) {
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/objects/" + ocsKeyPath(key)
	b, err := c.do("DELETE", path, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListOcsObjects lists a bucket with prefix/delimiter and cursor pagination.
func (c *Client) ListOcsObjects(bucket, prefix, delimiter string, limit int, cursor string) (map[string]any, error) {
	if limit <= 0 {
		limit = 100
	}
	query := url.Values{}
	query.Set("limit", fmt.Sprint(limit))
	if prefix != "" {
		query.Set("prefix", prefix)
	}
	if delimiter != "" {
		query.Set("delimiter", delimiter)
	}
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/objects?" + query.Encode()
	b, err := c.do("GET", path, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CopyOcsObject copies an object inside a bucket or from another bucket.
func (c *Client) CopyOcsObject(bucket, sourceKey, destinationKey, sourceBucket, contentType string) (map[string]any, error) {
	body := map[string]any{"sourceKey": sourceKey, "destinationKey": destinationKey}
	if sourceBucket != "" {
		body["sourceBucket"] = sourceBucket
	}
	if contentType != "" {
		body["contentType"] = contentType
	}
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/objects/copy"
	b, err := c.do("POST", path, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PresignOcs returns a short-lived S3 presigned URL.
func (c *Client) PresignOcs(bucket, key, method string, expiresIn int) (map[string]any, error) {
	if method == "" {
		method = "GET"
	}
	if expiresIn == 0 {
		expiresIn = 900
	}
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/presign"
	b, err := c.do("POST", path, map[string]any{"key": key, "method": method, "expiresIn": expiresIn})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateOcsMultipart starts a bucket-aware multipart upload.
func (c *Client) CreateOcsMultipart(bucket, key, contentType string) (map[string]any, error) {
	path := "/v1/ocs/buckets/" + url.PathEscape(bucket) + "/uploads"
	b, err := c.do("POST", path, map[string]any{"key": key, "contentType": contentType})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UploadOcsPart uploads one multipart part.
func (c *Client) UploadOcsPart(bucket, uploadID, key string, partNumber int, body []byte) (map[string]any, error) {
	path := fmt.Sprintf("/v1/ocs/buckets/%s/uploads/%s/parts/%d?key=%s",
		url.PathEscape(bucket), url.PathEscape(uploadID), partNumber, url.QueryEscape(key))
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

// CompleteOcsMultipart completes a multipart upload.
func (c *Client) CompleteOcsMultipart(bucket, uploadID, key string, parts []map[string]any) (map[string]any, error) {
	path := fmt.Sprintf("/v1/ocs/buckets/%s/uploads/%s/complete", url.PathEscape(bucket), url.PathEscape(uploadID))
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

// AbortOcsMultipart aborts a multipart upload.
func (c *Client) AbortOcsMultipart(bucket, uploadID, key string) error {
	path := fmt.Sprintf("/v1/ocs/buckets/%s/uploads/%s?key=%s",
		url.PathEscape(bucket), url.PathEscape(uploadID), url.QueryEscape(key))
	_, err := c.do("DELETE", path, nil)
	return err
}

func trimQuotes(value string) string {
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return value[1 : len(value)-1]
	}
	return value
}
