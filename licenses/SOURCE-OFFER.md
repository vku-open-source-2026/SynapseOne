# SynapseOne source offer and build provenance

SynapseOne itself is licensed under Apache-2.0. Every first-party container
image contains this bundle at `/usr/share/licenses/synapseone/`:

- `LICENSE` — Apache-2.0 license text.
- `NOTICE` — SynapseOne attribution and third-party attribution summary.
- `THIRD-PARTY.md` — human-readable dependency inventory.
- `licenses/SOURCE-OFFER.md` — this source/provenance document.
- `licenses/THIRD-PARTY-NOTICES.txt` — reviewed notices and license texts.
- `licenses/THIRD-PARTY-NOTICES.generated.txt` — generated dependency notices.
- `licenses/MPL-2.0.txt`, `licenses/CC-BY-4.0.txt`, `licenses/BSD-3-Clause.txt`,
  `licenses/MIT-DuckDB.txt` — full texts for bundled or linked components.
- `licenses/sbom/synapseone.cdx.json` — CycloneDX 1.5 SBOM for the release,
  including every resolved npm, Cargo and Python component and one `container`
  component per first-party image.
- `licenses/inventory.json` — the same data in a review-friendly inventory with
  exact versions, license expressions, source URLs and license-file names.

## Corresponding source

The complete corresponding source for the release, including build scripts,
Dockerfiles, lock files and dependency metadata, is available from:

- Repository: <https://github.com/vku-open-source-2026/SynapseOne>
- Release revision: `SOURCE_COMMIT` (rendered at build time)
- Source tree: <https://github.com/vku-open-source-2026/SynapseOne/tree/SOURCE_COMMIT>
- Source archive: <https://github.com/vku-open-source-2026/SynapseOne/archive/SOURCE_COMMIT.tar.gz>

Release automation passes `SOURCE_COMMIT=${GITHUB_SHA}` as a Docker build arg and
sets the OCI `org.opencontainers.image.revision` label. Local builds default to
`unknown`; they must not be presented as a published release.

## MPL-2.0 covered components

The Python SDK, inference service and Lakehouse environments include
`certifi` (MPL-2.0, an unmodified CA bundle). The inference model stack also
includes `tqdm` (`MPL-2.0 AND MIT`). Both are used unmodified as installed from
their upstream distributions. The full MPL-2.0 text is in `MPL-2.0.txt`.
Upstream source is available from:

- <https://pypi.org/project/certifi/>
- <https://pypi.org/project/tqdm/>
- The exact versions and hashes are recorded in `licenses/inventory.json` and the
  generated CycloneDX SBOM.

## Rust, npm, Go and Python components

Exact resolved versions are in the lock files at the release revision:
`package-lock.json`, each `apps/*/Cargo.lock`, `sdks/sdk-rust/Cargo.lock`, and
the Python inventory generated from the installed service environments. Crate
source is available from <https://crates.io/>; npm source from
<https://www.npmjs.com/>; Python source from <https://pypi.org/>. The Go SDK uses
only the Go standard library (BSD-3-Clause).

## Container provenance

Each first-party image is built from the repository root so the bundle can be
copied into the final layer. The SBOM records the Dockerfile, build context,
base image, source commit and publication status for every image:

| Image | Base / bundled runtime |
|---|---|
| gateway, ai, lds, base, faststore, queue, stream, warehouse, ocs, notifications | `debian:bookworm-slim` (builder `rust:1-bookworm`) |
| warehouse | Debian + official DuckDB 2.0.0 `libduckdb.so` (MIT) |
| iam, workflow | `node:20-alpine` |
| console | `nginx:alpine` (builder `node:20-alpine`) |
| inference | `python:3.11-slim` |
| lakehouse | `python:3.12-slim` |
| workflow-runner | `node:20-slim` + `python:3.11-slim-bookworm` |
| postgres | `pgvector/pgvector:pg16` |
| edge | `nginx:alpine` |
| pgbouncer | `alpine:3.20` |

The release pipeline publishes images as:

`ghcr.io/vku-open-source-2026/synapseone-<service>:<release-tag>`
