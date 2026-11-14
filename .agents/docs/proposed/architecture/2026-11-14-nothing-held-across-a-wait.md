# Concurrency on Effect's own primitives: one per need, nothing held across an open-ended wait

**Status:** proposed, 2026-11-14. Read at main `7547ab0`, Effect 4.1.3.
Origin: a concurrency audit of every package (seven read-only passes, four
root-cause passes, one pass over the areas the first seven left out), three
passes that read Effect's source and measured it, and the owner's rulings
during the work. Measurements and their scripts:
[evidence](../../evidence/2026-11-14-concurrency-primitives/README.md). This
note builds on
[root designs, Effect-native](./2026-11-05-root-designs-effect-native.md) and
[decisions read the log](./2026-11-09-decisions-read-the-log-not-the-view.md).

## Summary

The audit found no nested-lock deadlock in the tree. It found about fifty
defects, and nearly all have one cause: **something is held while the code
waits.** A lane, a permit, a registry entry, a claimed turn is taken, then the
fiber waits (for IO, another fiber, a person, or only the scheduler), and
during the wait the holder is interrupted, overtaken, or left waiting for
good.

The second cause is how the tree answers that: **each site wrote its own
answer.** Seventy locks in five shapes, thirty-four hand-made waits, a
hand-written keyed lane, a hand-written run state machine, four hand-written
request tables, 125 followers each with its own idea of "changed".

So the design is a standard, not a set of fixes:

1. **Nothing is held across an open-ended wait.** State this process reaches
   without waiting changes in one step. Work that must wait holds nothing and
   decides again when the wait ends.
2. **One shipped primitive per need, and one way per need across the tree.**
   Effect, SQLite and Node already provide each of them. A hand-written
   mechanism stays only where the source or a measurement shows nothing
   shipped does the job, and this note records that evidence.

Surface at `7547ab0`, non-test source, 1339 files:

| Construct                                                  | Sites | After                                                       |
| ---------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| Followers (`SubscriptionRef.changes`, `Stream.runForEach`) | 125   | one ref per fact; every follower through `Stream.changes`   |
| Listeners (`addEventListener`, `.on(`, `fs.watch`)         | 110   | `Stream.callback` with one consumer where order matters     |
| Entries into Effect (`runFork`, `runPromise`, `runSync`)   | 110   | a `FiberSet` runtime per owner scope; the hosts' roots stay |
| Module-level mutable state (`new Map`/`Set` 99, `let` 36)  | 135   | a layer's `Ref`, or constant                                |
| Keyed and cached lifetimes (`RcMap`, `Cache`, `cached`)    | 90    | the three shapes in rows 9 to 11                            |
| Locks (`Semaphore`, lanes, `SynchronizedRef`)              | 70    | rows 1, 7 and 8                                             |
| `Effect.uninterruptible`, `uninterruptibleMask`            | 50    | durable terminals and row 5 only                            |
| Hand-made `Deferred` and `Latch`                           | 34    | rows 3 and 16                                               |
| `Effect.forkDetach`                                        | 25    | 0                                                           |
| `Queue.unbounded`, `PubSub.unbounded`                      | 15    | 0 (row 20)                                                  |

## Rulings this note follows

Made by the owner on 2026-11-14:

- Do not reinvent what Effect ships, and do not solve one need two ways.
- An `unstable` or `experimental` tag is no reason to pass a primitive over;
  newer Effect is preferred.
