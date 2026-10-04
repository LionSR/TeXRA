# Agent SDK readiness re-verify: the 2026-10-04 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-09-26 pass (`2026-09-26-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against branch `claude/eager-noether-hiwxl7` at `ae953c3`. The
2026-09-26 pass's pin, `f0811a0` (branch `claude/eager-noether-q6bj0r`), is
**not reachable in this clone** — that branch merged and was reclaimed — so a
`git rev-list f0811a0..HEAD` delta cannot be reproduced here, and this pass
re-verifies the current tree directly instead. The intervening work is visible
in the merged history ending at `ae953c3`: the audited areas continued to
shrink under the same human-owned simplification program — the chat family
collapsed onto one codec (`packages/llm/src/api/openaiChat.ts` is gone,
consolidated into `chatStream.ts`), the model-access residue trimmed
(`modelBinding.ts` is now 967 lines, down from the 1037 the prior pass cited),
the run "ledger" became the run "history" (M5), and the workflow round program
was restructured (`loop/reflection.ts` is gone; the round mode is now
`loop/rounds.ts`, over `loop/{rows,step,toolUseDispatch,toolGuard,hooks,modelSwitch}.ts`).
Alignment has **held or improved**, entirely through review, not this routine.

## Pivot: the SDK is now the harness

Since the last pass the owner has reframed the target. Per
`2026-10-02-durable-harness.md` (status: accepted), the deliverable is a
general, Effect-native, *durable harness* — "TeXRA would just be an example" —
whose SDK is its **extend** surface: `Plugin`, `Sessions.layer({ plugins })`,
`Plugins.contribute` in a `Scope`, and `Session.resume`, built as Effect values
over the plugin table (that note's H4). This reorients this standing charter:
"Agent SDK readiness" now means the durable-harness program (H1–H5), not the
ratification of the 2026-09-10 `@texra-ai/agent` Tier-1 *static-export*
manifest. The audited areas and the no-unnecessary-abstraction verdict below
are unaffected; what changes is the open-work half (§New.1, §Recommendation).
The package name is still open (durable-harness Q5), so the harness SDK still
lives in `packages/agent` today.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter: every safe
candidate in these areas is already filed, already landed, or already recorded
as refused with a ruling (`config/ratchets/refuted-candidates.json`, still the
authoritative refused set — none of its entries changed shape this pass). Four
read-only audits — one each over the agent core, the model handler, the logger,
and the SDK public surface — found **no wrapper layer that only forwards, no
second run-history writer, no services-bag, no re-export shim**. The loop's
file count grew (`step.ts`, `modelSwitch.ts`, `toolGuard.ts`, `hooks.ts`), but
each is an Effect-native decomposition of one program, not an added indirection
tier — there is still one `Effect` per run appending one history. The large
files are large because of irreducible durability/resume/stop invariants.

What makes this pass worth recording is the **pivot** (§Pivot): the standing
deliverable has moved from ratifying the 2026-09-10 static-export manifest to
the accepted durable-harness program, which makes the manifest's growing export
list (now `Plugin`, `Composition`) intended surface rather than drift to
reconcile (§New.1). This pass also applied the one consensus doc fix the audit
carried — the six-error reconcile (§New.3) — and corrected a prior-pass
misdiagnosis (the `modelBinding` re-guard is reachable, not dead; §Marginal).
The simplification program, meanwhile, resolved one marginal cleanup and shrank
one of the two `packages/llm` ambient-read sites without this routine.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed:
   - Agent core: `src/agent/core/` (`definition/`, `state/`, `tools/`); run
     program `@agent/runtime/loop/toolUse.ts` over the run history, in round
     mode via `loop/rounds.ts` (the prior `loop/reflection.ts` is gone); the
     run loop's model call is `@agent/runtime/ModelInvoker.ts` (with
     `helperModel.ts` and `run/compaction.ts` invoking the bound `Model`
     directly — deliberate exceptions, not a second handler).
   - Model handler: provider calls are reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model` bound by `runtime/run/modelBinding.ts`. The
     deliberate exceptions outside that route are unchanged (audio transcription
     builds `OpenAI` directly; the `codex` and `claude_code` tools load their
     own provider SDKs; the settings-view consent probe acquires a VS Code
     `Model`).
   - Logger: `src/logger/` (`effectLog.ts`, `logSink.ts`, `effectDiagnostics.ts`,
     `formatLogData.ts`, `redaction.ts`).
   - SDK surface: `packages/agent` (`@texra-ai/agent`) — `index.ts`, `node.ts`,
     `schemas.ts`, `plugins.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways.
   - **Agent core** remains written defensively against the exact anti-patterns
     the charter names. `SessionHandle` still re-exposes owners as fields rather
     than forwarding per-method; `loop/runProgram.ts` is still the shared
     scaffolding `toolUse`/`rounds` draw on, not a pass-through. The only
     net-negative candidates are the marginal single-caller collapses below, one
     of which has since been resolved.
   - **Model handler** is already heavily de-duplicated; the chat-family
     consolidation named in the Pin removed a whole file this pass. The `Model`
     interface still takes only a Zod-guarded materialized `TurnRequest` and
     keeps host concerns in `BoundModel`.
   - **Logger** is reached through a clean host-agnostic *producer* port
     (`Effect.log*` + `withLogChannel`), render→redact→truncate single-owner.
     The one remaining structural item is the sink→Layer conversion (§New.2),
     still unlanded.
   - **SDK surface** center (Sessions/Session/Run + tagged errors + `defineTool`,
     pure-Effect, no in-package `runPromise`) is minimal and clean; the
     redundancy is at the edges (§New.1).

