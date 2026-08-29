# Simplification survey: the shared workflow run model, one day in

**Date:** 2026-08-29 (evening) · **Base:** `origin/main` `fa365c163f` (after #11606) ·
**Method:** four read-only scouts (shared model/copy, CLI popup path, board path,
engine/runtime) each with a domain brief and a refutation section, then two
adversarial verifiers re-deriving every claim at HEAD. Consumer counts are
`rg` over `src/` + `packages/*/src` excluding `src/test-kernel` ("prod") vs
`src/test-kernel` ("test").

**Scope:** the 53 production files the seven PRs of 2026-08-29 touched —
#11588 (copy/count fixes), #11591 (child-run concurrency owner), #11590
(`workflow.plan` marker), #11594 (phase-tab popup), #11602 (one shared
`workflowRunModel`, CLI on it), #11604 (board on it), #11606 (live child
progress joined to cards). In flight while this was written: #11612 (drop the
per-call / per-phase review scope) and #11613 (finished calls listed as
ticked rows). Where a candidate overlaps them it says so.

**Rulings honoured:** the owner ruling recorded in
[2026-08-29-simplification-survey-workflow-display-hosts.md](./2026-08-29-simplification-survey-workflow-display-hosts.md)
(one shared display structure, hosts differ only in paint, no projector or
adapter layers, single source of truth, zero new tests by default), the
plan-vs-issued-calls record
([2026-08-28](./2026-08-28-workflow-plan-vs-issued-calls.md)), and the
child-run concurrency proposal ([2026-08-15](./2026-08-15-child-run-concurrency-budget.md)).
Nothing below collapses a settled surface.

**Totals if everything lands:** ≈ −290 production LoC across seven small
PRs; −8 exports, −4 declarations, −1 trace event, −1 transcript marker kind,
+1 shared schema (the single plan shape). Zero new tests; three fixture
edits.

---

## Candidates, grouped as they should land

Each item: evidence → proposal → net → risk. "Verified" means the verifier
re-derived the consumer counts and read the cited lines.

### Bundle 1 — engine and shared, pure deletions (≈ −62)

**S1. Delete `attemptId` from phase stages (write-only since #11602).**
Written at `src/tools/delegation/workflowScriptRun.ts:205` → `events.ts:88`
→ recorder `TexraTranscriptRecorder.ts:445-447` → `taskGroup.ts:58` →
`projectTranscriptRow.ts:291-336` → `PhaseRow.attemptId`
(`transcriptRow.ts:245`). Readers across every host and `src/shared`: zero;
the only `.attemptId` hit outside `call.attemptId` is the projection writing
the field. The CLI consumers it was added for (2026-08-13, `aea5ccfd68`)
died in #11602. Persisted payload is `looseObject`, so old entries keep
parsing. Net ≈ −17. Risk: none.

**S2. One tally.** `workflowCallTally` (`src/shared/copy/workflowCall.ts:85-97`)
has one prod caller, the model's `tallyOf` (`workflowRunModel.ts:164-169`);
`WorkflowTally` (model, `declared` required) and `WorkflowTallyCounts`
(copy, `declared?`) are the same shape twice, and `phase.tally.declared ?? 0`
(`workflowCall.ts:263`) serves a caller that does not exist — all five
formatter callers pass a model tally. Inline the four `filter().length`
lines into `tallyOf`; one exported interface in the copy module (the model
imports it); delete the `??`. Reword the comment naming `workflowCallTally`
at `workflowScriptStrategy.ts:171` (both scouts missed it). Tests that call
`workflowCallTally` directly (`WorkflowCallCopy.vitest.ts:61-110`,
`WorkflowScriptProgressBridge.vitest.ts:16,431`) are retired into the
existing `model.tally` assertions. Net ≈ −15 (−28 with the docstring).
Risk: none; strings unchanged.

**S3. Inline `latestWorkflowAttemptEntries<T>`.** One prod caller
(`workflowRunModel.ts:271`), zero tests; the board's copy died in #11604. One
loop for the newest `attemptId`, test inline in the existing card loop, and
the `liveIds` `Set` (`:270-274`) goes with it. Net ≈ −20. Risk: none — the
model suite already pins resume and stale-attempt behaviour through
`workflowRunModel`.

**S4. CLI status style table becomes colour-only.**
`packages/cli/src/chat/tui/panes/transcriptEntryLayout.ts:163-186`: every
`marker:` is `WORKFLOW_CALL_STATUS_GLYPH.<same key>`; three marker readers
read the shared glyph directly. Net ≈ −10. Land after #11612 (it removes the
`awaitingApproval` row).

