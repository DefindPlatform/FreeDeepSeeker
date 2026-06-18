# DeepSeek Coding Agent

## Execution model

`deepseek-agent` is a local tool-using coding agent. The model never receives direct operating-system access. It requests typed tools, the local policy layer validates each request, and only then does the local runtime execute it.

The normal lifecycle is:

1. Resolve and canonicalize the workspace.
2. Load `.deepseek-agent.json` and the selected permission mode.
3. Create a run transaction under `.deepseek-agent/runs/<run-id>`.
4. Ask the model for one tool call at a time.
5. Validate path, protected-file, command, size, and approval policy.
6. Snapshot a path before its first mutation and write atomically.
7. Execute relevant checks with a structured executable/argument call.
8. Record tool and command events in the run manifest.
9. Complete the transaction or automatically roll file mutations back after failure.

## Permission modes

| Mode | Reads | File mutations | Commands |
| --- | --- | --- | --- |
| `read-only` | Allowed except protected paths | Denied | Denied |
| `ask` | Allowed except protected paths | Diff preview + confirmation | Confirmation + allowlist |
| `full` | Allowed except protected paths | Allowed and journaled | Allowed only through the program policy |

`--yes` is an alias for `--mode full`. It does not bypass protected paths, workspace confinement, command allowlists, Git mutation restrictions, size limits, or transaction journaling.

Project configuration is treated as untrusted input. A repository may select `read-only` or `ask`, but a configured `full` is downgraded to `ask`; only the operator's explicit CLI flag can enable full mode. Project configuration cannot enable access to built-in protected secret paths.

## Filesystem safety

- Paths are resolved against the canonical workspace root.
- Existing ancestors are resolved through `realpath`, preventing a new file path from escaping through a symlink.
- `.env*`, authentication files, private-key formats, credential files, and configured protected paths are unavailable to model tools by default.
- Writes use a temporary sibling file followed by rename.
- The first mutation of each path stores a backup and content hash.
- Undo verifies the post-run hash before restoring, preventing accidental overwrite of newer manual work.

## Command safety

The agent does not invoke a command string through PowerShell, `cmd.exe`, or `/bin/sh`. The model supplies a `program` and an argument array, which are passed to `spawn` with `shell: false`.

Programs must be listed in `allowedPrograms`. Arguments containing traversal or absolute paths outside the workspace are rejected. Git is restricted to read-only subcommands. Sensitive environment variables are removed before child-process launch.

This is process hardening, not a kernel sandbox. An allowed executable or project test script can still contain arbitrary code. Use containers or a dedicated low-privilege account for untrusted repositories.

## Recovery and audit

Run manifests contain timestamps, tool names, targets, command metadata, result status, file snapshots, and backup locations. File contents supplied to write tools are not copied into audit events. Backups remain local under the protected state directory.

`deepseek-agent --undo` restores the newest undoable run. Failed runs with file mutations are rolled back automatically by default. Set `rollbackOnFailure` to `false` only when partial results need to be inspected manually.

## Known boundaries

- DeepSeek Web is an unofficial and changeable provider contract. Provider adapters and an official API fallback remain desirable.
- Allowed project scripts execute with the current user's OS privileges. True isolation requires a container/VM/OS sandbox.
- Transaction tracking covers file tools. Files changed indirectly by a child process are not yet captured individually.
- The current agent is single-user and local-first; remote multi-tenant deployment is not supported.
