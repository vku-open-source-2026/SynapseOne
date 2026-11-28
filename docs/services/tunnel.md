# Synapse Tunnel service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Synapse Tunnel is the Tier-1 edge capability for publishing HTTP applications
behind NAT or private networks. It has a control plane, public HTTP ingress, and
an outbound-only connector. Existing gateway and Tier-2/3 integration are
intentionally pending.

See [Synapse Tunnel operations](../synapse-tunnel.md) and the
[service README](../../apps/tunnel-service/README.md).

## Main gateway routes

These routes are currently served directly by the tunnel control plane on port
`4015`; they are not mounted on the existing SynapseOne gateway yet.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health`, `/ready` | Public control-plane health/readiness. |
| GET/POST | `/v1/connectors` | List or create a connector; create returns its token once. |
| GET/PATCH/DELETE | `/v1/connectors/:id` | Read, update, disable, or delete a connector. |
| GET/POST | `/v1/routes` | List or create hostname/path routes. |
| GET/PATCH/DELETE | `/v1/routes/:id` | Read, update, or delete a route. |
| WS | `/_synapse/tunnel/connect` | Authenticated outbound connector protocol. |

## Important semantics and limits

- HTTP/SSE streaming is supported. Raw WebSocket, TCP, and UDP passthrough are not.
- Connectors open no inbound listener; they dial the ingress outbound.
- Host routes ignore the port and use the longest enabled path prefix.
- Unknown hosts return `404`; offline connectors `502`; header timeout `504`.
- Request bodies are buffered; responses stream with a cumulative size cap.
- One JSON writer/instance. No HA, shared rate-limit store, or database.
- TLS termination and existing API Gateway integration are external/future work.

## Authentication and scopes

Management routes require:

```http
Authorization: Bearer <SYNAPSETUNNEL_ADMIN_TOKEN>
```

Connectors use a separate one-time bearer token at the WebSocket endpoint. Only
its SHA-256 hash is stored. Public tunneled applications must still enforce
end-user authentication and authorization.

## SDK usage

The SDKs do not yet wrap Synapse Tunnel, so these examples use generic HTTP.

### JavaScript/TypeScript

```ts
const base = process.env.SYNAPSETUNNEL_API_URL ?? 'http://127.0.0.1:4015';
const token = process.env.SYNAPSETUNNEL_ADMIN_TOKEN!;

const created = await fetch(`${base}/v1/connectors`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'city-app', upstreamUrl: 'http://127.0.0.1:3000' }),
});
if (!created.ok) throw new Error(await created.text());
const { connector, token: connectorToken } = await created.json();
console.log(connector.id, connectorToken); // handle the one-time token securely
```

### Python

```python
import json
import os
import urllib.request

request = urllib.request.Request(
    os.environ.get("SYNAPSETUNNEL_API_URL", "http://127.0.0.1:4015") + "/v1/connectors",
    data=json.dumps({"name": "city-app", "upstreamUrl": "http://127.0.0.1:3000"}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["SYNAPSETUNNEL_ADMIN_TOKEN"],
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request) as response:
    payload = json.load(response)
print(payload["connector"]["id"], payload["token"])
```

### Go

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
)

func main() {
    body := bytes.NewBufferString(`{"name":"city-app","upstreamUrl":"http://127.0.0.1:3000"}`)
    req, _ := http.NewRequest("POST", os.Getenv("SYNAPSETUNNEL_API_URL")+"/v1/connectors", body)
    req.Header.Set("Authorization", "Bearer "+os.Getenv("SYNAPSETUNNEL_ADMIN_TOKEN"))
    req.Header.Set("Content-Type", "application/json")
    res, err := http.DefaultClient.Do(req)
    if err != nil { panic(err) }
    defer res.Body.Close()
    var payload map[string]any
    if err := json.NewDecoder(res.Body).Decode(&payload); err != nil { panic(err) }
    fmt.Println(payload)
}
```

### Rust

```rust
use reqwest::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = std::env::var("SYNAPSETUNNEL_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4015".to_string());
    let response = Client::new()
        .post(format!("{base}/v1/connectors"))
        .bearer_auth(std::env::var("SYNAPSETUNNEL_ADMIN_TOKEN")?)
        .json(&serde_json::json!({
            "name": "city-app",
            "upstreamUrl": "http://127.0.0.1:3000"
        }))
        .send()
        .await?
        .error_for_status()?;
    println!("{}", response.text().await?);
    Ok(())
}
```
