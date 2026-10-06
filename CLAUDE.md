# CLAUDE.md

TeXRA is an AI theorist that helps academics with writing, research, and
document processing using LLMs. It ships as a VS Code extension, an Electron
desktop app, and a terminal CLI (`texra`) — three hosts over one host-agnostic
core.

Coding conventions and full patterns live in [AGENTS.md](./AGENTS.md). This file
covers what you can't learn by reading the tree.

## Commands

```bash
corepack pnpm install
npm run compile:fast      # build (esbuild + Vite); watch:fast, package:fast
npm run typecheck         # builds do NOT type check — see below
npm test                  # Vitest — the full gate, minutes long
npm run test:changed      # vitest --changed: suites reachable from uncommitted edits
npm run test:pure         # the shared-registry tier (~30s), architecture ratchets included
npm run test:watch        # the dev loop: reruns what a save reaches
npm run lint
npm run format
npm run gate            # the static CI jobs as one command: invariants, typecheck + format, lint
npm run check:dead-code-ratchet
```

**The full suite is not the commit-loop gate.** It is minutes of wall time, so
in front of every local commit it gets skipped. The loop is stock Vitest:
`test:watch` while editing, `test:changed` before a commit, `test:pure` before
a push — 30s, and it covers the architecture ratchets, which no module graph
ties to the code they scan. `npm test` before opening a PR. Tiers and why a
suite lands in one: AGENTS.md "Test tiers".

**Builds don't type check.** esbuild and Vite only strip TypeScript types; they
treat it as "JavaScript with annotations to remove." Run `npm run typecheck`, or
use the `:safe` variants (`compile:safe`, `package:safe`, `build:safe`) that
type check first. This is the single most common way a change lands broken.

## Layout

A pnpm workspace in three layers (split design
`.agents/docs/proposed/architecture/2026-10-02-harness-package-split.md`):
`packages/harness/src` (`@texra-ai/harness`) is the Effect-only harness;
`packages/texra/src` (`@texra-ai/texra`) is the app: TeXRA's plugins, LaTeX,
the UI kit and the host-side controllers; `packages/llm` is model access.
`packages/extension`, `packages/desktop`, `packages/cli`, and
`packages/trace-viewer` are hosts and apps over them. Repo-root `src/` holds
only the centralized test suite (`src/test-kernel/`); `src/README.md` maps
the tree. Path aliases (`@agent/*`, `@platform/*`, …) are declared in
`tsconfig.json` — use them instead of long relative chains. Harness aliases
point into `packages/harness/src`; app files that left a mixed directory
take `@texra/*` (`@texra/tools/arxiv/…`), and `@latex/*`, `@replacement/*`,
`@telemetry/*`, `@housekeeping/*` and `@ui/*` point into the app. The harness
imports nothing from the app (`HARNESS_NO_APP_IMPORT_PATTERNS` in
`eslint.config.mjs`, with a shrink-only list of residents). Inside
`packages/harness/src` (an ESM package) a relative import names its `.js`
file.

Things the tree won't tell you:

