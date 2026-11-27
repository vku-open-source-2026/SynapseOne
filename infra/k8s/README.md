# K8s deployment (Kustomize)

```bash
# 1. Create real secrets from the example (NEVER commit the filled-in file):
cp infra/k8s/base/secrets.example.yaml /tmp/synapseone-secrets.yaml
# ... fill secrets into /tmp/synapseone-secrets.yaml ...
kubectl apply -f /tmp/synapseone-secrets.yaml

# 2. Deploy:
kubectl apply -k infra/k8s/base
kubectl -n synapseone get pods,svc

# 3. Open the gateway (port-forward until you have an ingress):
kubectl -n synapseone port-forward svc/gateway 8080:80
curl localhost:8080/health
curl localhost:8080/ready
```

Notes:

- `all.yaml` contains the Namespace, Deployments and Services for the complete
  first-party service set: `iam`, `gateway`, `workflow`, `ai`, `lds`, `base`,
  `faststore`, `queue`, `stream`, `warehouse`, `lakehouse`, `inference`, `ocs`,
  `notifications` and `console`. The image references use the published release
  convention `ghcr.io/vku-open-source-2026/synapseone-<service>:0.9.0`.
  For a fork, replace the registry owner in `all.yaml` (or add a Kustomize
  `images:` override) and publish the same `synapseone-<service>` names.
- The base assumes these dependency Services exist in the `synapseone`
  namespace (or are replaced with external endpoints): `postgres` (PostgreSQL
  16 + pgvector), `valkey` (Valkey 8) and `s3` (SeaweedFS S3 API on :9090).
  They are intentionally operated by their own charts/StatefulSets; the base
  does not ship database credentials or persistent-volume policy for them.
- Required keys in `synapseone-secrets` are validated by
  `node tools/k8s-manifest-check.cjs`. They include `database-url`,
  `database-direct-url`, `iam-jwt-secret`, `oidc-client-secret`,
  `internal-secret`, `api-key-pepper`, `credential-key`, `iam-api-key`,
  `ai-api-key`, `openrouter-api-key`, `storage-s3-access-key`,
  `storage-s3-secret-key`, and the Lakehouse catalog/S3 keys. The example file
  is a shape reference only; use SealedSecrets/External Secrets in production.
- Replace the `console`/`gateway` placeholder domains (`console.example.com`,
  `gateway.example.com`) and the OIDC issuer with real values.
- IAM and Workflow readiness probes use `/ready` (database/queue/credential
  checks), not `/health`. Liveness stays on `/health` so a dependency outage
  does not restart healthy processes. Startup probes allow migrations/model
  load to finish before liveness starts.
- Production: add Ingress + TLS, HPA, PDB, resource limits, and manage secrets
  with SealedSecrets/External Secrets. Validate changes with
  `node tools/k8s-manifest-check.cjs` and
  `kubectl apply --dry-run=server -k infra/k8s/base` when a cluster is available.
