---
created: 2026-11-14
status: proposed
---

# Agent SDK readiness: a verification audit of core, model, logger and surface

Baseline: `main`/`claude/eager-noether-dcmok0` at `a32024c`. This is a read-only
audit requested as a standalone "SDK readiness" pass over four areas: the agent
core, the model handler, the logger, and the public surface. It overlaps heavily
with existing design work and is written as a **verification** of that work plus
a short list of genuinely new cleanup candidates, not as a new plan.

Read alongside, and subordinate to:

- [`2026-10-21-harness-general-package-design.md`](./2026-10-21-harness-general-package-design.md)
  (the canonical "harness as a general package" plan AGENTS.md points to as the
  open work)
- [`2026-10-28-harness-1-release-prd.md`](./2026-10-28-harness-1-release-prd.md)
- [`../../implemented/architecture/2026-10-02-harness-package-split.md`](../../implemented/architecture/2026-10-02-harness-package-split.md)

## Summary

The codebase is already well-aligned for SDK consumption, and further along than
the 2026-10-21 plan's baseline. The headline measures:

- The root entry `@texra-ai/harness` exports **37 names** (`config/api-reports/harness.api.md`),
  down from 246 at the plan's `08455c8` baseline and below the plan's own
  ~48/59 target.
- The frozen boundary holds completely: **0** files under
  `packages/{texra,extension,desktop,cli}/src` import a harness internal alias
  (`@agent/*`, `@platform/*`, `@common/*`, `@tools/*`, …).
- `packages/texra/src/tools` imports **0** harness internals, down from the
  55–58 the 2026-10-21 audit counted. The plugin contract now covers TeXRA's own
  plugins, which was the single largest "behind our own design" gap.

Across the four areas, every layer audited carries real, distinct behavior. The
audit found **no shallow module or pass-through that warrants collapse** in the
core or model path, and only two minor, concrete cleanup candidates (one in the
model path, one in the logger). The remaining structural work is the already-
documented open items, not new discoveries.

## What was verified

### 1. Agent core (run loop, lifecycle)

