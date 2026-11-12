# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Workflow service client: templates, workflow CRUD/lifecycle, executions,
test runs and public inbound webhooks.

Access it through ``SynapseOneClient(...).workflow`` or build it directly with a
:class:`~synapseone_sdk._http.HttpClient`.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

import requests

from ._http import WEBHOOK_TIMEOUT, HttpClient, SynapseOneError


def unwrap_executions(payload: Any) -> list:
    """Normalize GET /v1/executions: engine returns {data: []}, mocks may return [].

    Accepts both a bare list and the {data: [...]} envelope so callers
    always get a list.
    """
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if payload is None:
        return []
    return payload  # type: ignore[return-value]


class WorkflowService:
    """Typed methods for every ``/v1`` workflow endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    # ---- templates ----
    def list_templates(self) -> Any:
        """List built-in workflow templates."""
        return self._req("GET", "/v1/templates")

    def get_template(self, name: str) -> Any:
        """Fetch a single built-in template definition by name."""
        return self._req("GET", f"/v1/templates/{quote(name, safe='')}")

    # ---- workflows ----
    def list_workflows(self) -> Any:
        """List workflows."""
        return self._req("GET", "/v1/workflows")

    def get_workflow(self, wf_id: str) -> Any:
        """Fetch a workflow definition."""
        return self._req("GET", f"/v1/workflows/{quote(wf_id, safe='')}")

    def create_workflow_from_template(
        self, template: str, name: str | None = None
    ) -> Any:
        """Create a workflow from a built-in template."""
        return self._req("POST", "/v1/workflows", {"template": template, "name": name})

    def create_workflow(
        self, name: str, definition: dict, settings: dict | None = None
    ) -> Any:
        """Create a workflow from a raw workflow definition."""
        body: dict = {"name": name, "definition": definition}
        if settings is not None:
            body["settings"] = settings
        return self._req("POST", "/v1/workflows", body)

    def update_workflow(
        self,
        wf_id: str,
        name: str | None = None,
        definition: dict | None = None,
        settings: dict | None = None,
    ) -> Any:
        """Update a workflow's name, definition and/or settings."""
        patch: dict = {}
        if name is not None:
            patch["name"] = name
        if definition is not None:
            patch["definition"] = definition
        if settings is not None:
            patch["settings"] = settings
        return self._req("PUT", f"/v1/workflows/{quote(wf_id, safe='')}", patch)

    def delete_workflow(self, wf_id: str) -> Any:
        """Delete a workflow."""
        return self._req("DELETE", f"/v1/workflows/{quote(wf_id, safe='')}")

    def activate_workflow(self, wf_id: str) -> Any:
        """Activate a workflow (webhooks and triggers start firing)."""
        return self._req("POST", f"/v1/workflows/{quote(wf_id, safe='')}/activate")

    def deactivate_workflow(self, wf_id: str) -> Any:
        """Deactivate a workflow (triggers stop, history is kept)."""
        return self._req("POST", f"/v1/workflows/{quote(wf_id, safe='')}/deactivate")

    def execute_workflow(
        self,
        wf_id: str,
        payload: dict | None = None,
        *,
        wait: bool = False,
        timeout_ms: int = 30000,
    ) -> Any:
        """Trigger a manual execution.

        Queue mode returns 202 with an ``executionId``. Pass ``wait=True`` to
        block until the worker finishes (bounded by ``timeout_ms``).
        """
        qs = ""
        if wait:
            bounded = max(1000, min(int(timeout_ms), 300000))
            qs = f"?wait=1&timeoutMs={bounded}"
        return self._req(
            "POST", f"/v1/workflows/{quote(wf_id, safe='')}/execute{qs}", payload or {}
        )

    def wait_for_execution(
        self, exec_id: str, timeout_ms: int = 30000, poll_ms: int = 500
    ) -> Any:
        """Poll an execution until it leaves queued/running."""
        import time as _time

        deadline = _time.time() + max(1000, min(int(timeout_ms), 300000)) / 1000
        current = self.get_execution(exec_id, include_data=True)
        while (
            isinstance(current, dict)
            and current.get("status") in ("queued", "running")
            and _time.time() < deadline
        ):
            _time.sleep(max(100, min(int(poll_ms), 5000)) / 1000)
            current = self.get_execution(exec_id, include_data=True)
        return current

    # ---- self-hosted workflow runners ----
    def list_workflow_runners(self) -> Any:
        return self._req("GET", "/v1/workflow-runners")

    def get_workflow_runner(self, runner_id: str) -> Any:
        return self._req("GET", f"/v1/workflow-runners/{quote(runner_id, safe='')}")

    def create_workflow_runner(
        self,
        name: str,
        mode: str = "custom",
        queue: str | None = None,
        api_key_id: str | None = None,
        key_prefix: str | None = None,
        scopes: list[str] | None = None,
        metadata: dict | None = None,
    ) -> Any:
        body: dict = {"name": name, "mode": mode}
        if queue:
            body["queue"] = queue
        if api_key_id:
            body["apiKeyId"] = api_key_id
        if key_prefix:
            body["keyPrefix"] = key_prefix
        if scopes:
            body["scopes"] = scopes
        if metadata:
            body["metadata"] = metadata
        return self._req("POST", "/v1/workflow-runners", body)

    def get_workflow_runner_connection(self, runner_id: str) -> Any:
        return self._req(
            "GET", f"/v1/workflow-runners/{quote(runner_id, safe='')}/connection"
        )

    def get_workflow_runner_command(self, runner_id: str, api_key: str | None = None) -> Any:
        body = {"apiKey": api_key} if api_key else {}
        return self._req(
            "POST",
            f"/v1/workflow-runners/{quote(runner_id, safe='')}/command",
            body,
        )

    def delete_workflow_runner(self, runner_id: str) -> Any:
        return self._req(
            "DELETE", f"/v1/workflow-runners/{quote(runner_id, safe='')}"
        )

    # ---- executions ----
    def list_executions(self, query: str | dict | None = "") -> Any:
        """List executions.

        query may be a raw string (e.g. 'limit=20') or a dict limited to the
        engine allowlist: limit/offset/workflowId/status/triggeredBy/includeData.
        Returns a plain list — accepts both the {data: []} envelope and a
        bare array (see unwrap_executions).
        """
        q = ""
        if isinstance(query, dict):
            allowed = (
                "limit",
                "offset",
                "workflowId",
                "status",
                "triggeredBy",
                "includeData",
            )
            params = {k: query[k] for k in allowed if query.get(k) not in (None, "")}
            qs = urlencode(params)
            q = f"?{qs}" if qs else ""
        elif query:
            q = query if query.startswith("?") else f"?{query}"
        raw = self._req("GET", f"/v1/executions{q}")
        return unwrap_executions(raw)

    def get_execution(self, exec_id: str, include_data: bool = False) -> Any:
        """Fetch one execution (optionally with its payload data)."""
        qs = "?includeData=true" if include_data else ""
        return self._req("GET", f"/v1/executions/{quote(exec_id, safe='')}{qs}")

    def test_run(
        self,
        definition: dict,
        input: dict | None = None,
        workflow_id: str | None = None,
    ) -> Any:
        """Try a definition without saving (POST /v1/workflows/test-run).

        Pass workflow_id to attach the run to a saved workflow's history.
        """
        body: dict = {"definition": definition, "input": input or {}}
        if workflow_id:
            body["workflowId"] = workflow_id
        return self._req("POST", "/v1/workflows/test-run", body)

    # ---- credentials (account-scoped secrets, encrypted at rest) ----
    def create_credential(
        self,
        account_id: str,
        name: str,
        kind: str = "bearer",
        secret: str = "",
        *,
        type: str | None = None,
        expires_at: str | None = None,
    ) -> dict:
        """Store an account credential (secret is write-only, encrypted at rest)."""
        body: dict[str, Any] = {
            "accountId": account_id,
            "name": name,
            "kind": kind or type or "bearer",
            "secret": secret,
        }
        return self._req("POST", "/v1/credentials", body)

    def list_credentials(self, account_id: str | None = None) -> list:
        """List credential metadata (never secrets)."""
        qs = f"?accountId={quote(account_id, safe='')}" if account_id else ""
        raw = self._req("GET", f"/v1/credentials{qs}")
        if isinstance(raw, dict) and isinstance(raw.get("data"), list):
            return raw["data"]
        return raw if isinstance(raw, list) else []

    def get_credential(self, cred_id: str) -> dict:
        """Fetch one credential's metadata (never the secret)."""
        return self._req("GET", f"/v1/credentials/{quote(cred_id, safe='')}")

    def rotate_credential(self, cred_id: str, secret: str) -> dict:
        """Rotate a credential's secret in place (write-only)."""
        return self._req(
            "POST",
            f"/v1/credentials/{quote(cred_id, safe='')}/rotate",
            {"secret": secret},
        )

    def delete_credential(self, cred_id: str) -> dict:
        """Delete a credential."""
        return self._req("DELETE", f"/v1/credentials/{quote(cred_id, safe='')}")

    # ---- durable human tasks (#44) ----
    def create_human_task(
        self,
        title: str,
        *,
        description: str = "",
        assignee: str | None = None,
        candidate_roles: list[str] | None = None,
        deadline: str | None = None,
        decision_schema: dict | None = None,
        payload: dict | None = None,
        workflow_id: str | None = None,
        execution_id: str | None = None,
        node: str | None = None,
    ) -> dict:
        """Create a durable human task (claim/complete/reject/expire)."""
        body: dict[str, Any] = {
            "title": title,
            "description": description,
            "candidateRoles": candidate_roles or [],
            "decisionSchema": decision_schema or {},
            "payload": payload or {},
        }
        if assignee:
            body["assignee"] = assignee
        if deadline:
            body["deadline"] = deadline
        if workflow_id:
            body["workflowId"] = workflow_id
        if execution_id:
            body["executionId"] = execution_id
        if node:
            body["node"] = node
        return self._req("POST", "/v1/human-tasks", body)

    def list_human_tasks(self, status: str | None = None, **filters: Any) -> list:
        """List tenant-scoped human tasks. Filters: executionId, workflowId, assignee, limit, offset."""
        params: dict[str, Any] = {k: v for k, v in filters.items() if v is not None}
        if status:
            params["status"] = status
        qs = urlencode(params) if params else ""
        raw = self._req("GET", f"/v1/human-tasks{('?' + qs) if qs else ''}")
        return raw.get("items", []) if isinstance(raw, dict) else (raw or [])

    def get_human_task(self, task_id: str) -> dict:
        return self._req("GET", f"/v1/human-tasks/{quote(task_id, safe='')}")

    def claim_human_task(self, task_id: str) -> dict:
        return self._req("POST", f"/v1/human-tasks/{quote(task_id, safe='')}/claim", {})

    def complete_human_task(
        self, task_id: str, decision: dict | None = None, note: str | None = None
    ) -> dict:
        body: dict[str, Any] = {"decision": decision or {}}
        if note:
            body["note"] = note
        return self._req(
            "POST", f"/v1/human-tasks/{quote(task_id, safe='')}/complete", body
        )

    def reject_human_task(
        self, task_id: str, note: str, decision: dict | None = None
    ) -> dict:
        return self._req(
            "POST",
            f"/v1/human-tasks/{quote(task_id, safe='')}/reject",
            {"note": note, "decision": decision or {}},
        )

    def expire_human_task(self, task_id: str, force: bool = False) -> dict:
        return self._req(
            "POST",
            f"/v1/human-tasks/{quote(task_id, safe='')}/expire",
            {"force": force},
        )

    # ---- tenant secret vault (#47) ----
    def create_secret(
        self,
        name: str,
        value: str,
        *,
        description: str = "",
        scope: str = "tenant",
        account_id: str | None = None,
    ) -> dict:
        body: dict[str, Any] = {
            "name": name,
            "value": value,
            "description": description,
            "scope": scope,
        }
        if account_id:
            body["accountId"] = account_id
        return self._req("POST", "/v1/secrets", body)

    def list_secrets(self) -> list:
        raw = self._req("GET", "/v1/secrets")
        return raw.get("items", []) if isinstance(raw, dict) else (raw or [])

    def get_secret(self, name: str) -> dict:
        return self._req("GET", f"/v1/secrets/{quote(name, safe='')}")

    def read_secret(self, name: str, version: int | None = None) -> dict:
        return self._req(
            "POST",
            f"/v1/secrets/{quote(name, safe='')}/read",
            {"version": version} if version else {},
        )

    def rotate_secret(self, name: str, value: str, grace_seconds: int = 86400) -> dict:
        return self._req(
            "POST",
            f"/v1/secrets/{quote(name, safe='')}/rotate",
            {"value": value, "graceSeconds": grace_seconds},
        )

    def revoke_secret(self, name: str, version: int | None = None) -> dict:
        return self._req(
            "POST",
            f"/v1/secrets/{quote(name, safe='')}/revoke",
            {"version": version} if version else {},
        )

    def delete_secret(self, name: str) -> dict:
        return self._req("DELETE", f"/v1/secrets/{quote(name, safe='')}")

    def trigger_webhook(
        self,
        path: str,
        payload: Any | None = None,
        method: str | None = None,
    ) -> Any:
        """Fire a public inbound webhook through the gateway: ANY /webhook/:path."""
        clean = str(path or "").strip("/").split("?")[0]
        if not clean:
            raise SynapseOneError("synapseone webhook: path required")
        verb = (method or ("GET" if payload is None else "POST")).upper()
        return self._http.request(
            verb,
            f"/webhook/{clean}",
            payload,
            timeout=WEBHOOK_TIMEOUT,
            retryable=True,
        )


