# SDK 0.10.2

SDK `0.10.2` keeps the `0.10.x` service API and adds complete, language-specific
service guides. The JavaScript/TypeScript, Python, Go and Rust clients release
together; the platform/container version remains independent.

## Install

| Language | Package / module | Install | Release tag |
| --- | --- | --- | --- |
| JavaScript / TypeScript | `@synapseone/sdk` | `npm install @synapseone/sdk@0.10.2` | `sdk-v0.10.2` |
| Python | `synapseone-sdk` | `pip install synapseone-sdk==0.10.2` | `sdk-v0.10.2` |
| Go | `github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go` | `go get github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go@v0.10.2` | `sdks/sdk-go/v0.10.2` |
| Rust | `synapseone` | `cargo add synapseone@0.10.2` | `sdk-rust-v0.10.2` |

Go uses a [multi-module tag](https://go.dev/doc/modules/version-numbers). The
public Go proxy resolves it automatically; no registry token or separate
repository is required. The old `github.com/synapseone/synapseone-sdk-go` path
never resolved to this repository and must not be used.

## Documentation

- Start at [synapseone.space/docs](https://synapseone.space/docs).
- Choose JavaScript/TypeScript, Python, Go or Rust independently for each
  service example. The Console language switch still localizes the surrounding
  interface and explanations.
- Service guides cover IAM, Workflow, AI Assistant, SynapseLDS, SynapseBase,
  Synapse Faststore, SynapseQueue, SynapseStream, SynapseOCS, SynapseNotifications,
  Synapse Warehouse, Synapse Lakehouse and Synapse Inference.
- Full method references remain in [sdk-js.md](sdk-js.md),
  [sdk-python.md](sdk-python.md), [sdk-go.md](sdk-go.md) and the
  [Rust crate documentation](https://docs.rs/synapseone).

## Release automation

`node tools/sdk-version-check.cjs` fails when the four SDK manifests drift or a
release tag does not match their shared version.

- `sdk-v<version>` builds JavaScript and Python assets, creates the GitHub
  release, and publishes through npm/PyPI Trusted Publishing (OIDC).
- `sdk-rust-v<version>` verifies the crate version, formatting, Clippy and tests
  before publishing to crates.io.
- `sdks/sdk-go/v<version>` verifies formatting, vet/tests, the module path and
  public proxy availability, then creates the GitHub release.

Publishing is idempotent for npm, PyPI and crates.io. Re-running an already
published version skips the registry upload.

## Operator release runbook

1. Restore GitHub Actions runner capacity if the organization billing/spending
   limit is blocking jobs, then confirm a trivial workflow starts.
2. Confirm npm/PyPI Trusted Publishing is bound to this repository and
   `release.yml`; configure `CARGO_REGISTRY_TOKEN` for the Rust crate.
3. Merge the release commit only after CI is green, then create all three tags on
   that exact commit:

   ```bash
   git tag -a sdk-v0.10.2 -m "SDK 0.10.2"
   git tag -a sdk-rust-v0.10.2 -m "Rust SDK 0.10.2"
   git tag -a sdks/sdk-go/v0.10.2 -m "Go SDK 0.10.2"
   git push origin sdk-v0.10.2 sdk-rust-v0.10.2 sdks/sdk-go/v0.10.2
   ```

4. Verify npm `@synapseone/sdk@0.10.2`, PyPI
   `synapseone-sdk==0.10.2`, crates.io `synapseone 0.10.2`, the Go proxy version
   list, GitHub Release assets/`SHA256SUMS`, and the docs.rs build.

Never move or reuse these tags after publication; ship fixes as `0.10.3`.

## SDK fixes in this release

- JavaScript package exports now include `./ocs`, `./search`, `./warehouse` and
  `./lakehouse`; legacy flat TypeScript methods match the wrappers that actually
  exist at runtime.
- Python Search methods are callable on `client.base` again. Workflow credential
  expiry is now documented as unsupported; compatibility parameters are ignored
  instead of sending a field the server discards.
- Go publishes from the real monorepo module and adds the complete Lakehouse
  namespace/table/snapshot/schema-evolution wrapper set.
- Rust MFA recovery-code rotation has a working
  `regenerate_recovery_codes_with_code` method; the old no-argument method remains
  deprecated for source compatibility. MFA can also be disabled with a recovery
  code.
- Python packaging uses the SPDX license expression and ships `LICENSE`/`NOTICE`.

## Compatibility notes

No runtime method or response field is removed. The JavaScript/TypeScript legacy
flat alias surface is narrowed to wrappers that actually exist at runtime; use
the namespaced API for newer methods. Go consumers must update their import path
to the public monorepo module above. IAM audit reads remain eventually
consistent when a deployment enables `DATABASE_READ_URL`, as described in
[sdk-0.10.1.md](sdk-0.10.1.md).
