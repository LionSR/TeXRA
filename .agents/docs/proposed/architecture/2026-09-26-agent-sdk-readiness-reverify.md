# Agent SDK readiness re-verify: the 2026-09-26 pass

Status: proposed

Origin: the recurring scheduled "review and refactor for Agent SDK readiness"
charter — identify the agent core, model handler, logger and surface areas;
audit each for unnecessary abstraction; plan API-surface simplification; design
subagent boundaries; document findings. This note is the finding, and it
supersedes the [2026-09-24 pass](../../archived/architecture/2026-09-24-agent-sdk-readiness-reverify.md),
which is now archived.

Pin: verified against branch `claude/eager-noether-q6bj0r` at `f0811a0`. The
2026-09-24 pass's pin, `7326fb4`, is itself PR #13094 ("model providers are
plugin contributions"), so it is the baseline, not part of the delta. It is an
ancestor of `f0811a0`, and the range is deterministic:
`git rev-list --count 7326fb4..f0811a0` is 189 commits, of which 65 touch the
audited areas (`src/agent`, `src/model`, `src/logger`, `packages/llm/src`,
`packages/agent/src`). Every intervening commit in those areas is a human-owned
PR continuing the same program the standing note named — e.g. #12886/#13249
(retire `logUtils`, every producer logs through Effect or the sink), #13236 (the
retry offer is decided once by the retry owner), #13293 (a prepared turn is
parsed once), #13274 (typed run-lifecycle errors), #13271 (workflow scripts are
generators over an Effect interpreter), each verified present in
`7326fb4..f0811a0` and absent from `7326fb4`. Alignment
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
     the run loop's model call is `@agent/runtime/ModelInvoker.ts` (with
     `helperModel.ts` and `run/compaction.ts` invoking the bound `Model`
     directly — deliberate exceptions, not a second handler, as the 2026-09-24
     note recorded).
   - Model handler: run-loop chat/model-turn provider calls are reached only
     through the `packages/llm` (`@texra-ai/llm`) `Model` bound by
     `runtime/run/modelBinding.ts`. Exceptions outside that route remain and are
     deliberate: audio transcription builds `OpenAI` directly in
     `src/tools/media/audio.ts`; the Codex tool uses `@openai/codex-sdk` and the
     Claude Code tool loads `@anthropic-ai/claude-agent-sdk`'s `query()`
     (`src/tools/claudeAgent.ts`); and the settings-view consent probe
     (`SettingsViewMessageHandler.ts:403-438`) acquires a VS Code `Model` and
     runs its own `prepareTurn`/`generateTurn` to confirm language-model access.
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
     `BoundModel` — clean enough to publish, with only the small edge items in
     §New.3 (one real ambient-read leak; one framing correction).
   - **Logger** is reached through a clean host-agnostic _producer_ port
     (`Effect.log*` + `withLogChannel`), and the render→redact→truncate pipeline
     is single-owner. Steps 1–5 of the sync-facades program have landed; the one
     remaining step is the sink→Layer conversion (§New.2).
   - **SDK surface** center (Sessions/Session/Run + tagged errors + `defineTool`,
     pure-Effect, no in-package `runPromise`) is minimal and clean; the
     redundancy is at the edges (§New.1, §New.3).

3. **Plan API-surface simplification.** The plan remains the Tier-1 public
   manifest (`2026-09-10-agent-sdk-tier-1-manifest.md`, still `proposed`) plus
   the frozen-list shrink AGENTS.md names. The SDK already speaks pure Effect
   end-to-end; the Promise boundary is deliberately gone, not missing.

4. **Design subagent boundaries.** Already first-class, re-confirmed. The
   model-driven run boundaries are: (a) native subagents via `executeAgent` with
   an owned `RunId` minted by `subagentRun.ts`; (b) the workflow-script run plus
   its `agent()` grandchildren; and (c) the agent-CLI children (the `claude_code`
   and `codex` tools, `src/tools/{claudeAgent,codex,agentCliShared}.ts`), which
   mint their own run IDs and run through `startDetachedChildRunLoop` with
   provider-specific `ChildRunStrategy` implementations — a distinct family
   outside `executeAgent`, not workflow grandchildren. The other candidates a
   charter tends to
   name — reflection output extraction (`loop/reflection.ts` `processOutput`),
   `compileCheck`, `LatexDiffManager`, `runAgentCreator` — are effectful sub-run
   stages (file extraction and host presentation; file/settings reads and
   LaTeX/latexdiff subprocesses; and, for the creator, a helper-model call
   before writing YAML and driving host UI). They are not "pure data," but none
   has an **independent run or model lifecycle** of its own — no owned `RunId`,
   no model turn through `ModelInvoker`, no roster entry — so that, not purity,
   is why an agent boundary buys nothing: reifying one would wrap a run
   lifecycle, roster entry and delivery choreography around work that has no
   lifecycle to own, fighting the "no flow engine / one Effect per run" rule
   while still owning its real interruption and resource-lifetime needs inline.
   No boundary change is warranted.

## New since the 2026-09-24 pass (needs an owner, not a routine)

