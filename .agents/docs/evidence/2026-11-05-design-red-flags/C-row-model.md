# C. The shared session row model and its folds

Scope: `packages/harness/src/shared/session/*`, `shared/runs/*`, the row-kind
schemas (`shared/schemas/sessionEvent.ts`, `shared/schemas/runHistoryEvent.ts`, `shared/schemas/run.ts`,
`shared/schemas/runRecords.ts`, `shared/schemas/rowVersions.ts`), read against their consumers in
`agent/`, `controllers/`, `transcript/` and the hosts. Read-only; every claim
cites `path:line` as the tree stands at `ccf15b4`; paths are relative to
`packages/harness/src` unless they start with `packages/`. Consumer counts are over
`packages/*/src` unless marked (tests: `src/test-kernel`, `packages/*/test`).

The git history available here is one squashed day (50 commits, all dated
2026-11-05), so no churn evidence could be measured for this area; the
one-fact note's "view/fold 18 fixes" is taken as given.

Not re-reported: everything in the one-fact note's tables A, B, E, F (claims,
`ownerId`/`ownedHere`/`readOnly`/held notice, `child.park heldFor` and the
delivery mechanisms, `abort`, the host predicates landed 2026-11-04, the
parent edge). Where a finding below touches one of those, it adds the angle
the note does not name and says so.

## Numbers

- 37 row kinds: 15 display (`shared/schemas/sessionEvent.ts:181-316`, with `run.start`,
  `run.removed`, `plugin.fact`), 10 trace arms spliced in (`:315`,
  `TRACE_ROW_TYPES :522`), 3 private records (`:328-332`), 9 run-history
  kinds (`:338-361`), of which `model.message` has 8 payload kinds
  (`shared/schemas/runHistoryEvent.ts:144-245`).
- Three folds over them: `applyRunRows` (`shared/session/runState.ts:528`, the loop),
  `makeSessionViewUpdater` (`shared/session/sessionViewUpdate.ts:106`, people) and
  `runRowsFrom` (`shared/session/runRowReads.ts:159`, every other reader, 9 named reads
  `RUN_ROW_READS :38-57`), plus two row-at-a-time readers of the tail,
  `recordOf` (`:187`) and `phaseMoveOf` (`:211`).
- Comment share: `shared/session/agentEvent.ts` 62%, `shared/session/sessionViewAccess.ts` 56%,
  `shared/runs/taskGroupProjection.ts` 56%, `shared/session/valueFamily.ts` 50%, `shared/session/runRowsShape.ts` 46%,
  `shared/session/sessionLog.ts` 44%, `shared/session/runHistory.ts` 43%, `shared/session/sessionView.ts` 41%,
  `shared/schemas/runRecords.ts` 38%, `shared/schemas/runHistoryEvent.ts` 37%, `shared/schemas/run.ts` 37%,
  `shared/runs/runStatus.ts` 37%. `shared/session/sessionViewUpdate.ts` is 1152 lines at 22%.
- Tests pinning the fold entry points: `applyRunRow` 1 file, `runRowsFrom`
  1, `applyRunRows` 1, `makeSessionViewUpdater` 3, `runActions` 1;
  `phaseMoveOf`, `runStatus`, `registrationDrafts`, `activationDrafts`,
  `runEndDraft`, `followUpReceipt`, `unboundRequests`: 0 each.

---

## Q2 first: the fact "where does this run stand", every representation

The brief's key table. One fact ("is it running, waiting on something, at
rest, or ended, and how") has these spellings. `R` = stored row field, `S` =
`RunState` (loop), `W` = `RunRows` (the other readers), `V` = `RunView`
(hosts), `P` = a predicate or table somewhere else.

