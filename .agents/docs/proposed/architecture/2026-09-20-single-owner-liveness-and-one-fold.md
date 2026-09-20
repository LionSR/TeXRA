---
created: 2026-09-20
status: proposed
---

# Single-owner liveness and one fold

Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](./2026-09-20-post-refactor-architecture-survey.md).
Extends, and does not replace, the 2026-09-10
[execution ownership](./2026-09-10-execution-ownership-lane-and-lease.md) and
[runtime system design](./2026-09-10-effect-native-runtime-system-design.md)
notes, whose D2 to D4 and section 2.1 `Runs` tag this proposal schedules.

## 1. Problem

The event table is the only durable authority for run facts and it is sound:
every append is stamped with the owner in the same SQL statement
(`src/controllers/session/Database.ts`), so a lost claim writes nothing. But
the rows are interpreted by three independent readers and shadowed by
in-memory copies that are not derived from them.

| Second copy                                                                             | Where                                                                            | Failure it produced                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `flow.snapshot` restates `references` and `runtime` already in rows                     | `src/shared/session/runStateFold.ts` (`stale-snapshot`, `dangling-binding` arms) | a mismatch fails the run `inconsistent`, unresumable                          |
| `sessionFold.ts` (1 983 L) beside `runStateFold.ts` (1 085 L), sharing only `traceFold` | `src/shared/session/`                                                            | a row type folded into one and not the other is silent; 4 fixes in the window |
| `RunRegistry.handles`, `childActivations`, `RunLanes.live`                              | `src/agent/runtime/runRegistry.ts`, `runLanes.ts`                                | the process believes it owns a run the DB reassigned; 7 fencing fixes         |
| `StreamLogStore` residency                                                              | `src/agent/runtime/StreamLogStore.ts`                                            | a third projection; fixed twice                                               |
| approval-policy field, rows as projection                                               | `src/agent/runtime/SessionHandle.ts`                                             | restart or second host resets it, nothing reconciles                          |
| `AppState` per-instance value map                                                       | `src/controllers/session/appStateStore.ts`                                       | another process's writes invisible for the instance's life                    |

Every race guard in production was classified. Inherent concurrency is small:
two processes on one root (claims, busy timeout, data-version poll), the
provider (`ModelRetryGate`), webview reconnect generations, JSON file lanes.
All other guards (`runLanes` hand-off and `live` gate, `holdLive`,
`hasRetainedOwner`, `cleanupLanes`, the `SynchronizedRef` on `run.model`,
`StreamLogStore.gate` and `releaseRequests`, per-key write lanes in
`appStateStore`) exist because two in-process authorities answer the same
question. Roughly 13 of the 18 session and tool fixes since 2026-09-03 are
impossible under single-owner-per-fact.

## 2. Target

One durable authority (unchanged), one interpreter, derived caches, ownership
held as a value in the owning fiber's scope rather than looked up in maps.

## 3. Changes, in dependency order

1. **A waiting run stays inside its fiber's scope.** `AgentRunLifecycle`
   returns and stashes a teardown today so the scope can close while the run
   parks. Keep the fiber alive across the park instead. Deletes `holdLive`
   and the `live` set in `runLanes.ts` and the sole caller in
   `waitingTermination.ts`. This is D3 of the ownership note.
2. **The DB claim is the only liveness authority, held as a scoped value.**
   Replace `RunRegistry.handles`, `childActivations`, `RunLanes.live` and
   `isActiveOrResuming` with one `FiberMap<RunId>` whose entry is the acquired
   claim. Admission, stop and deletion answer from one place. Deletes
   `runLanes.ts` (199 L), `waitingTermination.ts`, `hasRetainedOwner`, the
   `RunBusy` plumbing in `SessionRequests.ts` and `WorkflowScriptTool.ts`. D2
   and D4; the `Runs` tag of the runtime design section 2.1. A `FiberMap`
   entry exists only once a fiber does, and a stop can arrive before that:
   twelve synchronous host callers reach `interrupt()` and eleven
   `failIfLaunchStopped` sites race the launch. The `stopped` `Deferred` is
   therefore installed before admission returns and stays the pre-fiber
   latch; the map entry adopts it, it does not replace it.
3. **Derive the snapshot, do not restate.** `flow.snapshot` keeps family
   state and the message anchor, nothing the rows already carry. Three facts
   the snapshot carries today have no other row: `references.intentBindings`
   is the one carrier of an intent's `approvalRequestId` (`loop/rows.ts`
   says so), and `runtime.pendingRetry` and `runtime.declinedRoutes` are
   restored from it. Each moves to a named row first (a binding row beside
   `request.opened`, and the retry permit and declined routes as rows the
   retry owner writes); only then do the `stale-snapshot` and
   `dangling-binding` arms and about 90 lines of cross-checking in
   `runStateFold.ts` go. The new row types bump `SESSION_EVENT_FORMAT`
   (`src/shared/schemas/sessionEvent.ts`), so an older store is cleared at
   open rather than read as the current vocabulary, and the pinned
   format-fingerprint check is updated with it.
4. **One fold.** Extract the row-application both folds share into one
   reducer, and make `sessionFold` a projection of `RunState` plus the
   session-only rows. A new row type then has one place to land.
5. **`StreamLogStore` becomes a cache of the view**, not a store: its
   `Semaphore`, `known` set, `releaseRequests`, `runOwner` tokens and `seq`
   dedup go. Already named in the runtime design ("the view replaces
   `StreamLogStore`").
6. **App state reads through the committed level.** `SqliteStateStore`
   reads through the `level` stream instead of an open-time snapshot, so
   another process's writes become visible. The per-key `writeLanes` stay:
   overlapping flip-and-restore writes to one key must commit in invocation
   order, and a long-lived handle does not give that FIFO on its own. The
   approval policy is not moved onto rows: `approval.policy` rows are
   per-run snapshots, published only for runs this process owns, so with no
   active run there is no row and with two processes the fold can carry the
   other host's run policy. The host-seeded session policy stays the
   authority and the rows stay run projections; the restart and second-host
   reset in section 1 is a property of that design, and a durable
   session-level record is a separate decision.

With step 1 landed, D26 (`SessionHandle`'s `DisposableStore` onto a `Scope`
finalizer) is no longer refuted: the synchronous early teardown it preserved
exists only because the scope closes before the park.

## 4. What stays

The `SessionEvents` inbox (many producers, one commit order is inherent), the
claim and its liveness proof, `busyTimeout`, the `data_version` poll,
`sessionFrames.generation`, `jsonStore` file lanes, `ModelRetryGate`.

## 5. Acceptance

- `runLanes.ts` and `waitingTermination.ts` deleted; no `holdLive`.
- `runStateFold.ts` has no `stale-snapshot` or `dangling-binding` arm.
- `sessionFold.ts` imports the shared reducer; no row type is matched in
  both folds by separate `case` arms.
- `StreamLogStore` holds no `Semaphore` and no `seq` comparison.
- The crash-boundary measurement from the 2026-09-04 runtime doc (#12025,
  #12076) is recorded: kill during a tool, resume, verify the fold re-enters
  at the row boundary.
