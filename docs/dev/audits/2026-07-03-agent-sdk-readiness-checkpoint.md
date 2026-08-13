# Agent SDK Readiness — Verification Checkpoint (2026-07-03)

> **Packaging note (2026-07-05):** #7099 later demotes/deletes the unused
> `@texra/core` package. Mentions below are historical checkpoint observations,
> not current workspace layout.

**Status:** Verification checkpoint. Read alongside the canonical
[`2026-05-30-agent-sdk-readiness.md`](../../proposals/2026-05-30-agent-sdk-readiness.md), the detailed
[`./2026-05-29-agent-sdk-readiness-audit.md`](./2026-05-29-agent-sdk-readiness-audit.md), the
[`2026-06-24-agent-sdk-readiness-delta.md`](../../proposals/2026-06-24-agent-sdk-readiness-delta.md)
addendum, and the `-2026-06-25` / `-2026-06-26` / `-2026-06-30` / `-2026-07-01` /
[`-2026-07-02`](./2026-07-02-agent-sdk-readiness-checkpoint.md) checkpoints.

This pass re-verified the standing audit against the working tree at HEAD
(`11e063e`, branch `claude/eager-noether-9y5i4s`), which contains the 07-02
checkpoint's base plus the subsequent PR train (#6904 typed Platform port for
tool-edit approval, #6905/#6906 CLI stream/proposal routing, #6908 desktop
orphaned-stream repair, #6909 agent-sync ownership). None of those touch the four
audit areas structurally.

## Why this exists

Another recurring "review and refactor for Agent SDK readiness" request landed,
scoped (as before) against the same four areas: **agent core + runtime**,
**`modelHandlers/`**, **logger + platform/public surface**, and **subagent
boundaries**. As on every prior pass, this checkpoint ran a **fresh, uninformed
3-way fan-out audit** (one reader for core+runtime, one for `modelHandlers/`, one
for logger+platform+public surface), then reconciled every finding against the
adjudicated rulings. The uninformed audit re-surfaced the known traps (filtered
out below) and re-confirmed the tracked candidates — **and it went one level
deeper into `src/agent/node/persistedFlow.ts` than any prior pass, surfacing a
genuine, unattended-safe pure deletion that the 07-02 checkpoint had explicitly
reported it could not find.** That deletion is applied this pass; everything else
is recorded as reviewed-train class.

## Verdict — unchanged

**The codebase remains well-aligned and SDK-ready in shape. No structural
refactoring is warranted.** The three fresh readers independently reached the
same conclusion the standing plan holds — most notably the `modelHandlers` reader
**rejected the "collapse the OpenAI-compatible subclasses" and "delete
`IModelHandler`" premises on its own**, and the core reader found **no**
`Node.exec → wrapper → coreFunction → createFlow → flow.run` ladders, **no**
trivial identity factories, and **no** two-layer `buildX`-only-from-`createX`
factories in the flow/node layer. The SDK-idiomatic spine is re-confirmed in-tree
at HEAD:

- **`createModelHandler` factory** — `PROVIDER_HANDLER_ROUTES` exhaustive
  `Record<ModelProvider, …>` (`ModelFactory.ts:54`), single `createModelHandler`
  entry (`:377`). Compatibility-key routing means an SDK-backed handler can drop
  in behind one case with zero caller changes.
- **`platform()` composition root** — `initPlatform` (`platform.ts:66`), frozen
  `platform()` accessor (`:74`). The single-call-site ports (`linter`,
  `addCriticismSink`, `toolMissingHandler`, `toolNotificationHandler`,
  `toolEditApproval`) each re-verified to have **three genuinely different
  implementations** (VS Code UI / Node no-op / test fake) — correct host seams,
  not accidental abstraction.
- **`AgentTrace` emit/subscribe channel** — `src/agent/trace/index.ts` still the
  single `emit()`/`subscribe()` surface; `debug/info/warn/error`, stages,
  streams, and domain helpers are sugar over `emit()`. This maps ~1:1 onto the
  Agent SDK streamed-message model.
- **No barrel regression** — `src/agent/core/index.ts` remains **absent**;
  `@texra/core` (`packages/core/src/index.ts`) is the one curated surface.
- **PocketFlow `Node.exec → createFlow().run` shape** and the
  **lead-and-specialists delegation model** — unchanged.

