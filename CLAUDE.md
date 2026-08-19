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
npm test                  # Vitest
npm run lint
npm run format
npm run check:dead-code-ratchet
```

**Builds don't type check.** esbuild and Vite only strip TypeScript types; they
treat it as "JavaScript with annotations to remove." Run `npm run typecheck`, or
use the `:safe` variants (`compile:safe`, `package:safe`, `build:safe`) that
type check first. This is the single most common way a change lands broken.

## Layout

A pnpm workspace. Repo-root `src/` contains host-agnostic production code plus
centralized tests for shared and host-specific behavior; `packages/extension`, `packages/desktop`, `packages/cli`, and
`packages/trace-viewer` are hosts and apps over it. Path aliases (`@agent/*`, `@platform/*`, …) are declared in
`tsconfig.json` — use them instead of long relative chains.

Things the tree won't tell you:

- **The SDK surface is `packages/agent` (`@texra-ai/agent`) — built, fenced, not
  published.** There is no `@texra/core` package (deleted by #7099). Hosts still
  reach shared core through the repo-root path aliases, but that surface is
  **frozen, not open**: `eslint.config.mjs` forbids production `src/**` and
  `packages/agent/src/**` from importing host layers, and the ratchets in
  `config/ratchets/` freeze the remaining edges — `host-agent-import-baseline`
  (no NEW distinct `@agent/*` deep-import specifier from a host, type-only
  included), `shared-schemas-deep-import`, `host-agent-mock`, and
  `architecture-edges`. The invariant to hold is "never widen a baseline"; the
  open work is the Tier-1 public manifest and shrinking the frozen lists, not
  another lint rule. npm publication is deliberately held until a named external
  consumer exists. Kernel architecture tests under
  `src/test-kernel/architecture/` (including
  `approvalPolicyAuthorityRatchet.vitest.ts`) also pin single-authority
  invariants with hardcoded allowlists rather than baseline JSON.
- **`src/utils/` is host-agnostic, not universally browser-safe.** Exactly six
  modules are browser-reachable today: `@utils/core`,
  `@utils/core/boundedIdSet`, `@utils/core/keyedMutex`,
  `@utils/errors/errorMessage`, `@utils/files/pastedImageName`, and
  `@utils/text/stringUtils`. The other 58
  TypeScript modules are not browser-reachable and must not be assumed
  browser-safe. Side-specific helpers still belong in `frontend/` or `common/`.
  (`scripts/check-browser-safe-utils.mjs` enforces the count and reachable set.)
- **`src/eventBus/` is `AppSignals` only** — cross-cutting app-lifecycle signals
  (auth, subscriptions, tool availability, workspace-file writes). It is _not_
  run or session progress; those live in `@agent/trace` and `SessionEventHub`
  (`src/agent/runtime/`).
- **`src/common/webview/` does not exist.** Webview base classes are in
  `packages/extension/src/common/webview/`. <!-- guidance-refs-ignore -->
- **No convenience barrels.** A barrel exists only for a documented public
  surface. Import the file that defines the symbol — this includes model
  handlers (`src/agent/modelHandlers/`, see that directory's `README.md`).

Two wiring points fail silently if you forget them: a new VS Code command must
be registered through `packages/extension/src/commands.ts`, and a new setting
must be declared in the Zod schemas (`src/shared/schemas/coreSettings.ts` or
`stateSettings.ts`) and the native TeXRA settings view —
`packages/extension/package.json` must NOT contribute `configuration`;
`scripts/sync-package-contributes.mjs` throws if it does.

## Separation of concerns: VS Code coupling

Core logic must not import `vscode`. This is the highest-signal rule in the
repo and the first thing to check on any diff.

**VS Code-free zones** — must NOT import `vscode`:
`src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/controllers/`,
`src/shared/`, `src/replacement/`, `src/eventBus/`, `src/hosts/`, and the
webview frontends — `packages/extension/src/webview/frontend/`,
`packages/extension/src/progressView/frontend/`, and
`packages/extension/src/settingsView/frontend/`. Do not confuse these with
`packages/extension/src/frontend/` (no view-name segment), which is the
top-level extension-host frontend below and is VS Code-allowed.

**VS Code-allowed zones** — platform wiring belongs here:
`packages/extension/src/extension.ts` (calls `initPlatform()` exactly once),
`packages/extension/src/commands/`, `packages/extension/src/frontend/`,
`packages/extension/src/common/`, `src/platform/` interface definitions, and
`src/auth/`. Code under `src/utils/` remains host-agnostic; do not add `vscode`
imports there merely because a utility is not browser-reachable.

Reach host services through `platform()` from `@platform/platform` (config,
state, log, fs, workspace, storage, secrets). When agnostic code needs a
host-only capability, add a typed `Platform` port rather than an import.
Substitutions and the push-UI-to-the-caller rule: AGENTS.md "Platform
decoupling rules".

Also: `src/shared/` is for wire contracts and UI-shared message types — don't
add new `@agent/*` imports there; host-neutral orchestration goes in
`src/controllers/`.

**Event channels.** New run-scoped facts extend `AgentEvent` (trace);
session-scoped facts extend `SessionFact`. Don't add a new `bus.emit` from a
VS Code-free zone and don't add a new subscribe surface. (Ruled in
`docs/proposals/2026-06-10-error-pipeline-and-ownership.md`. The `src/tools`
emit sites this once grandfathered have since migrated to session-owned
emission via `SessionHandle.events` / `SessionEventHub`, so a new direct
`bus.emit` is a violation, not a grandfathered pattern.) This does not restrict
`appSignals.emit(...)` on the separate `AppSignals` bus within its documented
scope.

## Schemas (Zod v4)

Schemas are the single source of truth: define the schema, derive types with
`z.infer`, compose with `.extend()`/`.pick()`, prefer `z.discriminatedUnion()`
over `z.custom<T>()`. Normalize legacy formats once at the entry point with a
`z.union()` whose legacy member `.transform()`s into the canonical shape;
downstream code never branches on format version.

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

Core lives in `src/agent/`: `core/` is the host-agnostic domain model (see
`src/agent/core/README.md`), `implementations/flows/` holds the two PocketFlow
flows (`reflection`, `tooluse`) — each owning its own cycle/round flow, with
`core/flows/` keeping only the kernel both families use. Beside them,
`implementations/agentCreator/` is _not_ a flow despite the filename: it is one
linear async function (`runAgentCreator`) with a single production caller.
`modelHandlers/` abstracts
provider APIs. Agents are configured by YAML in
`packages/extension/resources/agents/`, one unified YAML per agent covering
single and multi-document output.

**Launch executions via `runAgent`** (`src/agent/runtime/runAgent.ts`) — it
assigns an `executionId`, registers the run, and opens workflow output. Use the
lower-level `executeAgent` only when you already own the `executionId` (subagent
dispatch, resume paths). Resume a persisted tool-use session via
`resumeToolUseFromResumeData`, not `runAgent`. PocketFlow conventions and the
services/shared-store split: AGENTS.md "Patterns across the codebase"
(PocketFlow architecture) and `docs/architecture/pocketflow-state.md`.

**The flow engine is local, not upstream PocketFlow.** `src/agent/node/index.ts`
(~150 lines) is the only definition of `BaseNode` and `Flow`. Upstream's
`BatchNode`/`BatchFlow`, `ParallelBatchNode`/`ParallelBatchFlow`, and the
`params`/`setParams` channel do not exist here — read the file rather than
upstream docs. There is no retrying `Node` class: the manual-retry loop
(automatic `p-retry` batch → `retryPrompt` → one approved attempt at a time →
`execFallback`) lives on `ModelInvocationNode`, its only implementor. A node
that just needs a failure hook overrides `BaseNode.execFallback`.

## Design guardrails

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
  it earns its place, a feature gets a few at its durable boundary. Extend
  existing suites instead of adding files, and don't demand tests in review
  beyond this bar. Full rules: AGENTS.md "Testing discipline".
- **Serialize async work with `p-queue`**, never a hand-rolled promise chain.

Full rationale and the evidence behind each: AGENTS.md "Design and
refactoring" and "Code quality rules".

## Docs

`docs/guide/` and a few root docs are published on the texra.ai VitePress site;
internal directories (`architecture/`, `design/`, `proposals/`, `prds/`,
`reference/`, …) are excluded by `docs/.vitepress/publicDocs.js`.

**A doc landing at the `docs/` root can silently freeze the texra.ai deploy** if
it trips the publish allowlist. Check `docs/.vitepress/publicDocs.js` and the
commit-time `docs-root-boundary` gate (`docs/scripts/check-root-docs.mjs`)
before adding root-level docs.

## Skills

Load these when the work lands in their territory:

- **code-review** — `/review`, PR audits, or any review of this repo. Generic
  passes miss the repo-specific rules; always include a `Verified` section.
- **texra-cli** — the Ink TUI, transcript rendering, terminal capabilities,
  headless output parity, and CLI flag/help design.
- **releasing** — cutting a release: changelog, tags, GitHub Releases, desktop
  installers.
- **tech-debt-tournament** — one cycle of the recurring scoped tech-debt sweep.
