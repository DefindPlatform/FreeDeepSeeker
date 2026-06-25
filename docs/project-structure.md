# Project Structure

This repository is organized around a local API proxy, CLI tools, a coding agent and a local Studio UI. Keep public source, generated artifacts and private runtime state separate.

## Root Files

- `server.js` - local DeepSeek Web proxy and OpenAI/Anthropic/Responses compatibility layer.
- `client.js` - command-line API client.
- `agent.js` - command-line coding agent.
- `studio-server.js` - local Studio host and same-origin API.
- `package.json` - npm scripts, package allowlist and CLI bin entries.
- `.env.example` - documented environment template.
- `auth.example.json` - safe example auth shape.

## Source Folders

- `lib/` - shared runtime modules for server config, HTTP guard, sessions, API routes, agent core, tool registry, task plans, project index, project memory, Git service and logging.
- `scripts/` - operational helpers for auth, import, doctor checks, release checks, docs checks, repository hygiene and live smoke tests.
- `dashboard/` - Studio frontend source and build configuration.
- `chrome-extension/` - unpacked Manifest V3 extension for exporting DeepSeek Web auth.
- `tests/` - Node test runner unit and integration tests.
- `.github/` - CI and release automation.
- `.agents/` - local agent instructions for this repository.

## Documentation

- `README.md` - product overview, quick start and main commands.
- `docs/README.md` - documentation index.
- `docs/api-documentation.md` - public API contract.
- `docs/architecture.md` - runtime/module boundaries.
- `docs/coding-agent.md` - agent behavior and configuration.
- `docs/agent-engine.md` - agent execution internals.
- `docs/studio.md` - Studio UI and API.
- `docs/browser-auth.md` - browser login and auth export/import.
- `SECURITY.md` - security posture and private-data handling.
- `CONTRIBUTING.md` - development workflow and checks.
- `CHANGELOG.md` - release history.

## Local Runtime State

These paths are intentionally ignored and must not be committed:

- `deepseek-auth.json` - private DeepSeek session/auth data.
- `.env` and `.env.*` - local secrets and environment overrides.
- `.deepseek-agent/` - local agent conversation, memory and transaction state.
- `.deepseek-studio/` - local Studio state when present.
- `.chrome-for-testing-profile-deepseek/` - Chrome auth profile.
- `node_modules/` - installed dependencies.
- `dashboard/dist/` - generated Studio build.
- `docs/roadmap-*.md` - local planning drafts.

## Release Package Surface

The npm package is intentionally allowlisted through `package.json#files`. Add a new public file there only when it is useful to installed users. Do not replace the explicit allowlist with broad globs.

## Safe Organization Rules

- Do not move root CLI entry points without updating `package.json#bin`, tests and docs.
- Do not move documented routes without updating `docs/api-documentation.md` or `docs/studio.md`.
- Do not move agent config keys without updating `docs/coding-agent.md`.
- Do not commit generated output, browser profiles, local sessions or auth files.
- Run `npm test` after documentation or structure changes; run `npm run check` before release.

