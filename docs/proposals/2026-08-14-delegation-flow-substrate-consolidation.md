# Delegation and flow substrate consolidation: the remaining ten debts

Status: proposal (plan of record for execution ordering)
Date: 2026-08-14

## Framing

The big unifications across the agent flows and multi-agent dispatch have
landed: one child-run loop with a single delivery site (`ChildRunStrategy` /
`startChildRunLoop`), one delivery envelope (`deliveryEnvelope.ts`) shared by
native subagents, workflow-script runs, agent-CLI children, and background
bash, one typed chaining result (`AgentFinalResult`), one launch primitive
(`createNativeSubagentStrategy`), one run identity (`RunIdentity`, per
`2026-08-03-run-classification-consolidation.md`), and the detached
workflow-script strategy (`workflowScriptStrategy.ts`, reversing the sync
special case per `2026-07-17-workflow-script-async-execution.md`).

What remains is a short, specific list. This document ranks the ten debts
still standing across `src/agent/core/flows/`, the two flow implementations,
`src/tools/delegation/`, `src/agent/runtime/childRunLoop.ts`, and
`src/agent/workflowScript/`, and turns them into an execution plan. Four of
the ten are already claimed by existing proposals and need execution, not
design; four are real but unclaimed until this document; two are cheap
honesty fixes.

This is a consolidation plan, not a re-design. The architecture rulings that
bound it are restated in "Non-goals" and are not to be relitigated here.

## The ten debts, ranked

Rank is blast radius × correctness risk, not size.

### 1. Layering inversion: `@tools/delegation` ↔ `executeAgent` cycle

**Claimed** — H4 in `2026-08-10-simplifier-fleet-round1-strategy.md`; named a
Step-3 SDK blocker.

The cycle `@tools/registry → DelegationTools → proposalFlow →
subagentExecution → executeAgent → registry` is papered over with two lazy
`await import('./nativeSubagentStrategy.js')` edges
(`subagentExecution.ts`, `inBandSubagentExecution.ts`; documented at
`subagentExecution.ts` header), and `childRunLoop.ts` (runtime layer) imports
persistence and delivery formatting from `@tools/delegation` (tools layer).

**Fix.** Break the cycle at the root as H4 prescribes; both lazy edges retire
together. Acceptance: no dynamic imports of `nativeSubagentStrategy`, no
`@tools/delegation` import from `src/agent/runtime/`, and the
`architecture-edges` ratchet baseline shrinks (never widens).

### 2. Cost accounting: three disciplines for one fact

**Unclaimed until now.**

Three sites account subagent cost three different ways:

- Loop path: `ChildRunLoopParams.recordCost` retains `max(bestCostUsd)`
  across turns and commits exactly once at run end
  (`childRunLoop.ts`, cost retention + single-commit).
- In-band path: `recordCost(options.onCost, totalCostUsd)` fires per
  observation (`inBandSubagentExecution.ts:464`) with no max-retention and no
  single-commit discipline.
- Workflow-script path: a three-level roll-up (grandchild `onCost` →
  `createWorkflowAttemptCostTracker` delta accounting in
  `workflowScriptStrategy.ts` → run-level `recordCost`), plus a separate
  journal-based settlement on the failure path that logs spend as unbilled,
  plus `invocation.report({ costUsd })` for snapshot display with a
  `recovered` guard so replayed journal entries are not re-billed.

Divergent accounting at seams is where silent double- or under-billing
lives; today correctness rests on each site independently honoring the
"child cost lands in parent totals exactly once" invariant that only the
loop path states.

**Fix.** One written contract for child-cost observation: who observes
(ports), who retains (max vs delta — the answer differs by attempt model and
must be stated, not implied), who commits, and when. Then make the in-band
path honor it (it is the outlier: per-event forwarding with no retention
policy). Extend `WorkflowScriptCost.vitest.ts` and add an in-band cost test
pinning single-commit behavior. This is a contract-and-tests change first;
code movement only where a site violates the written contract.

### 3. The in-band path is a degraded copy of the loop path

**Unclaimed until now.**

