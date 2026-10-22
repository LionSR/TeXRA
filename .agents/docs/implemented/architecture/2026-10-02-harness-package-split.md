---
created: 2026-10-02
status: implemented
---

# Splitting the harness from TeXRA: three packages, TeXRA as an example app

The split landed before 1.0 (M1 to M8, the last slice #13778); the deep-import
baseline (M9) is down to a handful of rows. This note records the boundary as it
stands and the rulings behind it. "The durable doc" is
[`2026-10-02-durable-harness.md`](./2026-10-02-durable-harness.md); "the
codemode doc" is
[`2026-10-01-codemode-everywhere.md`](./2026-10-01-codemode-everywhere.md). What
the harness still lacks as a general package (a storage and execution port, a
smaller root entry, a `./host` subpath) is planned in the
[harness general-package design](../../proposed/architecture/2026-10-21-harness-general-package-design.md).

**Owner rulings, 2026-10-02.** (1) "Ledger" is renamed "history" everywhere:
`RunLedger` became `RunHistory` (§6, #13653). (2) Model access (the catalog,
providers, routing and sign-in) lives in `@texra-ai/llm`. `llm` reads no TeXRA
setting and imports nothing in the repo; configuration and credentials are
inputs (§1). Its entry points are designed from TeXRA's own consumers, not
copied from a peer's.

## 1. The three packages

| Package             | Path               | Owns                                                                                                                                                                                                              |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/harness` | `packages/harness` | The run's history, the loop, sessions and storage, the Registry and Step, the ports, the binding of a run's model choice to settings, trust, MCP and data plugins, the built-in plugins, the transcript row model |
| `@texra-ai/llm`     | `packages/llm`     | Model access: the turn contract, the model catalog and routing, providers, the wire protocols behind one binder, subscription sign-in. Settings and credentials arrive as inputs                                  |
| `@texra-ai/texra`   | `packages/texra`   | The app plugins, the documents plugin, LaTeX, the UI kit, the app's settings rows, the host-side controllers, telemetry. Private: it is not published                                                             |

The three hosts (`packages/cli`, `packages/desktop`, `packages/extension`) and
`packages/trace-viewer` stay separate packages. They are TeXRA products built
over the harness and the app. Dependencies point one way: app → harness → llm,
and `llm` depends on nothing in the repo.

The agent YAMLs, skills and plugin resources stay in
`packages/extension/resources/` as app data; the desktop and the CLI copy them
from there.

### Where the UI toolkit goes

The transcript row model is part of the session view, so it lives in the harness
at `packages/harness/src/shared/transcript/` (`@shared/transcript`), published
to renderers as `@texra-ai/harness/transcript`. The kit, styles, markdown and
KaTeX, and the copy tables are app code in `packages/texra/src/ui/` (`@ui/*`).
App-specific presentation (the Codex cards, the `latexdiff` row) is app code
over the row model.

### Model access goes to `@texra-ai/llm` (ruling 2)

The provider catalog, routing facts (`RouteFacts`, `decideModelRoute`), the wire
protocols and the ChatGPT and Grok sign-in flows live in
`packages/llm/src/{models,providers,api,oauth}`. `llm` defines one port,
`CredentialStore` (`providers/credentials.ts`), which the harness serves from
`Secrets`. HTTP is Effect's own `HttpClient`.

What stays in the harness is the binding of a run's model choice to the
session's settings: `packages/harness/src/model/` (model options, Copilot
routing, the reasoning level, subscription access, `runModelDecision`) and
`agent/runtime/modelAccess/`, which reads settings into `RouteFacts` and calls
`bindModel`. The setup-time model and credential helpers are app code
(`packages/texra/src/model/`).

### The `llm` entry points

A package is split by where its code runs, not by topic, following the harness's
own convention.

| `@texra-ai/llm` entry | Contents                                                                                                                                                                                         | Runs in      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `.`                   | `Model`, the turn types and schemas, the model catalog over `llm-zoo` and the provider data, `RouteFacts`, `decideModelRoute`, the reasoning choice, the `CredentialStore` port type, the errors | browser-safe |
| `./node`              | `bindModel`, the ChatGPT and Grok sign-in flows, their coordinators and session schemas, `SharedAttempt`                                                                                         | Node         |

The protocols are internal modules under `packages/llm/src/api/`, with the
prefix fingerprint and the upload cache; nothing exports them. `bindModel`
chooses the protocol and loads its module with a literal `import()`, so a run
loads only its provider's SDK, and esbuild bundles each import in every host.

**What keeps `.` browser-safe.** An ESLint block on `packages/llm/src/**`
outside `api/`, `oauth/` and `node.ts` forbids Node built-ins and the vendor
SDKs, with no baseline, beside the zone that forbids `llm` any import from the
rest of the repo. The harness's `validate-artifacts.mjs` fails any published
entry whose declaration graph imports `@anthropic-ai/sdk`, `@google/genai`,
`@openrouter/sdk` or `openai`. The renderer has no `@types/node`, so a Node type
that reaches `.` shows up as a `process` or `NodeJS` error in its typecheck; the
fix is at the import, never a Node type in the renderer.

## 2. The harness public API

| Subpath        | Contents                                                                                                          | Runs in      |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| `.`            | `Sessions`, `Session`, `Run`, `defineTool`, the errors, the port types                                            | any          |
| `./plugins`    | The built-in plugin values of §3, `harnessBuiltins`, `definePlugin` and the plugin-authoring types                | any          |
| `./schemas`    | Agent config and run-end schemas, the row and view schemas                                                        | browser-safe |
| `./transcript` | The row model and its projections, for renderers                                                                  | browser-safe |
| `./node`       | `nodePlatform` and the Node blocks it is made of: workspace roots, the SQLite stores, the file system and spawner | Node         |

`./schemas` and `./transcript` exist because the webview frontends cannot load
`.`. A `./testing` subpath waits for a named external consumer. There is no
Promise API (rulings ledger, "The agent SDK's public surface is Effect",
2026-09-21; the owner ruled `./promise` "not now" on 2026-10-06).

A host composes the process with `Sessions.layer({ platform, plugins })`: the
platform carries the ports, and the plugin list is TeXRA's `texraPlugins()`, or
`harnessBuiltins` for an embedder. A `Plugin` (`tools/plugins.ts`) carries its
tools, availability probe, switch, injected tools, continuation, prompt section,
process and session layers, request-decision hook, `plugin.fact` arms and
agent-file block. How an app shows a plugin (its card, setup guide and settings
rows) is the app's own record keyed by the plugin's id. `definePlugin` checks at
compile time that every tool needs only harness services and what the plugin's
own layers serve. Where the app changes a built-in, the built-in takes options:
`fileOps({ writeFilter })` carries TeXRA's `.tex` replacement in `write_file`.

Not built: `Plugins.contribute` (live contribution in a `Scope`) and a per-run
execution environment; the general-package design plans the latter as its
Execution port.

## 3. Built-in plugins and app plugins

| Plugin (id)                                          | Tools                                                            | Lives in                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `file-ops`                                           | `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`   | harness                            |
| `web`                                                | `web_search`, `web_fetch`                                        | harness                            |
| `memory-workflow`                                    | `memory`, `executions`                                           | harness                            |
| `goal`                                               | `plan`, the continuation, the `goal/state` arm                   | harness                            |
| `multi-agent`                                        | `agent`                                                          | harness                            |
| `codemode`                                           | `script`                                                         | harness                            |
| MCP servers, installed Claude Code and Codex plugins | from data                                                        | harness                            |
| `core`                                               | `inline_comment`, `open_pdf`, `ask_user_question`, `lean_loogle` | app                                |
| `documents`                                          | `accept_run_files`, `document_task` and the typed document tools | app                                |
| `latex-extract`, `latex-diagnostics`                 | extraction, diagnostics                                          | app                                |
| `arxiv`, `zotero`                                    | papers and citations                                             | app                                |
| `lean4`, `wolfram`                                   | the Lean language server; Wolfram                                | app                                |
| `setup`                                              | the onboarding set                                               | app                                |
| `codex`, `claude-agent`                              | `codex`, `claude_code`                                           | app                                |
| `github-pr-subscription`                             | `github_subscription`                                            | app                                |
| `external-inquiry`                                   | `inquiry`                                                        | app                                |
| `copilot`                                            | from the host                                                    | app, with the VS Code host's layer |

`codex`, `claude-agent`, `github-pr-subscription` and `external-inquiry` are app
plugins (ruling SQ4), so the harness ships nothing that needs a vendor SDK or a
background service. Any of them moves to the harness when a second app needs it.

## 4. Proving TeXRA is just an example

**The ratchets.** The harness imports nothing from the app:
`HARNESS_NO_APP_IMPORT_PATTERNS` in `eslint.config.mjs` forbids every app alias
and any relative path into `packages/texra`, with no baseline. App and host
files reach the harness only through its package name and subpaths:
`config/ratchets/harness-deep-import-baseline.json`, checked by
`harnessDeepImportRatchet.vitest.ts`, holds each package's set of distinct
harness-internal specifiers and only shrinks (ruling SQ2).

**The plugin list is the app's.** `packages/texra/src/tools/registry.ts` defines
`texraPlugins()`, a list of `definePlugin` values; nothing in the harness names
an app plugin. Each host passes it to `Sessions.layer`, and an embedder passes
`harnessBuiltins`. Lists stay TypeScript values, with no YAML profiles or patch
layers.

**One case pins each roster.** `pluginBoundaryRatchet.vitest.ts` (`test:pure`)
pins, for TeXRA's list and for `harnessBuiltins`, the plugin ids in order and
the tools each offers, and the row kinds plugins write. A plugin or tool that
joins or leaves a list is a reviewed change there.

**Settings by owner.** A setting row is declared by its owner: the harness's
rows in `packages/harness/src/shared/state/stateSettings.ts`, the app's in
`packages/texra/src/shared/settingsView/texraSettings.ts` (with `TexraStateKey`)
and the plugin settings modules it lists. The catalog is their concatenation,
and the settings view and `texra config` read it. Key strings stay `texra.*`, so
there was no migration.

**App rows are plugin arms (ruling SQ3).** The harness's row union folds no app
kind. The documents plugin's outputs are the `documents/output` arm and the
inquiry thread is the `external-inquiry/thread` arm, both `plugin.fact` rows;
the retired `output.produced` and `inquiryThreadUpdated` are in
`RETIRED_ROW_KINDS`. A plugin owns an aggregate of kind `plugin`, and
`plugin.fact` carries a nullable `parent` run edge that `referencedAggregates`
reads. An arm may declare an `admits` transition check, which the store runs in
the writing transaction against the aggregate's latest row of the kind.

## 5. Hosts

The CLI, the desktop app and the extension are TeXRA products, and nothing in
them moves into the harness. The Ink TUI kit stays in `packages/cli`.

- **Host runtime layer.** A host differs from the SDK only in its platform and
  its plugin list; app services are the owning plugins' layers, or the host's
  (the extension's Lean, inline-comment and Copilot providers).
- **Host-side session controllers are app code** (ruling SQ6):
  `packages/texra/src/controllers/session/` (`hostRunActions`,
  `hostDraftRequests`, `hostSnapshotSource`, `sharedHostRequests`,
  `SessionBridge`, `attachSessionHost`, `webviewSessionLayer`, …) serves TeXRA's
  three hosts, and there is no `./host` subpath. A generic action reaches the
  harness as a `RuntimeRequest` arm.

## 6. Storage and the freeze

Every row kind in the harness's `SessionEvent` union is the harness's. Plugin
state is `plugin.fact` arms, each versioned with its own upcasters on the
plugin's `PluginArm`, so a plugin evolves its arms without a harness row
version. Plugin ids appear in stored rows (`tools.offered`, `plugin.fact`), so
an id change is a stored-shape change.

The row split (M6) gated the freeze (ruling SQ5); the package move changed no
stored shape.

### The run's history (ruling 1)

Bare "history" is the core-concepts History, the session's rows; the run's
history is one run aggregate's slice of it, always qualified (`RunHistory`,
`runHistory`), never a bare `History` identifier, and `History.writer` stays
unbuilt. `SessionHandle.runHistory` sits beside `history: HistoryQuery` (the
`executions` tool's SQL over the session's display rows). `input_history`
(prompt recall) and `texra history` (stored runs) keep their names. Two other
ledgers keep theirs: the architecture rulings ledger and the Lean plugin's
`tactic-ledger`.

## 7. Rules from the migration

- **No shims.** No step left a shim, a re-export or a forwarding module; a moved
  symbol's importers were rewritten in the same PR.
- **Path aliases.** The alias names stayed across the move. `tsconfig.json` maps
  the harness's aliases (`@agent/*`, `@shared/*`, `@tools/*`, `@controllers/*`,
  `@common/*`, `@utils/*`, `@platform/*`, `@model/*`, `@skills/*`,
  `@transcript/*`, `@logger/*`, `@eventBus/*`) into `packages/harness/src`;
  `scripts/aliases.mjs` derives the build aliases. App files that left a mixed
  directory take `@texra/*`, and `@latex/*`, `@replacement/*`, `@telemetry/*`,
  `@housekeeping/*` and `@ui/*` point into `packages/texra/src`. A subsystem
  keeps its name on either side (`packages/harness/src/tools/x` and
  `packages/texra/src/tools/y` are both `tools`), so path-keyed baselines are
  keyed the same.
- **Ratchets only shrink.** The move re-keyed `architecture-edges`, `file-size`,
  `knip` and the Effect allowlists by path with the same counts; the deep-import
  ratchet replaced the narrower host-agent import baseline. The `Effect.run*`
  door names the hosts and the harness's SDK entries; `packages/texra` is a
  library and gets no door.
- `VSCODE_FREE_ZONE_DIRS` and `dependencyDirection.vitest.ts` are re-keyed
  together.

## 8. Owner rulings

SQ1 was confirmed by the owner; SQ2 to SQ6 were ruled as recommended on
2026-10-03.

1. **SQ1, names and paths.** `@texra-ai/harness` at `packages/harness`,
   `@texra-ai/llm`, and the app `@texra-ai/texra` at `packages/texra` (the
   owner: "why not just texra?"; the workspace name `texra` is the VS Code
   extension's). The theorist is the first bundle inside the app, not the whole
   app.
2. **SQ2.** The deep-import ratchet starts from the measured set and only
   shrinks, rather than making public every internal module an app or host file
   reaches; shrinking goes through `Session.request` arms and public exports.
3. **SQ3.** App rows become plugin arms before the freeze: two kinds removed,
   none added, and the harness folds no app state.
4. **SQ4.** `codex`, `claude-agent`, `github-pr-subscription` and
   `external-inquiry` go to the app; any of them moves when a second app needs
   it.
5. **SQ5.** The row split (M6) gates the freeze, and the move lands right after;
   the move changes no stored byte.
6. **SQ6.** The host-side session controllers go to the app, with no `./host`
   subpath; each generic action becomes a `RuntimeRequest` arm. (The
   general-package design argues for a `./host` subpath as an owner question.)

## Verified

- Re-read on `main` at `485fbf2b6a` (2026-10-22): the `exports` of the three
  `package.json` files; `packages/llm/src/{index,node}.ts`;
  `packages/harness/src/plugins.ts`, `tools/builtinPlugins.ts` and
  `tools/plugins.ts`; `packages/texra/src/tools/registry.ts`; the rosters in
  `pluginBoundaryRatchet.vitest.ts`; `HARNESS_NO_APP_IMPORT_PATTERNS` and the
  `llm` zones in `eslint.config.mjs`;
  `config/ratchets/harness-deep-import-baseline.json`; `RETIRED_ROW_KINDS` in
  `rowVersions.ts`; the `plugin.fact` and aggregate schemas in
  `sessionEvent.ts`; the settings owners.
- Not run: any build, typecheck or test.
