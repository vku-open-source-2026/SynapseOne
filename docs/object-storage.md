# SynapseOCS — object cloud storage

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

SynapseOCS (Object Cloud Storage) is the Tier-1 bucket-aware object store. It
speaks its own `/v1/ocs` API at the gateway and keeps the original
`/v1/storage` API as the default-bucket compatibility surface. Bytes live in an
S3-compatible backend (SeaweedFS in Compose, or AWS S3) in production and on a local
filesystem for development/single-node deployments.

## Capabilities

| Capability | Route |
| --- | --- |
| Bucket create/list/get/head/stats/delete | `/v1/ocs/buckets`, `/v1/ocs/buckets/:bucket`, `/v1/ocs/buckets/:bucket/stats` |
| Object upload (upsert) | `PUT /v1/ocs/buckets/:bucket/objects/*` |
| Object download/head/delete | `GET`/`HEAD`/`DELETE /v1/ocs/buckets/:bucket/objects/*` |
| List objects (prefix + delimiter) | `GET /v1/ocs/buckets/:bucket/objects?prefix=&delimiter=&limit=&cursor=` |
| Copy object | `POST /v1/ocs/buckets/:bucket/objects/copy` |
| Presigned URL | `POST /v1/ocs/buckets/:bucket/presign` |
| Multipart | `POST /v1/ocs/buckets/:bucket/uploads`, `PUT .../parts/:n`, `POST .../complete`, `DELETE .../:id` |
| Legacy default bucket | `/v1/storage/*` (unchanged) |

Every bucket and object is tenant-scoped (`org:<id>` first, then `account:<id>`,
then `user:<sub>`). Cross-tenant reads return `404`; there is no existence
leak. Platform callers must send `x-synapseone-tenant`.

## Buckets

```bash
curl -X POST https://api.synapseone.space/v1/ocs/buckets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"city-assets","quotaBytes":1073741824}'

curl https://api.synapseone.space/v1/ocs/buckets/city-assets \
  -H "Authorization: Bearer $TOKEN"

curl -X DELETE 'https://api.synapseone.space/v1/ocs/buckets/city-assets?force=true' \
  -H "Authorization: Bearer $TOKEN"
```

Bucket names follow S3-style lowercase rules (3–63 characters). `default` is a
virtual bucket backed by the legacy key space and cannot be deleted. Deleting a
non-empty bucket requires `?force=true`; that removes every object and the
bucket marker.

## Objects

```bash
curl -X PUT "https://api.synapseone.space/v1/ocs/buckets/city-assets/objects/2026/10/photo.png" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  -H "x-object-checksum-sha256: $(sha256sum photo.png | cut -d' ' -f1)" \
  --data-binary @photo.png

curl "https://api.synapseone.space/v1/ocs/buckets/city-assets/objects/2026/10/photo.png" \
  -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-1023'
```

* Checksums are verified when `x-object-checksum-sha256` is supplied.
* `Range` and `If-Match`/`If-None-Match` are supported (single range).
* Size limits: `STORAGE_MAX_OBJECT_BYTES` (25 MiB default) and
  `STORAGE_TENANT_QUOTA_BYTES` (5 GiB default); buckets may set a smaller
  `quotaBytes`.
* List responses include `objects`, `commonPrefixes` (when `delimiter` is
  supplied) and an opaque `nextCursor`.

## Multipart

Create an upload, PUT numbered parts (max 10,000), then complete with the
returned ETags. The filesystem backend assembles the parts; the S3 backend (SeaweedFS/AWS) uses
native multipart. Abort removes the temporary upload directory.

## Presigned URLs

`POST /v1/ocs/buckets/:bucket/presign` returns a short-lived HMAC-signed URL
(default 900 s, max 7 days) for `GET`/`PUT`/`DELETE`/`HEAD`. It works on both
backends and never exposes backend S3 credentials. The URL is scoped to one
tenant/bucket/key/method; hand it only to the intended client. The legacy
`/v1/storage/presign` route still requires the S3 backend.

## Backends