## Applied this pass — two confirmed-safe cleanups

### 1. `PersistedFlow.attach()` + `PersistedFlow.getRunId()` deleted (pure dead code)

`src/agent/node/persistedFlow.ts`. Both are genuine zero-caller dead code:

- `static async attach<S,P,Svc>(kv, runId, start)` (17 lines + JSDoc) — a
  documented "attach to an existing persisted flow for resume" factory. Verified
  **zero callers** across `src` + `packages` (grep for `.attach(`, `.attach<`,
  `PersistedFlow.attach` — only its own definition matched). The real resume path
  does not use it: `runToolUseFlow` / `runReflectionFlow` construct the flow
  directly and resume by reading the `FlowRecord` themselves. Speculative API
  surface for a distributed/resume-by-attach scenario no consumer exercises.
- `getRunId()` — verified **zero callers** repo-wide (only the definition
  matched). The `runId` field is retained (used internally by `flowKey(this.runId)`
  in `stepWithResult` / `getShared`).

Both are absent from all prior readiness docs (grep: 0 hits in the canonical doc,
the detailed audit, the delta, and every checkpoint), so this is a genuinely-new
find, not a re-open. This is the same **pure-deletion class the 06-30 checkpoint
applied unattended**; the 07-02 checkpoint reported "no equivalent unattended-safe
deletion" was found — this pass found one.

### 2. `PersistedFlow.init()` one-caller alias inlined

`init(shared)` was a pure pass-through to the private `ensureRecord(shared)`
with a single caller, `RoundPersistedFlow.run()` (`roundPersistedFlow.ts:138`).
Since `RoundPersistedFlow extends PersistedFlow`, `ensureRecord` was promoted
`private → protected`, `RoundPersistedFlow.run()` now calls it directly, and the
`init()` wrapper was deleted. Behavior-identical (this was candidate #1 below,
promoted to applied after confirming the single caller).

**Verification:** `npm run typecheck` — **exit 0** across all projects
(`tsc --noEmit`, test-kernel, `texra`, `@texra-ai/cli`) after both changes; the
full agent test suite — **888 passed / 4 skipped** — after both changes. `runId`
field retained (used internally by `flowKey(this.runId)`).

**Attempted and reverted — `createMediaContent(): any[] → unknown[]` (candidate #3
below).** Empirically **not** confirmed-safe: the abstract's `any` is load-bearing
for the `createMediaMessage` wrapper's `Promise<ReturnType<typeof
this.createMediaContent>>` return type — the base-class method resolves the
_abstract_ signature, so `any` silently flows through to concrete call sites in
`modelHandlerOpenAI` / `modelHandlerOpenRouterNative`. `unknown[]` produced 11
`TS2345`/`TS2322` errors there. A correct fix requires making
`createMediaContent` / `createMediaMessage` generic over the provider
content-part type — reviewed-train, not an unattended one-liner. Reverted; the
candidate is re-scoped below.

## Genuinely-new candidates — surfaced by this fan-out, absent from all prior docs

Confirmed by grep to appear in none of the canonical doc, the detailed audit, the
delta, or the 06-25 → 07-02 checkpoints. All are reviewed-train class (type /
signature / surface changes or design-direction notes); none is unattended-safe.

### Core / runtime

1. **`PersistedFlow.init()` one-caller alias** _(LOW)_ — **APPLIED this pass**
   (see § Applied #2). Left here for the record: `init(shared)` was a pure
   pass-through to private `ensureRecord(shared)` with the sole caller
   `RoundPersistedFlow.run()`; `ensureRecord` promoted to `protected` and the
   wrapper deleted. Typecheck + full suite green.

2. **Two divergent round-loop mechanisms for the same control-flow shape**
   _(MEDIUM — design consistency, note-only)_. The reflection flow drives its
   round loop through a dedicated `RoundPersistedFlow` subclass (~250 LOC,
   `run()` owns `while (shouldContinueNextRound) …`), while the tool-use flow
   expresses the identical "run the cycle again" loop as an **in-graph edge**
   (`waitNode.on(FlowTransition.CONTINUE, cycleNode)` in `runToolUseFlow.ts`).
   `RoundPersistedFlow` is instantiated exactly once (`runReflectionFlow.ts`). A
   reader must learn two mental models for one shape. Longer term, converging on
   one looping mechanism (preferably the graph edge, see § SDK divergence) is the
   highest-leverage structural move — but it is not a quick delete and is flagged
   for direction, not action.

### Model handlers

3. **`createMediaContent` returns `any[]` on the abstract base member**
   _(MEDIUM — re-scoped after an empirical attempt this pass)_.
   `ModelHandler.ts:823` — `abstract createMediaContent(mediaMessage:
MediaEntry[]): any[]` — the lone `any` on an abstract member in a class that
   otherwise preserves full `<M,U,T,C,Resp>` generic typing. **The naive fix
   (`any[] → unknown[]`) does not work** — see § Applied's revert note: the
   abstract `any` flows through the `createMediaMessage` wrapper's
   `ReturnType<typeof this.createMediaContent>` return type and `unknown` breaks
   11 concrete call sites. The real fix is to make `createMediaContent` /
   `createMediaMessage` generic over the provider content-part type (each
   override already returns a concrete type: `ContentBlockParam[]`,
   `ChatCompletionContentPart[]`, `ResponseInputContent[]`, `ChatContentItems[]`,
   `MediaEntry[]`). Reviewed-train (a real generics refactor, not a one-liner).

4. **`IModelHandler` role-split angle** _(MEDIUM surface — distinct from the
   adjudicated "delete `IModelHandler`" trap)_. The ~35-method port bundles two
   disjoint flow roles (reflection/workflow message-building vs tool-use
   dispatch) plus usage/pricing, yet no single consumer needs all of them —
   `followUpMessages.ts` **already** narrows via `Pick<IModelHandler,
