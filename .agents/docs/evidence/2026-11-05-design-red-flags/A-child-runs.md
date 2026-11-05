# Area A: child runs, delegation and result delivery

Read-only audit at `main` (working tree 2026-11-05; the clone is shallow,
50 commits, so no month-long churn counts could be made for this area; the
seven commits in view that touch it are one `fix` each on `childRunLoop.ts`,
`childTurnResult.ts`, `FollowUps.ts`, `Inbox.ts`, `RunInput.ts`,
`ToolUseFollowUp.ts`, `followUpMessages.ts`). Paths are relative to
`packages/harness/src` unless they start with `packages/`. Consumer counts
are files in `packages/*/src` that mention the symbol, the defining file
included (so `2` means one consumer).

Area size: 27 files, 7,800 lines. The two files the key question lives in,
`agent/runtime/childRunLoop.ts` (849) and `agent/runtime/childTurnResult.ts`
(362), carry 20% and 19% comment lines; `RunCall.ts` 36%, `RunInput.ts` 32%,
`inBandSubagentRun.ts` 29%, `ToolUseFollowUp.ts` 29%, `deliveryEnvelope.ts`
40%, `childRunBudget.ts` 39%.

## The key question: how many mechanisms carry "a child finished, here is its result"

Counted as distinct code paths that put a child's result, or the fact of its
end, in front of its parent. The one-fact note's row "A child's result
reached its parent" names the held-park and leftover family (`heldFor`,
`RESULT_WAITING`, `deliverHeld`, `deliverOne`, `clearHeld`, `onHeldResult`,
`sendStopNotice`, `pauseNotice`, `reportInterrupted`, `closeLeftoverRun`,
`closeLeftoverChildren`, `sweepLeftoverRuns`); this list is the complete
inventory, with the row shapes and wake sites each one owns.

| #   | Mechanism                                                                          | Writes                                                                                                                     | Wakes the parent by                                                                                               | Where                                                                                                                |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Awaited native child, in band                                                      | child's own `run.end` + `run.result`; nothing on the parent                                                                | the tool call's fiber joins the loop fiber (`Fiber.join`), reads `lastTurn()` from memory, then re-reads the rows | `delegation/inBandSubagentRun.ts:162-207`, `delegation/AgentTool.ts:249-292` (`childResult`)                         |
| 2   | Awaited native child, recovered on a resumed call                                  | none                                                                                                                       | `standingOf` re-derives the answer from `run.end`, `run.result`, `child.turn`                                     | `delegation/agentChild.ts:113-164`                                                                                   |
| 3   | Background native child, each non-last turn                                        | `run.report`, `run.result`, `child.turn settled`, `followup.consumed`, parent's `followup.queued`, all in the turn's batch | `wakeParent` after the batch commits                                                                              | `childRunLoop.ts:521-536` (`finishTurn`), `loop/toolUse.ts:471-506`                                                  |
| 4   | Background native child, last turn                                                 | same rows inside the child's `run.end` transaction (`handedOff`)                                                           | a second wake site: the registry's settle callback `onExit → wakeParent(loop.end.result.delivery)`                | `childRunLoop.ts:538-546`, `:835-839`; `storage/runLifecycle.ts:214-280` (`endIn`)                                   |
| 5   | Process child (bash, agent CLI), interim turn                                      | same result rows + `child.park parked`, one transaction of its own (`commitPart`)                                          | `wakeParent` in the loop                                                                                          | `childRunLoop.ts:557-570` (`finishInterimTurn`)                                                                      |
| 6   | Process child, last turn                                                           | `endActivation({ lastTurn })`                                                                                              | the settle callback (as 4)                                                                                        | `childRunLoop.ts:687-739` (`writeEnd`)                                                                               |
| 7   | Held park: parent open in another process                                          | `child.park parked heldFor ends`, the child's end withheld, its claim released (`tx.release`)                              | the parent's tail (`onHeldResult`) or its next resume (`deliverHeld`); `clearHeld` repaints the child             | `childTurnResult.ts:250-266`, `runLaunchGuard.ts:119-275`, `resumeRun.ts:203`, `storage/runLifecycle.ts:240,273`     |
| 8   | Pause notice: a stopped agent-CLI child the parent's model can continue            | `run.report` + `child.park paused resumeId` + parent's `followup.queued` held until an instruction                         | wakes nobody by design                                                                                            | `delegation/childRun.ts:63-133`                                                                                      |
| 9   | Stop notice: a user-stopped background script                                      | parent's `followup.queued` held until an instruction, id `${runId}:${attemptId}:stopped`                                   | wakes nobody                                                                                                      | `childRunLoop.ts:651-678`                                                                                            |
| 10  | Interrupted report: a child a dead process or a clean close left cut short         | `childTurnResult(...end:'failed')` through `finalizeRun`, or `sendToParent`; id `${child.id}:interrupted`                  | the parent's resume runs it (`closeLeftoverChildren`), or session open (`sweepLeftoverRuns`)                      | `runLaunchGuard.ts:289-392`, `loop/toolUse.ts:407`, `controllers/session/sweepLeftoverRuns.ts`                       |
| 11  | `executions wait`: the parent's own call turns a background delivery into a result | the parent's `tool.result` with `consumedFollowUps` = every queued id with prefix `${childRunId}:`                         | none; the call returns                                                                                            | `tools/ExecutionsTool.ts:203-218`, `tools/executions/waitCoordination.ts:423-444`, `loop/toolUseDispatch.ts:630-631` |
| 12  | `run.end` `note`: "a last turn whose delivery failed"                              | `run.end.error.message` suffix                                                                                             | —                                                                                                                 | `childTurnResult.ts:121`, `storage/runLifecycle.ts:245`, `shared/session/runFacts.ts:340`: the field has no producer |

