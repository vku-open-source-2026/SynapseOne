# Third-party components

SynapseOne itself is Apache-2.0 (see `LICENSE`, `NOTICE`). This file inventories
the third-party components it integrates with or bundles. The authoritative,
exact inventory is generated from installed dependency metadata:

- `licenses/inventory.json` — every resolved npm, Cargo and Python package with
  exact version, license expression, scope, workspace, source URL and retained
  license-file names.
- `licenses/sbom/synapseone.cdx.json` — CycloneDX 1.5 SBOM for the release,
  including one `container` component per first-party image with Dockerfile,
  build context and source commit provenance.
- `licenses/THIRD-PARTY-NOTICES.generated.txt` — generated dependency license
  texts.
- `licenses/THIRD-PARTY-NOTICES.txt` — reviewed notices for notable components
  and the two approved MPL-2.0 exceptions.
- `licenses/SOURCE-OFFER.md` — corresponding-source offer and image provenance.

Regenerate all of the above with `make license-check`. CI regenerates them on
every push and release builds regenerate them for the release commit.

## External engines / services (not bundled, talked to over HTTP — never derived works)

| Component | License | Consumed as | Notes |
|---|---|---|---|
| Workflow engine | SynapseOne's own code (Apache-2.0, `apps/workflow-service/src/engine.ts`) | Built-in, no external image | Former n8n integration removed in 0.4.0 for license + usability reasons. No SUL/AGPL engine remains in the default stack. |
| Authentik (`ghcr.io/goauthentik/server`) | MIT | Container image + OIDC | Optional external IdP (default). |
| Keycloak | Apache-2.0 | OIDC (alternative IdP) | Supported as alternative upstream IdP; no image pinned in compose. |
| PostgreSQL (`pgvector/pgvector:pg16` + PostGIS) | PostgreSQL Licence (permissive) | Container image + `pg` driver (MIT) | System of record for IAM, Workflow, LDS, Base, Notifications and Lakehouse catalog. |
| Valkey (`valkey/valkey:8-alpine`) | BSD-3-Clause | Container image + `ioredis` (MIT) | Cache, queue, stream and Authentik backend. Redis-protocol compatible; replaces Redis 7 whose 7.4+ releases moved to RSALv2/SSPL. |
| SeaweedFS (`chrislusf/seaweedfs:4.48`) | Apache-2.0 | Container image (S3-compatible object storage) | Default S3-compatible backend for SynapseOCS and Lakehouse. Production may point at AWS S3/R2 instead. |
| Prometheus (`prom/prometheus`) | Apache-2.0 | Container image + scrape API | Metrics store for `infra/monitoring`. |
| postgres-exporter (`prometheuscommunity/postgres-exporter`) | Apache-2.0 | Container image | PG metrics for Prometheus. |
| redis-exporter (`oliver006/redis_exporter`) | MIT | Container image | Valkey metrics for Prometheus. |
| nginx (`nginx:alpine`, prod edge) | BSD-2-Clause-like | Container image | TLS terminator in `infra/prod`. |
| certbot (`certbot/certbot`) | Apache-2.0 | Container image (one-shot) | LE certificates in `infra/prod`. |
| AWS CLI (`amazon/aws-cli`, s3-init) | Apache-2.0 | Container image (one-shot) | Bucket auto-create for the bundled S3-compatible store. |
| MinIO (`quay.io/minio/minio`, not shipped) | **AGPL-3.0** | Not used | The stack ships SeaweedFS (Apache-2.0) instead. Pointing OCS at AWS S3 or another S3 service is also supported. |

## Runtime dependencies (linked / installed from registries)

Generated scan at the current release base (`SOURCE_COMMIT=ef7b3d4`; the
release pipeline regenerates against the release commit):

