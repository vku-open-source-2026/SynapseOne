# SynapseFlow runner image

Build context: repository root.

```bash
docker build -f apps/workflow-runner/Dockerfile -t synapseone-workflow-runner .
```

Run (the Console generates this command with a real key):

```bash
docker run -d --restart unless-stopped \
  -e SYNAPSEONE_URL=https://api.synapseone.space \
  -e SYNAPSEONE_API_KEY=sk-... \
  -e WORKFLOW_RUNNER_ID=<runner-id> \
  ghcr.io/vku-open-source-2026/synapseone-workflow-runner:latest
```

The runner only makes outbound HTTPS calls to the public gateway. It does not
need `DATABASE_URL`, `SYNAPSEONE_INTERNAL_SECRET`, or service-network access.
See [`docs/workflow-runners.md`](../../docs/workflow-runners.md) for modes,
scopes, lease/retry behavior and the connection check.
