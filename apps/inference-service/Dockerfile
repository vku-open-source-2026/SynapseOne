# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM python:3.11-slim

WORKDIR /app

# Prevent python from buffering stdout/stderr and writing .pyc
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=4008 \
    HF_HOME=/app/.cache/huggingface

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-models.txt requirements-torch.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# CPU model stack: ONNX Runtime + tokenizer (small, no torch/CUDA).
ARG INSTALL_MODELS=1
RUN if [ "$INSTALL_MODELS" = "1" ]; then \
      pip install --no-cache-dir -r requirements-models.txt; \
    fi

# Optional: PyTorch for the 0.8B decision model (adds ~1 GB and ~3 GB RAM at
# runtime). Enabled by default; set to 0 on memory-constrained nodes (the
# deterministic router fallback stays active).
ARG INSTALL_TORCH=1
RUN if [ "$INSTALL_TORCH" = "1" ]; then \
      pip install --no-cache-dir -r requirements-torch.txt; \
      if [ "$INSTALL_MODELS" != "1" ]; then \
        pip install --no-cache-dir -r requirements-models.txt; \
      fi; \
    fi

COPY src ./src

# Create non-root user
RUN useradd -m -u 1000 appuser \
    && mkdir -p "$HF_HOME" \
    && chown -R appuser:appuser /app
USER appuser

# Bake the int8 embedding graph into the image so production does not need the
# Hugging Face network at boot. Set to 0 for air-gapped/mounted-model builds.
ARG PREFETCH_EMBEDDING=1
RUN if [ "$INSTALL_MODELS" = "1" ] && [ "$PREFETCH_EMBEDDING" = "1" ]; then \
      python -m src.prefetch; \
    fi

# Optional: bake the ~3 GB Decision-2.0 package into the image so the first
# decision request does not download it. Set to 1 for self-contained images.
ARG PREFETCH_DECISION=0
RUN if [ "$INSTALL_TORCH" = "1" ] && [ "$PREFETCH_DECISION" = "1" ]; then \
      python -m src.prefetch_decision; \
    fi

EXPOSE 4008

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:4008/health')" || exit 1

CMD ["python3", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4008"]
