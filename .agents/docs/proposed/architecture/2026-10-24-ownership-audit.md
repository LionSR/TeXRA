# Ownership audit: one fact, several deciders (harness, 2026-10-24)

Baseline: worktree `coauthor-input`, branch `feat/run-input-one-owner`, HEAD
`0aa993447b`. Ten files had uncommitted step-3 edits while this was read
(`runRegistry.ts`, `Inbox.ts`, `ToolUseFollowUp.ts`, `resumeRun.ts`,
`childRunLoop.ts`, `childTurnResult.ts`, `runs.ts`, `runLifecycle.ts`,
`errors.ts`, `sessionEvent.ts`); line numbers for those cite `git show HEAD:`
and are marked `(HEAD)`. Every other citation is the working tree. Paths are
under `packages/harness/src/` unless they start with `packages/`.

Method, as in `2026-10-23-run-input-one-owner.md`: name one fact, list every
place that decides it, show the disagreement or race, name one owner, list
what goes. Findings that cover the input chain already in that doc are not
repeated here.

## Summary

1. **A stop in progress** is held in four forms (`stopping` tokens,
   `entry.stopReason`, the folded `CANCELLED` status, the `run.end` row) with
   two lifetimes; the child-admission gap between token-lift and fold is
   patched by a fifth mechanism, `sweepChildrenOfFoldedStop`. Owner:
   `entry.stopReason` until the fold, then the row. Deletes about 70 lines.
2. **Why a run may not continue** is decided three times for one message to an
   idle run: `runRejection` before the send, the inbox's hold in the send, and
   `resumeHere` after it; `blocked` is known only to the third, so the user
   gets two notices for one refusal. The nine-arm `FollowUpFailureReason`
   aggregates these three deciders plus the inbox's `Refusal`, and the resume
   path round-trips a four-arm union through `Error` instances and back
   (`refusalFor`). Owner: one `resumeStanding` read, the admission's only
   gate. Deletes about 60 lines and three mapping tables.
3. **"Ended in its current lifecycle"** is written five times with three
   scopes (`runEndFromEvents`, `heldParks`, `needsWake`, `Inbox.read.closed`,
   `sweepLeftoverRuns`); `needsWake` reads an old cancelled end after a resume
   and refuses a child's wake. Owner: `runEndFromEvents`. About 15 lines.
4. **A child's held result was delivered** is two rows: the parent's
   `followup.queued` and a corrective `child.park` the view's observer writes
   after seeing it (`clearHeld`). A crash between leaves the child "result
   waiting" until the parent's next resume. Owner: the parent's row, read by
   `parkSubstate`. About 40 lines.
5. **Stop-reason precedence** is stated twice, oppositely: the registry keeps
   `user` over a later `shutdown` (`markStopped`), the CLI keeps `shutdown`
   over a later `user` (`standingStop`), and the CLI holds the reason in two
   more places (`let stopReason`, `rootRunClaim.stop`). Owner: the registry
   entry; the CLI sends and forgets. About 25 lines.

Smaller: `Resumes.inFlight` restates `Resumes.running` (5 lines);
`runActionGuard.require` repeats `SessionRequests.requireRunAction` for
requests that already pass through it, and `runActionGuard.resuming` restates
`Resumes` with a different answer (refuse vs join) (20 lines);
`isChildResult` restates `parentOf`'s fallback order inline (6 lines);
`sweepLeftoverRuns.runningRuns` is a third liveness rule (phase-based) that
keeps a crashed owner's shell forever.

## Findings

### F1. A stop in progress: four forms, two lifetimes, a sweep for the gap

**Landed in #14261 (2026-10-24):** `stopping` tokens, their lift and
`sweepChildrenOfFoldedStop` deleted; `assertAdmitsChild` reads
`entry.stopReason`, then the fold's `cancelled`, with one refusal message.
`ChildLoop.userStopped` stays: it is the loop's copy of `stopReason` taken at
the interrupt, because the entry can be pruned before the loop's end runs.

Fact: "a stop of run R has begun and the run has not yet folded as
cancelled" — what child admission, a user's follow-up and a child loop read.

