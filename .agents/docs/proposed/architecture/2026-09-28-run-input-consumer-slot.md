# A run's input has one consumer slot

Status: proposed, 2026-09-28, revision 2. Design only; no code until this
is read. Follows #13468, which put the follow-up holds on the
`followup.queued` row (`holdUntil`), made the take rule row-only
(`ToolUseFollowUpQueue.takeable`), and woke a waiting take when a sender's
terminal row folds.

Revision 1 proposed making the `RunRegistry` entry the consumer, backed by
the DB claim. Review found that its premises were wrong. Each finding below
is now a constraint, and the mechanism changed to fit it.

## Corrected premises

1. **There is no `claim` table.** Ownership is `event_sequence.owner_id` (one
   process per aggregate, checked on every append). Inside a process, holds
   on it are the `claims` `RcMap` in `sessionLayer.ts`. Its lookup runs
   `acquireClaims` and hydrates the aggregate's pending follow-ups. Its
   release gives the claim back when the hold was `taken` or `ended`. Neither
   record names a consumer within the process.
2. **`claimRecovery` does not take the DB claim.** It only reserves the lease.
   The claim is taken by an admission (`writeRows` → `acquireClaim`) when no
   live consumer holds it, and is kept as `adoptedClaim` for a recovery owner.
3. **`entry.fiber` and `entry.activation` don't prove the claim is held.**
   `RunRegistry.admit` registers the generation (`launches`, then `fiber` as
   the fiber's first step) before the run program acquires the claim
   (`holdRunClaim`, inside the launch guard or ledger acquire).
4. **A child activation outlives its input consumer.** The activation covers
   preparation and final delivery (`reserveChildActivation` → release after
   the terminal delivery). The child's input lease is released earlier, at
   `release(queueLease, 'terminal')`.
5. **`reserveChildActivation` is not exclusive.** A second reservation for a
   run that already has one returns a no-op release instead of refusing.
6. **The registry's `hold` arm is taken.** It is the inactive-run hold
   (`borrowRunClaim`, `setFiber(..., 'hold')`), and `isLive` counts it. A
   recovery hold kept there would make `resumeQueuedToolUse`'s own `isLive`
   pre-check refuse the resume it is meant to enable.
7. **Tombstones need their own persisted fact.** `terminalize` ends a run's
   queue for two reasons: the run was deleted, or its parked run was torn
   down with nothing queued (`releaseUnstartedRecovery`). The second case has
   no terminal row. `run.end` can't express "this run's input is closed",
   because a run that ended can still be resumed with user input.
8. **`takeable` exists as of #13468.** Revision 1 named it before that PR
   landed.

## What stays and why

**The in-process consumer record stays.** Nothing else identifies which
consumer inside a process may take a run's input: not the DB claim, which is
per process; not the `RcMap`, which counts holds; and not the registry, which
registers before the claim is taken and does not make child activations
exclusive. The lease is not a duplicate. What does duplicate is the state
around it: `adoptedClaim`, `releasing` and `pendingRelease`, which track a
claim hold beside the lease. The in-memory `terminalized` set is also a
stand-in for a fact that should be persisted.

## The design

One **consumer slot** per run replaces the lease, `QueueEntry.owner`,
`adoptedClaim` and `releasing`. A slot is a value on the inbox, not on the
registry:

```ts
type Slot = {
  readonly kind: 'loop' | 'child' | 'recovery';
  readonly hold: Effect.Effect<void>; // one RcMap hold on the run's claim
  input?: RunInput;
};
```

**Taking a slot takes a claim hold.** `acquire(runId, kind)` takes one hold
through `SessionHandle.acquireClaims` (the `RcMap`) and then sets the slot, in
one publisher job. If the run's slot is occupied it refuses, returning the
hold it took. A slot therefore proves that this process holds the claim, which
closes premise 3. Exclusivity is the slot's own, which closes premises 4 and 5.
A child's slot is taken and released by its input consumer, not by its
activation.

**Recovery is a slot with no taker.** An admission to a run with no slot
takes a `recovery` slot. The claim hold the admission takes is that slot's
hold, which replaces `adoptedClaim`. A resume adopts the slot:
`adopt(runId, 'loop' | 'child')` swaps the kind in place and keeps the same
hold, so the claim never drops between recovery and launch, and `releasing`
is gone. Recovery lives on the inbox, not the registry, so `isLive` is
unchanged and `resumeQueuedToolUse`'s pre-check stays as it is (premise 6).

**Release ordering.** Admission, slot acquisition, slot release and adoption
are all jobs on the one publisher (`exclusive`), so they are serial by
construction. A release can't interleave with an admission, so
`pendingRelease` and `admitting` are deleted. The rule that a committed row
keeps the run recoverable becomes: the admission job that commits rows to a
run with no slot takes the `recovery` slot in the same job.

**Queue-terminal is a persisted fact.** A new `followup.closed` row on the
run aggregate is written by the two `terminalize` callers: run deletion
(beside `run.removed`), and `releaseUnstartedRecovery` when nothing is queued.
The fold reads it as `RunRows.inputClosed`.

- An admission that is not a claim refuses a closed run, so the bounded
  in-memory `terminalized` set and its eviction caveat are deleted.
- An explicit claim reopens the run: `claimLive` / `claimChildRun` write
  `followup.reopened`, the fold clears the flag, and that commits in the same
  job as the slot.
- This is a format bump, to the next free number.

**A held row whose sender left no rows.** #13468 rules that an absent sender
is not ended. That stays: a `senderEnd` hold is released only by a committed
terminal row (`run.end` or `run.removed`) that is folded or read at
hydration. Run deletion writes `run.removed`, and the
`event_sequence` collection (`collectClosed`) must not delete a sender's
tombstone while a held row names it. That is an open check for the
implementation, not an assumption. If the check shows that tombstones are
collected, the rule gains one clause: a sender whose aggregate is closed and
collected counts as ended. That is still a persisted fact (the collected
`event_sequence` row), never an absence.

**Observers.** `onRelease` fires on slot release and on `followup.closed`,
which are the same two points it fires on today.

## What gets deleted and what gets added

**Deleted**, from `ToolUseFollowUpQueueManager.ts` (729 lines today) and its
callers:

- `QueueEntry` (`owner`, `admitting`, `pendingRelease`, `adoptedClaim`),
  `releasing`, `terminalized`, `TERMINALIZED_CAP`, `releaseAdoptedClaim`,
  `applyRelease`, `finishTerminalize`, and `useRecovery`'s pending-release
  check;
- the `writeRows` claim hand-back branch and `admit`'s post-commit claim
  disposition;
- the lease parameter threading through `resumeRun` (13 sites) and
  `childRunLoop` (6 sites).

**Added:**

- the `Slot` type with `acquire` / `adopt` / `release`;
- the `followup.closed` / `followup.reopened` rows, their fold arm in
  `runRows.ts`, and their writers in the two tear-down paths;
- the admission refusal read from the fold.

**Estimate, stated plainly:** roughly −260 production lines and +170, so a
net deletion of about 90. Revision 1's −450 / +80 assumed the registry could
absorb the lease; premises 3 to 6 show it can't. What's left is a clarity and
single-authority change more than a deletion. If you'd rather not take a
format bump for tombstones, the `followup.closed` part can be left out: the
in-memory `terminalized` set would stay, and the net deletion drops to about 40.

## Tests that guard it

Assertions stay unchanged, except where an assertion names the lease API
itself; those are rewritten to the slot state they stand for:

- `ToolUseFollowUp.vitest.ts`: admission statuses, replays,
  release-during-admission (becomes serialization), tombstones and their
  eviction (becomes `followup.closed`), the #8093 held delivery for each
  consumer kind.
- `resumeRun.vitest.ts`: recovery before I/O, refusals,
  `releaseUnstartedRecovery`, the root and child branches.
- `ChildRunLoop.vitest.ts`: the child slot released at its input's end
  while the activation continues.
- `NativeSubagentProductionPath.vitest.ts`, `ToolUseWait.vitest.ts`,
  `SessionScope.vitest.ts`, `DelegationHeadless.vitest.ts`,
  `BashTool.vitest.ts`, `ExecutionsToolWorkspaceFiles.vitest.ts`,
  `GitHubSubscriptionProgressEvents.vitest.ts`,
  `ToolUseFollowUpProgressEvents.vitest.ts`, `RetryState.vitest.ts`,
  `UsageLogService.vitest.ts`.

## E2E, with artifacts

Every case runs a real CLI bundle from the branch and from main under an
isolated HOME with the local Responses fake. Each follows the
freeze-trigger-then-SIGKILL method of #13457 and #13468. Each writes a
row dump (`dump.py <home>`: every `followup.*`, `run.end` and `run.position`
row) and a JSON table of consumed counts per follow-up id, and the PR body
carries both, main against branch:

1. **Parked root, follow-up admitted, kill before its turn.** Resume, then:
   `followup.consumed` once, one model request (fake log).
2. **Stopped root with a queued user follow-up (a recovery slot).** Kill
   after admission, before the resume launches. On the next resume the slot
   is adopted without the claim dropping: no `DatabaseNotOwner` in the log,
   and one consumption.
3. **Child result to a parked parent, kill between admission and the
   parent's take.** Consumed once, after the resume.
4. **Held child result (#13468's `hold_e2e.py`), with and without the
   parent already waiting (`live`).** Held until the child's `run.end`,
   then consumed exactly once. In `live` mode the waiting parent takes it
   without a new input.
5. **A deleted parked run, then a child delivery to it.** Refused, with
   `followup.closed` in the dump, across a restart. This is the tombstone
   that is in memory today.
