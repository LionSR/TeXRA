# Source map

Where code lives across the workspace packages. Conventions, the package
layers and the boundary rules are in the root [`AGENTS.md`](../AGENTS.md)
("Layout"); this file is the directory map. Facts that live in code (the
VS Code-free zone list, lint rules, ratchet baselines) are canonical there, not
here.

Repo-root `src/` holds only `src/test-kernel/`, the test suite. It may import
or mock extension, desktop and CLI surfaces, and ships in nothing.

## The harness: `packages/harness/src` (`@texra-ai/harness`)

| Directory      | What it is                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/`       | The agent domain model (`core/`), the run loop and run services (`runtime/`), prompts, traces, storage. Start with [`agent/core/README.md`](../packages/harness/src/agent/core/README.md) |
| `effect/`      | The SDK boundary: `processLayer`, `Sessions` and the typed session reads hosts hold                                                                                                       |
| `controllers/` | The session layer the hosts and the app call into instead of driving `agent/` directly                                                                                                    |
| `tools/`       | The tool engine and built-in plugins (bash and file tools, web, memory, goal, multi-agent, codemode, MCP)                                                                                 |
| `shared/`      | Wire contracts and message types (Effect schemas) and the host-neutral logic over them, including the transcript row model (`shared/transcript/`)                                         |
| `platform/`    | Host port contracts (config, state, lifecycle, agent directories, secrets, rooted fs, workspace roots)                                                                                    |
| `model/`       | Binding a run's model choice to the session's settings: route facts, picker options, reasoning levels. The catalog, routes and sign-in are `packages/llm`                                 |
| `common/`      | Cross-cutting logic that is not a wire contract, notably `common/errors/`                                                                                                                 |
| `utils/`       | Host-agnostic leaf helpers; not browser-safe unless in a browser entry's closure                                                                                                          |
| `transcript/`  | Trace and transcript document schemas and stream logging                                                                                                                                  |
| `skills/`      | Skill schema and loading                                                                                                                                                                  |
| `logger/`      | Channel-keyed logging                                                                                                                                                                     |
| `eventBus/`    | `AppSignals` only: process-scoped app signals (credentials, GitHub token and subscriptions, workspace agents and files, approval policy)                                                  |
| `types/`       | Ambient declarations for untyped third-party packages                                                                                                                                     |

## The app: `packages/texra/src` (`@texra-ai/texra`)

| Directory       | What it is                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/`        | TeXRA's plugins: LaTeX, papers, Lean, setup, documents, codex, claude-agent, GitHub subscriptions, external inquiry; `registry.ts` lists them     |
| `agent/`        | The document-task recipe and output (`output/`), agent templates, export                                                                          |
| `controllers/`  | Main, progress and settings views, model access, onboarding, the service (`server/`), and the host-side session modules (`session/`)              |
| `shared/`       | App wire contracts (`ipc.ts`, settings rows and handlers) plus the Lit controllers, Monaco and highlighting code that stayed outside `ui/`        |
| `ui/`           | The browser UI kit all three hosts render with (`wa/`, `styles/`, `markdown/`, `copy/`); see [`ui/README.md`](../packages/texra/src/ui/README.md) |
| `latex/`        | LaTeX compilation, diffing, formatting and log parsing; see [`latex/README.md`](../packages/texra/src/latex/README.md)                            |
| `replacement/`  | Text replacement for editing tools                                                                                                                |
| `model/`        | Model options, provider presentation, setup credentials and defaults                                                                              |
| `common/`       | The app's file rules (`files/`), secrets helpers, terminal output                                                                                 |
| `platform/`     | Node defaults for host services (`defaults/`)                                                                                                     |
| `utils/`        | App leaf helpers (files, git, text, system, diagnostics)                                                                                          |
| `hosts/`        | UI host descriptors shared by the three hosts                                                                                                     |
| `housekeeping/` | Workspace cleanup                                                                                                                                 |
| `telemetry/`    | Usage-log reporting                                                                                                                               |
| `types/`        | Ambient declarations                                                                                                                              |

`packages/llm/src` (`@texra-ai/llm`) is model access. The hosts are
`packages/extension`, `packages/desktop` and `packages/cli`.

## Picking between the general-sounding names

- **`shared/`**: shapes both sides of a process or wire boundary must agree on
  (extension host ↔ webview, main ↔ renderer, client ↔ backend), with the
  host-neutral logic that reads them.
- **`ui/`**: runtime browser UI that imports `lit`. Reusable webview UI goes
  here, not in a host package or `shared/`.
- **`common/`**: cross-cutting logic with domain meaning that is not a wire
  contract, such as error classification.
- **`utils/`**: leaf helpers with no domain knowledge; if it could be an npm
  package, it goes here.

When two fit, take the one with tighter constraints, and look for a boundary
test near the target first: `shared/settingsView/handlers/` is guarded by
`SharedSettingsViewBoundary.vitest.ts` against `@controllers/`, `@agent/`,
`@model/` and `@tools/`, while `ui/wa/` deliberately depends on Lit.