`executeInBand` (`inBandSubagentExecution.ts:389`) drops progress
notifications entirely (`notify: () => {}`, `:463`) and passes
`strategy.launch` a fresh `AbortController` (`:467`) that no caller retains a
reference to — the only live cancellation is `options.signal` threaded via
`bindAbortSignals`. There is no lease-lost watchdog and no loop-level
interrupt handler. The workflow-script path compensates with its own event
channel (`WorkflowScriptEvent` projection); the headless `stopAfterCycle`
arm of `delegate_agent`/`delegate_workflow` simply loses both.

By the repo's own rule — silent degradation is a defect — this is debt even
where it has not yet caused a reported failure.

**Fix.** Two scoped changes, not a rewrite: (a) thread a real notification
sink for the `stopAfterCycle` arm (the parent is in-band, so "notify" can
degrade to trace-card emission rather than follow-up delivery — but
deliberately and documented, not via a silent no-op); (b) either retain and
wire the controller into the caller's cancellation scope or stop
constructing it and pass the bound signal explicitly, so the code states
what cancellation exists instead of implying cancellation that doesn't.
The in-band-vs-async *durability* split stays (see Non-goals).

### 4. Two independent concurrency budgets

**Half-claimed** — `2026-07-05-workflow-script-engine.md` §4 already states
"the same semaphore should eventually gate LLM-driven delegation too";
unbuilt.

`ToolUseDispatchNode` runs parallel-safe tool calls under a local
`PQueue({ concurrency: 4 })` (`MAX_PARALLEL_TOOL_CALLS`,
`ToolUseDispatchNode.ts:33`). The workflow-script engine runs `agent()`
calls under its own semaphore (default 4). An orchestrator combining direct
parallel-safe tool calls with a running workflow script can hold up to both
budgets at once, and neither is provider-rate-aware.

**Fix.** One run-scoped (eventually provider-aware) budget both draw from,
owned in `@agent/runtime` (not in either consumer), injected into the
dispatch node's queue and the engine's semaphore. Keep the engine's
*lifetime* call cap and fan-out caps where they are — those are script
governance, not concurrency.

### 5. Three event-folds over one `WorkflowScriptEvent` stream

**Claimed** — H2 in `2026-08-10-simplifier-fleet-round1-strategy.md`.

`workflowScriptDeliverySummary.ts`, `workflowScriptStrategy.ts`, and
`workflowScriptRun.ts` each independently fold the same event stream into
state — three chances to disagree about what a run did.

**Fix.** One fold owner producing one snapshot type; the other two consume
it. Per H2.

### 6. Lineage and identity residue

**Claimed** — steps 6–7 of
`2026-08-03-run-classification-consolidation.md` enumerate the exact sites.

Four open-coded `isChildExecution` copies, four open-coded ownership checks,
the `orchestratorStreamId`/`parentStreamId` naming split, three independent
`isSubagent` spellings at finalize, the fabricated
`DELEGATION_AVAILABILITY_CATEGORY` row (wrong for the bi-categorical
`delegate_multi_agents`), and — the sharpest edge — a second stream-id
derivation (`getStreamTabId(...)` in `subagentExecution.ts`, again in
`inBandSubagentExecution.ts`) that must *silently* match
`AgentLaunchContext`'s internal `reservedStreamId` formula. Nothing enforces
the match; a drift is a lineage bug with no error.

**Fix.** Execute the step-6/7 table as written. The stream-id formula
collapse comes first within this item: one exported derivation, both
call sites deleted, a test pinning equality with `AgentLaunchContext`.

### 7. Detached-launch lease choreography, three copies

**Claimed with a deliberately narrow ruling** — H3 in
`2026-08-10-simplifier-fleet-round1-strategy.md`.

`subagentExecution.ts`, `WorkflowScriptTool.ts`, and
`inBandSubagentExecution.ts` each hand-roll register + lease +
release-on-failure. H3's ruling: do **not** extract a shared launcher; move
only the register/lease/release-on-failure triplet next to
`captureOwnedExecutionLease` in `@agent/storage`. Execute exactly that.