- `@effect/sql` stays (the ledger's ruling is not reopened).
- Where a mechanism is too complex to be right, prefer failing loudly.

## What reading and measuring Effect changed

Each of these replaced a belief the earlier design, or the tree, rested on.

- **A transaction in memory exists and is the right tool.** `Effect.tx` over
  `TxRef`s validates and commits in one synchronous function, so its
  atomicity does not depend on the scheduler: 0 broken invariants in 3120
  reads and 0 registrations after a close in 780 runs, at every step budget
  from 2 to 79. `Effect.txRetry` waits on the refs it read and holds
  nothing. Two limits: a conflicting commit runs the body again, so a body
  has no side effects, and commit order is not start order.
- **The recorded reason against `Semaphore` was about the lane map, not the
  semaphore.** In 4.1.3 joining a semaphore's queue is one step and entry
  follows join order. Measured against the step that calls the lane, the
  hand-written chain and a bare `Semaphore(1)` reorder identically (39 of
  225 runs each at budgets 2 to 79, 2 of 2101 offsets each at the default),
  and once queued both enter in order (0 of 225). `withPerKeyLane` over one
  fixed key is a `Semaphore(1)`.
- **`PartitionedSemaphore` is not a lock per key.** It is one pool of permits
  shared round-robin across keys.
- **Nothing shipped makes a reopen wait for a close.** `RcMap.invalidate`,
  `ScopedCache.invalidate` and `FiberHandle.run` each start the new instance
  while the old one is still releasing.
- **`Atom` and `reactivity` are for UI state.** A node nobody reads is
  disposed, which is the availability loop's own fault as a design.
- **`SubscriptionRef.set` publishes an equal value.** "Not published again"
  is `Stream.changes`, at every follower.
- **`Effect.cached` keeps a failure for good.** Only an interruption is not
  kept.
- **A timeout around `Scope.close` does not bound it** (150 ms under a 30 ms
  timeout). `FiberSet.clear` then `awaitEmpty` under a timeout does.
- **`Terminal.readLine` ends at end of input** with `QuitError`;
  `readline/promises` `question()` never settles there.
- **The SQL client has no synchronous transaction.** A transaction through
  it is one turn only inside a region that turns the scheduler's yield off.

## One primitive per need

Paths are under `packages/`. "Stays" names what remains hand-written and why.

| #   | Need                                               | Primitive                                                                                                                                                                     | Replaces                                                                                                                                             | Stays                                                                                                                                                    |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Change one value fibers share                      | `Ref.modify` (one step)                                                                                                                                                       | the three `SynchronizedRef`s whose updates are pure; module `let`s and maps changed over several steps                                               | none                                                                                                                                                     |
| 2   | Change several values together; check, then act    | `Effect.tx` over `TxRef` / `TxHashMap`                                                                                                                                        | the publisher's `closed` flag and its check; the registry's entry map                                                                                | none. A body does no IO                                                                                                                                  |
| 3   | Wait until shared state allows it                  | `Effect.txRetry`; `Latch` for a gate; `Deferred` for one answer                                                                                                               | the registry's `settled` and `done` hand-offs; wait-then-recurse paths                                                                               | none                                                                                                                                                     |
| 4   | Take something and guarantee its release           | `Effect.acquireUseRelease` / `acquireRelease`, around the claim                                                                                                               | "set, then register the release" (three sites in `runRegistry.ts`, the JSON-RPC pending table, the draft recorder, the lane's claim)                 | none                                                                                                                                                     |
| 5   | Read rows and write on what was read               | `sql.withTransaction`, run as one turn                                                                                                                                        | the publication inbox, already gone in PR 14927                                                                                                      | the one `atomic` region (uninterruptible, no scheduler yield): a `tx` body re-runs and the client has no sync form                                       |
| 6   | The runs this process drives                       | `FiberMap<RunId>` for the fibers; their state stays a `Map` changed one step at a time, each claim an `acquireUseRelease`                                                     | three claims that set state before registering its release; three stop paths, one of which skipped the cascade                                       | the `Map`: a fiber's exit observer, `interrupt()` and the hosts' `get()` are synchronous, and a `TxHashMap` is read and written only inside an Effect    |
| 7   | A thing only one user can have                     | `Semaphore.withPermitsIfAvailable(1)`: busy is an answer                                                                                                                      | queueing behind `lake build`, the model socket's lane, the prompt lane, the window's `opening`                                                       | none                                                                                                                                                     |
| 8   | One writer at a time for a file                    | a `Semaphore` per key, in a map that counts its holders (`withPerKeyLane`); a fixed owner holds its own `Semaphore(1)`; the file writers share one map keyed by the real path | the hand-written `Deferred` chain; the two maps an approved edit and an editor save keep for one file                                                | the counted map: `RcMap` prunes too but needs a `Scope`, and eight of the maps are module-level                                                          |
| 9   | A keyed resource with an explicit close            | `ScopedCache`; its lookup first waits, by `txRetry`, until the key is not closing                                                                                             | the per-root lane in `sessionLayer.ts`, the desktop projects' lane and `selectionLane`                                                               | the wait on "closing": nothing shipped has it                                                                                                            |
| 10  | A computation callers share                        | `Effect.cachedInvalidateWithTTL`, or `Cache.makeWith` by key, with a failure kept for no time                                                                                 | the agent catalog's load lane, the OAuth in-process lock, the vendor-package `SynchronizedRef`, the Codex probe lane, `Effect.cached` in the sandbox | none                                                                                                                                                     |
| 11  | A result that outlives the one who asked           | `RcMap`: the surface that shows it holds it; a refresh uses `RcMap.getOption` and only asks for a round                                                                       | the availability probe that restarts itself                                                                                                          | the round's own logic                                                                                                                                    |
| 12  | Events that must be handled in order               | `Stream.callback` / `Stream.fromEventListener` with a `bufferSize`, one consumer                                                                                              | `routing`, `reconcileLane`, `inOrder`, `pushes`; a fork per GitHub event                                                                             | none                                                                                                                                                     |
| 13  | A host callback that starts Effect work            | `FiberSet.makeRuntime` in the owner's scope (`FiberHandle` for latest-wins, `FiberMap` by key)                                                                                | about 54 `runtime.runFork` sites                                                                                                                     | each host's root entry                                                                                                                                   |
| 14  | A notice nobody waits for                          | the host runs the wait in its own `FiberSet`; `notify` returns once shown                                                                                                     | about 11 `forkDetach` at callers; the other 14 become scoped forks                                                                                   | none                                                                                                                                                     |
| 15  | One fact, many readers                             | one `SubscriptionRef` holding a union; readers take `changes` through `Stream.changes`                                                                                        | the link's three refs and five derivations; "a task is at work" computed two ways                                                                    | none                                                                                                                                                     |
| 16  | A request and its answer, between TeXRA's own ends | `rpc`, with a `Protocol` over `postMessage` where the transport is a frame                                                                                                    | the tables in `texra/src/ui/progress/sessionTransport.ts`, `SessionBridge.ts`, `desktop/src/main/desktopPromptController.ts`                         | `harness/src/tools/jsonRpc.ts` (LSP: the peer also asks); `hostWindows.ts` `ask` (the direction `rpc` lacks)                                             |
| 17  | A line from the terminal                           | the one readline wrapper, racing readline's `close`                                                                                                                           | the question that stayed pending when its input ended                                                                                                | readline: `Terminal.readLine` hides no input and prompts on stdout                                                                                       |
| 18  | A WebSocket                                        | `Socket.fromWebSocket(ws, { openTimeout })`                                                                                                                                   | the iterator, `rejoin` and the open wait in `llm/src/api/openaiResponsesWebSocket.ts`                                                                | reading the handshake's status; a deadline per pull for liveness                                                                                         |
| 19  | A wait on something outside the process            | `Effect.timeoutOrElse`; a retry is a `Schedule` with an end                                                                                                                   | the untimed Lean request, TUI exit, `texra service stop` across builds; `READ_RETRY` without a bound; "retry on the next view"                       | a wait on a person, which ends with their window                                                                                                         |
| 20  | A buffer                                           | `Queue.bounded`, `sliding` or `dropping`, chosen where the queue is made                                                                                                      | fifteen unbounded queues                                                                                                                             | none                                                                                                                                                     |
| 21  | Ending a scope's fibers in bounded time            | `FiberSet.clear`, then `awaitEmpty` under one timeout                                                                                                                         | the close that is 5 s, then unbounded, then 5 s                                                                                                      | none                                                                                                                                                     |
| 22  | A fact several processes write                     | one transaction in the global SQLite store (`modify`)                                                                                                                         | agent selection's lane and its two-key write                                                                                                         | the credential file's store-if-unchanged: no in-process primitive crosses processes                                                                      |
| 23  | Route health across fibers                         | route state in a `TxRef`; a call is one `tx` that passes, takes the probe, or `txRetry`s; the probe's verdict is recorded at the first evidence the route answers             | the probe permit held for a whole turn, up to three hours                                                                                            | the backoff rule; both `EFF-ADOPT-retry-gate-*` refusals stand. The `tx` alone does not shorten the hold: the attempt has to say when the route answered |

## What "nothing held across a wait" did not cover

The pass over the unaudited areas tested the model and found six things it
does not say. Each gets a rule and the primitive it names.

- **Who may close a scope.** Closing one session runs every plugin's drain,
  and the GitHub plugin's drain closes the process's poll and delivery
  scopes (`harness/src/controllers/session/sessionLayer.ts`,
  `harness/src/tools/liveTools.ts`,
  `texra/src/tools/github/subscriptionsLayer.ts`). After one project closes,
  no session's poller runs, while the subscriptions still list. Rule: a
  resource is closed only by the scope that acquired it. A process resource
  is a finalizer of the process layer; a session's close reaches nothing
  above the session.
- **An outside effect with no condition.** Saving to Zotero, or "the dialog
  was shown, now record it", cannot be written "only if still true". Rule:
  such a call and its record are one uninterruptible step with its own
  deadline, and it uses the other side's idempotency key where one exists
  (the usage batch has one). This and the durable append are the two places
  `Effect.uninterruptible` belongs.
- **Order.** Where order matters it is row 12, and nowhere else.
- **What a full buffer does.** Row 20: stated at the queue, not inherited
  from a default.
- **A failure that is remembered.** Row 10: a shared computation keeps a
  failure for no time unless its owner says otherwise.
- **A retry that waits for an event that may not come.**
  `harness/src/effect/requestAnswerer.ts` re-offers an unrecorded decision
  on "the next view". Row 19: a retry runs on a `Schedule`.

## The items the owner listed

- **The availability probe that never stops.** A settings surface on a
  workspace no local session holds runs a probe round every 120 to 150 ms:
  85 `npm prefix -g` spawns and about 400 log lines in 14 s, the same on
  `main` and on PR 14927. The page finds no result and calls `refresh`
  (`texra/src/controllers/settingsView/settingsToolCommands.ts`); `refresh`
  holds the probe for its own scope and that scope's close deletes the
  result (`harness/src/tools/toolAvailability.ts`); the page's follower saw
  a result and rebuilds; the page finds no result. Row 11.
- **A stop of an opening run does not reach its children.** Row 6.
- **A refresh that loses a race deletes the winner's session**
  (`llm/src/oauth/SubscriptionOAuthCoordinator.ts`). Rows 10 and 22: callers
  in one process share one attempt; the store happens only if the file still
  holds the token the exchange used, and a fatal answer deletes only an
  unchanged session.
- **An approved edit and an editor save guard one file with two maps.**
  Row 8: one service, one key.
- **`transact` waits for a reader to apply the view.** The view is a pure
  function of the rows; the commit applies it. This belongs to the session
  data work in flight (see "Order").
- **The log viewer test races the app's log.** The viewer's content has one
  writer, the main process. The test writes its entry through the app's log
  sink and posts nothing into the renderer.

## Why the earlier root designs grew back

R1 to R10 were right in direction. Each rested on a premise one layer down
that did not hold: R1's store interface on a transaction nothing could run
inside; R2 ("a run is one fiber") on an opening that is one transaction,
when it is resource acquisition in the caller's fiber; O1 on an attach that
never landed. And each was written with the primitives the tree already
used, so the hand-offs they deleted were rewritten by hand.

Seven refusals in `.agents/docs/refuted-candidates.json` change under this
note (the first has landed). Landing the row rewrites the entry in the same PR.

| Refused candidate                  | Its reason                                        | Now                                                                   |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `EFF-ADOPT-per-key-lane-semaphore` | a later claimant can enter first                  | landed and removed: measured, the cost is 8 offsets of 2101 against 2 |
| `M7-file-lanes-as-references`      | a reference per site adds a declaration at each   | row 8 is one service, not a reference per site                        |
| `LEAN-lake-lane-server-semaphore`  | the lane outlives the server                      | row 7: the directory is taken or refused                              |
| `RT-desktop-projects-rcmap`        | `RcMap` cannot close a held entry                 | row 9 uses `ScopedCache`, whose `invalidate` closes it                |
| `RT-desktop-window-fiberhandle`    | a reopen during a close would be dropped          | row 9's wait on "closing"                                             |
| `RT-tui-approve-handler`           | a service-backed session takes no approve handler | slice 7 finishes O1's attach                                          |
| `SESSION-one-view-service`         | the remote view needs a second layer              | the same                                                              |

`DISPATCH-script-lanes-semaphore` and both retry-gate refusals stand.

## Order

A slice is a deletion whose callers are known; each PR cites its rows and
deletes what they name for the files it touches.

1. **Memory and claims** (rows 1 to 4, 6, 23). The registry on `FiberMap`
   and `TxHashMap`; a run opens in its own fiber and answers one `Deferred`
   the launcher awaits; a stop is one path. The retry gate on a `TxRef`.
2. **Locks** (rows 7, 8, 10). Delete `perKeyQueue.ts`. The file-write
   service; shared computations on the cached forms; exclusive things
   refuse.
3. **Lifetimes** (rows 9, 21, and scope ownership). Sessions and desktop
   projects on `ScopedCache`; one close deadline; the GitHub drain moves to
   the process layer.
4. **Facts and followers** (rows 11, 15). Availability, the link, "at
   work"; `Stream.changes` at every follower.
5. **Boundaries** (rows 12 to 14, 16 to 18). Inbound queues, `FiberSet`
   runtimes, `notify`, `rpc` for the frames, `Terminal`, `Socket`.
6. **Waits and buffers** (rows 19, 20, and outside effects).
7. **Across processes** (row 22). O1's attach: `texra run` and the project
   listing attach to the store's holder or hold it; a cold read uses the
   open connection; a shared store is never moved aside by a process that
   does not hold it.
8. **The log viewer test.** Any time.

**The view.** "The commit applies the view" has no owner now. The projection
table once proposed for the session-data path was withdrawn (the owner
questions the projections already there), so
`shared/session/sessionViewUpdate.ts`, `sessionInputsLayer.ts` and
`projections.ts` wait on that decision. Two findings from that work stand
open: a run's deletion does not take its children, and a run's end closes
open requests with the same decision a person's cancel writes. That work
also read `effect/workflow`, `effect/eventlog` and the `effect/sql` models
against the run loop and the store and refused each with evidence
(`EFF-ADOPT-workflow-run-loop`, `EFF-ADOPT-eventlog-session-store`,
`EFF-ADOPT-sql-schema-resolver-model`, on its own branch).

## Progress

Done, on the branch after PR 14927:

- Row 4 and row 6: the registry's launch, hold and stop are one
  `acquireUseRelease` each, the three stop paths are one, and a stop asked
  while a run opens stops the runs under it where the launch writes its
  stop row. The JSON-RPC pending table and the draft recorder's reservation
  follow row 4.
- Row 1: a run's open step is a `Ref`.
- Row 8: `withPerKeyLane` is a `Semaphore` per key in a counted map; the
  `Deferred` chain is gone. The agent catalog's one-key lane is a
  `Semaphore(1)`. An approved edit and the desktop editor's save share one
  lane per file (`withFileWriteLane`).
- Row 11: the settings surface holds its workspace's availability results
  while it follows them. Over the same desktop E2E spec the app's log fell
  from about 400 lines to 76, Zotero probes from 168 to 10 and
  `npm prefix -g` spawns from 85 to 6.
- Row 22, the credential file: a refused refresh adopts a session another
  process stored and deletes only one that is still the stored one.
- Slice 8: the log viewer test writes its entry through the app's log.
- Scope ownership: one session's close runs no plugin drain; the shutdown
  (`closeAll`) alone does. Closing one project had ended the GitHub pollers
  of every other.
- Row 19: `texra service stop` and `restart` have one deadline, for a
  service of another build too.
- Row 17, not as written: a question on stdin fails when its input ends
  (readline leaves it pending for good). `Terminal.readLine` was not
  adopted: it has no hidden input and writes its prompt to stdout, so the
  two would have needed two mechanisms. The one readline wrapper stays and
  races its `close`.
- Row 14: `Dialogs.notify` returns once the host is asked to show the
  notice, in VS Code and the desktop app; eleven caller forks are gone.
- Row 15: a service link holds one value, the client or why it is away;
  "a run at work" has one reading (`runsAtWork`) for a project's hold, the
  service's load and a drain's end.
- Row 23: the recovery probe tells the gate when its response's first
  event arrives (`RouteAnswered`) and goes on as one of the calls that
  answer admits.

Open: fiber-first opening (row 6), the frames on `rpc` (row 16), the model
socket (row 18), the inbound queues (row 12), agent selection as one store
write (row 22), the buffers (row 20), and slice 7. What the passes learned:

- Row 6 keeps a `Map`, for the reason in its "Stays" cell. Fiber-first
  opening (the run's fiber acquires its own resources) removes the
  `opening` and `pending` states and the detached scope. It changes what a
  launcher's interruption means, and a stop that reaches a run before its
  registration commits has no row to carry its reason, so the run's end
  would read the reason from the registry.
- Row 21, the close deadline: the step with no bound is
  `Fiber.interruptAll` in the run `FiberMap`'s finalizer, which waits for
  a run that does not unwind. No such run was reproduced, and a bounded
  closer would be hand-written, so it is left until one is observed.
- Rows 9 and 10 at the remaining lanes: a reopen must wait for a close and
  nothing shipped does that, so the session and desktop project lanes
  stay. The Codex probe keeps its lane and its map: it caches only what a
  probe said, which `Cache` would need a failure channel to express.

## Needs the owner

- **Row 8's cost.** `withPerKeyLane` on a `Semaphore` lets a later caller
  enter first at 8 of 2101 offsets at the default budget; the hand-written
  chain did at 2. Both exclude correctly and neither leaves a key held. A
  site that needs call order is row 12, not a lock. Landed on that basis;
  `EFF-ADOPT-per-key-lane-semaphore` is removed.
- **Row 5 uses `PreventSchedulerYield` for atomicity.** Effect documents it
  for throughput. Two tests pin the behaviour. The alternative is the
  ledger's exit, the Node SQLite driver called directly.
- **Busy is an answer** (row 7): an agent's second `lake build` on a root is
  told one is running.
- **A failed refresh no longer signs out** unless the stored session is the
  one that failed.
- **A launcher's interruption stops being a `user` stop** (row 6), and a
  child interrupted while opening under "Keep agents running" keeps opening.

## What this gives up

- Fairness. A refused caller retries; nothing remembers who asked first.
- Call order, except where row 12 keeps it.
- Side effects inside a state change (rows 2 and 6): a body that re-runs
  may only read and write refs.

## Checks

- `scripts/check-fact-spread.mjs` holds `withPerKeyLane` shrink-only. Add
  the constructs of the surface table, so a slice that raises one fails and
  names the file.
- The two tests PR 14927 added stay: a detached job has committed when the
  call returns, and no job runs after the publisher closed, at every
  scheduler budget from 2 to 79.

## Verified

- Read in Effect 4.1.3's source and measured, by the three primitive passes:
  every row's primitive and each statement under "What reading and
  measuring Effect changed". The scripts are in the evidence directory.
- Rerun by the note's author from that directory: lane against semaphore
  once queued (0 of 225 each), transaction interleaving through the SQL
  client (0 / 3 / 41 intrusions, 0 with the yield off), `Terminal.readLine`
  and `readline` at end of input.
- The availability loop: read from the two files named, and measured from
  the desktop app's log under xvfb on `main`'s and the PR's sources.
- The surface counts: a script over `packages/*/src` at `7547ab0`.
- Not verified: the registry on `TxHashMap` under the real stop cascade;
  whether any of the sixteen lanes needs call order; provider behaviour for
  single-use refresh tokens; `rpc` over `postMessage` in the three frames.
