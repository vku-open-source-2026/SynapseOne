# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Static checks for the runner image contract (no Docker build required)."""

from __future__ import annotations

import os
import unittest
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[2] / "Dockerfile"


def _instructions() -> list[str]:
    lines = []
    for raw in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return lines


class DockerfileContractTests(unittest.TestCase):
    def test_no_listener_metadata(self):
        instructions = _instructions()
        self.assertFalse(any(line.startswith("EXPOSE") for line in instructions))
        self.assertFalse(any(line.startswith("ENV PORT=") for line in instructions))
        self.assertIn("HEALTHCHECK NONE", instructions)

    def test_runtime_entrypoint_is_node_runner(self):
        self.assertIn(
            'CMD ["node", "/app/dist/runner.js"]',
            [line.replace("  ", " ") for line in _instructions()],
        )

    def test_production_lockfile_installs_only(self):
        text = "\n".join(_instructions())
        self.assertIn("npm ci --include=dev", text)
        self.assertIn("npm ci --omit=dev", text)
        self.assertNotIn("npm install", text)
        self.assertNotIn("|| npm", text)

    def test_no_recursive_chown_layer(self):
        text = "\n".join(_instructions())
        self.assertNotIn("chown -R", text)
        self.assertIn(
            "COPY --chown=runner:runner --from=modelstack /app/.cache/huggingface",
            text,
        )
        self.assertIn(
            "COPY --chown=runner:runner --from=nodedeps /app/node_modules",
            text,
        )

    def test_model_stack_is_copy_only_and_pinned(self):
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn(
            "ARG MODEL_STACK_IMAGE=synapseone/inference:0.9.1-20261114", text
        )
        self.assertIn("FROM ${MODEL_STACK_IMAGE} AS modelstack", text)
        # The model image is only a COPY source, never the final stage.
        final_from = [line for line in _instructions() if line.startswith("FROM ")]
        self.assertEqual(final_from[-1], "FROM ${PYTHON_IMAGE}")


if __name__ == "__main__":
    unittest.main()