| Decider                             | Where                                              | Set                                                                                               | Cleared                                                | Read by                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `stopping: Map<RunId, Set<symbol>>` | `runRegistry.ts:167` (HEAD)                        | `stop()` `:641-647`                                                                               | `lift` at settlement `:648-652`; new generation `:464` | `assertAdmitsChild` `:374-389`                                                                                                                 |
| `entry.stopReason`                  | `:154`                                             | `markStopped` at request `:641`, in `stopHere`, `terminate`, `interruptActiveChildren` `:771-775` | new generation `:466`; entry pruned                    | `submitFollowUp` (HEAD `ToolUseFollowUp.ts:297`, waits for drain); `ChildLoop.interrupt` (HEAD `childRunLoop.ts:310`); `backgroundTurn.ts:100` |
| folded status `CANCELLED`           | `stopFolded` `:391-393` over `view.run(id).status` | the fold of `run.end`                                                                             | next `run.activate`                                    | `assertAdmitsChild`, `sweepChildrenOfFoldedStop` `:762-767`                                                                                    |
| `run.end` row, outcome `cancelled`  | `finalizeRun` (HEAD `runLifecycle.ts:324`)         | the terminal                                                                                      | next `run.activate`                                    | `needsWake` (`runFacts.ts:206-207`), `runEndFromEvents`                                                                                        |
| `ChildLoop.userStopped`             | HEAD `childRunLoop.ts:274, 310`                    | copy of `stopReason === 'user'` at interrupt                                                      | loop end                                               | `endNative` `:747`                                                                                                                             |

The gap and its patch are documented in the code itself:
`sweepChildrenOfFoldedStop` (HEAD `:756-767`) "interrupts the children
admitted between the stop's settlement and the fold". The window exists
because the token is lifted at settlement, and for a local cascading stop the
settlement is `Effect.void` (`:674-676`): `lift` runs as soon as the request
handler awaits it (`SessionRequests.ts:363-366`), while the run's fiber is
still unwinding and its `run.end` is not yet committed.

Scenario (inputs → two deciders disagree): user presses Stop on a local root
with `detachActiveChildren: false`. `stop()` marks `stopReason = 'user'`,
`stopHere()` interrupts, settlement returns, `lift` empties `stopping`. The
root's dispatcher is in an uninterruptible region (`toolUseDispatch.ts`
settlement) and launches one more child: `reserveChildActivation` →
`assertAdmitsChild` sees no token and no folded `CANCELLED` → admits. Meanwhile
`submitFollowUp` for a user message on the same run sees
`stopReason !== undefined` and waits for the drain. Two in-memory markers for
one fact answer differently in the same instant. The child runs until the
fold-gated tail delivers the parent's `run.end` and the sweep kills it with
`reason: undefined` (`:764-766`), so a remote operation it started is not
cancelled even though the user's stop was explicit.

Why `stopReason` alone closes the window: `SessionLog.transact` returns only
once the view has folded the commit (`SessionHandle.ts:87-89`,
`sessionStore.ts:6-11`), and `finalizeRunTerminal` writes the row through it
before `untrackIfCurrent` (`AgentRunLifecycle.ts:157-177`); the entry is
pruned by the fiber's exit observer after that. So the entry, and
`stopReason` on it, outlives the fold of the run's `run.end`, and from the
fold on `stopFolded` answers. The `stopping` map's stated purpose, two
overlapping stops (`:164-166`), is covered the same way: `stopReason` is not
lifted at settlement.