'addMediaToUserMessage' | 'capabilities' | 'createUserFollowUpMessages'>`.
   Extending that `Pick<>` pattern into named role slices (`ISamplingHandler` /
   `IReflectionHandler` / `IToolUseHandler` / `IUsageHandler`, with
   `ModelHandler` implementing the union) would let a minimal SDK-backed provider
   satisfy only the slice it runs. **This is not the adjudicated trap** (which was
   _removing_ the interface as a duplicate of `ModelHandler` — still a trap; the
   optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` narrowing keep it
   load-bearing). Type-only refactor, reviewed-train.

### Logger / platform surface

5. **`@platform` barrel is a near-dead facade** _(LOW surface)_.
   `src/platform/index.ts` exists to make the CLAUDE.md-mandated
   `import … from '@platform'` path real, but only **4 files** use it while **79**
   bypass it via the deep `from '@platform/platform'`. Two valid paths for
   identical symbols; the convention the barrel enforces is followed ~5% of the
   time. Pick one — codemod the 79 deep imports to `@platform`, or delete the
   barrel and bless `@platform/platform` in CLAUDE.md (the deep path is already
   declared "stays valid," so deletion is lower-effort). Reviewed-train
   (import-path churn).

6. **`@logger/index.ts` is a 1-symbol barrel** _(TRIVIAL)_. It re-exports only
   `createChannelTrace`; the real logger API (`debug/info/warn/error`,
   `redactSecrets`, `setOutputChannelFactory`, …) is reached by 164 direct
   imports of `@logger/logUtils` / `@logger/redaction`. The barrel gives a false
   impression of being a curated facade. Either promote the real API into the
   index or drop the 1-line index. Cosmetic; opportunistic.

## Adjudicated traps the fan-out re-surfaced — rulings held

The uninformed audit raised, and the standing rulings correctly filter, all of
the following. No change.

