# Agent engine contracts

This document defines the maintained contracts for the coding-agent runtime, tool registry, task planning, execution loop, and durable project memory. The implementation owners are `lib/agent-runtime.js`, `lib/tool-registry.js`, `lib/task-plan.js`, `agent.js`, and `lib/project-memory.js`.

## User scenarios and success criteria

| Scenario | Expected result | Evidence |
| --- | --- | --- |
| Run a bounded coding task | The run stops on completion, cancellation, step, tool-call, repetition, or wall-clock limits | JSON run report and unit tests |
| Let the model use a tool | Arguments are schema-validated before policy checks and execution | Registry tests and transaction audit |
| Decompose a change | A persisted plan exposes dependencies, ready work, progress, and legal state transitions | Plan tests and `.deepseek-agent/plan.json` |
| Recover from failure | File and plan mutations can be rolled back without overwriting later user changes | Transaction tests |
| Continue across conversations | Typed non-secret facts and unfinished work survive session reset | Memory tests and `/memory` |

The release target is zero unhandled errors in the deterministic test suite, no secret-bearing fields in reports, and no regression above the benchmark budget described below.

## Boundaries and data flow

1. `agent.js` builds bounded model messages and receives tool calls.
2. `ToolRegistry.validate()` validates JSON arguments. The registry labels every tool as `read`, `write`, or `command`; that label drives permission handling and metrics.
3. `AgentRunController` checks run state, cancellation, time, step, tool-call, and repetition budgets.
4. `executeTool()` applies workspace, protected-path, confirmation, and command policy.
5. `RunTransaction` snapshots mutations and appends a redacted audit event.
6. Results return to the model and are also summarized in the run report.

The engine never receives authentication files through coding tools. Repository configuration may reduce privileges but cannot enable protected-file access or silently select `full` mode.

## Runtime contract

States are `initialized -> running -> completed|failed|cancelled`; terminal transitions are idempotent. Limits have safe defaults and hard upper bounds:

- model steps: CLI `--max-steps`, 1–100;
- tool calls: CLI `--max-tool-calls`, 1–1000;
- wall clock: `maxRunDurationMs` or `--max-duration-ms`, 1 second–24 hours;
- command time: `commandTimeoutMs`, 1–120 seconds;
- file and command output limits: `maxFileBytes` and `maxCommandOutputBytes`.

Errors from runtime policy use stable codes (`RUN_CANCELLED`, `INVALID_STATE`, `DURATION_LIMIT`, `STEP_LIMIT`, `TOOL_CALL_LIMIT`, `REPEATED_TOOL_LOOP`) and may include a user-facing recovery hint. Reports contain duration, usage, failed and denied calls, and counts by permission kind. They contain bounded targets rather than tool payloads.

Cancellation is checked at each model step and tool call. The wall-clock deadline is also attached to in-flight proxy requests, so a stalled model call cannot outlive the configured run budget. Commands have their own timeout and process-tree termination. Failed or cancelled mutations roll back when `rollbackOnFailure` is enabled.

## Tool registry contract

A definition must have a unique name, a supported permission kind, and an object parameter schema. Before execution, required fields, primitive types, enums, bounds, array sizes, and unknown fields for closed schemas are rejected. New optional fields are backward-compatible; removing or changing an existing field requires a release note.

`ToolRegistry.schemas()` is the provider-facing contract. `describe()` is the policy/diagnostic view. Registering a tool does not grant filesystem access: the executor must still enforce workspace and permission policy.

## Task planning contract

Plans are stored locally in `.deepseek-agent/plan.json` and capped at 100 tasks through the model tool (500 at the storage validation boundary). Each task has a stable ID, title, state, dependency IDs, and an optional bounded note. Unknown dependencies, duplicate IDs, self-dependencies, and cycles are rejected.

Only dependency-ready tasks may enter `in_progress`. Legal transitions are explicit; completed tasks cannot silently reopen. Every mutation increments `revision`, and callers can pass `expected_revision` to reject stale concurrent updates. Writes are atomic. Plan mutations participate in run rollback.

## Execution-loop contract

The loop validates a call, accounts for it, applies permissions, records a bounded result, and only then sends that result back to the model. Repeated identical calls are detected using a stable canonical signature. A denied or failed tool result remains recoverable model context; a runtime budget violation terminates the run. The final answer and a bounded local conversation history are saved only after successful completion.

## Context and conversation contract

Project context is layered: a bounded project-map summary, bounded durable memory, relevant local conversation exchanges, and the current request. When the proxy does not already own the session context, saved exchanges are ranked by keyword overlap and recency, packed under `maxConversationChars`, then restored in chronological order. Full files are fetched only through tools. History is isolated by canonical workspace ID, bounded by entry count, characters, and TTL, atomically written, optional per project or invocation, and explicitly resettable without erasing durable project memory.

## Project-memory contract

Memory stores at most 100 typed entries (`fact`, `decision`, `constraint`, `preference`, `todo`), 2,000 characters each, in a file capped at 256 KiB. Keys update in place. Secret-like keys and values are rejected. Corrupt or oversized storage produces an explicit error instead of silently discarding project knowledge. Atomic writes and optimistic revisions prevent unnoticed stale updates.

Conversation history and project memory are independent. `/new` clears conversation context but intentionally preserves durable project memory. Memory mutations participate in transaction rollback.

## Security and privacy review

Primary threats are path escape through symlinks, secret disclosure, shell injection, unbounded output or execution, malicious repository configuration, stale concurrent writes, and rollback clobbering later edits. Mitigations are realpath containment, protected names, no-shell process spawning, environment redaction, hard budgets, non-escalating config, optimistic revisions, hashes before rollback, Docker isolation when selected, and network-off Docker defaults.

Residual risks: process sandbox mode executes approved programs with the user's OS rights, and model output can still contain source code read from the workspace. Use `read-only`, `ask`, Docker sandboxing, and a dedicated repository for untrusted projects.

## Verification and performance budget

`npm test` covers deterministic logic, negative cases, persistence boundaries, rollback, malformed schemas, dependency cycles, stale revisions, corrupt memory, timeouts, and cancellation. `npm run studio:e2e` covers the main UI path and error recovery. `npm run benchmark:agent` runs a reproducible local microbenchmark; the default budget is 2 seconds for 10,000 runtime operations, 2,000 registry validations, and a 100-task dependency plan on supported CI machines.

Release readiness requires `npm run check`, `npm run coverage`, `npm run studio:e2e`, `npm run benchmark:agent`, clean repository hygiene, updated documentation, and observation of CI after push.
