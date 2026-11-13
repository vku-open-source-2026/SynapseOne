# Authentication & public SSO (OIDC)

This document is the operator guide for the SynapseOne Console login, MFA, and
the public OIDC Authorization Code flow. It covers what the code enforces, how
to expose a real identity provider, and the exact steps to verify production.

## Components

| Piece | Responsibility |
|---|---|
| Console `/login` | Password, API key, and SSO entry points; explicit organization slug |
| Console `/oidc/callback` | Browser-bound state check, code POST, local MFA challenge |
| IAM `/v1/auth/oidc/*` | Discovery, signed state, PKCE, code exchange, ID-token validation, shadow user mapping |
| Authentik / Keycloak | Upstream identity provider (confidential OIDC client) |

The IAM service is the OIDC **confidential client**. The browser never receives
the client secret and never exchanges the authorization code. It only receives
an opaque `code` + `state` from the IdP and POSTs them to IAM.

## What the IAM flow enforces

- **Public HTTPS issuer.** `OIDC_ISSUER` must be a browser-reachable HTTPS URL
  in production. An internal Docker URL is rejected at boot unless the operator
  explicitly sets `IAM_ALLOW_INTERNAL_OIDC_ISSUER=true` as a temporary bridge.
- **Discovery document is authoritative.** Authorization/token/JWKS endpoints
  come from `<issuer>/.well-known/openid-configuration`; the advertised issuer
  must match `OIDC_ISSUER` exactly (trailing slash normalized).
- **Endpoints stay on the issuer origin.** A discovery document that points
  token/JWKS endpoints at another origin is rejected in production.
- **Signed state.** `state` is `base64url(payload).HMAC-SHA256` keyed by
  `OIDC_STATE_SECRET` (fallback: JWT secret). It carries the organization, a
  nonce, a PKCE verifier encrypted with AES-256-GCM, and a 10-minute expiry.
  The Console additionally stores the state in `sessionStorage` and refuses a
  callback whose state was not issued by the same tab (login CSRF protection).
- **PKCE S256.** The verifier never leaves IAM; the authorize URL carries only
  the S256 challenge, and the token request carries `code_verifier`.
- **Nonce.** The nonce is sent to the IdP and must match the `nonce` claim in
  the ID token.
- **ID token validation.** Signature via JWKS (`RS256`/`ES256`), issuer,
  audience/`azp`, expiry with 60 s clock tolerance, `sub`, and verified email.
  Symmetric (`HS256`) IdP tokens are refused.
- **Single-use authorization code.** The code is exchanged exactly once by IAM;
  the Console never retries a consumed code automatically.
- **Tenant membership.** The slug in the signed state selects the organization.
  Joining an **existing** org requires an existing user row for that email in
  that org. A new slug is self-service only when it is not the reserved platform
  slug (`PLATFORM_ORG_SLUG`, default `synapseone-platform`). A different IdP
  identity can never attach itself to another tenant by guessing a slug.
- **Local MFA is not bypassed.** If the mapped user has an enrolled TOTP factor,
  the callback returns `401 mfa_required` with a short-lived `mfaToken`; the
  Console must complete `/v1/auth/mfa/verify` before an access token is issued.
  Upstream IdP MFA can be additional assurance, never a replacement.
- **Platform separation.** OIDC signs in a normal user session. Platform Admin
  privileges still require the Platform Owner account, its local MFA, and the
  `/admin/*` platform guard. SSO cannot mint platform privileges.

Relevant code: `apps/iam-service/src/oidc.ts`,
`apps/iam-service/src/index.ts` (`/v1/auth/oidc/*`, `/v1/auth/mfa/verify`),
`apps/console/src/pages/Login.jsx`, `apps/console/src/pages/OidcCallback.jsx`.

## Production topology

```
Browser ──https──> cloud.synapseone.space  (Console)
   │                    │ POST code+state
   │                    ▼
   │              api.synapseone.space (Gateway → IAM)
   │                    │ discovery + token + JWKS (server-side)
   ▼                    ▼
auth.synapseone.space (nginx → authentik-server:9000)
```

