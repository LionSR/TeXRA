---
created: 2026-11-05
status: proposed (owner review)
---

# Root designs: the decisions behind the red flags, and the Effect-native shape of each

Origin: the owner's verdict on 2026-11-05 that the in-flight, liveness, run and
resume machinery "are design problems, not _A Philosophy of Software Design_",
that "many similar ones are red flags", and that the fix must be
"effect native and follow effect best solution". Surveyed on `main` at
`ccf15b4` (one squashed day of history, so no churn counts) by seven read-only
audits: the run lifecycle (the lead), child runs and delivery (A), session
composition and the store (B), the row model and its folds (C), the model call
path (D), the loop and the tool engine (E), the three hosts (F). The audits,
with every claim as `path:line` and grepped consumer counts, are in
[`../../evidence/2026-11-05-design-red-flags/`](../../evidence/2026-11-05-design-red-flags/).
Effect facts below were read from `node_modules/effect` 4.1.2.

This note builds on
[one fact, one representation](./2026-11-03-one-fact-one-representation.md)
(O1–O10, accepted 2026-11-04) and does not repeat its tables. That note found
the representations; this one names the **design decisions that generate
them** and the structure under which each representation cannot exist. Its
rule 5, "decide the model before consolidating inside it", is the one the
tree keeps breaking: `ccf15b4` ("one owner each for run liveness, …") landed
on the day of this survey and consolidated owners inside `ownerLiveness.ts`,
a file O1 deletes whole.

## Summary

Ten decisions, each held in the wrong place or made several times, generate
the red flags the seven audits found (about seventy, listed by area at the
end). Six of them are the harness's own (R1–R6); two are the store's and the
session's assembly (R7–R8); two are the model path's and the hosts' (R9–R10).
For each, the Effect-native structure is one primitive the repo already
depends on, and the deletion list is a consequence, not a goal:

| #   | The decision, as it should be                                                               | The primitive                                                         | What goes                                                                                                         |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R1  | One process writes a project store (O1); the store is one connection, one `BEGIN IMMEDIATE` | the SQLite connection                                                 | claims, liveness, `afterCommit`, per-write `storeGate`, two of three tails, `data_version` poll (project)         |
| R2  | A run this process drives is one fiber; a stop is its interruption plus one row             | `FiberMap<RunId>` in the session scope                                | `Activation`, `StopCause`, `RunControls`, lanes, `awaitDrained`, `stopAll`, `markStopped`, `withInactiveRunStep`  |
| R3  | A resume is a start from rows; nobody "joins" a resume                                      | the same `FiberMap.run`                                               | `RunAttempt`, `openResume`, `decideResume`, `restsWith`, `wakeRun`, `answered`, `'released'`                      |
| R4  | A run's end is one transaction; a storage failure fails the fiber                           | `Effect.uninterruptible(log.transact(rows))`                          | the nine-function end chain, `finalizeRun`'s three fallbacks, the halted `run.position`, `lastTurn` hooks         |
| R5  | Every child is a run that ends; awaited: the call's `tool.result`; background: one message  | `Effect.forkChild` + `Fiber.join`, or `FiberMap.run` + one row        | `childRunLoop.ts`, `child.turn`, `child.park`, 10 of 12 delivery paths, `executions wait`'s prefix scan           |
| R6  | The view carries three facts; words, groups and offers are one app function                 | one pure fold                                                         | `RUN_PHASE`, `substate`, `group`, `statusKey`, nine derived fields, four row→phase tables                         |
| R7  | A question to a person is a row of the run, opened and decided through its cell             | `RunCell.append` + the cell's row stream                              | `AskOptions.open`, five `request.decided` writers, three tail waiters, `enqueue`, `approvePendingUnderBypass`     |
| R8  | A session is one scoped layer; one tail; the writer applies what it wrote                   | `Layer.scoped` + `PubSub` + `Queue.sliding`                           | `SessionStoreParts`, seven piped layers, `folded`/`settlement`, `PublisherJob`, `SessionHostInteractions`         |
| R9  | Only a turn is row-driven; the `failed` row stores llm's verdict; health is a `Latch`       | `Effect.retry`, `Latch` + `Semaphore(1)`, `ScopedRef`, `Semaphore(1)` | `InvocationDriver`, `modelCall.ts`, `ProviderErrorClassification`, 250 lines of `ModelRetryGate`, `SharedAttempt` |
| R10 | Hosts bind verbs to one action body; a client holds a `Session`, not pieces of one          | `FiberHandle`, `SessionHost.approve`, `Stream.takeWhile`              | the CLI's run claim, four approval loops, `CliRunReads`, four exit-code writers, the progress drainer             |

The rule that keeps them from growing back, added to the one-fact note's six:

7. **A fact that lives in this process lives in one Effect value.** Running is
   a `Fiber`; waiting is a `Latch` or a `Deferred`; a budget is a `Semaphore`;
   a resource with a lifetime is in a `Scope` or a `ScopedRef`; a set of
   things in flight is a `FiberMap`/`FiberSet`; ordering is a `Queue`; a
   broadcast is a `PubSub`. A hand-rolled counter, flag, observer, `*Unsafe`
   call or `uninterruptibleMask` beside one of those is the primitive written
   twice. The harness and llm hold 53 such sites today.

## R1. One process per store, and what the store is once that holds

**Decision.** O1, accepted 2026-11-04, designed as "slice 3" in the one-fact
note; not executed. Every other root shrinks by about half once it lands, so
it goes first. What the audits add is the store's interface afterwards, which
slice 3 does not describe.

**What the multi-process model still generates** (B2, B3, B4, B6, F7):

- Three readers of the same committed rows: `logTails` (`shared/session/sessionEvents.ts:353-399`),
  `SessionInputs.read` (`controllers/session/sessionInputs.ts:160-240`), and
  `SessionStore.folded` (`controllers/session/sessionStore.ts:360-365`),
  stitched by six commit coordinates (`level`, `observedCommit`,
  `currentCommit`, `delivered`, `view.cursor`, `foldedRead`), so that every
  `transact` waits for an asynchronous fold of what it just wrote
  (`sessionStore.ts:253-254`).
- A post-commit hook list, `PublisherJob`/`afterCommit`
  (`shared/session/sessionEvents.ts:49-91`, 9 files), needed only because a
  job "may run again whole" under busy retry; and `JobOptions.order`, which
  routes every streamed token through the SQLite write inbox
  (`controllers/session/runTrace.ts:133-135`).