def trigger_webhook(
    webhook_base_url: str,
    path: str,
    payload: Any | None = None,
    method: str | None = None,
    timeout: int = WEBHOOK_TIMEOUT,
) -> Any:
    """Fire a public inbound webhook: ANY /webhook/:path (no auth).

    Triggers the ACTIVE workflow whose webhook node declares that ``path``.
    The gateway proxies ``/webhook/*`` to the workflow service; the 300s
    gateway budget is the default timeout.
    """
    clean = str(path or "").strip("/").split("?")[0]
    if not clean:
        raise SynapseOneError("synapseone webhook: path required")
    verb = (method or ("GET" if payload is None else "POST")).upper()
    url = webhook_base_url.rstrip("/") + "/webhook/" + clean
    try:
        if verb == "GET":
            r = requests.request(verb, url, timeout=timeout)
        else:
            r = requests.request(
                verb,
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=timeout,
            )
    except Exception as e:
        raise SynapseOneError(f"synapseone network /webhook/{clean}: {e}") from e
    try:
        r.raise_for_status()
    except Exception as e:
        raise SynapseOneError(
            f"synapseone {r.status_code} /webhook/{clean}: {r.text[:500]}",
            status=r.status_code,
        ) from e
    if not r.text:
        return None
    try:
        return r.json()
    except ValueError:
        return r.text
