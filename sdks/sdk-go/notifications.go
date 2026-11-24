// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseNotifications: outbox, templates and delivery status (#25).
package synapseone

import (
	"fmt"
	"net/url"
)

// NotificationRecipient addresses one or more delivery channels.
type NotificationRecipient struct {
	Email      string `json:"email,omitempty"`
	Phone      string `json:"phone,omitempty"`
	UserID     string `json:"userId,omitempty"`
	URL        string `json:"url,omitempty"`
	WebhookURL string `json:"webhookUrl,omitempty"`
	PushToken  string `json:"pushToken,omitempty"`
}

// SendNotificationInput is the POST /v1/notifications body.
type SendNotificationInput struct {
	Channel        string                `json:"channel,omitempty"`
	Channels       []string              `json:"channels,omitempty"`
	Recipient      NotificationRecipient `json:"recipient"`
	Subject        string                `json:"subject,omitempty"`
	Body           string                `json:"body,omitempty"`
	TemplateID     string                `json:"templateId,omitempty"`
	TemplateSlug   string                `json:"templateSlug,omitempty"`
	Data           map[string]any        `json:"data,omitempty"`
	IdempotencyKey string                `json:"idempotencyKey,omitempty"`
}

// SendNotification queues one notification per channel.
func (c *Client) SendNotification(in SendNotificationInput) (map[string]any, error) {
	b, err := c.do("POST", "/v1/notifications", in)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetNotification returns status + attempts for one notification.
func (c *Client) GetNotification(id string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/notifications/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListNotifications lists recent notifications (optional status filter).
func (c *Client) ListNotifications(status string, limit int) ([]any, error) {
	if limit <= 0 {
		limit = 50
	}
	q := url.Values{}
	q.Set("limit", fmt.Sprint(limit))
	if status != "" {
		q.Set("status", status)
	}
	b, err := c.do("GET", "/v1/notifications?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CancelNotification cancels a queued/failed notification.
func (c *Client) CancelNotification(id string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/notifications/"+pathEscape(id)+"/cancel", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RetryNotification re-queues a failed/dead notification.
func (c *Client) RetryNotification(id string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/notifications/"+pathEscape(id)+"/retry", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateNotificationTemplate creates a tenant-owned template.
func (c *Client) CreateNotificationTemplate(body map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/notifications/templates", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListNotificationTemplates lists/search templates with optional archiving.
func (c *Client) ListNotificationTemplates(params map[string]string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/notifications/templates"+queryString(params), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetNotificationTemplate reads one template.
func (c *Client) GetNotificationTemplate(id string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/notifications/templates/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateNotificationTemplate updates template content (version increments).
func (c *Client) UpdateNotificationTemplate(id string, body map[string]any) (map[string]any, error) {
	b, err := c.do("PATCH", "/v1/notifications/templates/"+pathEscape(id), body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteNotificationTemplate archives a template.
func (c *Client) DeleteNotificationTemplate(id string) (map[string]any, error) {
	b, err := c.do("DELETE", "/v1/notifications/templates/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PreviewNotificationTemplate renders a template with data.
func (c *Client) PreviewNotificationTemplate(id string, data map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/notifications/templates/"+pathEscape(id)+"/preview", map[string]any{"data": data})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetNotificationPreference reads a recipient's channel preferences.
func (c *Client) GetNotificationPreference(recipient string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/notifications/preferences/"+pathEscape(recipient), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetNotificationPreference updates channels/unsubscribe state.
func (c *Client) SetNotificationPreference(recipient string, channels []string, unsubscribed bool) (map[string]any, error) {
	body := map[string]any{"unsubscribed": unsubscribed}
	if channels != nil {
		body["channels"] = channels
	}
	b, err := c.do("PUT", "/v1/notifications/preferences/"+pathEscape(recipient), body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Unsubscribe marks a recipient as unsubscribed.
func (c *Client) Unsubscribe(recipient string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/notifications/unsubscribe", map[string]any{"recipient": recipient})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
