# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Build-time helper: cache the Decision 2.0 package without loading weights."""

import json

from huggingface_hub import snapshot_download

from .config import settings


def main() -> None:
    path = snapshot_download(repo_id=settings.DECISION_MODEL_NAME)
    print(json.dumps({"decision_model": settings.DECISION_MODEL_NAME, "path": path}))


if __name__ == "__main__":
    main()