Twelve paths, over two row vocabularies (`followup.queued` and `child.park`
/ `child.turn` / `run.report` / `run.result`), four wake sites
(`toolUse.ts:506`, `childRunLoop.ts:568`, `childRunLoop.ts:837`,
`ToolUseFollowUp.ts:166` via `onHeldResult` and `closeLeftoverRun`), and a
delivery-id grammar (`${runId}:${key}:${index}:delivery`,
`${runId}:${prompt}:delivery`, `${runId}:script:delivery`,
`${runId}:${attemptId}:stopped`, `${runId}:interrupted`) that a fourth
module parses by prefix (`ExecutionsTool.ts:213`).

Under O5 as decided, the survivors are two: **(1)** an awaited child's result
is the `tool.result` its call records, and **(3′)** a background child's end
is one `followup.queued` on its parent, committed in the child's `run.end`
transaction, with one wake after that commit. Everything else in the table
is either a duplicate of one of those two for a special case (4, 5, 6 are 3
with a different trigger; 8, 9, 10 are 3′ with a different text; 11 is 1
re-derived from 3; 2 is 1 re-derived from rows) or a consequence of a fact
O1 deletes (7). Finding 1 gives the design.

## Findings

### 1. A child has no "finished": a background child delivers every turn and never ends

**Red flags**: special and general code mixed; temporal decomposition; a
fact with no representation (so a second mechanism, `executions wait`,
derives it).

**Evidence.** A detached `agent` child is prepared without `stopAfterCycle`
(`delegation/subagentRun.ts:320-322`), so its loop parks after each turn and
blocks on its inbox forever (`loop/toolUse.ts:408-446`: `parked` →
`followUps.input.next('idle')`), delivering each turn to the parent
(`:471-472`, `finishTurn`) and waking it (`:506`). Its `run.end` arrives only
from a stop or the session's close (`FollowUps.ts:294-300` ends a child's
reader as terminal). `shouldSkipWait` then has to say that "a subagent in
WAITING = job delivered" (`tools/executions/waitCoordination.ts:437-443`),
and the `agent` tool's receipt tells the model to `wait` on the child
(`subagentRun.ts:364`). The loop body carries four `isChild()` branches for
this (`toolUse.ts:417-436`). An awaited child is the same program with
`stopAfterCycle: true` (`inBandSubagentRun.ts:153, 240`), `awaited: true` on
the loop (`:133`), no budget slot (`childRunLoop.ts:795`), no delivery
(`:420`), no stop notice (`:657`), and `finishLastTurn` guarded by
`!loop.awaited` (`:539`). `awaited` is read in six places of `childRunLoop.ts`
(`:214, :268-270, :420, :539, :591, :657, :795`) and computed in
`AgentTool.ts:383-385` from `stopAfterCycle` and `background`, the same fact
the registry reads again as `LiveRun.readsMessages` from `controls.oneShot`
(`runRegistry.ts:179-183`).

**The design decision behind it.** "A background child is a long-lived pane
the parent types into" (session-messaging note, 2026-09-25, "Subagent
reporting on the same row"), so its result is a stream of turn results and
there is no completion to deliver. O5 asks for a completion. The code has
none, so it substitutes "turn settled" and stays alive.

**The better design.** One child program, no mode: every child runs
`executeAgent` with `stopAfterCycle: true` and ends with its `run.end`. The
difference between awaited and background is only _who runs the fiber_:

- awaited: the tool call's fiber forks it as a child fiber (`Effect.forkChild`,
  as `awaitInBand` already does, `inBandSubagentRun.ts:286`), joins it, and
  records the child's `run.end` as its `tool.result`. No loop object, no
  `lastTurn()` memory, no `awaited` flag.
