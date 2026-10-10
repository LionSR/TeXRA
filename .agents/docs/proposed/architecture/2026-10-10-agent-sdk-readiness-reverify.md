# Agent SDK readiness re-verify: the 2026-10-10 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against branch `claude/eager-noether-5nwuta` at `8a58597`
(#13922). The 2026-10-04 pass's pin, `ae953c3`, is an ancestor — 192 commits
back (`git rev-list --count ae953c3..HEAD`); it only looks unreachable from a
shallow clone, which needs deepening first (`git fetch --deepen`). This pass
re-verifies the current tree and reads that range for the delta.

## Headline: the harness program moved, so this pass has signal

The 2026-10-04 pass closed with "re-running this audit as a routine will again
add no signal until the harness program moves." It has moved. The whole
precondition that pass named is now met, and the delta over `ae953c3..HEAD` is
the harness-package-split and durable-harness program landing in the tree:

- **The package split landed.** `packages/agent` / `@texra-ai/agent` is gone;
  the SDK surface now lives in `packages/harness` and ships as
  **`@texra-ai/harness`** (`packages/harness/package.json`,
  "Embeddable TeXRA agent runtime"). `@texra-ai/llm` builds to `dist` and the
  harness depends on it (#13857); hosts and `Sessions.layer` compose one
  `processLayer` (#13825). This is `2026-10-02-harness-package-split.md` made
  real: the dependency arrow is app → harness → llm. The durable-harness Q5
  package-name question the 2026-10-04 pass called "still open" is answered in
  the tree — the name is `harness` — even though `2026-10-02-durable-harness.md`
  still lists Q5 as open (that doc is the delta to reconcile, not the tree).
- **The model handler was consolidated to one service.** `modelBinding.ts`
  (966 lines at the prior pin) is **gone**; a `modelBinding` grep of
  `packages/harness/src` is empty. Provider calls now bind through one
  `ModelAccess` service (#13919, "one ModelAccess replaces model binding, routes
  and failure reading"), decomposed under
  `packages/harness/src/agent/runtime/modelAccess/` into `ModelAccess.ts`,
  `binding.ts`, `routeDecision.ts`, `failureInfo.ts`, `credentials.ts` — the
  internal arms of the one service (the 400-line core rule forces the split),
  each imported and used, none orphaned. Routing is owned once
  (`decideRoute` over llm's pure `decideModelRoute`); failure wording is owned
  once (`failureInfo.ts` words llm's `ModelError` verdicts for rows).
- **`BoundModel` was slimmed.** Host concerns (picker copy, coding plans,
  `modelFileName`) moved to the app; `BoundModel` keeps only what the run reads
  (#13920).
- **The run loop was restructured again** and is still one Effect program over
  one history: "one door, one cell for a run's rows" (#13917), the invocation
  ledger as one retry loop over the attempt rows (#13835), the final answer is a
  history row (#13887). `packages/harness/AGENTS.md` "Run loop architecture"
  states the invariant as current fact: one program (`runToolUse`), state is row
  data folded by `appendBatch`, "No services bag, no node fields," one retry
  loop (`runInvocation`).
- **SDK surface grew along the pivot, not as drift.** `inherits` is refused with
  a clear message (#13868); the built-in agents ship in one directory (#13884);
  `StartInput` takes an inline persona (#13856), so `InlinePersona` is now a
  root export. The extend surface (`Plugin`, `Composition`, `Sessions`) is the
  intended shape per the durable-harness pivot, not accidental export creep.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter. Four
read-only audits — two of them independent adversarial sweeps run this pass over
the *restructured* agent core/run-loop and the *consolidated* model handler —
found **no wrapper layer that only forwards, no second run-history writer, no
services-bag, no re-export shim** introduced by the restructuring:

- **Single live append path confirmed.** `runHistory.appendBatch` has two call
  sites: `loop/runProgram.ts:102` inside `RunCell.append` (the one writer for a
  run's live rows — adds the `SynchronizedRef` lock, fold-back, uninterruptible
  mask), and `forkRun.ts:173`, the one-time atomic birth of a *new* forked run
  (`state=null` + a `registration` `run.start`), not a second writer into an
  existing run. `RunHistory.ts`'s internal `transact` writes only
  `request.decided` cancellations inside the service itself. Every loop module
  routes through `cell.append`.
- **Model handler has one chokepoint.** The `packages/llm` `Model` is still the
  sole provider-API path; the only `new OpenAI/Anthropic/GoogleGenAI` and
  endpoint construction live inside the llm protocol arms (the `Model`
  implementation), and the deliberate exceptions are unchanged (audio
  transcription builds `OpenAI` directly in `packages/texra/src/tools/media/audio.ts`;
  the `codex`/`claude_code` tools load their own provider SDKs; `@texra-ai/llm/node`
  imports elsewhere are OAuth sign-in/status helpers, not model calls). `bindModel`
  (llm/node) has exactly one caller, `modelAccess/binding.ts`.
- **No services bag.** `AgentRun` is a per-run `Context.Service` carrying real
  captured state (model ref + `swapModel`, steps ref, scope); `ToolServices.ts`
  is type unions plus `ChildRuns` with real `launch` logic. No logic-free bundle.
- **No re-export shim.** `runtime/index.ts` is the sanctioned, derived-from-use,
  cross-host public-surface barrel (nothing inside `src/agent` imports it, so no
  cycle); `packages/llm/src/index.ts` is the browser-safe public barrel. Neither
  is forward-only.

The `modelAccess/` directory's five files and the loop's file growth are
Effect-native decompositions of one program under the 400-line core rule, not
added indirection tiers.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed at their new homes:
   - Agent core: `packages/harness/src/agent/core/` (`definition/`, `state/`,
     `tools/`); run program `@agent/runtime/loop/toolUse.ts` over the run
     history; the loop's model call is `@agent/runtime/ModelInvoker.ts` (with
     `helperModel.ts` and `run/compaction.ts` invoking the bound `Model`
     directly — deliberate exceptions, not a second handler).
   - Model handler: provider calls are reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model`, bound by the one
     `packages/harness/src/agent/runtime/modelAccess/` service (was
     `runtime/run/modelBinding.ts`, now deleted). Deliberate exceptions unchanged.
   - Logger: `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`) — relocated
     from repo-root `src/logger/` by the split, same five files.
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts`,
     `node.ts`, `schemas.ts`, `plugins.ts`, `effect/`
     (`sessions.ts`, `sessionPrograms.ts`, `runHandle.ts`, `requestAnswerer.ts`,
     `errors.ts`; the old `effect/runtime.ts` composition file is gone, folded
     into `processLayer`/`sessions.ts`).

2. **Audit for unnecessary abstraction.** Done, four ways (see Verdict).
   - **Agent core**: clean of all five anti-pattern categories after the
     restructuring; one marginal single-caller observation below.
   - **Model handler**: the consolidation removed a whole binder file and left
     no leftover routing/failure-reading. The `Model` interface still takes a
     Zod-guarded materialized request and keeps host concerns out.
   - **Logger**: still a clean host-agnostic *producer* port (`Effect.log*` +
     `withLogChannel` in `effectLog.ts`), render→redact→truncate single-owner.
     The one structural item is the sink→Layer conversion (§New.1), still
     unlanded.
   - **SDK surface**: the center (`Sessions`/`Session`/`Run` + tagged errors +
     `defineTool`, pure Effect, no in-package `runPromise`/`runSync`/`runFork`)
     is minimal and clean; the README states it exactly. Redundancy is at the
     edges (§New.2).

3. **Plan API-surface simplification.** Reoriented by the pivot already recorded
   in the prior passes: the plan is the durable-harness program's "extend" half
   (`2026-10-02-durable-harness.md` H4 — `Plugin`, `Sessions.layer({ plugins })`,
   `Plugins.contribute`, `Session.resume`) plus the frozen-list shrink AGENTS.md
   names, not ratification of the 2026-09-10 static-export manifest (§New.2). The
   SDK speaks pure Effect end-to-end.

4. **Design subagent boundaries.** First-class and unchanged: (a) native
   subagents via `executeAgent` with an owned `RunId` (dispatch in
   `tools/delegation/inBandSubagentRun.ts`); (b) the workflow-script run plus its
   `agent()` grandchildren; (c) the agent-CLI children (`claude_code`, `codex`)
   through a provider-specific `ChildRunStrategy`. The non-candidates (round
   output extraction, `compileCheck`, `LatexDiffManager`) still have no
   independent run or model lifecycle, so reifying one buys nothing. No boundary
   change is warranted.

## New / updated since the 2026-10-04 pass (needs an owner, not a routine)

1. **The logger sink→Layer step is still unlanded, and the composition root
   still installs no sink.** `packages/harness/src/logger/logSink.ts` still holds
   the mutable module global (`let sink = consoleLogSink`, `let sinkTrusted =
   false`, `setLogSink`, `writeLogEntry`, lines ~165–186), set by the host
   bootstraps (`packages/{extension,desktop,cli}` call `setLogSink`). The
   embedder-facing composition — `packages/harness/src/effect/sessions.ts` and
   `packages/harness/src/platform/processRuntime.ts` — installs no sink (grep for
   `setLogSink`/`LogSink`/`withLogChannel` in both is empty), so an embedder of
   `@texra-ai/harness` gets whatever process-global sink is set and cannot inject
   its own through `Sessions.layer`/`AgentPlatform`, and two embedders in one
   process share one global. This is the one real SDK-relevant host leak; it is
   step 6 of `2026-09-21-effect-design-synchronous-facades.md` §5 and rides that
   note. It is the expensive step (it rewrites the kernel log-capture seam) and
   does not by itself deliver embedder injection through the public boundary —
   that is a further, not-yet-designed public-API step. Carried from the prior
   pass; re-pinned to the new `packages/harness/src/logger/` location.

2. **The 2026-09-10 static-export manifest is now doubly stale; retire or
   rewrite it, do not ratify.** `2026-09-10-agent-sdk-tier-1-manifest.md` still
   names the **old package** throughout — `packages/agent`, `@texra-ai/agent`,
   `@texra-ai/agent/schemas`, `@texra-ai/agent/node`, `typecheck:agent`,
   `pnpm --filter @texra-ai/agent build` — a package that no longer exists.
   On top of that it carries the drift the prior pass already flagged: it lists
   `ToolHost` as a root type (a `ToolHost` grep of `packages/harness/src` is now
   empty — the name is gone from the package) and omits `Plugin`, `Composition`,
   `InlinePersona`, which the live root entry (`packages/harness/src/index.ts`,
   35 export statements) now carries as the harness extend surface. Ratifying the
   draft as-is would pin a dead package name and a deleted type. The move is to
   re-scope the manifest around the harness SDK (`@texra-ai/harness` and its four
   entries `.`, `/schemas`, `/plugins`, `/node`), which belongs to the
   durable-harness program, not this routine. The shed/leak questions that
   survive the pivot are unchanged: `SettingHost` (TeXRA's internal host enum
   reaching the public tool-definition contract) and the `MapToolRegistry` /
   registry plumbing an embedder on the `defineTool` path never constructs — both
   still exported from the root entry.

3. **The `packages/llm` ambient-header reads are now refusal guards on both
   paths — effectively closed in the audited code.** The prior pass carried "two
   ambient reads to file into llm-package-hardening." At this pin neither path
   *honors* an ambient value: `openaiResponsesRequest.ts:254` throws a
   `ModelError` (`kind 'unsupported'`, "Ambient OpenAI headers cannot override
   the selected deployment.") when `OPENAI_CUSTOM_HEADERS` is set, and
   `anthropicMessages.ts:715` throws a `ModelError` ("Anthropic Messages does not
   support ANTHROPIC_CUSTOM_HEADERS; the selected binding must determine its
   request headers.") — both make the selected binding the sole source of
   request headers. These are intentional guardrails, not value-honoring reads;
   relocating the `process.env` *check* to the host boundary remains a low-value
   relocation (each llm factory would have to be passed the decision explicitly,
   and `packages/llm/test-live/` constructs factories without it), not a lift.
   Low priority; file into `2026-09-20-llm-package-hardening.md` only if the
   relocation is ever wanted.

4. **The surface error vocabulary grew from six to eight and stayed
   consistent — no reconcile needed.** The 2026-10-04 pass applied a six-error
   reconcile across `errors.ts` and the README. At this pin the package defines
   **six** tagged errors (`PluginsRefused`, `SessionOptionsConflict`,
   `AgentNotFound`, `ToolsRefused`, `ResumeRefused`, `RunFailure`) plus **two**
   re-exported store errors (`DatabaseOpenFailed`, `DatabaseReadFailed`, the
   `SessionOpenError` union) — **eight** on the surface. Both the `errors.ts`
   header comment and the README §Effect state eight, with the same six-from-the-
   package breakdown. The reconcile held through the growth; nothing to fix this
   pass.

## Marginal cleanups (tech-debt-tier)

- `AgentRunLifecycle.ts` `finalizeRunTerminalBody` — **resolved.** The symbol the
  prior pass carried as a cosmetic single-caller split no longer exists (folded in
  the restructuring, like `assembleAgentLaunchContext` before it). Dropped from the
  list. These single-caller cosmetics keep folding during restructuring without
  this routine.
- `loop/runProgram.ts:239` `stagedBy` — a generic stage combinator with one caller
  (`toolUse.ts:471`); its comment gestures at a second adopter
  (`childRunLoop.ts`, which still uses a mutable `loop.stage` field and did not
  adopt it). It encapsulates non-trivial logic (`acquireUseRelease` +
  `Exit.match`/`failureOutcome` a Scope finalizer cannot express), so it is
  defensible as-is; the only item in the audited area that approaches a
  single-caller violation. Carried as an observation, not a fix: the implied
  two-loop consolidation did not land.
- `core/definition/AgentConfig.ts:5` — `AgentConfigSchema = AgentConfigFieldsSchema`
  carries a comment claiming "output file count validation" it does not add. A
  doc-comment inaccuracy, not indirection (the alias anchors the widely-used
  `AgentConfig`/`AgentConfigPayload` types). First-pass observation; if a later
  pass corroborates it, correct the comment. Not applied autonomously (the
  two-consecutive-passes bar the prior pass used for doc fixes is not met).

**Do not collapse** (unchanged): `executeAgent.ts` `resumeToolUse*` chain — each
level is a distinct `Effect.scoped`/`acquireRelease` region whose nesting order
is load-bearing for finalizer-before-release ordering.

## Refuted set unchanged except mechanical re-pins

`config/ratchets/refuted-candidates.json` is still the authoritative refused
set. Over this range it changed only mechanically: the split moved the files, so
the symbol paths were re-pinned from `packages/agent/src/...` to
`packages/harness/src/...` (e.g. `ModelRetryGate.ts`, `perKeyQueue.ts`,
`interfaces.ts`, `jsonConfigProvider.ts`). No retained refusal was reversed, so
none bears on this verdict.

## Genuinely open (carried, still human-owned)

- **Re-scope the Tier-1 manifest around the harness SDK** — §New.2; belongs to
  the durable-harness program. More urgent than the prior pass noted: the draft
  now names a deleted package.
- **Reconcile `2026-10-02-durable-harness.md` Q5** — the package name it lists as
  open is `harness` in the tree. A doc catch-up, owner-level.
- **Shrink the `host-agent-import` frozen list** as the manifest ratifies each
  edge; never widen.
- **Logger sink→Layer** (§New.1) — rides
  `2026-09-21-effect-design-synchronous-facades.md`.

## Recommendation

No refactor to land autonomously from this charter: the one doc inconsistency the
prior pass fixed (the six-error reconcile) is already consistent through growth,
and the two marginal observations this pass surfaced are first-pass, below the
bar for autonomous correction. The charter's deliverable this pass is this
finding itself. The harness program has moved as predicted — the package split
and the `ModelAccess` consolidation landed — and the audited areas held or
improved (the ambient-header reads became explicit refusals; the model binder
collapsed to one service) entirely through review, not this routine. The one
owner-level action the surface audit asks for is unchanged and now more pressing:
**re-scope the 2026-09-10 Tier-1 manifest around `@texra-ai/harness` rather than
ratify a draft that names a deleted package**. Re-running this audit as a routine
will again add little signal until the durable-harness program takes its next
step.