- **The SDK surface is `packages/harness` (`@texra-ai/harness`) — built, fenced, not
  published.** There is no `@texra/core` package (deleted by #7099). Hosts still
  reach the harness through the path aliases, but that surface is
  **frozen, not open**: `eslint.config.mjs` forbids `packages/harness/src/**`,
  `packages/texra/src/**` and `packages/llm/src/**` from importing host layers, and the ratchets in
  `config/ratchets/` freeze the remaining edges — `harness-deep-import-baseline`
  (no NEW distinct harness-internal specifier, `@agent/*`, `@shared/*`,
  `@platform/*` …, from the app or a host, type-only included; reach the
  harness through `@texra-ai/harness` instead), `core-quality/core-module-mocks`,
  `architecture-edges`, plus `refuted-candidates` (the costed-and-refused
  refactors, with their ruling anchors). ESLint's `no-restricted-syntax` fails
  an `Effect.run*` call outside `packages/{extension,desktop,cli}/src/` and the
  SDK entry files (`packages/harness/src/{index,node,plugins,schemas}.ts`,
  `packages/harness/src/effect/`)
  (webview frontends excluded) or a named runtime entry carved out in
  `eslint.config.mjs` (whole-file; the receiver is checked in review), as does
  `new AbortController()` outside its two ledger residents, and `no-warning-comments` fails on any `@adapter-until`
  marker, since the owner ruled there are no temporary adapters. AGENTS.md
  "Directory organization"
  has the rules. The invariant to hold is "never widen a
  baseline"; the open work is the Tier-1 public manifest and shrinking the
  frozen lists, not
  another lint rule. npm publication is deliberately held until a named external
  consumer exists. Kernel architecture tests under
  `src/test-kernel/architecture/` (including
  `approvalPolicyAuthorityRatchet.vitest.ts`, and
  `sharedSchemasDeepImportRatchet.vitest.ts`, which forbids every
  `@shared/schemas/<leaf>` import outright, and
  `unknownErrorChannelRatchet.vitest.ts`, which forbids an
  `Effect.Effect`/`Effect.fn.Return` error channel spelled `unknown` — type it
  with the tagged error the path raises, `Error` at a host port, and
  `ensureError` at a foreign boundary) also pin single-authority invariants
  with hardcoded rules rather than baseline JSON.
- **`packages/harness/src/utils/` is host-agnostic, not universally browser-safe.** Only the
  `BROWSER_SAFE_UTILS` allowlist in `eslint.config.mjs` (`@utils/core`,
  `@utils/errors/errorMessage`,
  `@utils/files/pastedImageName`, `@utils/text/stringUtils`) is
  browser-reachable: ESLint lets the webview frontends import only those at
  runtime, and holds those to no Node built-ins and runtime imports of each
  other only. The rest of `packages/harness/src/utils/` must not be assumed browser-safe.
  Side-specific helpers still belong in `frontend/` or `common/`.
- **`packages/harness/src/eventBus/` is `AppSignals` only** — cross-cutting app-lifecycle signals
  (auth, subscriptions, credentials, workspace-file writes). It is _not_
  run or session progress; those live in `@agent/trace` and `SessionEvents`
  (`packages/harness/src/agent/runtime/`).
- **`packages/harness/src/common/webview/` does not exist.** Webview base classes are in
  `packages/extension/src/common/webview/`. <!-- guidance-refs-ignore -->
- **No convenience barrels.** A barrel exists only for a documented public
  surface. Import the file that defines the symbol.
- **`packages/texra/src/ui/` is the host-neutral UI toolkit** (`@ui/*`): the Web Awesome and
  Lit building blocks (`wa/`), the shared `css` tag blocks (`styles/`), the
  markdown/KaTeX pipeline (`markdown/`) and the user-facing copy tables
  (`copy/`). All three hosts render from it. It is app code, a VS Code-free
  zone, and takes no `@agent/*` imports. The transcript row model is part of
  the harness's session view and lives in `packages/harness/src/shared/transcript/`
  (`@shared/transcript`); do not confuse it with `packages/harness/src/transcript/`
  (`@transcript`), the run-transcript persistence layer.
  **`packages/texra/src/shared/{litControllers,monaco,highlighting}/`
  never moved into the kit** — Lit reactive controllers, a Monaco bootstrap, and a
  highlight.js wrapper. Consumers are webview/renderer UI code, plus one
  main-process diff-labeling caller (`packages/desktop/src/main/desktopDiffHost.ts`)
  and the UI toolkit's own markdown pipeline (`packages/texra/src/ui/markdown/katexHtmlProcessor.ts`);
  none is a wire-contract reader. The three were shelved along with a broader,
  separately proposed regroup of six `packages/harness/src/shared/` subtrees under `packages/harness/src/shared/ui/`
  that was rejected on cost (235 import statements plus 9 hardcoded literal test
  paths for that six-directory regroup, not for these three alone) — not because
  the code belongs with wire contracts. Treat them as the UI toolkit's territory:
  don't duplicate a controller or a highlighter in `@ui` without checking
  here first, and don't read their location as license to add more rendering
  code under a `shared/` directory.

Two wiring points fail silently if you forget them: a new VS Code command must
be registered through `packages/extension/src/commands.ts`, and a new setting
must be declared in the Zod catalog by its owner (the harness's rows in
`packages/harness/src/shared/state/stateSettings.ts`, schemas in `packages/harness/src/shared/schemas/coreSettings.ts`;
TeXRA's rows in `packages/texra/src/shared/settingsView/texraSettings.ts`, a plugin's rows on
its `Plugin` value's `settings`) and the native TeXRA settings view —
`packages/extension/package.json` must NOT contribute `configuration`;
`scripts/sync-package-contributes.mjs` throws if it does.

## Separation of concerns: VS Code coupling

Core logic must not import `vscode`. This is the highest-signal rule in the
repo and the first thing to check on any diff.

**VS Code-free zones** — must NOT import `vscode`:
the whole harness (`packages/harness/src/`), the whole app
(`packages/texra/src/`), `packages/llm/src/`,
`packages/desktop/src/`, and the webview
frontends — `packages/extension/src/progressView/frontend/` and
`packages/extension/src/settingsView/frontend/`. Do not confuse
the harness's `common/` and `utils/` (host-neutral, enforced VS
Code-free) with `packages/extension/src/common/` below (extension-only,
VS Code-allowed), or `packages/extension/src/frontend/` (no view-name
segment, the top-level extension-host frontend, VS Code-allowed) with the
VS Code-free webview frontends above. This list is enforced by
`VSCODE_FREE_ZONE_DIRS` in `eslint.config.mjs` and mirrored in
`src/test-kernel/architecture/dependencyDirection.vitest.ts` — keep both in
sync with this list and with each other.

**VS Code-allowed zones** — platform wiring belongs here:
`packages/extension/src/extension.ts` (calls `installProcessRuntime()` exactly once),
`packages/extension/src/commands/`, `packages/extension/src/frontend/`,
`packages/extension/src/common/`, and `packages/harness/src/platform/` interface definitions.
Within `packages/harness/src/utils/`, a browser-reachable module additionally
stays free of Node built-ins — see the browser-safe note above; that is a
stricter constraint layered on top of the VS Code-free rule, not a
substitute for it.

Reach process services from the Effect context the process runtime serves
(`AgentDirectories`, `AppState`, `Secrets`, `FileSystem`, …; the
composition roots install it once through `installProcessRuntime`) and
per-workspace ones from the `WorkspaceRoots` the caller holds. When agnostic
code needs a host-only capability, add a typed port served by that runtime
rather than an import.
Substitutions and the push-UI-to-the-caller rule: AGENTS.md "Platform
decoupling rules".

Also: `packages/harness/src/shared/` is for wire contracts and UI-shared message types, and
`@ui` (`packages/texra/src/ui/`) for the rendering toolkit over them — don't add new `@agent/*`
imports to either; host-neutral orchestration goes in `packages/harness/src/controllers/`.

**Event channels.** New facts a run's trace emits extend `AgentEvent`
(trace) and reach the plane through `runEventDraft`; facts the session itself
authors (lifecycle, status, approvals) extend the `SessionEvent` schema
(`packages/harness/src/shared/schemas/sessionEvent.ts`) and are published as drafts through
`SessionHandle.publish`. Don't add a new `bus.emit` from a
VS Code-free zone and don't add a new subscribe surface. (Ruled in
`.agents/docs/implemented/architecture/2026-06-10-error-pipeline-and-ownership.md`. The tool
emit sites this once grandfathered have since migrated to session-owned
emission via `SessionHandle.publish` / `SessionEvents`, so a new direct
`bus.emit` is a violation, not a grandfathered pattern.) This does not restrict
`emitAppSignal(...)` on the separate `AppSignals` bus within its documented
scope.

