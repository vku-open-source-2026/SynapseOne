# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Build-time helper: download and validate the ONNX embedding graph."""

import json
import logging

from .config import settings
from .embedding import embedding_engine
from .onnx_embedding import all_onnx_files

logger = logging.getLogger(__name__)


def _prefetch_graphs() -> None:
    """Cache every shipped graph so the image is portable across CPU targets.

    The build host may support different instruction sets than the runtime
    host; downloading all int8 variants avoids a runtime network dependency.
    """
    if settings.EMBEDDING_ONNX_PATH:
        return
    from huggingface_hub import hf_hub_download

    filenames = all_onnx_files()
    if settings.EMBEDDING_ONNX_FILE:
        filenames = [settings.EMBEDDING_ONNX_FILE, *filenames]
    for filename in dict.fromkeys(filenames):
        try:
            hf_hub_download(repo_id=settings.EMBEDDING_MODEL_NAME, filename=filename)
        except Exception as exc:  # noqa: BLE001 - optional variants may be absent
            logger.warning("could not prefetch %s: %s", filename, exc)


def main() -> None:
    _prefetch_graphs()
    ok = embedding_engine.load_model()
    print(
        json.dumps(
            {
                "embedding_backend": settings.EMBEDDING_BACKEND,
                "status": embedding_engine.status,
            },
            indent=2,
        )
    )
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
