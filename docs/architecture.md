# Architecture

FreeDeepseekAPI is a local-first Node.js application with four user-facing entry points:

- `server.js` — process lifecycle, DeepSeek Web transport and compatibility response conversion.
- `client.js` — interactive and one-shot API client.
- `agent.js` — tool-using coding agent with workspace policy and transactions.
- `studio-server.js` — same-origin local API and static host for Agent Studio.

## Server modules

The proxy process delegates stable infrastructure concerns to focused modules:

- `lib/server-config.js` validates environment configuration before the server starts.
- `lib/logger.js` emits redacted text or JSON logs and propagates `X-Request-Id` across proxy and Studio requests.
- `lib/http-guard.js` owns CORS headers, constant-time API-key comparison and local rate limiting.
- `lib/session-store.js` owns per-agent session creation, bounded recovery history, listing and reset behavior.
- `lib/api-routes.js` owns health, model metadata and session-control routes.

`server.js` retains the DeepSeek-specific Web protocol, PoW flow, model mapping, streaming parser and OpenAI/Anthropic/Responses conversions. This boundary deliberately avoids introducing a generic multi-provider abstraction.

## Coding agent modules

- `lib/agent-core.js` enforces path and command policy, transaction snapshots, rollback and conversation persistence.
- `lib/tool-registry.js` owns model-facing tool schemas and local read/write/command categories.
- `lib/agent-runtime.js` owns run state, model/tool budgets, loop detection, usage accounting and JSON reports.
- `lib/project-index.js` produces the bounded project map used by the agent and Studio.
- `.deepseek-agent/` contains protected local run state and is never exposed to model file tools.

## Validation

`npm run check` is the release gate: lint, unit/integration tests, documentation contracts, Studio production build and dependency audits. HTTP integration tests start real proxy processes with temporary fake auth and never contact DeepSeek.

Pushing a semantic tag matching `package.json` (for example `v0.1.0`) runs the same gate, builds the npm tarball, standalone Studio and Chrome-extension archives, writes SHA-256 checksums and publishes a GitHub Release. Run `npm run release:check -- v0.1.0` before tagging.