### Bundle 2 — the attempt marker (≈ −40)

**S5. Delete `workflow.attempt` and the `workflowAttempt` INTERNAL marker.**
Both scouts found this independently; verified. Emission
`workflowScriptRun.ts:598-601` → `events.ts:150-154,390` → recorder
`:547-562`; the only reader is `workflowMarkerOf`'s `attempt` arm
(`workflowRunModel.ts:73`), which both hosts reduce to "plan := undefined
until a plan marker arrives" (`transcriptFold.ts:231-234`,
`logSlice.ts:143`). The fact it carries is already on the wire twice: the
plan marker has `attemptId` and every card has `attemptId`, and the model
scopes cards by card `attemptId`, never by the marker. Every attempt that
reaches engine construction emits exactly one plan marker (constructor
`#emit()` at `workflowExecutionState.ts:76` → first fold
`workflowScriptRun.ts:434-462`, unconditional, empty phases/tasks for a
dynamic script), so the marker changes exactly one situation — a relaunch
that dies before construction — and there it produces a _half_ reset (old
cards, no plan) rather than the full reset its comment promises. Without it
the display shows the last attempt that got anywhere, consistently. Old
persisted markers parse harmlessly (`INTERNAL` data is `z.unknown()`;
unknown kinds return `undefined`). Delete the event, the recorder case,
`WorkflowAttemptMarker`, the `attempt` arm, both hosts' reset branches, and
the five test fixtures that pin it (four are one-line "any INTERNAL entry"
swaps). The verifier's correction: an "empty plan marker in `finally`"
alternative does not give a full reset either (cards still scope by their
own `attemptId`), so it is not offered. Net ≈ −40. Risk: low; `events.ts` is
the unpublished `@texra-ai/agent` contract with no external consumer.

### Bundle 3 — one declared-plan shape (≈ −20; deletes the fold #11608 relocated)

