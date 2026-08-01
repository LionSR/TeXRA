# Agent SDK Readiness — Verification Checkpoint (2026-07-29)

**Status:** Verification checkpoint. Read alongside the prior
[`2026-07-27-agent-sdk-readiness-checkpoint.md`](./2026-07-27-agent-sdk-readiness-checkpoint.md),
the foundation-gap analysis
[`2026-07-26-agent-sdk-foundation-gap.md`](../../proposals/2026-07-26-agent-sdk-foundation-gap.md)
(§6 absorption sequence, §7 acceptance criteria, §9 the real ceiling), the audit
of record [`../dev/audits/2026-07-25-agent-sdk-readiness-audit.md`](./2026-07-25-agent-sdk-readiness-audit.md),
the plan of record [`2026-07-09-agent-sdk-north-star.md`](../../proposals/2026-07-09-agent-sdk-north-star.md),
and the `-06-25` → `-07-27` checkpoint chain.

This pass inspected the tree afresh at HEAD `25c0cb1`
(`refactor: make response text processing host supplied (#9376)`; `CHANGELOG.md`
heading `[Unreleased]`). The `-07-27` checkpoint pin `55ee72b` **is** an ancestor
(`git merge-base --is-ancestor` succeeds); `git rev-list --count 55ee72b..HEAD`
reports **166 commits**. This pass re-inspected the tree at HEAD and reconciled
against the standing record; it did not perform a commit-by-commit audit of that
range.

**Run context (honesty note).** This was an **unattended scheduled run** with **no
external adversarial review available**. It therefore applies **no code change** —
see "No change lands." The discipline is the one the `-07-22` checkpoint's
applied-then-reverted `MapToolRegistry` mistake established: this class of change
needs a reviewer outside the pass's own analysis, which an unattended run lacks.
Method this pass: four parallel read-only deep-dives (model handlers, agent
core + flow engine, runtime + public surface, logging + trace), each returning
file:line-cited findings, reconciled here against the standing record so
already-tracked items are not re-filed as fresh (the `-07-27` warning against
double-counting).

## Verdict — well-aligned; one genuinely new structural observation

**The codebase remains well-aligned and SDK-ready in shape; no new structural
refactoring is warranted this pass.** The core-shape conclusion every checkpoint
since `-06-26` has reconverged on holds unchanged, and the `packages/agent`
public surface — `runAgent(input): AgentRun` where
`AgentRun extends AsyncIterable<AgentEvent>` + `{ result, interrupt() }`
(`packages/agent/src/index.ts:71-74,201`) — **is** the north-star
`run(agent, input) -> stream/result` shape, already implemented and honest about
what it cannot yet do (approval tools rejected `:207`; interactive retry denied
`:231`).

**The one item worth surfacing that prior checkpoints have not named:** the
**inner, non-persisted cycle flows** pay full PocketFlow ceremony for zero
persistence benefit (§New-1). It is a structural simplification opportunity, not
a defect, and — like everything else here — is recorded, not applied.

## Spine invariants — re-verified at HEAD `25c0cb1`

- `src/agent/core/index.ts` **absent** (no barrel regression).
- `IModelHandler = Pick<ModelHandler<…>>` (`src/agent/types/IModelHandler.ts:41`),
  **43** picked members.
- `Node.exec → createFlow().run` shape intact: `ResponseCycleNode.exec()` creates
  and runs the cycle flow inline, no wrapper.
- **0** `vscode` imports across all declared VS Code-free zones (`src/agent`,
  `model`, `latex`, `tools`, `controllers`, `shared`, `replacement`, `eventBus`,
  `hosts`, `logger`).
- `MapToolRegistry` still `Map<string, ITool> | Record<string, ITool>` with the
  `instanceof Map` branch (`ToolTypes.ts:51`) — the reverted `-07-22`/`-07-23`
  state, correctly not re-attempted.
- `agentCreator/` still contains **0** `Node`/`Flow`/`@agent/node` references — a
  linear async function, not a flow; CLAUDE.md's "not a flow" note is accurate.

## Movement since `-07-27` (spot-checks, not a full audit)

- **`stateOwnership` tail (§9.5) continues to shrink:** **7** live non-test
  references at HEAD (was 8 at `-07-27`). `ProgressBackend` now holds 4
  (`:75,107,115,379`), `ProgressViewState.load` 2 (`:519,530`), desktop 1
  (`desktopAgentExecution.ts:214`). The `ProgressBackend:294,315` references the
  `-07-27` checkpoint enumerated are gone. Acceptance row 1's "symbol absent"
  target is still not met, but the absorption is progressing through the correct
  (attended) channel.