1. **The Tier-1 manifest has drifted a third time — re-enumerate before
   ratifying.** `2026-09-10-agent-sdk-tier-1-manifest.md` §3.1 lists `ToolHost`
   as a root export and does **not** list `ToolGuard` or `SettingHost`. The live
   `packages/agent/src/index.ts:68-73` exports `ITool`, `IToolRegistry`,
   `ToolGuard`, and `SettingHost`, and no longer exports `ToolHost`. The manifest
   header already records two prior drifts; this is a third. (The §3.1 header
   count "34 (10 values, 24 types)" also moves under the same swap, so the
   re-enumeration should correct the tallies, not just the names.) Ratifying the
   draft as-is would pin the wrong names, so a re-enumeration is a prerequisite
   for the ratification step, not a substitute for it. Shed/leak candidates the
   re-enumeration should weigh (all invisible to the dead-export ratchet, which
   exempts the public barrel):
   - The registry surface should be weighed export-by-export, not swept: a tool
     enters only through `StartInput.tools?: readonly ITool[]` and
     `defineTool`→`DefinedTool`, so no public signature takes an
     `IToolRegistry`, and `MapToolRegistry` is registry plumbing an embedder
     using the documented path never constructs. But `ToolGuard` is **not**
     unreachable — `ITool.guard` and `DefinedTool.guard` are both typed
     `ToolGuard`, so it rides the documented tool path and must stay;
     `IToolRegistry` is likewise named by the exported `MapToolRegistry`
     declaration. So the shed question is really `MapToolRegistry` (and, only if
     it goes, `IToolRegistry`), not `ToolGuard`.
   - `SettingHost` reaches the surface via `DefinedTool.unavailableHosts` /
     `ITool.unavailableHosts` — TeXRA's internal host enum leaking into the
     public tool-definition contract an embedder has no notion of.
   - The declared error set is six tagged errors (`AgentNotFound`,
     `PlatformConflict`, `RunFailure`, `ToolsRefused`, `DatabaseOpenFailed`,
     `DatabaseReadFailed`), but `README.md:203` and `effect/errors.ts` still say
     "four." Reconcile the count and the "no more" comment.

2. **The logger sync-facades program is at its last step.** Steps 1–5 of
   `2026-09-21-effect-design-synchronous-facades.md`'s six-step plan have landed —
   `logUtils.ts` (deleted in step 5), `createLog`, `channelTrace.ts`,
   `withLogData`, and the `debugMode` carrier (`isDebugModeEnabled`/
   `setDebugModeConfig`/`DebugModeConfig`) are all gone from `src`/`packages`.
   Only step 6 (design §5, "the sink becomes a Layer") remains: `src/logger/logSink.ts:165-186` still holds a
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
   Once it lands, `effectDiagnostics.ts` merges into the sink module — and the
   rewrite must preserve **both** its production callers: `sessionLayer.ts:1127`
   (the process runtime) and `packages/extension/src/extension.ts:498`, the
   latter a failed-activation cleanup path that supplies diagnostics after the
   runtime holding its logger layer is gone.

3. **One small `packages/llm` cleanliness item, plus one framing correction.**
   These fall in the territory of `2026-09-20-llm-package-hardening.md`, but that
   note's §0 records its five planned changes as closed and mentions neither, so
   they are **not** already owned there — they need filing (into that note or a
   fresh tech-debt entry) rather than being deferred to it:
   - **Not a published-surface leak** (correcting the audit's first framing):
     `packages/llm/package.json` exports `"./prefix-fingerprint"`, reached only
     by two kernel tests (`admittedFingerprint`); production uses relative
     imports. But `@texra-ai/llm` is `"private": true` and unpublished, and its
     README makes the `exports` map the enforced boundary every consumer —
     tests included — must go through (no filesystem-alias bypass). So this is
     not a leak and cannot simply be "shed to a test-only path" without either
     recreating the contract or breaking that boundary rule. At most it is a
     minor question of whether a purely test-only symbol deserves a package
     subpath; low priority, and constrained by the exports-map rule.
   - Three sites read `process.env.{OPENAI,ANTHROPIC}_CUSTOM_HEADERS` inside
     otherwise-pure codec factories — `openaiChat.ts:525`,
     `anthropicMessages.ts:465`, and `openaiResponsesRequest.ts:348` (in
     `responseAuthentication`). These are the only ambient-process reads in the
     package. Intentional guardrails (preserve the behavior). For a pure `Model`
     boundary the check ideally moves to the host boundary (`modelBinding.ts`) —
     but that is a relocation, not a deletion, and only safe if the guard is
     preserved for callers who construct the exported factories directly
     (`packages/llm/test-live/` calls `openaiChatModel`/`openaiResponsesModel`/
     `anthropicMessagesModel` without `modelBinding`). A naive move to
     `modelBinding` alone would silently drop the guardrail for those direct
     callers, so the check must be passed explicitly into every factory (or the
     SDK configured to ignore the ambient variables) rather than simply lifted.

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
- **Shrink the `host-agent-import` frozen list** as the manifest ratifies each
  edge (its `agent` row is the internal-coupling width a Tier-1 barrel must
  re-export or seal); never widen. (`effect-migration` is not coupled to the
  manifest — its only live row is the two permanent `new AbortController()`
  foreign-adapter sites, which a ruling protects; it shrinks by code conversion,
  not by ratifying exports, so it is out of scope for this deliverable.)
- **Owner ruling on the two agent-creation systems** (`texra.createAgentWithAI`
  wizard vs. the `creator` tool-use agent), per
  `2026-09-23-ssot-ownership-survey.md` §2 — changes user-visible behaviour and
  reverses two rulings, so it is not a routine's call.

## Recommendation

No refactor to land autonomously from this charter. The single new,
concrete action for an owner is to **re-enumerate the Tier-1 manifest against
`index.ts` before ratifying it** (§New.1). The logger sink→Layer step (§New.2) is
owned by `2026-09-21-effect-design-synchronous-facades.md` §5/step 6 and should
ride it; the `packages/llm` items (§New.3 — one real ambient-read leak, one
framing correction) are in the hardening note's territory but not yet recorded
there (that note is closed), so they need filing before they have an owner. Re-running this audit as a routine will again add no signal until the
manifest is re-enumerated and moves.