**S6. `WorkflowDeclaredPlan` once; the proposal panel folds through the
model.** The approval proposal carries
`WorkflowScriptProposalDetailsSchema.{phases:[{title}], tasks}`
(`prompts.ts:74-80`, from `meta` at `WorkflowScriptTool.ts:410-416`); the
trace carries `WorkflowPlanMarker.{phases:[{title,index}], tasks, attemptId}`
(`workflowCallProgress.ts:43-50`); `src/shared/copy/workflowScriptProposal.ts:3-6`
hand-writes the shape a third time. `phases` is the same fact (at
construction `snapshot.stages` is exactly `meta.phases`,
`workflowExecutionState.ts:48-53`), and `index` is derivable — order equals
array position at construction and for appended stages (`:105-107`); its one
reader is `workflowRunModel.ts:211`; the popup's tab order uses model array
order, not `index`. `tasks` is the same _shape_ but a different fact
(pre-approval declaration vs. this attempt's remaining plan), which is why
this is one schema, not one event. `workflowScriptDeclaredItemsByPhase`
(after #11608 a file-local helper in `ProposalRequestPanel.ts:67`, one
caller at `:238`; the survey was scouted before that relocation landed)
is the same grouping `unionWithDeclaredPlan` performs; calling
`workflowRunModel({ taskGroups: [], rows: [], plan, runSettled: false,
childProgress: new Map() })` yields the panel's groups exactly (zero-task
phases kept because `runSettled: false` disables the settle skip). Proposal:
`WorkflowDeclaredPlanSchema` in `workflowCallProgress.ts`; the proposal
schema `.extend`s it with `name/description/scriptPath`, the marker with
`kind/attemptId`; drop `index` from the marker (recorder `:569-573`,
projection `:441-444`, model iterates `plan.phases.entries()`); the panel
renders `phases[].heading.phaseLabel` / `declaredTasks` and
`workflowScriptDeclaredItemsByPhase` is deleted. One copy change: the
unphased tail reads `Unphased` (the model's label) instead of `No phase`.
Markers already on disk carry `index` and were introduced today (#11590):
they fail `strictObject` loudly as `malformedPlan` (warn, no plan) — the
intermediate-data ruling; no tolerance arm. Fixtures with `index:`
(`WorkflowScriptProgressBridge.vitest.ts:152-160`,
`WorkflowRunModel.vitest.ts:155,222-224`) are edits. Net ≈ −15 (the new
shared schema counted, the panel-local helper deleted). #11605 chose
relocation and closed with #11608; this is the next step — the extension no
longer regroups the plan at all, which is the divergence the owner ruling
names. Land after Bundle 2 so the marker vocabulary changes once.

### Bundle 4 — the projection keeps the card it last wrote (≈ −20)

**S7. `ProjectedWorkflowCall` = `{ logId, card }`.**
`workflowScriptRun.ts:87-95` stores six fields hand-copied out of each card
in `emitCall` (`:258-283`); the settle-sweep literal (`:641-651`) rebuilds a
card from that subset and omits `kind/agent/model/files`. `StreamLog`
patches replace `data` wholesale (`StreamLog.ts:497-503`), so a card the
projection's _backstop_ sweep settles loses the issued-call facts it showed
a moment earlier. The verifier narrowed the defect: the engine's own sweep
goes through `cardFor` and keeps them; only the projection-fault path
(`WorkflowScriptProgressProjectionFailure.vitest.ts`, added by #11574 —
which hand-added `attemptNumber` to the same subset) drops them. This is the
define-out-of-existence version of that fix: keep the last emitted card,
sweep with `{ ...card, status: 'failed', error: WORKFLOW_CALL_UNFINISHED_NOTE }`
narrowed by `isTerminalWorkflowCallProgress`. Also delete the phase
re-derivation (`:239-247,274-283` — the engine pins `stageId` at issue and
throws on a mismatch, `workflowExecutionState.ts:160-187`) and the unused
`index/total` parameters of `openPhaseStage`/`markPhaseFailed` (all four
call sites pass one argument). Two corrections from verification: keep
`error ?? NOTE` at `:375` (removing it needs a discriminated persisted
snapshot), and `call.model ?? attempts.at(-1)?.model` at `:317` is
_reachable_ (retry re-queue clears `model`, then a cancel while waiting
sweeps CANCELLED) — deleting it is a behaviour change that matches
`queueCall`'s documented intent, decide explicitly. The stale "two channels"
comment on `WORKFLOW_CALL_NOT_REACHED_NOTE` (`workflowCall.ts:173-179`) is
folded in. Net ≈ −20…−25. Land after #11612.

### Bundle 5 — CLI mechanical (≈ −50)

**S8. Inline `selectedChildRowWorkflowControllable`**
(`appInteractionPolicy.ts:226-249`; one caller `WorkflowPopup.tsx:357`, no
tests; its `RunIdentity` import serves nothing else). Net −19.

**S9. `workflowPhase.ts`: drop the category guard, inline the helper.** A
`kind: 'phase'` `StreamStage` comes only from `stage.ts:35-42` fed by the
single opener `workflowScriptRun.ts:227`; the `AgentCategory.Workflow` check
is redundant with the discriminant and can _hide_ a correct label while the
parent's category placeholder lags (`SessionFactApplier.ts:746-750`). Loop
body becomes `stage?.kind === 'phase'`; delete `currentWorkflowPhaseLabel`
and the `categoryOf` parameter both callers pay for. Net ≈ −22.

**S10. Object literals instead of conditional spreads** for `ChildRunProgress`
in `App.tsx:350-358` and `progressState.ts:333-337`: no `tsconfig` sets
`exactOptionalPropertyTypes`, every reader tests `!== undefined`. Net −8.

**S11. Popup clock keyed on the root's origin only**
(`useLiveNowMsSince([runStartedAt])`): the sole writer clears
`runStartedAt` on any non-active phase, and a card is live only while its
workflow is. Net −3; ≤1 s staleness in the terminal→child-kill window.
**S12.** `pendingApprovals` required on the popup props (test fixture passes
`new Map()`). ±0.

### Bundle 6 — CLI state (≈ −19)

**S13. Plan fold without the `applied` map.** `projectWorkflowPlanIncrementally`
(`transcriptFold.ts:216-247`) keeps `Map<entryId, entry>` to dedupe re-fed
entries; its one caller feeds the appended tail plus `dirtied`, and markers
are `appendSettled` only (`TexraTranscriptRecorder.ts:552,583`) while
`dirtied` carries in-place mutations only (`StreamLog.ts:37-42`). The fold
is last-marker-wins, so any prefix replay is idempotent — the map is dead
weight and latently wrong under mixed same/fresh-object replay. Replace with
`workflowPlan?: WorkflowPlanMarker` on the fold state — the shape the board
already has (`logSlice.ts:136-145`). Net −11. One difference: a malformed
marker re-warns on rebuild (loud side).

**S14. Delete `rosterParentOf`** (`childControls.ts:93-100`, the #11602
review fix's fallback). The verifier corrected the scout's ordering
argument and still confirmed: `trackAgentExecution` transitions status
before `track()`, the status applier `ensureStream`s the child
(`SessionFactApplier.ts:881-882`) before the roster and edge are emitted
back-to-back synchronously, every `presentStream` caller needs a slice or
is suppressed for child attachments (`sessionSignalsAdapter.ts:239`), and
edge clearing happens only on parent deletion, which drops the roster too.
The state is representable but unreachable; delete with a one-line comment
naming those two invariants. The identity scan in `streamIdentityFor` (the
reviewer's actual ask) stays. Net −8.

### Bundle 7 — board mechanical, then the board model (≈ −79)

**S15. `getStatusIcon(status: string)`** (`TaskGroupList.ts:95-113`) is a
defensive switch with a `default` over the exact four-member
`TaskGroupStatus` enum; `terminalStatusIcon` accepts the identical union.
Call it directly. Net −18.

**S16. `updatedRowIndices: readonly number[] | null`** — no producer yields
null (`store.ts:59` → `streamContexts.ts:67` → `LogList.ts:72`); the
`?? []` at `TaskGroupList.ts:309` can never fire. Type it `readonly
number[]`, delete `canUseUpdatedRowIndices`. Also the `streamStatus`
null/undefined round trip (`progressState.ts:499` manufactures `?? null`,
`TaskGroupList.ts:360,805` convert back). Net −13.

**S17. `Signal.Computed`'s `equals` for `pendingApprovalIds$` and
`phaseStages$`** (`progressState.ts:158-170,416-426`): they hand-roll
identity stability with module-level `_prev*` variables that need explicit
clearing in `resetProgressState` and a nine-line ordering comment;
`activeChildProgress$` (#11606) already uses the built-in. `signal-polyfill`
keeps `oldValue` and skips the version bump when `equals` holds, so the
`toBe` identity pins in `StreamMetaState.vitest.ts:497-534` still hold. Net
−14; −2 bare module singletons.

**S18. Compute the model in a selector; `<task-group-list>` receives
`.model`.** Today each model input travels four hops (selector → context →
`LogList` cache → component) and #11604/#11606 each paid four edit sites.
`activeRunModel$` beside `activeChildProgress$`, gated exactly as
`rebuildRunModel` gates today plus a boolean `activeRunSettled$` leaf (so a
status tick no longer rebuilds the model — a strict memo improvement, since
`StreamLogs` is republished as a fresh object per log change,
`logSlice.ts:287-306`). Context and cache carry one `runModel` field instead
of two; `TaskGroupList` deletes two properties, `rebuildRunModel`, the
six-way trigger list, and five imports; `groups`/`rows`/`streamStatus` stay
for the tree, header times, and placeholder. Passing the computed
`WorkflowRunModel` is passing the one structure the owner ruled on, not a
parameter object. Verified net ≈ −26; one fixture edit
(`TaskGroupListIndex.vitest.ts` mounts with `workflowPlan`/`childProgress`).

**S19. Board opens a card's child through the model's `childStreamOf`.**
Divergence 5 of the previous survey, reclassified as a defect by the ruling:
the popup honours the one-claimant rule (`WorkflowPopup.tsx:316-325`), the
board links on `call.childStreamId` verbatim
(`workflowCallFormatter.ts:79-85`). The verifier corrected the route:
unphased cards carry the run stage as `groupId` (`workflowScriptRun.ts:297`)
and render through the root group, so passing the id only on the phase path
would create a new divergence. Route every `workflowTask` row through
`renderLogEntry` with `this.model?.childStreamOf.get(row.id)` and add the
resolved id to the `guard` deps. Net ≈ 0; −1 second owner. Land after S18.

**S20.** Un-export `WorkflowMarker` and `WorkflowRunModelInput` (zero
consumers outside their file; the declaration build covers only
`packages/agent/src`, which does not import the model). **S21 (marginal).**
Share the `wa-details` shell between `renderDeclaredPhases` and
`renderGroupNode` (≈ −8) only if S18 is already reshaping the file; a
synthetic `TaskGroup` for a declared phase is render-time fabrication and is
rejected.

---

## Refuted, with the evidence

- **Two groupings of the same rows (tree vs. model).** `TranscriptIndex`
  groups every stream kind (round/session/run, orphan re-rooting
  `messageIndex.ts:274-284`, incremental upserts); the model groups
  `workflowTask` rows by phase. A script phase still needs `node.rows` for
  the script's own log lines, and giving the model non-task rows adds a
  board-only field the CLI never reads — the widening the ruling rejects.
- **`WorkflowScriptPlan` vs. `WorkflowPlanMarker` as one _event_.**
  Different producers (static `meta` before approval vs. this attempt's
  remaining plan with completed/cached calls excluded). One schema (S6),
  not one event.
- **Three per-status tables and the board's CSS/icon switches.** Different
  facts (label text, terminal glyph, web icon, card rail, strip colour) with
  different tokens; a single owner was rejected in the previous survey and
  re-checked. Only the CLI pass-through (S4) is real.
- **Merging `deriveWorkflowCounts` with the card tally.** Different
  vocabularies (`stageBlocked`) and inputs (snapshot vs. rows), both
  consumers real (`/executions`, delivery summary).
- **Dropping `total`/`index` from phase `stage.start`.** Three consumers
  print the stage heading _before and without_ the model (`◆` divider,
  headless output, status bar). The reverse — drop `index` from the plan —
  is S6.
- **Two concurrency owners.** `resolveChildRunConcurrencyBudget()` has two
  readers by design (session queue, workflow semaphore); workflow
  grandchildren run `budgeted: false` and never double-queue. The library
  default `DEFAULT_CONCURRENCY = 4` has zero product callers and ~110 test
  call sites; not worth −2 lines.
- **Root elapsed/cost through the model.** The run's own window and its
  children's are different facts; the board shows neither for the root.
  Adding a root field is a pass-through the model does not fold; net ≥ +3.
- **`WorkflowPopupView` fields, the popup's `tabWindowStart`/`statusStrip`,
  `useLiveNowMsSince`'s array API, `ancestorWorkflowPhaseLabel`,
  `workflowPopupExecutionIds`, the `streams.has` guard, harness-vs-vitest
  overlap.** Each read; each has live consumers or no shorter equivalent.
- **`workflowPlan` on `StreamState` instead of `StreamLogs`.** Possible
  (precedent: `taskGroups`) but deletes nothing: the `logChanged: true`
  flip becomes `stateChanged = true`, and `logContext$` needs a new leaf.
- **`formatLogEntry`'s try/catch; `internalMarkerKind`'s probe and the
  plan `safeParse`.** The first is the loud render boundary; the second is a
  real boundary — INTERNAL entries come from persisted transcripts and the
  kind is shared with reflection-flow emitters.
- **Declared-task template folded into the card; one status→CSS table;
  `TranscriptIndex` pre-partitioning task rows; `renderRunBand`'s phase
  gate.** Each nets positive or changes pixels.

## Excluded on purpose

The five ratchets, the `@agent/*` surface, the PocketFlow engine, the four
hosts, the browser-safe `@utils` set; `WorkflowRunDetails` (serves
reflection-flow agents); `createWorkflowAttemptCostTracker` (one caller but
a stateful object with its own suite); `emitChildActivity` /
`conversation.progress` (single private emitter, session-owned).

## Landing order

Bundle 1 → Bundle 2 → Bundle 3 (marker vocabulary changes once) → Bundle 4
and S4 after #11612 merges → Bundles 5–7 in any order, rebased after #11612
and #11613 (textual overlap in `WorkflowPopup.tsx` and
`workflowRunModel.ts` only).

## Tracking

No issues filed from this survey (the classifier gates issue creation
without an explicit request); each bundle above is written to be an issue
or a PR body. #11605 closed with #11608 (relocation); S6 goes one step
further and deletes the relocated fold.

## Checks

`npm run format`, `npm run check:guidance-refs`, `git diff --check` — all
clean on this docs-only change.