The issuer is `https://auth.synapseone.space/application/o/<slug>/` and the
registered redirect URI is `https://cloud.synapseone.space/oidc/callback`.

## Activation checklist (external infrastructure)

These steps need DNS and TLS control. They are intentionally not automated by
the application.

### 1. DNS

Create an `A` record at the DNS provider (Spaceship for `synapseone.space`):

```
auth.synapseone.space.  A  136.85.84.73
```

Verify from a public resolver:

```bash
dig +short auth.synapseone.space A
# 136.85.84.73
```

Do not continue until this resolves; Let's Encrypt HTTP-01 validation and the
browser redirect both depend on it.

### 2. TLS certificate including `auth`

The existing certificate lineage does **not** include `auth.synapseone.space`.
Expand it with the same webroot flow used for the other hosts:

```bash
cd /path/to/SynapseOne
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  --cert-name synapseone.space --expand \
  --email "$LE_EMAIL" --agree-tos --no-eff-email --keep-until-expiring \
  -d synapseone.space -d cloud.synapseone.space -d api.synapseone.space \
  -d auth.synapseone.space \
  -d synapsedx.sbs -d cloud.synapsedx.sbs -d api.synapsedx.sbs \
  -d synapsecity.sbs -d sos.synapsecity.sbs -d contribution.synapsecity.sbs
```

`infra/prod/init-letsencrypt.sh` already includes `auth.${DOMAIN}` in its
`--expand` invocation. `infra/prod/renew.sh` only renews the existing lineage;
it does not add SANs, so the expansion above is required once.

Verify:

```bash
openssl s_client -connect auth.synapseone.space:443 -servername auth.synapseone.space </dev/null 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName | grep auth.synapseone.space
```

### 3. Edge routing

`infra/prod/nginx-prod.conf` contains an `auth.@@DOMAIN@@` HTTPS server that
proxies to `authentik-server:9000` and forwards `Host`, `X-Forwarded-Proto`,
and `X-Forwarded-Host`. `infra/prod/nginx-http-only.conf` includes the host in
the ACME/HTTP server so certificate issuance works before the TLS block is
active.

Rebuild/recreate only the edge after the certificate exists:

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build nginx
```

### 4. Authentik provider and application

Create a **confidential** OAuth2/OpenID provider in Authentik:

| Setting | Value |
|---|---|
| Application slug | `synapseone` |
| Client ID | `synapseone-platform` |
| Client secret | random 32+ bytes, stored only in `.env` |
| Redirect URI | `https://cloud.synapseone.space/oidc/callback` (strict) |
| Signing key | the Authentik self-signed certificate (or a dedicated RSA key) |
| Issuer mode | per provider |
| Scopes | `openid email profile` |
| Subject mode | stable user identifier (do not use email as `sub`) |

Attach the provider to the `synapseone` application. The discovery document
must advertise:

```json
{
  "issuer": "https://auth.synapseone.space/application/o/synapseone/",
  "authorization_endpoint": "https://auth.synapseone.space/application/o/authorize/",
  "token_endpoint": "https://auth.synapseone.space/application/o/token/",
  "jwks_uri": "https://auth.synapseone.space/application/o/synapseone/jwks/"
}
```

### 5. IAM environment

After DNS, TLS, nginx, and the provider are ready:

```dotenv
OIDC_ISSUER=https://auth.synapseone.space/application/o/synapseone/
OIDC_CLIENT_ID=synapseone-platform
OIDC_CLIENT_SECRET=<same secret as the Authentik provider>
OIDC_REDIRECT_URI=https://cloud.synapseone.space/oidc/callback
OIDC_STATE_SECRET=<random 32+ bytes, different from JWT secret>
IAM_ALLOW_INTERNAL_OIDC_ISSUER=false
# Optional: comma-separated org slugs allowed through SSO.
OIDC_ALLOWED_ORGS=
```