### 8. The flow twins: mechanical duplication around the two flows

**Unclaimed until now** (individual pieces noted across audits; no single
owner).

- Two near-identical persisted-record hydration blocks:
  `runReflectionFlow.ts` (read → boundary-parse → `stampCompatibilityKey` →
  back-write → `PersistedFlowStateError`) and the same ladder in
  `runToolUseFlow.ts`.
- Two outer cycle nodes with the same skeleton and near-verbatim comments
  (`ResponseCycleNode` / `ToolUseCycleNode`), including twin
  `execFallback` → `buildFailedRetryInfo` converters.
- Two cancellation latches with inverted semantics (`continueRounds`
  cleared-on-cancel vs `userCancelledRetry` set-on-cancel).
- Two flow-record retention policies (reflection's implicit
  outcome-based rule vs the five-branch `preservationReason` ladder in
  `runToolUseFlow.ts`) — per
  `2026-06-10-lifecycle-status-ownership.md`, reconciling these is a
  deliberate, release-noted decision, not a silent merge.
- Comment-for-comment identical "log the opening transcript row in
  `finally`" blocks (`MediaExtractionNode` / `ToolUsePrepareNode`).

**Fix.** Extract the hydration ladder into one shared boundary helper in
`@agent/node/persistedFlow` (both call sites, parameterized by schema pair —
this is a multi-caller extraction, allowed). Leave the cycle-node skeletons
alone unless a later change touches both (the shared shape is the D6-fenced
kernel's job, and a forced merge is the super-cycle trap). Do not touch the
retention policies in this pass; if reconciled later, release-note it.

### 9. Misfiled and mislabeled modules

**Half-claimed** — D6's own fence
(`2026-07-09-state-of-the-architecture.md`) says `ResponseCycleFlow` moves on
next touch.

- `ResponseCycleFlow.ts` (~650 lines) + `ResponseCycleServices` sit in
  `core/flows/` with exactly one consumer, in reflection. Per the fence they
  belong under `implementations/flows/reflection/`, leaving `core/flows/` an
  honest kernel (`ModelInvocationNode`, `RetryState`, `CommonCycleTypes`,
  `postCompactionContext`, `BaseFlowServices`, `FlowTransitions`).
- `agentCreator/` lives under `implementations/flows/` while using zero flow
  machinery (no `BaseNode`, no `Flow`, no transitions) — it is one linear
  wizard function.
- `TaskState`'s row in `src/agent/core/README.md` presents a frozen wire
  projection (sole surviving boundary: the CLI NDJSON `setTaskState` event)
  as a live state model.

**Fix.** Relocations and one README correction. No re-export shims (house
rule). Whether `ToolUseRoundFlow` + `toolUseRound/` follow into
`implementations/flows/tooluse/` is decided at execution time by the same
test: single-consumer modules follow their consumer; the kernel keeps only
what both families use.

### 10. Observability asymmetry for workflow-script grandchildren

**Unclaimed until now.**

A successful `agent()` grandchild persists no `/executions/{id}/report`
(only `result` via `persistResultMetaRequired`); turn attribution
(`turnToken` stamping) exists only on the loop path; the workflow run wraps
its return value in a third delivery shape (the `<workflow-summary>` JSON
line in `workflowScriptStrategy.ts`); and the runner adds two post-conditions
that exist nowhere else (`outcome !== 'completed'` → throw; workflow
category with zero outputs → throw, `workflowScriptAgentRunner.ts`).
Debugging the same agent therefore uses different artifacts depending on
which tool launched it.

**Fix.** Decide, and write down in `src/agent/workflowScript/README.md`,
which asymmetries are contract (typed result instead of report is arguably
the feature) and which are gaps. Minimum concrete change: persist a report
for successful grandchildren too *or* document that `result` is the sole
artifact for scripted children and teach the `executions` tool's `report`
action to say so instead of returning nothing.

## Honorable mentions (tracked, not planned here)

- Workflow agents *can* declare `tools:` in YAML (shared
  `AgentSettingBaseSchema.tools`); definitions would be sent to the provider
  but a returned call is never dispatched — a latent silent-failure trap,
  currently moot because no shipped workflow YAML declares tools. A load-time
  warn (or schema-level rejection) on `tools:` in a workflow-category YAML
  would close it cheaply; fold into whichever of items 3/9 lands first.
- `ToolUseRunSharedSchema` is a `z.looseObject` while reflection's shared
  schema is strict.
- The `max(configuredRounds, userRequestTemplateCount)` rule duplicated
  between `agentYamlScanner` and `runReflectionFlow` — rated LOW in
  `2026-07-09-tech-debt-audit-runtime-ui.md` (B15); leave unless touched.

## Execution plan

Order respects dependencies and keeps each PR reviewable alone. Every PR:
`npm run typecheck`, `npm test`, `npm run check:dead-code-ratchet`; no
ratchet baseline widens.

**Wave 1 — unlock and de-risk (independent, can run in parallel):**

1. Item 1 (cycle break). Prerequisite for the SDK step-3 work; also the
   enabling change for item 7's file moves to land cleanly.
2. Item 6's stream-id formula collapse (small, test-pinned, removes the
   coincidence-based invariant). The rest of steps 6–7 follows as its own
   PR per the run-classification plan.
