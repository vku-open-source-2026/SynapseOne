# ADR 0004 — Workflow approval checkpoints and runner audience

- **Status:** Accepted — implemented in Phase 1.
- **Date:** 2026-11-23
- **Owners:** Workflow / Security

## Context

The workflow API allowed a caller to create a human task for a paused execution
and choose its node name. A task could therefore resume a run at an arbitrary
node, bypassing the engine-created pause checkpoint. Tenant runners also shared
an organization queue, so a runner created by one account could claim another
account's execution and request its decrypted credentials.

## Decision

1. A paused execution stores `pause_task_id` and `pause_node`, written by the
   engine when it creates the pause task. Only that exact task may resume the
   execution, and only at `pause_node`.
2. `POST /v1/human-tasks` refuses to create a second task for an already paused
   execution. Standalone tasks remain supported.
3. Legacy/unbound paused executions fail closed with
   `not_pause_checkpoint`; they must be expired or re-created, not silently
   approved.
4. Tenant runners have an `audience`:
   - `account` (default): may claim only executions whose principal has the same
     account;
   - `org`: explicit organization-wide compute, only creatable by an org admin.
   Existing runners without an account are migrated to `org`; account-bound
   runners are migrated to `account`.
5. Platform runners remain owner-managed and are authorized by the separate
   platform-runner protocol.

## Consequences

- Paused executions created before the migration without a checkpoint cannot be
  resumed for security reasons. Operators should expire and recreate them.
- Organization-wide runners must be created/recreated by an org administrator.
- The Console/API displays `audience`; clients that need account isolation should
  use account-bound credentials.