| #   | Representation                                                                                                                                        | Where                                                                                                                                                                                                                | Answers                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| R1  | `run.activate` row exists                                                                                                                             | `shared/schemas/sessionEvent.ts:234`                                                                                                                                                                                 | a process took the run                                                                          |
| R2  | `run.position.payload.at` (7 literals incl. `waiting`, `halted`)                                                                                      | `shared/schemas/runHistoryEvent.ts:86-94`                                                                                                                                                                            | loop position                                                                                   |
| R3  | `run.position.payload.outcome` on a `halted` row                                                                                                      | `shared/schemas/runHistoryEvent.ts:106-110`, written only with `run.end` (`agent/runtime/loop/rows.ts:88-90`)                                                                                                        | how it ended (again)                                                                            |
| R4  | `child.park.phase` (`parked`/`resumed`/`paused`) + `heldFor` + `ends`                                                                                 | `shared/schemas/sessionEvent.ts:261-266`                                                                                                                                                                             | a loop-less child's wait                                                                        |
| R5  | `child.turn.phase` (`accepted`/`settled`)                                                                                                             | `shared/schemas/sessionEvent.ts:356-360`, written in the same transactions as R4 (`agent/runtime/childRunLoop.ts:399-408`, `:565`)                                                                                   | the same child's wait                                                                           |
| R6  | `run.end.outcome` + `reason`                                                                                                                          | `shared/schemas/runRecords.ts:95-104`                                                                                                                                                                                | ended, how, why                                                                                 |
| R7  | `followup.closed`                                                                                                                                     | `shared/schemas/sessionEvent.ts:331`                                                                                                                                                                                 | takes no input (claim-era)                                                                      |
| S1  | `RunState.phase: RunLoopPhase` (5 values)                                                                                                             | `shared/runs/runStatus.ts:68-73`, `PHASE_AT :84-92`                                                                                                                                                                  | loop position, from R2                                                                          |
| S2  | `RunState.at`, `.outcome` (from R2, R3)                                                                                                               | `shared/session/runRowsShape.ts:33-42`                                                                                                                                                                               | loop position; `.outcome` has **no reader** (grep: set at `shared/session/runRows.ts:205` only) |
| S3  | `RunState.resuming`                                                                                                                                   | `shared/session/runState.ts:130-131`, set `:343`, cleared `:310`                                                                                                                                                     | R1 after the last R2                                                                            |
| S4  | `RunState.invocation.current.closed`                                                                                                                  | `shared/session/inFlight.ts:48-49`, set by R6 reason `shutdown` (`shared/session/runState.ts:331-334`)                                                                                                               | ended by shutdown                                                                               |
| W1  | `RunRows.at`, `.outcome`, `.position`, `.positions`                                                                                                   | `shared/session/runRowsShape.ts:59-120`                                                                                                                                                                              | R2, R3                                                                                          |
| W2  | `RunRows.activation`, `.end`, `.lifecycles`, `.inputClosed`, `.park`, `.heldParks`                                                                    | `shared/session/runRowReads.ts:74-88`, `:118-124`                                                                                                                                                                    | R1, R4, R6, R7                                                                                  |
| V1  | `RunView.status: RunPhase \| 'ready'` (running, waiting, completed, cancelled, failed, ready)                                                         | `shared/session/sessionView.ts:126`; written at `shared/session/sessionViewUpdate.ts:723`, `:784`, `:818`                                                                                                            | R1+R2+R4+R6 collapsed into one enum                                                             |
| V2  | `RunView.substate` (starting, resuming, paused, resultWaiting)                                                                                        | `shared/session/sessionView.ts:130`; `shared/session/sessionViewUpdate.ts:714-720`, `:766`                                                                                                                           | S3 again (as two words), R4 again                                                               |
| V3  | `RunView.durableOutcome`                                                                                                                              | `shared/session/sessionViewUpdate.ts:459` = `isTerminalOutcomePhase(status) ? status : null`                                                                                                                         | R6, re-split out of V1                                                                          |
| V4  | `RunView.group` (running, waiting, interrupted, recent)                                                                                               | `shared/session/sessionViewUpdate.ts:475-478`                                                                                                                                                                        | V1 + held + pending request                                                                     |
| V5  | `RunView.working`, `.live`, `.runsHere`, `.turnOver`                                                                                                  | `shared/session/sessionViewUpdate.ts:460-464`, `:509`                                                                                                                                                                | four booleans over V1 + held + paused                                                           |
| V6  | `RunView.statusKey` (12 keys) + `tone`                                                                                                                | `shared/runs/runStatusDisplay.ts:29-42`, `runStatus() :58-70`: `interrupted` > `waitingOnUser` > substate > status                                                                                                   | V1+V2+V4 as one word                                                                            |
| V7  | `RunView.statusNotice.kind` (`interrupted`, `held`, `lost`, unreadable)                                                                               | `shared/session/sessionViewUpdate.ts:491-497`                                                                                                                                                                        | interrupted, a third time                                                                       |
| V8  | `RunView.actions` includes `stop`/`resume`; `.forceExpanded`; `.approval`; `rollup.{running,finished}`; `session.rollup.interrupted`                  | `shared/session/runActions.ts:59-80`, `shared/session/sessionViewUpdate.ts:479-490`, `rollupOf shared/session/sessionView.ts:245-261`, `countGroups shared/session/sessionViewUpdate.ts:214-220`                     | the same bits, as offers and counts                                                             |
| V9  | `RunView.runStartedAt` / `turnStartedAt`, `.output`, `.lost`, `.turn` (nulled at R1)                                                                  | `shared/session/sessionViewUpdate.ts:510`, `:725-728`, `:785-790`                                                                                                                                                    | running / ended / resumed, as side effects                                                      |
| P1  | `isTerminalOutcomePhase`, `isInFlightPhase`, `isTranscriptSettlementPhase`                                                                            | `shared/runs/runStatus.ts:39-60`; 24, 7, 6 refs                                                                                                                                                                      | V1 read back as three bits                                                                      |
| P2  | `phaseMoveOf`, `closesRunWindow`                                                                                                                      | `shared/session/runRowReads.ts:211-234`; readers `shared/session/sessionViewUpdate.ts:805,969`, `shared/session/transcriptUpdate.ts:341`, `agent/runtime/SessionEvents.ts:94`, `controllers/session/runTrace.ts:189` | a second row→phase mapping beside `PHASE_AT` and `applyRunEvent`                                |
| P3  | `lastLifecycleRow`, `runEndFromEvents`, `lifecycleStart`, `runEndOf`'s window, `turnReceipt`'s activate/end walk                                      | `shared/session/runFacts.ts:208-223`, `controllers/session/runTrace.ts:216-224`, `agent/storage/runRecords.ts:206-215`, `shared/session/runRowReads.ts:302-305`                                                      | "which rows bound a lifecycle", four times                                                      |
| P4  | `RESTING_SUBSTATES`, `parkSubstate`                                                                                                                   | `shared/schemas/run.ts:79-92`                                                                                                                                                                                        | R4 as a substate                                                                                |
| P5  | `continuesFromRows` (view) / `deriveResumability` (rows) / `AgentRunListingEntry.{outcome,paused,resumable,resumeBlocked}` / CLI `HISTORY_RUN_STATUS` | `shared/session/runActions.ts:95-97`, `agent/storage/resumability.ts:34-73`, `shared/schemas/runRecords.ts:169-192`, `packages/cli/src/runtime/history.ts:57-100`                                                    | "can it continue", four vocabularies                                                            |
| P6  | `taskGroupDisplayStatus`                                                                                                                              | `shared/runs/taskGroupProjection.ts:30-37`                                                                                                                                                                           | V3 painted onto a group                                                                         |

Count: 7 stored, 4 in the loop state, 2 groups in `RunRows`, 9 groups on the
view, 6 predicate families. "Interrupted" alone is spelled seven ways on one
`RunView` (V4, V6, V7, `forceExpanded`, `actions` has `resume`,
`rollup.interrupted`, `tone: warning`) and hosts still read two of them
directly (`packages/cli/src/chat/tui/state/sessionView.ts:103`,
`packages/texra/src/ui/progress/components/TaskGroupList.ts:366`).

**Which survives.** Three facts, three fields, one place: `position`
(`'ready' | 'running' | 'waiting'`, from R1/R2/R4), `outcome`
(`RunOutcome | null`, from R6), `holder` (whether this process runs it, from
the registry under O1). Everything in V2–V8 and P1/P4/P6 is a function of
those three plus the open-request set, computed by one `runStatus(view)` at
the app's copy table, not stored as nine fields the fold must keep
consistent. See Finding 1.

---

## Findings

### 1. `RunView.status` is two facts in one enum; the fold then re-splits it into eight fields

**Red flags:** two representations of one fact (by construction), a union as
a state machine, comments substituting for design.

**Evidence.** `RUN_PHASE` reuses the three `RUN_OUTCOME` literals as phases
(`shared/schemas/run.ts:36-42`), so `status === 'completed'` means "ended, outcome
completed" and `status === 'waiting'` means "live, between turns". The fold
writes `status` from four row kinds (`shared/session/sessionViewUpdate.ts:723` activate,
`:784` end, `:818` position and park) and then, in `withAggregates`
(`:443-530`), takes it apart again:

```ts
const durableOutcome = isTerminalOutcomePhase(run.status) ? run.status : null;   // :459
const working = !interrupted && !paused && run.status === RUN_PHASE.RUNNING;     // :460
const turnOver = isTranscriptSettlementPhase(run.status) || (interrupted && !…); // :461
const live = held && !paused && durableOutcome === null;                         // :464
```

`turnOver` equals `!working` except during the `ownerUnread` window
(`:241-243`, `:463`), a readiness flag kept so a freshly created run is not
painted final before its claim is read; one host still reads
`isTranscriptSettlementPhase` instead of either (`packages/cli/src/chat/tui/runChatTui.tsx:790`, noted
open in table B). `statusKey` (`shared/runs/runStatusDisplay.ts:58-70`) is a priority
ladder over `interrupted`, `waiting`, `substate`, `status`; its 12 keys mix a
phase, a substate, `ready`, and two "readings". `RunNotice` (`shared/schemas/sessionViewInput.ts:50-55`)
says `interrupted` a third time. `rollupOf` (`shared/session/sessionView.ts:245-261`) decides
"idle" from `status === WAITING && (group === 'running' || substate === PAUSED)`,
a fourth derivation. The doc comment on `status` (`shared/session/sessionView.ts:120-125`)
is five lines explaining which row sets which value: the structure, not the
prose, is what needs fixing.

