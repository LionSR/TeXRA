# A run's consumer is its claim holder

Status: proposed, 2026-09-28. Design only; no code until this is read.
Follows #13468, which moved the last in-memory follow-up holds onto the
`followup.queued` row.

## Where things stand

A run's pending input is already durable. Each follow-up is a
`followup.queued` row, admitted as one `exclusive` job on the session's
`SessionEvents` publisher and consumed by a `followup.consumed` row that
commits with the message it became. A take reads the pending rows through the
publisher's fold. `RunInput` keeps no copy of them: it is a wake latch plus the
loop's synthetic maintenance turn.

What `ToolUseFollowUpQueue` (`src/agent/followUp/ToolUseFollowUpQueueManager.ts`,
about 710 lines) still owns is **who may consume**. It does this through a
second ownership record kept beside two that already exist:

| Record              | Where                                                         | Says                                                                                                                                |
| ------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| DB claim            | `claim` table, `SessionHandle.holdRunClaim` / `acquireClaims` | which process may append to the run aggregate; refcounted holds, released by the last one                                           |
| `RunRegistry` entry | `runRegistry.ts` `RunEntry`                                   | whether this process runs the run: `fiber` (a generation), `hold`, `handle`, `activation` (a native child loop), `lane`, `launches` |
| Follow-up lease     | `QueueEntry.owner`                                            | which in-process consumer (`loop`, `child`, `recovery`) may take the run's input                                                    |

The lease duplicates the other two. A `loop` lease exists exactly while a
generation's fiber runs the tool-use loop (`claimFollowUps` in `FollowUps.ts`,
scoped to that fiber). A `child` lease exists exactly while the registry holds
the child's `activation` (`startChildRunLoop`). A `recovery` lease is "the claim
is held, and no fiber is running yet". The lease adds three pieces of state
that the other records would have to carry if the lease went away:

1. **`adoptedClaim`.** When an admission to an unowned run took the DB claim
   for a recovery owner that has not launched, the claim's release belongs to
   that owner. Either the consumer that attaches gives it back, because its own
   hold now keeps the claim, or the lease releases it when it exits unlaunched.
   While that release runs, `releasing` keeps the entry owned by a lease nobody
   holds, so no successor claims the run and acquires a DB claim that is about
   to be dropped.
2. **`pendingRelease`.** Admissions are serial jobs on the publisher. A
   release or `terminalize` that arrives while an admission for the run is in
   flight is applied when that admission settles. An admission that committed
   rows keeps the run recoverable even if a `terminal` release was pending, so
   a committed row is never left behind for a consumer that already left.
3. **Tombstones** (`terminalized`, bounded to 500). A run ended by
   `terminalize` (deleted, or its parked run torn down) refuses non-owner
   admissions, so a child whose activation outlives its parent's teardown
   cannot revive the parent. Only an explicit claim reopens it.

It also exposes `onRelease`, which `RunSubscriptionRegistry` uses to drop a
run's GitHub bindings when its entry ends.

## One authority

The consumer of a run's input is **whoever this process has running the run**,
as the `RunRegistry` entry records it. The DB claim is that entry's durable
side.

- **`loop`.** The generation's fiber (`entry.fiber`), which already holds the
  DB claim through `holdRunClaim`. The registry's `admit` already refuses a
  second generation with `RunLive`, so the lease's exclusivity check is
  redundant.
- **`child`.** The child loop's `activation` (`entry.activation`), which
  `reserveChildActivation` already makes exclusive.
- **`recovery`.** An entry with `hold` set and no `fiber`. The registry
  already has the `hold` arm. An admission to an unowned run takes the DB claim
  and records it as the entry's `hold`, instead of as a lease's
  `adoptedClaim`. The launch that follows (`resumeRun` → `Runs.launch`) adopts
  the hold when its fiber writes `entry.fiber`. If no launch comes, releasing
  the `hold` releases the claim, and the entry lives exactly as long as that
  release.
- **Input.** The `RunInput` latch hangs off the registry entry, created by the
  first taker. `attachInput(runId, lease)` becomes `Runs.input(runId)`, which
  is valid only from the fiber or activation the entry names. Admissions wake
  it through the entry.
- **Tombstones.** These become a fold fact. A run whose aggregate carries
  `run.removed`, or whose tear-down wrote its terminal row with the queue
  ended, is refused by admission because its folded state says so, not because
  of an in-memory set. This also removes the 500-entry bound and its eviction
  caveat ("callers must revalidate persisted authority").
- **Observers.** `onRelease` becomes the registry's existing entry-deletion
  point (`drains`, `awaitDrained`). `RunSubscriptionRegistry` subscribes there.

## The invariants that have to survive

**Release ordering.** An admission is one publisher job. Today the job flips
`admitting`, and any release that arrives meanwhile waits in
`pendingRelease`. Under the registry:

- The admission job reads the entry state when it starts.
- A release that arrives mid-job is a registry transition: `fiber` exits, or
  `hold` is released. The job observes it after its rows commit, because the
  job re-reads the entry before it wakes anyone. That is the same "decide
  after the rows commit" point the manager uses today (`current`).
- The rule that a committed row keeps the run recoverable becomes: after an
  admission commits rows to a run whose entry is gone, the job leaves a `hold`
  only if the run is resumable. Otherwise the rows wait, durably, for the next
  resume, which reads them from the fold.