| Setting | Dev | Production |
| --- | --- | --- |
| `STORAGE_BACKEND` | `fs` | `s3` (required by the boot guard) |
| `STORAGE_FS_ROOT` | `/data` (volume) | — |
| `STORAGE_S3_ENDPOINT` | `http://s3:9090` | `http://s3:9090` (SeaweedFS in the prod overlay) or an AWS S3 HTTPS endpoint |
| `STORAGE_S3_BUCKET` | `synapseone-core` | dedicated bucket |
| `STORAGE_S3_ACCESS_KEY` / `_SECRET_KEY` | `test`/`test` | scoped credentials |
| `STORAGE_S3_REGION` | `us-east-1` | backend region |
| `STORAGE_S3_PATH_STYLE` | `true` | `false` for AWS virtual-host style |

Compose runs **SeaweedFS** (`chrislusf/seaweedfs:4.48`, Apache-2.0) as the `s3`
service in development and production: OCS uses `STORAGE_S3_ENDPOINT=http://s3:9090`
with `STORAGE_S3_PATH_STYLE=true`. SeaweedFS uses `STORAGE_S3_ACCESS_KEY` /
`STORAGE_S3_SECRET_KEY` as its only identity (letters and digits; `test`/`test` in
dev), keeps data in the `seaweeddata` volume, and the prod overlay requires real
keys and removes the host port.

Earlier releases used S3Mock, which deletes its files whenever the container stops,
so a deployment upgrading from it has no durable objects to carry over: OCS buckets
are recreated on demand (SynapseDX does this automatically for `synapsedx-files`).

## Backups

The `s3-backup` service (docker-compose.yml) takes a daily snapshot of the bucket
into the `s3backups` volume with `tools/backup/s3-backup.mjs`, run in the OCS image:

- content is stored once per SHA-256 under `blobs/`; each snapshot is a manifest
  (`snapshots/<UTC stamp>.json`) of key, size, ETag, Content-Type and SHA-256;
- unchanged objects (same key, size and ETag) are not downloaded again;
- snapshots older than `BACKUP_RETENTION_DAYS` (7) are removed, the newest is always
  kept, and blobs no snapshot uses are deleted.

```bash
C="docker compose -f docker-compose.yml"
$C run --rm --no-deps s3-backup once                        # snapshot now
$C run --rm --no-deps s3-backup list                        # snapshots with object counts
$C run --rm --no-deps s3-backup restore latest --dry-run    # what would change
$C run --rm --no-deps s3-backup restore 20261106T020000Z --prefix tenants/org_x/
```

`--no-deps` keeps `run` from recreating the `s3` service when its running config
differs from the file.

Restore writes objects back with their original Content-Type after checking the
blob SHA-256, skips objects that are already identical and never deletes objects
from the store. Postgres dumps are covered in `docs/production.md`.

The bucket
policy should allow only SynapseOCS credentials to read/write the backend;
clients should use the OCS API/presigned URLs, not the backend directly.

## SDK

TypeScript:

```ts
const bucket = await c.ocs.createBucket('city-assets', { quotaBytes: 1_073_741_824 });
await c.ocs.putObject('city-assets', '2026/10/photo.png', bytes, { contentType: 'image/png' });
const bytes = await c.ocs.getObject('city-assets', '2026/10/photo.png', { range: 'bytes=0-1023' });
const page = await c.ocs.listObjects('city-assets', { prefix: '2026/', delimiter: '/' });
const copied = await c.ocs.copyObject('city-assets', { sourceKey: 'a.png', destinationKey: 'b.png' });
const { url } = await c.ocs.presign('city-assets', 'a.png', { method: 'GET', expiresIn: 300 });
```

Python: `client.ocs.create_bucket`, `put_object`, `get_object`, `list_objects`,
`copy_object`, `presign`, multipart.

Go: `CreateOcsBucket`, `PutOcsObject`, `GetOcsObject`, `ListOcsObjects`,
`CopyOcsObject`, `PresignOcs`, multipart.

`client.storage` / `StorageService` remains the default-bucket compatibility
API (`/v1/storage`).

## Tier-2/Tier-3 guidance

Tier 2 wraps SynapseOCS as the files capability and stores bucket/key metadata
in Base; it does not store base64 payloads in documents. Tier 3 uploads evidence
and stores the returned bucket/key or presigned URL. Neither Tier 2 nor Tier 3
talks to the backend S3 credentials directly.