Owner: `entry.stopReason` (already "recorded before the interrupt for its
cleanup", `:152-153`) for "a stop has begun here", the row from the fold on.
`assertAdmitsChild` reads `entry?.stopReason !== undefined || stopFolded`.

Deleted: `stopping` and its token/lift (`:164-167, 641-652, 464, 902`),
`sweepChildrenOfFoldedStop` and its call (`:756-767`,
`sessionLayer.ts:280`), `ChildLoop.userStopped` (the loop can read
`stopReason` at its end as `backgroundTurn.ts:100` does), about 70 lines.
Not deleted: `stopReason` is still not on the row (owner ruling: stop vs
shutdown stays `CANCELLED`); see R2 for what that costs `needsWake`.

### F2. Why a run cannot continue: three deciders per message, one union for all

**Landed in part in #14261 (2026-10-24):** `runRejection` is the one decider
the admission, the resume (`resumeHere`, in place of `canResume`) and the
host's run record share; `canResume` is deleted; an earlier build's rows now
refuse as `earlier_build` instead of failing the resume. Not done: `blocked`
stays the resume's alone, because `resumeBlocker` needs the catalog services
the admission's callers do not carry; the two notices for a blocked run
remain. `refusalFor` stays as the launch's own error classification, and
`executeAgent` keeps its `canResume`-shaped guard for a child its parent's
open call reattaches without a resume. Both are smaller than the audit's
estimate; the sender-side wording path is one.

Fact: "run R, with no generation here, may be resumed by this process, and
if not, why" — what a follow-up to an idle run and an explicit Resume ask.

| Decider                            | Where                             | Inputs                                                  | Produces                                                                               |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `runRejection`                     | `runClassification.ts:32-46`      | `claimStanding(log.owner)`, `deriveResumability`        | `RunRejection`: `owned_elsewhere`, `finished`, `earlier_build`; `unreadable` → `Error` |
| `Inbox.admission`                  | HEAD `Inbox.ts:299-355`           | `log.hold` (takes the claim)                            | `Refusal`: `not_resumable`, `owned_elsewhere`, `not_parent`                            |
| `resumeHere`                       | HEAD `resumeRun.ts:168-226`       | `holdClaim`, `owningCall`, `canResume`, `resumeBlocker` | `owned_elsewhere`, `finished`, `blocked`, `not_resumable`, `ownedBy`                   |
| `refusalFor`                       | HEAD `resumeRun.ts:240-263`       | the launch's `Error` by `instanceof`                    | `not_resumable`, `owned_elsewhere`, `finished`, `earlier_build`, `unusable_checkpoint` |
| `deriveResumability` → `canResume` | `resumability.ts:38-90`           | rows                                                    | 4-arm union → `boolean                                                                 | Error`(the`earlierBuild`arm becomes the`DatabaseRowEarlier`instance, recovered by`refusalFor`) |
| `resumeOnSession`                  | HEAD `ToolUseFollowUp.ts:189-237` | any failure cause                                       | collapses to `not_resumable`                                                           |

Scenario (one action, two deciders, two notices): the user sends a message to
an idle run whose agent's plugin is off. `submitFollowUp` (HEAD
`ToolUseFollowUp.ts:266-308`): `runRejection` → `null` (it does not know
`blocked`); `send` → queued, no reader; `Inbox.wake` → `port.resume` →
`startFollowUpWake` → `resumeOnSession` → `resumeHere` → `resumeBlocker` →
`{ failed: 'blocked' }`. `resumeOnSession` emits `requestShowInstruction`
with `describeFollowUpFailure('blocked')` (HEAD `:201-212`), returns the
refusal; `startFollowUpWake` maps it to `false`; `submitFollowUp` returns
`{ status: 'queued', wake: 'failed' }`; the host shows
`FOLLOW_UP_WAKE_FAILED_MESSAGE` ("could not be resumed automatically"). The
user reads two messages for one fact, the second generic, because the
admission's decider and the resume's decider have different arm sets.

Race: `runRejection` reads the claim (`log.owner`), the send takes it
(`log.hold`), `resumeHere` takes it again. Between the first read and the
send another process can take the run: the admission said "ok", the send
refuses `owned_elsewhere`. Harmless, but the first read decided nothing the
second did not decide again under the claim.

Owner: one `resumeStanding(runId, session)` run under the claim, in
`resumeRun.ts`, returning the full refusal (`owned_elsewhere` by `holdClaim`,
`finished`, `earlier_build`, `unusable_checkpoint`, `blocked`, `ownedBy`), and
`submitFollowUp` does not pre-check at all: it sends under the claim and lets
`Inbox.wake` → resume answer; the admission refuses only what the inbox
refuses (`not_parent`, closed input) plus `one_shot`. A refusal comes back
once, typed, and the host words it once.

Deleted: `runClassification.ts` (46 lines), `refusalFor`'s `instanceof` table
(HEAD `resumeRun.ts:240-263`, ~25) by having `deriveResumability` return its
union to the resume instead of collapsing in `canResume`
(`resumability.ts:72-90`, ~20), the duplicate `holdClaim` in `resumeOwnRun`'s
joiner path stays. About 60 lines and one wording path. `FollowUpFailureReason`
shrinks to what the admission can actually produce; `ResumeRefused.reason`
and `ResumeRunResult.failed` stop being `Exclude<>` views of it (see the
Reason unions section).

### F3. "Ended in its current lifecycle": five spellings, three scopes

Fact: whether run R's latest lifecycle has a `run.end`, and which.

| Spelling            | Where                                   | Scope                                                                                          |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `runEndFromEvents`  | `runRecords.ts:80-91`                   | `findLast(run.end \| run.activate)`, end only if it is the last                                |
| `heldParks`         | `runLaunchGuard.ts:191-205`             | same rule, rewritten inline for parks                                                          |
| `needsWake`         | `runFacts.ts:206-207`                   | `findLast(run.end)` alone, no `run.activate` scoping                                           |
| `Inbox.read.closed` | HEAD `Inbox.ts:46, 363-367`             | `findLast(run.activate \| followup.closed \| run.removed)`; `run.end` not a lifecycle row here |
| `sweepLeftoverRuns` | `sweepLeftoverRuns.ts:29-41`            | last `run.end` commit vs a park's commit                                                       |
| view `status`       | `sessionViewUpdate.ts:693-712, 775-783` | `run.activate` → RUNNING, `run.end` → outcome (the same rule as `runEndFromEvents`, as a fold) |

