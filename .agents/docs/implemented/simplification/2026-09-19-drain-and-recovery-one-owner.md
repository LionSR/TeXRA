# Drain and recovery: one owner per fact

Status: implemented

Date: 2026-09-19
Baseline: `origin/main` at `ca4e74a597`, after wave 5 of the Effect round-trip
campaign. Landed as eight PRs, #12848 through #12855, on top of wave 6.

## What this wave was

Wave 7 was not a round-trip wave. The round-trip campaign had already made the
settlement, shutdown and resume paths Effect programs; what it left behind was
duplication inside those programs. The same fact had two or three owners, and
the copies had drifted.

Before: the session drain answered "is this settled?" with two publication
barriers, two close budgets and three copies of one drain loop, and the third
copy was the one without the re-check arm, which is why closing a desktop
project could strand on the last run that left. The CLI log plane had two
write paths that produced identical bytes and two flush owners for one FIFO
lane. The desktop main process kept its own `shutdownStarted` flag beside
`LifecycleHost.runShutdown`'s own join-once contract, and its sign-in attempt
carried a rewritable settle hook that forced the waiting variant to thread a
callback and two mutable locals. Three ports carried a member that mirrored
another member or had no reader at all. The headless `texra run` exit path
spelled one resume question three ways and let a shutdown-finalization notice
claim the run's failure presentation, so a run that both failed and failed to
finalize printed only the finalization notice. The agent-CLI launch path
hand-rolled the guard-and-trace choreography that `startDetachedChildRunLoop`
already owned. The resume surface mirrored its identity three ways: a
fault/outcome axis nothing read, a partial lookup table with an unreachable
arm, a snapshot every resumed child turn read twice, and three copies of one
claim ladder. The two run loops carried three branches that could not fire.

After: one publication barrier, one close budget, one drain wait, one write
path, one flush owner, one settle hook, one run guard per question, one resume
identity, one classification, one snapshot read, and one claim standing. The
desktop stall is fixed as a side effect of the drain becoming shared.

## The eight PRs

- **#12848**, refactor(agent): delete three provably-inert branches in the run
  loops. A follow-up-wait block whose outer disjunct and inner negation cancel,
  two open-coded `Ref.set(latest, …)` writers beside the `commit` helper that
  exists for that write, and an always-false supersession conjunct in
  `runWorkflowScript`'s attempt loop. No row, no order, no timing changes.
- **#12849**, refactor(cli): give the CLI log plane one write path and one
  flush owner. `guardedStreamWrite` and its constant `onSettled` parameter go,
  `writeRaw` stops consulting the runtime slot, `LogSink.flush?()` and the
  duplicate flush in `close()` go, and `LogSink` stops being exported.
- **#12850**, refactor(desktop): one owner for the quit drain and the sign-in
  outcome. `shutdownStarted` is deleted so a second before-quit joins the drain
  in flight; `DesktopAuthAttempt.settle` becomes a `readonly outcome` Deferred
  the attempt mints with itself, so `startSignIn` returns the attempt it
  claimed and the waiting variant is one `flatMap`; `signOut` folds
  `onSessionChanged` into the program it already runs.
- **#12851**, refactor: delete the dead and doubled port members.
  `LoopbackCallbackServer.sessionSettled` was `Effect.asVoid(waitForSession)`
  over the same Deferred; `LeanServer.isRunning` had no reader anywhere; and
  `ToolEditApprovalController.admit` and `.buildDisplayFor` spelled one join
  registration twice, now `track(entry)` returning the withdrawal.
- **#12852**, refactor(cli): one resume-advertise predicate and one
  presentation claim in the headless exit path. Three inline spellings of the
  checkpoint-advertise question become `advertisesInterruptedRun`, two
  `Extract<…>` restatements become `ResumableCheckpoint`, two unreachable
  guards go, and `reportFinalizationFailure` presents on `presentationHost`
  directly so it stops claiming the run's own failure presentation.
- **#12853**, refactor(tools): launch agent-CLI children through the shared
  detached-child primitive. `startAgentCliLoop` and the hand-rolled launch
  guard go, `childRunLoop` keeps one abort-race spelling, `budgeted: false` is
  passed explicitly beside the same comment `bash.ts` carries, and the two
  adjacent agent-CLI shutdown sweeps become one.
- **#12854**, refactor(agent): one resume identity, one classification, one
  snapshot read. The `fault`/`outcome` axis is deleted, `RESUME_BY_CATEGORY`
  becomes one exhaustive table so a new agent category fails to compile,
  `resumeToolUseTurn` takes a `ResumeTurnIdentity` instead of a whole
  `ToolUseResumeData` it was re-reading, the tautological `willLaunch` and its
  unreachable tail go, and `claimStanding(claim)` answers the claim question
  once for all three readers.
- **#12855**, refactor(session): one publication barrier, one close budget,
  one drain wait. `TrackedPublication.settled`, `aborted(signal)`, five
  `signal?: AbortSignal` parameters, `untilSettled(runs)`, one of `settleTo`'s
  two sequential `Stream.runHead` waits and the desktop's hand-rolled `for(;;)`
  drain loop all cease to exist; `RunRegistry.awaitDrained()` is the one drain
  wait, with three callers. Carries the `stopProjectRuns` stall fix as its own
  commit.

