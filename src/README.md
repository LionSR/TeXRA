# The source map: the harness, the app, and the test suite

TeXRA's production code lives in three workspace packages (split design
`.agents/docs/proposed/architecture/2026-10-02-harness-package-split.md`):

- `packages/harness/src` (`@texra-ai/harness`): the Effect-only agent
  harness: the run loop and its history, sessions and storage, the plugin
  registry and the built-in plugins, the ports. It imports nothing from the
  app (an ESLint zone, with a shrink-only list of residents).
- `packages/texra/src` (`@texra-ai/texra`): the app, TeXRA itself: its
  plugins, LaTeX, the UI kit, the settings rows and the host-side
  controllers.
- `packages/llm/src` (`@texra-ai/llm`): model access.

The VS Code extension (`packages/extension`), the Electron desktop app
(`packages/desktop`) and the terminal CLI (`packages/cli`) are hosts over
them. Repo-root `src/` holds only `src/test-kernel/`, which centralizes tests
for shared and host-specific behavior; suites may import or mock extension,
desktop, and CLI surfaces.

Code reaches a module through the path aliases declared in
[`tsconfig.json`](../tsconfig.json) (`@agent/*`, `@platform/*`, `@shared/*`,
…; an app file that left a mixed directory takes `@texra/*`). Use the alias,
not a long relative chain.

## Subsystems

| Directory                           | What it is                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/src/agent/`       | The agent domain model, the run loop, and provider abstraction. Largest subsystem; has its own READMEs — start with [`agent/core/README.md`](../packages/harness/src/agent/core/README.md)                                                     |
| `packages/harness/src/tools/`       | The tool engine and the built-in plugins (bash and the file tools, web, memory, goal, multi-agent, codemode, MCP)                                                                                                                              |
| `packages/harness/src/shared/`      | Wire contracts and message types (Zod schemas) plus the host-neutral logic over them, including the transcript row model (`shared/transcript/`)                                                                                                |
| `packages/harness/src/controllers/` | The session layer the hosts and the app call into instead of driving `agent/` directly                                                                                                                                                         |
| `packages/harness/src/utils/`       | Host-agnostic helpers. A fixed set is additionally browser-safe (see below)                                                                                                                                                                    |
| `packages/harness/src/common/`      | Cross-cutting helpers that are not wire contracts — notably `common/errors/` error classification                                                                                                                                              |
| `packages/harness/src/platform/`    | Host port contracts (config, state, lifecycle, agent directories, secrets, rooted fs, workspace roots) served by `installProcessRuntime`                                                                                                       |
| `packages/harness/src/model/`       | The binding of a run's model choice to the session's settings: route facts, the picker's options, Copilot routing, reasoning levels, subscription preferences. The catalog, routes, providers and sign-in are `@texra-ai/llm` (`packages/llm`) |
| `packages/harness/src/transcript/`  | Trace and transcript document schemas plus stream logging                                                                                                                                                                                      |
| `packages/harness/src/skills/`      | Skill schema and loading                                                                                                                                                                                                                       |
| `packages/harness/src/logger/`      | Channel-keyed logging primitives                                                                                                                                                                                                               |
| `packages/harness/src/eventBus/`    | `AppSignals` **only** — process-scoped app-lifecycle signals (auth, subscriptions, tool availability). Not run or session progress                                                                                                             |
| `packages/harness/src/types/`       | Ambient module declarations for untyped third-party packages                                                                                                                                                                                   |
| `packages/texra/src/tools/`         | The app's plugins: LaTeX, papers, Lean, setup, the documents plugin, codex, claude-agent, GitHub subscriptions, external inquiry; `registry.ts` is TeXRA's plugin list                                                                         |
| `packages/texra/src/controllers/`   | The app's controllers: main view, progress view, settings view, model access, onboarding, the service (`server/`) and the host-side session modules                                                                                            |
| `packages/texra/src/ui/`            | The shared browser UI kit (`wa/`, `styles/`, `markdown/`, `copy/`) all three hosts render with. Lit and Web Awesome live here, not in a host package                                                                                           |
| `packages/texra/src/latex/`         | LaTeX compilation, diffing, formatting, and log parsing                                                                                                                                                                                        |
| `packages/texra/src/replacement/`   | Text-replacement utilities used by editing tools                                                                                                                                                                                               |
| `packages/texra/src/housekeeping/`  | Workspace cleanup routines                                                                                                                                                                                                                     |
| `packages/texra/src/hosts/`         | UI host descriptors shared across the three hosts                                                                                                                                                                                              |
| `packages/texra/src/telemetry/`     | Usage-log reporting                                                                                                                                                                                                                            |
| `src/test-kernel/`                  | The test suite. It dominates a directory listing but ships in nothing                                                                                                                                                                          |

## Two axes that decide where code goes

**Does it import `vscode`?** Some directories here are enforced VS Code-free:
importing `vscode` inside one is a lint error, not a convention. The canonical
list is `VSCODE_FREE_ZONE_DIRS` in [`eslint.config.mjs`](../eslint.config.mjs) — read it there rather
than trusting a copy, including this one. Code in those zones reaches host
services through the Effect context the process runtime serves; when it
needs a capability no port exposes, add a typed port rather than an import.

**Does it run in a webview?** The webview frontends bundle for the browser, so
anything they import must avoid Node built-ins. Only a small, fixed set of
`utils` modules is reachable from them — the `BROWSER_SAFE_UTILS` allowlist in
`eslint.config.mjs`, which ESLint enforces. Adding an import to
any of them, or to their transitive dependencies, can break a webview build in a
way `tsc` will not catch.

## Picking between the general-sounding names

`shared/`, `ui/`, `common/`, and `utils/` are the placements newcomers get
wrong.

- **`shared/`** — types and schemas that cross a process or wire boundary
  (extension host ↔ webview, main ↔ renderer, client ↔ backend): if both sides
  must agree on the shape, it goes here, together with the host-neutral logic
  that folds and reads them.
- **`ui/`** — the **shared browser UI kit** (in the app): `ui/wa/` (Web
  Awesome icon and component helpers), `ui/styles/`, `ui/markdown/` and
  `ui/copy/` (user-facing strings). That is runtime
  UI code, not a contract — it imports `lit`. Reusable webview UI belongs here,
  not in a host package and not under `shared/`.
- **`common/`** — cross-cutting logic with domain meaning that is not a wire
  contract. Error classification is the clearest example.
- **`utils/`** — leaf helpers with no domain knowledge. If it could plausibly be
  an npm package, it belongs here.

When two fit, prefer the one with the tighter constraints. Note that "tighter"
varies by directory: `shared/settingsView/handlers/` is guarded by
`SharedSettingsViewBoundary.vitest.ts` against importing `@controllers/`,
`@agent/`, `@model/` or `@tools/`, while `ui/wa/` deliberately
depends on Lit. Check for an existing boundary test near your target directory
before assuming either extreme.

**Where this document is not authoritative.** [`AGENTS.md`](../AGENTS.md) is the
canonical statement of conventions; this file is an orientation map for the source tree
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
