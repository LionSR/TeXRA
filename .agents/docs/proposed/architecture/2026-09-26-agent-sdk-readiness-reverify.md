# Agent SDK readiness re-verify: the 2026-09-26 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the [2026-09-24 pass](../../archived/architecture/2026-09-24-agent-sdk-readiness-reverify.md),
which is now archived.

Pin: verified against branch `claude/eager-noether-q6bj0r` at `f0811a0`, which
is **20 merged PRs ahead** of the 2026-09-24 pass's pin (`7326fb4`) in the
audited areas (`src/agent`, `src/model`, `src/logger`, `packages/llm/src`,
`packages/agent/src`). Every one of those PRs is human-owned and continues the
same program the standing note named — e.g. #12886/#13249 (retire `logUtils`,
every producer logs through Effect or the sink), #13236 (the retry offer is
decided once by the retry owner), #13293 (a prepared turn is parsed once), #13274
(typed run-lifecycle errors), #13094 (model providers as plugin contributions),
#13271 (workflow scripts are generators over an Effect interpreter). Alignment
has **improved**, entirely through review, not this routine.

## Verdict (unchanged)

The codebase is still well-aligned, and this audit remains a standing program,
not a gap. No autonomous refactor is warranted from this charter: every safe
candidate in these areas is already filed, already landed, or already recorded
as refused with a ruling (`config/ratchets/refuted-candidates.json`). Four
read-only audits — one each over the agent core, the model handler, the
logger, and the SDK public surface — found **no wrapper layer that only
forwards, no second ledger writer, no services-bag, no re-export shim**. The
large files are large because of irreducible durability/resume/stop
invariants, not accreted indirection. The open work is ratification and
manifest-writing, which needs an owner, not a routine.

What makes this pass worth recording — the 2026-09-24 note set the bar as "re-
running adds no signal until the manifest moves" — is that the Tier-1 manifest
draft has now **drifted a third time** against the live surface (§New.1), so
the one named open deliverable has degraded and must be re-enumerated before it
can be ratified.

## The four asks, re-mapped to the current pin

1. **Identify the areas.** Unchanged from the 2026-09-24 map and re-confirmed:
   - Agent core: `src/agent/core/` (`definition/`, `state/`, `tools/`); run
     programs `@agent/runtime/loop/{toolUse,reflection}.ts` over the run ledger;
     the one model call is `@agent/runtime/ModelInvoker.ts`.
   - Model handler: provider APIs reached only through the `packages/llm`
     (`@texra-ai/llm`) `Model` bound by `runtime/run/modelBinding.ts`.
   - Logger: `src/logger/` (`effectLog.ts`, `logSink.ts`, `effectDiagnostics.ts`,
     `formatLogData.ts`, `redaction.ts`).
   - SDK surface: `packages/agent` (`@texra-ai/agent`) — `index.ts`, `node.ts`,
     `schemas.ts`, `effect/`.

