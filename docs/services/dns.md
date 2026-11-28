# SynapseDNS service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseDNS is the Tier-1 authoritative DNS capability. It serves DNS over UDP and
TCP and manages zones/records through a standalone HTTP API. It does not recurse
or forward queries. Existing gateway integration is intentionally pending.

See [SynapseDNS operations](../synapsedns.md) and the
[service README](../../apps/dns-service/README.md).

## Main gateway routes

These routes are currently served directly by SynapseDNS on port `4014`; they are
not mounted on the existing SynapseOne gateway yet.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Public liveness and version. |
| GET | `/ready` | Public readiness; `503` until DNS listeners/store are ready. |
| GET/POST | `/v1/zones` | List or create a zone with SOA/NS defaults. |
| GET/DELETE | `/v1/zones/:zone` | Read or delete a zone. |
| GET/POST | `/v1/zones/:zone/records` | List or create records. |
| PATCH/DELETE | `/v1/zones/:zone/records/:recordId` | Update or delete a record. |

## Important semantics and limits

- Authoritative-only: unknown zones return `REFUSED`; known missing names return
  `NXDOMAIN`; existing names without the requested type return `NODATA`.
- Supports `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SOA`, `SRV`, `CAA`, and `PTR`.
- Wildcards, empty non-terminals, in-zone CNAME chains, delegation referrals, and
  UDP truncation are implemented.
- One JSON writer/instance per data file. There is no DNSSEC, AXFR, recursion,
  database, or HA in the MVP.
- Do not delegate production NS until every record is migrated and verified.

## Authentication and scopes

All `/v1/*` management routes require:

```http
Authorization: Bearer <SYNAPSEDNS_ADMIN_TOKEN>
```

DNS queries themselves are unauthenticated. Keep the management API private.
The token is an operator credential, not a tenant API key.

## SDK usage

The SDKs do not yet wrap SynapseDNS, so these examples use their generic HTTP
escape hatches.

### JavaScript/TypeScript

```ts
const base = process.env.SYNAPSEDNS_API_URL ?? 'http://127.0.0.1:4014';
const token = process.env.SYNAPSEDNS_ADMIN_TOKEN!;

const zone = await fetch(`${base}/v1/zones`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'example.test', nameservers: ['ns1.example.test'] }),
});
if (!zone.ok) throw new Error(await zone.text());
console.log(await zone.json());
```

### Python

```python
import json
import os
import urllib.request

request = urllib.request.Request(
    os.environ.get("SYNAPSEDNS_API_URL", "http://127.0.0.1:4014") + "/v1/zones",
    data=json.dumps({"name": "example.test", "nameservers": ["ns1.example.test"]}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["SYNAPSEDNS_ADMIN_TOKEN"],
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request) as response:
    print(json.load(response))
```

### Go

```go
package main

import (
    "bytes"
    "fmt"
    "net/http"
    "os"
)

func main() {
    body := bytes.NewBufferString(`{"name":"example.test","nameservers":["ns1.example.test"]}`)
    req, _ := http.NewRequest("POST", os.Getenv("SYNAPSEDNS_API_URL")+"/v1/zones", body)
    req.Header.Set("Authorization", "Bearer "+os.Getenv("SYNAPSEDNS_ADMIN_TOKEN"))
    req.Header.Set("Content-Type", "application/json")
    res, err := http.DefaultClient.Do(req)
    if err != nil { panic(err) }
    defer res.Body.Close()
    fmt.Println(res.Status)
}
```

### Rust

```rust
use reqwest::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = std::env::var("SYNAPSEDNS_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4014".to_string());
    let response = Client::new()
        .post(format!("{base}/v1/zones"))
        .bearer_auth(std::env::var("SYNAPSEDNS_ADMIN_TOKEN")?)
        .json(&serde_json::json!({
            "name": "example.test",
            "nameservers": ["ns1.example.test"]
        }))
        .send()
        .await?
        .error_for_status()?;
    println!("{}", response.text().await?);
    Ok(())
}
```
