# IAM service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

IAM owns users, organizations, accounts, roles, policies, API keys, service
accounts, sessions, MFA, SCIM provisioning, audit records, and usage telemetry.
It is also the authority used by the gateway for scope and policy decisions.

See [API reference](../api.md), [IAM model](../iam-model.md), and
[Authentication/SSO](../authentication-sso.md) for the broader identity model.

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/auth/login` | Password or development passwordless login. |
| POST | `/v1/auth/register` | First-party registration. |
| POST | `/v1/auth/mfa/verify` | Complete an MFA challenge. |
| POST | `/v1/auth/refresh`, `/v1/auth/logout`, `/v1/auth/logout-all` | Rotate or revoke refresh sessions. |
| GET | `/v1/auth/verify`, `/v1/auth/me`, `/v1/auth/sessions`, `/v1/auth/contexts` | Current identity and sessions. |
| GET/POST/PATCH | `/v1/orgs[/:orgId]` | List, create, and rename organizations. |
| GET/POST | `/v1/orgs/:orgId/accounts`, `/v1/orgs/:orgId/users` | Account and user administration. |
| GET/PATCH | `/v1/accounts/:accountId`, `/v1/users/:userId` | Account/user metadata. |
| GET/POST/PATCH/DELETE | `/v1/accounts/:accountId/roles`, `/v1/roles/:roleId` | Role lifecycle. |
| GET/POST/PATCH/DELETE | `/v1/accounts/:accountId/policies`, `/v1/policies/:policyId` | Policy lifecycle. |
| POST/DELETE | `/v1/roles/:roleId/attach`, `/v1/roles/:roleId/policies/:policyId` | Attach/detach a policy. |
| POST/DELETE | `/v1/users/:userId/assign`, `/v1/users/:userId/roles/:roleId` | Assign/unassign a role. |
| POST | `/v1/authorize`, `/v1/authorize/dry-run` | Authorize one action or simulate policy documents. |
| GET/POST/DELETE | `/v1/accounts/:accountId/keys`, `/v1/keys/:id` | Create, list, inspect, and revoke API keys. |
| POST | `/v1/keys/:id/rotate`, `/v1/keys/verify` | Rotate a key or verify a plaintext key. |
| GET/POST | `/v1/accounts/:accountId/service-accounts` | Create/list machine identities. |
| POST | `/v1/service-accounts/:id/token`, `/v1/service-accounts/:id/roles` | Mint a token or grant a role. |
| GET/POST/DELETE | `/v1/scim/tokens[/:id]` | Manage SCIM bearer tokens. |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/Users`, `/scim/v2/Groups` | SCIM 2.0 provisioning surface. |
| GET | `/v1/audit`, `/v1/usage/summary`, `/v1/usage/events` | Tenant-scoped audit and usage reads. |

## Important semantics and limits

- **Tenant isolation:** reads and writes are constrained to the caller's
  organization/account. Cross-tenant writes are refused; many cross-tenant reads
  return `404` to avoid resource enumeration.
- **Org administrators:** the first user of a new organization becomes its
  administrator. Later users have no permissions until granted roles. The last
  administrator cannot be demoted (`409 last_admin`).
- **Validation:** slugs match `^[a-z0-9-]{1,64}$`; display names are 2–200
  characters; emails are normalized and limited to 320 characters. Passwords
  are 12–128 characters.
- **Policy documents:** 1–100 statements; `Effect` is `Allow` or `Deny`; action
  and resource patterns are at most 512 characters; conditions are at most
  8 KiB. Dry-run accepts at most 20 documents.
- **Scopes:** a key/service-account token accepts 1–100 scope strings of at most
  200 characters. Key creation defaults to `["*:read"]`; `["*"]` is explicit
  full authority. A caller cannot create scopes beyond its own authority.
- **One-time secrets:** API-key plaintext is returned only by create/rotate.
  Lists and detail reads contain metadata, never the secret or its hash.
- **Refresh rotation:** refresh tokens are single-use. Reusing a consumed token
  revokes the token family; clients must serialize refresh calls.
- **MFA:** an MFA login returns `401 mfa_required` with a short-lived challenge
  token, not an access token. TOTP codes are replay-protected and recovery codes
  are single-use. Self-service MFA does not accept API keys or delegated tokens.
- **Service accounts:** tokens are account-bound. Omitting `scopes` delegates the
  caller's scopes; passing scopes can narrow, not widen, authority.
- **Delegation:** `/v1/auth/exchange` requires an account-level operator API key
  or service-account Bearer token. User-bound keys are rejected, and target
  user/org/account state and requested scopes are rechecked.
- **Retention:** hard deletion of organizations, accounts, and users is not
  supported. Retirement/suspension lifecycle operations preserve resources.

## Authentication and scopes

The gateway accepts Bearer JWTs or API keys on IAM management routes and maps
them to the `iam` namespace:

