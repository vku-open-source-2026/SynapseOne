// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// SCIM provisioning token lifecycle (#48).
package synapseone

// CreateScimToken issues a scoped SCIM bearer token (shown once).
func (c *Client) CreateScimToken(description string, scopes []string) (map[string]any, error) {
	body := map[string]any{"description": description}
	if len(scopes) > 0 {
		body["scopes"] = scopes
	}
	b, err := c.do("POST", "/v1/scim/tokens", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListScimTokens lists token metadata for the caller's org.
func (c *Client) ListScimTokens() ([]any, error) {
	b, err := c.do("GET", "/v1/scim/tokens", nil)
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

// RevokeScimToken revokes a SCIM token by id.
func (c *Client) RevokeScimToken(id string) error {
	_, err := c.do("DELETE", "/v1/scim/tokens/"+pathEscape(id), nil)
	return err
}