3. **Plan API-surface simplification.** Reoriented by the pivot: the plan is now
   the durable-harness program's "extend" half (`2026-10-02-durable-harness.md`
   H4 — `Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute`,
   `Session.resume`) plus the frozen-list shrink AGENTS.md names, not
   ratification of the 2026-09-10 static-export manifest (see §New.1). The SDK
   speaks pure Effect end-to-end; the Promise boundary is deliberately gone.

4. **Design subagent boundaries.** Already first-class, re-confirmed unchanged:
   (a) native subagents via `executeAgent` with an owned `RunId`; (b) the
   workflow-script run plus its `agent()` grandchildren; and (c) the agent-CLI
   children (`claude_code`, `codex`) through `startDetachedChildRunLoop` with
   provider-specific `ChildRunStrategy`. The non-candidates (reflection/round
   output extraction, `compileCheck`, `LatexDiffManager`, `runAgentCreator`)
   still have no independent run or model lifecycle, so reifying one buys
   nothing. No boundary change is warranted.

## New since the 2026-09-26 pass (needs an owner, not a routine)

1. **The 2026-09-10 static-export manifest is behind the live surface; the
   pivot reframes what to do about it.** The manifest's §3.1 lists the root
   entry as "34 (10 values, 24 types)" and names `ToolHost`. The live
   `packages/agent/src/index.ts` now exports **37 bindings (10 values, 27
   types)**:
   - `ToolHost` is **gone from the package entirely** (`grep ToolHost
     packages/agent/src` is empty); §3.1 still lists it as a root type.
   - The root entry also exports `ToolGuard`, `SettingHost`, `Composition`
     (`./effect/runtime.js`) and `Plugin` (`@tools/plugins`), none of which
     §3.1 lists. `Plugin` and `Composition` are **not** accidental drift: they
     are the harness **extend** surface the durable-harness pivot makes central
     (§Pivot, that note's H4), so the move is to re-scope the manifest around
     the harness SDK, not to re-pin the old static list. The shed/leak
     questions that survive the pivot are `SettingHost` (TeXRA's internal host
     enum reaching the public tool-definition contract via `unavailableHosts`)
     and the `MapToolRegistry`/`IToolRegistry` registry plumbing an embedder on
     the documented `StartInput.tools`/`defineTool` path never constructs.
   So the 2026-09-10 draft should be retired or rewritten against the harness
   program rather than ratified as-is: ratifying it would pin a deleted name
   (`ToolHost`) and omit the very surface (`Plugin`) the pivot is built on.

2. **The logger sink→Layer step is still unlanded.** `src/logger/logSink.ts`
   still holds the mutable module global (`let sink = consoleLogSink`,
   `setLogSink`, `writeLogEntry`, lines ~165–186), set by the host callers. This
   is still the one real SDK-relevant host leak: `packages/agent/src/effect/runtime.ts`
   composes the process runtime but installs no sink, so an embedder of
   `@texra-ai/agent` gets whatever process-global sink is set and cannot inject
   its own through `Sessions.layer`/`AgentPlatform`, and two embedders in one
   process share one global. This is step 6 of
   `2026-09-21-effect-design-synchronous-facades.md` §5 and rides that note; it
   is the expensive step (it rewrites the kernel log-capture seam) and does not,
   by itself, deliver embedder injection through the public boundary — that is a
   further, not-yet-designed public-API step.

3. **`packages/llm` ambient reads shrank from three to two; reconcile the error
   count.**
   - The ambient `process.env.*_CUSTOM_HEADERS` reads are now **two**:
     `anthropicMessages.ts:460` and `openaiResponsesRequest.ts:254`. The third
     (`openaiChat.ts`, the `openaiChatModel` factory) is gone with the file in
     the chat-codec consolidation. These two are intentional guardrails; moving
     the check to the host boundary (`modelBinding.ts`) remains a relocation that
     must be passed explicitly into every factory, not a lift (the
     `packages/llm/test-live/` callers construct the factories without
     `modelBinding`). Low priority; file into `2026-09-20-llm-package-hardening.md`
     or a fresh tech-debt entry (that note's §0 is closed and owns neither).
   - **Error-count reconcile — fixed this pass (consensus).**
     `packages/agent/src/effect/errors.ts` had claimed "Four tagged errors, no
     more" and the README enumerated four and said "nothing else is exported: no
     store," while the root entry exports **six** error values (those four plus
     `DatabaseOpenFailed`, `DatabaseReadFailed` from `@shared/session/database`,
     the `SessionOpenError` union). Both the header comment and the README now
     state six and name the two store errors. Flagged by two consecutive passes,
     so applied directly rather than filed.

## Marginal cleanups (tech-debt-tier, re-pinned)

- `AgentLaunchContext` `assembleAgentLaunchContext` single-caller collapse —
  **resolved.** The symbol no longer exists under `src/agent/runtime` (folded in
  the single-caller-file pass ending `ae953c3`). Dropped from the list.
- `AgentRunLifecycle.ts:134` `finalizeRunTerminalBody` — one caller (at :132);
  exists only to be wrapped in `Effect.uninterruptible`. Cosmetic split, carried.
- `modelBinding.ts` ~843–847 — **prior diagnosis refuted, do not trim.** The
  2026-09-26 pass called the re-guard's `protocol === 'vscode-lm'` and
  `'validation'` disjuncts unreachable. On inspection they are not: the `if` at
  :803 returns only for `vscode-lm` **and** `copilot` together, and the `if` at
  :816 returns only for `protocol === 'validation'`, so by :843 the `vscode-lm`
  disjunct (vscode-lm format, non-copilot route) and the `route.kind ===
  'validation'` disjunct (validation route, non-validation protocol) are the
  live format/route-mismatch cases this guard exists to fail loudly on. Trimming
  would be a silent-degradation regression. Dropped from the cleanup list.

**Do not collapse** (unchanged): `executeAgent.ts` `resumeToolUse*` three-level
chain — each level is a distinct `Effect.scoped`/`acquireRelease` region whose
nesting order is load-bearing for finalizer-before-release ordering.

## Genuinely open (carried, still human-owned)

- **Re-scope the Tier-1 manifest around the harness SDK** (not ratify the
  2026-09-10 static list) — §New.1; belongs to the durable-harness program.
- **Shrink the `host-agent-import` frozen list** as the manifest ratifies each
  edge; never widen.
- **Owner ruling on the two agent-creation systems** (`texra.createAgentWithAI`
  wizard vs. the `creator` tool-use agent), per
  `2026-09-23-ssot-ownership-survey.md` §2 — reverses two rulings, not a
  routine's call.

## Recommendation

No refactor to land autonomously from this charter beyond the one consensus doc
fix already applied this pass (the six-error reconcile, §New.3). The charter has
pivoted to the durable-harness program (§Pivot): "Agent SDK readiness" now
tracks that note's H1–H5, and the one owner-level action the surface audit still
asks for is to **re-scope the Tier-1 manifest around the harness SDK rather than
ratify the 2026-09-10 static list** (§New.1) — the live root entry already
carries the harness extend surface (`Plugin`, `Composition`) the old draft
predates. The logger sink→Layer step (§New.2) rides
`2026-09-21-effect-design-synchronous-facades.md`; the two remaining
`packages/llm` ambient reads (§New.3) need filing. Re-running this audit as a
routine will again add no signal until the harness program moves.
