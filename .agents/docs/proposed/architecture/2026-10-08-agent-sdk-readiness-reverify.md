# Agent SDK readiness re-verify: the 2026-10-08 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the 2026-10-04 pass (`2026-10-04-agent-sdk-readiness-reverify.md`),
which is now deleted; version control keeps it, per `.agents/docs/README.md`.

Pin: verified against branch `claude/eager-noether-avb5l0` at `f668a87`. The
2026-10-04 pass's pin, `ae953c3` (branch `claude/eager-noether-hiwxl7`), is not
reachable from this shallow clone, so the delta below is read from the tree
itself, not a `git rev-list` range. The headline delta is the one that pass
anticipated: **the harness package-split landed**
(`2026-10-02-harness-package-split.md`). `packages/agent` is gone;
the SDK package is now `packages/harness` (`@texra-ai/harness`). `@texra-ai/agent`
survives only in prose inside `.agents/docs/**` (historical references) — a grep
of `packages/**/src` for it is empty. Alignment has **held or improved**,
entirely through the human-owned program, not this routine.

## What moved since 2026-10-04 (all human-owned, none from this routine)

- **Package rename / split.** `packages/agent` → `packages/harness`;
  `@texra-ai/agent` → `@texra-ai/harness`. CLAUDE.md, `src/README.md`,
  `packages/harness/README.md` and the path aliases are all consistent with the
  new name. There is no `@texra/core` (deleted by #7099); the SDK surface is
  `@texra-ai/harness`, built and fenced, not published.
- **Model handler kept shrinking.** `runtime/run/modelBinding.ts` is now **423
  lines**, down from the 966 the 2026-10-04 pass cited (itself down from 1037).
  The bound-`Model` route and its deliberate exceptions are unchanged.
- **SDK center `effect/` decomposed.** The single `effect/runtime.ts` the prior
  pass named is gone; the directory is now
  `effect/{sessions,sessionPrograms,runHandle,requestAnswerer,errors}.ts`. This
  is an Effect-native decomposition of one surface, not an added tier — the
  public barrel (`index.ts`) still re-exports from it with no in-package
  `Effect.run*`.
- **Run loop folded further.** `loop/rounds.ts` (the round-mode entry the prior
  pass cited) is gone; the loop is now
  `loop/{toolUse,runProgram,step,rows,toolUseDispatch,toolGuard,modelSwitch,hooks}.ts`
  — still one `Effect` per run appending one history.
- **Subagent delegation grew its own home.** `tools/delegation/`
  (`childRun.ts`, `detachedChildRun.ts`, `inBandSubagentRun.ts`,
  `subagentRun.ts`) plus `runtime/{childRunLoop,nativeSubagentStrategy,scriptRun}.ts`.
  The boundaries the charter asks about are now first-class and more legible
  than the prior pass described, not less.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter. Four
read-only audits — one each over the agent core, the model handler, the logger,
and the SDK public surface — again found **no wrapper layer that only forwards,
no second run-history writer, no services-bag, no re-export shim**. The one
consensus fix the prior pass applied (the six-error reconcile) survived the
rename intact: `packages/harness/README.md:355` and
`packages/harness/src/effect/errors.ts:2` both state "Six" and name the two
store errors, matching the six error values the root entry exports. The
`refuted-candidates.json` ledger remains the authoritative refused set; nothing
in these areas reopened a retained refusal.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Re-confirmed under the new package path:
   - Agent core: `packages/harness/src/agent/core/` (`definition/`, `state/`,
     `tools/`) — three modules (see `agent/core/README.md`). Run program
     `@agent/runtime/loop/toolUse.ts` over the run history; the run loop's model
     call is `@agent/runtime/ModelInvoker.ts` (with `helperModel.ts` and
     `run/compaction.ts` invoking the bound `Model` directly — deliberate
     exceptions, not a second handler).
   - Model handler: provider calls are reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model` bound by `runtime/run/modelBinding.ts` (423
     lines). Deliberate exceptions outside that route are unchanged (audio
     transcription builds `OpenAI` directly; the `codex`/`claude_code` tools
     load their own provider SDKs; the settings-view consent probe acquires a VS
     Code `Model`).
   - Logger: `packages/harness/src/logger/`
     (`effectLog.ts`, `logSink.ts`, `effectDiagnostics.ts`, `formatLogData.ts`,
     `redaction.ts`).
   - SDK surface: `packages/harness` (`@texra-ai/harness`) — `index.ts`,
     `node.ts`, `schemas.ts`, `plugins.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways.
   - **Agent core** is still written defensively against the exact anti-patterns
     the charter names. The only net-negative candidate carried is cosmetic
     (`AgentRunLifecycle.ts` `finalizeRunTerminalBody`, one caller, exists only
     to be wrapped in `Effect.uninterruptible`) — not worth a churn.
   - **Model handler** continues to de-duplicate (the 966→423 shrink). The
     `Model` interface still takes only a Zod-guarded materialized `TurnRequest`
     and keeps host concerns in `BoundModel`.
   - **Logger** is a clean host-agnostic producer port (`Effect.log*` +
     `withLogChannel`) with a single render→redact→truncate owner
     (`logSink.ts`). One structural item is still open — the sink→Layer
     conversion (§Open.2).
   - **SDK surface** center (Sessions/Session/Run + tagged errors + `defineTool`,
     pure-Effect, no in-package `runPromise`) is minimal and clean; the
     redundancy is at the edges, and the manifest that was meant to pin it is now
     further behind the live surface (§Open.1).

3. **Plan API-surface simplification.** Unchanged in direction, sharper in
   degree. The plan is the accepted durable-harness program
   (`2026-10-02-durable-harness.md`, status: accepted) — its "extend" half
   (`Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute`,
   `Session.resume`) plus the frozen-list shrink AGENTS.md names — **not**
   ratification of the 2026-09-10 static-export manifest. The SDK speaks pure
   Effect end-to-end; the Promise boundary is deliberately gone.

4. **Design subagent boundaries.** Already first-class, re-confirmed and now
   better-factored (see §What moved): (a) native subagents via `executeAgent`
   with an owned `RunId` (`runtime/nativeSubagentStrategy.ts`); (b) the
   workflow-script run plus its `agent()` grandchildren (`runtime/scriptRun.ts`);
   and (c) the agent-CLI children (`claude_code`, `codex`) through the
   `tools/delegation/` detached-child path with provider-specific strategies.
   No boundary change is warranted; the non-candidates (round output extraction,
   `compileCheck`, `LatexDiffManager`) still have no independent run or model
   lifecycle.

## Genuinely open (carried, still human-owned — not this routine's to land)

1. **Re-scope the Tier-1 manifest around the harness SDK, and now also against
   the rename.** `2026-09-10-agent-sdk-tier-1-manifest.md` (status: proposed) is
   stale two ways: it predates the durable-harness pivot *and* it is written
   entirely against the deleted `packages/agent` / `@texra-ai/agent` names (its
   §3.1 export table, the `npm run typecheck:agent` / `@texra-ai/agent/{schemas,node}`
   entries). The live root entry (`packages/harness/src/index.ts`) now exports on
   the order of **35 runtime values plus ~50 type-only names** — well beyond the
   manifest's pinned "34 (10 values, 24 types)" — the jump driven by the split
   pulling the platform ports, `Secrets`, `LanguageModel`, the request-error
   union and the tool-probe types up into the one root entry. The move is to
   retire or rewrite the manifest around the harness SDK, not to ratify the old
   static list (which would pin a deleted package name and omit the `Plugin` /
   `Composition` extend surface the pivot is built on). INDEX.md:26 still labels
   that row "The `@texra-ai/agent` public surface" — the same rename staleness.
2. **The logger sink→Layer step is still unlanded.** `logSink.ts` still holds
   the mutable module global (`let sink = consoleLogSink`, `setLogSink`,
   `writeLogEntry`), set by host callers; the harness runtime composition
   (`effect/sessions.ts` and `@controllers/session/sessionLayer`) installs no
   sink, so an embedder of `@texra-ai/harness` inherits whatever process-global
   sink is set and cannot inject its own through `Sessions.layer`/`AgentPlatform`,
   and two embedders in one process share one global. This is still the one real
   SDK-relevant host leak; it rides
   `2026-09-21-effect-design-synchronous-facades.md` §5 step 6 (the expensive
   kernel-seam step) and, by itself, does not yet deliver embedder injection
   through the public boundary — that is a further, not-yet-designed public-API
   step.
3. **`packages/llm` ambient reads: still two, still to file.** The ambient
   `process.env.*_CUSTOM_HEADERS` guards are `anthropicMessages.ts:715` and
   `openaiResponsesRequest.ts:254` (line numbers shifted as the files grew; the
   count is unchanged from the prior pass's two). They are intentional
   guardrails; relocating them to the host boundary (`modelBinding.ts`) is a
   relocation that must be passed into every factory, not a lift (the
   `packages/llm/test-live/` callers construct the factories without
   `modelBinding`). Low priority; file into
   `2026-09-20-llm-package-hardening.md` or a fresh tech-debt entry.

## Recommendation

No refactor to land autonomously from this charter. The one consensus fix the
prior pass carried (the six-error reconcile) is already in place and survived
the rename. "Agent SDK readiness" now tracks the durable-harness program
(`2026-10-02-durable-harness.md` H1–H5); the one owner-level action the surface
audit still asks for is to **re-scope (or retire) the 2026-09-10 Tier-1 manifest
around the `@texra-ai/harness` SDK** — it is now stale against both the pivot and
the package rename (§Open.1). The logger sink→Layer step (§Open.2) rides the
synchronous-facades note; the two `packages/llm` ambient reads (§Open.3) still
need filing. As the prior pass predicted, re-running this audit as a routine
adds no new structural signal — the standing value is the pin refresh and the
rename reconcile recorded above; the next real motion is the harness program's,
not this routine's.