| Re-surfaced candidate                                                                      | Ruling                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collapse OpenAI-compatible subclasses (DeepSeek/Kimi/MiniMax/GLM) to a config table        | **Trap** — the `modelHandlers` reader rejected this itself: each carries real per-provider override points (`getThinkingParameter` shapes, reasoning-wire fields, temperatures, token-count APIs). Only DashScope (1 flag) + XAI are genuinely thin. |
| Remove `IModelHandler` as a "duplicate" of `ModelHandler`                                  | **Trap** — optional `createBatchedToolUseFollowUpMessages?` + `Pick<>` consumer narrowing make it load-bearing (see new candidate #4 for the distinct _split_ angle).                                                                                |
| Inline `createResponse → withCreateResponseGuard → sdkErrorTagger`                         | **Keep** — each hook has a distinct real overrider (OpenAIResponse in-flight guard; per-SDK tagger; per-handler impl).                                                                                                                               |
| Provider getters `isGrokReasoningModel` / `isDeepSeek` / `isKimi` / `isMiniMax` are "dead" | **VERIFIED FALSE** (detailed audit) — used by `modelHandlerOpenAI` / `ModelHandlerOpenRouterNative`; the live angle is _placement_ (07-02 candidate #7), still reviewed-train.                                                                       |
| `ModelFactory` two-layer / trivial-identity factories                                      | **No violation** — `createModelHandler` + `createModelHandlerForCompatibilityKey` are two real entry points sharing logic (justified DRY); routes give compile-time exhaustiveness.                                                                  |
| Inline the cycle-wrapper nodes / `createXCycleFlow` factories                              | **Keep** — this _is_ the mandated `Node.exec → createFlow → flow.run` shape.                                                                                                                                                                         |
| Collapse `runAgent` / `runAgentStream` dual entry / add a `runtime/index.ts` barrel        | **Trap** — deliberate naming; `@texra/core` **is** the curated barrel.                                                                                                                                                                               |
| `AgentTrace` over-layered / platform single-call-site ports are over-abstraction           | **Keep** — trace is one `emit()` SSoT (SDK-shaped); the thin ports each have three divergent host impls.                                                                                                                                             |
| Two logging idioms (`logUtils` vs `createChannelTrace`) are "redundant"                    | **Known / tracked** — run-scope vs module-singleton split targeted by `docs/prds/2026-05-17-logger-surface-cleanup.md`; the reader's "narrow `createChannelTrace` to 4 methods for log-only singletons" is the same tracked cleanup, not novel.      |
| `runToolUseAgent` / `runReflectionAgent` are single-caller wrappers                        | **Keep** — each owns genuinely category-specific wiring (progress-turn counting / follow-up side effects vs per-round callback); inlining bloats `executeAgent`. The reader flagged them as defensible, not must-fix.                                |
| Test-only injection seams on `runReflectionFlow` (`getOutputFileLocation?` etc.)           | **Keep** — legitimate DI-for-testability; production caller passes neither.                                                                                                                                                                          |

## Structural divergence from the Agent SDK loop — re-stated (no new action)

The three divergences remain the accurate picture of where TeXRA's shape differs
from the SDK's flat `query()` generator loop; all are justified capability, not
over-abstraction:

1. **Nested two-flow execution.** The SDK's single "model call + tool dispatch"
   loop is TeXRA's _inner_ cycle flow (`createResponseCycleFlow` /
   `createToolUseRoundFlow`); an outer persisted flow drives rounds and bridges
   services across the boundary. The nesting exists for persistence, not
   ceremony. Highest-leverage SDK-alignment move (candidate #2) is to converge
   the two round loops and consider collapsing the inner cycle flow into nodes of
   the outer flow, making "one model call + tool dispatch" a graph edge.
2. **Persistence-first design.** Every node step is `structuredClone`'d to a KV
   store so a run resumes after a VS Code reload — a real product requirement with
   no SDK counterpart (this is _why_ the loop can't be a plain generator, and why
   the now-deleted `attach`/`getRunId` speculative resume surface was never
   needed).
3. **Rich human-in-the-loop coordination.** `BasePromiseCoordinator` +
   plan-approval / proposal / manual-retry coordinators implement interactive
   gates the SDK collapses to a single `canUseTool` permission callback. Additive
   capability.

## Subagent split points — re-confirmed, unchanged

No change to the canonical/delta analysis. TeXRA already ships a **mature
subagent mechanism**: YAML agent profiles ≈ SDK `AgentDefinition`; `delegate_agent`
/ `delegate_workflow` + `executeSubagent` = the isolated-context delegation
primitive (with `NESTED_DELEGATION_DEPTH_RANGE` depth policy and worktree
isolation); the `claude_agent` tool embeds `@anthropic-ai/claude-agent-sdk`
directly, and `codex` mirrors it. The three highest-confidence already-isolated
units a formal decomposition would draw on are unchanged:

- **`ModelFactory.createModelHandler`** — `(modelName) → handler`; the "model
  provider" unit.
- **`assembleAgentLaunchContext`** — `(launchInput) → launchContext`; the "define
  an agent" half of the SDK model.
- **`agentToolResolution`** — `(declaredTools, gates) → effectiveTools`; the SDK's
  tools-as-data resolver, a pure pipeline.

Split points ranked by value/effort (unchanged from 06-26 → 07-02):

1. Wire the existing `review` tool-use agent as a post-draft Verifier delegation
   (lowest risk; reuses `executeSubagent`, no new flow code).
2. Introduce a typed `delegateTo(subagent, input, { maxDepth, tools })` primitive
   over the existing plumbing.
3. Formalize workflow agents (`polish` / `correct` / `merge`) as SDK actors with
   typed I/O contracts.
4. Relocate the remaining module-global registries onto the per-session handle —
   gates concurrent in-process sessions (agent registry + `agentDirectoriesRegistry`
   are the concrete targets).
5. Decompose in-agent multi-phase workflow agents (`devise`, `verifyFix`) into
   draft → Verifier → apply hand-offs — gated by #4.

## Recommendation

**SDK-ready in shape; no structural refactoring warranted.** Two confirmed-safe
cleanups applied this pass: the `PersistedFlow.attach` + `getRunId` dead-code
deletion and the `PersistedFlow.init` one-caller-alias inline (both typecheck +
full-suite green). A third attempt (`createMediaContent` typing) was made,
empirically found unsafe as a one-liner, and reverted — re-scoped to a generics
refactor. Continue the canonical plan's surface / multi-tenant track through the
reviewed PR train: port narrowing (incl. the `IModelHandler` role-split and the
`createMediaContent` generics), per-session state relocation, the typed
`delegateTo` primitive, and wiring `review` as the first Verifier delegation.
Fold the remaining candidates above into that train — none of them is an
unattended sweep. Do not re-open the adjudicated traps.

## Verified (this checkpoint)

- Spine re-confirmed by grep at HEAD `11e063e`: `PROVIDER_HANDLER_ROUTES` +
  `createModelHandler` (`ModelFactory.ts:54/377`), `initPlatform` / `platform`
  (`platform.ts:66/74`), `AgentTrace` emit/subscribe (`trace/index.ts`),
  `src/agent/core/index.ts` **absent** (no barrel regression).
- Applied deletion verified: `grep "static async attach\|getRunId"
src/agent/node/persistedFlow.ts` → **0** after edit; both had **0** callers
  across `src` + `packages` before deletion; absent from all prior readiness docs
  (0 grep hits). `runId` field retained.
- Applied inline verified: `PersistedFlow.init` had exactly **1** caller
  (`RoundPersistedFlow.run()`, `roundPersistedFlow.ts:138`); `ensureRecord`
  promoted `private → protected`; `grep "\.init(" src/agent/node` → **0** after
  edit. `createMediaContent any[] → unknown[]` attempted → **11 TS errors**
  (`modelHandlerOpenAI` / `modelHandlerOpenRouterNative`) → reverted.
- Both applied changes verified green: `npm run typecheck` **exit 0** (all four
  projects); `npx vitest run src/test-kernel/agent/` — **888 passed / 4 skipped**.
- Other candidates verified in-tree: `RoundPersistedFlow` instantiated once
  (`runReflectionFlow.ts`); `createMediaContent(): any[]` (`ModelHandler.ts:823`);
  `Pick<IModelHandler, …>` already in `followUpMessages.ts`; `@platform` barrel
  4 importers vs 79 deep-path; `@logger/index.ts` 1 re-export vs 164 deep imports.
- Model-handler thin-subclass measurement corroborated independently: DashScope
  14 LOC (1 config flag `convertContentToString`), XAI 38 LOC (1 debug log),
  GLM 51, vs DeepSeek 113 / MiniMax 120 / Kimi 148 (real per-provider overrides)
  — collapse remains lossy; the config-driven `PROVIDER_HANDLER_ROUTES` registry
  is already the right shape and each thin class keeps a persisted
  `compatibilityKey`.
- `npm run typecheck` — **exit 0** across all projects (`tsc --noEmit`,
  test-kernel, `texra`, `@texra-ai/cli`) after the deletion.
