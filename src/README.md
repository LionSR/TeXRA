# `src/` — host-agnostic production code and centralized tests

Production code in this directory is host-agnostic and consumed by one or more of
the VS Code extension (`packages/extension`), Electron desktop app
(`packages/desktop`), and terminal CLI (`packages/cli`). A module does not need
to be used by every host to belong here. `src/test-kernel/` centralizes tests for
both shared and host-specific behavior; suites may import or mock extension,
desktop, and CLI surfaces. Host-specific production wiring lives in the package
that owns that host.

There is no `@texra/core` package. Hosts reach this code through the path
aliases declared in [`tsconfig.json`](../tsconfig.json) (`@agent/*`, `@platform/*`, `@shared/*`, …).
Use the alias, not a long relative chain.

## Subsystems

| Directory           | What it is                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/`        | The agent domain model, PocketFlow flows, and provider abstraction. Largest subsystem; has its own READMEs — start with [`agent/core/README.md`](agent/core/README.md)                                   |
| `src/tools/`        | Tool implementations the agent can call (bash, file edits, delegation, search, setup)                                                                                                                    |
| `src/shared/`       | Two things: wire contracts and message types (Zod schemas), **and** the shared browser UI kit (`wa/`, `styles/`, `litControllers/`, `markdown/`). Browser-reachable throughout                           |
| `src/controllers/`  | Host-neutral orchestration — the layer hosts call into instead of driving `agent/` directly                                                                                                              |
| `src/utils/`        | Host-agnostic helpers. Five modules are additionally browser-safe (see below)                                                                                                                            |
| `src/latex/`        | LaTeX compilation, diffing, formatting, and log parsing                                                                                                                                                  |
| `src/common/`       | Cross-cutting helpers that are not wire contracts — notably `common/errors/` error classification                                                                                                        |
| `src/auth/`         | Sign-in, session, and credential handling. **Core zones import this directly today** — `tools/setup/platform.ts`, `agent/remote/`, `telemetry/` all do. Decoupling it behind ports is proposed, not done |
| `src/platform/`     | The `Platform` port interfaces (config, state, log, fs, workspace, storage, secrets) that hosts implement                                                                                                |
| `src/model/`        | Model catalog, selection, and capability resolution                                                                                                                                                      |
| `src/transcript/`   | Trace and transcript document schemas plus stream logging                                                                                                                                                |
| `src/replacement/`  | Text-replacement utilities used by editing tools                                                                                                                                                         |
| `src/skills/`       | Skill schema and loading                                                                                                                                                                                 |
| `src/housekeeping/` | Workspace cleanup routines                                                                                                                                                                               |
| `src/telemetry/`    | Usage-log reporting                                                                                                                                                                                      |
| `src/logger/`       | Channel-keyed logging primitives                                                                                                                                                                         |
| `src/eventBus/`     | `AppSignals` **only** — process-scoped app-lifecycle signals (auth, subscriptions, tool availability). Not run or session progress                                                                       |
| `src/hosts/`        | UI host descriptors shared across the three hosts                                                                                                                                                        |
| `src/types/`        | Ambient module declarations for untyped third-party packages                                                                                                                                             |
| `src/test-kernel/`  | The test suite. 875 tracked files, ~57% of `src/` by line count — it dominates a directory listing but ships in nothing                                                                                  |

## Two axes that decide where code goes

**Does it import `vscode`?** Some directories here are enforced VS Code-free:
importing `vscode` inside one is a lint error, not a convention. The canonical
list is `VSCODE_FREE_ZONE_DIRS` in [`eslint.config.mjs`](../eslint.config.mjs) — read it there rather
than trusting a copy, including this one. Code in those zones reaches host
services through `platform()` from `@platform/platform`; when it needs a
capability the port does not expose, add a typed port rather than an import.

**Does it run in a webview?** The webview frontends bundle for the browser, so
anything they import must avoid Node built-ins. Exactly five `utils` modules are
reachable from them today — `@utils/core`, `@utils/core/boundedIdSet`,
`@utils/errors/errorMessage`, `@utils/files/pastedImageName`,
`@utils/text/stringUtils`. Adding an import to any of those five, or to their
transitive dependencies, can break a webview build in a way `tsc` will not catch.

## Picking between the general-sounding names

`shared/`, `common/`, and `utils/` are the three placements newcomers get wrong.

- **`shared/`** — two things, both browser-reachable. First, types and schemas
  that cross a process or wire boundary (extension host ↔ webview, main ↔
  renderer, client ↔ backend): if both sides must agree on the shape, it goes
  here. Second, the **shared browser UI kit** — `shared/wa/` (Web Awesome icon
  and component helpers), `shared/styles/`, `shared/litControllers/`,
  `shared/markdown/`, `BaseWebviewApp.ts`. That is runtime UI code, not a
  contract: 26 modules under `shared/` import `lit`. Reusable webview UI belongs
  here, not in a host package.
- **`common/`** — cross-cutting logic with domain meaning that is not a wire
  contract. Error classification is the clearest example.
- **`utils/`** — leaf helpers with no domain knowledge. If it could plausibly be
  an npm package, it belongs here.

When two fit, prefer the one with the tighter constraints. Note that "tighter"
varies within `shared/` itself: `shared/settingsView/handlers/` is guarded by
`SharedSettingsViewBoundary.vitest.ts` against importing `@controllers/`,
`@agent/`, `@model/`, `@tools/` or `@auth/`, while `shared/wa/` deliberately
depends on Lit. Check for an existing boundary test near your target directory
before assuming either extreme.

**Where this document is not authoritative.** [`AGENTS.md`](../AGENTS.md) is the
canonical statement of conventions; this file is an orientation map for `src/`
and defers to it wherever the two overlap. Facts that live in code — the
VS Code-free zone list, the lint rules, the ratchet baselines — are canonical in
code, and this file points at them rather than restating them.

## Conventions worth knowing before your first change

- **Builds do not type check.** esbuild and Vite strip types without checking
  them. Run `npm run typecheck`, or use the `:safe` script variants.
- **No convenience barrels.** An `index.ts` exists only for a documented public
  surface. Import the file that defines the symbol.
- **Schemas are the source of truth.** Define the Zod schema, derive the type
  with `z.infer`. Tool input schemas use `.nullish()`, not `.optional()`.
- **Silent degradation is a defect.** A fallback that hides a failure must log
  loudly or not exist.

Full conventions and the reasoning behind each: [`AGENTS.md`](../AGENTS.md).
Orientation for agents and a map of the wiring points that fail silently:
[`CLAUDE.md`](../CLAUDE.md).