- **`#9376` (HEAD) made response-text-processing host-supplied** — consistent with
  the host-decoupling direction; no VS Code-free-zone regression introduced.

## Remaining gaps — the real ceiling (§9), re-verified present at HEAD

Unchanged in substance from `-07-27`; all still present:

1. **Tool registry still closed.** `IToolRegistry = { get, has }`
   (`ToolTypes.ts:41-44`), no public `register`; 6 tools hard-coded in
   `createDefaultTools()` (`src/tools/registry.ts`). An embedder cannot add a
   tool. Correctly last on LoC, first on foundation.
2. **Product types still leak into the runtime launch path.** `toolConfig`
   carries LaTeX booleans (`autoCompileInputPdf`, `src/shared/schemas/toolConfig.ts:11`);
   `AgentFlowResult.compileFailures` (`:34`) rides the generic flow result;
   `RunAgentOptions.preferHelperModel` (`runAgent.ts:54,82,92-96`) is still a VS
   Code "fix LaTeX" flag on root-launch options. The `AgentEvent` union likewise
   carries TeXRA-domain arms as first-class members (`updateCompileFailures`,
   `updateMissingOutputs`, `goalPaused`) rather than routing them through the
   `domain` escape hatch — the same product-out-of-runtime split, seen from the
   event surface.
3. **`IModelHandler` port width (44 members) and `SdkToolCall` vendor-type
   embedding** remain the standing strategic port-shape item. `IModelHandler` is
   still auto-derived `Pick<ModelHandler>`, so this is a surface-shape
   observation, not drift. The model-handler deep-dive below gives concrete
   _how_ detail (collaborator extractions) under this known _what_.
4. **NS-1 host→core public surface.** Hosts still reach `@agent/*` deep
   specifiers frozen by the enforcing ratchet; no Tier-1 manifest yet.
5. **Partial: `stateOwnership` not fully retired** (see "Movement" above — 7 refs).

## Deep-dive findings — reconciled against the standing record

