#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
"""Emit installed Python distribution metadata as JSON for the license gate.

Runs in the same interpreter/environment that will ship the service, so the
inventory reflects resolved service dependencies rather than requirement ranges.
Uses only the Python standard library.
"""

import json
import re
import sys
from importlib import metadata

LICENSE_FILE = re.compile(r"^(?:licen[cs]e|copying|notice)(?:[._-]|$)", re.IGNORECASE)


def clean(value):
    if not value:
        return ""
    return " ".join(str(value).split())


def first_line(value):
    return clean(str(value).splitlines()[0]) if value else ""


def distribution_license(meta):
    expression = clean(meta.get("License-Expression"))
    if expression:
        return expression
    classifiers = [
        clean(item)
        for item in (meta.get_all("Classifier") or [])
        if item.startswith("License ::")
    ]
    raw = meta.get("License") or ""
    raw_line = first_line(raw)
    # A short SPDX-ish value is authoritative; full license text is not.
    if raw_line and len(raw_line) <= 120 and not raw_line.lower().startswith(("the ", "copyright ", "permission ")):
        return raw_line
    for classifier in classifiers:
        if classifier.startswith("License :: OSI Approved ::"):
            return classifier.rsplit("::", 1)[-1].strip()
    if classifiers:
        return classifiers[-1].rsplit("::", 1)[-1].strip()
    return "UNKNOWN"


def license_files(dist):
    files = []
    for entry in dist.files or []:
        name = entry.name
        if not LICENSE_FILE.match(name):
            continue
        try:
            path = dist.locate_file(entry)
            if path.is_file() and path.stat().st_size <= 2 * 1024 * 1024:
                files.append(str(path))
        except OSError:
            continue
    return sorted(set(files))


def source_url(meta):
    for key in ("Home-page", "Project-URL"):
        values = meta.get_all(key) or []
        for value in values:
            text = clean(value)
            if "http://" in text or "https://" in text:
                return text.split(", ", 1)[-1]
    return ""


def main():
    components = []
    for dist in metadata.distributions():
        meta = dist.metadata
        name = clean(meta.get("Name"))
        if not name:
            continue
        components.append(
            {
                "name": name,
                "version": clean(dist.version) or "?",
                "license": distribution_license(meta),
                "classifiers": [
                    clean(item)
                    for item in (meta.get_all("Classifier") or [])
                    if item.startswith("License ::")
                ],
                "source": source_url(meta),
                "path": str(getattr(dist, "_path", "")),
                "licenseFiles": license_files(dist),
            }
        )
    components.sort(key=lambda item: (item["name"].lower(), item["version"]))
    json.dump(
        {
            "generatedAt": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).isoformat(),
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "components": components,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
