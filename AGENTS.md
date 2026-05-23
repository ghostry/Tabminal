# Repository Guidelines

## Project Structure & Module Organization

Tabminal is a Node.js ESM application. The backend entry point is
`src/server.mjs`; terminal lifecycle code lives in `src/terminal-session.mjs`
and `src/terminal-manager.mjs`; ACP agent supervision lives in
`src/acp-manager.mjs`. The browser UI is primarily `public/app.js`, with
styles in `public/styles.css`, shell markup in `public/index.html`, and shared
frontend helpers under `public/modules/`. Tests are in `test/`, browser smoke
scripts are in `scripts/`, shell integration files are in `shell/`, and native
app workspaces are under `apps/`.

## Build, Test, and Development Commands

- `npm start -- --accept-terms`: run the local server.
- `npm run dev -- --accept-terms`: run with Node watch mode for `src/` and
  `public/`.
- `npm run build`: run `build.mjs` and produce distributable assets.
- `npm run lint`: run ESLint across the repository.
- `npm test`: run the full Node test suite.
- `node --test test/acp-manager.mjs`: run a focused test file.

Use `TABMINAL_ENABLE_TEST_AGENT=1 npm start -- --accept-terms` when validating
ACP UI flows with the built-in test agent.

## Coding Style & Naming Conventions

Use modern ESM JavaScript with two-space indentation where existing files do.
Prefer explicit helper functions over ad hoc inline parsing, and follow nearby
patterns before adding new abstractions. Keep user-facing labels consistent:
the UI term is `Host`, not `Server`. Frontend state is host-isolated; do not
merge sessions, files, agent tabs, or auth state across hosts.

## Testing Guidelines

Tests use Node's built-in test runner (`node --test`) and `assert`. Add or
update focused tests for backend behavior, persistence, ACP state changes, and
terminal session contracts. For significant UI/ACP changes, run the relevant
unit tests plus `npm run lint`; use `scripts/acp-browser-smoke.mjs` for browser
coverage when interaction behavior changes.

## Commit & Pull Request Guidelines

Recent commits use concise Chinese imperative summaries, for example
`减少终端和 ACP 按需加载流量` or `修复文件树 Git 重置`. Keep commits focused and
mention the affected subsystem. Pull requests should include a short summary,
test results, linked issues when applicable, and screenshots or recordings for
visible UI changes.

## Security & Configuration Tips

This app controls terminals and may launch external ACP runtimes. Do not commit
tokens, private config, or files from `~/.tabminal`. Keep auth browser-owned,
preserve main-host global auth behavior, and avoid weakening WebSocket
reconnect or host-isolation rules without measurement.
