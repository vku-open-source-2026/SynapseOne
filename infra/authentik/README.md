# Authentik — default IdP (swappable with Keycloak)

Compose stands up `authentik-server:9000` + `authentik-worker` sharing Postgres/Redis.

## First-time bootstrap

1. Sign in at `http://localhost:19000` as `akadmin` (password below),
   then **change the password immediately** (user menu → Change password).
2. Create a Provider (OAuth2/OIDC):
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client ID: `synapseone-platform` (matches `OIDC_CLIENT_ID`)
   - Redirect URI: your Console `/oidc/callback` page, e.g.
     `https://cloud.example.com/oidc/callback` (matches `OIDC_REDIRECT_URI`;
     local dev without a frontend page may use the API callback instead)
3. Create the `synapseone` Application, attach the provider, take the slug →
   `OIDC_ISSUER=http://localhost:19000/application/o/synapseone/` for browsers, while
   inside the docker network IAM uses
   `OIDC_ISSUER=http://authentik-server:9000/application/o/synapseone/`.
4. Put `OIDC_CLIENT_SECRET` in `.env`, `docker compose up -d iam`.

> Deploy note: the Authentik image doesn't print the bootstrap password to the log, so
> the `akadmin` password is seeded directly via the DB at creation time (Django PBKDF2).
> Change it right after signing in. Reset when needed via UPDATE on
> `authentik_core_user` or Authentik's recovery flow.

## Using Keycloak instead

1. Stand up Keycloak (outside compose, or add a service).
2. Create a realm (e.g. `synapseone`) and a `synapseone-platform` client (standard flow,
   same redirect as above).
3. Change `.env`: `OIDC_ISSUER=https://<host>/realms/synapseone`,
   matching `OIDC_CLIENT_ID`/`SECRET`.
4. No IAM code changes — `GET /v1/auth/oidc/config` reflects the new issuer.

## Sign-in flow (real Authorization Code, no demo shortcuts)

`GET /v1/auth/oidc/start?org=<slug>` → open `authorizeUrl` → IdP redirects to
`OIDC_REDIRECT_URI` with `?code&state` → `POST /v1/auth/oidc/callback {code, state}`
redeems the code and verifies the ID token against the IdP JWKS. The legacy
demo-email callback only exists for local dev (`IAM_ALLOW_OIDC_DEMO_CALLBACK=true`).

## Production (synapseone.space): status and how to enable SSO

Status on 2026-11-06: SSO is **not enabled** in production. Sign-in works with
email + password (with TOTP MFA when enrolled) and API keys.

- The Authentik containers run and are healthy, but no `synapseone` application or
  provider exists yet: discovery at `/application/o/synapseone/` returns 404, so
  `GET /v1/auth/oidc/start` answers `502 oidc_discovery_failed`.
- `.env` points `OIDC_ISSUER` at the internal `http://authentik-server:9000/...`,
  which a browser cannot open, and there is no public hostname for Authentik.
- Authentik 2024.10 cannot be served under a path such as `/auth/`, so it needs its
  own hostname. None of the team domains has wildcard DNS.

Steps to enable it:

1. **DNS**: add an A record `auth.synapseone.space` → the host IP (same as
   `api.synapseone.space`).
2. **TLS**: add `-d auth.${DOMAIN}` to `ARGS` in `infra/prod/init-letsencrypt.sh`
   and expand the certificate:
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm certbot certonly --webroot -w /var/www/certbot --expand <all -d flags>`.
3. **nginx**: add a `server_name auth.@@DOMAIN@@;` block to
   `infra/prod/nginx-prod.conf` (same TLS lines as the console block) that proxies
   `location /` to `http://authentik-server:9000` with `Host $host`,
   `X-Forwarded-Proto https` and WebSocket upgrade headers
   (`Upgrade $http_upgrade`, `Connection "upgrade"`). Rebuild and recreate `nginx`
   (or copy the rendered config into the container and `nginx -s reload`).
4. **Authentik admin**: finish `https://auth.synapseone.space/if/flow/initial-setup/`
   (admin email + password) and store the password outside the repo.
5. **Provider and application** (Admin → Applications → Create with provider):
   OAuth2/OIDC, client type confidential, client ID `synapseone-platform`,
   redirect URI (strict) `https://cloud.synapseone.space/oidc/callback`, authorization
   flow `default-provider-authorization-implicit-consent`, scopes `openid email
   profile`, signing key `authentik Self-signed Certificate`. Application slug
   `synapseone`. Copy the generated client secret.
6. **IAM**: in `.env` set
   `OIDC_ISSUER=https://auth.synapseone.space/application/o/synapseone/`,
   `OIDC_CLIENT_SECRET=<secret>`,
   `OIDC_REDIRECT_URI=https://cloud.synapseone.space/oidc/callback`, then recreate IAM
   (`docker compose -f docker-compose.yml up -d --no-deps iam`).
   Check `curl https://api.synapseone.space/v1/auth/oidc/start?org=acme` returns an
   `authorizeUrl` on `auth.synapseone.space`.
7. **Then**: set `IAM_ALLOW_DEV_LOGIN=false` and `IAM_ALLOW_OIDC_DEMO_CALLBACK=false`.
   With a public issuer, the production overlay (`NODE_ENV=production`) can also be
   used for the app services: its boot check rejects an internal `OIDC_ISSUER`.