- `storeGate`'s `SELECT` inside every write transaction
  (`controllers/session/Database.ts:436-447`, `rowCodec.ts:384-393`), guarding
  a newer build writing the file concurrently.
- `mapDatabaseFailure` (`Database.ts:1049-1060`) catching every defect, so an
  `invariant()` die inside a batch ("A run must begin with exactly one
  run.start") ends the run as a `DatabaseWriteFailed` with "Rows this run
  published were not written".
- After O1 two in-process facts remain and both travel through the fold's
  `local` escape hatch: `unreadable` (a store fact round-tripped through
  memory with dedup, `sessionInputs.ts:250-264`) and `runsHere` (the
  registry's set, reaching the fold as `self` compared against the claim
  column).

**Design.** The project store is one connection held by one process for the
connection's life (`locking_mode = EXCLUSIVE`, slice 3). Its interface:
`append(rows): Effect<SessionEvent[]>` in one `BEGIN IMMEDIATE`
(`inImmediateTransaction` in `storeAside.ts:48-63` already is the
`acquireUseRelease`), the typed reads, and one `PubSub<SessionEvent[]>` the
writer publishes to after commit. The writer applies the rows it holds to the
view updater on its own fiber before returning, so a caller that reads the
view next sees what it wrote with no read-back; `logTails` is the one tail,
fed by the PubSub, with `readDisplay(from)` for a cold catch-up. "After
commit" is `Effect.tap` at the call site. `storeGate` runs at open only;
`mapDatabaseFailure` catches `isSqlError` and lets a defect die. `unreadable`
rides the `drained`/`existence` marker the same read already returns;
`runsHere` is the registry's `SubscriptionRef<ReadonlySet<RunId>>` and the
fold's one non-durable input, so `readSessionView` is `readListing` plus the
updater with no fake local state.

**Deletes** (with slice 3's own list): `SessionStore.folded`, `foldedRead`,
`settlement`, `delivered`, `tailEnded`, `SessionStore.deliver`,
`Database.observedCommit`, `now()`, the project-store `data_version` poll,
`PublisherJob`, `afterCommit`, `committing`, `JobOptions.order`, `ordering`,
`reentered`, `SessionLogShape.afterCommit`, the per-write `storeGate` and the
`gated` parameter, `OwnersUnproven`'s special case, `LocalRuntimeState.unreadable`,
`markDamaged`, `NO_LOCAL_STATE`, `readSessionView`'s prober.

**Gives up.** Two processes driving one project (O1). Program order across
fibers for a detached trace row and the loop's next batch becomes the
caller's sequence, which is what it meant. For the global store, whose
service record is multi-process, the poll stays.

## R2. A run this process drives is one fiber; a stop is an interruption plus a row

**Decision today.** "What this process holds for a run" is an `Activation`
record, `{launch, fiber?, unbornParent, stop?, attempt?, controls?}`
(`agent/runtime/runRegistry.ts:112-135`): two fiber fields and four optionals
whose combinations are the states of a machine no type names. `start`
(`:256-345`) takes five parameters, one a `settle` callback and one an
optional `attempt` that changes which branch runs; the stop reason is an
in-memory `StopCause` with a priority rule (`markStopped`, `:572-578`) and a
sentinel `'released'` that `stoppedVerdict` and `markStopped` both branch on
although the one-fact note says nothing does; `stop()` returns
`{ accepted: () => boolean, settlement }` because a detaching stop learns
whether it hit anything only after its batch commits. The same fact is read
again as `runs.stopCause(runId)` from 15 sites, including a background turn's
cancel decision mid-interrupt (`run/backgroundTurn.ts:99-103`), and as
`LiveRun.readsMessages` from `controls.oneShot`, which is the fourth spelling
of "this run reads input" (E1). The comment share of `runRegistry.ts` is 29%:
"a deciding resume hands its activation to the next launch here (its
generation, or a parent's reattach), never to a second resume" is a protocol
in prose.

The hosts pay for it twice more: the CLI chat keeps its own run registry,
`RootRunClaim` (`packages/cli/src/chat/tui/state/sessionRunState.ts:31-41`),
fed by five `Deferred.makeUnsafe` (F1), and the headless shutdown fences
"accepted" with `Effect.uninterruptible` and a documented double read
(`packages/cli/src/runtime/executeCli.ts:261-358`) because a stop for a run id
the registry has not accepted is "the registry's quiet no-op" (F5).

**Design.** `Runs` is a `FiberMap<RunId, RunReport, Error>` made in the
session's scope (`FiberMap.make`; the repo already uses one in
`loop/toolUseDispatch.ts:768` and `effect/requestAnswerer.ts:102`) plus the
child-run `Semaphore` it already has.

- `start(runId, program)`: `FiberMap.hasUnsafe` then `RunLive`, else
  `FiberMap.run(map, runId, program)`; the map drops the entry on exit and the
  scope's close interrupts every run. No `settle`, no `attempt`, no
  `unbornParent`, no `controls`.
- `stop(runId, reason)`: append `run.stop { reason }` (one of O2's two
  values), then `FiberMap.remove(map, runId)`, children first by a loop over
  `facts.children`; a detaching stop appends the `run.detach` batch and does
  not cascade. A run with no fiber here gets `run.stop` and `run.end CANCELLED`
  in one batch. A stop for a minted id not yet started records the refusal
  and the later `start` fails at once ("stopped before it started"), which
  deletes the CLI's fence. `stop` returns `Effect<boolean>`.
- The reason cannot ride the interrupt: `Cause.Interrupt` carries only
  `fiberId` (`effect/dist/Cause.d.ts:386-388`). So it is a row, read by the
  end (R4), by `needsWake`, by the background turn's cancel, and by the stop
  notice; `run.end.reason` either goes or stays as O2's one field, never
  both.
- Drain is `FiberMap.join` / `awaitEmpty` under `Effect.timeout` for the
  close budget; `LiveRun` is the fiber; `readsMessages` and `oneShot` are the
  `run.start`/`run.activate` row field the view already shows.
- Launch is **open, then fork**: the registration or activation batch
  commits in the caller's fiber and returns its commit; then `FiberMap.run`
  the loop. The `opened` Deferred, `onAdmitted` (four suppliers, all
  `Deferred.succeed`), `activationIfOpened`, `rootRun`'s `raceFirst` under
  `uninterruptibleMask`, `sessionPrograms.start`'s second `onInterrupt`, and
  the trace buffer held "until the run enters" (`executeAgent.ts:106-134`) go
  (B8).
- The CLI chat's claim is a `FiberHandle<Run>`: pending is non-empty, the run
  id is `rootRunId`, everything else is a view read (F1).

**Deletes.** `Activation`, `RunLive`'s second meaning, `attemptOf`,
`attachControls`, `RunControls` (model switch is a queued row, R7),
`LiveRun`, `awaitDrained`, `withInactiveRunStep` and the registry's lanes
(the publisher's commit order serializes), `stopCause`, `markStopped`,
`terminate`/`visited`, `stoppedAtDisposal`, `closing`/`disposed`,
`bornDetached`/`unbornParent`, `assertAdmitsChild`, `RunStop`,
`StopCause`/`'released'`, `ExecuteAgentOptions.onAdmitted`,
`activationIfOpened`; in the CLI `RootRunClaim`, `NO_CLAIM`, the five claim
methods, `chatTuiRunPending`, `chatTuiCanStartRootRun`, the stop pair,
`isResumableIdle`, `settleClaimOnExit`, `continuedSince`, `accepted`,
`shutdownFinalizationDone`.

**Gives up.** A parent's stop cascading through fiber ancestry: a child runs
in the session scope (it may outlive a detaching parent), so the cascade is
a loop over the rows' children, as now. A stop that arrives between minting
and the first write refuses the launch instead of starting and stopping it.

**Amplification.** "A third terminal outcome": 14 files today
(`endVerdict`, `stoppedVerdict`, `endRun`, `failedEnd`, `finalizeRun`,
`endIn`, `runStatus` phases, three hosts' mappings, …); after, `RUN_OUTCOME`,
`verdict()`, the fold, the copy table.

## R3. A resume is a start from rows

**Decision today.** A resume is a joinable shared attempt: `RunAttempt
{ answer, admitted, waiters, handedOff, activation? }`
(`agent/followUp/ToolUseFollowUp.ts:143-156`), opened by `openResume`
(`:196-240`, recursive when refused), run as its own activation by
`RunRegistry.start(…, attempt)`, decided by `decideResume`
(`agent/runtime/resumeRun.ts:171-222`), launched by `resumeQueuedToolUse`
(`:280-369`) which answers "delivered" by tailing the log until the run rests
with its batch taken (`restsWith`, `:231-262`), handed to the caller by
`resumeRun` (`:103-159`) which counts `waiters` down and interrupts the run
when the last caller leaves before any held it, presented by `answered`
(`ToolUseFollowUp.ts:248-295`) from `handedOff` and `Deferred.isDoneUnsafe`,
and re-entered by `wakeRun` for an owned child's parent. One operation in
three files, by time; a mutable object crossing module boundaries (the
AGENTS.md "No shared mutable state" rule); `Deferred` plus counters where
`Fiber.join` is the thing. `SessionRequests.viaControls` waits on
`attempt.answer` before touching controls (`controllers/session/SessionRequests.ts:293-302`),
so the resume protocol leaks into the request handler too.

**Design.** `resume(runId, options)` = `resumeRefusal(facts, config)` (pure:
`finished | earlierBuild | unusable | blocked | ownedBy`) then the same
open-then-fork as R2. A second resume of a live run answers `{ live: fiber }`
and may `Fiber.await` it; nobody counts waiters and nobody stops a run
because its caller left (the owner wants runs to continue). A wake is a
resume with no caller. A caller that needs "the message was taken" reads
`followUpReceipt` over rows, which exists.

**Deletes.** `RunAttempt`, `openResume`, `wakeRun`, `answered`,
`decideResume`, `resumeQueuedToolUse`, `restsWith`, `taken`, `ResumeHandOff`,
`ResumeAttempt`'s `started/delivered` shape, `refusalFor`'s three branches
(one typed refusal), `storage/resumability.ts` folded into the pure refusal,
`FOLLOW_UP_WAKE_FAILED_MESSAGE`'s two emitters, `viaControls`' wait.

**Gives up.** Reference-counted resumes; the "presentation at the wake"
decision moves to one rule: a clicked resume is told its refusal at the
click, a refused wake is logged and the queued row waits for the next
explicit resume.

## R4. A run's end is one transaction; storage failure fails the fiber

**Decision today.** Writing one `run.end` row goes through `endRun →
failedEnd → endWith → endActivation → finalizeRun → beforeEnd → endIn` plus
`endVerdict`/`stoppedVerdict` (`agent/runtime/AgentRunLifecycle.ts`,
`agent/storage/runLifecycle.ts`), nine functions in two files, each
uninterruptible. `finalizeRun` (`runLifecycle.ts:315-397`) survives storage
failure three times: the end with its last turn, then an end carrying a
"result lost" notice to the parent, then a FAILED backstop, then
`logError("reads as running")`; `endIn` keeps a raw `append(beside)` beside
the `RunCell` path the guide calls the one writer. The halted `run.position`
is written only with `run.end`, carries the same outcome, and its
`RunPosition.outcome` has no production reader (`loop/rows.ts:83-104`, C3).
The end's rows are drafted in `shared/session/runFacts.ts`, added to in
`runLifecycle.ts`, edited by object identity in `loop/runProgram.ts:53-74`
(`birthRows` rewrites another module's `run.start`), and opened by a
three-optional mode on `RunHistory.open` (C8).

**Design.** `endRun(exit)` under `Effect.uninterruptible`: `verdict(exit,
stopRow)` is pure; the rows (open requests cancelled, consumed input dropped,
closure, `run.end`) are built by the transaction that commits them, in
`runLifecycle.ts`, as `birth`, `activate` and `end`, each one `log.transact`
deciding its rows from what it reads under the lock; `RunHistory.open` takes
one `opening` and learns birth from activation by the rows' first kind. A
failed transaction fails the fiber once, logged; the run then reads as
interrupted at the next open (O4), which is the truth: the process could not
write. There is no halt row: `run.end` is the halt, and `forkPoint`/`lastWait`
read the newest `waiting` position or the end. A child's result is not an
end-time hook (R5).

**Deletes.** `failedEnd`, `endWith`, `endActivation`, the `endVerdict` /
`stoppedVerdict` split, `finalizeRun`'s lost-notice and backstop levels,
`beforeEnd`'s claim line, `endIn`'s raw append, `persistFailure`, `recorded`,
`lastTurn`/`FinishLastTurn`/`TransactionPart` (`note` has no producer,
`held` goes with O1), `haltedPositionRow`, the `halted` literal and its five
special cases, `RunPosition.outcome`, `registrationDrafts`,
`activationDrafts`, `runEndDraft`, `Registration`, `birthRows`'s rewrite,
`RunOpening`'s three optionals; `run.start.approvalPolicy` (grants are one
kind, `approval.policy`, in the birth batch, C5).

**Gives up.** A run whose end could not be written reads as interrupted, not
as FAILED-with-backstop; the trace viewer's scrubber stops at the end row.

## R5. Every child is a run that ends

**Decision today.** A background child has no "finished": it is launched
without `stopAfterCycle` (`agent/runtime/delegation/subagentRun.ts:320-322`),
delivers every turn, then blocks on its inbox forever
(`loop/toolUse.ts:408-446`), so `shouldSkipWait` reads WAITING as "job
delivered" (`tools/executions/waitCoordination.ts:437-443`) and the loop
carries four `isChild()` branches. "A child finished, here is its result"
therefore has twelve paths (A's table), over two row vocabularies
(`followup.queued` versus `child.park`/`child.turn`/`run.report`/`run.result`),
four wake sites and a five-form delivery-id grammar parsed by prefix in a
fifth module (`tools/ExecutionsTool.ts:213`). `childRunLoop.ts` (849 lines)
drives two unrelated families (native, process) through a mutable
`ChildLoop` with a nine-step temporal decomposition of one turn and a
`settle` callback explained by comment (A5). `child.turn` restates
`run.position` for a native child, keyed by a `randomUUID` minted per loop
object although the activation already has the `run.activate` commit as its
identity; `child.park parked/resumed` is the process child's
`waiting`/`turn.begin` under another name, and `paused { resumeId }` is one
plugin's thread id stored as a harness row with a five-method interface
implemented once (A2, A3, C4). A background command's output is smuggled as
trace `log` rows tagged by a magic data key and re-parsed, its stop is a
fabricated `exitCode: 130`, and `wait` re-derives `working` (E7).

**Design.** One child program, no mode: every child is `executeAgent` with
`stopAfterCycle: true` and ends with its `run.end`. The difference is who runs
the fiber (O5):

- awaited: the tool call's fiber `Effect.forkChild`s it (as `awaitInBand`
  does, `delegation/inBandSubagentRun.ts:286`), `Fiber.join`s, and records
  the child's `run.end` as its `tool.result`; `agentChildRunId`/`earlierChild`
  keep it crash-safe.
- background: `FiberMap.run` on the session; its `run.end` transaction
  appends the one `followup.queued` on the parent; `wakeIfOwed(parent)` runs
  once after that commit. A follow-up to a finished child is a resume with a
  message (what `submitFollowUp` already does).

A process child (bash, agent CLI) is a run too: a second run program under
`runToolUse` whose turn is `strategy.runTurn(batch)` instead of a model call,
with `run.position` rows like every run, so `child.turn`, `child.park` and
`RunRows.childTurn/park/heldParks` go. Its output is its own row,
`process.output { stream, text }`, its exit `process.exit { code, signal }`;
a stop writes no exit (the interruption is the fact). The agent-CLI thread id
is a `plugin.fact` row the plugin writes and reads back by id; a stopped
CLI child is a cancelled run resumed by its own id. The budget is a
`Context.Reference<Semaphore>` with an unlimited default, one permit per
background run around its loop; the per-script semaphore goes (A6). "Does
this run take a message now" is one fact on the rows read in the sending
job (`needsWake`); its eight representations and three answer shapes
collapse to `sent | refused(reason)` with one wake after the commit (A4).
The delivery envelope's typed facts ride the row and render once at
`FollowUps.batchMessage`; the id is `${runId}:${activationCommit}` assigned in
one place and parsed nowhere (A7). The child's `run.end` carries its result;
`run.result` goes (A11).

**Deletes.** `ChildRunTurns`, `ChildRunBoundary`, `turnPermit`,
`finishTurn`, `finishLastTurn`, `ExecuteAgentOptions.turns`, `driveNative`,
`ChildLoop`, `ChildEnd`, `startChildRunLoop`, `startDetachedChildRunLoop`'s
two branches, `childRunLoop.ts` whole, `awaited`, `LiveRun.readsMessages`,
`suppressAutoDeliveredSubagentReport`, the `wait` prefix scan,
`waitCoordination.ts`, `child.turn` and `child.park` as row kinds,
`parkSubstate`, `RESTING_SUBSTATES`, `RUN_SUBSTATE.PAUSED/RESULT_WAITING`,
`RUN_ROW_READS.parks/turns`, `pauseChildRun`, `resumedChildRunId`,
`ChildRunPause`, `ChildRunPort`, `releaseOwnership`, `interruptedTurn`,
`scriptChildBudget`, `AgentBudget`, `RunRegistry.childRunBudget`,
`USER_FOLLOW_UP_SUPPORT`'s five launch sites, `wakesOnly`,
`Sent.queued.read`, `SubmitFollowUpResult.wake`, `RunInput.ended`,
`SessionInbox.disposed`, `run.result` as a kind, `buildResultMeta`,
`readResultMeta`, `LastTurn`, `TAG_OF`, `launchBackgroundBash`'s twelve
duplicated lines (A9); `runLaunchGuard.ts` whole (held parks: O1/O5;
`closeLeftoverRun`: O4 plus a resumed parent's call finding its child
interrupted through `resumedAttempt`).

**Gives up.** A background conversation child taking a second message
without a resume; per-turn progress from a multi-turn background child; the
word "Paused" (a paused child reads "stopped, resumable"); a plugin's
free-form delivery tag. Hosts that listed a background child as WAITING
("job done") list it as COMPLETED, which is truer.

**Amplification.** "A background child's completion is one message" (O5):
22 files today, 2 after.

## R6. The view carries facts; words are one function

**Decision today.** `RunView.status` reuses the three `RUN_OUTCOME` literals
as phases (`shared/schemas/run.ts:36-42`), so one enum holds two facts and
`withAggregates` takes it apart again into `durableOutcome`, `working`,
`turnOver`, `live` (`shared/session/sessionViewUpdate.ts:457-464`); `substate`,
`group`, `statusKey`+`tone`, `statusNotice`, `actions`/`forceExpanded`/the
rollups and `runStartedAt`/`turn` nulling spell the same three facts nine
ways on one record, "interrupted" alone seven ways (C's table, 28
representations). The row→phase rule is written four times (`PHASE_AT`,
`phaseMoveOf`, `applyRunEvent`+`movePhase`, `recordFacts`) and "which rows
bound a lifecycle" five times (C2). "Can this run continue" is decided in
four vocabularies while `actions.includes('resume')` already answers it for
25 sites (C9). Activation is accumulated over as `decidedSinceActivation` (a
`Set` rebuilt per row) and `resuming`, both "commit > activation's commit"
(C6). Hosts still re-derive fourteen of these (F1's table), the CLI chat
most of all.

**Design.** `RunView` carries `position: 'ready' | 'running' | 'waiting'`,
`outcome: RunOutcome | null`, `holder: 'here' | 'none'` (R1), `pendingRequest`
and `actions`; one function in the app's copy module maps them to word,
tone, group and offers. One `lifecycle(rows)` reader names the activate/end
pair; `phaseMoveOf` is the one row→phase function and the view's
`movePhase` calls it. `RunState.activatedAt: CommitOrdinal` and
`RequestState.decidedAt` replace the accumulators. The listing entry carries
`actions` and `outcome`; `resumable`/`resumeBlocked`/`paused` and the CLI's
`HISTORY_RUN_STATUS` go. `RunRows` becomes typed per read (C10). Hosts read
`position`, `outcome`, `actions`, nothing else (O6 taken to its end: fewer
fields, not more).

**Deletes.** `RUN_PHASE`, `RunLifecycleStatus`, `RUN_LIFECYCLE_READY`,
`RunView.status/substate/durableOutcome/group/working/turnOver/live/statusKey/tone/forceExpanded`,
`statusNotice.interrupted`, `isTerminalOutcomePhase` (24 refs),
`isInFlightPhase`, `isTranscriptSettlementPhase`, `RUN_STATUS_TONE_OF`,
`runStatus()`, `taskGroupDisplayStatus`'s outcome parameter,
`lastLifecycleRow`, `runEndFromEvents`, `lifecycleStart`, `PHASE_AT`'s
`waiting` duplication, `decidedSinceActivation`, `resuming`,
`RUN_SUBSTATE.STARTING/RESUMING`, `continuesFromRows`' second caller,
`AgentRunListingEntry.resumable/resumeBlocked/paused`, `HISTORY_RUN_STATUS`,
`cliRunStanding`, `recordOf`, the fold's string error channel
(`invocationAfter` returning `string`, `RunRowVerdict`'s `unresolved` arm and
two overloads, `outOfOrder`, `RowRejection`, the five-reason enum: C7).

**Gives up.** `statusKey` as a stable wire enum (18 readers re-baseline); the
frozen `status` word in the NDJSON stream `texra-action` reads (1.0 allows the
break, with a clear error).

**Amplification.** "A fourth terminal outcome": 16 files today, 3 after.

## R7. A question to a person is a row of the run

**Decision today.** The request is in `RunState.requests`, but the door that
writes it is on the session (`SessionRequests`), with the run's cell reachable
only through `AskOptions.open`, a callback with one supplier
(`loop/toolGuard.ts:354-372`). So `request.decided` is spelled by five
writers (policy answer, surface, activation cancel, end cancel, the invoker's
`PERSONAL_RETRY`), waited on by three `log.tail` readers, and
fitness-checked three times (B5). A bash approval passes through ten steps
in six files; "who may answer it" is stored four ways (`QueuedApproval.grant`,
row `allowBypass` from four writers and two expressions, `RunCall.hook`,
`OPERATIONS` column 1); "a grant turned on answers waiting prompts" has two
mechanisms (the lane head re-check and `approvePendingUnderBypass`) (E2).
`approvalDenied` is a fire-and-forget side channel beside the rows that the
CLI dedups by string key (E8). The harness's `SessionHost.approve` port and
its `answerRequests` loop (`effect/requestAnswerer.ts:135-175`) are
implemented by no host; the CLI rebuilds the loop twice and adds a
client-side `decided` set so the modal can vanish a frame before the row
lands (F2).

**Design.** One module, `agent/runtime/requests.ts`: `openRequest(cell,
payload, beside?)` commits through `RunCell.append` (every asker holds a
cell: the guard, the invoker, a script's agent request) with the policy's
own answer in the same batch, and waits on the cell's row stream;
`decideRequest(runId, requestId, decision)` is the one checked append every
surface, policy change and the invoker use; `cancelOpenRequests(state,
cause)` is what activation and end append. The request row carries
`answeredBy: 'person' | ApprovalBypassKind`; a grant change commits its
`approval.policy` row and, in the same transaction, a `request.decided` for
every open request it covers. A denial is a row (`request.decided` with a
reason, a `tool.result`, or `withheld` on the `tools.offered` row). Hosts
attach with `approve: (pending) => Effect<RequestDecision>` and the harness's
loop runs it: the card is on screen exactly while its fiber runs. A model
switch is a queued `/model` row the loop applies or refuses with a consumed
row the receipt reads; `RunControls` goes with it.

**Deletes.** `AskOptions`, `SessionRequestsShape.ask/decide/decision`,
`requestAsks`, the three tail waiters, two `answerMismatch` sites,
`DecidedDraft`/`decidedRows`, `PERSONAL_RETRY`, `commandApproval.ts`,
`QueuedApproval`, `enqueue`, `approvePendingUnderBypass`, the per-run prompt
lanes, `allowBypass`'s four writers, `OPERATIONS`' second column,
`ApprovalPolicyDenial` and its host schema copy, `approvalDenied`,
`approvalPromptsUnavailable` as a getter (a boolean at attach),
`requestAnswerer.overlay`'s `Proxy`, `RunControls`, `viaControls`; in the
CLI `createHeadlessCliHostInteractions`' loop, `decided`, `markDecided`,
`reopenRequest`, `issue`, `stagePresentation`/`dropPresentation`,
`presentedOrder`, `promoted`, `useHostCapability`/`hostCapability`.

**Gives up.** `request.decide` from a surface on a run the process does not
hold (O1 makes it moot); a grant answers every open request it covers,
including a hook's, unless the ask wrote `answeredBy: 'person'`, which it
knows; the headless prompt's "ask again" becomes the harness's three retries.

**Amplification.** "A new request kind": 6 files today, 3 after.

## R8. A session is one scoped layer, one tail, one host port

**Decision today.** `SessionServices` is 13 tags and the per-root graph 10
more: 23 Context tags over one SQLite file, split by layer and by time
(`sessionOwnersLayer` is seven layers piped in build order with a private
bag `SessionStoreParts` carrying `consumers`/`fibers`/`cohort` across them,
`controllers/session/sessionOwners.ts:91-127, 297-320`); the roots are four
tags over one value; the view is two tags; `requestsLayer` spreads the raw
`Database` into `SessionRequests` so the request handler reads the claim
table below `SessionLog`'s doors; `SessionOwner.holds` identity-compares the
`Runs` object to learn the session is open (B1). `SessionHostInteractions` is
a state machine in `attached?/opened?/disposed` with a 256-deep replay array
and a `Proxy` overlay, over an interface whose every member is optional
(B7, E8). One layer down, `RunCallShape.session` carries 13 picked tags
re-provided or read 18 times in fibers that already hold them (E5); the
owner's decision 1 named `runs`, one tag.

**Design.** One `Layer.scoped(SessionServices)` that acquires store, view,
interactions, runs, consumers in order and lets the scope release in reverse;
no bag, no `cohort` (the sweep reads the view), no `holds`. One root tag
(`SessionRoots` with the two rooted filesystems as fields), one view tag.
`Interactions` = `{ host: SubscriptionRef<Option<Host>>, notices:
Queue.sliding(256) }`; `attach(host)` is `acquireRelease` in the caller's
scope; `emit` is `Queue.offer`; `canPresent` is a required boolean.
`RunCallShape.session` becomes `runs`; a built-in that needs a session
service yields its tag. The fold's non-durable inputs are one record with
fields, not three tags.

**Deletes.** `SessionStoreParts`, the seven layer constants, the `consumers`
scope and `fibers` set, `cohort`, `SessionOwner.holds`, the `requestsLayer`
spread, `WorkspaceRoots`/`WorkspaceFs`/`StorageFs` as tags,
`SessionViewService` as a second tag, `SessionHostInteractions`,
`PresentationProgram`, `queuePresentationReplay`, `replayPendingPresentations`,
`overlay`, the `ended` Deferred, `RunCallShape.session`'s 13 tags, `ToolEnv.run`
(the same object as `RunCall.run`).

**Gives up.** Swapping one layer in a test (the two suites build the one
session layer over an ephemeral store); the compile-time fence that a
plugin's tool cannot name a session tag moves to the table's one cast.

## R9. The model path: rows drive a turn; the row stores the verdict; health is a Latch

**Decision today.** `runInvocation` is generic over an eight-member
`InvocationDriver` plus a three-member `Asker` for two callers, and the
second caller (`run/modelCall.ts`) implements the driver by faking rows with
an in-memory `Ref<Invocation>`, `requests: {}` and a null asker the loop dies
on if reached (D1). The `failed` row stores a display vocabulary
(`ProviderErrorClassification`) and worded text, and the loop branches on the
re-encoding (`run/compaction.ts:417-421`); eleven places decide "retryable /
which credential / which plan" after O8 (D2). `ModelRetryGate` is a `Latch`
and a `Semaphore(1)` written by hand with version counters, waiter arrays, a
probe slot, two `uninterruptibleMask` and `Deferred.makeUnsafe` (D4).
`AgentRun.swapModel` is `ScopedRef.set` by hand; a bearer token rides on
`BoundModel` through five signatures so the loop can renew it, and the renewal
spends a retry and is guarded in memory (D5). The OAuth coordinator builds
`SharedAttempt`, `SerializedWrites` and a generation counter so a sign-out can
supersede a refresh (D6). "Background delivery" has seven representations and
four checks, two unreachable (D3). The helper model is a special request
inside the general bind with a layer per call (D7).

**Design.**

- Two loops because there are two kinds of call: a turn (`runInvocation`
  inlined into `ModelInvoker.invoke`, its one caller, over `cell`, the
  `ScopedRef<BoundModel>` and the gate; `nextAttempt` stays the pure reducer)
  and a call off the rows (summary, helper) as `Effect.retry({ while:
  retryable, times, schedule: Schedule.spaced(…) })` under the gate, about
  forty lines. The summary's `purpose: 'summary'` rows go (the fold already
  ignores them; the usage is on `context.edit`); harness `AGENTS.md`'s
  sentence about them changes with it.
- The `failed` row stores llm's verdict fields; wording is a projection at
  every reader; `next` carries the credential move; an automatic fallback
  opens no request.
- The gate is per route `{ latch: Latch, probe: Semaphore(1), failures,
  retryAt }`; `RoutePolicy` is data `{ key, scope }`; the backoff is the
  gate's alone.
- `AgentRun.model` is a `ScopedRef<BoundModel>`; a switch is `ScopedRef.set`
  at the loop's model boundary; `rebind` compares the row's `modelId`, not
  object identity.
- The bearer is the credential's: `ModelCredential { accessToken:
  Effect<string> }` served by the coordinator; on 401 llm refreshes and
  resends once, unbilled, inside the attempt. The harness never sees a
  renewal.
- The coordinator is one `Semaphore(1)` around every read-then-write, the
  exchange-and-store uninterruptible; a login waits for an in-flight refresh.
- `BoundModel.delivery` is a value decided once at bind; `observe` emits no
  `identified`; `submit`'s completion goes through the same sink.
- `helperCall` resolves its name and calls the general `bind`; `ModelAccess`
  is provided once per session.

**Deletes.** `InvocationDriver`, `Asker`, `ModelCall`, `modelCall.ts`,
`reacquire`, `InvocationPurpose`, `isSummaryAttempt`,
`ProviderErrorClassificationSchema`, `classificationOf`, `PERSONAL_RETRY`,
`declinedBy`'s request read, `BindRequest.config`, `RouteState.version`,
`waiters`, `Waiter`, `ScheduledProbe`, `acquire`/`acquireAll`/`leave`/`abandon*`,
`RouteOptions`, `RoutePolicy.classifyFailure`/`isReachableFailure`, the sleep
in `pauseBefore`, `swapModel`, `bindingScope`, `BoundModel.subscriptionToken`,
`BindRequest.rejected`, `HelperRequest`, `credentialRenewal`, `spent`, the
`'renewed'` literal, `SharedAttempt`, `SerializedWrites`, `sessionGeneration`,
`stableSession`, `supersedeInFlightRefresh`, `sessionAfterSupersede`,
`backgroundOn`, `readGoogleBackground`, `Binding.background`,
`BindSpec.options.background`, the `identified` dedupe, the two unreachable
capability checks, `attemptStarts` WeakMap, the synthetic `failed` row for
`reask`.

**Gives up.** A summary's audit rows; stored wording (hosts render from the
verdict, which is also what makes it localizable); a toggle flipped mid-run
applies at the next bind; a sign-out waits for an in-flight exchange; the
"unclassified failure keeps the cohort closed" rule.

**Amplification.** "A third subscription": 9 files today, 3 after. "A new
verdict kind": 6 today, 3 after.

## R10. Hosts bind verbs; a client holds a Session

**Decision today.** The two GUI hosts already share one body
(`packages/texra/src/controllers/server/openGuiWindow.ts` `answerShared`, 29
kinds) over a verb table; the CLI is a third, unrelated implementation of the
same actions: five resume entry points with four refusal wordings, three
copies of "a refused launch shows its notice" (F3). The client reimplements
the session three times at three widths (`serviceSession.ts` as `Session`,
`runReads.ts` as `CliRunReads`, `serviceRecords`), with `serviceRunReads`
fabricating `null`/`[]`/`config_missing` for an unknown run (silent
degradation), and the local path already fakes a `ServiceLink` so the hosts
carry `GuiSession`/`DesktopProject`/`CliPlatformServices` unions (F4). The
exit code has four writers over about twenty sites (F5). The NDJSON progress
drainer hand-rolls "drain to a cursor" with four counters, a `Deferred` and
three fibers (F6); the service client carries a generation the `FiberHandle`
already supersedes and opens a second `task.watch` stream for aggregates the
window feed names (F7).

**Design.** `createHostRunActions` is the one owner for all three hosts; the
chat controller and the headless commands call `runValidated`, `resume`,
`fork`, `sendFollowUp` with the terminal's presentation ports; `admitLaunch`
is "the working directory is one of `roots.workspaces`" in the body. One
`Session` interface with `records`, `listRuns`, `deleteRuns`; the RPC surface
mirrors it one-to-one; an unknown run fails with `TaskRecordsFailed`. `Run.result`
is a projection of the view the client folds. The exit code is one function
of one fact at the process edge, `exitCodeOf(outcome)` in `bin/texra.ts`. The
drainer is `Stream.takeWhile(e => e.commit <= stopAt)` with `stopAt` a
`Deferred` the detach completes. The RPC path carries no generation.

**Deletes.** `launchRootRun`'s start/present half, `showFailure`,
`reportRunFailure`, the five resume wordings, `admitLaunch` from both binding
tables, `useCurrentFile`'s 68 lines from the extension, `CliRunReads`,
`localRunReads`, `serviceRunReads`, `noDetail`, `serviceRecords`, the
`GuiSession` union, `DesktopProject`'s second branch,
`CliPlatformServices.runSession/reads`, `runEnded`, `task.ended`,
`answered`/`endOf`, `exitCode.ts` (`setExitCode` 8 sites), `settleExitCode`,
`CliConfigExecuteResult.exitCode`, `ChatExit.signal`, `delivered`/`stopAt`/
`drained`/`childrenPending`/`settleIfDrained`/`passed`/`drainedTo`, the
generation on the RPC path, `runningTasks(projects, parked)`, the ten
`registerCliStateResetHook` singletons' reason to exist.

**Gives up.** Nothing user-visible; the headless resume keeps its usage exit
code by mapping `Unavailable` once.

## Order

Each root depends on the ones above it in this list; a slice is a deletion
whose callers are known, never a fix, and no "one owner" consolidation PR
lands inside a model a root below replaces.

1. **R1** (slice 3 of the one-fact note, plus the store interface above).
   Decides the size of everything else.
2. **R2 + R3 + R4** in one PR: the registry as a `FiberMap`, resume as start,
   end as one transaction. They share every file; split, each would re-add
   the hand-off the next deletes.
3. **R5**: children as runs that end. Depends on R4's `endRun` for the one
   delivery and on R2's `FiberMap.run` for the background fork.
4. **R6**: the view's three facts. Depends on R2 (`holder`) and R5 (no
   `child.park` substates). Hosts' re-derivations (F1's table) go in the same
   PR as the fields they read.
5. **R7**: requests through the cell; `SessionHost.approve` used by the CLI.
   Depends on R2 (no `RunControls`, no `viaControls`).
6. **R8**: the session as one layer, one tail. Depends on R1 (one writer) and
   R7 (no `SessionRequests` reading `Database`).
7. **R9**: the model path, in three PRs (the loops; the verdict row; the gate,
   `ScopedRef` and the credential), each independent of the others.
8. **R10**: hosts, in two PRs (actions and session; exit code, drainer,
   generation). Depends on R6 for the view fields it reads.

Second-order findings that need no root decision and can land any time:
tool-schema union flattening (E6), hooks as one step value (E3), the script
run's five `handedDown` branches (E4), `openStep`'s mode parameter (E9), the
script door's `Deferred` maps (E10, measured attempt only), the fold's typed
read table (C10), deletion's three entry points (B9), the module-level
singletons in the CLI runtime (F7).

## Acceptance

- Every root lists its deletions; a PR cites the root and deletes everything
  the root names for the files it touches, or says in its body which item it
  leaves and why.
- `npm run check:fact-spread` shrinks on every slice; the `*Unsafe` /
  `addObserver` / `uninterruptibleMask` count in `packages/harness/src` and
  `packages/llm/src` (53 at `ccf15b4`) falls with R2–R4, R8 and R9, and no
  slice raises it.
- Comment share of `runRegistry.ts`, `AgentRunLifecycle.ts`,
  `ownerLiveness.ts`, `childRunLoop.ts`, `sharedAttempt.ts` is no longer
  measurable, because the files are gone; no replacement file explains a
  hand-off protocol in prose.
- The change-amplification counts above (14 → 4, 22 → 2, 16 → 3, 9 → 3) hold
  on the tree after the slice that claims them.
- The good modules each audit names stay: `inFlight.ts`'s reducers,
  `RunCell`/`commit`, `inImmediateTransaction`, `logTails`, `defineTool`,
  `hooksAt`, `resolveStepTools`, `EXECUTION_ROUTES`, `backgroundLifecycle`,
  `configurationFor`, `verdict.ts`, `RunInput.ts`, `agentChildRunId`,
  `formatDelivery` as a renderer, `followPendingRequests`, `SessionKey` +
  `LayerMap`, `openGuiWindow`'s `answerShared`, `requireAction`, `holdSignals`,
  `hostWindows`, `linkService`.

## Risks

- R2's `FiberMap.run` with a synchronous `hasUnsafe` check is atomic only
  because JavaScript is single-threaded and the fork starts in the same
  evaluation; the check must stay in one `Effect.suspend`.
- R4 makes a storage failure fatal to the run's fiber; the hosts must present
  an interrupted run (O4 lists it) rather than a FAILED one. That is a
  behaviour change the owner accepts by accepting R4.
- R5 changes the rows a child writes (`child.turn`, `child.park`, `run.result`
  go; `process.output`/`process.exit` arrive) and the status hosts show for a
  background child; one `rowVersions` bump per kind, golden stores
  regenerated, the crash-conformance support rewritten for the new rows.
- R9's credential getter depends on the pinned OpenAI SDK's per-request token
  path; the fallback is a client per request.
- R6 re-baselines three hosts' status snapshots and breaks the NDJSON `status`
  word for `texra-action`.

## Findings by area

The audits' findings, each with its root; "2nd" marks a second-order item.

| Area | Finding                                                                   | Root |
| ---- | ------------------------------------------------------------------------- | ---- |
| L    | `Activation` as a state machine; `start`'s five parameters                | R2   |
| L    | resume split across three files with a shared mutable `RunAttempt`        | R3   |
| L    | the claim protocol in twelve call sites                                   | R1   |
| L    | nine functions to write one `run.end`; `finalizeRun`'s three fallbacks    | R4   |
| L    | `runLaunchGuard.ts` as a conjoined, vaguely named file                    | R5   |
| L    | `'released'`; `stop()`'s two-part answer; 28–35% comment share            | R2   |
| A1   | a background child never ends; twelve delivery paths                      | R5   |
| A2   | `child.turn`/`child.park` as a second position vocabulary                 | R5   |
| A3   | the agent-CLI pause as a harness row with a five-method interface         | R5   |
| A4   | "takes a message now" has eight representations                           | R5   |
| A5   | `childRunLoop.ts` drives two families through a mutable class             | R5   |
| A6   | budget acquired through a row-writing permit; a second semaphore          | R5   |
| A7   | the envelope's shape in four modules, its id grammar in a fifth           | R5   |
| A8   | `openResume`/`wakeRun` as a counted `Deferred` join that also presents    | R3   |
| A9   | `launchBackgroundBash` duplicates `launchProcessChild`                    | R5   |
| A10  | `TransactionPart.note` with no producer; `held` with O1                   | R4   |
| A11  | an awaited result read three times; `run.result` duplicates `run.end`     | R5   |
| B1   | the session assembled by time with a services bag                         | R8   |
| B2   | three tails, six commit coordinates                                       | R1   |
| B3   | `afterCommit` hook list; `order: true` jobs for streamed text             | R1   |
| B4   | `unreadable` and `runsHere` through the `local` ref; a cold read's prober | R1   |
| B5   | five writers of `request.decided`, three waiters, one-caller callback     | R7   |
| B6   | `mapDatabaseFailure` re-classifies defects; `storeGate` per write         | R1   |
| B7   | `SessionHostInteractions` as a state machine with a `Proxy`               | R8   |
| B8   | "the caller let go" handled twice; `onAdmitted` as a callback             | R2   |
| B9   | deletion: a two-valued mode, a decorated method, a per-call scan          | 2nd  |
| C1   | `RunView.status` is two facts; the fold re-splits it into eight           | R6   |
| C2   | row→phase written four times; lifecycle bounds five times                 | R6   |
| C3   | the halted `run.position` restates `run.end`                              | R4   |
| C4   | `child.park` as optional fields, duplicated by `child.turn`               | R5   |
| C5   | grants on two row kinds; `birthRows` rewrites another module's draft      | R4   |
| C6   | activation accumulated over (`decidedSinceActivation`, `resuming`)        | R6   |
| C7   | fold errors as strings, a four-arm verdict, a five-reason enum            | R6   |
| C8   | drafts in `shared`, committed in `storage`, edited in `loop`, by boolean  | R4   |
| C9   | "can it continue" in four vocabularies                                    | R6   |
| C10  | `RunRows` as nine reads over one 23-field record; `recordOf`              | 2nd  |
| D1   | one retry loop, three drivers, two stacked interfaces                     | R9   |
| D2   | the verdict re-encoded into a display classification the loop reads       | R9   |
| D3   | background delivery: seven representations, four checks                   | R9   |
| D4   | `ModelRetryGate` as a hand-rolled Latch + Semaphore                       | R9   |
| D5   | `swapModel` as `ScopedRef.set` by hand; the bearer on the binding         | R9   |
| D6   | `SharedAttempt`/`SerializedWrites`/generation for login over refresh      | R9   |
| D7   | the helper model as a special request in the general bind                 | R9   |
| D8   | `attemptStarts` WeakMap; a `failed` row for an attempt that did not fail  | R9   |
| E1   | seven in-memory facts beside the rows (`oneShot`, `opened`, `holding`, …) | R2   |
| E2   | ten steps, six files, four spellings of "who may answer"                  | R7   |
| E3   | `hooks.ts`: six single-caller exports, `staleHook`, a view parent walk    | 2nd  |
| E4   | a script run's five `handedDown` branches; `isTrustedScript` at eight     | 2nd  |
| E5   | `RunCallShape.session` as a carried context of 13 tags                    | R8   |
| E6   | the provider's union flattening known by twelve input schemas             | 2nd  |
| E7   | background output as tagged log rows; a fabricated exit code; `wait`      | R5   |
| E8   | `HostInteractions` all-optional over a hand-rolled sliding queue          | R8   |
| E9   | `openStep`'s mode parameter and discarded rows                            | 2nd  |
| E10  | the script door's `Deferred`-map lane scheduler                           | 2nd  |
| E11  | `callRequests`' eight parameters; `sessionDescription`'s Deferred         | R7   |
| F1   | the CLI chat's own run registry beside the view                           | R2   |
| F2   | the harness's approval loop reimplemented twice, with `decided`           | R7   |
| F3   | the CLI as a third host-request handler                                   | R10  |
| F4   | the client reimplements the session three times                           | R10  |
| F5   | four exit-code writers; the headless shutdown's documented race           | R10  |
| F6   | the NDJSON drainer's four counters and three fibers                       | R10  |
| F7   | vestigial generations; `runningTasks(parked)`; CLI singletons             | 2nd  |