**The decision behind it.** The view stores the vocabulary hosts print
instead of the facts hosts decide from, so every new question ("is a clock
ticking", "may I stop it", "is the transcript final") becomes a new stored
field with its own derivation and its own drift (the three 2026-11-04 fixes
in table B were exactly this).

**Better design.** `RunView` carries the facts: `position: 'ready' | 'running' | 'waiting'`,
`outcome: RunOutcome | null`, `holder: 'here' | 'none'` (under O1; `'elsewhere'`
goes with the claims), `pendingRequest: boolean` (blocking), `paused: boolean`
(until Finding 4 removes it). One function in the app's copy module
(`packages/texra/src/ui/copy/runStatus.ts`) maps those to the word, tone, group, and offers;
`actions` stays on the view as the one place that licenses host actions
(AGENTS.md "one home per user action") but takes the facts, not `group`.
Deleted: `RUN_PHASE` (keep `RUN_OUTCOME`), `RunLifecycleStatus`,
`RUN_LIFECYCLE_READY`, `RunView.status`, `substate` (see 4 and 6),
`durableOutcome` (= `outcome`), `group`, `working`, `turnOver`, `live`,
`statusKey`, `tone`, `statusNotice.interrupted`, `forceExpanded`,
`isTerminalOutcomePhase` (24 refs / 12 files), `isInFlightPhase` (7/5),
`isTranscriptSettlementPhase` (6/4), `RUN_STATUS_TONE_OF`, `runStatus()`,
`RESTING_SUBSTATES`, `parkSubstate`, `taskGroupDisplayStatus`'s
`runDurableOutcome` parameter, `TaskGroupStatusSchema`'s reuse of phases.
Hosts write against `run.position`, `run.outcome`, `run.actions` and the one
label function. This is O6 taken to its end: O6 added `working`/`runsHere`
as more derived fields; the fix is fewer.

**What we give up.** `statusKey` as a stable wire enum for the TUI and dock
(18 files read it); the `RunView` schema changes shape, which is fine before
1.0. Risk: the label ladder's priorities (`interrupted` outranks
`waitingOnUser`) must be written once in the copy function and the three
hosts' snapshot tests re-baselined.

**Change amplification.** "A run gets a fourth terminal outcome
(`timed-out`)". Today: `RUN_OUTCOME`, `RUN_PHASE`, `TaskGroupStatusSchema`,
`RUN_STATUS_TONE_OF`, `RUN_STATUS_LABEL` (app), `HISTORY_RUN_STATUS` (CLI),
`isTerminalOutcomePhase`, `outcomeFromCause`, the `positionRow` overload that
excludes `cancelled` (`agent/runtime/loop/rows.ts:64-69`), `unansweredBy`, `runActions`'s
`status !== COMPLETED`, `rollupOf`, `taskGroupDisplayStatus`,
`packages/cli/src/chat/chatSessionController.ts:1019`, `packages/texra/src/controllers/server/handlers.ts:212`, `packages/texra/src/controllers/onboarding/onboardingFunnel.ts:77`:
16 files. After: `RUN_OUTCOME`, the copy table, `outcomeFromCause`: 3.

### 2. The row→phase rule is written four times, and "which rows bound a lifecycle" five

**Red flags:** information leakage; a protocol known by several modules.

**Evidence.** The mapping "this row moves the run to this phase" exists as
`PHASE_AT` (`shared/runs/runStatus.ts:84-92`, position → loop phase, for the loop),
`phaseMoveOf` (`shared/session/runRowReads.ts:211-227`, activate/position/park/end → view
phase, for the transcript boundary, the publisher's open streams and the
trace export), `applyRunEvent` + `movePhase` (`shared/session/sessionViewUpdate.ts:709-730`,
`:764-766`, `:780-791`, `:815-822`, for the view) and `recordFacts`
(`shared/session/runRowReads.ts:74-83`, activate clears `end`, for `RunRows`). The three
disagree on purpose: a halt moves nothing in `phaseMoveOf` (`:216`) and
`PHASE_AT`, but sets `forkPoint` and `ix.lastWait` (`shared/session/sessionViewUpdate.ts:800-803`,
`shared/session/transcriptUpdate.ts:336-340`); `child.park` is a phase move for the view and
transcript but a record for `RunRows`.

"The current lifecycle is the rows since the last `run.activate`, unless a
`run.end` follows it" is computed by `lastLifecycleRow` (`shared/session/runFacts.ts:208-214`),
`lifecycleStart` (`controllers/session/runTrace.ts:216-224`), `runEndOf`'s `start`/`during`
window (`agent/storage/runRecords.ts:206-215`, which also zeroes `usage` per
activation), `turnReceipt` (`shared/session/runRowReads.ts:302-305`), `recordFacts`'s
`activation`/`end` reset (`:74-83`), `endIn`'s `facts.end?.outcome` test
(`agent/storage/runLifecycle.ts:231`) and `agent/runtime/childRunLoop.ts:662`. `effect/runHandle.ts:45` and
`controllers/session/runTrace.ts:298` filter a tail with `lastLifecycleRow([row], runId)`, which
is `row.type === 'run.activate' || row.type === 'run.end'` spelled as a fold.

**The decision behind it.** The rows carry two independent facts, "a process
took the run" (`run.activate`) and "the run ended" (`run.end`), and every
reader re-derives the window between them. Nothing on the rows says "this is
activation N" or "this end closes activation N".

**Better design.** One `lifecycle(rows)` reader in `shared/session/runRowReads.ts` that
returns `{ activation: RowOf<'run.activate'> | null, end: RowOf<'run.end'> | null, from: seq }`
and is the only code that names the pair; `phaseMoveOf` becomes the only
row→phase function and `applyRunEvent`'s activate/end/park cases call it
(the view then has one phase writer, `movePhase`, fed by `phaseMoveOf`).
Deleted: `lastLifecycleRow` (9 refs / 4 files), `runEndFromEvents` (5/3),
`lifecycleStart`, the inline walk in `turnReceipt`, `PHASE_AT`'s duplication
of the `waiting` decision (keep the loop-phase table, derive the "waits" bit
from `phaseMoveOf`). If Finding 6 lands (`activatedAt` on the state), the
window is a commit comparison and `runEndOf`'s two-pass fold (`agent/storage/runRecords.ts:217-234`)
becomes `applyRunRows` over rows with `commit > activatedAt`.

**What we give up.** Nothing user-visible. Risk: `runEndOf`'s usage zeroing
per activation is subtle and under-tested (0 tests name `runEndFromEvents`).

**Change amplification.** "A third kind of child (a remote worker) that
waits on its own row": today `phaseMoveOf`, `applyRunEvent`, `recordFacts`,
`rollupOf`, `parkSubstate`, `RUN_ROW_READS.parks`, `runActions` (5 files
minimum). After: one `phaseMoveOf` case.

### 3. The halted `run.position` restates `run.end`

