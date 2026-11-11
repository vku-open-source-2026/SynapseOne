# Synapse Inference Engine (`@synapseone/inference-service`)

Multi-model inference microservice for the SynapseOne ecosystem. Provides:
1. **LLM Proxy**: OpenAI-compatible chat completions endpoint (streaming + non-streaming) backed by OpenRouter, with a configured fallback model.
2. **Embedding**: Self-hosted `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions) running on **ONNX Runtime int8** by default, with PyTorch and deterministic mock fallbacks.
3. **Decision Model**: Self-hosted `vllm-sr/Decision-2.0-Eos-0.8B` model (0.8B parameters) for single-forward-pass routing and structured evaluations (`system_one`).

---

## CPU optimization

- **ONNX int8 embeddings:** the service picks `onnx/model_qint8_avx512_vnni.onnx`,
  `onnx/model_quint8_avx2.onnx` or `onnx/model_qint8_arm64.onnx` based on the
  host CPU, then falls back to the fp32 graph. This avoids the torch import,
  cuts the graph to ~23 MB (from ~90 MB) and is ~1.2-1.5x faster on AVX2 hosts
  (more with AVX-512 VNNI), with lower memory use.
- **ONNX embeddings, PyTorch decision:** embeddings never import torch; the
  ONNX stack is `onnxruntime` + tokenizer + numpy. CPU PyTorch **is installed by
  default** for the 0.8B Decision-2.0 model; set `INSTALL_TORCH=0` **and**
  `DECISION_ENABLED=false` on memory-constrained nodes (the deterministic
  router fallback stays active).
- **Model prefetch:** `PREFETCH_EMBEDDING=1` (default) bakes the tokenizer and
  all ONNX graphs into the image, so production does not need the Hugging Face
  network for embeddings. `PREFETCH_DECISION=1` does the same for the ~3 GB
  Decision package.
- **First decision load:** `DECISION_WARMUP=true` (default) loads the model in
  a background thread at startup. Without `PREFETCH_DECISION=1` the ~3 GB
  weights are downloaded on the first startup; loading takes ~40 s cold and
  ~12 s from cache, and inference is ~2-6 s per request on 4 CPU threads.
- **CPU threads:** `INFERENCE_CPU_THREADS` (0 = min(4, host CPUs)) sets the
  ONNX intra-op pool; pin it to the container CPU limit.
- **Load backoff:** a failed model load is retried at most every
  `MODEL_LOAD_RETRY_SECONDS` instead of on every request.
- **Decision model:** loads through its bundled runtime with `device`/`threads`
  options, runs under `torch.inference_mode()` and is serialised. It is FP32 on
  CPU (~3 GB RAM); set `DECISION_ENABLED=false` on small nodes.

---

## API Endpoints

### 1. Health & Subsystem Status
* `GET /health`
  Returns status of LLM provider, embedding engine, and decision engine.

### 2. LLM Chat Completions (OpenRouter)
* `POST /v1/chat/completions`
  OpenAI-compatible request body:
  ```json
  {
    "model": "liquid/lfm-2.5-2.6b:free",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Hello!" }
    ],
    "temperature": 0.7,
    "max_tokens": 512,
    "stream": false
  }
  ```
  Supports Server-Sent Events (SSE) when `stream: true`.

### 3. Embeddings (Self-hosted Lightweight Model)
* `POST /v1/embeddings`
  OpenAI-compatible embeddings request:
  ```json
  {
    "input": "Calculate embedding vector for this workflow node.",
    "model": "sentence-transformers/all-MiniLM-L6-v2"
  }
  ```
  Returns 384-dimensional unit-norm float vector.

### 4. Decision Engine (`Decision-2.0-Eos-0.8B`)
* `POST /v1/decision` (Advanced `system_one` structured questions):
  ```json
  {
    "state": "The order arrived damaged yesterday. The customer has a receipt and asks for a replacement today.",
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "Which team should handle this request?",
        "criteria": {
          "returns": "Refunds, replacements and damaged deliveries",
          "billing": "Payments, invoices and charges",
          "technical": "Product setup and faults"
        }
      },
      "has_receipt": {
        "type": "noul",
        "instructions": "Does the customer have a receipt?"
      }
    }
  }
  ```

* `POST /v1/decision/route` (Workflow-friendly simple branch router):
  ```json
  {
    "input": "How do I create a new API key in SynapseOne?",
    "instruction": "Pick the right service for this query.",
    "choices": {
      "iam": "Identity, user management, and API credentials",
      "workflow": "Creating and managing DAG execution workflows",
      "base": "Database collections and records storage"
    }
  }
  ```
  Response:
  ```json
  {
    "best_choice": "iam",
    "confidence": 0.92,
    "probabilities": {
      "iam": 0.92,
      "workflow": 0.05,
      "base": 0.03
    },
    "model": "vllm-sr/Decision-2.0-Eos-0.8B",
    "duration_ms": 14.2
  }
  ```

#### Question types and response fields

The engine normalises the native Decision 2.0 output so existing consumers keep
working. Every question type is supported:

| Type | Native output | Normalised fields |
| :--- | :--- | :--- |
| `choice` | `choice`, `probabilities`, `confidence` | `best_choice` (= `choice`) |
| `noul` | `noul` = P(true) | `answer` (`yes`/`no`), `probabilities.yes/no` |
| `score` | `score`, `probabilities`, `legend` | unchanged (index-valued score + label legend) |

Example `noul` result:

```json
{ "type": "noul", "noul": 0.9989, "answer": "yes",
  "probabilities": { "yes": 0.9989, "no": 0.0011 } }
