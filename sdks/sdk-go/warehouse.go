// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Synapse Warehouse: tenant-scoped OLAP datasets, read-only SQL and ETL jobs.
package synapseone

import (
	"encoding/json"
	"fmt"
	"net/url"
)

const warehousePath = "/v1/warehouse"

func (c *Client) warehouseReq(method, path string, body any, out any) error {
	raw, err := c.do(method, path, body)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("synapseone decode %s: %w", path, err)
	}
	return nil
}

// ListWarehouseDatasets lists datasets owned by the caller's tenant.
func (c *Client) ListWarehouseDatasets() (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("GET", warehousePath+"/datasets", nil, &out)
}

// GetWarehouseDataset fetches one dataset and its schema.
func (c *Client) GetWarehouseDataset(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("GET", warehousePath+"/datasets/"+url.PathEscape(id), nil, &out)
}

// CreateWarehouseDataset creates a dataset; body must include name and columns.
func (c *Client) CreateWarehouseDataset(body map[string]any) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/datasets", body, &out)
}

// DeleteWarehouseDataset deletes a dataset and its ETL jobs.
func (c *Client) DeleteWarehouseDataset(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("DELETE", warehousePath+"/datasets/"+url.PathEscape(id), nil, &out)
}

// IngestWarehouseRows appends rows to a dataset.
func (c *Client) IngestWarehouseRows(id string, rows []map[string]any) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/datasets/"+url.PathEscape(id)+"/rows", map[string]any{"rows": rows}, &out)
}

// QueryWarehouse executes one read-only SELECT/WITH statement.
func (c *Client) QueryWarehouse(sql string, limit int) (map[string]any, error) {
	body := map[string]any{"sql": sql}
	if limit > 0 {
		body["limit"] = limit
	}
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/query", body, &out)
}

// WarehouseTemplates lists built-in batch/stream ETL recipes.
func (c *Client) WarehouseTemplates() (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("GET", warehousePath+"/templates", nil, &out)
}

// ListWarehouseJobs lists ETL jobs.
func (c *Client) ListWarehouseJobs() (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("GET", warehousePath+"/jobs", nil, &out)
}

// GetWarehouseJob fetches one ETL job.
func (c *Client) GetWarehouseJob(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("GET", warehousePath+"/jobs/"+url.PathEscape(id), nil, &out)
}

// CreateWarehouseJob creates a batch or stream ETL job.
func (c *Client) CreateWarehouseJob(body map[string]any) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/jobs", body, &out)
}

// RunWarehouseBatch runs a one-shot batch transform.
func (c *Client) RunWarehouseBatch(body map[string]any) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/etl/batch", body, &out)
}

// EnsureWarehouseStream idempotently creates a stream ingestion job.
func (c *Client) EnsureWarehouseStream(body map[string]any) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/etl/stream", body, &out)
}

// RunWarehouseJob runs a batch job manually.
func (c *Client) RunWarehouseJob(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/jobs/"+url.PathEscape(id)+"/run", nil, &out)
}

// PauseWarehouseJob pauses a stream worker.
func (c *Client) PauseWarehouseJob(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/jobs/"+url.PathEscape(id)+"/pause", nil, &out)
}

// ResumeWarehouseJob resumes a stream worker.
func (c *Client) ResumeWarehouseJob(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("POST", warehousePath+"/jobs/"+url.PathEscape(id)+"/resume", nil, &out)
}

// DeleteWarehouseJob deletes a job.
func (c *Client) DeleteWarehouseJob(id string) (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("DELETE", warehousePath+"/jobs/"+url.PathEscape(id), nil, &out)
}

// WarehousePipelineStatus returns datasets/jobs/consumer freshness counters.
func (c *Client) WarehousePipelineStatus() (map[string]any, error) {
	var out map[string]any
	return out, c.warehouseReq("GET", warehousePath+"/pipeline/status", nil, &out)
}