Scenario (two deciders disagree): run R was stopped by the user (`run.end`
cancelled at commit 100), resumed explicitly (`run.activate` at 110), worked a
turn and the process was killed (no `run.end` after 110). On the next open,
`runEndFromEvents` says R has no end in this lifecycle (resumable, not
stopped); `needsWake` says `stopped = true` from the row at 100, so a child's
delivery (`from.relation === 'child'` → `!stopped`) does not wake R, and a
user's message wakes it only if committed after 100 (always true, so that arm
is unaffected). The run's own interrupted-tasks follower would resume it; a
child's result landing first does not.

Owner: `runEndFromEvents`, made importable from `shared/session` (it is a pure
function over rows; `runRecords.ts` is in `agent/storage` and the view cannot
import it). `needsWake` and `heldParks` call it. `Inbox.read.closed` is a
different fact (input closed) and stays. `sweepLeftoverRuns` can use it per
aggregate.

Deleted: `heldParks`' inline `since` (~5), `needsWake`'s own `findLast` (~3),
`sweepLeftoverRuns`' `ended` map (~6). About 15 lines; the gain is one scope
rule rather than lines.

### F4. A held result was delivered: one fact, two rows, an observer in between

**Verified 2026-10-24, not built:** the caveat below fails. The cold listing
keys `followup.*` rows by `followup/<id>` and deletes the entry on the
consuming row, so a parent's consumed follow-up is in the listing only while
unconsumed; the proposed view-side rule would show every delivered interim
result as "result waiting" on a cold open, the common path. The derivation
needs the parent's aggregate rows, which only the Inbox reads today. Also:
`clearHeld` runs only in the child's owning process, so a parked child whose
process is gone is never cleared even without a crash. Options, none chosen:
(a) a parent-aggregate read of `followup.*` on listing hydrate per held
child; (b) a parent-side listing row keyed by the child that the parent's
holder can write under its own claim, read by `parkSubstate`; (c) keep the
child's park as the owner and have the child's own loop write the clearing
row on its wake instead of an observer fork. The "one commit" variant (the
delivery writes the child's plain park) is blocked by claims: a parked
child's live owner holds its claim, so the parent's holder cannot append.

Fact: "child C's turn result X, held because its parent was open elsewhere,
has reached the parent's input."

| Decider                                            | Where                                                                                                                          | Form                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| parent's `followup.queued` with `followUpId === X` | `Inbox.admission`, `deliverHeld` → `parentAdmission` (`runLaunchGuard.ts:175-252`)                                             | durable, committed with the delivery          |
| child's latest `child.park` with `heldFor`         | HEAD `childTurnResult.ts:235-253` sets it; `clearHeld` (`runLaunchGuard.ts:301-330`) clears it by writing a plain `child.park` | durable, written twice                        |
| view `substate === RESULT_WAITING`                 | `parkSubstate` (`schemas/run.ts:79-85`), `sessionViewUpdate.ts:758-760`                                                        | derived from the child's last park only       |
| `sweepLeftoverRuns`                                | `sweepLeftoverRuns.ts:29-41`                                                                                                   | `heldFor` set and no `run.end` after the park |

`onHeldResult` (`runLaunchGuard.ts:260-299`) watches the fold-gated tail for
the parent's `followup.queued`, checks the child's view substate, and forks
`clearHeld`, which reads the child's rows, compares `heldFor`, and appends the
corrective park. The second row restates the first.

Scenario (race window, then a crash): the parent's process delivers X
(`deliverHeld`), the row commits, the tail delivers it, `onHeldResult` forks
`clearHeld`; the process is killed before that transaction commits. The parent
has X in its input and will read it; the child's rows still end in a park with
`heldFor: X`, so every view shows C as "result waiting" (warning tone,
`runStatusDisplay.ts:39`), and `sweepLeftoverRuns` keeps it. It stays so until the
parent is resumed again, when `deliverHeld` re-runs, `parentAdmission` answers
`duplicate`, and `endIn` or an empty append happens to fix it. Nothing else
clears it.

Owner: the parent's row. `parkSubstate` takes the parent's `followUpIds`
(the view keeps `state.rows` per run, `sessionViewUpdate.ts:234`, whose
`followUpIds` names every id queued or consumed, `runRows.ts:116-120`):
`RESULT_WAITING` iff the last park has `heldFor` and the parent's rows do not
name it. One derived fact, no corrective write.

Deleted: `clearHeld` and the `followup.queued` arm of `onHeldResult`
(`runLaunchGuard.ts:267-272, 301-330`, ~38 lines), the `RESULT_WAITING` arm of
`sweepLeftoverRuns` reads the same rule. About 40 lines.

Caveat to verify before building: the view holds the parent's follow-up rows
only if the listing or the aggregate read delivered them (`applyEvent`,
`read === 'listing'`); if the cold listing carries no `followup.*` rows for
an unsubscribed parent, the derivation needs the aggregate read the parent's
resume already does. `deliverHeld` reads rows directly and is unaffected.

### F5. Stop-reason precedence: stated twice, oppositely, held three times

**Built 2026-10-24 (PR from `refactor/stop-reason-one-owner`):** the CLI
holds no reason; the registry entry's `stopReason` is the one holder and its
precedence the one rule. The CLI keeps two booleans, each its own fact, not
a copy: `RootRunClaim.stop` (a stop was asked of this claim's run; consumed
when the run completes or a new claim is taken) and `TuiSession.leaving`
(`/exit` or quit; stands until the run state clears, so a queued follow-up
gives up and no claim taken while leaving starts a run). A re-issued stop
sends `leaving ? 'shutdown' : 'user'`. Net −11 lines, not the −25 estimated:
`leaving` cannot be dropped, since completion must consume a Ctrl-C stop but
not a quit.

Fact: why run R is being stopped, when two stops overlap.

| Holder              | Where                                                                              | Precedence                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `entry.stopReason`  | HEAD `runRegistry.ts:771-775` `markStopped`                                        | `user` stands over a later `shutdown` ("a user reason outlives a later shutdown", `:152-153`) |
| `rootRunClaim.stop` | `packages/cli/src/chat/tui/state/sessionRunState.ts:54-55, 103-106` `standingStop` | `shutdown` stands over a later `user` ("a shutdown is never downgraded")                      |
| `let stopReason`    | `packages/cli/src/chat/chatSessionController.ts:394, 828`                          | last write wins; used to re-issue a stop in the launch gap `:411`                             |

Scenario: Ctrl-C (user) on a running turn, then a quit (shutdown) during the
unwind. Harness: `stopReason` stays `'user'`, so `backgroundTurn.ts:100`
cancels the remote operation and `endNative` queues the stop notice
(`childRunLoop.ts:744-764` HEAD). CLI: `claim.stop` becomes `'shutdown'`,
which `markRunPending`/`markRunCompleted` carry into the next claim
(`sessionRunState.ts:128-133, 152-160`: "a shutdown carries into every claim
taken while leaving"), and `let stopReason === 'shutdown'` is what a stop
re-issued in the launch gap sends (`chatSessionController.ts:411`). The
reverse order (quit, then Ctrl-C lands) gives the harness `'shutdown'` kept
by `markStopped`'s rule only if `'user'` was not first; the CLI keeps
`'shutdown'` either way. Same event, two remembered reasons, two precedence
rules.

Owner: the registry entry, read through `LiveRun.stopReason` (already on the
shape, `runs.ts:34` HEAD). The CLI keeps `stop !== null` as a boolean for its
exit code and drops the reason copies; a re-issued stop sends the reason of
the key pressed, not a remembered one.

Deleted: `standingStop` and the `stop` field's reason (`sessionRunState.ts`,
~12), `let stopReason` (`chatSessionController.ts:394, 828`, ~4), about 25
lines with the comments that explain the precedence.

### F6. Smaller instances, same species

- **`Resumes.inFlight` restates `Resumes.running`** (HEAD
  `ToolUseFollowUp.ts:119-120, 147-154`): a `Set` and a `Map` keyed the same,
  added and deleted together; `Inbox.wake` (HEAD `Inbox.ts:217`) reads the
  set. `running.has(runId)` behind a method. 5 lines.
- **Host re-gates what the harness gates.** `runActionGuard.require`
  (`packages/texra/src/controllers/session/runActionGuard.ts:32-40`) checks
  `run.actions.includes(action)` with `runActionRefusal`; `SessionRequests.
requireRunAction` (`SessionRequests.ts:119-135`) checks the same for every
  gated request. `hostRunActions.ts:702, 709` guards `files` and then sends
  `run.files` (`:712`), which the harness gates again. `resume`/`runNew`
  (`:389`) reach `session.resume` which is not request-gated, so that
  `require` is the only check there. Two deciders for the request-routed
  actions, with the view snapshot read at two moments. 10 lines on the host.
- **`runActionGuard.resuming` vs `Resumes`.** The host refuses a second
  Resume ("already resuming", `runActionGuard.ts:24-27, 43-53`); the harness
  joins it (`Resumes.once`, HEAD `ToolUseFollowUp.ts:130-159`,
  `resumeOwnRun` HEAD `resumeRun.ts:129-154`). A resume the harness started
  itself (a wake, `followInterruptedTasks`) is not in the host's set, so a
  user's Resume during it is admitted by the host and joined by the harness:
  the host's rule applies only to its own clicks. Two answers to "may a
  second resume start" for one run. 15 lines.
- **`isChildResult`** (`terminalResultToast.ts:30-35`) re-implements
  `parentOf`'s fallback order (handle first, then view) in the opposite order
  the registry uses (view first, `runRegistry.ts:311-318` HEAD). Same answer
  today; two statements. 6 lines.
- **`sweepLeftoverRuns.runningRuns`** (`sweepLeftoverRuns.ts:14-21`) is a
  third "is it running" rule: registry entries ∪ any run with an in-flight
  phase. A background shell whose owner process died while RUNNING has an
  in-flight phase, an `interrupted` group in the view, no entry here: the
  view says interrupted, the sweep says running, and keeps it forever. The
  one rule is `isLiveRun(run) && run.ownedHere` or the registry.

## Reason unions

| Union                                                     | Arms                      | Producers                                                                                                                                                            | Readers                                                                       | Note                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FollowUpFailureReason` (HEAD `ToolUseFollowUp.ts:32-41`) | 9                         | `runRejection` (3), `Inbox` `Refusal` (3), `submitFollowUp` (`one_shot`, `not_resumable`), `resumeHere` (`blocked`, `finished`, `owned_elsewhere`), `refusalFor` (5) | `describeFollowUpFailure` (one table), `presentFollowUpResult`, every host    | One union, four deciders; the admission can produce five of nine, the resume six of nine, two overlap.                                                                                                                                                                                                                                |
| `ResumeRunResult.failed` (HEAD `resumeRun.ts:49-64`)      | `Exclude<…, 3>` = 6       | `resumeHere`, `refusalFor`, `REFUSED`                                                                                                                                | `resumeOnSession`, `startFollowUpWake` (reads only `started`/`delivered`)     | A view of the union above.                                                                                                                                                                                                                                                                                                            |
| `ResumeRefused.reason` (HEAD `errors.ts:58-65`)           | same `Exclude`            | the SDK surface over `ResumeRunResult`                                                                                                                               | embedders, `hostRunActions.ts:641` (branches on `blocked` only)               | A second view of the same union; the doc comment lists five, the type allows six.                                                                                                                                                                                                                                                     |
| `RunRejection` (`runClassification.ts:26-29`)             | 3                         | `runRejection`                                                                                                                                                       | `submitFollowUp`                                                              | Arms chosen to coincide with the union above by name; the mapping is `rejection.kind` as is.                                                                                                                                                                                                                                          |
| `ResumabilityDecision` (`resumability.ts:19-23`)          | 4                         | `deriveResumability`                                                                                                                                                 | `canResume` (flattens to `boolean \| Error`), `runRejection` (maps 2 arms)    | Round trip: `earlierBuild` → `DatabaseRowEarlier` instance → `refusalFor` `instanceof` → `'earlier_build'`.                                                                                                                                                                                                                           |
| `Inbox` `Refusal` (HEAD `Inbox.ts:95`)                    | 3                         | `admission`                                                                                                                                                          | `submitFollowUp` (`sent.reason`), `deliverIn` (`owned_elsewhere` → `heldFor`) | Fine on its own; its arms are copied into the nine.                                                                                                                                                                                                                                                                                   |
| `RunStopReason` (`runtimeRequest.ts:32-34`)               | 2                         | hosts                                                                                                                                                                | registry, child loop, background turn, CLI                                    | Lost at the row: `run.end` records `cancelled` for both. `needsWake` then reads "`cancelled`" as "the user's Stop" (`runFacts.ts:192-200, 206-207`), so a shutdown's end gets the Stop rule (a child's delivery does not wake a run the process closed). Owner ruling keeps one outcome; the reader should then not infer the reason. |
| `RUN_OUTCOME` / `RUN_PHASE` / `RUN_LIFECYCLE_READY`       | 3 / 5 / +1                | the fold                                                                                                                                                             | everything                                                                    | One vocabulary, fine.                                                                                                                                                                                                                                                                                                                 |
| `ResumeRunResult.outcome`                                 | `RunOutcome \| 'waiting'` | `resumeQueuedToolUse`                                                                                                                                                | hosts                                                                         | Two vocabularies in one field (an outcome, or a phase).                                                                                                                                                                                                                                                                               |
| `RequestError` (`Unavailable`/`NotOwner`/`Rejected`)      | 3, with `reason: string`  | `SessionRequests`                                                                                                                                                    | hosts                                                                         | Wraps the unions above as prose; the `followUp.send` arm wraps `describeFollowUpFailure` (`SessionRequests.ts:414-421`), so a host cannot branch on the reason it already had typed.                                                                                                                                                  |
| `ToolError`                                               | n/a                       | —                                                                                                                                                                    | —                                                                             | No reason union; `toolResult.ts` carries a status, not reasons. Rejected as a candidate.                                                                                                                                                                                                                                              |

Answer to "why so many different reasons": `FollowUpFailureReason` is the
union of the vocabularies of four deciders that each answer a different
question (can I write a row; can this process resume; what did the launch
throw; what does the host say), joined because one wording table serves them
all. Each decider produces a subset, each reader `Exclude`s a different
subset, and the resume path converts its own union to `Error` instances and
back so the reasons survive `canResume`'s boolean. The cure is F2: one decider
for "can this process resume R, and why", producing its arms directly, and an
admission that refuses only what the admission knows.

## Why the ratchets miss this

What `scripts/check-core-quality.mjs` and `config/ratchets/` measure
(`core-quality-measure.mjs:73-140`, `check-core-quality.mjs:152-159`):

- Per file, counted: `any`, `!`, `as`, missing boundary types, undocumented
  exports, `file-size` (400 lines), `complexity` (15), `max-depth` (4),
  `max-lines-per-function` (150), `new Promise`, `.then`, `Effect.run*`,
  `try/catch`, silent degradation (`catch {}`, `.catch(() => v)`,
  `orElseSucceed`, `ignore`), non-erasable syntax.
- Per module: `import-cycles`, `wide-records` (members > 20 on an exported
  class or `Context.Service` shape), `pass-through` (forwarding functions),
  `shallow-modules` (interface elements vs lines).
- Per package: `entry-files`, `entry-externals`, `ranged-dependencies`,
  `missing-readme`, `durable-invariants` (README numbers I1.. and a test
  cites each), `core-module-mocks`.
- Edges: `architecture-edges-baseline.json`, `harness-deep-import-baseline.
json`, `subsystemEdgeRatchet`, `dependencyDirection` (which directory may
  import which); `runRegistryAccessRatchet` and `runLaunchDoorRatchet` (which
  files may name `RunRegistry`/`registryOf`, and which forks are not
  launches); `storedShapeBoundary`, `persistenceWriteBoundary` (one writer of
  SQLite, one codec of stored shapes); `stepBoundaryRatchet` (one author of
  `tools.offered`); `unknownErrorChannelRatchet`.

Every one of these is a property of one file, one function, one module's
export list, or one import edge. None is a property of a _fact_. Each of the
five findings above is spread over files that individually pass every rule:
`markStopped` is 5 lines; `stopping` is a private field; `needsWake` is
documented, typed and under complexity 15; `clearHeld` has a TSDoc comment and
logs its failure; `refusalFor` is a tidy table. The `persistenceWriteBoundary`
ratchet holds "one writer of the store", and `stepBoundaryRatchet` holds "one
author of `tools.offered`": those are the only two rules of the form "one
owner per fact", and each covers one named fact. Nothing counts how many
files decide "is R stopping", read `run.end` to answer "has R ended", or
construct a `{ failed: … }` value. The `wide-records` rule looks at the width
of a shape, not at how many shapes carry the same field (`stopReason` sits
on `RunEntry`, `LiveRun`, the CLI claim and a `let`). The "deep modules" bar
measures lines per interface element, which rewards a small helper that
restates a rule as much as it rewards the rule's home.

Also: the in-memory copies that restate rows are not `vi.mock`s, `any`s or
`catch {}`s; they are `private readonly x = new Map()` fields with good
comments, and nothing in the ratchets reads a field's comment against the row
it duplicates. The one architecture doc on the subject
(`2026-09-20-single-owner-liveness-and-one-fold.md`, "one in-process record
per run") was satisfied by making `RunEntry` the one record, and the
duplicates then grew as fields _on_ that record (`stopReason` beside
`stopping`) and as derived caches elsewhere (`unbornDetached`, `userStopped`,
the CLI claim), which the rule's wording does not forbid.

A cheap check that would surface this species (described, not built):

1. **Readers per row type and view field.** A script over the TypeScript AST
   that, for each `SessionEvent` type literal (`'run.end'`, `'child.park'`,
   `'followup.queued'`) and each `RunView` field (`status`, `parentId`,
   `substate`), lists the files that read it outside `runRows.ts` /
   `sessionViewUpdate.ts`, and holds the count per row type as a shrink-only
   baseline. `'run.end'` today: `runRecords.ts`, `runLaunchGuard.ts`,
   `runFacts.ts`, `Inbox.ts`, `sweepLeftoverRuns.ts`, `sessionViewUpdate.ts`.
   Any new reader of a lifecycle row outside its one reducer is a new decider.
2. **Deciders per named fact.** A short list in `config/ratchets/` of fact
   names, each with the one symbol that owns it (`stopReason` →
   `RunRegistry.markStopped`; `resumeStanding` → `resumeRun.ts`; `parentOf` →
   `RunRegistry.parentOf`), and a grep-level check that no other file
   assigns a field of that name or constructs a value of that union's type
   (`{ failed: '…' }`, `{ kind: 'owned_elsewhere' }`) outside the owner. This
   is `stepBoundaryRatchet` generalized from one fact to a table.
3. **Same-name fields across shapes.** Flag a field name that appears on more
   than one exported record or class in the harness with the same type
   (`stopReason: RunStopReason` on three shapes; `launchParent` on two). Most
   hits are copies of one fact.

## Rejected candidates

Checked and not a double decision or race; listed so they are not re-opened.

- **`RunView.readOnly` / `ownedHere` vs `log.owns` vs `claimStanding`.** One
  source (the SQLite claim) read through the view's existence markers
  (`reconcileExistence`) or directly; the view lags but states no second
  rule. `requireRunAction` skipping a `heldElsewhere` run for `admit`'s fresh
  probe (`SessionRequests.ts:127-134, 158-174`) is deliberate layering, not a
  second verdict.
- **`isLiveRun` (view) vs `LiveRun.live` (registry).** Different facts: "some
  process holds it and it did not end" vs "a generation runs in this
  process". `followInterruptedTasks` combines both with the claim on
  purpose (`interruptedTasks.ts:130-144`). The design doc already lists the
  three "live here" predicates in the input chain.
- **`parentOf`'s fallbacks and `unbornDetached`.** The view's `relink` nulls a
  parent the view does not hold and `persistedParentRunId` nulls a parent
  with no records: the same outcome for a removed parent. `unbornDetached`
  patches a real durable gap (no row to cut before `run.start`) and is
  cleared with the entry; the only cure is a stored shape (a detach row on
  the parent), which the owner's rules weigh against. No disagreement shown.
- **`requestAnswerability` (view) vs `decideRequest`'s inline rule**
  (`sessionView.ts:291-299`, `SessionRequests.ts:239-246`). Same inputs
  (claim held here, request parks its caller), both derived from the DB
  claim; the request handler re-reads because the view lags. Two statements,
  one source; no scenario where they answer differently and both act.
- **`claimHolds` count in `sessionStore.ts:150-200` vs the SQLite claim.** A
  refcount for nested holds in one process; the DB holds the claim. Inherent,
  as the 2026-09-20 doc's "what stays" lists.
- **`Inbox.readers` vs the registry's fiber.** Different facts (a reader is
  open; a generation is live); the design doc's wake already reconciles them.
- **`RunState` vs the view.** Both folded from the same rows through
  `applyRunRow`; that is the one-fold design, working.
- **`resumeBlocked` local state.** One writer (`markResumeBlocked`), one
  reader path (`LocalRuntimeState` → view). Not held twice.
- **`ChildLoop` flags (`turnIndex`, `consumed`, `end`, `failure`).** Loop-local
  working state for one fiber; `child.turn` rows record the durable half and
  `readChildTurnState` reads them back only on resume. No second decider.
- **`ToolError` reasons.** No reason union exists (`toolResult.ts` is a
  status); nothing to merge.
- **`detachSubagentsOnStop` read at two sites.** One reader of one setting,
  resolved once per request; the two explicit call sites declare a value
  rather than re-deciding.
- **Compaction / context edits.** `compactingActive` is transcript-derived in
  one place; the `/compact` request is one control row read by
  `RunInput.controls`. The design doc already names the one direct inbox read
  in `toolUseDispatch.ts:1106`.