**One publisher, loop-owned cards.** Every write to a session's event table
is a job on the `SessionEvents` inbox (`publish`, `exclusive`, `detach`,
`settle`); commit order is enqueue order, and nothing appends around it. A
tool call's card belongs to the run loop. A slow tool's `tool.start` commits
with the row that admits the attempt; a fast tool's card opens and closes in
its settlement batch. On a run with a run history, the card stores no output: its
output is projected at read time from the `tool.result` it commits with.
What a tool prints while it runs is transient text on the card id
(`hooks.onToolOutput` → `stream.chunk`), never a row. Do not add a tool-side
start card, a durable progress row, or a second append path.

## Schemas (Zod v4)

Schemas are the single source of truth: define the schema, derive types with
`z.infer`, compose with `.extend()`/`.pick()`, prefer `z.discriminatedUnion()`
over `z.custom<T>()`. Normalize external input once at the boundary into the
canonical shape; downstream code never branches on format version. There are
no legacy-format readers: AGENTS.md "Compatibility and format retirement".

Two traps worth memorizing:

- **Tool input schemas use `.nullish()`, not `.optional()`.** OpenAI-compatible
  APIs (DeepSeek, Kimi, …) require optional fields to also be nullable for
  structured output. Check for `== null` at use sites, not `=== undefined`.
