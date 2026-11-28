<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

# Organization ownership migration for SynapseDNS and Synapse Tunnel

## What changes

- DNS zones gain `orgId: string | null`.
- Tunnel connectors gain `orgId: string | null`; routes inherit ownership from
  their connector.
- Tenant management moves to `/v1/dns/*` and `/v1/tunnel/*` on the gateway.
  Console pages move to `/dns` and `/tunnel`.
- `dns:read`, `dns:write`, `dns:*`, `tunnel:read`, `tunnel:write`, and
  `tunnel:*` become valid tenant API-key scopes.
- Platform operators keep direct admin-token access and the separate
  `/v1/platform/edge/*` routes.

Version-1 JSON snapshots are upgraded to version 2 on load. Every existing zone
or connector receives `orgId=null`, meaning **platform-owned**. No existing
resource is silently assigned to a tenant. Tenant list/get/mutation operations
return `404` for resources owned by another organization.

## Deployment order

1. Back up `synapsedns.json` and `synapse-tunnel.json` from their volumes.
2. Deploy IAM with the new tenant scope catalog.
3. Deploy the gateway with `/v1/dns` and `/v1/tunnel` routes.
4. Set the same `SYNAPSEONE_INTERNAL_SECRET` on the gateway, SynapseDNS and
   Synapse Tunnel. A blank service-side secret disables tenant management with
   `503 internal_auth_unavailable`; direct admin access still works.
5. Deploy SynapseDNS and Synapse Tunnel and wait for `/ready`.
6. Deploy Console and verify `/dns` and `/tunnel` with a normal organization
   user, not a platform token.

The gateway strips client-supplied `x-synapseone-*` headers and stamps verified
identity. Services validate `x-synapseone-internal` before trusting
`x-synapseone-org` or the service-account fallback `x-synapseone-owner-org`.

## Verification

- Org A creates a zone, connector, route and DNS record; Org B cannot list, read,
  patch or delete them.
- Org B receives `404`, not `403`, for another org's resource ID.
- A `dns:read` or `tunnel:read` API key cannot mutate resources; the matching
  `write` scope can.
- A service-account JWT can manage only its verified owning organization's
  resources.
- Platform admin-token access still lists and manages all resources.
- Connector tokens remain one-time secrets and are never returned by list/get.

## Rollback

Stop writes before rollback. Restore the version-1 JSON backups and redeploy the
previous IAM, gateway, DNS, Tunnel and Console images together. Do not run the
new Console against old services: `/v1/dns` and `/v1/tunnel` will not exist, and
new version-2 ownership fields are ignored by the old stores. Keep the old DNS
provider/NS unchanged throughout the migration.
