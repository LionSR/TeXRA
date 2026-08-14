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
`src/agent/workflowScript/`, and turns them into an execution plan. A
2026-08-14 review against head restated two claimed items (item 1's
layering premise; item 5's three-fold claim), marked two others as mostly
landed residue (items 6 and 7), and left four unclaimed plus two cheap
honesty fixes.

This is a consolidation plan, not a re-design. The architecture rulings that
bound it are restated in "Non-goals" and are not to be relitigated here.
Every wave starts by re-verifying the cited proposal Status line and the
named sites against head so completed work is not re-planned.

## The ten debts, ranked

Rank is blast radius × correctness risk, not size.

### 1. Layering inversion: `@tools/delegation` ↔ `executeAgent` cycle

**Claimed** — H4 in `2026-08-10-simplifier-fleet-round1-strategy.md`; named a
Step-3 SDK blocker. The cycle half is current; the "childRunLoop imports
from the tools layer" half is inherited stale from fleet H4.

The cycle `@tools/registry → DelegationTools → proposalFlow →
subagentExecution → executeAgent → registry` is papered over with two lazy
`await import('./nativeSubagentStrategy.js')` edges
(`subagentExecution.ts:203`, `inBandSubagentExecution.ts:400`; documented
at `subagentExecution.ts` header).

`childRunLoop.ts` does **not** import from `@tools/delegation`. It imports
`deliverChildRunFollowUp` from `@agent/followUp/childRunDelivery` (`:45`),
`persistChildRunDeliveryBestEffort` from
`@agent/storage/childRunDeliveryPersistence` (`:46`), and
`formatSubagentProgress` from `@shared/subagentFollowup` (`:55`). Those
helpers import nothing from `@tools` either. The remaining
`src/agent/runtime/` → `@tools/delegation` edge is the availability
predicates in `agentToolResolution.ts:41-47` (plus
`src/agent/prompt/userVars.ts:24`). Those predicates are not the inversion.

**Fix.** Break the cycle at the root as H4 prescribes; both lazy edges
retire together. Acceptance: no dynamic imports of
`nativeSubagentStrategy`. Do **not** require "no `@tools/delegation` import
from `src/agent/runtime/`" — that would force removing the
`delegationAvailability` predicates, which are a different edge. Do **not**
require the `architecture-edges` ratchet to shrink: that ratchet tracks
top-level subsystem pairs, and the existing `agent → tools` value edge
remains required by `agentToolResolution.ts`, `agentSettingTools.ts`,
`HostInteractions.ts`, and `toolInjection.ts`. Shrinking it is broader later
work, not an acceptance criterion of the cycle break.

### 2. Cost accounting: three disciplines for one fact

**Unclaimed until now.** The in-band "per-event forwarding" framing is stale.

Three sites still write cost differently:

- Loop path: `ChildRunLoopParams.recordCost` retains `max(bestCostUsd)`
  across turns and commits exactly once at run end
  (`childRunLoop.ts`, cost retention + single-commit).
- In-band path: `executionMode: 'single-cycle'` and one `strategy.launch`
  (`inBandSubagentExecution.ts:456-468`). `runNative` then calls
  `ports.recordCost(result.totalCostUsd)` exactly once after that
  invocation (`nativeSubagentStrategy.ts:192-199`). That is one
  cumulative observation per physical attempt, not repeated per-event
  forwarding. A second retention layer would be churn around an
  invariant that already holds.
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

**Fix.** Write the contract first: who observes (ports), who retains
(max vs delta — the answer differs by attempt model and must be stated),
who commits, and when. Then make the workflow-script path honor it (it is
the remaining complexity: delta tracker, journal settlement, recovered
guard). Do **not** add an in-band retention layer or a new in-band
single-commit test unless a multi-observation in-band path is identified.
Extend `WorkflowScriptCost.vitest.ts` for the contract the workflow path
must keep. Code movement only where a site violates the written contract.

### 3. The in-band path is a degraded copy of the loop path

**Unclaimed until now.**

`executeInBand` (`inBandSubagentExecution.ts:389`) drops progress
notifications entirely (`notify: () => {}`, `:463`). The workflow-script
path compensates with its own event channel (`WorkflowScriptEvent`
projection); the headless `stopAfterCycle` arm of
`delegate_agent`/`delegate_workflow` loses the notification sink.

The fresh `AbortController` passed to `strategy.launch` (`:467`) is
**not** an unhandled caller-cancellation gap. `runNative` already
combines `params.signal` and `abortController.signal` and binds the
result to `handle.interrupt()` (`nativeSubagentStrategy.ts:182-190`);
`onAbort` fires immediately even if the caller signal was aborted
before the handle existed. Retaining the controller in the caller adds
no cancellation behavior, and removing it would change the shared
`ChildRunStrategy.launch` contract just to drop an inert allocation.
Keep it as the strategy-interface argument.

The in-band run also does **not** lack a lease-lost watchdog once
`strategy.launch` enters `executeAgent`: `runFlowWithLifecycle` attaches
`onOwnedExecutionLeaseLost` for the same execution ID, marks the handle
lease-lost, and calls `handle.interrupt()`, and also attaches the run
interrupt handler (`AgentRunLifecycle.ts:490-501`). Treating that as
absent would add a second watcher and double-run cancellation side
effects.

**Fix.** One scoped change, not a rewrite: thread a real notification
sink for the `stopAfterCycle` arm (the parent is in-band, so "notify" can
degrade to trace-card emission rather than follow-up delivery — but
deliberately and documented, not via a silent no-op). Do **not** add a
second lease-lost watcher, a loop-level interrupt path, or a launch-
signature change to retire the controller. The in-band-vs-async
_durability_ split stays (see Non-goals).

### 4. Two independent concurrency budgets

**Half-claimed** — `2026-07-05-workflow-script-engine.md` §4 already states
"the same semaphore should eventually gate LLM-driven delegation too";
unbuilt. Scope and inheritance are **not** settled (see Open question 2).

`ToolUseDispatchNode` runs **only** `parallelSafe` tool calls under a local
`PQueue({ concurrency: 4 })` (`MAX_PARALLEL_TOOL_CALLS`,
`ToolUseDispatchNode.ts:33`; queue vs barrier at `:165-181`). Delegation
tools do not declare `parallelSafe`, so they execute on the barrier branch
and never take a queue slot. Detached delegation also returns after launch,
so a queue slot would be released while the child keeps running. The
workflow-script engine runs `agent()` under its own semaphore (default 4).
An orchestrator can therefore hold the engine budget plus ungated native
child-agent lifetimes at once, and neither is provider-rate-aware.

A purely run-scoped budget does not by itself close that case:
`delegate_multi_agents` returns after launching a detached workflow
execution, so the parent's launch and the workflow child's semaphore belong
to distinct runs unless budget inheritance is designed.

**Fix.** One budget owned in `@agent/runtime`, acquired and held at
**one** child-execution boundary — **not** injected into the dispatch
node's `PQueue`, which would throttle `read_file`/`grep` while leaving
child-agent lifetimes ungated. The listed sites are nested, not
independent: a workflow-script `agent()` holds the engine semaphore
while its production runner enters in-band native launch
(`workflowScriptAgentRunner.ts` → `executeStableSubagentInBand`), and a
detached native run calls `strategy.launch` from inside
`startChildRunLoop` (`childRunLoop.ts:790`). Acquiring the same shared
budget at every listed site charges one physical child twice; at
concurrency 1 that deadlocks immediately, and nested delegation
deadlocks when parents occupy every slot while awaiting children.
Define a single owner per physical execution, or pass a reentrant lease
through the nested layers, in the Wave-4 design note **before**
implementing. Also settle per-run vs per-session vs per-provider-key
and whether a detached child inherits its parent's remaining slots.
Keep the engine's _lifetime_ call cap and fan-out caps where they are —
those are script governance, not concurrency.

### 5. Dual-channel sync tax over `WorkflowScriptEvent` + snapshot

**Claimed** — H2 in `2026-08-10-simplifier-fleet-round1-strategy.md`,
restated against head. The original "three independent event-folds" inventory
is stale.

There is no `workflowScriptDeliverySummary.ts` file (the
`WorkflowScriptDeliverySummary` type lives in
`src/shared/schemas/workflowScriptDelivery.ts`).
`workflowScriptStrategy.ts` does not fold the event stream — `settleSummary`
reads the engine's terminal snapshot + journal (`:181-216`). The comment
at `:167-169` claims this "can never disagree with `/executions/{id}`";
that is overstated. `onSnapshot` assigns `lastSnapshot` **before**
awaiting `params.onSnapshot` (`:275-277`), and the failure path later
passes that unpersisted value to `settleSummary` (`:294-299`). If
snapshot persistence fails, durable execution metadata keeps the older
snapshot while the delivery summary reports the rejected newer one.
The sole event fold is `workflowScriptRun.ts:308` (`project`, wired as
the engine's only `onEvent` consumer at `:428`).

The remaining debt is the dual hand-synchronized channel (snapshot +
events) with its dual-stamp tax — the same debt A7 describes — plus the
failed-write disagreement above.

**Fix.** Execute A7: emit per-transition snapshots; narrow
`WorkflowScriptEvent` to the facts a snapshot cannot carry. Unify
`event.label` derivation first as a separate reviewed commit (it is not
snapshot-derivable today: prompt-excerpt fallback vs role fallback).
Assign `lastSnapshot` only after `onSnapshot` persistence succeeds (or
stop claiming the delivery summary matches the durable execution view).

### 6. Lineage and identity residue

**Mostly landed** — steps 6–7 of
`2026-08-03-run-classification-consolidation.md` are implemented (that
document's status header: "Part I implemented (steps 1-7 ... lineage
predicate dedup, per-tool delegation availability)"). Do not re-execute
the step-6/7 table.

Already gone at head:

- The only `isChildExecution` predicate is the canonical
  `ExecutionHandle.ts:207` (plus the exported helper); the four open-coded
  copies are consolidated.
- All four ownership-check sites call `handle.isOwnedBy(...)`.
- `DELEGATION_AVAILABILITY_CATEGORY` has zero hits outside proposal docs.
- `getStreamTabId` is defined once (`src/agent/runtime/streamTab.ts:12-17`)
  and imported by both launch sites; they re-invoke it, they do not
  re-derive it. The match with `AgentLaunchContext` is documented
  (`subagentExecution.ts:152-158`) and pinned by
  `SubagentExecutionChildStreamId.vitest.ts:166-176`.

What remains:

- the `orchestratorStreamId`/`parentStreamId` naming split
  (`subagentExecution.ts:71`)
- two `isSubagent` spellings (`handle.isChildExecution` vs hardcoded `true`
  at `nativeSubagentStrategy.ts:239`) across three finalize sites

**Fix.** Rename the parameter and replace the hardcoded `true`. Cheap
honesty, not a Wave-1 unlock.

### 7. Detached-launch lease choreography

**Mostly landed** — H3 in
`2026-08-10-simplifier-fleet-round1-strategy.md`.

The three launch sites no longer hand-roll register + lease +
release-on-failure. All three call `registerOwnedExecution` from
`@agent/storage/executionLifecycle`; the two detached paths share
`startDetachedChildRunLoop` and its `runWithOwnedExecutionLeaseLaunchGuard`;
the in-band path uses the same storage guard while retaining its distinct
terminal-release policy. There is no Wave-3 PR for the original triplet
move.

**Fix.** Audit the remaining in-band vs detached terminal-release policy
difference before scheduling anything; do not extract a shared launcher
(H3's ruling stands).

### 8. The flow twins: mechanical duplication around the two flows

**Unclaimed until now** (individual pieces noted across audits; no single
owner).

- Two persisted-record hydration blocks that share a read → parse/migrate
  → `stampCompatibilityKey` skeleton but are **not** near-identical
  schema-pair ladders:
  - `runReflectionFlow.ts:189-210` is read → `safeParse` →
    `PersistedFlowStateError` → in-memory `stampCompatibilityKey`. There
    is no `kv.*` back-write; persistence happens later via the
    `RoundPersistedFlow` it constructs (~`:264`).
  - `runToolUseFlow.ts` first distinguishes a resume handoff from a leftover
    record, checks `sourceShared` for concurrent drift, runs
    `migrateSharedState`, repairs the continuation generation, stamps the
    flow-record schema version, and conditionally writes (`:486-490`,
    `:530-534`).
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

**Fix.** Extract only operations that are actually shared (read +
parse/migrate + stamp) into one helper in `@agent/node/persistedFlow`. The
write step must be parameterized or left to the caller — a helper
parameterized only by a schema pair cannot preserve tool-use's
durable-state checks. Leave the cycle-node skeletons alone unless a later
change touches both (the shared shape is the D6-fenced kernel's job, and a
forced merge is the super-cycle trap). Do not touch the retention policies
in this pass; if reconciled later, release-note it.

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
for successful grandchildren too _or_ document that `result` is the sole
artifact for scripted children and teach the `executions` tool's `report`
action to say so instead of returning nothing.

## Honorable mentions (tracked, not planned here)

- Workflow agents _can_ declare `tools:` in YAML (shared
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
`npm run format`, `npm run compile:fast`, `npm run lint`, `npm run typecheck`,
`npm test`, `npm run check:dead-code-ratchet`; no ratchet baseline widens.
Before scheduling any item, re-verify the cited proposal's Status line and
the named sites against head.

**Wave 1 — unlock and de-risk (independent, can run in parallel):**

1. Item 1 (cycle break: retire the two lazy
   `nativeSubagentStrategy` imports). Prerequisite for the SDK step-3 work.
   Acceptance is "no dynamic imports of `nativeSubagentStrategy`"; the
   `architecture-edges` ratchet stays unchanged.
2. Item 9's relocations (mechanical; churn-only; best landed early before
   other waves touch the same files).
3. Item 6's leftover naming (parameter rename + hardcoded `true`); not a
   blocker.

**Wave 2 — contracts (design-first, small diffs):**

4. Item 2 (cost contract + workflow-path conformance + tests). Do not
   add an in-band single-commit test unless a multi-observation path
   is found.
5. Item 3 (in-band notify sink only). Do not add a second lease-lost
   watcher or change the `ChildRunStrategy.launch` signature.
6. Item 10 (report/result decision, README, `executions` tool messaging).

**Wave 3 — consolidations:**

7. Item 5 / A7 (emit per-transition snapshots; narrow the event stream;
   label-derivation micro-step first).
8. Item 8's shared hydration operations (read + parse/migrate + stamp
   only; write parameterized or left to the caller). The rest of item 8
   stays deliberately untouched.

Item 7 (H3 lease triplet) has no Wave-3 PR.

**Wave 4 — capability:**

9. Item 4 (shared concurrency budget, one owner per physical
   execution). Last because it is the only item that changes runtime
   behavior under load, wants the cost contract (item 2) settled first,
   and needs the scope/inheritance/reentrancy design note written
   before any code moves.

**Wave 5 — audit addendum (see Addendum below):** A5's defect fix ships
immediately (it is a bug, not debt); A1–A3 and A6 are independent and can
interleave with Waves 1–3; A7 executes _as_ item 5's implementation; A4
lands after item 1 (same files); A8 lands last in its area (largest blast
radius of the addendum items).

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
  move (already landed; remaining residue is the in-band terminal-release
  policy, if any).
- **XML follow-up delivery and the typed `AgentFinalResult` remain two
  surfaces** — one feeds a model's conversation, one feeds a deterministic
  script; collapsing them recreates the flattening the workflow-script
  engine was built to remove.
- **The workflow-script journal does not become a `PersistedFlow`.**
  Positional cursors suit hand-authored static graphs; content-hashed
  journals suit LLM-authored scripts (edit-and-rerun replay). They already
  share the `ExecutionKVStore`; convergence, if any, is at record
  versioning/strictness conventions only.

## Addendum: eight further verified candidates (debt-audit run, 2026-08-14)

A structural debt-audit workflow (25 agents: seam mapping → ideation →
shortlist → adversarial net-gain verification) swept the same area with this
document's ten items excluded from its charter. Eight candidates survived
adversarial verification, all with confirmed net gain — combined roughly
−665 LoC and −60 structural elements. Verifier corrections are folded into
the scopes below; where a verifier cut a sub-item, the cut is stated.

### A1. Collapse the retry template-method split (−110 LoC, −11 elements)

`RetryableInvocationNode` (`RetryState.ts`, 606 LoC) is an abstract
template-method base with exactly one production subclass —
`ModelInvocationNode`. The promised second instantiation never materialized
(`ToolUseDispatchNode` extends `Node` directly), so the abstract/concrete
split, three virtual-dispatch pairs, and `RetryableNodeServices` are
speculative generality. Independently, seven classify/predicate functions in
`providerErrorFormat.ts` have exactly one consumer each
(`ModelInvocationNode`), re-deriving cause-chain/status/rate-limit-scope up
to six times per relay failure. Fix: merge `RetryState.ts` into
`ModelInvocationNode` (one deep module behind the unchanged `Node`
interface); collapse the seven classifiers into one route-verdict function.
Verifier corrections: the verdict shape must carry `exhaustionReason` (the
relay-gate predicate has no 429 gate), the transport/5xx/408 wire branch,
and relay's max(header, body) retryAfter with rate-vs-concurrency reason;
the existing `RetryState.vitest.ts` predicate condition tables survive
unchanged; the test harness needs a dummy config, which is churn, not risk.

### A2. Approval surface trim (−100 LoC, −13 elements)

Three shippable trims, none touching the healthy core: delete the
"re-export commonly used functions" convenience barrel block in
`tools/approval/index.ts` (a banned barrel with a live dual import path);
dissolve `proposalApproval.ts` (46 LoC of `SessionApprovals` behavior
stranded two directories from its owner — becomes a method on the class
already owning the bypass objects); single-source the
`{feedback}|{reason}|{cause}` rejection-provenance union hand-written five
times across `HostInteractions.ts`/`toolEditApproval.ts`. Verifier cut:
keep `cleanupAllApprovals` (test teardown consumer set makes deletion a
wash).

### A3. One error channel for child-run/terminal persistence (−90 LoC, −9)

`finalizeExecution` (`executionLifecycle.ts`) provably never throws — every
await is inside a try whose catch returns `{status:'failed'}` — yet three
call sites still carry dead defensive throw arms: `'thrownError' in` at
`runAgent.ts:182-183` and `terminalPersistence.ts:96-101`, plus the
CLI `try`/`catch` around `finalizeExecution` at
`packages/cli/src/runtime/executionFinalization.ts:43-58` (it reports an
"unexpected" thrown failure that cannot occur). The other finalize-family
sites (`restartRepair.ts:185`, `AgentRunLifecycle.ts:197`,
`executionRegistry.ts:850`) have no such arm.
`childRunPersistence.ts` (37 LoC) converts KV-store throws into a
`{kind}` result object. One required consumer
(`persistResultMetaRequired` in `inBandSubagentExecution.ts:258-264`)
immediately converts a failure back into a `SubagentDurabilityError`
throw. A second consumer, `persistChildRunDeliveryBestEffort`, calls
both result-returning functions, inspects each result independently,
marks the lease undurable, and reports failures without rejecting
(`childRunDeliveryPersistence.ts:17-30`). That helper is used by the
detached child loop and in-band failure paths, so deleting the
result-object layer literally would let an artifact write escape a
deliberately best-effort path or drop one of two concurrent failures.
`bash.ts` hand-rolls a second copy of the delivery-persistence policy
and the CLI a third. Fix: delete the three dead throw/catch arms
(including the CLI catch); route bash/CLI through the two surviving
owners; keep the result type (or replace it with an equivalent
`Promise.allSettled` that still inspects both writes independently) so
the best-effort consumer does not start throwing. Verifier corrections:
`rejectedMessage` warn strings are asserted verbatim by tests (must
land together); keep the CLI's per-stage `finalizationFailureMessage`
(headless-parity reporting surface).

### A4. Delegation shallow-file collapse (−75 LoC, −8 elements)

Two shallow indirections dissolve into their real consumers:

- `ToolUseFollowUpQueue.drainItems`/`.restore` (one-line delegations of the
  already-guarded `queue(lease)` accessor).
- Merge the two-consumer `subagentDeliveryFormat.ts` (production consumers:
  `inBandSubagentExecution.ts:51`, `nativeSubagentStrategy.ts:67`; it
  already imports both `./subagentDiffs` and `./subagentResults`) and its
  single-caller `subagentDiffs.ts` leaf into `subagentResults.ts`, inlining
  the 14-line `formatBuiltSubagentDelivery` arg-rearranger.

Do **not** dissolve `childRunDelivery.ts` (34 LoC). Production callers
include `src/agent/runtime/childRunLoop.ts`, `src/tools/bash.ts`, and
`src/tools/delegation/DelegationTools.ts`. That only
`DelegationTools.ts` also imports raw `submitFollowUp` does not make the
wrapper redundant for the other two paths.

Verifier cut: do **not** fold the `workflowScriptAgentRunner` /
`createRunAgent` seam — it is a load-bearing dependency-injection port
(16 `createRunAgent:` injection sites in `WorkflowScriptStrategy.vitest.ts`)
and closes over run identity, not just a stream id.

### A5. One bundled-prompt loader — fixes a live desktop defect (−65 LoC, −7)

`polishModel.ts` and `goal/promptLoader.ts` are two copies of the same
host-wired YAML-prompt singleton pattern, and the wiring drift already
shipped a defect: `initializePolishModel`'s only production caller is
`extension.ts:184-188` (it _does_ pass `templates/instructionPolish.yaml`
and `loadPromptTemplate` reads it lazily on first `renderPolishPrompt`),
while desktop wires `polishTextWithAI` into its follow-up polish controller
(`desktopAgentExecution.ts:212-215`) without initializing — so **every
desktop follow-up polish fails** with "Polish model not initialized"
(`polishModel.ts:25-29`; `textEnhancement.ts` logs the error, then returns
`{ success: false }`, so the user-visible result is a polish that never
changes the text). The CLI bundles a copy (`copy-resources.mjs` lists
`templates/instructionPolish.yaml`) that no CLI code loads. Fix: one
table-driven bundled-prompt loader (`{relPath, schema, missingPolicy}`
rows, one `initializeBundledPrompts(resourcesPath)` per host); per-row
failure semantics stay data. The defect fix ships first, independent of the
consolidation. Verifier correction: `getHelperModelName` has four
production consumers and stays a barrel export; only `helperModelPreference`
fit the single-caller-extraction claim.

### A6. Resume topology cleanup (−45 LoC, −2 elements)

Tier 1 (verified dead): `ResumeStreamPorts.interactions` is a required
field supplied at four production construction sites
(`resumeFromResumeData.ts`, `desktopAgentResume.ts`, `resumeExecution.ts`,
`chatSessionController.ts`) and never read; `resumeAdmission.ts` is a
9-LoC file whose three importers all already import `executeAgent.ts`.
Tier 2: extension and desktop each maintain a near-identical
preload-then-read resume-state resolver over the same `StreamSnapshotStore`
(the extension comment admits the mirroring), and the extension's
`ProgressViewProvider` singleton hop is provably identical to
`defaultSession().snapshots` while adding a spurious "progress view never
opened" failure mode — one runtime default resolver deletes both host
copies. The riskier CLI two-rehydration-path merge is droppable without
losing the tiers above.

### A7. `WorkflowExecutionSnapshot` as the one fold owner (−70 LoC, −6)

This is the concrete design for item 5 (H2): the engine publishes every run
fact on two hand-synchronized channels and already pays documented tax to
police the duplication (cost restated onto events with a "never accumulate
a second, divergent total" comment; `failCall` existing solely to
dual-stamp; four terminal sites stamping both). The event stream has exactly
one consumer in the repo, and it already trusts `lastSnapshot` over its own
event fold. Fix: emit per-transition snapshots; narrow `WorkflowScriptEvent`
to the facts a snapshot cannot carry. Verifier correction: `event.label` is
_not_ snapshot-derivable today (two divergent label derivations exist —
prompt-excerpt fallback vs role fallback); unifying the label derivation is
a prerequisite micro-step and changes surfaced labels, so it lands as its
own reviewed commit.

### A8. One subscription registry (−110 LoC, −4 elements)

`ExecutionSubscriptionBinder` (270 LoC, `agent/runtime`) and
`StreamSubscriptionRegistry` (275 LoC, `tools/github`, three instances) are
the same machine written twice — the registry's own doc says "Mirrors
ExecutionSubscriptionBinder" — with parallel Map-of-Map bookkeeping,
bind-time generation capture, auto-dispose hooks, and an identical
`submitFollowUp(live_notification)` → emit → warn-catch sequence. The
independently-shippable first step folds the copy-pasted post-notification
emit into `submitFollowUp` itself. Verifier correction: the "layering
forced the duplicate" premise is false — `agent/runtime` already imports
`@tools` within the ratcheted baseline, so relocation is optional taste,
not a prerequisite.

Do **not** replace the binder with a fourth registry instance until the
lifecycle difference is designed. The binder is created and disposed per
`SessionHandle` (`SessionHandle.ts:200-207`, `:864-869`). The registry keys
process-level state only by `StreamTabId`, captures whichever session
called `bind`, and has no `dispose()` for its source or queue hooks
(`StreamSubscriptionRegistry.ts:72-100`, `:220-237`). A process-wide
fourth instance can collide when two sessions share a stream/key; a
per-session fourth instance leaks registered hooks at teardown. Add
session identity and an explicit disposal contract to the shared
registry before replacing the binder, or keep the session-owned binder
and only ship the emit fold.

## Open questions

1. Item 2: should the cost contract also cover agent-CLI children
   (`agentCliShared.ts`), which currently ride the loop path's discipline
   implicitly? (Likely yes, for free, once written.)
2. Item 4: is the shared budget per run, per session, or per provider key?
   The engine's semaphore is per run today; the dispatch queue is per
   batch. Provider-rate-awareness argues for per-provider-key with a
   per-run floor. A detached workflow child is a distinct run, so
   inheritance (or not) must be written down. Nested sites (engine
   semaphore ⊃ in-band launch; child-run loop ⊃ `strategy.launch`) also
   need a single owner per physical execution or a reentrant lease.
   This note is a Wave-4 prerequisite, not an open afterthought.
3. Item 10: does any consumer besides the `executions` tool's `report`
   action assume a report exists for every terminal child? Audit before
   choosing between "persist report" and "document result-only".
