// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package synapseone

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestLakehouseTableLifecycleAndSnapshots(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	c.SetToken("tok")

	if _, err := c.LakehouseUsage(); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lakehouse/usage" {
		t.Fatalf("usage path: %s", seen["path"])
	}
	if _, err := c.LakehouseCreateNamespace("analytics"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/lakehouse/namespaces" {
		t.Fatalf("create namespace: %s %s", seen["method"], seen["path"])
	}
	if _, err := c.LakehouseCreateTable("analytics", map[string]any{
		"name":   "events",
		"schema": map[string]any{"id": "long", "city": "string"},
	}); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lakehouse/namespaces/analytics/tables" || body["name"] != "events" {
		t.Fatalf("create table: %s %#v", seen["path"], body)
	}
	if _, err := c.LakehouseTable("analytics", "events"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lakehouse/namespaces/analytics/tables/events" {
		t.Fatalf("get table: %s", seen["path"])
	}
	if _, err := c.LakehouseSnapshots("analytics", "events"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lakehouse/namespaces/analytics/tables/events/snapshots" {
		t.Fatalf("snapshots: %s", seen["path"])
	}
	add := []map[string]any{{"name": "country", "type": "string", "required": false}}
	if _, err := c.LakehouseEvolveSchema("analytics", "events", add); err != nil {
		t.Fatal(err)
	}
	var evolvedBody struct {
		Add []map[string]any `json:"add"`
	}
	if err := json.Unmarshal([]byte(seen["body"]), &evolvedBody); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lakehouse/namespaces/analytics/tables/events/schema" ||
		!reflect.DeepEqual(evolvedBody.Add, add) {
		t.Fatalf("evolve schema: %s %#v", seen["path"], evolvedBody)
	}
	if _, err := c.LakehouseDeleteTable("analytics", "events"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" || seen["path"] != "/v1/lakehouse/namespaces/analytics/tables/events" {
		t.Fatalf("delete table: %s %s", seen["method"], seen["path"])
	}
	if _, err := c.LakehouseDeleteNamespace("analytics"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" || seen["path"] != "/v1/lakehouse/namespaces/analytics" {
		t.Fatalf("delete namespace: %s %s", seen["method"], seen["path"])
	}
}