```

---

## Configuration

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4008` | HTTP listening port |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `OPENROUTER_API_KEY` | `""` | OpenRouter API Key |
| `OPENROUTER_MODEL` | `liquid/lfm-2.5-2.6b:free` | Default LLM model |
| `OPENROUTER_FALLBACK_MODEL` | `inception/mercury-2.5` | Tried after the primary model exhausts retries; empty disables |
| `EMBEDDING_MODEL_NAME` | `sentence-transformers/all-MiniLM-L6-v2` | Embedding model / tokenizer source |
| `EMBEDDING_BACKEND` | `auto` | `auto`, `onnx`, `torch` or `mock` |
| `EMBEDDING_ONNX_PATH` | `""` | Local `.onnx` file or directory (skips the Hub) |
| `EMBEDDING_ONNX_FILE` | `""` | Repo-relative ONNX override, e.g. `onnx/model.onnx` |
| `EMBEDDING_BATCH_SIZE` | `32` | Encode batch size |
| `EMBEDDING_MAX_LENGTH` | `256` | Tokenizer truncation limit |
| `INFERENCE_CPU_THREADS` | `0` | ONNX intra-op threads; 0 = auto |
| `INFERENCE_MODEL_DOWNLOAD` | `true` | Allow first-use Hugging Face downloads |
| `INFERENCE_WARMUP` | `true` | Load the embedding graph in a background thread at startup |
| `MODEL_LOAD_RETRY_SECONDS` | `300` | Backoff after a failed model load |
| `DECISION_MODEL_NAME` | `vllm-sr/Decision-2.0-Eos-0.8B` | Self-hosted 0.8B decision model |
| `DECISION_ENABLED` | `true` | Set `false` to skip the ~3 GB CPU model |
| `DECISION_THREADS` | `0` | Decision runtime threads; 0 = auto |
| `DECISION_WARMUP` | `true` | Load the decision model in a background thread at startup |
| `INFERENCE_DEVICE` | `auto` | `cpu` or `cuda` |
| `INFERENCE_MOCK_MODELS` | `false` | Enable deterministic fallback for test/offline environments |
| `SYNAPSEONE_INTERNAL_SECRET` | `""` | Shared secret required on `/v1/*` when set |

### Docker build args

| Arg | Default | Effect |
| :--- | :--- | :--- |
| `INSTALL_MODELS` | `1` | Install the ONNX/tokenizer stack |
| `INSTALL_TORCH` | `1` | Install CPU PyTorch (Decision-2.0 + torch embedding fallback) |
| `PREFETCH_EMBEDDING` | `1` | Download the int8 ONNX graph at build time |
| `PREFETCH_DECISION` | `0` | Bake the ~3 GB Decision-2.0 package into the image |

`GET /health` reports `status: degraded` when a real embedding model was
expected but could not load. `INFERENCE_MOCK_MODELS=true` keeps `ok` and marks
the embedding component `mock_mode: true`.