## Rulings taken

- **Keep the per-run retention set, delete only the second Deferred.** The
  publication path keeps its retention `Set` and its `consume` semantics, and
  the interrupt-time cancellation detach stays inside the drain. The surviving
  barrier was shown to cover the pinned case first: the handle's job runs
  strictly inside the plane's job, so a failed publication's cause is recorded
  before the plane's Deferred completes, and `graph.settle` awaits that.
- **Drop the unused `signal` from the SDK close chain**, `packages/agent`
  included. No external consumer exists, and the surface change is stated in
  the PR. Cancellation on that path is fiber interruption.
- **Ship the desktop `stopProjectRuns` stall fix in the same PR**, as its own
  commit, rather than filing it. It is the defect the third drain copy caused,
  so it lands with the copy's deletion.
- **Accept the visible stderr change on a double failure at CLI exit.** A
  headless run that both fails and hits a shutdown-finalization failure now
  prints its classified `AgentError` message as well as the finalization
  notice. Today the notice silently suppresses it, which is the
  silent-degradation rule applied. No other path changes what it writes and no
  exit code moves.
- **`ClaimStanding` lives beside the claim type**, in
  `src/shared/session/database.ts` next to `AggregateClaim`, not inside either
  liveness ladder, because the third reader is `resumeRun`. The two ladders
  keep their own, deliberately opposite, orderings.
- **Accept the shared child-loop primitive's interrupt channel.** An interrupt
  landing once the agent-CLI child stream exists now re-raises as an interrupt
  into the calling tool fiber instead of being squashed into
  `AgentCliCallFailed`. No catch-and-squash was added at the call site, because
  that would reintroduce the divergence the lane removes; typed failures still
  re-tag and defects still reach `BaseTool` as defects.
- **Skip the halt-row helper.** The shared row-write-and-warn extraction for
  the two loop finalizers was estimated at about eight lines, and #12767
  already owns exactly that extraction against the same two files. A second
  version would be the duplicate-convergence failure mode.

## Refuted, so nobody re-mines them

- **`SessionEvents.detach`'s `tapCause` is not a duplicate of
  `SessionHandle`'s.** The handle's job ends in `Effect.exit`, so the outer
  effect never fails and the plane's `tapCause` never fires for a handle
  publication. It fires only for a follow-up job's defect and for a direct
  `events.detach` caller, and with `settle` no longer aggregating it is the
  only loud channel for those. Deleting it would be a silent swallow.
- **`AgentCliSessionRegistry.release` is not a rename of `releaseByRunId`.**
  `release` settles a reservation's `ready` Deferred through
  `settleReservation`, which `releaseByRunId` cannot do, because a reserved id
  has no `runId` yet. Two of the six call sites release reservations rather
  than registrations and would have to be rewritten onto captured `claim()`
  handles; the other four would each need a `runId` in hand. Three suites
  churned and one test intent weakened, for five production lines.
- **Folding `collectReviewDiff` into the Effect tree stays refuted.**
  `AgentReviewService.executeReview` is itself a Promise method and nothing
  lifts the collection's result back into Effect, so there is no round trip to
  close. The measurement is #12802's: wrapping `simple-git` once inside
  `reviewDiff.ts` deletes zero lifts, adds two runs and costs +43 lines against
  a predicted -6. Retry only when `executeReview` is itself a program.
- **The fiber-interruptible child loop.** Refuted in the survey on
  first-terminal-outcome arbitration and on `interrupt()` being a synchronous
  non-Effect port method. `AbortController`, the `signal` parameter,
  `bindAbortSignals` and the `Effect.uninterruptible` regions in
  `src/agent/runtime/childRunLoop.ts` all stay, and two of those
  `AbortController` residents are the ones the ratchet names as permanent.
- Smaller ones the lanes recorded: sharing one level stream between `settleTo`
  and `folded` (they cannot be the same value without either hanging a settle
  or ending the hosts' live folded tail); tightening
  `SessionEventsShape['detach']`'s job error channel to `never` (left as a
  lead, because a kernel suite hands it a raw `append`); folding the two
  `deriveResumability` probes into one (three questions at three instants);
  and `resumeRun`'s own `retrieveSessionResumeData` call, which asks a
  different question before the run lease is spent.

## Left behind as leads

- `packages/desktop/src/main/desktopProjects.ts`'s `stopProjectRuns` kill sweep
  is byte-for-byte `sessionLayer.closeSession`'s. With the drain now shared,
  the sweep is the remaining copy; it differs only in error channel, so a
  `RunRegistry.stopAll()` returning the settlements would leave each caller its
  own channel.
- `settlePublications`'s docstring is about 35 lines for a 20-line body, and
  three of its paragraphs now restate the same rule. A prose pass.

## Related

- [`2026-09-17-effect-round-trips-and-dual-systems.md`](../../proposed/simplification/2026-09-17-effect-round-trips-and-dual-systems.md)
  is the campaign ledger this wave follows.
- [`2026-09-19-broad-survey-wave-8.md`](./2026-09-19-broad-survey-wave-8.md) is
  the wave that followed.
- [`2026-08-01-architecture-rulings-ledger.md`](../architecture/2026-08-01-architecture-rulings-ledger.md)
  carries the rulings above that constrain future work.
