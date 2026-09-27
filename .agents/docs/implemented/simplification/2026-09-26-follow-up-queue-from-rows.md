# Pending follow-ups read from the run's rows

Date: 2026-09-26
Status: implemented (ruling 4(b) taken: `RunState.followUps` removed).
Baseline: `main` at `904d2f55`. Parent survey:
[SSOT ownership survey](../../proposed/simplification/2026-09-23-ssot-ownership-survey.md),
section 4.

## 1. Finding

A run's pending follow-ups have two authorities today.

- The rows: `followup.queued` and `followup.consumed` on the run aggregate,
  folded by `runRows.foldRunRows` into `RunRows.followUps` (queued without
  consumed, commit order) and `followUpIds` (every id a row named). #13255
  made the admission replay check read that fold.
- An in-memory copy beside them:
  - `ToolUseFollowUpQueue` (`src/agent/followUp/ToolUseFollowUpQueueManager.ts`)
    keeps per run a `held` list for rows committed before a consumer attached
    its input, and `offer()` pushes every admitted row into the owner's input.
  - `RunInput` (`src/agent/followUp/RunInput.ts`) keeps an Effect `Queue` of
    follow-ups, its own `held` list for offers that arrive before `seed`, and
    a `seen` id set that dedupes the overlap between "offered live" and
    "seeded from the fold".
  - The consumers seed that queue once from a cold fold: the tool-use loop
    from `RunLedger.load` (`toolUse.ts` `followUps.seed(entry.loaded)`), the
    agent-CLI child from `foldRunState(null, readAggregate(...))`
    (`childRunLoop.ts`).

The `held`/`seen`/seed-ordering machinery exists only to reconcile the two
copies. With the rows as the one authority, the input would shrink to a wake
signal and `hasQueued` to a read of the fold.

## 2. Why it was not done in the SSOT lane

Two constraints block a mechanical swap. Neither is latency: a tail read of
one aggregate is cheap.

### 2.1 A durable row that must not be delivered yet (#8093)

`childRunLoop.deliverTurn` admits a child's turn result onto the parent
_before_ the child finalizes (crash safety: the result survives a crash
between settlement and finalize), with `liveOffer: 'deferred'` on a turn it
is about to finalize. The row is durable, but a live parent must not take it
until the child's terminal row lands; otherwise a parent that immediately
waits on the child sees it still RUNNING and, on the recovery path where the
wake runs the parent's whole turn inline, self-stalls.
`submitPendingDelivery` re-submits the same delivery id after finalize, and
only then is it offered.

"Admitted but not yet offerable" is a live-only fact. The rows cannot say
it, and on a fresh process it must not apply (the seed delivers such a row,
which is correct: the child that deferred it is gone). A consumer that reads
every pending row on wake would deliver the deferred row early, on any wake
(a user follow-up, a synthetic compaction turn).

### 2.2 The loop's `RunState` is not a fold of the aggregate

`RunLedger.appendBatch` returns `foldRunState(state, committed)`: the state
the loop loaded, plus the loop's own batches. `followup.queued` rows are
written by a different job on the same publisher (the admission boundary),
so they never reach the loop's `RunState` after load. `RunState.followUps`
is therefore stale by design after the first batch; reading pending from it
on wake needs either a tail read folded into the state or a change to the
ledger's continuation contract ("the state the loop continues from is the
fold of its own writes", which `contractViolation` and the candidate fold in
`appendBatch` both assume). That contract is not this lane's to change.

There is also a synchronous reader: `toolUse.ts` calls
`followUps.hasQueued()` five times, one of them inside the sync host port
`requestImmediateCompaction`. Those become Effect reads or read a
publisher-kept set.

## 3. Design

Rows are the authority; memory keeps only a wake signal and the one live-only
gate.

1. **Publisher-kept pending set.** `sessionEventsLayer` already keeps each
   aggregate's open work as it commits (#13255 streams, and open stages and
   workflow calls since the host-exit change). Add pending follow-ups the
   same way: `followup.queued` adds `{followUpId, content}` unless the id is
   known, `followup.consumed` removes it and marks the id known,
   `run.removed` drops the aggregate. Expose
   `SessionEvents.pendingFollowUps(aggregateId)`. Rows an earlier process
   committed are not in the set; the boundary that covers them is the claim:
   `RunLedger.acquire` already cold-folds the aggregate
   (`foldRunState(null, readAggregate(...))`) to retire unbound requests, and
   the admission's `acquireClaim` is the other claim path. Whichever claim
   runs first hydrates the set from that fold, once per aggregate per
   process. That replaces both consumer seeds with one hydrate at the claim.