- background: `RunRegistry.start` forks it on the session's fork; its
  `run.end` transaction appends the one `followup.queued` on the parent
  (through `endIn`'s existing `last` part); `wakeIfOwed(parent)` runs once,
  after that commit, from the one place that already runs after a run's end
  (`AgentRunLifecycle.endRun`'s caller), never from the loop's turn boundary.

A follow-up to a finished background child is a resume with a message, which
`submitFollowUp` already does for a run with no loop here
(`ToolUseFollowUp.ts:324-365`, `wakeIfOwed` → `wakeRun`), and the resumed
run ends again with another delivery. The "deliver each turn" capability
becomes "resume delivers at end".

**Deleted**: `ChildRunTurns`, `ChildRunBoundary` (3 and 2 files),
`turnPermit`/`finishTurn`/`finishLastTurn` and their pass-through in
`nativeSubagentStrategy.ts:228-240`, `ExecuteAgentOptions.turns`
(`executeAgent.ts:63`), `endRun`'s `finish` parameter and `FinishLastTurn`
(`AgentRunLifecycle.ts:182, 212-224`), the `childTurn`/`alongside`/`wakeParent`
lines of `loop/toolUse.ts:471-506`, the four `isChild()` branches
(`:417-436`), `ChildRunLoopParams.awaited`, `StartedChildRunLoop.lastTurn`,
`LastTurn`, `ChildEnd.handedOff`, `recordLastTurn`'s `handedOff` argument,
`driveNative` (`childRunLoop.ts:577-604`), `shouldSkipWait`'s WAITING case,
`suppressAutoDeliveredSubagentReport` (`ExecutionsTool.ts:201, 215, 398,
433-437`), the `wait` action's prefix scan of `consumedFollowUps`
(`:207-217`). `childTurnResult.ts` shrinks to the formatter of one
`followup.queued` draft.

**What we give up**: a background conversation child that takes a second
message without being resumed (its fiber and budget slot were held idle for
that); the per-turn progress a parent heard from a multi-turn background
child. Risk: hosts that list a background child as WAITING ("job done") will
list it as COMPLETED; that is the truer status.

**Change amplification** for "a background child's completion is one
message" (O5 itself): today 22 files hold a piece of delivery (the table's
"Where" column plus `sessionEvent.ts`, `run.ts`, `runRowReads.ts`,
`sessionViewUpdate.ts`, `runStatusDisplay.ts`, `packages/texra/src/ui/copy/runStatus.ts`,
`subagentRun.ts`, `detachedChildRun.ts`). After: `AgentRunLifecycle.ts`
(append the delivery in `endIn`'s part, wake after) and `AgentTool.ts`
(fork or register), two.

### 2. `child.turn` and `child.park` are a second position vocabulary for runs without a run history

**Red flags**: two representations of one fact; information leakage (the
phase vocabulary known to the fold, the view, the loop and the agent tool);
a key minted as a mechanism (`attemptId = randomUUID()`).

**Evidence.** The question "where is this child in its loop" has these
representations:

| Representation                                                    | Owner                                                                 | Readers                                                                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.position` `turn.begin/turn.end/waiting/halted` (native runs) | the loop (`loop/rows.ts`)                                             | fold, view, fork, `nextAttempt`                                                                                                                                        |
| `child.turn accepted/settled` with `attemptId`, `turnIndex`       | `childRunLoop.ts:392-409` (`beginTurn`), `childTurnResult.ts:167-173` | `runRowReads.ts:102-110` → `childTurn.active/lastCompleted` → `agentChild.ts:118-129`, `runLaunchGuard.ts:325-327` (`cutShort`), `:317`                                |
| `child.park parked/resumed/paused` (process children)             | `childRunLoop.ts:379-384`, `:565`, `childRun.ts:109-113`              | `sessionViewUpdate.ts:764-766` maps it into the same `movePhase` as `run.position` (`:820-830`); `runRowReads.ts:118-123`; `resumedChildRunId` (`childRun.ts:142-162`) |
| `child.park` `heldFor`/`ends` (delivery state)                    | `childTurnResult.ts:255-262`                                          | `runLaunchGuard.ts:153-189`, `run.ts:79-91` (`parkSubstate` → `RUN_SUBSTATE.RESULT_WAITING`)                                                                           |
| `ChildLoop.turnIndex`, `turnStart`, `consumed`, `end` (memory)    | `childRunLoop.ts:258-307`                                             | the same file                                                                                                                                                          |
| `RunRows.childTurn` + `RunRows.park` + `RunRows.heldParks`        | `runRowsShape.ts:83-110`                                              | as above                                                                                                                                                               |

For a native child, `child.turn` restates `run.position`: the loop writes
`turn.end` and `waiting` in the same batch as `child.turn settled`
(`toolUse.ts:473-478` with `childTurn.rows`). `standingOf` reads
`turns.active !== null` to mean "cut short" (`agentChild.ts:118-129`); the
same fact is `state.phase` of the run history, which the resume already loads
(`toolUse.ts:399-402`). For a process child, `child.park parked/resumed` _is_
its `waiting`/`turn.ready` (`phaseMoveOf`, `sessionViewUpdate.ts:764`), and
`child.turn accepted` its `turn.begin`. The `attemptId` is a fresh UUID per
`ChildLoop` instance (`childRunLoop.ts:259`) although the activation already
has an identity, the `run.activate` commit, that every other reader uses
(`RunAttempt.admitted`, `resumeRun.ts:70-76`). `turnIndex` is "how many
turns this activation ran", a count the rows already give.

**Is a child's turn a fact or a mechanism?** For a native child it is a
mechanism: the turn is the loop's turn, already recorded; `child.turn` only
exists because `finishTurn`'s delivery needed a key for the delivery id
(`childTurnResult.ts:147-151`) and an "active turn" test for recovery. For a
process child, "a batch of follow-ups became one provider turn" is a fact,
but it is the same fact `FollowUps.consume` records for a native run as
`followup.consumed { kind: 'turn', turn }` plus `run.position turn.ready`
(`FollowUps.ts:258-285`); the child loop records it as `{ kind: 'answered' }`
at the turn's _end_ (`childTurnResult.ts:164-166`) and as `child.park resumed`
at its start (`childRunLoop.ts:400`). Two dispositions and two position rows
for one fact.

**The better design.** A process child is a run: it records `run.position`
rows like any other run (`turn.begin` when its provider call starts,
`turn.end` + `waiting` when it returns) through the same `positionRow`
builder, and consumes its batch with `{ kind: 'turn', turn }` at the start.
Then: `child.turn` is deleted (row kind, `rowVersions.ts:297`, the
`childTurn` fold in `runRowReads.ts:102-110`, `RunRows.childTurn`,
`readChildTurnState`, `AttemptKey`); `child.park parked/resumed` is deleted;
`cutShort` becomes "position is `turn.begin` with no later `turn.end`" read
from the rows every run has; `standingOf` reads the run's phase. What is left
of `child.park` is `paused { resumeId }`, which is finding 3. The delivery
id loses its turn key (finding 1 leaves one delivery per run end, so the id
is `${runId}:${activationCommit}`), and the `attemptId` UUID goes.

**What we give up**: nothing a reader has; `RUN_ROW_READS.turns` and
`.parks` collapse into `.positions`. Risk: a `rowVersions` bump for the
`child.park` kind and the fold's `movePhase` losing its second caller; the
`ChildRunLoop.vitest.ts` (448 lines) and the crash conformance support pin the
old rows.

**Change amplification** for "a run gets a third position kind" (say, a
provider-side pause): today `run.position` (`rows.ts`), `child.park`
(`childRunLoop.ts`, `childRun.ts`), `phaseMoveOf`, `parkSubstate`,
`RUN_SUBSTATE`, `runStatusDisplay`, the UI copy: 7 files. After: `rows.ts`
and `phaseMoveOf`.

### 3. The pause is one plugin's fact stored as a harness row, and the loop carries a five-method interface for it

**Red flags**: information leakage; overexposure (an interface with one
implementer); a callback parameter with one shape.

**Evidence.** `ProcessChildStrategy.cli` has five members (`runTurn`,
`pauseNotice`, `onTurnSuccess`, `releaseSessionOwnership`, plus the
`interruptedTurn` alternative; `childRunLoop.ts:156-191`). Its only
implementer is `buildAgentCliLaunch` in the app
(`packages/texra/src/tools/agentCli/agentCliShared.ts:471-490`); bash takes
the other branch. `pauseNotice`'s text and `resumeId` are the Codex thread
or Claude session id (`agentCliShared.ts:478-484`, `codex.ts:424`,
`claudeAgent.ts:505`), which the harness stores on `child.park paused
resumeId` (`childRun.ts:109-113`, `sessionEvent.ts:262`) and reads back by
walking every paused child of the parent (`resumedChildRunId`,
`childRun.ts:152-160`, a view scan plus a `facts` read per child).
`releaseSessionOwnership`/`releaseOwnership` is called from four places of
the loop (`childRunLoop.ts:293-297, :421, :772, :834`) to release a registry
the plugin owns (`agentCliShared.ts:415`, `holdWhileLive`). `onTurnSuccess`
registers the same ids after the turn commits (`:567`). `ChildRunPause` and
`ChildRunPort` exist for this one family.

**The design decision behind it.** The harness drives the agent-CLI's
session lifetime (hold, release, pause, reactivate) because the plugin's
registry is in-process memory and the harness wanted the pause durable.

**The better design.** The thread id is the plugin's fact: a `plugin.fact`
row the agent-CLI plugin writes with its turn (the plugin fact mechanism
already exists, `factRows`, `toolUseDispatch.ts:632`) and reads when a call
names a `thread_id`: "the run whose fact holds this id" is one indexed read,
not a scan of paused children. A stopped agent-CLI child is then simply a
cancelled run (`run.end cancelled`, O2's reason) whose fact still holds the
id; the plugin's tool, called again with that id, resumes that run under its
own id (what `resumeSubagentInBand` does for an `agent` child). The pause
notice becomes the plugin's own text in the delivery it formats for a
cancelled turn (`formatError` already takes the turn). `child.park` is
deleted whole (with finding 2); `ProcessChildStrategy.cli` collapses to
`runTurn`; `pauseChildRun`, `resumedChildRunId`, `ChildRunPause`,
`ChildRunPort`, `releaseOwnership`, `ownershipReleased` and the registry
hold go. The plugin's in-memory registry (`holdWhileLive`, `releaseByRunId`)
becomes a projection of its own fact rows or disappears.

**What we give up**: a paused child listed as PAUSED instead of CANCELLED
(`packages/cli/src/runtime/history.ts:251` is the one reader). Risk: a
format change to the agent-CLI plugin's row, which 1.0 allows.

### 4. "Does this run take a message now" has eight representations

**Red flags**: two (eight) representations of one fact; state machine in
flags and maps.

**Evidence.** `submitFollowUp` (`ToolUseFollowUp.ts:310-366`) and
`SessionInbox.admission` (`Inbox.ts:269-334`) decide the one question
"may this message land, and will anyone read it" from:

1. `LiveRun.readsMessages`, memory, from `controls.oneShot` or the view's
   `followUpSupport` (`runRegistry.ts:179-183`);
2. `USER_FOLLOW_UP_SUPPORT` stamped on `run.start` (`run.ts:22-26`), set
   at five launch sites (`executeAgent.ts:101`, `forkRun.ts:240`,
   `detachedChildRun.ts:186`, `bash.ts:475`, `traceAssembler.ts:101`), read
   by the composer (`SessionComposer.ts:511, 531`) and `sessionView.ts:273`;
3. `RunRows.inputClosed` from `followup.closed`/`run.removed`/`run.activate`
   (`runRowsShape.ts:80-82`);
4. `SessionInbox.readers` ("a reader here", `Inbox.ts:102, 275, 282`);
5. `RunInput.ended` (`RunInput.ts:97, 143-146`);
6. `SessionInbox.disposed` (`Inbox.ts:106`);
7. `runRejection(runId)` (records usable) at `ToolUseFollowUp.ts:329`;
8. `run.toolPolicy.stopAfterCycle` as `oneShot` in `AgentTool.ts:383`, the
   same fact as 1's `controls.oneShot`.

Plus the answer has three shapes: `Sent` (`duplicate | queued{read} |
refused{reason}`, `Inbox.ts:74-79`), `SubmitFollowUpResult`
(`sent | queued{wake?} | failed{reason}`, `ToolUseFollowUp.ts:75-78`) and
`FollowUpFailureReason`'s ten wordings (`:95-113`), with `wake: 'failed'`
and `presentFollowUpResult` mapping between them. The wake decision is
taken twice on the same rows: `wakesOnly` inside admission
(`Inbox.ts:308-309`, pre-commit) and `owesResume` after the publisher
settles (`:173-189`), both over `needsWake` (`RunInput.ts:58-71`).

**The design decision behind it.** Whether a run reads input was decided
per launch (support kind), per loop (oneShot), per process (reader map) and
per row (closed), and each decision got an owner.

**The better design.** One fact, on the rows, read in the sending job: a
run takes a message iff its rows are not closed and it has not ended with a
user's stop before this message (`needsWake` already states the second
half). "A reader here" is not a separate fact: with one process per store
(O1) a live loop is the registry's activation, and the send does not need
to know it; the loop's `RunInput` is notified by the committed row's tail
(the inbox already does this, `Inbox.ts:285`). `readsMessages`,
`USER_FOLLOW_UP_SUPPORT` (the composer reads "has a loop that reads input"
from the run's phase and identity it already shows), `wakesOnly`,
`Sent.queued.read`, `SubmitFollowUpResult.wake`, `RunInput.ended` and
`SessionInbox.disposed` go; a one-shot run's refusal is "it ended" once it
ends and "queued for its end" before, no `oneShot` reason. The answer is
`sent | refused(reason)` and the wake is one call after the commit.

**What we give up**: the `oneShot` early refusal (the model learns at the
end); the `readFailed` distinction (a read failure fails the send).

**Change amplification** for "add a kind of input a run takes" (a plugin's
control): today 8 representations, 3 result shapes, 10 wordings; after: one
`needsWake` branch.

### 5. `childRunLoop.ts` is a shallow module with two families and a class of mutable loop state

**Red flags**: special and general code mixed; temporal decomposition
(`beginTurn`/`attemptTurn`/`noteFailure`/`buildTurnResult`/`recordLastTurn`/
`endTurns`/`finishInterimTurn`/`writeEnd`/`endChildLoop`, nine steps of one
turn); state machine in a class (`ChildLoop` with `stage`, `budget`,
`ownershipReleased`, `turnIndex`, `turnStart`, `consumed`, `failure`,
`end: ChildEnd`); reinvented Effect primitives (`Effect.uninterruptible` at
`:350, :752`, `Effect.onExit` at `:813, :835`, the `settle` callback with
`Effect.yieldNow` at `:833`, an `Exit` rebuilt by hand at `:757-761`).

**Evidence.** The file drives two unrelated programs through one
`ChildLoop`: a native run, whose loop is `executeAgent`'s and which reaches
back into this file through `ChildRunTurns` (`:512-548`), and a process
turn loop that this file owns (`driveProcess`, `:610-645`). `ChildEnd` is a
three-case union with a boolean (`handedOff`) and `loop.failure` a separate
"why" beside it (`:242-250, :272-273`); `endChildLoop` then rebuilds an
`Exit` from `body` and `failure` (`:757-761`) and aggregates two exits
(`:776-782`). The settle callback passed to `RunRegistry.start`
(`:829-842`) is a five-line protocol: yield a tick, release ownership on
exit, wake the parent on exit if `loop.end` is finished, which a comment
explains (`:826-828`). `attemptTurn` records a process child's interrupted
turn under `Effect.uninterruptible` inside an interrupted fiber (`:346-356`)
so that `writeEnd` later finds `loop.end !== 'open'`.

**The design decision behind it.** One driver for native and process
children, so the native child's loop had to export its turn boundaries
(`ChildRunTurns`) and the process child's turns had to be a loop here.

**The better design.** Findings 1 and 2 remove the native family from this
file (a native child is `executeAgent` with one delivery at its end). What
remains is the process child, and it is a run too: `executeAgent` over a
`RunProgram` whose "turn" is `strategy.launch()` / `runTurn(batch)` instead
of a model call, so `runToolUse` (`loop/toolUse.ts`) runs it with its own
`claimFollowUps`, `run.position` rows, `endRun` and the one delivery. The
`ProcessChildStrategy` shrinks to `{ launch, runTurn?, formatDelivery,
formatError, buildResultMeta }`, provided to a second run program the way
`script.kind: 'recipe'` already selects one (`AGENTS.md` "One program").
`childRunLoop.ts` (849 lines), `ChildLoop`, `ChildEnd`, `Turned`,
`StartedChildRunLoop`, `startChildRunLoop`, `startDetachedChildRunLoop`'s
two branches and the `opened` Deferred race (`detachedChildRun.ts:93-100`)
are deleted; `logLateFailure` becomes the registry's one "a run nobody joins
failed" log, if it is not already (`Fiber` observers).

**What we give up**: the `budget` acquisition per turn for a background
native child (finding 6 keeps the budget, acquired per run).

### 6. The concurrency budget is acquired through a row-writing permit, and a script's budget is a second semaphore

**Red flags**: conjoined methods (`turnPermit` both takes a permit and
writes `child.turn accepted`, `childRunLoop.ts:517-520`); two owners of one
number (`RunRegistry.childRunBudget`, `runRegistry.ts:429-438`, resized on
every launch, and `scriptChildBudget`, `childRunBudget.ts:390-399`, one
`Semaphore` per script under `ScriptScope.shared`); a `Context.Reference`
not used where the rule asks for one (`AGENTS.md` "Effect").

**Evidence.** `AgentTool.launchChildAgent` takes a script permit for the
whole call (`AgentTool.ts:301-304`); the in-band child under it takes no
session permit (`childRunLoop.ts:795`); a background child takes a session
permit per turn inside `turnPermit`. The budget note (2026-08-15, "Single
acquisition boundary") rules one boundary, the child-run loop; the per-script
semaphore is the "known soft spot" the note itself names.

**The better design.** `ChildRunBudget` is a `Context.Reference<Semaphore>`
whose default is unlimited (a root run); the session provides its one
semaphore to every background child's `executeAgent`, which takes one
permit for the run (`Semaphore.withPermit` around the loop). A script's
awaited calls run under the same reference (they are awaited, so they ride
their parent's slot, as the note says) and need no second semaphore.
Deleted: `turnPermit`, `scriptChildBudget`, `AgentBudget`,
`RunRegistry.childRunBudget` and `this.budget`, `loop.budget`. Kept:
`resolveChildRunConcurrencyBudget` (one reader, the session layer).

**What we give up**: a script that launches more than the budget in parallel
gets ordered by the session's semaphore instead of its own (the same
ordering).

### 7. The delivery envelope's shape is known to four modules, and its identity grammar to a fifth

**Red flags**: information leakage; a validated-by-regex contract
(`formatDelivery` throws when `deliveryTagOf(xml) !== delivery.tag`,
`deliveryEnvelope.ts:225-228`).

**Evidence.** `formatDelivery` is called from 15 files (`formatDelivery`
count above): the harness's four formatters (`subagentResults.ts`,
`bashDelivery.ts`, `scriptRun.ts`, `childRun.ts`), `runLaunchGuard.ts`'s
`TAG_OF` table keyed by identity kind (`:279-283`), and three app files.
`queuedRow` summarises the XML again for `displayText`
(`followUpMessages.ts:87-89`, `summarizeSubagentFollowup`) and
`followUpDisplay` re-parses a script's summary from the text
(`:52-55`, `parseScriptDeliverySummary`). The delivery id grammar is built in
three places (`childTurnResult.ts:147-151`, `scriptRun.ts:293`,
`childRunLoop.ts:674`, `runLaunchGuard.ts:313`) and parsed by prefix in
`ExecutionsTool.ts:213`.

**The better design.** With one delivery per run end (finding 1), the id is
the child's run id plus its activation commit, assigned in one place
(`AgentRunLifecycle`), and nothing parses it: a tool result that answers a
delivery names the `followUpId`s it consumed from the rows it read (the
`consumedFollowUps` field stays; the prefix scan goes). The envelope's
typed facts (`ScriptDeliverySummary`, `ResultMeta`) travel on the row
(`run.result` already does) and the XML is rendered once at the point the
row becomes a model message (`FollowUps.batchMessage`), not stored twice
(`run.report` text and `followup.queued` text are the same string today,
`childTurnResult.ts:154, :181`). `summarizeSubagentFollowup` and
`parseScriptDeliverySummary` then read the typed row.

**What we give up**: a plugin's free-form `<family>-result` tag; it names its
family on the row instead.

### 8. `openResume` / `wakeRun` / `RunAttempt` reimplement a `Deferred` join with counters

**Red flags**: reinvented Effect primitives (`waiters` count, `handedOff`
boolean, `activation?: object` link, `fiber.addObserver`,
`Deferred.doneUnsafe`, `Deferred.isDoneUnsafe`, `Effect.uninterruptible`
over the whole open, `ToolUseFollowUp.ts:142-240`); comments substituting
for design (`:157-165`, `:189-195`, `:242-247`, `:276-281`).

**Evidence.** The one-fact note's "A resume is in flight here" row deletes
`waiters`, `handedOff`, the activation link and `attemptOf` (6 files). The
new angle: the wake path _also_ presents. `answered` (`:248-295`) decides,
from `handedOff`, `waiters` and `Deferred.isDoneUnsafe(attempt.admitted)`,
whether to show `requestShowInstruction` or `presentRunFailure`, and
`wakeRun` re-enters `wakeRun(result.ownedBy)` for an owned child's parent
(`:262`). The decision "who tells the user this resume failed" is spread
over the wake, the resume and `presentTerminalResult`.

**The better design.** The note's `Deferred<activation | refusal>` per run in
the registry. The presentation rule then has one owner: a resume a person
clicked is told its refusal at the click (A7 already landed this for
blocked runs); a wake that is refused is logged, since nobody is looking,
and the queued row stays for the next explicit resume. `answered`,
`wakeRun`'s `handedOff = true`, and `FOLLOW_UP_WAKE_FAILED_MESSAGE`'s two
emitters (`:131, :270`) go.

### 9. Two detached-launch shapes, one of them a duplicate the plugin door does not use

**Red flags**: repetition; a factory with a one-shape callback
(`createChildRun: () => restore(Effect.void).pipe(Effect.as(createChildRun(log, runId)))`
appears verbatim at `bash.ts:492-493` and `detachedChildRun.ts:197-198`).

**Evidence.** `launchProcessChild` (`detachedChildRun.ts:173-204`) is the
plugin door's launch (`ToolServices.ts:183`, its only consumer). `bash.ts`
`launchBackgroundBash` (`:455-510`) is the same twelve lines (`registerRun`
with `childRunDescription`, `uninterruptibleMask`, `startDetachedChildRunLoop`
with `createChildRun` and `buildLaunch`) with `identity.kind: 'process'` and
`USER_FOLLOW_UP_SUPPORT.UNSUPPORTED`. `DetachedChildRunInput` is a union of
two shapes (`:46-70`) whose branches are taken by different callers only.

**The better design.** `bash.ts` calls `launchProcessChild` with its identity
and support kind as data; `startDetachedChildRunLoop`'s native branch goes
with finding 1; the file is the one process-child launch. With finding 5 it
is `executeAgent` with a process program and no choreography at all.

### 10. The `TransactionPart` carries two fields with one producer and one with none

**Red flags**: dead field; a mode flag through a storage function.

**Evidence.** `TransactionPart = Effect<{ rows, held?, note? }>`
(`childTurnResult.ts:117-125`). `note` is read at
`storage/runLifecycle.ts:245` and documented at `runFacts.ts:333-340` ("the
note of a last turn whose delivery failed") but no producer sets it
(grep `note:` across `agent/`: only `toolUseDispatch.ts` sets a different
`note`). `held` is set once (`childTurnResult.ts:264`) and branches
`endIn` (`:240, :273`, withholding the `run.end` and releasing the claim)
and `pauseChildRun` (`childRun.ts:93`); it is finding 7 of the table and
goes with O1. After both, `endIn`'s `last` is `readonly RunInputDraft[]`,
not an Effect over `Scope | PartServices`.

### 11. Recovery of an awaited call reads the answer three times

**Red flags**: two representations of one fact; a special case in the
general path.

**Evidence.** `executeInBand` reads `lastTurn()` from memory, then
`readRunEnd()`, then `readResultMeta()` and compares `producer === 'subagent'`
twice (`inBandSubagentRun.ts:165-202`). `standingOf` does the same read from
rows on a resumed call (`agentChild.ts:113-164`), with a synthesized
`FAILED` end for a completed run with no manifest (`:142-154`), and
`executeInBand` synthesizes the same message (`:197-202`). `childResult`
then reads `readConfig()` and the view again (`AgentTool.ts:269-270`).

**The better design.** The child's `run.end` carries its result
(`output.structured`, `output.response`, `files`) and `run.result` is the
same fact under another kind (`ResultMeta.output` duplicates
`RunEnd.output`, `nativeSubagentStrategy.ts:323-326`). One row, one reader:
the call's answer is `readRunEnd()` and nothing else; "completed with no
result" cannot be written, so it is not read. Deleted: `run.result` as a kind
(`rowVersions`), `buildResultMeta`, `ResultMeta`, `readResultMeta`,
`LastTurn`, the two synthesized failures.

**What we give up**: `producer: 'backgroundBash' | 'subagent'` on the
manifest; the end row's `output` says what it is.

## Good modules in this area

- `agent/followUp/RunInput.ts`: one `Latch`, rows as the authority, a pure
  `readableMessages` and `needsWake` over `RunRows`. A deep module; the
  `holdUntil: 'instruction'` case has only the notices of findings 1 and 3
  as producers (`childRunLoop.ts:676`, `childRun.ts:101`) and goes with them,
  leaving `'turn'`.
- `agent/followUp/followUpMessages.ts` `sentBefore`/`sentReceipt`: a
  receipt read from rows with `Schema.toEquivalence`, as the guide
  describes.
- `agent/runtime/RunCall.ts`: a `Context.Reference` with a null default,
  `requireRun`/`requireToolRun` the one wording of the refusal (10 and 9
  consumers). Its 36% comment share is API documentation, not protocol.
- `agent/runtime/forkRun.ts`: `cutOf` reads a settled position from rows
  and writes the fork whole in one cell append; `forkSeed` reuses it for a
  script's `self()`.
- `agent/runtime/deliveryEnvelope.ts` `formatDelivery` as a renderer (its
  tag validation is finding 7's leak, the renderer itself is fine).
- `agent/runtime/scriptRun.ts` `scriptRunCalls`/`deliveredFiles`: a fold of
  the run's own rows into its summary.
- `delegation/agentChild.ts` `agentChildRunId` and `earlierChild`: the
  child's id derived from the call and its attempt, so a resumed call finds
  its child from rows alone. Keep this; it is what makes finding 1's
  "awaited = fork, join, read `run.end`" crash-safe.

## Already settled, left alone

- The one `followup.queued` row for every run-to-run message, relation
  stamped at admission, and the wait reading committed rows: session
  messaging note 2026-09-25, "The row", "Waiting", owner decisions 3, 4, 7.
  Finding 1 keeps the row and the wait; it changes when a child writes it.
- `executions send` as the one verb and no per-run `PubSub`/`Mailbox`:
  the same note, "Considered and rejected".
- One child-run budget per session, acquired at one boundary, in-band
  children exempt: 2026-08-15 note. Finding 6 moves the boundary from a
  turn to a run and keeps the rule.
- The `SessionEvents` publisher and per-key lanes
  (`withPerKeyLane(inbox.sendLanes, runId)`, `ToolUseFollowUp.ts:355`):
  2026-09-20 note §3.
- `AppendedMessage`/`addressedMessages` in `storedTurn.ts`: the media
  address boundary; not a delivery concern, left alone.
- The claim protocol inside `Inbox.admission` (`port.log.hold`,
  `heldElsewhereBy`, `Inbox.ts:291, 324-332`), `sentBefore`'s
  `heldElsewhere`, `forkRun.ts:269-275`'s claim release, and
  `deliverOne`'s `log.hold(child)`: O1's slice, not re-reported.
- `reason: 'user' | 'shutdown'` reads in `needsWake` and
  `closeLeftoverRun`: O2, landed.
