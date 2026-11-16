// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Tenant secret vault (#47).
package synapseone

// CreateSecret stores an encrypted, versioned secret.
func (c *Client) CreateSecret(name, value, description string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/secrets", map[string]any{"name": name, "value": value, "description": description})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListSecrets returns metadata only; values are never listed.
func (c *Client) ListSecrets() ([]any, error) {
	b, err := c.do("GET", "/v1/secrets", nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Items []any `json:"items"`
	}
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// ReadSecret reveals one version (audited). Callers should cache sparingly.
func (c *Client) ReadSecret(name string, version int) (map[string]any, error) {
	body := map[string]any{}
	if version > 0 {
		body["version"] = version
	}
	b, err := c.do("POST", "/v1/secrets/"+pathEscape(name)+"/read", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RotateSecret creates a new version and keeps the old one until grace expires.
func (c *Client) RotateSecret(name, value string, graceSeconds int) (map[string]any, error) {
	b, err := c.do("POST", "/v1/secrets/"+pathEscape(name)+"/rotate", map[string]any{"value": value, "graceSeconds": graceSeconds})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteSecret soft-deletes the secret and revokes every version.
func (c *Client) DeleteSecret(name string) error {
	_, err := c.do("DELETE", "/v1/secrets/"+pathEscape(name), nil)
	return err
}
