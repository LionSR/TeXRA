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

**Wave 5 — audit addendum (see Addendum below):** A5's defect fix ships
immediately (it is a bug, not debt); A1–A3 and A6 are independent and can
interleave with Waves 1–3; A7 executes *as* item 5's implementation; A4
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
await is inside a try whose catch returns `{status:'failed'}` — yet four
call sites carry dead defensive `thrownError` arms. `childRunPersistence.ts`
(38 LoC) converts KV-store throws into a `{kind}` result object that its
consumer immediately converts back into a `SubagentDurabilityError` throw;
`bash.ts` hand-rolls a second copy of the delivery-persistence policy and
the CLI a third. Fix: delete the result-object layer and the dead throw
arms; route bash/CLI through the two surviving owners. Verifier
corrections: `rejectedMessage` warn strings are asserted verbatim by tests
(must land together); keep the CLI's per-stage `finalizationFailureMessage`
(headless-parity reporting surface).

### A4. Delegation shallow-file collapse (−75 LoC, −8 elements)

Three shallow indirections dissolve into their single real consumers:
`childRunDelivery.ts` (34 LoC — renames `SubmitFollowUpResult`'s five
variants to three, but its own caller file also imports raw
`submitFollowUp`, so the vocabulary boundary is already breached);
`ToolUseFollowUpQueue.drainItems`/`.restore` (one-line delegations of the
already-guarded `queue(lease)` accessor); and the
`subagentDiffs.ts → subagentDeliveryFormat.ts` strict two-deep
single-caller chain, folded into `subagentResults.ts` with the 14-line
`formatBuiltSubagentDelivery` arg-rearranger inlined. Verifier cut: do
**not** fold the `workflowScriptAgentRunner`/`createRunAgent` seam — it is
a load-bearing dependency-injection port (19 fake-runner injections in
tests) and closes over run identity, not just a stream id.

### A5. One bundled-prompt loader — fixes a live desktop defect (−65 LoC, −7)

`polishModel.ts` and `goal/promptLoader.ts` are two copies of the same
host-wired YAML-prompt singleton pattern, and the wiring drift already
shipped a defect: `initializePolishModel`'s only production caller is
`extension.ts`, while desktop wires `polishTextWithAI` into its follow-up
polish controller — so **every desktop follow-up polish fails** with
"Polish model not initialized" (caught and silently degraded downstream);
the CLI ships `instructionPolish.yaml` that nothing loads. Fix: one
table-driven bundled-prompt loader (`{relPath, schema, missingPolicy}`
rows, one `initializeBundledPrompts(resourcesPath)` per host); per-row
failure semantics stay data. The defect fix ships first, independent of the
consolidation. Verifier correction: `getHelperModelName` has four
production consumers and stays a barrel export; only `helperModelPreference`
fit the single-caller-extraction claim.

### A6. Resume topology cleanup (−45 LoC, −2 elements)

Tier 1 (verified dead): `ResumeStreamPorts.interactions` is a required
field supplied at five construction sites and never read; `resumeAdmission.ts`
is a 9-LoC file whose three importers all already import `executeAgent.ts`.
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
*not* snapshot-derivable today (two divergent label derivations exist —
prompt-excerpt fallback vs role fallback); unifying the label derivation is
a prerequisite micro-step and changes surfaced labels, so it lands as its
own reviewed commit.

### A8. One subscription registry (−110 LoC, −4 elements)

`ExecutionSubscriptionBinder` (270 LoC, `agent/runtime`) and
`StreamSubscriptionRegistry` (275 LoC, `tools/github`, three instances) are
the same machine written twice — the registry's own doc says "Mirrors
ExecutionSubscriptionBinder" — with parallel Map-of-Map bookkeeping,
bind-time generation capture, auto-dispose hooks, and an identical
`submitFollowUp(live_notification)` → emit → warn-catch sequence. Fix:
express the execution channel as the registry's fourth instance via an
`ExecutionRegistry → PollingSourceLike` adapter; the independently-shippable
first step folds the copy-pasted post-notification emit into
`submitFollowUp` itself. Verifier correction: the "layering forced the
duplicate" premise is false — `agent/runtime` already imports `@tools`
within the ratcheted baseline, so relocation is optional taste, not a
prerequisite.

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
