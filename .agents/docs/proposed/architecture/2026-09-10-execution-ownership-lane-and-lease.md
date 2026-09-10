---
created: 2026-09-10
status: proposed
---

# Execution ownership: the lane and the lease

One execution is currently owned by three mechanisms at once. Two of them are
durable and answer the same question with different storage; the third is
local and is what silently makes the first two sound. The [1.0 implementation
plan](2026-09-09-texra-1-0-implementation-plan.md) already rules that the file
lease goes. It does not say what happens to the lane, and the lane is the half
that carries the load-bearing invariant.

This note maps the authorities, states the coupling that is currently
unwritten, and proposes the shape ownership should take after the persistence
cutover.

## 1. The authorities today

| #   | Mechanism                                                                                     | Scope                   | Keyed by                                 | Refusal                                                 | Where                                                                  |
| --- | --------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Sequence-row `owner_id` claim, with liveness proof inside the write transaction               | cross-process, durable  | `AggregateId` (stream **and** execution) | `DatabaseClaimRefused`                                  | [`Database.ts`](../../../../src/controllers/session/Database.ts#L506)  |
| 2   | Claim files `executionLeases/<id>/<token>.json`, pid liveness, lock-free token-order protocol | cross-process, durable  | `(storageRoot, executionId)`             | `ExecutionLeaseActiveError` / `ExecutionLeaseLostError` | [`executionLease.ts`](../../../../src/agent/storage/executionLease.ts) |
| 3   | Per-execution lane: tail hand-off, `live` gate, `waiting` refusals                            | in-process, per session | `executionId`                            | `ExecutionBusy`                                         | [`executionLanes.ts`](../../../../src/agent/runtime/executionLanes.ts) |

Around those three sit four more partial answers to "who owns this run right
now": the registry's `handles` / `childActivations` maps (read as
`hasRetainedOwner`, [`executionRegistry.ts`](../../../../src/agent/runtime/executionRegistry.ts#L275)),
the handle's own `terminalState` / `suspension`
([`ExecutionHandle.ts`](../../../../src/agent/runtime/ExecutionHandle.ts#L81)),
the stream phase read as `isActiveOrResuming`, and the lease module's private
`maintenanceExecutions` ALS set plus `unleasedWriteQueues`.

This is PRD problem P13 — "status, settlement, and ownership are arbitrated,
not owned" — in its most concentrated form.

## 2. Findings

### F1. The two durable mechanisms decide the same fact from the same evidence

Both prove ownership with the _same_ primitive,
[`proveOwnerLiveness`](../../../../src/agent/storage/leaseOwnerLiveness.ts):
the lease reads it from a JSON file's `owner` field, the database reads it from
a parsed `owner_id` column, inside the transaction. Neither adds information
the other lacks. Fresh launch claims the aggregate by its first append ("first
append claims the aggregate; later appends require that same claim",
`Database.ts:196`); resume acquires explicitly with a liveness recheck. The
lease repeats that decision in a second store with its own 653-line protocol
(token ordering, `MAX_CLAIM_ROUNDS`, ABA avoidance, two reap policies).

### F2. The lease's one remaining unique job is fencing files that are not in the database

`runWithExecutionLeaseWriteFence` guards exactly one thing:
[`ExecutionKVStore`](../../../../src/agent/storage/ExecutionKVStore.ts#L133)
writes, which are `StorageFS` files under `executions/{executionId}/{key}.json`
— the flow record, checkpoint, and turn state. That is why the lease cannot be
deleted before the KV/checkpoint cutover, and why it _can_ be deleted with it:
once those writes are transactions, the transaction's own claim check is the
fence.

### F3. The lease is generation-blind, and the lane is what makes it sound

`ownedLeases` is a process-global `Map` keyed by `(storageRoot, executionId)`
with no generation identity. `assertOwnedExecutionLease` says so outright:

> Generations of one execution are serialized by the registry's per-execution
> lane, so the owned record for an id is always the generation doing the
> asking; no async-context capture is needed to tell generations apart.

So the correctness of every in-run fence — `executeAgent.ts:410`,
`childRunLoop.ts:838`, `childRunLoop.ts:914` — rests on an invariant owned by a
different module, enforced by nothing, and checked by no type. If the lane ever
admits two generations of one id concurrently, `ownsExecutionLease` answers for
the wrong one and the fence passes silently. A regression of exactly this kind
was introduced and caught by inspection, not by tests, while converting the
lane to Effect primitives (a `holdLive` gate that opened on the shorter of two
overlapping generations).

The process-global map also contradicts the repo's own #7694 invariant. It is
reached through ALS: nine call sites wrap a lease call in `runInSession` for no
purpose other than telling it which storage root it is on.

### F4. `holdLive` and `handle.suspend(teardown)` both compensate for a scope that ends before its generation does

A run parked at WAITING returns from `runFlowWithLifecycle`, so the
generation's scope closes — but the generation is not over: a later stop still
has to run its teardown. The code recovers by stashing the teardown as an
`Effect` field on the handle
([`AgentRunLifecycle.ts:749`](../../../../src/agent/runtime/AgentRunLifecycle.ts#L749))
and, when a stop finally runs it, re-opening a second gate on the lane through
`holdLive` — whose only caller is
[`waitingTermination.ts:104`](../../../../src/agent/runtime/waitingTermination.ts#L104).

Everything expensive in the lane exists to serve that second gate: the `live`
set, its ordering rules, and the "which generation may clear it" question that
produced the regression above. Under structured concurrency a run parked at
WAITING is a fiber suspended inside its scope, not a closed scope plus a
detached teardown, and none of that machinery is needed.

### F5. Admission is asked of queue occupancy, not of ownership

`withInactiveStep` refuses when `hasRetainedOwner() || live.size > 0 ||
fibers > 0`. Two of those three are properties of the queue's implementation,
not facts about who owns the execution — which is why the predicate had to
peek at `PQueue.size`/`pending` before, and at a fiber counter now. Admission
policy and scheduling mechanism are fused in one object.

## 3. What is already ruled, and what is not

The 1.0 plan's retirement boundary already covers the lease:

> File-based `executionLease` — replace ownership admission and write checks
> with database transactions; delete lease files, polling, legacy readers, and
> compatibility writes together.

and its step B retires it together with the flow, checkpoint and KV
dependencies. `leaseOwnerLiveness.ts` stays; `Database.ts` already uses it.

Not covered anywhere: the lane, the three in-run `assertOwnedExecutionLease`
fences that have no stated database successor, and F3's unwritten dependency.

## 4. Proposed direction

**D1 — one durable authority.** The sequence-row claim is it. Delete the lease
with the KV cutover, per the 1.0 plan. Nothing new is designed here; the point
is that the claim must also absorb the three in-run fences, either by an
explicit "still mine" read or by the fact that every write becomes a
transaction that checks the claim itself. Name which, in the cutover PR.

**D2 — the lane stops being an ownership mechanism.** Split its two jobs:

- _Admission_ ("may this generation start?") is one predicate over ownership —
  the claim, plus the registry's live handles. It belongs beside the registry
  that already answers `isActiveOrResuming`, and it must not read scheduling
  counters.
- _Ordering_ ("start after the previous generation has fully unwound") is one
  permit per execution id, held for the generation's scope. `Effect.Semaphore`
  with a scoped permit expresses it whole.

**D3 — the generation's scope is the generation's lifetime.** Keep a run parked
at WAITING inside its scope instead of returning and stashing a teardown. Then
`holdLive`, the `live` set, and `AgentExecutionHandle.suspend`/
`beginSuspendedTermination` all go, and a stop is an interrupt of a fiber
rather than an invocation of a detached teardown that has to re-acquire a gate.
This is the only item here with real design risk: parking a fiber across a
process restart is not the same as parking a Promise, and the resume path
(`resumeQueuedToolUse`) has to be re-read against it.

**D4 — make the remaining ownership token generation-scoped.** Whatever
survives D1–D3, the fix for F3 is that a run holds its ownership as a value in
its own scope, not as an entry looked up by id in a process-global map. That
removes the unwritten dependency rather than documenting it, and drops the nine
ALS wrappers with it.

## 5. What this deletes

`executionLease.ts` (653 lines) and its claim protocol; `executionLanes.ts`'s
`live` gate, `waiting` refusals and `holdLive`; `AgentExecutionHandle.suspend`
/ `suspendedTerminationStarted` / `beginSuspendedTermination`; the lease's
`maintenanceExecutions` ALS and `unleasedWriteQueues`; nine `runInSession`
wrappers; and `SessionHandle.releaseExecutionLease`'s four-way failure
aggregation, which exists because four independent things have to be released
in order.

## 6. For the owner to rule

1. Does D3 (WAITING stays inside the generation's scope) belong in the 1.0
   cutover, or after it? It is the item that makes D2 cheap, and the item most
   likely to move the resume contract.
2. Should admission keep refusing (`ExecutionBusy`) where it refuses today, or
   should the queueing and refusing paths converge now that both would read
   the same claim?
3. F3 is a latent-correctness issue on today's code, not only after the
   cutover. Worth a targeted regression test at the lane boundary before any
   of this lands?
