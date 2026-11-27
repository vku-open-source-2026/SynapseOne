# OCS service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseOCS is bucket-aware object cloud storage backed by an S3/MinIO-compatible
service or filesystem backend. It adds tenant-scoped buckets, raw object I/O,
copy, delimited listing, presigned URLs, and multipart uploads. The legacy
`/v1/storage` API remains available for default-bucket clients.

See [Object storage](../object-storage.md), [Warehouse](warehouse.md),
[Lakehouse](lakehouse.md), and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET/POST | `/v1/ocs/buckets` | List (optionally with stats) or create a bucket. |
| GET/HEAD | `/v1/ocs/buckets/:bucket` | Bucket metadata/headers. |
| GET | `/v1/ocs/buckets/:bucket/stats` | Object/byte/quota usage. |
| DELETE | `/v1/ocs/buckets/:bucket?force=true` | Delete an empty bucket, or all objects with `force`. |
| PUT/GET/HEAD/DELETE | `/v1/ocs/buckets/:bucket/objects/*` | Raw object body and metadata. |
| GET | `/v1/ocs/buckets/:bucket/objects?prefix=&delimiter=&limit=&cursor=` | List objects/common prefixes. |
| POST | `/v1/ocs/buckets/:bucket/objects/copy` | Copy within or across visible buckets. |
| POST | `/v1/ocs/buckets/:bucket/presign` | HMAC-signed GET/PUT/DELETE/HEAD URL. |
| GET | `/v1/ocs/signed/*` | Public signed URL; the URL token is the credential. |
| POST | `/v1/ocs/buckets/:bucket/uploads` | Start multipart upload. |
| PUT | `/v1/ocs/buckets/:bucket/uploads/:id/parts/:n?key=...` | Upload a raw part. |
| POST | `/v1/ocs/buckets/:bucket/uploads/:id/complete` | Complete with ordered part etags. |
| DELETE | `/v1/ocs/buckets/:bucket/uploads/:id?key=...` | Abort multipart upload. |
| Various | `/v1/storage/...` | Legacy default-bucket object API. |

## Important semantics and limits

- **Tenancy:** buckets and objects are tenant-scoped. Cross-tenant access
  returns `404` rather than exposing another tenant's resource names.
- **Raw bodies:** object upload/download is binary, not JSON-wrapped. SDK object
  methods accept bytes/strings and return bytes/metadata.
- **Checksums/conditions:** uploads can send `x-object-checksum-sha256`; reads
  support `Range`, `If-None-Match`, and `If-Match`.
- **Quotas:** buckets can set `quotaBytes`. Stats distinguish object count and
  stored bytes; the default bucket is protected from deletion.
- **Listing:** `prefix` filters keys, `delimiter` groups common prefixes, and
  `nextCursor` continues a page. Do not treat listing as a transactional snapshot.
- **Copy:** `sourceBucket` defaults to the destination bucket. Copy stays within
  the caller's visible tenant buckets.
- **Presign:** the returned URL is a bearer capability bound to tenant, bucket,
  key, method, and expiry. Do not log it or give it to a broader audience.
- **Signed route:** `/v1/ocs/signed/*` is public at the gateway specifically to
  validate the signature. Other OCS routes require normal gateway auth.
- **Multipart:** complete with `{key, parts:[{partNumber,etag}]}`. Abort
  abandoned uploads; cleanup of orphaned uploads is operator-driven.
- **SDK binary cap:** the SDKs default to a 128 MiB binary-response cap. Large
  object downloads should use range requests or direct presigned transfer.
- **Lakehouse separation:** ordinary OCS keys live below the tenant prefix;
  Iceberg data lives under a separate `lakehouse/` area and is not addressable
  as a normal tenant object key.

## Authentication and scopes

OCS and legacy storage accept a Bearer JWT or API key and use the **`storage`**
namespace:

- Reads/head/list/stats: `storage:read`.
- Bucket/object writes and presign creation: `storage:write`.
- Deletes: `storage:delete`.
- `storage:*` covers both `/v1/ocs` and `/v1/storage`.

There is no separate `ocs` credential-scope namespace. IAM policy checks are
additional in enforce mode. Signed URLs authenticate by signature and do not
need an `Authorization` header.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});
await client.ocs.createBucket('assets', { quotaBytes: 10 * 1024 * 1024 });
await client.ocs.putObject('assets', 'docs/hello.txt', 'hello', {
  contentType: 'text/plain',
});
const bytes = await client.ocs.getObject('assets', 'docs/hello.txt');
const signed = await client.ocs.presign('assets', 'docs/hello.txt', {
  method: 'GET',
  expiresIn: 900,
});
void signed; // share signed.url only with an authorized client
console.log(new TextDecoder().decode(bytes));
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
client.ocs.create_bucket("assets", quota_bytes=10 * 1024 * 1024)
client.ocs.put_object("assets", "docs/hello.txt", b"hello", content_type="text/plain")
content = client.ocs.get_object("assets", "docs/hello.txt")
signed = client.ocs.presign("assets", "docs/hello.txt", method="GET", expires_in=900)
_ = signed  # share signed["url"] only with an authorized client
print(content.decode())
```

### Go

```go
package main

import (
    "fmt"
    "os"

    synapseone "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"
)

func main() {
    client := synapseone.New(os.Getenv("SYNAPSEONE_BASE_URL"))
    client.SetAPIKey(os.Getenv("SYNAPSEONE_API_KEY"))

    if _, err := client.CreateOcsBucket("assets", 10*1024*1024); err != nil {
        panic(err)
    }
    if _, err := client.PutOcsObject("assets", "docs/hello.txt", []byte("hello"), "text/plain", ""); err != nil {
        panic(err)
    }
    content, err := client.GetOcsObject("assets", "docs/hello.txt", "")
    if err != nil {
        panic(err)
    }
    signed, err := client.PresignOcs("assets", "docs/hello.txt", "GET", 900)
    if err != nil {
        panic(err)
    }
    _ = signed // share signed["url"] only with an authorized client
    fmt.Println(string(content))
}
```

### Rust

```rust
use synapseone::{Credentials, SynapseOneClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = SynapseOneClient::new(
        std::env::var("SYNAPSEONE_BASE_URL")
            .unwrap_or_else(|_| "https://api.synapseone.space".to_string()),
        Credentials::api_key(std::env::var("SYNAPSEONE_API_KEY")?),
    )?;
    client.ocs().create_bucket("assets", Some(10 * 1024 * 1024)).await?;
    client.ocs().put_object(
        "assets", "docs/hello.txt", "hello".as_bytes(), "text/plain", None,
    ).await?;
    let content = client.ocs()
        .get_object("assets", "docs/hello.txt", None, None, None)
        .await?;
    let signed = client.ocs().presign("assets", "docs/hello.txt", "GET", 900).await?;
    let _ = signed; // share signed["url"] only with an authorized client
    println!("{}", String::from_utf8(content.to_vec())?);
    Ok(())
}
```