- **`.prefault()` vs `.default()` vs `.catch()` is not stylistic.**
  `.prefault` substitutes before validation (deserialization), `.default` fills
  a missing field after, `.catch` swallows a validation error. On persisted,
  security, accounting, or lifecycle data, `.catch` turns corruption into a
  silent default — and if that value feeds a later whole-file write, it becomes
  permanent data loss.

Full patterns: AGENTS.md "Zod v4 Schema Patterns".

## Agent system

Core lives in `packages/harness/src/agent/`: `core/` is the host-agnostic domain model (see
`packages/harness/src/agent/core/README.md`); `runtime/loop/` holds the one run program
(`toolUse.ts`), a plain Effect loop over the run history, with
`runtime/run/` the per-run services it
takes from context (`AgentRun`, model binding, pricing, media, tools) and
`runtime/ModelInvoker.ts` the one service that calls the `packages/llm`
`Model`. `core/tools/` holds `toolCallParsing`, which parses a response's
tool calls. `output/` holds the document recipe (`documentRecipe.ts`), the
script a document task's run executes over the documents plugin's tools
(`packages/texra/src/tools/documents/`), and its output pipeline. Provider APIs are reached
only through the `packages/llm` `Model` that `runtime/run/modelBinding.ts`
binds; the `helperModel` path binds through that same route. New agents come
from the built-in `creator` agent or the settings view's "Create from
template". Agents are flat persona YAML (`name`, `description`, `prompt`,
`tools`, `temperature`) in `packages/extension/resources/`; a `task:` block
makes one also launchable as a document task.

**Launch executions via `runAgent`** (`packages/harness/src/agent/runtime/runAgent.ts`) — it
assigns a `runId`, registers the run, and opens workflow output. Use the
lower-level `executeAgent` only when you already own the `runId` (subagent
dispatch). `runAgent` launches fresh runs only: a persisted run resumes
through `resumeRun`, which continues it with
`resumeToolUseFromResumeData`. Loop conventions and the
write points: AGENTS.md "Patterns across the codebase" (Run loop
architecture).

