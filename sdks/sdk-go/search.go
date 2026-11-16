// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Tenant-scoped search over Base documents (#46).
package synapseone

// SearchQuery is a full-text, semantic or hybrid search request.
type SearchQuery struct {
	Query       string            `json:"query"`
	Mode        string            `json:"mode,omitempty"`
	Collection  string            `json:"collection,omitempty"`
	Collections []string          `json:"collections,omitempty"`
	Filters     map[string]string `json:"filters,omitempty"`
	Limit       int               `json:"limit,omitempty"`
	Cursor      string            `json:"cursor,omitempty"`
}

// Search runs POST /v1/search.
func (c *Client) Search(query SearchQuery) (map[string]any, error) {
	b, err := c.do("POST", "/v1/search", query)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ReindexSearch rebuilds the tenant-scoped search projection.
func (c *Client) ReindexSearch(collections []string) (map[string]any, error) {
	body := map[string]any{}
	if len(collections) > 0 {
		body["collections"] = collections
	}
	b, err := c.do("POST", "/v1/search/reindex", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SearchStatus reports the tenant's index size and freshness.
func (c *Client) SearchStatus() (map[string]any, error) {
	b, err := c.do("GET", "/v1/search/status", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
