# SynapseOne runner image

Build context: `SynapseOne/` repository root. One image serves all three
connector kinds (`workflow`, `inference`, `hybrid`).

```bash
docker build -f apps/workflow-runner/Dockerfile \
  -t api.synapseone.space/synapseone/workflow-runner:0.9.10-local .
```

The image contains:

- the compiled Node runner (`/app/dist/runner.js`) and its production deps;
- a self-contained CPU model stack (`/app/.cache/huggingface`) with the real
  ONNX `all-MiniLM-L6-v2` embeddings and `Decision-2.0-Eos-0.8B` route/decision
  models, copied from `synapseone/inference:0.9.1-20261114`;
- the local Python worker at `/app/local-inference/worker.py` and a safe copy of
  the pure inference modules at `/app/local-inference/synapse_local_models/`
  (no `src.main`, no `uvicorn`).

## Inference is local

The `inference`/`hybrid` lane executes models **inside this container** through
the persistent JSONL worker. There is **no inference HTTP server**, no
`INFERENCE_RUNNER_URL`, no `INFERENCE_RUNNER_API_KEY`, and no OpenRouter/remote
model fallback. The Node runner only makes outbound HTTPS calls to the
SynapseOne gateway (control/queue); the worker makes no network calls at all.

Models are loaded at startup; readiness is reported per capability. If a model
is missing or fails to load, the worker returns `model_not_ready` and the runner
must not claim inference work. Deterministic/mock fallbacks are disabled
(`INFERENCE_MOCK_MODELS=false`, downloads off) and the strict wrappers raise
instead of returning fallback embeddings/decisions.

Optional local chat only works when a real local causal-LM **directory** is
mounted/configured (`LOCAL_INFERENCE_CHAT_MODEL`); otherwise `chat` is reported
as unsupported. URLs, Hub ids and provider APIs are rejected.

## Run

The Console generates the command with the real runner API key:

```bash
docker run -d --restart unless-stopped \
  -e SYNAPSEONE_URL=https://api.synapseone.space \
  -e SYNAPSEONE_API_KEY=sk-... \
  -e WORKFLOW_RUNNER_ID=<runner-id> \
  api.synapseone.space/synapseone/workflow-runner:0.9.10-local
```

The server-side runner registration selects `kind` (`workflow|inference|hybrid`)
and the queues. For a local inference runner, do **not** set
`INFERENCE_RUNNER_URL`/`INFERENCE_RUNNER_API_KEY`; the Node bridge spawns
`python3 /app/local-inference/worker.py` and forwards jobs over JSONL.

## CPU and memory sizing

The real CPU models are not tiny:

| Lane | Minimum RSS | Recommended RSS | Notes |
| --- | --- | --- | --- |
| embeddings only (ONNX MiniLM) | 1024 MiB | 1536 MiB | small int8 graph, fast |
| decision / route (Decision-2.0 FP32) | **4096 MiB** | **6144 MiB** | ~3 GiB weights + torch overhead; load ~38 s on 2 threads |
| inference/hybrid (both) | **4096 MiB** | **6144 MiB** | do not use a 2048 MiB default |

Use at least 2 CPUs (`--cpus 2`); 4 is better for concurrent embedding + route.
The decision load takes roughly 40 s on 2 CPU threads, so the runner must not
claim inference work until `health.capabilities.decision.ready=true` (health is
still answered immediately with `status:"starting"`). If a container is limited
to 2048 MiB it can be OOM-killed while loading Decision-2.0 even though the
health frame was served; set `LOCAL_INFERENCE_MAX_RSS_MB=4096` (or `6144`) and
the matching container memory limit. A decision-less runner may set
`LOCAL_INFERENCE_CAPABILITIES=embeddings` and use the lower embedding budget.

Worker-only probe (no Node, no network):

```bash
docker run --rm --network none \
  api.synapseone.space/synapseone/workflow-runner:0.9.10-local \
  python3 /app/local-inference/worker.py --probe
```

`--self-test` prints the health/readiness JSON and exits non-zero when an
enabled capability is not genuinely loaded.

## Worker protocol (v1)

stdout is protocol-only; logs go to stderr. One JSON object per line, serial:

```text
-> {"id":"1","op":"health"}
<- {"id":"1","ok":true,"result":{"ready":true,"capabilities":{...},...}}
-> {"id":"2","op":"infer","type":"embeddings","request":{"input":["a","b"]}}
<- {"id":"2","ok":true,"result":{"object":"list","data":[...],"model":"...","usage":{...}}}
-> {"id":"3","op":"infer","type":"decision","request":{"state":"...","questions":{...}}}
<- {"id":"3","ok":true,"result":{"model":"...","results":{...},"duration_ms":...}}
-> {"id":"4","op":"infer","type":"route","request":{"input":"...","choices":{...}}}
<- {"id":"4","ok":true,"result":{"best_choice":"...","confidence":0.9,"probabilities":{...},"model":"...","duration_ms":...}}
-> {"id":"5","op":"shutdown"}
```

Errors are fail-closed:

```json
{"id":"6","ok":false,"error":{"code":"model_not_ready","message":"...","retryable":true}}
```

`health.capabilities` contains `embeddings`, `decision`, `route` (same engine as
decision) and `chat` (unsupported unless configured). Each entry has
`supported`, `enabled`, `ready`, `state` (`pending|loading|ready|failed|
disabled|unsupported`), `model`, `backend`, `error`, `attempts`, `loadedAt`.

### Worker environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOCAL_INFERENCE_CAPABILITIES` | `embeddings,decision,route` | advertised capabilities |
| `LOCAL_INFERENCE_EMBEDDING` / `LOCAL_INFERENCE_DECISION` | `1` | enable when no capability list |
| `LOCAL_INFERENCE_THREADS` | auto | CPU threads |
| `LOCAL_INFERENCE_CHAT_MODEL` | empty | local chat model directory |
| `LOCAL_INFERENCE_MAX_BATCH` | `256` | max embedding inputs |
| `LOCAL_INFERENCE_MAX_TOKENS` | `512` | max chat tokens |
| `LOCAL_INFERENCE_MAX_LINE_BYTES` | `4 MiB` | max request frame |
| `LOCAL_INFERENCE_MAX_RESPONSE_BYTES` | `8 MiB` | max response frame |
| `LOCAL_INFERENCE_MODEL_RETRY_SECONDS` | `60` | retry backoff for failed loads |
| `SYNAPSE_LOCAL_MODELS_DIR` | packaged / repo `inference-service/src` | model modules |
| `HF_HOME` | `/app/.cache/huggingface` | baked weights |
| `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` | `1` | no downloads |

## Network options (control/queue only)

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
- `SYNAPSEONE_CA_CERT=/path/ca.pem` (or `NODE_EXTRA_CA_CERTS`)
- `SYNAPSEONE_HTTP_RETRIES` (default 3)
- `SYNAPSEONE_TLS_INSECURE=true` (dev only)

The image exposes **no ports** (`EXPOSE`/`PORT` absent) and runs no listener.
The runner uses a blocking pull loop (`consume` with `waitSeconds`, 20s default)
instead of polling empty queues once per second. Tune it with
`WORKFLOW_RUNNER_LONGPOLL_SECONDS` (`0` disables long-polling) and
`WORKFLOW_RUNNER_POLL_MS` (idle sleep when every slot is busy).

See [`docs/workflow-runners.md`](../../docs/workflow-runners.md) for modes,
scopes, connector status, network troubleshooting and the connection check.