Each finding is tagged **[TRACKED]** (already on the record; do not re-file as
new) or **[NEW]** (not previously named in the checkpoint chain, to the best of
this pass's reading). Effort S/M/L. All are recorded for an attended maintainer
pass; none are applied here.

### Already-tracked — cited for completeness, not fresh

- **[TRACKED] Model-handler god-class → collaborator extractions.** `ModelHandler`
  (`ModelHandlers/ModelHandler.ts`, 2068 LOC, 6 generics, 16 abstract methods)
  mixes provider adaptation with credential/wire-route policy (~13 methods + a
  `WeakMap`), client-side compaction (~11 methods, one self-contained state
  machine), and agent-run orchestration (`checkStopConditions`, `shouldContinue`,
  `initializeOutputAndPrefill`, which take `AgentRunStateSnapshot`/`AgentConfig`).
  A clean adapter answers "given messages, produce+extract a response"; the rest
  is a `CredentialRouter` collaborator and a `ClientCompactor` collaborator the
  handler should _hold_, plus flow-layer decisions. This is the concrete
  decomposition under standing gap §9.3 (port width). **L**, safety-sensitive
  (feeds usage accounting and the fingerprint guard that prevents replaying a
  stale compaction payload and losing a user message). The ~10 single-override
  predicate getters are **settled work (#7101)** — do not re-litigate.
- **[TRACKED] `createChannelTrace` fabricates a full inert `AgentTrace` to serve
  as a plain module logger.** 35 non-test module singletons do
  `const logger = createChannelTrace('X')` and only ever call `debug/info/warn/error`
  (`channelTrace.ts:30-40`, over `logUtils` `writeLine`). The clean shape is a
  4-method `ChannelLogger`; this is the `-07-08`/`-07-12`/`-07-18` +
  `logger-surface-cleanup` PRD standing item. **M.** One caller must stay
  exempt: `ModelHandler.ts:292-298` needs the full `TraceEmitter` for `openStream`
  before the per-run trace is swapped in.
- **[TRACKED] `@agent/index` barrel conflates run vs manage.** The barrel exports
  ~25 symbols; the SDK facade uses exactly two (`loadAgents`, `resolveAgent`).
  Roster/directory management (`AgentRosterController` 521 LOC,
  `AgentDirectoryService` 4 injected ports) is host/UI concern reached through the
  same barrel a run-path consumer imports. Splitting "run" (load/resolve) from
  "manage" (roster/directory) is the NS-1 (§9.4) surface question, seen from the
  registry side. **M.**

### New this pass — recorded for maintainer re-derivation

- **[NEW] §New-1 — the inner, non-persisted cycle flows are ceremony over a
  while-loop. (L; the standout structural finding.)** `ResponseCycleFlow.ts`
  (685 LOC) and `ToolUseRoundFlow.ts` + `toolUseRound/*` (~1100 LOC) are each
  built and run _inside one outer persisted node's `exec()`_
  (`ResponseCycleNode.ts:105`, `ToolUseCycleNode.ts:101`) as plain `Flow`, not
  `PersistedFlow`. Their shared objects are **never written to the KV store** —
  only the _outer_ `ReflectionFlowState`/`ToolUseRunShared` persist — so a
  mid-cycle crash re-runs the whole cycle. Yet they pay full ceremony: 4–5
  `BaseNode` subclasses each, `FlowTransition` string routing, and dedicated
  "cycle shared" Zod schemas (`CycleFieldsSchema`, `BaseCycleFieldsSchema`,
  `ToolUseRoundFieldsSchema`) that are **never `.parse()`d** — independently
  re-verified this pass: `grep` for `.parse`/`.safeParse` on those schema names
  returns **0**. The graphs are near-linear state machines (prep→invoke→process→
  continuation with a `CONTINUE→prep` loop-back). Collapsing each inner flow into
  its owning node's body (a plain async loop, keeping `ModelInvocationNode`'s
  retry as a helper) removes ~5 node classes + 1 never-parsed schema + two of the
  four services layers (`ResponseCycleServices`/`ToolUseRoundServices`), and cuts
  the snapshot-schema surface substantially. **Important boundary:** this critique
  applies **only to the inner, non-persisted flows.** The _outer_ persisted flows
  (reflection round-loop, tool-use WAIT/CONTINUE loop) earn their node graph — the
  per-node cursor is the crash/suspend-resume granularity; do not coarsen it.
  **Caveat:** `createResponseCycleFlow`/`createToolUseRoundFlow` are the codebase's
  main unit-test seam (≥6 vitest suites import them directly), so this is a
  deliberate test-restructuring, not a deletion.
- **[NEW] §New-2 — canonical-vs-legacy snapshot twin duplication, stamped three
  times. (M.)** The legacy-migration union `AgentWorkspaceStateSnapshotSchema`
  (`AgentWorkspaceState.ts:381`) forces a parallel "canonical only" schema at
  every nesting site: `AgentWorkspaceCurrentSnapshotSchema` (`:332`),
  `ReflectionFlowStateCanonicalSchema` (`ReflectionFlowState.ts:83-86`),
  `StateSlicesCanonicalSchema` (`tooluse/nodes/types.ts:33-35`), plus
  `fromSnapshot` vs `fromCanonicalSnapshot` (`:435,448`). The legacy arm is needed
  only at the _one_ first-hydration boundary. Normalizing the legacy `todos`/`plan`
  shape once at the storage read boundary (a `.prefault`/`.transform` on read)
  lets the live schema keep a single canonical form and the `*CanonicalSchema` /
  `fromCanonicalSnapshot` twins disappear. This is the house Zod rule
  ("normalize legacy formats once at the entry point") applied. Safest sequencing:
  do §New-2 _before_ §New-1, so the flows aren't touched while the schema twins
  still exist.
- **[NEW] §New-3 — `Node.retryPrompt`/`execFallback` manual-retry machinery lives
  in the generic engine. (M.)** `node/index.ts:119-224` bakes `retryPrompt`,
  `shouldAutoRetry`, and `execFallback` into the generic `Node`, but the only real
  user is `RetryableInvocationNode` (`RetryState.ts`); every other node subclass
  inherits an unused manual-retry surface. For an SDK, the generic `Node` should
  be the ~50-line prep/exec/post + basic p-retry, with the retry-prompt behavior
  on `RetryableInvocationNode`.
- **[NEW] §New-4 — dual run-identity representation. (M.)** `createRunScope` is a
  one-line `Object.freeze` (`RunScope.ts:23-25`) with a single production caller
  (`AgentLaunchContext.ts:393`); it exists only because `RunContext` has two
  variants — `launch` (carries `runScope`) and `bare` (flat fields, "test/one-shot
  contexts only", `RunContext.ts:238-243`) — routed through six accessor functions
  that dispatch on `context.kind` (`RunContext.ts:174-223`). Collapsing `bare` to
  also carry a `RunScope` deletes `RunScope.ts`, the `getRunContextField` dispatch,
  and the discriminator. Cost is the ~40 test `createRunContext({...})` call sites.
- **[NEW] §New-5 — two thin `createModelHandler` entrypoints. (S; lowest-risk.)**
  `createModelHandler` and `createModelHandlerForCompatibilityKey`
  (`ModelFactory.ts:427,457`) both delegate to the same private impl and differ
  only in whether a compatibility key is passed; the caller branches on which to
  call (`AgentLaunchContext.ts:293-306`). Collapse to one
  `createModelHandler(config, category, rtp, compatibilityKey?)`.
- **[NEW] §New-6 — `AgentRun` should own its own `events`/`interactions`. (M.)**
  The `packages/agent` facade hand-subscribes
  `session.events.subscribe(..., { scope: 'run' })` and filters by `streamId`
  itself (`packages/agent/src/index.ts:109-122`), and reaches into
  `AgentRunHandle` for interrupt. A `run.events` accessor on the returned object
  (already half-built as `AgentRunStream`) would remove `SessionEventHub` and
  `AgentRunHandle` from the consumer's vocabulary — the run object should own its
  stream, not the session. Pairs with the standing observation that two result
  shapes (`AgentFlowResult` vs `AgentFinalResult`, with a rename projector at
  `AgentFinalResult.ts:89` as the drift canary) and two `HostInteractions` shapes
  sit below the SDK line; unify results _before_ freezing a public result type.
- **[NEW] §New-7 — redaction path-stripping never runs on the primary log sink.
  (S; possible silent-degradation defect — worth a look, not a confirmed leak.)**
  `redactSecrets` accepts `homeDir`/`workspacePath` options to strip filesystem
  paths (`redaction.ts:88`), but the main output-channel sink calls
  `redactSecrets(message)` with **no options** (`logUtils.ts:77`), independently
  re-verified this pass, and the CLI stream-log sink does the same
  (`subscribeStreamLog.ts:119` etc.). Only the desktop app-log passes
  `redactionOptions` (`desktopAppLog.ts:63,71-81`). So secret-token patterns _are_
  stripped everywhere, but **path redaction only runs in the desktop app-log
  export** — the VS Code output channel and CLI transcript get paths un-redacted.
  Either the option is dead on the hot path (remove it) or the main sink should
  receive it (fix the gap); the current state is silent partial coverage, which
  the "silent degradation is a defect" rule targets. Security-sensitive — validate
  against the redaction test suite before any change.

## Subagent boundaries (task item 4) — the seams already exist

The subagent architecture is the **strongest-factored part of the runtime**; the
task's "identify logical units that could run as independent agents" is largely
answered by naming the existing seams rather than inventing new ones:

1. **`ChildRunStrategy<TTurn>` is THE subagent seam (split point #1).** One
   host-agnostic driver `startChildRunLoop` (`childRunLoop.ts:499`) runs **four**
   concrete strategies: native subagent (`nativeSubagentStrategy.ts:138`), codex
   CLI (`codex.ts:441`), claude CLI (`claudeAgent.ts:461`), workflow-script
   (`workflowScriptStrategy.ts:145`). A future "custom subagent provider" SDK is
   exactly an external `ChildRunStrategy` implementation — publish
   `ChildRunStrategy` + `startChildRunLoop` + `ChildRunPorts` (`childRunLoop.ts:69`).
2. **`nativeSubagentStrategy` is the "run a TeXRA agent as a subagent" adapter
   (split point #2)** — its `launch`/`runTurn` wrap `executeAgent`
   (`nativeSubagentStrategy.ts:244`) and `resumeToolUseFromResumeData` (`:291`).
   This is why `executeAgent`'s low production-caller count (2) is **not** an
   inline signal — folding it into `runAgent` would break the subagent engine's
   ability to reuse the run engine without re-registering.
3. **Lineage/detach seam (split point #3):** `reserveChildActivation`
   (`executionRegistry.ts:667`) + `getActiveChildren`/`detachActiveChildren`/
   `interruptActiveChildren`, with `detachSubagentsOnStop()`
   (`detachSubagentsOnStop.ts:17`, one clean policy read) +
   `AgentExecutionHandle.detach()` — "promote a subagent to a top-level run" is
   already a first-class operation.
4. **Core-level boundary:** `runToolUseFlow({ isSubagent })` + `ToolUseWaitNode`
   suspends the persisted flow at `FlowTransition.WAITING`
   (`ToolUseWaitNode.ts:121-126`); delegation tools (`delegate_workflow`,
   `delegate_agent`, `executions`) dispatch through
   `tools/delegation/subagentExecution.ts` → `runToolUseFlow`. The tool call is
   the right SDK granularity for a nested agent.
5. **Cleanly extractable unit: the reflection `OutputNode`** (378 LOC,
   `reflection/nodes/OutputNode.ts`) does compile/latexdiff/lineage/validation,
   touches almost none of the model/conversation state, and is the most natural
   candidate to become a separately-testable "compile & diff" boundary.
6. **The load-bearing non-abstractable coupling:** parent-delivery via
   `deliverTurn` → `submitPendingDelivery` (`childRunLoop.ts:399,464`) routes
   results back through the parent's follow-up queue with careful ordering (#8093).
   Any "subagent as an independent process" story must replace this in-process
   handoff with IPC/RPC — the current design does not (and need not yet) abstract
   it. Flag it so a distributed-subagent SDK doesn't assume the seam is free.

## Notable strengths (unchanged, re-affirmed)

- The SDK target shape is implemented and honest (`packages/agent`, 491 LOC).
- `createResponse`/`extractResponse` template method (`ModelHandler.ts:1165-1212`)
  is textbook — the one clean provider contract to keep as the SDK core.
- `IModelHandler = Pick<ModelHandler>` prevents port drift by construction; the
  problem is width, not derivation.
- `SdkToolCall` discriminated union already replaced per-provider type guards.
- `ChildRunStrategy` unification (one driver, 4 providers, VS Code-free) is the
  model the rest of the runtime should aspire to.
- `SessionHandle` deliberately is _not_ a conversation API and says so, citing the
  shipped-then-deleted Anthropic shape (`SessionHandle.ts:26-31`).
- Single trace emit boundary (`TraceEmitter.emit`) with per-subscriber exception
  isolation; per-instance (not module-singleton) `AsyncLocalStorage` stage scope.
- The three buses (`AgentEvent` run-scoped / `SessionFact` session-scoped /
  `AppSignals` process-scoped) are genuinely distinct by lifetime — **none should
  collapse.** The only cost is shared "fact" vocabulary between `RunFactEvent`
  arms and `SessionFact`; a "which bus for what" doc line, not a merge.

## No change lands (by design this pass)

Consistent with every unattended checkpoint since `-07-22`. Even the lowest-risk
candidate this pass could see — §New-5, the two `createModelHandler` entrypoints
— was **not applied.** The `-07-22` revert and the `-07-27` `taskType` sequel are
the worked examples: a grep-justified "obviously safe" change can hide an
incomplete caller census, and only an out-of-pass reviewer reliably catches it.
§New-7 (redaction) is security-sensitive and stays recorded, not touched.
`MapToolRegistry` re-checked and still `Map | Record` with the `instanceof Map`
branch — **do not re-attempt the narrowing without a deliberate compatibility
boundary for `Map` inputs.**

## Coverage gaps (honest scope of this pass)

- Alignment against the live `code.claude.com/docs/en/agent-sdk` docs was **not**
  re-fetched; the standing verification is carried forward.
- No commit-by-commit audit of the 166-commit `55ee72b..HEAD` range — a fresh
  state inspection at HEAD reconciled against the standing record instead.
- Findings tagged [NEW] were produced by focused read-only deep-dives and are
  cited to file:line; the two most consequential factual claims (§New-1's
  never-parsed schemas, §New-7's un-optioned redact call) were independently
  re-derived this pass. The rest are reported at deep-dive scope, not full
  forensic caller-census scope — re-derive before any edit, per the standing rule.
- This checkpoint lives under `docs/proposals/` (internal, excluded from the
  texra.ai publish allowlist) — not a root-level doc, so it does not touch the
  `docs-root-boundary` gate.
