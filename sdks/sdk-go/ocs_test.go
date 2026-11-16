// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package synapseone

import "testing"

func TestOcsBucketAndObjectRequests(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.CreateOcsBucket("media", 1024); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/ocs/buckets" {
		t.Fatalf("create bucket: %v", seen)
	}
	if _, err := c.ListOcsBuckets(true); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/ocs/buckets?withStats=1" {
		t.Fatalf("list buckets: %v", seen)
	}
	if _, err := c.PutOcsObject("media", "a/b.txt", []byte("hello"), "text/plain", ""); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/ocs/buckets/media/objects/a/b.txt" {
		t.Fatalf("put object: %v", seen)
	}
	if _, err := c.ListOcsObjects("media", "a/", "/", 10, ""); err != nil {
		t.Fatal(err)
	}
	if seen["path"] == "" {
		t.Fatalf("list objects path missing")
	}
	if _, err := c.DeleteOcsBucket("media", true); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/ocs/buckets/media?force=true" {
		t.Fatalf("delete bucket: %v", seen)
	}
}