- `GET`/`HEAD` normally require `iam:read`.
- `DELETE` normally requires `iam:delete`.
- Other methods normally require `iam:write`.
- `iam:*` covers the namespace; `*:read` and `*:write` are broader alternatives.

`POST /v1/authorize` and `/v1/authorize/dry-run` are mapped to `iam:Read` by the
gateway. With central authorization enabled, IAM policy evaluation is additional
to credential scopes. Admin-only operations also enforce organization or
platform role requirements inside IAM.

`/v1/auth/*` is public at the gateway, but authenticated self-service routes
still require a user Bearer token. `/scim/v2/*` is public at the gateway only so
that IAM can authenticate the SCIM token itself; ordinary user JWTs are rejected.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

The examples sign in with placeholders supplied through environment variables,
then mint a read-only Base key. Handle a `401 mfa_required` response with the
SDK's MFA verification method before using the access token.

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const baseUrl = process.env.SYNAPSEONE_BASE_URL;
let client = new SynapseOneClient({ baseUrl });

const session = await client.iam.loginWithPassword({
  email: process.env.SYNAPSEONE_EMAIL!,
  password: process.env.SYNAPSEONE_PASSWORD!,
  orgSlug: process.env.SYNAPSEONE_ORG_SLUG!,
});
client.setToken(session.accessToken);

const orgs = await client.iam.listOrgs();
const key = await client.iam.createApiKey(
  process.env.SYNAPSEONE_ACCOUNT_ID!,
  'sdk-reader',
  ['base:read'],
) as { apiKey: string; id: string; prefix: string };
client.setApiKey(key.apiKey); // returned once; store it securely
console.log(orgs, key.id, key.prefix);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

base_url = os.environ.get("SYNAPSEONE_BASE_URL")
client = SynapseOneClient(base_url=base_url)
session = client.iam.login_with_password(
    os.environ["SYNAPSEONE_EMAIL"],
    os.environ["SYNAPSEONE_PASSWORD"],
    os.environ["SYNAPSEONE_ORG_SLUG"],
)
client.set_token(session["accessToken"])

orgs = client.iam.list_orgs()
key = client.iam.create_api_key(
    os.environ["SYNAPSEONE_ACCOUNT_ID"], "sdk-reader", ["base:read"]
)
client.set_api_key(key["apiKey"])  # returned once; store it securely
print(orgs, key["id"], key["prefix"])
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
    session, err := client.LoginWithPassword(
        os.Getenv("SYNAPSEONE_EMAIL"),
        os.Getenv("SYNAPSEONE_PASSWORD"),
        os.Getenv("SYNAPSEONE_ORG_SLUG"),
    )
    if err != nil {
        panic(err)
    }
    client.SetToken(session["accessToken"].(string))

    orgs, err := client.ListOrgs()
    if err != nil {
        panic(err)
    }
    key, err := client.CreateAPIKey(
        os.Getenv("SYNAPSEONE_ACCOUNT_ID"), "sdk-reader", []string{"base:read"},
    )
    if err != nil {
        panic(err)
    }
    client.SetAPIKey(key["apiKey"].(string)) // returned once; store it securely
    fmt.Println(orgs, key["id"], key["prefix"])
}
```

### Rust

Rust `regenerate_recovery_codes` requires a TOTP code. Use `disable_mfa` with a
TOTP code or `disable_mfa_with_recovery_code` with a recovery code; the helper
below shows both alternatives without running them.

```rust
use synapseone::{Credentials, SynapseOneClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = std::env::var("SYNAPSEONE_BASE_URL")
        .unwrap_or_else(|_| "https://api.synapseone.space".to_string());
    let client = SynapseOneClient::new(base_url.clone(), Credentials::none())?;
    let session = client.iam().login_with_password(
        &std::env::var("SYNAPSEONE_EMAIL")?,
        &std::env::var("SYNAPSEONE_PASSWORD")?,
        &std::env::var("SYNAPSEONE_ORG_SLUG")?,
    ).await?;
    let token = session["accessToken"].as_str().ok_or("missing accessToken")?;
    let client = SynapseOneClient::new(base_url.clone(), Credentials::token(token))?;

    let orgs = client.iam().list_orgs().await?;
    let key = client.iam().create_api_key(
        &std::env::var("SYNAPSEONE_ACCOUNT_ID")?,
        "sdk-reader",
        Some(vec!["base:read".to_string()]),
        None,
        None,
    ).await?;
    println!("{orgs} {} {}", key["id"], key["prefix"]);
    Ok(())
}

#[allow(dead_code)]
async fn mfa_actions(client: &SynapseOneClient, use_recovery_code: bool) -> synapseone::Result<()> {
    let regenerated = client.iam()
        .regenerate_recovery_codes("<totp-code-for-regenerate>")
        .await?;
    println!("{regenerated}");
    if use_recovery_code {
        client.iam()
            .disable_mfa_with_recovery_code("<recovery-code>")
            .await?;
    } else {
        client.iam().disable_mfa("<totp-code-for-disable>").await?;
    }
    Ok(())
}
```