**Adopted claim.** The claim an admission takes for a not-yet-launched run is
the entry's `hold`: one refcounted DB hold, owned by the entry, never by a
caller.

- A launch that adopts it takes one more hold of its own and then releases the
  entry's.
- A lease that exits unlaunched releases it.
- The window the manager covers with `releasing` is covered by the entry's
  existence: the entry is deleted only after the hold's release effect has
  run. The registry already deletes entries only when every field is gone
  (`RunEntry`, "the entry exists exactly while one of its fields does").

**Recovery with the claim held and no fiber yet.** This is the `recovery`
lease's case, and it is exactly `hold` without `fiber`.

- `resumeRun`'s `claimRecovery` / `useRecovery` become "take or join the
  entry's hold".
- `startFollowUpWake` passes the run id, not a lease.
- `releaseUnstartedRecovery` becomes "release the hold". It still decides from
  the rows (queued input, or an unreadable fold) whether the run stays
  recoverable. "Terminalize" becomes writing nothing, because the fold already
  reads an empty, ended run as ended.

## What gets deleted

- `ToolUseFollowUpQueue`'s ownership half: `FollowUpConsumerLease`,
  `FollowUpRecoveryLease`, `QueueEntry` (`owner`, `admitting`,
  `pendingRelease`, `adoptedClaim`), `releasing`, `claim` / `claimLive` /
  `claimChildRun` / `claimRecovery` / `useRecovery`, `release`,
  `terminalize`, `terminalized` and `TERMINALIZED_CAP`, `onRelease` and
  `releaseObservers`, `hasLiveOwner`, `releaseAdoptedClaim`, `applyRelease`,
  `finishTerminalize`.
- Admission (`submit`, `submitBatch`, `withdraw`, the replay check and
  `takeable`) stays. It is about 200 lines and moves to a small `RunInbox`
  module, or into `SessionEvents`' follow-up slice.
- Every lease parameter: `resumeRun` (`queueLease`, `recovery`),
  `childRunLoop` (`queueLease`, `params.queueLease`), `startFollowUpWake`,
  `resumeOnSession`'s `recovery`, `PendingChildDelivery.recovery`, and the
  `lease` in `FollowUpSubmission`'s `queued` arm.

Estimate: about −450 production lines against about +80 of registry
transitions. Call sites: about 50 across `resumeRun.ts` (13), `childRunLoop.ts`
(6), `ToolUseFollowUp.ts`, `FollowUps.ts`, `tools/approval/index.ts`,
`tools/delegation/childRun.ts`, `RunSubscriptionRegistry.ts`, the workflow
script runner and trace helpers.

## Tests that guard it

These suites use the lease API directly, or depend on its ordering. They must
stay green, with assertions unchanged except where an assertion names the
lease API itself; those are rewritten to the registry state they stand for.

- `src/test-kernel/agent/followUp/ToolUseFollowUp.vitest.ts`: admission
  statuses, replay suppression, release-during-admission, tombstones and their
  eviction, the #8093 held delivery for each consumer kind.
- `src/test-kernel/agent/runtime/resumeRun.vitest.ts`: recovery claimed before
  I/O, refusal paths, `releaseUnstartedRecovery`, the root and child resume
  branches.
- `src/test-kernel/agent/runtime/ChildRunLoop.vitest.ts`: the child activation
  as consumer, recovered children, terminal release.
- `src/test-kernel/tools/NativeSubagentProductionPath.vitest.ts`: production
  delivery, recovery and replay across child and parent.
- `src/test-kernel/agent/followUp/ToolUseWait.vitest.ts`: the loop's
  `claimFollowUps` lease and parked input.
- `src/test-kernel/agent/runtime/SessionScope.vitest.ts`,
  `DelegationHeadless.vitest.ts`, `BashTool.vitest.ts`,
  `ExecutionsToolWorkspaceFiles.vitest.ts`,
  `GitHubSubscriptionProgressEvents.vitest.ts` (`onRelease`),
  `ToolUseFollowUpProgressEvents.vitest.ts`, `RetryState.vitest.ts`,
  `UsageLogService.vitest.ts`.

**E2E.** Each of these runs with a real CLI and a kill between admission and
consumption:

- a follow-up to a parked root;
- a follow-up to a stopped root (its recovery hold, then resume);
- a child result to a parked parent;
- a held child result (#13468's case).

Each must be taken exactly once, in order.

## Risk

- **Claim refcounting.** The manager's `adoptedClaim` hand-off is the subtle
  part. A wrong hold count either drops the DB claim under a running
  generation, where the next append fails with `DatabaseNotOwner`, or leaks
  it, and the run then reads as held by this process. The registry transition
  must take the launch's hold before it releases the entry's, in one
  synchronous step on the entry.
- **Admission against a vanishing entry.** Moving the "decide after commit"
  read onto registry state needs the same no-yield window the manager keeps
  today. The job reads the entry, then wakes or releases, with nothing yielding
  in between.
- **Tombstones as a fold fact.** Today a torn-down parked run is tombstoned
  without writing anything. The fold needs a fact to read instead. The run's
  `run.end` with its queue terminal is the candidate; the tear-down paths that
  call `terminalize` today have to be checked for one.