2. **Deferred ids stay in memory, explicitly.** `ToolUseFollowUpQueue` keeps
   `deferred: Set<followUpId>` per run, filled by a `liveOffer: 'deferred'`
   admission and cleared by the re-submit (or the lease's release). The
   consumer's pending read is `pendingFollowUps(run)` minus `deferred`. This
   is the only in-memory follow-up state left, and it is by nature
   live-only.
3. **`RunInput` becomes a wake signal.** A `Queue<'input' | {synthetic}>` (or
   a latch plus a synthetic slot). `take` waits for a signal, then reads the
   pending set; an empty read after a signal (a batch another consumer of
   the same generation took) waits again. Synthetic turns keep their current
   rule: they never share a batch with follow-ups. `held`, `seen`,
   `seed(pending, known)` and `QueueEntry.held` are deleted; `attachInput`
   no longer replays anything; `offer()` becomes "signal the owner".
4. **One consumer per generation stays the invariant.** The native child's
   delivery driver and its inner tool-use flow share one input today; the
   batch is claimed by the `followup.consumed` commit (tool-use `consume`)
   or, for the agent-CLI child, held in flight until `commitChildTurn`
   writes consumed at settle. That loop is sequential (no second `take`
   before settle), so the in-flight batch cannot be read twice. State this
   in the `take` contract rather than adding a guard.
5. **`hasQueued` reads the set.** `FollowUps.hasQueued` and
   `ToolUseFollowUpQueue.hasQueued(lease)` become "the pending set holds an
   id not in `deferred`", a synchronous read as today.

What is deleted: `RunInput.held`, `RunInput.seen`, `RunInput.seed`,
`QueueEntry.held`, the replay in `attachInput`, `FollowUps.seed` and its two
call sites (`toolUse.ts` enter, `childRunLoop.ts` setup fold for the
agent-CLI child), and the ordering argument in the `RunInput` header.
Estimated net: about -120 lines, plus the pending-set tracker (about +30).

## 4. Ruling needed

The design keeps the loop's `RunState` as the fold of its own writes (no
ledger contract change): pending is read from the publisher's set, not from
`RunState.followUps`. `RunState.followUps` then has no runtime reader after
load; the ruling is whether to

- (a) keep `RunState.followUps` as a fold field for `load` diagnostics and
  tests only, or
- (b) remove it from `RunState` and keep it only in `RunRows` (the
  admission replay check and the hydrate read it there).

Recommended: (b). One field, one reader, and the loop state stops carrying a
value that is stale after its first batch.

## 5. Verification plan

- `ToolUseFollowUp.vitest.ts` and `ToolUseWait.vitest.ts` cover admission,
  replay, deferred offer and release; they keep their assertions and lose
  the ones about `held` ordering.
- The #8093 case (a finalizing child's result is not taken by a parent woken
  for another reason before the child's `run.end`) is the one regression
  test the change earns.
- A restart case: rows queued by an earlier process are delivered after the
  claim hydrates the set.

## 6. Landed

- `SessionEvents` keeps each run's pending follow-ups
  (`pendingFollowUps`), folded by `applyRunRow` as it commits.
  `hydrateFollowUps` seeds it from the rows where a claim moves here (or the
  first time this publisher sees the run): `RunLedger.acquire` passes the
  rows it already read, the graph's `acquireClaims` reads them. A read that
  raced a commit merges with what was tracked, so the set holds commit order.
- `RunInput` is a wake latch plus the synthetic slot; a take reads
  `pendingFollowUps` less the entry's `deferred` ids. `held`, `seen`, `seed`,
  `QueueEntry.held`, the `attachInput` replay, `FollowUps.seed`, the
  agent-CLI child's setup fold and the unused `hasQueued(lease)` are gone.
- `RunState` is `RunPosition` plus the loop's own fields; a follow-up row
  only opens an otherwise empty run. `RunRows` keeps `followUps` for
  `sessionFold` and the admission's replay check. `onIdle` takes no state:
  its one consumer reads `pendingFollowUps`.
- One behavior note: a deferred row keeps its commit position, so once its
  producer re-submits it, it is delivered ahead of rows committed after it.
  The old queue appended it at re-submit time.
