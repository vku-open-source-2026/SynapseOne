# SDK 0.10.1

This release keeps the public SDK API compatible with 0.9.x and documents the
new optional IAM audit read-replica behavior introduced in the platform.

## Packages

| Language | Package | Version | Release tag |
| --- | --- | --- | --- |
| JavaScript/TypeScript | `@synapseone/sdk` | `0.10.1` | `sdk-v0.10.1` |
| Python | `synapseone-sdk` | `0.10.1` | `sdk-v0.10.1` |
| Rust | `synapseone` | `0.10.1` | `sdk-rust-v0.10.1` |
| Go | `github.com/synapseone/synapseone-sdk-go` | module revision | `sdk-v0.10.1` |

## IAM audit consistency

When a deployment enables `DATABASE_READ_URL`, IAM may serve audit list/count
reads from an asynchronous read-only PostgreSQL replica. SDK callers should
treat `GET /v1/audit` and `GET /v1/platform/audit` as eventually consistent:

- A newly written audit event can be absent briefly.
- Paginated list and count calls can observe different replay positions.
- Authentication, authorization, quotas, writes, exports and mutations remain
  primary-only.
- Replica connection/query failures automatically fall back to the primary.

No SDK method, request field or response schema changes in this release.
