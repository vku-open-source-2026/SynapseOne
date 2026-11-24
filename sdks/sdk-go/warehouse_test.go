// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package synapseone

import "testing"

func TestWarehouseDatasetJobAndETLPaths(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	c.SetToken("tok")

	if _, err := c.ListWarehouseDatasetsPage(map[string]string{"limit": "10", "offset": "20", "name": "qa"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/warehouse/datasets?limit=10&name=qa&offset=20" {
		t.Fatalf("datasets page path: %s", seen["path"])
	}
	if _, err := c.UpdateWarehouseDataset("ds1", map[string]any{"name": "renamed"}); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PATCH" || seen["path"] != "/v1/warehouse/datasets/ds1" {
		t.Fatalf("dataset patch: %v %v", seen["method"], seen["path"])
	}
	if _, err := c.ListWarehouseJobsPage(map[string]string{"status": "paused", "mode": "stream"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/warehouse/jobs?mode=stream&status=paused" {
		t.Fatalf("jobs page path: %s", seen["path"])
	}
	if _, err := c.UpdateWarehouseJob("job1", map[string]any{"name": "renamed"}); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PATCH" || seen["path"] != "/v1/warehouse/jobs/job1" {
		t.Fatalf("job patch: %v %v", seen["method"], seen["path"])
	}
	if _, err := c.WarehouseETLBase(map[string]any{"collection": "parks"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/warehouse/etl/base" {
		t.Fatalf("path A: %s", seen["path"])
	}
	if _, err := c.WarehouseETLLakehouse(map[string]any{"namespace": "analytics"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/warehouse/etl/lakehouse" {
		t.Fatalf("path C: %s", seen["path"])
	}
}