Restart IAM (and only IAM) after the change:

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate iam-service
```

`IAM_ALLOW_INTERNAL_OIDC_ISSUER=true` exists only to let a deployment boot while
the public hostname is being prepared. It is **not** a production substitute:
`/v1/auth/oidc/start` returns `503 sso_unavailable` in production whenever the
issuer is not public HTTPS, and the Console disables the SSO button.

## Verification

### Server-side

```bash
# 1. Discovery through the public edge
curl -fsS https://auth.synapseone.space/application/o/synapseone/.well-known/openid-configuration \
  | jq '{issuer, authorization_endpoint, token_endpoint, jwks_uri}'

# 2. IAM reports a usable public SSO configuration
curl -fsS https://api.synapseone.space/v1/auth/oidc/config \
  | jq '{issuer, clientId, redirectUri, issuerPublic, ssoAvailable}'

# 3. Start returns an authorize URL with PKCE + nonce + state
curl -fsS 'https://api.synapseone.space/v1/auth/oidc/start?org=<org-slug>' \
  | jq '{authorizeUrl, state}'
```

The `authorizeUrl` must contain `code_challenge_method=S256`, `code_challenge`,
`nonce`, `state`, `client_id=synapseone-platform`, and the exact redirect URI.

### Browser

1. Open `https://cloud.synapseone.space/login`, enter the organization slug,
   click **Sign in with SSO**.
2. Authenticate at `https://auth.synapseone.space`.
3. The browser returns to `/oidc/callback`; the Console exchanges the code and
   either lands on `/dashboard` or shows the local MFA form.
4. Complete MFA if the account has a TOTP factor.
5. Reload the page: the session must persist. Sign out: the session must be
   cleared and `/login` shown.

The Playwright suite used for the production smoke test lives outside the repo
(`tests/e2e` contains the CI-safe flows; production credentials are never
committed).

## Error reference

| Error | Meaning | Fix |
|---|---|---|
| `sso_unavailable` | Issuer is not public HTTPS in production | Finish DNS/TLS/nginx, switch `OIDC_ISSUER` |
| `oidc_org_required` | No organization slug supplied | Enter the slug on `/login` |
| `org_not_allowed` | Slug not in `OIDC_ALLOWED_ORGS` | Update the allowlist or use another org |
| `org_membership_required` | Email is not a member of the existing org | Invite the user first; SSO cannot auto-join |
| `reserved_org_slug` | Attempt to self-create the platform org | Use the provisioned Platform Owner account |
| `oidc_bad_state` / `oidc_state_expired` | State tampered with or older than 10 minutes | Restart sign-in |
| `oidc_bad_nonce` | ID token nonce does not match the request | Check IdP/provider configuration and retry |
| `oidc_bad_id_token` | Signature/issuer/audience/expiry invalid | Check signing key, issuer URL, client ID |
| `oidc_unknown_kid` | JWKS has no key for the token `kid` | Re-check the provider signing key |
| `oidc_discovery_failed` | IAM cannot read the discovery document | Check issuer URL and network path from IAM |
| `oidc_issuer_mismatch` | Discovery issuer differs from `OIDC_ISSUER` | Fix trailing slash / provider issuer mode |
| `oidc_no_email` / `oidc_email_unverified` | IdP did not return a verified email | Enable the `email` scope and verify the address |
| `account_deactivated` | Local user is disabled | Re-enable the account or contact an admin |

## Security notes

- Never put the client secret, `OIDC_STATE_SECRET`, or JWT secret in the Console
  bundle or in git. Only IAM reads them.
- The IdP management UI is not exposed by the edge configuration; only the
  OIDC endpoints are proxied under `/application/o/`.
- Do not enable `IAM_ALLOW_OIDC_DEMO_CALLBACK` in production. The demo callback
  trusts a caller-supplied email and is disabled when `NODE_ENV=production`.
- Do not weaken MFA or `AUTHZ_MODE` to make SSO pass. OIDC is an additional
  identity source, not an authorization bypass.