Deep and aligned. The run is one Effect program
(`agent/runtime/loop/runLoop.ts`, `loop/toolUseDispatch.ts`) that continues from
the `RunState` each `RunCell.append` returns; live and resume are one function.
There is no flow engine, no cursor, no services bag — services come from context
at the `executeAgent` boundary. The top level of `agent/runtime/` is
deliberately flat, with the rationale recorded in its `README.md` ("Why the top
level stays flat"): most files have many in-harness importers, so a regroup is
churn without a design gain. This matches the 1.0 PRD's decision to keep the ten
directories and not introduce `sdk/`/`session/` for 1.0.

No new finding here. `ModelInvoker.ts` (902 lines) and `loop/toolUseDispatch.ts`
(1022 lines) are large but are deep modules — a small interface over row-based
behavior — not split candidates.

### 2. Model handler

Mostly deep and well-aligned. The call chain `ModelInvoker.invoke` (turn retry
over committed rows) / `callModel` (off-the-rows call under the shared
`ModelRetryGate`) / `ModelAccess` (project-scoped bind facade) /
`modelAccess/routeDecision.ts` (route and credential policy) / the `packages/llm`
`Model` (schema-driven, three protocol implementations behind one interface) each
carries real, distinct work. The "new provider is data" guidance
(harness AGENTS.md "Agent execution") is borne out by the `CONFIGURE` quirk table
in `packages/llm/src/api/configuration.ts`.

**Finding M1 (minor, borderline) — single-caller bind seam.**
`bindOver` (`agent/runtime/modelAccess/ModelAccess.ts:124`) is called only by the
`ModelAccess.bind` method (`:186`); `bindRoute` (`modelAccess/binding.ts:94`) is
called only by `bindOver` (`:145`); the `BindPlan` interface (`binding.ts:36`)
exists only as the hand-off record between them. Caller counts verified by grep:
each is 1:1. This is near the repo's single-caller-extraction ban, but the two
functions sit at different altitudes — "decide the route" (selectModel, resolve
config, read settings, `decideRoute`) vs "construct the model" (validation-model
branch, `routeCredential`, `reasoningOf`, `bindWireModel`) — so the "method that
only forwards" rule is not actually violated. Collapsing means moving ~90 lines
across the `ModelAccess.ts`/`binding.ts` boundary and dropping `BindPlan`. **Low
value; recommend leaving as-is** unless this area is edited for another reason.

Explicitly considered and cleared as justified (do not collapse): the
`ModelAccess` service methods forwarding to standalone functions (they inject
project-captured `Secrets`/env from the layer, so `ModelInvoker` cannot call the
standalone functions directly); `ModelInvoker.call` over `callModel` (resolves
media bytes, selects the binding, provides usage/route services — `callModel` has
two real callers, the compaction summary and `helperCall`); `routeFailureOf`
(multi-caller pure unwrap); `api/verdict.ts` `judgedModel` (a real per-call
failure-judgment decorator).

### 3. Logger / trace

Well-factored. There are two planes separated by **destination**, not by fiber
boundary, and they are not two representations of one fact:

- Diagnostic (operator) plane: `Effect.log*` + `withLogChannel`
  (`@logger/effectLog`) → `logEntryOf` → render → redact → truncate → installed
  `LogSink`.
- Session/trace (user) plane: `AgentTrace` → `TraceEmitter.emit` → session log
  `publish` → progress view / transcript.

The fiber/fiberless split matches the AGENTS.md rule exactly. Redaction
(`logger/redaction.ts`, compile-checked key-shape table) and formatting
(`logger/formatLogData.ts`) are real single-owner work.

**Finding L1 (minor) — duplicated `Logger.make` entry→sink closure.**
`diagnosticLogger` (`logger/effectDiagnostics.ts:18-21`) and the inline logger in
`viewDiagnosticsLayer` (`platform/processRuntime.ts:174-180`) are byte-for-byte
the same adapter from an Effect log entry to `writeLogEntry`. `logEntryOf` has
exactly these two call sites. The surrounding layers legitimately differ (the
diagnostics layer also installs `MinimumLogLevel` and a tracer; the view layer is
logger-only for a browser/view runtime), but the closure body is the duplicated
fact. **Fix is low-risk:** export a shared `sinkLogger` and have both layers reuse
it. Touches the "one owner per fact" rule.

### 4. Public surface

Lean and clean. Root is 37 exports; `runView` (`effect/runHandle.ts:103`) and
`activationView` are genuinely deep view construction (activation-boundary
detection, transcript-subscription union, racing an end against a drain), not
pass-through. The larger subpaths are intentional and already explained by the
2026-10-28 re-check in the general-package design: `./schemas` (311) is a named
manifest over the internal barrel that no app/host `src` file reaches, and
`./host` (164) is host composition held by consumed signatures. No new surface
finding.

## Subagent boundaries (task step 4)

Subagents are already a first-class, well-designed concept in the harness — there
is no missing boundary to introduce:

- The `agent` tool (`agent/runtime/delegation/AgentTool.ts`) runs a named agent
  as a child of the calling run, sharing `launchChildAgent` with plugin task
  tools.
- `childRunLoop` is the single driver for every child-run type; a native child
  runs one cycle under `executeAgent`, a process child one turn under
  `runProcessChild` (`agent/runtime/processRun.ts`).
- `childRunBudget` enforces per-session concurrency; `delegationAvailability.ts`
  decides which models a child may use.
- TeXRA's own document tasks already run as child runs via recipes
  (`documentRecipe.ts`), through the plugin `agentBlock` contract — the app adds
  no out-of-band orchestration.

The correct SDK-readiness posture here is **not** to carve new subagent split
points but to confirm the existing delegation surface is the one an embedder
would use. It is: child launches go through the same `executeAgent` as roots, and
the public `agent` tool is the embedder-facing primitive.

## Proposed cleanup (both optional, low value)

| # | Change | Files | Risk |
| - | ------ | ----- | ---- |
| M1 | Inline `bindOver` into `ModelAccess.bind`, drop the `BindPlan` seam | `modelAccess/ModelAccess.ts`, `modelAccess/binding.ts` | low (one module boundary) |
| L1 | Share one `sinkLogger` between `effectDiagnostics.ts` and `processRuntime.ts` | `logger/effectDiagnostics.ts`, `platform/processRuntime.ts` | low |

Neither is required for SDK readiness. M1 is borderline against the single-caller
ban and a reviewer may raise it; L1 is a genuine one-owner-per-fact dedupe.

## Still open (already documented elsewhere — not new)

Carried verbatim from the 2026-10-21 design's "Still open" list, re-measured:

- `shared/session/sessionViewUpdate.ts` is **1084** lines (was 1169).
- ~350 lines of duplicated lowering across the llm adapters
  (`packages/llm/src/api/`); `openaiResponsesLower.ts` alone is 338.
- The CLI TUI still synthesizes transcript rows at render time with `Date.now()`
  (`packages/cli/src/chat/tui/state/transcript.ts:77`) — the renderer
  anti-pattern.
- Four CLAUDE.md rules still have no mechanical check (barrel ban, single-caller
  ban, renderer `Date.now()`, silent degradation outside harness/llm).

## Verified

- Read `main` at `a32024c`. Export counts from `config/api-reports/*.api.md`
  headers (`harness` 37, `host` 164, `node` 50, `plugins` 135, `schemas` 311,
  `transcript` 75, `llm` 97).
- Boundary counts by grep: 0 files under `packages/{texra,extension,desktop,cli}/src`
  importing a harness internal alias; 0 under `packages/texra/src/tools`; 0 under
  `packages/texra/src`, `packages/extension/src`, `packages/desktop/src`,
  `packages/cli/src`.
- Read directly: `agent/runtime/README.md`, `agent/core/README.md`,
  `effect/runHandle.ts`, `effect/sessions.ts` (head), `delegation/AgentTool.ts`
  (head), the `agent/runtime/delegation/` and `effect/` file inventories.
- Caller counts for M1 (`bindOver`, `bindRoute`) and L1 (`logEntryOf`) verified
  by repo-wide grep.
- Not run: any build, typecheck, or test; no files were edited.
