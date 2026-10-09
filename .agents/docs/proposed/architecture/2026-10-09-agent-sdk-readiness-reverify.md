# Agent SDK readiness re-verify: the 2026-10-09 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against `main` at `2bda324` (#13916). The 2026-10-04 pass pinned
branch `claude/eager-noether-hiwxl7` at `ae953c3`, which named the SDK package
`packages/agent` (`@texra-ai/agent`) and the model handler
`runtime/run/modelBinding.ts`. Both names are now gone: this pass re-verifies the
current tree because the condition the last pass set for a re-run worth recording
— "re-running this audit as a routine will again add no signal **until the harness
program moves**" — has been met. The harness program moved.

## The delta: the harness program moved

The last pass's §Pivot reoriented the standing charter onto the accepted
durable-harness program (`2026-10-02-durable-harness.md`, H1–H5), whose SDK is
the harness **extend** surface (`Plugin`, `Sessions.layer({ plugins })`,
`Plugins.contribute`, `Session.resume`). Three of that program's moves have since
landed, so "Agent SDK readiness" advanced through review, not this routine:

- **The package split landed, and the SDK package is now `packages/harness`
  (`@texra-ai/harness`).** Durable-harness Q5 ("the package names stay open")
  is resolved for the harness package: the SDK no longer lives in
  `packages/agent`. The split design is
  `2026-10-02-harness-package-split.md`; the layer is now
  `packages/harness/src` (Effect-only harness), `packages/texra/src` (the app),
  `packages/llm/src` (model access). The repo-root `src/` holds only the
  centralized test suite.
