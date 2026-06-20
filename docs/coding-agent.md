# DeepSeek Coding Agent

## Execution model

`deepseek-agent` is a local tool-using coding agent. The model never receives direct operating-system access. It requests typed tools, the local policy layer validates each request, and only then does the local runtime execute it.

The normal lifecycle is:

1. Resolve and canonicalize the workspace.
2. Load `.deepseek-agent.json` and the selected permission mode.
3. Create a run transaction under `.deepseek-agent/runs/<run-id>`.
4. Start a bounded runtime state machine and ask the model for tool calls.
5. Validate path, protected-file, command, size, and approval policy.
6. Snapshot a path before its first mutation and write atomically.
7. Execute relevant checks with a structured executable/argument call.
8. Record tool and command events in the run manifest.
9. Stop repeated identical calls and enforce both model-step and tool-call budgets.
10. Complete the transaction or automatically roll file mutations back after failure.
11. Optionally write a machine-readable run report with state, usage and tool outcomes.

## Permission modes

| Mode | Reads | File mutations | Commands |
| --- | --- | --- | --- |
| `read-only` | Allowed except protected paths | Denied | Denied |
| `ask` | Allowed except protected paths | Diff preview + confirmation | Confirmation + allowlist |
| `full` | Allowed except protected paths | Allowed and journaled | Allowed only through the program policy |

`--yes` is an alias for `--mode full`. It does not bypass protected paths, workspace confinement, command allowlists, Git mutation restrictions, size limits, or transaction journaling.

Project configuration is treated as untrusted input. A repository may select `read-only` or `ask`, but a configured `full` is downgraded to `ask`; only the operator's explicit CLI flag can enable full mode. Project configuration cannot enable access to built-in protected secret paths.

## Project configuration

Create a starter file with `deepseek-agent --init`. Supported keys:

```json
{
  "permissionMode": "ask",
  "allowProtectedPaths": false,
  "protectedPaths": ["secrets", "config/production"],
  "allowedPrograms": ["node", "npm", "git"],
  "maxFileBytes": 1000000,
  "maxCommandOutputBytes": 100000,
  "commandTimeoutMs": 30000,
  "commandSandbox": "process",
  "dockerImage": "node:22-alpine",
  "sandboxMemoryMb": 512,
  "sandboxCpu": 1,
  "sandboxNetwork": false,
  "rollbackOnFailure": true,
  "historyEnabled": true,
  "historyTtlDays": 30,
  "maxConversationExchanges": 12,
  "maxConversationChars": 30000
}
```

Repository configuration can only narrow the built-in program allowlist. Limits are clamped to files `1 KiB–10 MiB`, command output `1 KiB–1 MiB`, and timeout `1–120 seconds`. `allowProtectedPaths` from a repository is always forced to `false`.

Built-in programs include Node package managers, Python/pip/pytest, Git, Rust/Cargo, Go, .NET, Java/Javac/Maven/Gradle. Git is limited to `status`, `diff`, `log`, `show`, `rev-parse` and `ls-files`.

## Model tools

- `get_project_map` — paginated/searchable project index
- `get_project_memory` — read durable project facts and decisions
- `remember_project_memory` and `forget_project_memory` — maintain durable non-secret context across conversations
- `list_files` — bounded directory listing
- `read_file` and `search_files` — inspect text inside the workspace
- `write_file` and `replace_in_file` — atomic changes
- `delete_path` — delete a file or directory
- `run_command` — structured executable plus argument array

All paths remain workspace-relative and protected paths are rejected for reads and mutations.

Schemas and permission categories are owned by `lib/tool-registry.js`. The provider receives schemas without internal metadata, while the local runtime retains each tool's `read`, `write`, or `command` category for policy and reporting.

## Runtime controls and dry-run

`--max-steps` limits model round trips and `--max-tool-calls` independently limits local tool requests. The runtime rejects a fourth identical tool call by default, including calls whose JSON object keys only differ in order. This prevents a confused model from consuming the complete budget in a tight loop.

Use `--dry-run` to let the model inspect the project and request intended writes, deletions, or commands without executing them. Mutation tools still validate paths, protected files, content size, exact replacement matches, command allowlists and arguments. Their results are marked `dry_run: true`, allowing the model to return a concrete implementation plan based on real files.