| Ecosystem | Unique components | Runtime scope | Result |
|---|---:|---:|---|
| npm workspaces (incl. dev) | 313 | production tree included | MIT 276, ISC 16, Apache-2.0 12, BSD-3-Clause 5, BSD-2-Clause 1, Python-2.0 1, CC-BY-4.0 1, `(CC-BY-4.0 AND MIT)` 1. No copyleft. |
| Cargo (11 lockfiles) | 373 (362 third-party + 11 first-party) | all | Permissive expressions only; permissive alternative selected from every OR expression. No mandatory GPL/AGPL/LGPL. |
| Python (SDK, inference base + ONNX models + optional Torch, Lakehouse) | 78 (77 third-party + SDK) | all | MIT 34, BSD-3-Clause 20, Apache-2.0 14, and permissive compound expressions. `certifi` MPL-2.0 and `tqdm` MPL-2.0 AND MIT are the only reviewed weak-copyleft exceptions. |
| Go SDK | standard library only | all | BSD-3-Clause (Go itself). |
| First-party images | 19 | all | Every image carries `/usr/share/licenses/synapseone/`. |

Details that apply to the bundled images:

- Console (`apps/console`): React + Vite + Tailwind — MIT; FontAwesome icons
  (`@fortawesome/*` — MIT, except `free-solid-svg-icons` dual
  `CC-BY-4.0 AND MIT`: attribution is in `NOTICE`, `licenses/THIRD-PARTY-NOTICES.txt`
  and `licenses/CC-BY-4.0.txt`); Lucide icons (`lucide-react`, ISC). Fonts
  Be Vietnam Pro and JetBrains Mono (SIL OFL 1.1) load from Google Fonts.
- Warehouse (`apps/warehouse-service`): the image bundles the official DuckDB
  2.0.0 `libduckdb.so` (MIT). Full text is in `licenses/MIT-DuckDB.txt`.
- Python SDK: `requests` — Apache-2.0; `certifi` **MPL-2.0** (unmodified CA
  bundle, reviewed exception; full MPL text in `licenses/MPL-2.0.txt`).
- Lakehouse: PyIceberg/PyArrow — Apache-2.0; FastAPI/Starlette — MIT/BSD-3-Clause;
  Uvicorn — BSD-3-Clause; pg8000 — BSD-3-Clause; SQLAlchemy — MIT; `certifi` —
  MPL-2.0 (same reviewed exception).
- Inference: FastAPI/Uvicorn/Pydantic — MIT/BSD/Apache-2.0; ONNX Runtime — MIT;
  Transformers/Hugging Face Hub — Apache-2.0; Torch stack — permissive compound
  Apache-2.0/BSD/BSL/ISC/MIT/Zlib expression; `tqdm` — **MPL-2.0 AND MIT**
  (reviewed exception, full MPL text shipped).
- Go SDK: standard library only — BSD-3-Clause.

## Policy and CI

`make license-check` runs `tools/license-check.cjs`:

- npm: scans the installed workspace tree (hoisted and nested `node_modules`).
- Cargo: uses live `cargo metadata --locked`; when Cargo is unavailable it uses
  `third-party/cargo-inventory.json` and fails if any lockfile package is
  missing from that pinned inventory.
- Python: runs `tools/python-license-inventory.py` inside every supplied
  interpreter (`--python`, `--require-python` in CI) after the service
  environments are installed.
- Images: verifies every first-party Dockerfile copies the notice bundle and
  OCI provenance labels, and records all images in the SBOM.
- Policy is permissive-only and fail-closed. Unknown/missing licenses fail.
  GPL/AGPL/LGPL and other copyleft fail unless the component offers a permissive
  alternative. The only exceptions are `certifi` and `tqdm`, both MPL-2.0 and
  listed above.

CI installs the SDK, inference and Lakehouse Python dependencies before running
the gate, then uploads `licenses/` (SBOM, inventory, generated notices) as an
artifact. Direct inference requirements are pinned to exact versions (Torch
included); transitive versions are recorded in the SBOM/inventory. Release
images are built from the repository root so the bundle is copied into
`/usr/share/licenses/synapseone/`; Docker build-time `RUN` checks fail the build
if any required file is missing.

## License headers

Every source file owned by this repo carries an `Apache-2.0 / SynapseOne Contributors`
header. Generated artifacts (`dist/`, `*.egg-info/`, `.pytest_cache/`) are build output,
not source, and are not expected to carry headers (they are git-ignored where practical).
