# Agent SDK readiness re-verify: the 2026-10-05 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against `claude/eager-noether-ekbp0k` at `bb66415`. The 2026-10-04
pass's pin, `ae953c3`, is 42 commits back (`git rev-list --count ae953c3..HEAD`).
This range is why the pass was worth running: the 2026-10-04 note closed with
"re-running this audit as a routine will again add no signal **until the harness
program moves**," and it has moved — through M6, M7, the first slice of M8, the
round-mode retirement (R1) and lane 6, all under the same human-owned program.
Four read-only audits — agent core, model handler, logger, SDK surface — plus a
subagent-boundary and lane-status sweep re-confirm the standing verdict on the
current tree and record the delta below.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter beyond the one
consensus doc fix this pass already applied (the error-count reconcile, §New.4,
committed). The four area audits found **no forwarding-only wrapper, no second
run-history writer, no services-bag, and no re-export shim** — including a clean,
shimless `packages/agent`→`packages/harness` rename and a clean removal of round
mode. Every open item is owner-tier program work (the durable-harness lanes) or
tech-debt-tier, not an abstraction this routine should delete on its own.

## The delta since `ae953c3` (why this pass has signal)

The harness program advanced on five fronts. Each is landed on the tree at
`bb66415`:

1. **M8 slice 1 — the package is `@texra-ai/harness` at `packages/harness`**
   (#13756). Rename only, per durable-harness ruling Q5 / the package-split §7.
   It is clean: no compat package under `packages/agent`, no re-export shim, and
   **zero `@texra-ai/agent` or `packages/agent` references anywhere in live code
   or config** (grep over `src`, `packages`, `config`, `eslint.config.mjs`). The
   deep-import ratchet host key is now `harness`. This retires the physical-name
   half of durable-harness violation 7; the app-plugin split (`packages/theorist`)
   is still pending (§Lane status).

2. **R1 — one document recipe replaces round mode** (#13686). `loop/rounds.ts`
   and `loop/reflection.ts` are deleted; there is now **exactly one run program,
   `toolUse.ts`**, with no `agentCategory === Workflow` → `roundsContinuation`
   branch. A document task reaches the loop through `@agent/output/documentRecipe`,
   and round mode itself is the app's **`documents` plugin** (`src/tools/documents/`,
   registered via `texraPlugins` in `src/tools/registry.ts`). This **resolves
   durable-harness boundary violation 4** outright. The removal left no shim and
   no dangling reference.

3. **Lane 6 part 1 — a `Plugin` says what it contributes** (#13709). `Plugin`
   narrowed from 19 fields to 9 (`src/tools/plugins.ts:44`); dashboard copy and
   inline-settings labels moved to TeXRA's card table (`@tools/pluginCards`);
   `toggleable`+`onByDefault` collapsed to one `toggle`; the `skills`/`agents`
   flags were deleted (a plugin's bundled resources are whatever
   `resources/plugins/<id>/` holds). No stored-shape change.

4. **M6/M7 — the harness folds no app kind, and the settings catalog is declared
   by owner** (#13706, #13677). M6 turned the external inquiry into a `plugin.fact`
   arm and the inquiry aggregate into a generic plugin aggregate, with a nullable
   `parent` run edge — the kernel folds no app-specific row kind. M7 split the
   settings catalog: the harness keeps its own rows (`@shared/state/stateSettings`),
   TeXRA's rows move to `@shared/settingsView/texraSettings`, integration rows to
   `@shared/settingsView/integrationSettings`, and `installProcessRuntime` takes
   the app's rows as a `settings` argument so **the harness never imports an app
   row**. This substantially clears durable-harness violation 3.

5. **Core-quality gates and surface-shape follow-ups.** #13674 added a whole
   `config/ratchets/core-quality/` subsystem — shrink-only baselines over the
   harness and llm cores (file-size, complexity, max-lines-per-function,
   silent-degradation, undocumented-exports, no-non-null-assertion, and ~20 more).
   This is new SSOT-style enforcement that post-dates the 2026-10-04 note and is
   itself a readiness artifact: it ratchets the cores toward the "modern,
   scalable, not over-engineered" bar without a hand-written rule per edge.
   #13754 split `ToolCall` (15 fields) into a public 4-field `ToolContext` plus
   harness-internal `RunCall`, added `PluginsRefused` (a typed compose-time
   refusal for an uncomposable plugin list), and pinned a kernel check that every
   switchable TeXRA plugin has a dashboard card and vice-versa. #13758 made each
   `current_value` family a typed `ValueFamily` descriptor its owner declares,
   removing the closed harness map that named app state.

A measured consequence worth recording: `src/agent/runtime/run/modelBinding.ts`
has consolidated to **428 lines** (the 2026-10-04 note cited 966 at its pin). The
route-mismatch re-guard the prior pass defended as reachable is still reachable,
now at `:317-327` (§The four asks, 2).

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed, with the renames applied:
   - Agent core: `src/agent/core/` (`definition/`, `state/`, `tools/`); the one
     run program `@agent/runtime/loop/toolUse.ts` over the run history, with
     `runProgram.ts` (the `RunCell` single-writer), `step.ts`, `toolUseDispatch.ts`,
     `toolGuard.ts`, `hooks.ts`, `modelSwitch.ts`, `rows.ts` as its Effect-native
     decomposition (`rounds.ts`/`reflection.ts` gone, R1). Run-loop model call is
     `@agent/runtime/ModelInvoker.ts` (with `helperModel.ts` and `run/compaction.ts`
     the documented row-less direct-`Model` exceptions).
   - Model handler: provider calls are reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model` bound by `runtime/run/modelBinding.ts` (node
     `bindModel` imported at exactly one non-test site, `:27`). The intentional
     exceptions are unchanged (audio transcription builds `OpenAI` directly,
     `src/tools/media/audio.ts:252`; `codex`/`claude_code` load their own
     agent-CLI SDKs; the settings-view consent probe reads the `LanguageModel`
     platform port, `src/model/copilotRouting.ts`, not an llm `Model`).
   - Logger: `src/logger/` (`effectLog.ts`, `logSink.ts`, `effectDiagnostics.ts`,
     `formatLogData.ts`, `redaction.ts`).
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts`, `node.ts`,
     `schemas.ts`, `plugins.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways; all clean.
   - **Agent core.** Single run-history writer holds: `runProgram.ts`'s `RunCell`
     (`SynchronizedRef`) is the loop's one writer; the direct `appendBatch` callers
     are the documented bootstrap/compaction/follow-up/fork exceptions that re-sync
     via `cell.adopt`. `SessionHandle` still re-exposes owners as typed fields, not
     a per-method forwarder. `runAgent`/`executeAgent` are not pass-throughs, and
     the `resumeToolUseFromResumeData` nesting is still load-bearing.
   - **Model handler.** Still heavily de-duplicated: one turn-owning service
     (`ModelInvoker`), one shared call leaf (`run/modelCall.ts`), one host binding
     boundary. The `Model` interface still takes only a Zod-materialized
     `TurnRequest`; host concerns live in `BoundModel`. The old `ModelHandler`
     god-base / `IModelHandler` port (#12320) have not re-grown and left no shim.
   - **Logger.** The producer port (`Effect.log*` + `withLogChannel`) is clean and
     host-agnostic; render→redact→truncate is single-owner; no dead exports.
   - **SDK surface.** The root entry is `index.ts` — **40 exports (12 values, 28
     types)**, matching `config/api-reports/harness.api.md`; `schemas.ts` 19 (9/10),
     `node.ts` 2 (1/1), `plugins.ts` 1 (`harnessBuiltins`). `ToolHost` is gone from
     the package (the 2026-10-04 §New.1 drift is now actually removed). No
     `Effect.runPromise`/`runSync`/`runFork` in the package.

3. **Plan API-surface simplification.** Still the durable-harness "extend" half
   (that note's H4) plus the frozen-list shrink AGENTS.md names — not ratification
   of the 2026-09-10 static-export manifest, whose premise the pivot already
   retired. H4 is now **partially landed** (§Lane status): `Plugin` and
   `harnessBuiltins` are exported and `Sessions.layer({ platform, plugins })` takes
   a plugin list; `Plugins.contribute` in a `Scope` and `Session.resume(runId)` are
   still unexposed.

4. **Design subagent boundaries.** Already first-class; all three confirmed, with
   one framing update:
   (a) native subagents via `executeAgent` with an owned `RunId`
   (`executeAgent.ts:298`), the child-id owner `agentChildRunId`
   (`src/tools/delegation/agentChild.ts:39`) and the recover/in-band machinery;
   (b) the **`agent` tool and background `script`** share that one child-id owner
   (`backgroundScript.ts:55`) — this replaces the prior pass's "workflow-script run
   plus `agent()` grandchildren" framing, since the workflow-script runner was
   deleted; (c) agent-CLI children (`claude_code`, `codex`) via
   `startDetachedChildRunLoop` with a provider-specific `ChildRunStrategy`
   (`agentCliShared.ts:244,:526`). The non-candidates (document-output extraction,
   `compileCheck`, `LatexDiffManager`) still carry no independent run/model
   lifecycle, so reifying one buys nothing. `runAgentCreator`/`texra.createAgentWithAI`
   remain deleted. No boundary change is warranted.

## New since the 2026-10-04 pass (needs an owner, not a routine)

1. **The Tier-1 manifest is further behind the live surface — re-scope it around
   the harness SDK.** The 2026-09-10 manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`)
   still names `@texra-ai/agent`, lists `ToolHost`, and counts the root entry at
   34 bindings. The live surface is `@texra-ai/harness`, `ToolHost` is gone, and
   the root entry is 40 bindings carrying the harness **extend** surface (`Plugin`,
   `Composition`, `PluginsRefused`). As the 2026-10-04 note already ruled, this is
   intended surface under the durable-harness pivot, not drift to re-pin: the
   manifest should be rewritten against the harness SDK, not ratified as-is. The
   surviving shed/leak questions are unchanged and still owner-tier: `SettingHost`
   (TeXRA's host enum reaching the public tool contract via `ITool.unavailableHosts`)
   and the `MapToolRegistry`/`IToolRegistry` registry plumbing a `defineTool` /
   `StartInput.tools` embedder never constructs (`StartInput.tools` is a plain
   `readonly ITool[]`).

2. **The logger sink→Layer step is still unlanded** (carried verbatim from the
   2026-10-04 note; re-verified open). `src/logger/logSink.ts:165-186` still holds
   the mutable module global (`let sink = consoleLogSink`, `setLogSink`,
   `writeLogEntry`), set by host callers (extension, desktop, CLI) through the
   mutating setter, never a Layer. `packages/harness/src/effect/runtime.ts`
   installs no sink, so an SDK embedder cannot inject its own destination through
   `Sessions.layer`/`AgentPlatform` and two embedders in one process collide on
   one global. This rides `2026-09-21-effect-design-synchronous-facades.md` §5
   step 6; it is the expensive kernel-log-capture rewrite and does not by itself
   deliver embedder injection through the public boundary.

3. **A `runProgram.ts` single-caller residue appeared with the `rounds.ts`
   deletion** (new, tech-debt-tier). `runProgram.ts` was factored to be shared
   between `toolUse` and `rounds`; with `rounds` gone, `loadRun`, `settleRun`,
   `stagedBy`, `stoppedBy` and the `RunEntry`/`RunExit` types
   (`runProgram.ts:126-257`) now have exactly one caller, `toolUse.ts`. `RunCell`
   / `makeRunCell` stay genuinely multi-consumer, so the file is not wholly
   single-caller and is **not** a pass-through. Inlining the four functions + two
   types into the (already large) `toolUse.ts` is an optional judgment call, same
   tier as the carried `finalizeRunTerminalBody` cosmetic split — file it, don't
   autonomously land it.

4. **Error-count reconcile — fixed this pass (consensus), committed.** The
   source-of-truth header `packages/harness/src/effect/errors.ts` already stated
   **seven** tagged errors on the surface (five package errors, now including
   `PluginsRefused` from #13754, plus the two re-exported store errors), but
   `packages/harness/README.md` still enumerated "four + two = six." The README is
   the lagging copy; it now states five + two = seven, mirroring the header. Flagged
   independently by two of this pass's audits, so applied directly
   (commit on this branch), the same disposition the 2026-10-04 pass gave its own
   six-error reconcile.

## Lane status (durable-harness H3/H4, for the owner)

The durable-harness program (`2026-10-02-durable-harness.md`) is the live meaning
of "Agent SDK readiness." Where its boundary (H3) and extend (H4) lanes stand at
`bb66415`:

- **H3 boundary — mostly landed.** Cleared: violation 2 (`extractFigures`/`extractTikz`
  gone from `src/agent`), 4 (round mode is the `documents` plugin), 5 (the kernel
  no longer binds `TOOL_TABLE`; the table is a composition input via `toolTable(plugins)`),
  6 (`PromptSection.bibPath` gone). Substantially cleared: 3 (settings moved onto
  the binding/catalog; one deliberate live re-check remains in `ModelInvoker.ts`
  for the background-delivery policy). **Still open:** 1 — `src/agent/output/`
  retains runtime `@latex` edges (`compileCheck.ts:6-7`, `LatexDiffManager.ts:6-8`)
  and the kernel still imports `@agent/output/documentRecipe`; 7 — the physical
  `packages/theorist` split; and the **kernel/app ESLint zone is not yet added**
  (consistent with the doc's "added in the PR that clears the last edge"). An
  interim guard exists: `src/test-kernel/architecture/pluginBoundaryRatchet.vitest.ts`.
- **H4 SDK extend — partially landed.** Landed: `Plugin` value + `harnessBuiltins`;
  `Sessions.layer({ platform, plugins })`. **Open:** `Plugins.contribute` in a
  `Scope`, `Session.resume(runId)` on the public `Session` handle, and the
  `ChildProcessSpawner`→run-layer move (still process-wide in
  `src/platform/processRuntime.ts:66`).
- H1/H2 (row shapes: `parent.callId`, `context.edit`, `run.start.provenance`), H5
  and the H6 crash-point conformance suite were out of this pass's two questions
  and are not assessed here.

## Marginal cleanups (tech-debt-tier)

- `runProgram.ts:126-257` single-caller residue — §New.3. Optional inline; `RunCell`
  stays shared.
- `AgentRunLifecycle.ts` `finalizeRunTerminalBody` — one caller, exists only to be
  wrapped in `Effect.uninterruptible`. Cosmetic split, carried.

**Do not trim** (re-confirmed): the `modelBinding.ts:317-327` route-mismatch
re-guard (the `vscode-lm` and `validation` disjuncts are the live format/route
mismatches it fails loudly on; trimming is a silent-degradation regression); the
`executeAgent.ts` `resumeToolUse*` nesting (distinct `Effect.scoped`/`acquireRelease`
regions, load-bearing order).

## Recommendation

No refactor to land autonomously from this charter beyond the error-count reconcile
already applied and committed this pass (§New.4). "Agent SDK readiness" tracks the
durable-harness program; this pass records that it advanced materially (M6, M7, M8
slice 1, R1, lane 6) and that the four audited areas held their no-unnecessary-abstraction
verdict across that movement. The owner-level actions the surface audit still asks
for are to **re-scope the Tier-1 manifest around the harness SDK** (§New.1) and to
continue H3/H4 (§Lane status); the logger sink→Layer step (§New.2) rides its own
note. Re-running this audit as a routine will add fresh signal again only when the
harness program next moves — the next H3 edge (the `@latex` runtime imports in
`src/agent/output`), an H4 surface addition (`Plugins.contribute`, `Session.resume`),
or the manifest re-scope.
