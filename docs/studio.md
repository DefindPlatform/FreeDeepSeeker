# DeepSeek Agent Studio

Studio is a local dashboard for one workspace. It displays the project tree, selected file, current task output, transaction diffs, project statistics, conversation count and undo state.

## Start

```powershell
npm run studio -- -C C:\path\to\project --port 9660
```

The production dashboard is committed under `dashboard/dist/`. Rebuild it after UI changes with `npm run studio:build` (Node.js 20.19+). Studio binds only to `127.0.0.1`.

`DEEPSEEK_API_URL` selects the proxy (default `http://127.0.0.1:9655`). If the proxy uses `FREEDEEPSEEK_API_KEY`, give Studio the same environment variable.

## Conversation context

Tasks in the same workspace reuse a deterministic session and saved project history, including across new agent processes and proxy restarts. The history stores up to 12 final request/result exchanges under `.deepseek-agent/conversation.json`. **Новый диалог** clears this file and resets the corresponding proxy session; it does not undo code changes.

## Permission behavior

- `read-only`: the spawned agent cannot mutate files or run commands.
- `ask`: Studio asks once before starting, then executes that approved task as `full`; individual tool operations do not open terminal prompts.
- `full`: runs immediately with protected paths and command policy still enforced.

Only one task can run at a time. Output is retained in memory up to 5000 lines. File mutations are recorded under `<workspace>/.deepseek-agent/` and can be undone while their post-run hashes still match.

## Local Studio API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Workspace, API, task, conversation and transaction state |
| `GET` | `/api/file?path=<relative>` | Read allowed text; binaries return a notice |
| `POST` | `/api/tasks` | Start `{prompt, model, mode, approved}` |
| `POST` | `/api/undo` | Undo the newest undoable transaction |
| `POST` | `/api/session/reset` | Clear project conversation and proxy session |

Requests are protected against DNS rebinding and cross-site mutation with strict `Host`, `Origin`, `Sec-Fetch-Site`, CSP and same-origin headers. Studio is not intended for network exposure or multi-user hosting.
