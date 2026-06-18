# Contributing to TeXRA

Thanks for your interest in improving TeXRA! This document explains how to set
up the project, the conventions we follow, and how to get your changes merged.

## Ways to contribute

- **Report bugs** and request features in the
  [issue tracker](https://github.com/texra-ai/texra-issues/issues).
- **Improve documentation** — both the in-repo docs under `docs/` and the
  guides published at [texra.ai/guide](https://texra.ai/guide/).
- **Submit code** — bug fixes, new agents, new model providers, or new CLI/UI
  features. For anything large, please open an issue first so we can agree on
  the approach before you invest time.

## Project layout

TeXRA is a pnpm workspace. The most important directories:

- Repo-root `src/` — host-agnostic core logic (agents, model handlers, LaTeX
  processing, tools, shared schemas).
- `packages/extension/` — the VS Code extension entry point, commands,
  webviews, and packaged resources.
- `packages/desktop/` — the Electron desktop shell.
- `packages/cli/` — the `texra` terminal client.
- `packages/core/` — the shared core package surface.

See [CLAUDE.md](./CLAUDE.md) and [AGENTS.md](./AGENTS.md) for a deeper tour of
the architecture and the coding conventions we expect (platform-coupling
rules, Zod v4 patterns, PocketFlow flows, and more).

## Development setup

Requirements:

- **Node.js >= 22.9.0**
- **pnpm** via Corepack (the repo pins the exact version in `package.json`)
- A **LaTeX distribution** and **Perl** are needed to exercise the LaTeX
  features, but not to build or run the test suite.

```bash
# Install dependencies
corepack pnpm install

# Development build (esbuild + Vite)
npm run compile:fast

# Watch mode
npm run watch:fast

# Production build
npm run package:fast
```

To try the extension, open the repo in VS Code and press <kbd>F5</kbd> to
launch an Extension Development Host.

To run your locally built CLI:

```bash
npm run texra-local:build   # bundle the CLI + resources
npm run texra-local:link    # symlink `texra-local` into ~/.local/bin (one-time)
```

## Before you open a pull request

Run these locally — CI runs the same checks:

```bash
npm run typecheck   # TypeScript type checking (builds do NOT type-check)
npm run lint        # ESLint
npm run format      # Prettier (writes changes)
npm test            # Vitest suite
```

> **Note:** The `compile`/`watch`/`package` builds use esbuild, which only
> strips types and does **not** type-check. Always run `npm run typecheck`
> (or `npm run compile:safe`) before pushing.

## Pull request guidelines

- **Branch** off `main` and keep PRs focused on a single change.
- **Describe** what changed and why; link the issue it addresses.
- **Update `CHANGELOG.md`** for user-facing changes (under Features, Bug
  Fixes, or Improvements). Don't document intermediate bugs fixed within the
  same PR.
- **Add or update tests** when you change behavior.
- **Keep core platform-agnostic.** Code under `src/agent/`, `src/model/`,
  `src/latex/`, `src/tools/`, `src/controllers/`, `src/shared/`, and the other
  VS Code-free zones listed in [CLAUDE.md](./CLAUDE.md) must not import the
  `vscode` module. Reach host services through `platform()` from `@platform`.
- **Match the surrounding style.** Use the existing path aliases (`@agent/*`,
  `@utils/*`, …) and follow the Zod-schema-first conventions documented in
  AGENTS.md.

## Commit messages

Write clear, descriptive commit messages in the imperative mood
(e.g. "Add Gemini streaming handler"). Group related changes into logical
commits.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE) that covers the project. You retain copyright
to your contributions.