**There is no flow engine.** A run is one Effect program that appends rows to
the run history (`packages/harness/src/shared/session/runHistory.ts`) and continues from the
folded `RunState` each `appendBatch` returns; resume is the same function
reading the same rows. Every wait writes a `run.position`; a response row is
committed before its tools dispatch and a `tool.result` before the loop
continues. Retry has two owners inside `ModelInvoker`: an automatic
route-scoped batch under the process's `ModelRetryGate`, and a durable human
permit (`request.opened` + the snapshot's `pendingRetry`). Do not add a
node, a cursor, a services bag, or a second writer of the run history.

## Design guardrails

- **Modern, scalable, not over-engineered (owner rule).** Use what SQLite
  and Effect already provide instead of a hand-written version of it.
  Choose shapes that keep working as data grows: content addressing, a
  version per record kind, projections rebuilt from history, one owner per
  fact. Then write the fewest lines that do the job, and build nothing for
  a problem we don't have: no speculative layers, knobs or frameworks.
- **Abstraction discipline.** Collapse pass-through layers — nodes create and
  run flows directly in `exec()`; a wrapper that only creates state, runs a
  flow, and interprets results gets inlined; deleted wrappers leave no
  re-export shims. Factories need multiple callers, real logic, class
  construction, or captured context. Grep the caller count before adding a
  shared helper: single-caller extractions are banned.
- **UI anti-patterns.** Never compensate for data-model problems at render time
  (no `Date.now()`, synthetic IDs, or dedup in renderers — fix the upstream
  data). One home per user action; secondary surfaces show read-only status.
- **Silent degradation is a defect.** A fallback that masks a failure must be
  loud — log the cause at `warn` and surface it — or not exist. `catch {}`, a
  `??` over a failed read, a Zod `.catch(default)` on persisted data, and a
  `default: return` that quietly drops an unknown event all turn a bug into
  wrong-but-quiet behavior that nobody reports. Taxonomy and the accepted
  best-effort exceptions: §15 of
  `.claude/skills/code-review/references/review-checklist.md`.
- **Exports are contracts.** A new export needs a consumer in the same PR;
  `npm run check:dead-code-ratchet` enforces it against
  `config/ratchets/knip-baseline.json`.
- **Tests are a budget, not proof of work.** Internal interfaces here break
  often by design, so every test pinned to a churning seam is merge friction,
  not safety. Default for a PR is zero new tests: a behavior-preserving
  refactor adds none, a bug fix gets at most one regression test and only if
  it earns its place, a feature gets E2E coverage ending in a verifiable
  artifact. Never write unit tests after the code; an isolated test starts
  from a written list of failure modes, before the implementation. Extend
  existing suites instead of adding files, and don't demand tests in review
  beyond this bar. Full rules: AGENTS.md "Testing discipline".
- **Serialize async work through Effect** (concurrency primitives, or
  `withPerKeyLane` in `packages/harness/src/utils/core/perKeyQueue.ts` when operations must run
  one at a time per key), never a hand-rolled promise chain; see AGENTS.md
  "Code quality rules".

Full rationale and the evidence behind each: AGENTS.md "Design and
refactoring" and "Code quality rules".

## Docs

`docs/guide/` and a few root docs are published on the texra.ai VitePress site;
internal directories (`architecture/`, `design/`, `dev/`, `supabase/`, …) are
excluded by `docs/.vitepress/publicDocs.js`. The former PRD and proposal
trees now live under `.agents/docs/` (outside the VitePress root) — see
`.agents/docs/README.md` for the lifecycle/class layout.

**A doc landing at the `docs/` root can silently freeze the texra.ai deploy** if
it trips the publish allowlist. Check `docs/.vitepress/publicDocs.js` and the
commit-time `docs-root-boundary` gate (`docs/scripts/check-root-docs.mjs`)
before adding root-level docs.

## Skills

Load these when the work lands in their territory:

- **code-review** — `/review`, PR audits, or any review of this repo. Generic
  passes miss the repo-specific rules; always include a `Verified` section.
- **find-simplification** — hunting non-obvious deletion or collapse candidates
  and recording them as dated proposals or tech-debt issues.
- **texra-cli** — the Ink TUI, transcript rendering, terminal capabilities,
  headless output parity, and CLI flag/help design.
- **releasing** — cutting a release: changelog, tags, GitHub Releases, desktop
  installers.

<!-- effect-solutions:start -->

Follow the **Effect Best Practices** guidance in `AGENTS.md`.

<!-- effect-solutions:end -->