- **One ModelAccess replaced model binding (#13919).** The 966-line
  `runtime/run/modelBinding.ts` the last pass cited is gone, decomposed into
  `runtime/modelAccess/` — one service (`ModelAccess.ts`) over four cohesive
  modules: `binding.ts` (route → `Model` + the one billed credential),
  `credentials.ts`, `routeDecision.ts`, `failureInfo.ts` (words `ModelError` /
  `RouteUnavailable` for the run's rows). This is a consolidation, not an added
  tier: three former concerns (binding, routes, failure reading) now have **one
  owner**, and AGENTS.md records the invariant — "the one service a run binds
  through; there is no per-provider handler class." Alignment improved.
- **One tool catalog; each project runs its own MCP servers (#13916); one door,
  one cell for a run's rows (#13917).** Continued single-owner consolidation in
  the areas this charter audits.

Also gone: `loop/rounds.ts` (the last pass's round-mode file). Round
orchestration now rides the one `runToolUse` program over the documents plugin's
recipe script (`documentRecipe.ts`, "calls the agent once per revision"); there
is no separate round-mode loop file. One fewer program, not a new one. (Not
traced exhaustively this pass; the verdict does not rest on it.)

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter. Every safe
candidate in the audited areas is filed, landed, or recorded as refused with a
ruling (`config/ratchets/refuted-candidates.json`, still the authoritative
refused set; unchanged in shape this pass). The four read-only audits — agent
core, model handler, logger, SDK public surface — again found **no wrapper layer
that only forwards, no second run-history writer, no services-bag, no re-export
shim**. The loop and the model handler are Effect-native decompositions of one
program and one service respectively; large files are large because of
irreducible durability/resume/stop invariants, enforced by `check:core-quality`.

## The four asks, re-mapped to `2bda324`

1. **Identify the areas.** Re-confirmed at current paths:
   - **Agent core:** `packages/harness/src/agent/core/` (`definition/`, `state/`,
     `tools/`). The run program is `@agent/runtime/loop/toolUse.ts`
     (`runToolUse`, with `toolUseDispatch.ts`) over the run history, continuing
     from the folded `RunState` (`shared/session/runStateFold.ts`); peers
     `rows.ts`, `step.ts`, `modelSwitch.ts`, `toolGuard.ts`, `hooks.ts`,
     `runProgram.ts` are one program's parts. The loop's model call is
     `@agent/runtime/ModelInvoker.ts` (the only service that calls the `packages/llm`
     `Model`); `run/compaction.ts` and `helperModel.ts` invoke the bound `Model`
     directly — deliberate exceptions, not a second handler.
   - **Model handler:** `packages/harness/src/agent/runtime/modelAccess/` (the one
     service a run binds through) over the `packages/llm` (`@texra-ai/llm`)
     `Model`. A new provider is a `packages/llm` protocol arm plus its route and
     credential here — no per-provider handler class. The deliberate exceptions
     outside this route are unchanged (audio transcription builds `OpenAI`
     directly; the `codex` / `claude_code` tools load their own provider SDKs; the
     settings consent probe acquires a VS Code `Model`).
   - **Logger:** `packages/harness/src/logger/` (`effectLog.ts`, `logSink.ts`,
     `effectDiagnostics.ts`, `formatLogData.ts`, `redaction.ts`). Reached through a
     host-agnostic producer port (`Effect.log*` + `withLogChannel`),
     render→redact→truncate single-owner.
   - **SDK surface:** `packages/harness` (`@texra-ai/harness`) —
     `index.ts`, `node.ts`, `schemas.ts`, `plugins.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways; no net-negative
   candidate found that is not already filed or ruled.
   - **Agent core** is still written against the exact anti-patterns the charter
     names. `SessionHandle` re-exposes owners as fields rather than forwarding
     per-method; `loop/runProgram.ts` is shared scaffolding, not a pass-through.
   - **Model handler** got *more* consolidated this cycle (#13919); the `Model`
     interface still takes only a Zod-guarded materialized `TurnRequest` and keeps
     host concerns in `BoundModel`.
   - **Logger** is clean except the one remaining host leak (§Open.2).
   - **SDK surface** center (Sessions/Session/Run + tagged errors + `defineTool`,
     pure Effect, no in-package `runPromise`) is minimal; the redundancy is at the
     edges (§Open.1).

3. **Plan API-surface simplification.** Unchanged in direction: the durable-harness
   "extend" half (`Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute`,
   `Session.resume`) plus the frozen-list shrink AGENTS.md names — not ratification
   of the 2026-09-10 static-export manifest (§Open.1). The SDK speaks pure Effect
   end-to-end; the Promise boundary is deliberately gone.

4. **Design subagent boundaries.** Already first-class, re-confirmed unchanged:
   (a) native subagents via `executeAgent` with an owned `RunId`
   (`tools/delegation/inBandSubagentRun.ts`); (b) the workflow-script run plus its
   `agent()` grandchildren; (c) the agent-CLI children (`claude_code`, `codex`)
   through a provider-specific child-run strategy. The non-candidates (round
   output extraction, `compileCheck`, `LatexDiffManager`) still have no independent
   run or model lifecycle, so reifying one buys nothing. No boundary change
   warranted.

## Open (human-owned; carried, re-pinned)

1. **Re-scope the Tier-1 manifest around the harness SDK, not the 2026-09-10
   static list.** The live root entry (`packages/harness/src/index.ts`) exports the
   harness extend surface the old draft predates — `Plugin` (`@tools/plugins`),
   `Composition`, `AgentPlatform`, `Sessions`, `PluginContext`, `PluginsRefused`.
   `ToolHost` is confirmed **gone from the package** (an empty grep), so the
   2026-09-10 manifest's §3.1 still names a deleted type. The shed/leak questions
   that survive the pivot are unchanged: `SettingHost`
   (`@shared/state/stateSettings`, TeXRA's internal host enum reaching the public
   tool-definition contract) and the `MapToolRegistry`/`ToolContext` registry
   plumbing an embedder on the documented `defineTool` / `StartInput.tools` path
   never constructs. Retire or rewrite the 2026-09-10 draft against the harness
   program rather than ratify it. The manifest and durable-harness notes also now
   carry stale `packages/agent` paths; refresh them to `packages/harness` when next
   touched.

2. **The logger sink→Layer step is still unlanded.** `logSink.ts` still holds the
   mutable module global (`let sink = consoleLogSink`, `setLogSink`,
   `writeLogEntry`, ~165–199), set by host callers. It is the one real
   SDK-relevant host leak: `effect/runtime.ts` composes the process runtime but
   installs no sink, so an embedder of `@texra-ai/harness` gets whatever
   process-global sink is set and cannot inject its own through
   `Sessions.layer`/`AgentPlatform`, and two embedders in one process share one
   global. This rides `2026-09-21-effect-design-synchronous-facades.md` §5 step 6
   (the expensive step; it rewrites the kernel log-capture seam) and does not by
   itself deliver embedder injection through the public boundary.

3. **`packages/llm` ambient `*_CUSTOM_HEADERS` reads, still two.**
   `openaiResponsesRequest.ts:254` and `anthropicMessages.ts:715` (the latter now a
   throwing guardrail: "the selected binding must determine its request headers").
   Intentional guardrails; relocating the check to the host boundary is a
   per-factory relocation, not a lift (the `packages/llm/test-live/` callers
   construct factories without model access). Low priority; file into
   `2026-09-20-llm-package-hardening.md` or a fresh tech-debt entry.

## Resolved since the 2026-10-04 pass

- **`AgentRunLifecycle.ts` `finalizeRunTerminalBody` single-caller split** — gone;
  the symbol no longer exists. The last remaining marginal cleanup on the list is
  resolved.
- **The `modelBinding.ts` re-guard** (prior "do not trim" entry) retired with the
  file in the ModelAccess consolidation; the format/route-mismatch guard it
  described now lives in `modelAccess/routeDecision.ts` / `binding.ts`.

**Do not collapse** (unchanged): `executeAgent.ts` `resumeToolUse*` chain — each
level is a distinct `Effect.scoped`/`acquireRelease` region whose nesting order is
load-bearing for finalizer-before-release ordering.

## Recommendation

No refactor to land autonomously from this charter. The one owner-level action the
surface audit asks for is to **re-scope the Tier-1 manifest around the harness SDK**
(§Open.1) — now more clearly warranted, since the package the old manifest named
(`@texra-ai/agent`) no longer exists. The logger sink→Layer step (§Open.2) and the
two `packages/llm` ambient reads (§Open.3) are carried unchanged. Re-running this
audit as a routine will again add no signal until the durable-harness program
moves further (next: `Session.resume` after reopen, the public sink-injection
step, and the manifest re-scope).