3. Item 9's relocations (mechanical; churn-only; best landed early before
   other waves touch the same files).

**Wave 2 — contracts (design-first, small diffs):**

4. Item 2 (cost contract + in-band conformance + tests).
5. Item 3 (in-band notify sink + explicit cancellation wiring).
6. Item 10 (report/result decision, README, `executions` tool messaging).

**Wave 3 — consolidations:**

7. Item 5 (one event-fold owner).
8. Item 7 (lease triplet move, exactly as H3 scoped).
9. Item 8's hydration helper (the only extraction in the item; the rest of
   item 8 stays deliberately untouched).

**Wave 4 — capability:**

10. Item 4 (shared concurrency budget). Last because it is the only item
    that changes runtime behavior under load and wants the cost contract
    (item 2) settled first so budget accounting and cost accounting don't
    co-evolve.

## Non-goals (standing rulings, restated so this plan cannot drift)

- **No merged super-cycle flow.** D6
  (`2026-07-09-state-of-the-architecture.md`): reflection and tool-use are
  both first-class; a parameterized merge "smears contract-level differences
  into flags." New capability lands in the shared kernel only.
- **No unification of the per-node outcome unions**
  (`InvocationResult`, `ToolUseCycleOutcome`, reflection's cycle outcome,
  `WaitExecResult`) — ruled in `2026-06-10-lifecycle-status-ownership.md`.
- **The in-band vs async execution split stays.** Ruled "different
  durability contracts, not duplication"
  (`2026-08-03-run-classification-consolidation.md`). Item 3 upgrades the
  in-band path's honesty; it does not fold the paths.
- **No shared detached-launcher abstraction** beyond H3's scoped triplet
  move.
- **XML follow-up delivery and the typed `AgentFinalResult` remain two
  surfaces** — one feeds a model's conversation, one feeds a deterministic
  script; collapsing them recreates the flattening the workflow-script
  engine was built to remove.
- **The workflow-script journal does not become a `PersistedFlow`.**
  Positional cursors suit hand-authored static graphs; content-hashed
  journals suit LLM-authored scripts (edit-and-rerun replay). They already
  share the `ExecutionKVStore`; convergence, if any, is at record
  versioning/strictness conventions only.

## Open questions

1. Item 2: should the cost contract also cover agent-CLI children
   (`agentCliShared.ts`), which currently ride the loop path's discipline
   implicitly? (Likely yes, for free, once written.)
2. Item 4: is the shared budget per run, per session, or per provider key?
   The engine's semaphore is per run today; the dispatch queue is per
   batch. Provider-rate-awareness argues for per-provider-key with a
   per-run floor — needs a short design note before Wave 4.
3. Item 10: does any consumer besides the `executions` tool's `report`
   action assume a report exists for every terminal child? Audit before
   choosing between "persist report" and "document result-only".
