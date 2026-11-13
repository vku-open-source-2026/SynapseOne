# SynapseOne runner image

Build context: repository root.

```bash
docker build -f apps/workflow-runner/Dockerfile -t synapseone-workflow-runner .
```

The same image can run three connector types (set on the runner registration):

- `workflow` — consumes the SynapseFlow workflow queue and executes DAGs.
- `inference` — consumes the inference queue and calls a local OpenAI-compatible
  backend (`INFERENCE_RUNNER_URL`); chat and embeddings are supported.
- `hybrid` — both lanes in one process.

Run (the Console generates this command with the real API key):

```bash
docker run -d --restart unless-stopped \
  -e SYNAPSEONE_URL=https://api.synapseone.space \
  -e SYNAPSEONE_API_KEY=sk-... \
  -e WORKFLOW_RUNNER_ID=<runner-id> \
  -e WORKFLOW_RUNNER_KIND=hybrid \
  -e WORKFLOW_RUNNER_QUEUE=synapseone-wf-custom \
  -e WORKFLOW_RUNNER_INFERENCE_QUEUE=synapseone-inference \
  -e INFERENCE_RUNNER_URL=http://vllm:8000/v1 \
  ghcr.io/vku-open-source-2026/synapseone-workflow-runner:latest
```

The runner uses a blocking pull loop (`consume` with `waitSeconds`, 20s by
default) instead of polling empty queues once per second. Tune it with
`WORKFLOW_RUNNER_LONGPOLL_SECONDS` (`0` disables long-polling) and
`WORKFLOW_RUNNER_POLL_MS` (idle sleep when every slot is busy).

Network options:

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
- `SYNAPSEONE_CA_CERT=/path/ca.pem` (or `NODE_EXTRA_CA_CERTS`)
- `SYNAPSEONE_HTTP_RETRIES` (default 3)
- `SYNAPSEONE_TLS_INSECURE=true` (dev only)

The runner only makes outbound calls to the SynapseOne gateway and the local
inference backend. It does not need `DATABASE_URL`,
`SYNAPSEONE_INTERNAL_SECRET`, or service-network access. See
[`docs/workflow-runners.md`](../../docs/workflow-runners.md) for modes, scopes,
connector status, network troubleshooting and the connection check.