**Red flags:** two representations of one fact; a row that restates loop
state (the guide's own rule, `packages/harness/AGENTS.md` "no row restates
loop state").

**Evidence.** `haltedPositionRow` (`agent/runtime/loop/rows.ts:88-106`) is "written only
with the run's `run.end`" (`:88-90`) and carries the same `outcome`
(`shared/schemas/runHistoryEvent.ts:106-110`, the check at `:111-119` forces one). The fold
copies it to `RunPosition.outcome` (`shared/session/runRows.ts:205`), which has no reader
in production: grep over `packages/*/src` for `rows.outcome`/`state.outcome`
finds only the setter. What the halt row does serve: `forkPoint`
(`shared/session/sessionViewUpdate.ts:800-803`), `ix.lastWait` (`shared/session/transcriptUpdate.ts:336-340`),
the trace viewer's scrubber (`packages/trace-viewer/src/traceFrames.ts:29-35`) and
the "a stopped run never reads as interrupted" comment (`agent/runtime/loop/rows.ts:89-90`),
which the end row already guarantees (`durableOutcome !== null` ⇒ not
interrupted, `shared/session/sessionViewUpdate.ts:457-464`). `endIn` writes it only when a
position exists (`agent/storage/runLifecycle.ts:249-252`), so a run that ends before its
opening has no halt: readers already cannot rely on it. The payload check
"only a halted or turn.end position carries an outcome"
(`shared/schemas/runHistoryEvent.ts:111-119`) and
`PositionAt`'s `halted` literal, `applyRunRow`'s `at === 'halted' ? rows.at : p.at`
(`shared/session/runRows.ts:200-206`), `phaseAfter`'s halt case (`shared/runs/runStatus.ts:93-97`),
`phaseMoveOf`'s (`shared/session/runRowReads.ts:216`) and `RunPosition.at`'s
`Exclude<PositionAt, 'halted'>` (`shared/session/runRowsShape.ts:37`) all exist to carry a
row nothing decides from.

**Better design.** Delete `halted` from `PositionAt`; `run.end` is the halt.
`forkPoint` and `lastWait` read the newest `waiting` position or the end row
(`phaseMoveOf(end) !== running` already says "rest"). `run.position` v4,
golden store regenerated. Deleted: `haltedPositionRow`, the `halted` literal
and its five special cases above, `RunPosition.outcome`, the payload filter's
halt half. `endIn` loses `halt` and its `facts.position` read
(`agent/storage/runLifecycle.ts:249-252`).

**What we give up.** The trace viewer scrubber loses a final frame; it can
stop at the end row instead. Risk: low; one row kind version bump.

**Change amplification.** "A stop wants to record where the loop stood":
today the halt row + `RunPosition.outcome` + four special cases; after, the
newest `run.position` already says it.

### 4. `child.park` is a state machine in optional fields, duplicated by `child.turn`

**Red flags:** state machine in optional fields; special and general code
mixed; two representations of one fact. (Table A lists `heldFor` and the
delivery duplicates under O5. The new angle: after O5 the row is still two
representations and a special case.)

**Evidence.** `child.park` is `phase ∈ {parked, resumed, paused}` with
`resumeId?`, `heldFor?`, `ends?` (`shared/schemas/sessionEvent.ts:252-266`); which
combinations are legal is stated in a nine-line comment, not a type.
`child.turn` is `accepted | settled` (`:356-360`). `beginTurn` commits
`park resumed` and `turn accepted` in one transaction (`agent/runtime/childRunLoop.ts:399-408`);
`turnResultPart` commits `turn settled` with `park parked` (`agent/runtime/childTurnResult.ts:170`,
`:282-295`; `agent/runtime/childRunLoop.ts:565`). One boundary, two rows: one display, one
private, because the listing serves only display rows (`shared/schemas/rowVersions.ts:30-39`
says `child.park` is listed "so a cold listing that dropped it would not
paint every parked child as busy"). A loop-driven run records the same fact
as `run.position { at: 'waiting', turn: null }`; the view's doc comment
admits the child "has no loop to step" (`shared/session/sessionView.ts:121-123`), yet
`RunPositionPayload.turn` is already nullable (`shared/schemas/runHistoryEvent.ts:103-105`).
The special case then spreads: `parkSubstate` (`shared/schemas/run.ts:79-85`),
`RESTING_SUBSTATES` (`:89-92`), `RUN_SUBSTATE.PAUSED/RESULT_WAITING`
(`:63-72`), `rollupOf`'s idle rule (`shared/session/sessionView.ts:251-253`),
`phaseMoveOf`'s park case (`shared/session/runRowReads.ts:220-221`), `movePhase`'s second
caller (`shared/session/sessionViewUpdate.ts:764-766`), `RUN_ROW_READS.parks`, `heldParks`
(11 refs / 4 files), `RunRows.park`, `agent/runtime/delegation/childRun.ts:154-158`'s `substate !== PAUSED`
check, `agent/storage/runListing.ts:61` and the CLI's `HISTORY_RUN_STATUS.PAUSED`
(`packages/cli/src/runtime/history.ts:59-61`).

**The decision behind it.** The child loop (`agent/runtime/childRunLoop.ts`) wanted its
own vocabulary for "between turns" instead of the run's.

**Better design.** A child between turns writes `run.position { at: 'waiting', turn: null }`
like every run; a paused child is a `run.end { outcome: 'cancelled', reason: 'user' }`
whose resume re-enters through the same `resume` that every run has (the
`resumeId` is the run id: `agent/runtime/delegation/childRun.ts:109-111` stores it only to look the
run up again). `child.turn`'s key `(attemptId, turnIndex)` stays as the one
private record of turn identity, or moves onto the position row's `turn`.
Deleted: the `child.park` kind (15 refs / 10 files; 5 writers), `parkSubstate`,
`RESTING_SUBSTATES`, `RUN_SUBSTATE.PAUSED`, `RUN_SUBSTATE.RESULT_WAITING`
(with O5), `RUN_ROW_READS.parks`, `RunRows.park/heldParks`, `phaseMoveOf`'s
park case, `movePhase`'s park call, `rollupOf`'s idle rule, the CLI's
`paused` status and `AgentRunListingEntry.paused` (`shared/schemas/runRecords.ts:175`).

**What we give up.** The "Paused" word (a paused child reads "Stopped,
resumable"); a child's continuation by its parent's next call is a resume of
a cancelled run, which is what it is. Risk: the parent's `agent` tool
re-entering a cancelled child must be accepted by `runActions` (it is: a
cancelled loop-driven run offers `resume`, `shared/session/runActions.ts:73-80`).

**Change amplification.** "A host adds a surface listing runs": today it
must know `status`, `substate`, `group`, `paused`, `live` (the CLI
`cliRunStanding` is the proof, `packages/cli/src/runtime/history.ts:81-100`); after, `position` and
`outcome`.

### 5. The approval grants ride two row kinds, and a born-detached child writes both

**Red flags:** two representations; a listing limitation leaking into the
row vocabulary; a draft built in one module and rewritten in another.

**Evidence.** `run.start.approvalPolicy` (`shared/schemas/sessionEvent.ts:190`) exists
because "under the latest-of-type rule a run never edited would otherwise
have no policy entry" (`:175-179`): the listing projection's shape chose a
stored field. `approval.policy` (`:307`) carries the same snapshot. Both are
read into the same slots: `recordFacts` run.start → `grants` and
`approval.policy` → `grants` (`shared/session/runRowReads.ts:66-71`); `applySessionFacts`
run.start → `view.policy` and `approval.policy` → `view.policy`
(`shared/session/sessionViewUpdate.ts:833-843`). `birthRows` (`agent/runtime/loop/runProgram.ts:52-74`)
takes the registration built by `registrationDrafts` (`shared/session/runFacts.ts:282-314`),
finds the `run.start` by identity (`row === start`), rewrites its `parent`
to null and appends an `approval.policy` row, so a born-detached child's
first batch carries the grants twice. The listing already serves one row per
`(aggregate, 'approval.policy')` key (`shared/schemas/rowVersions.ts:184`, `'own'`).

**Better design.** Grants are one kind, `approval.policy`, committed in the
birth batch beside `run.start` (`RunCell.append` already commits the
registration with the opening batch: `shared/session/runHistory.ts:256-263`). `run.start`
loses `approvalPolicy` (v3); `recordFacts` and `applySessionFacts` lose a
case each; `view.policy` is read from the run's `approval.policy` latest row
as today; `birthRows` stops editing another module's draft (see Finding 8).
Deleted: `RunStartEventSchema.approvalPolicy`, the two run.start grant
readers, `grantSource`'s `own.grants ?? NO_APPROVAL_GRANTS` fallback for a
start with none (`shared/approvalBypassKind.ts:221`).

**What we give up.** The trace viewer's synthetic `run.start` "carries none"
(`shared/session/sessionViewUpdate.ts:834-836`), which is the current default anyway.

**Change amplification.** "Grants gain a field": today `ApprovalPolicySnapshotSchema`
plus two carriers and two readers each (4 sites); after, one carrier, one
reader.

### 6. Activation is carried by the loop state as two accumulators and by the view as two words

**Red flags:** state machine in optional fields; a derived accumulator where
one coordinate would do; the same fact spelled in both folds. (Answers Q3.)

**Evidence.** `RunState.decidedSinceActivation: ReadonlySet<string>` is
rebuilt at every `run.activate` (`shared/session/runState.ts:337-345`) and grown at every
`request.decided` (`:300-304`, a `new Set([...])` per row); its one reader is
`resumedAttempt` (`shared/session/inFlight.ts:353-377`), which uses it to tell "decided
before the previous process died" from "decided since this one took the
run". `RunState.resuming: boolean` (`shared/session/runState.ts:130-131`) is "activate after the last
position", read once (`agent/runtime/loop/toolUse.ts:425`) to rewrite a `waiting` position
"an activation clears the step the view shows". The view spells the same
boundary as `substate: starting | resuming` (`shared/session/sessionViewUpdate.ts:714-720`),
decided by `isPlainAgentIdentity` and `status === 'ready'`, a special case
inside the general activate handler, cleared by `movePhase` (`:819`); it
also nulls `turn` at activation (`:726`) while `RunRows.turn` keeps it, so
the two folds disagree on the run's turn until the next position.
`RunRows` keeps `activation` and `lifecycles` (`shared/session/runRowsShape.ts:76`, `:116`).

**Is activation a fact the rows should know?** Yes, as a lifecycle boundary:
it is what `runEndOf` zeroes usage from, what the trace export starts from,
what the receipt rule reads, and under O1 "a process took the run" is the
one durable mark of a restart. It is not a fact the loop should _accumulate
over_: both `decidedSinceActivation` and `resuming` are "X's commit >
activation's commit".

**Better design.** `RunState.activatedAt: CommitOrdinal | null` (the
activate row's commit) and `RequestState.decidedAt: CommitOrdinal | null`
(the decided row's commit, `shared/session/runRowsShape.ts:21-26` gains one field).
`resumedAttempt` tests `decidedAt > activatedAt`; the loop tests
`activatedAt > position.commit`; the view's `starting`/`resuming` becomes a
display question ("is there a position since the activation", which it
already has as `turn === null`). Deleted: `decidedSinceActivation` (7 refs /
2 files), `resuming` (6 refs / 2 files), `RUN_SUBSTATE.STARTING/RESUMING`,
the identity special case at `shared/session/sessionViewUpdate.ts:715-720`, the
`turn: null` reset, `RunRows.lifecycles` once Finding 2 lands.

**What we give up.** Nothing. Risk: `resumedAttempt`'s rule is the subtlest
in the loop and has 0 direct tests; the commit comparison is strictly the
same predicate, so one regression test on it (decided during load, before
dispatch) is the bar.

**Change amplification.** "A resume must also know the configuration at
activation": today `RunRows.activation`, `activationRows`'s stored-vs-next
diff (`agent/storage/runLifecycle.ts:79-97`), `substate`; after, one coordinate the
`run.config` row's commit is compared against.

### 7. The fold's errors: strings, a four-arm verdict, a five-reason error that one reader branches on, and a throw

**Red flags:** errors re-classified at each layer; a reason literal nothing
branches on is a message, not a kind (AGENTS.md); an error arm kept alive
for a case the storage already defines out of existence; a stale comment.
(Answers Q4.)

**Evidence.**

- `invocationAfter`, `openedBy`, `movedBy` return `Invocation | null | string`
  (`shared/session/inFlight.ts:96-168`); `closedTo` and `unreportedCall` return
  `string | null` (`shared/session/turnRowHandlers.ts:91-102`, `:132-151`). Each caller
  tests `typeof x === 'string'` and wraps with `outOfOrder(x)` (`:163-165`,
  `:347-352`, `:377-381`).
- `applyRunRow` returns `RunRowVerdict` with `applied | unchanged | unresolved | contradiction`
  (`shared/session/runRowsShape.ts:136-144`) and two overloads (`shared/session/runRows.ts:171-180`)
  because "the two readers treat a decision for an unknown request
  differently" (`:14-19`). The run state maps `unresolved` and
  `contradiction` to `outOfOrder` (`shared/session/runState.ts:293-297`); `runRowsFrom`
  _throws_ `new Error` on both (`shared/session/runRowReads.ts:166-174`); the view throws on
  `contradiction` and ignores `unresolved` (`shared/session/sessionViewUpdate.ts:875-878`);
  `recordOf` ignores everything but `applied` (`shared/session/runRowReads.ts:191-192`).
- The view's rationale, "a cold listing delivers one request row per run,
  so the opening a decision answers may never have reached this view"
  (`shared/session/sessionViewUpdate.ts:866-870`), does not match the projection: a
  `request.decided` has a pending key with `open: false`, which _deletes_
  the entry (`shared/schemas/sessionEvent.ts:503-518`, `controllers/session/projections.ts:112-122`),
  so the listing never serves a decision; an open request is served by its
  pending key, so a tail decision always follows a served opening. As far
  as the projection shows, `unresolved` is unreachable, and the comment is
  false.
- `RowRejection` → `RunHistoryInconsistent` (5 `reason` literals,
  `shared/session/runState.ts:75-88`) → `RunHistoryRefused { reason: 'inconsistent', cause }`
  (`agent/runtime/RunHistory.ts:183-189`) → `runReadRefusal` → `'unusable'`
  (`shared/session/runHistory.ts:168-183`) → `ResumabilityDecision.unusableCheckpoint`
  (`agent/storage/resumability.ts:48-56`) → `AgentRunListingEntry.resumeBlocked: string`
  (`shared/schemas/runRecords.ts:188`). Of the five inconsistency reasons, one is read:
  `mismatched-delivery` turns a failure into a defect (`agent/runtime/RunHistory.ts:257`).
  The other four are messages with an enum.

**Better design.** One rejection type for the fold, `RunHistoryInconsistent({ detail, commit })`,
returned as `Result` from every helper (`invocationAfter` and friends return
`Result<Invocation | null, string>` or take the state and return the
rejection directly); `mismatched-delivery` is a defect raised where it is
detected (`shared/session/turnRowHandlers.ts:257-264` already knows it is the writer's own
batch), not a reason the caller re-reads. `applyRunRow` returns
`Result<Partial<RunRows>, RunHistoryInconsistent>` with one signature and
no `unresolved` arm; `runRowsFrom`, `recordOf` and the view propagate the
same `Result` (the view's updater already documents that a throw leaves it
half-applied, `shared/session/sessionViewUpdate.ts:95-97`). Deleted: `RunRowVerdict`'s
`unchanged`/`unresolved` arms (the "already recorded" case returns the same
rows), the two overloads and the `slice`/`positionOnly` guard
(`shared/session/runRows.ts:154-158`, `:187-189`), `RowRejection`, the `reason` field of
`RunHistoryInconsistent`, `outOfOrder` (11 call sites become `Result.fail`),
the string channel in `shared/session/inFlight.ts` and `shared/session/turnRowHandlers.ts`.

**What we give up.** `RunHistoryRefused.reason === 'inconsistent'` stays
(it is one of five refusal reasons with a reader, `runReadRefusal`); the
inconsistency's sub-kind is only ever shown. Risk: low; the fold has one
test file per entry point.

**Change amplification.** "A new row invariant": today a string helper, an
`outOfOrder` wrap, possibly a new reason literal and its comment at
`shared/session/runState.ts:78-84`; after, one `Result.fail(new RunHistoryInconsistent(...))`.

### 8. Registration, activation and end: drafts built in `shared`, committed in `storage`, edited in `loop`, chosen by a boolean

**Red flags:** temporal decomposition; single-caller extractions; an option
for a special case; a mode in optional fields. (Answers Q5.)

**Evidence.** `registrationDrafts` (`shared/session/runFacts.ts:282-314`),
`activationDrafts` (`:318-329`) and `runEndDraft` (`:334-354`) each have one
production caller (`agent/storage/runLifecycle.ts:145`, `:92`, `:241`) and 0 tests.
`registrationDrafts(runId, config, options, born, ended)` takes a boolean
`born` that picks which rows to emit (`:305-310`) and returns
`Registration { rows, start: born ? start : null }` (`:262-265`), a state
machine in a nullable. `registerRun` then re-reads that boolean to choose
`born ? { registration: rows } : { activation: () => rows }`
(`agent/storage/runLifecycle.ts:110-113`), and `RunOpening` is three optional modes,
`registration?`, `activation?`, `within?` (`shared/session/runHistory.ts:256-279`).
`birthRows` (`agent/runtime/loop/runProgram.ts:52-74`) takes the registration a third
module built, finds the start row by object identity, and rewrites it. The
end: `runEndDraft` is built in `shared`, `endIn` adds the halt, the consumed
rows, the closure and the cancelled requests (`agent/storage/runLifecycle.ts:240-259`,
`:268-272`), and `finalizeRun` decides the outcome twice more (`:338-343`,
`:389-393`; the lead auditor's three-level fallback). "Which rows register,
activate and end a run" is therefore known by `shared/session/runFacts.ts` (builds),
`agent/storage/runLifecycle.ts` (commits and adds), `agent/runtime/loop/runProgram.ts` (edits), `RunHistory`
(opens by mode), and read back by `recordFacts`, `applyRunEvent`,
`ROW_HANDLERS` — seven files. The `shared/` location of the builders was
chosen "beside the readers of their facts" (`shared/session/runFacts.ts:11-13`), but a
builder is not a reader: it has no `shared` consumer.

**Better design.** The lifecycle transactions own their rows. Three
functions in `agent/storage/runLifecycle.ts`, each one transaction whose
rows are decided from what it reads under the lock: `birth(runId, record, options)`
(run.start, run.config, approval.policy, run.activate, description),
`activate(runId, record)` (run.activate, grants, config-if-changed) and
`end(runId, ending)`. `RunHistory.open` takes one `opening: Effect<rows>`
and no mode: a birth's rows start with `run.start`, an activation's with
`run.activate`, and the cell learns which from the rows (it already applies
them). The born-detached child's edge is decided inside `birth` from the
registry (the one caller that needs it passes `detached: boolean` as a fact
it holds, not a draft to rewrite). Deleted: `registrationDrafts`,
`activationDrafts`, `runEndDraft`, `Registration`, `RegisterRunOptions.seed`'s
leak into `shared` (3 refs each), `RunOpening`'s three optionals,
`registerRun`'s mode switch, `birthRows`'s identity rewrite.

**What we give up.** Nothing. Risk: the cell's precondition "a batch on an
unopened run carries the `run.position` that opens it unless it is a
registration alone" (`shared/session/runHistory.ts:224-226`) must still hold; it is checked
in `contractViolation`, not by the mode.

**Change amplification.** "A run gains a launch fact (say a budget)": today
`RegisterRunOptions`, `registrationDrafts`, `RunStartEventSchema`,
`birthRows`'s rewrite survives it only if the field is not the one edited,
`createRun` in the view, `recordFacts`: 6 files. After: `birth` and the
schema and the two readers: 4.

### 9. "Can this run continue?" is decided in four vocabularies

**Red flags:** two representations; a general rule with a view copy and a
rows copy; a host re-deriving.

**Evidence.** `continuesFromRows` (`shared/session/runActions.ts:95-97`) is documented as
"the one standing `deriveResumability` reads from a run's records and
`runActions` from its view, so the two never decide apart": one function,
two callers over two data sources, each wrapped in its own result union.
`deriveResumability` (`agent/storage/resumability.ts:34-73`) returns five kinds; the
listing writes `resumable: boolean` plus `resumeBlocked?: string`
(`agent/storage/runListing.ts:56-63`, `shared/schemas/runRecords.ts:181-188`); the CLI then
folds `outcome`, `paused` and `resumable` into a sixth enum
`HISTORY_RUN_STATUS` (`packages/cli/src/runtime/history.ts:57-100`) while the view already carries
`actions.includes('resume')` (25 `actions.includes` sites) and
`statusNotice` for the unreadable case (`shared/session/sessionViewUpdate.ts:492`).
`runActions` reads `group === 'interrupted'` to offer resume (`:77`), so the
view's answer depends on Finding 1's seven-way "interrupted".

**Better design.** The view's `actions` is the one answer for hosts (it is
already computed from `stranded`/unreadable and the rows' identity and
recipe); `deriveResumability` stays as the harness-side gate a resume runs
under (it reads rows under the claim), returning the typed refusal of table
A's "why a resume is refused" row. `AgentRunListingEntry.resumable/resumeBlocked`
and the CLI's `HISTORY_RUN_STATUS` are deleted: the listing entry carries
`actions` and `outcome` (`texra history`'s NDJSON contract gains `actions`
and keeps `outcome`; `resumable` is `actions.includes('resume')`).
Deleted: `continuesFromRows`'s second caller, `AgentRunListingEntry.resumable`,
`.resumeBlocked`, `.paused`, `HISTORY_RUN_STATUS`, `cliRunStanding`,
`CliRunFacts`.

**What we give up.** The frozen `status` word in the NDJSON stream that
`texra-action` reads (`packages/cli/src/runtime/history.ts:81-84`): a breaking change to one external
consumer, which 1.0 allows ("formats with consumers outside TeXRA ... reject
anything else with a clear error").

**Change amplification.** "A run becomes resumable under a new condition":
today `continuesFromRows`, `runActions`, `deriveResumability`, `runListing`,
`cliRunStanding`: 5. After: `runActions` and `deriveResumability`: 2.

### 10. `RunRows` is nine reads sharing one 23-field record; `recordOf` is a type narrowing dressed as a fold

**Red flags:** shallow module; information leakage (the caller must know
which read fills which field); pass-through.

**Evidence.** `RunRows` (`shared/session/runRowsShape.ts:59-120`) has 23 fields "each
empty unless the read selected its kind" (`:112-115`). `RUN_ROW_READS`
(`shared/session/runRowReads.ts:38-57`) names nine reads; the type does not say that
`'parks'` fills `heldParks` and `park` but not `position`, or that
`'lifecycle'` fills `lifecycles` and `end` but not `start`. Callers encode
the pairing by hand: `agent/runtime/runLaunchGuard.ts:137-141` reads `'parks'` for
`heldParks`; `agent/runtime/forkRun.ts:111` reads `'positions'` for `positions`;
`agent/storage/runRecords.ts:65` reads `'lifecycle'` for `lifecycles`;
`agent/runtime/requestPolicy.ts:310` reads `'requests'`; `agent/runtime/delegation/agentChild.ts:310` reads
`'results'`; `agent/runtime/scriptRun.ts:68` reads `'script'` for `scriptCalls` and
`results`; a wrong pairing returns a silently empty field. `log.facts(runId)`
(`shared/session/sessionLog.ts:124`) is a tenth read with its own description. `recordOf(row)`
(`shared/session/runRowReads.ts:187-193`) folds one row into a fresh 23-field record so six
callers can write `recordOf(row).end` (`agent/runtime/HostInteractions.ts:311`),
`.start` (`transcript/traceAssembler.ts:95`), `.facts` (`tools/plugins.ts:218`),
`.followUps[0]` / `.heldParks[0]` (`agent/runtime/runLaunchGuard.ts:224-231`), each of
which is `row.type === 'run.end' ? row : null` with extra steps.

**Better design.** One function per read with its own return type, or
`runRows` typed by a mapped `Reads` table so `log.runRows(id, 'lifecycle')`
returns `{ activation, end, lifecycles }` and nothing else; `RunRows` keeps
only the fields every read shares (position and input). `recordOf` is
deleted; its six callers narrow on `row.type`. Under Findings 2–4 the
`parks`, `lifecycle` and `positions` reads disappear, which brings the table
to six reads.

**What we give up.** One shape for every reader. Risk: none; this is types.

**Change amplification.** "A new reader needs the run's script calls and
its end": today a new `RUN_ROW_READS` entry, a mental note of which fields
it fills, and a caller that may read an empty one; after, one typed read.

### 11. Batched smaller items

- **Topology spelled five ways per view row.** `parentId`, `launchParentId`,
  `parentCard`, `ancestors`, `childIds` (`shared/session/sessionView.ts:181-198`), kept
  consistent by `relink`/`refreshAncestors`/`walkUp` (`shared/session/sessionViewUpdate.ts:420-428`,
  `:932-959`). `ancestors` has 8 readers, `launchParentId` 2
  (`agent/runtime/delegation/agentChild.ts:255-257`), `parentCard` 6 (all `shared/transcript/scriptStage.ts` and
  `agent/runtime/historyQuery/views.ts`). Two representations of the parent edge on the
  view (table E covers the rows vs view half); the fix is `parent: { id, card } | null`
  and `descendantRuns` as the one walk.
- **`forkPoint` vs `ix.lastWait`.** The same seq is kept on the view
  (`shared/session/sessionViewUpdate.ts:803`) and in the transcript working state
  (`shared/session/transcriptUpdate.ts:336-340`, read at `shared/session/transcriptLogRows.ts:73-75`);
  one reader each.
- **`hasHistoryRows`** (`shared/session/runState.ts:98-99`, `:513`) is a boolean computed
  from a handler's `requires !== 'existing'` so `loaded` can tell "no
  history rows" from "rows but no opening" (`agent/runtime/RunHistory.ts:200-215`). It is
  `phase === null && messages.length === 0 && …` spelled as a flag; with the
  `Requirement` table it is the one place where the row-type classification
  (`RunStateRowType` vs `CardRowType`, `shared/session/runState.ts:156-174`) is read at
  runtime.
- **`followup.closed` / `inputClosed`.** Three rows set one bit
  (`shared/session/runRowReads.ts:74-88`): activate clears it, closed and removed set it.
  Its writer exists for the claim era ("closed until a claim reopens it",
  `shared/schemas/sessionEvent.ts:325-327`; `agent/followUp/Inbox.ts:210`); its readers are `agent/runtime/resumeRun.ts:190`
  and `agent/followUp/Inbox.ts:178,275`. Under O1 the one remaining meaning is "the run's
  records are gone" (`agent/runtime/resumeRun.ts:181-186`), which `run.removed` already
  says. Candidate for deletion with slice 3; not counted as new.
- **`run.result` subagent arm carries a `RunEndOutput`** (`shared/schemas/runRecords.ts:131-134`),
  the same shape as `run.end.output`, for a child whose `run.end.output` is
  then empty (`agent/storage/runLifecycle.ts:162`). O5 decides where a child's result
  lives; whichever row survives, the other arm goes.
- **`RunHistoryDraft` vs `RunInputDraft` vs `UnfoldedDraft`** (`shared/session/runState.ts:53-74`,
  `:171-174`, `shared/session/sessionEvents.ts:105-108`): three `Exclude`-typed subsets of
  one draft union that fence "who may append which kind", with `runStateAppend`
  as a cast-only widening (`shared/session/runHistory.ts:153-157`, "the narrowing is the
  type fence"). Three names for one rule ("rows the state reads go through
  the cell"); `isRunStateRow` (`shared/session/runState.ts:471-474`) is the runtime form.
  One `Draft` type and one `RunStateRowType` set would do.

---

## Q1 in one place: which rows restate another row or the loop

| Row                                   | Restates                                                                  | Verdict                                                    |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `run.position` at `halted`            | `run.end.outcome`; written in the same transaction                        | delete (Finding 3)                                         |
| `child.park` parked/resumed           | `child.turn` settled/accepted; same transactions                          | delete, use `run.position waiting` (Finding 4)             |
| `child.park` paused + `resumeId`      | a cancelled end of a resumable run                                        | delete (Finding 4)                                         |
| `child.park` heldFor/ends             | the delivery mechanism                                                    | O5 (table A)                                               |
| `run.start.approvalPolicy`            | `approval.policy`                                                         | delete the field (Finding 5)                               |
| `run.activate`                        | nothing; it is the lifecycle boundary                                     | keep; stop accumulating over it (Finding 6)                |
| `run.detach`                          | nothing                                                                   | keep                                                       |
| `followup.consumed`                   | nothing (it is the receipt)                                               | keep                                                       |
| `followup.closed`                     | `run.removed`, once claims go                                             | delete with slice 3                                        |
| `request.decided` cancel at `run.end` | the end itself ("The run ended", `agent/storage/runLifecycle.ts:193-208`) | keep: a request's closure is a fact of its own; one writer |
| `run.result` (subagent)               | `run.end.output`                                                          | O5 decides                                                 |
| `run.report`                          | the newest `followup.queued` text the child sent its parent               | O5 decides                                                 |

---

## Q6: names that are design smells

- **`park` / `parked` / `heldParks` / `RESULT_WAITING`** (30 + 4 + 4 in this
  area): the word names a mechanism (a row the child "parks on") instead of
  a fact (the child waits, is paused, holds a result). Finding 4: the
  mechanism should not exist, so the rename is a deletion.
- **`settled` / `settlement`** (44 + 11): three facts share the word: a
  call's result is committed (`CallStatus 'settled'`, `callSettlementOf`,
  `'orphan-settlement'`), a transcript row may be printed (`settledRows`,
  `settlementSeqNo`, `settle()` in `shared/session/transcriptState.ts:312`), and the
  publisher has drained (`SessionLogShape.settled`, `shared/session/sessionLog.ts:94`).
  Design smell: `log.settled` is a barrier (`Latch`/`drained`), not a
  settlement; `settledRows` is "final rows". `'settled'` as a call status
  could stay as `'finished'`.
- **`held`**: four facts: a claim is held (O1, goes), a result is held for a
  parent (`heldParks`, O5), live text is held (`agent/runtime/SessionEvents.ts:94-110`),
  a follow-up is held until a turn (`holdUntil`). After O1 and O5 two
  remain, in unrelated modules; fine.
- **`verdict`** (`RunRowVerdict`, `applyRunRow`'s result, and the claim's
  `DatabaseClaimRefused.verdict`): judge vocabulary for a `Result`
  (Finding 7).
- **`admission` / `admitted`** (`parentAdmission`, `Inbox.admission`,
  "admitted" in comments): the table says accept/start. The design smell is
  that `admission` returns `{ rows, sent }` where `sent` is a union with a
  `refused` arm and reasons (`ownedElsewhere`, `notResumable`,
  `agent/runtime/childTurnResult.ts:193-220`), i.e. a result that is sometimes an error:
  a typed failure would let `deliverIn`'s branches disappear.
- **`fold` / `arm` / `plane` / `tombstone`** (35 + 13 + 11 + 24 + 10 + 5 + 1):
  comments only, none in an identifier; a wording pass, not a design one.
  The density itself is the smell: `shared/session/runRowsShape.ts` is 46% comment because
  the 23-field record needs a sentence per field to say which read fills it
  (Finding 10).

---

## Good modules in this area

- `shared/session/inFlight.ts` `nextAttempt`/`failedNext`/`spentRetries` (already judged):
  a pure reducer over the invocation's rows, deep interface, one caller.
- `BatchCopies`/`ownCopy` (`shared/session/runRows.ts:82-104`): copy-once-per-batch for a
  rebuild over a long run, with the reason stated once; both folds use it.
- `followUpReceipt`/`turnReceipt` (`shared/session/runRowReads.ts:262-320`): the receipt of
  a message is read from the rows and never stored; the guide's rule, kept.
- `ROW_KINDS` (`shared/schemas/rowVersions.ts:110-298`): an exhaustive `Record` over the
  draft union with a version history per kind; a new arm does not compile
  without an entry. `edgesOf` and `recordFacts`'s exhaustive switches are
  the same discipline.
- `MESSAGE_HANDLERS` (`shared/session/turnRowHandlers.ts:174-271`) and `ROW_HANDLERS` with
  `requires` (`shared/session/runState.ts:317-462`): a table per row kind with its
  precondition stated as data, and `applyRow` checking it once.
- `withDerived` (`shared/session/sessionViewUpdate.ts:538-544`): identity-stable derived
  fields so hosts compare views by `===`.
- `unboundRequests` (`shared/session/runState.ts:216-237`): the one rule for what a resume
  cancels, read off the state.
- `pendingKeyOf` + the listing projection (`shared/schemas/sessionEvent.ts:503-518`,
  `controllers/session/projections.ts:112-122`): the open-request set is a projection, not a row.

## Already settled, left alone

- `SessionEvents` as the one publisher with commit order = enqueue order
  (`2026-09-20` note §3; `packages/harness/AGENTS.md` "One publisher").
- `RunState` has no schema "because giving it one invites persisting it"
  (`shared/session/runState.ts:90-94`): correct, and the reason the loop state can change
  shape freely in Finding 6.
- `run.end` written once by the storage finalizer, after the run's last
  transcript row (`shared/schemas/sessionEvent.ts:243-250`); the halt's deletion in
  Finding 3 keeps that.
- `RunView.working`, `runsHere`, `runStartedAt` nulling (O6, table B landed
  2026-11-04): Finding 1 proposes fewer fields, which is a different
  decision from O6's, not a reversal of its rule "hosts read view fields".
- The listing serves `run.position` and `child.park` (`shared/schemas/rowVersions.ts:30-39`)
  so a cold view is not painted wrong: holds; under Finding 4 only
  `run.position` needs listing.
- `stageId` on the envelope (`shared/schemas/sessionEvent.ts:103`): read by three
  transcript sites; a card fact, not a run fact.
- `applyRunRow` as the one function for the five shared row kinds
  (`shared/session/runRows.ts:1-12`): the idea stands; Finding 7 only removes its two
  overloads and the verdict union.
- The `Requirement` table (`shared/session/runState.ts:270-283`) and the opening-position
  rule (`agent/runtime/RunHistory.ts:200-215`): the fold refuses history it cannot
  continue from rather than defaulting; kept.