2. **Audit for unnecessary abstraction.** Done, four ways, this pass:
   - **Agent core** is exceptionally disciplined — written defensively against
     the exact anti-patterns the charter names ("no cursor and no graph," "it is
     a composition record, not a facade"). `run/modelBinding.ts` already
     collapsed its three switches into one exhaustiveness-checked
     `PROTOCOL_DESCRIPTORS` table; `loop/{toolUse,reflection}.ts` already share
     scaffolding through `loop/runProgram.ts`; `SessionHandle.ts` deliberately
     re-exposes owners as fields rather than forwarding per-method. The only
     net-negative candidates found are two low-impact single-caller collapses
     (§Cleanups), both below the worthwhile-change bar.
   - **Model handler** is already heavily de-duplicated: the chat family is one
     codec serving all seven OpenAI-compatible protocols; the Responses
     five-file split is a shared-codec split (HTTP and WebSocket share every
     lowering module), not duplication; the per-provider message-lowering loops
     target four incompatible SDK wire types and cannot share without a mapping
     layer heavier than the code it removes. The `Model` interface takes only a
     Zod-guarded materialized `TurnRequest` and keeps every host concern in
     `BoundModel` — clean enough to publish, with two small leaks (§New.3).
   - **Logger** is reached through a clean host-agnostic *producer* port
     (`Effect.log*` + `withLogChannel`), and the render→redact→truncate pipeline
     is single-owner. Steps 1–4 of the sync-facades program have landed; the one
     remaining leak is the sink-injection side (§New.2).
   - **SDK surface** center (Sessions/Session/Run + tagged errors + `defineTool`,
     pure-Effect, no in-package `runPromise`) is minimal and clean; the
     redundancy is at the edges (§New.1, §New.3).

3. **Plan API-surface simplification.** The plan remains the Tier-1 public
   manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`, still `proposed`) plus
   the frozen-list shrink AGENTS.md names. The SDK already speaks pure Effect
   end-to-end; the Promise boundary is deliberately gone, not missing.

4. **Design subagent boundaries.** Already first-class, re-confirmed: the only
   real model-driven boundaries are (a) native subagents via `executeAgent` with
   an owned `RunId` minted by `subagentRun.ts`, and (b) the workflow-script run
   plus its `agent()` grandchildren. The other candidates a charter tends to
   name — reflection output extraction (`loop/reflection.ts` `processOutput`),
   `compileCheck`, `LatexDiffManager`, `runAgentCreator` — are deterministic
   sub-run library stages (or, for the creator, a helper-model wizard below the
   run machinery). Reifying any of them as an agent boundary would add a run
   lifecycle, roster entry and delivery choreography around pure data work: pure
   indirection that would fight the "no flow engine / one Effect per run" rule.
   No boundary change is warranted.

## New since the 2026-09-24 pass (needs an owner, not a routine)

1. **The Tier-1 manifest has drifted a third time — re-enumerate before
   ratifying.** `2026-09-10-agent-sdk-tier-1-manifest.md` §3.1 lists `ToolHost`
   as a root export and does **not** list `ToolGuard` or `SettingHost`. The live
   `packages/agent/src/index.ts:68-73` exports `ITool`, `IToolRegistry`,
   `ToolGuard`, and `SettingHost`, and no longer exports `ToolHost`. The manifest
   header already records two prior drifts; this is a third. Ratifying the draft
   as-is would pin the wrong names, so a re-enumeration is a prerequisite for the
   ratification step, not a substitute for it. Shed/leak candidates the
   re-enumeration should weigh (all invisible to the dead-export ratchet, which
   exempts the public barrel):
   - Registry types `IToolRegistry`, `ToolGuard` and the value `MapToolRegistry`
     are reachable from no public signature — a tool enters only through
     `StartInput.tools?: readonly ITool[]` and `defineTool`→`DefinedTool`.
   - `SettingHost` reaches the surface via `DefinedTool.unavailableHosts` /
     `ITool.unavailableHosts` — TeXRA's internal host enum leaking into the
     public tool-definition contract an embedder has no notion of.
   - The declared error set is six tagged errors (`AgentNotFound`,
     `PlatformConflict`, `RunFailure`, `ToolsRefused`, `DatabaseOpenFailed`,
     `DatabaseReadFailed`), but `README.md:203` and `effect/errors.ts` still say
     "four." Reconcile the count and the "no more" comment.

2. **The logger sync-facades program is at its last step.** Steps 1–4 of
   `2026-09-21-effect-design-synchronous-facades.md` have landed —
   `logUtils.ts`, `createLog`, `channelTrace.ts`, `withLogData`, and the
   `debugMode` carrier (`isDebugModeEnabled`/`setDebugModeConfig`/
   `DebugModeConfig`) are all gone from `src`/`packages`. Only §5, "the sink
   becomes a Layer," remains: `src/logger/logSink.ts:165-186` still holds a
   mutable module global (`let sink = consoleLogSink`, `setLogSink`,
   `writeLogEntry`), set by five host callers. This is the one real
   SDK-relevant host leak: `packages/agent/src/effect/runtime.ts` composes
   `installProcessRuntime` but installs no sink, so an embedder of
   `@texra-ai/agent` gets whatever process-global sink happens to be set, cannot
   inject its own through `Sessions.layer`/`AgentPlatform`, and two embedders in
   one process share one global. The fix is already designed (the
   `diagnosticsLayer({ write, trusted, minimumLogLevel })` parameter beside the
   existing `lean`/`usageLog`/`globalDatabase` layer params); it is human-owned
   because it is the expensive step (it rewrites the kernel log-capture seam).
   Once it lands, `effectDiagnostics.ts` (one production caller) merges into the
   sink module.

3. **Two small, real surface leaks in `packages/llm`** (territory of
   `2026-09-20-llm-package-hardening.md`):
   - `packages/llm/package.json` exports `"./prefix-fingerprint"` with **zero
     production importers** — only two kernel tests reach `admittedFingerprint`
     through it; production uses relative imports. A published package should not
     expose an internal continuation-anchoring digest as a subpath. Shed the
     export entry; have the tests import via a test-only path.
   - `openaiChat.ts:525` and `anthropicMessages.ts:465` read
     `process.env.{OPENAI,ANTHROPIC}_CUSTOM_HEADERS` inside otherwise-pure codec
     factories — the only ambient-process reads in the package. Intentional
     guardrails (preserve the behavior), but for a pure `Model` boundary the
     check belongs at the host boundary (`modelBinding.ts`), a relocation, not a
     deletion.

## Marginal cleanups (tech-debt-tier, not for this routine)

Recorded so a future owner has the file:line, and so they are not mistaken for
churn worth a standalone PR:

- `AgentLaunchContext.ts:324` `assembleAgentLaunchContext` — one caller
  (`buildAgentLaunchContext` at :520); the outer adds only an
  `Effect.onError(finalizeRun)`. Collapsible, behavior-preserving, low benefit.
- `AgentRunLifecycle.ts:136` `finalizeRunTerminalBody` — one caller; exists only
  to be wrapped in `Effect.uninterruptible`. Cosmetic split.
- `modelBinding.ts:1027-1037` — a re-guard whose `protocol === 'vscode-lm'` and
  `validation` disjuncts are unreachable (both branches already returned above);
  only the `route.kind` mismatch case is live. Trim to the reachable check.

**Do not collapse** (flagged so they are not mistaken for the above):
`executeAgent.ts` `resumeToolUse*` three-level chain — each level is a distinct
`Effect.scoped`/`acquireRelease` region whose nesting order is load-bearing for
finalizer-before-release ordering (comments at `:531-535`, `:604-613`).

## Genuinely open (carried from 2026-09-24, still human-owned)

- **Ratify the Tier-1 public manifest** — now gated on the re-enumeration in
  §New.1.
- **Shrink the frozen lists** (`host-agent-import`, `effect-migration`) as the
  manifest ratifies each edge; never widen.
- **Owner ruling on the two agent-creation systems** (`texra.createAgentWithAI`
  wizard vs. the `creator` tool-use agent), per
  `2026-09-23-ssot-ownership-survey.md` §2 — changes user-visible behaviour and
  reverses two rulings, so it is not a routine's call.

## Recommendation

No refactor to land autonomously from this charter. The single new,
concrete action for an owner is to **re-enumerate the Tier-1 manifest against
`index.ts` before ratifying it** (§New.1); the logger sink→Layer step (§New.2)
and the `packages/llm` leaks (§New.3) are already owned by their respective
proposals and should ride those. Re-running this audit as a routine will again
add no signal until the manifest is re-enumerated and moves.