Use `--report <path>` to atomically save a JSON report. It contains the run state, timestamps, model, workspace, counters, provider token usage when available, and sanitized tool outcomes. File contents and command output are not copied into the report.

```powershell
deepseek-agent --dry-run --report .deepseek-agent\plan.json "Обнови API"
deepseek-agent --max-steps 40 --max-tool-calls 160 "Исправь тесты"
```

## Filesystem safety

- Paths are resolved against the canonical workspace root.
- Existing ancestors are resolved through `realpath`, preventing a new file path from escaping through a symlink.
- `.env*`, authentication files, private-key formats, credential files, and configured protected paths are unavailable to model tools by default.
- Writes use a temporary sibling file followed by rename.
- The first mutation of each path stores a backup and content hash.
- Undo verifies the post-run hash before restoring, preventing accidental overwrite of newer manual work.

## Command safety

The agent does not invoke a command string through PowerShell, `cmd.exe`, or `/bin/sh`. The model supplies a `program` and an argument array, which are passed to `spawn` with `shell: false`.

Programs must be listed in `allowedPrograms`. Arguments containing traversal or absolute paths outside the workspace are rejected. Git is restricted to read-only subcommands. Sensitive environment variables are removed before child-process launch. Timeouts terminate the complete spawned process tree instead of leaving grandchildren running.

`commandSandbox: "process"` is the compatible default and is process hardening, not a kernel sandbox. For untrusted project commands, install Docker and select `commandSandbox: "docker"`. Docker runs the chosen program with no capabilities, `no-new-privileges`, no network by default, 128-process limit, configurable CPU/memory limits and only the workspace mounted at `/workspace`. Select an image that contains the required toolchain; enabling `sandboxNetwork` should be an explicit exception. Docker isolation does not protect files inside the mounted workspace, so transaction review and a clean Git worktree remain important.

## Recovery and audit

Run manifests contain timestamps, tool names, targets, command metadata, result status, file snapshots, and backup locations. File contents supplied to write tools are not copied into audit events. Backups remain local under the protected state directory.

`deepseek-agent --undo` restores the newest undoable run. Failed runs with file mutations are rolled back automatically by default. Set `rollbackOnFailure` to `false` only when partial results need to be inspected manually.

Each workspace has a deterministic proxy session and saved request/result exchanges in `.deepseek-agent/conversation.json`. Therefore a new CLI process or Studio task continues the same project dialogue. By default the local history keeps 12 exchanges, at most 30,000 serialized characters, for 30 days. The four history settings above are clamped to safe bounds. Set `historyEnabled` to `false` for a repository that must never persist conversation context, or use `--no-history` for one private invocation; private invocations use an isolated proxy session and delete that remote session when they finish without erasing previously saved local history. Use `/new` interactively, `--new-session` for a one-shot run, or **Новый диалог** in Studio to clear both local history and the regular proxy session.

Durable project memory is stored separately in `.deepseek-agent/memory.json`. The agent receives it at the start of every task, even after `/new`, and can maintain typed `fact`, `decision`, `constraint`, `preference`, and `todo` records through policy-controlled tools. Keys are updated in place, storage is bounded to 100 entries, and secret-like keys or values are rejected. `/memory` displays the records, `/memory forget <key>` removes one, and `/memory clear` removes all durable memory. Clearing conversation context intentionally does not erase project knowledge.

Interactive commands are `/status`, `/mode <read-only|ask|full>`, `/models`, `/model <id>`, `/memory`, `/memory forget <key>`, `/memory clear`, `/new`, `/undo`, `/help` and `/exit`. Use `--project-map --json` for machine-readable project inventory.

## Known boundaries

- DeepSeek Web is an unofficial and changeable provider contract. Provider adapters and an official API fallback remain desirable.
- Allowed project scripts execute with the current user's OS privileges. True isolation requires a container/VM/OS sandbox.
- Transaction tracking covers file tools. Files changed indirectly by a child process are not yet captured individually.
- The current agent is single-user and local-first; remote multi-tenant deployment is not supported.
