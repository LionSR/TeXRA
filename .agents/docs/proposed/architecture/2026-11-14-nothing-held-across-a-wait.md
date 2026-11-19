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
| `Effect.uninterruptible`, `uninterruptibleMask`            | 50    | durable terminals and row 5 only (45 on 2026-11-18)         |
| Hand-made `Deferred` and `Latch`                           | 34    | rows 3 and 16                                               |
| `Effect.forkDetach`                                        | 25    | 0                                                           |
| `Queue.unbounded`, `PubSub.unbounded`                      | 15    | 0 (row 20; 2 on 2026-11-18, 1 on 2026-11-19)                |

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
- **`PubSub.publishUnsafe` skips a sliding hub's strategy.** It refuses a
  full subscriber, so a `PubSub.sliding(1)` fed by it loses the newest
  value, not the oldest (`settingsInputs.mjs`); `PubSub.publish` slides.
  `Queue.offerUnsafe` does apply a sliding queue's strategy.
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
| 16  | A request and its answer, between TeXRA's own ends | `rpc`, with a `Protocol` over `postMessage` where the transport is a frame                                                                                                    | the tables in `texra/src/ui/progress/sessionTransport.ts`, `SessionBridge.ts`, `desktop/src/main/desktopPromptController.ts`, `hostWindows.ts`       | `harness/src/tools/jsonRpc.ts` (LSP: the peer also asks)                                                                                                 |
| 17  | A line from the terminal                           | the one readline wrapper, racing readline's `close`                                                                                                                           | the question that stayed pending when its input ended                                                                                                | readline: `Terminal.readLine` hides no input and prompts on stdout                                                                                       |
| 18  | A WebSocket                                        | `Socket.fromWebSocket(ws, { openTimeout })`                                                                                                                                   | the iterator, `rejoin` and the open wait in `llm/src/api/openaiResponsesWebSocket.ts`                                                                | reading the handshake's status; the read that waits between turns (data with no turn makes the connection unusable); the ping                            |
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
`EFF-ADOPT-sql-schema-resolver-model`, now entries of
`.agents/docs/refuted-candidates.json`).

## Progress

Done, on `main` after PR 14927 (checked 2026-11-17: `withFileWriteLane`,
`runsAtWork`, `RouteAnswered` and `scopedFork` are all in the tree):

- Row 4 and row 6: the registry's launch, hold and stop are one
  `acquireUseRelease` each, the three stop paths are one, and a stop asked
  while a run opens stops the runs under it where the launch writes its
  stop row. The JSON-RPC pending table and the draft recorder's reservation
  follow row 4.
- Row 6, fiber-first opening: a run is one fiber from its launch's first
  step. `RunRegistry.start` forks it in the step that checks the launch
  may start (the fiber takes its entry as its first step, which the fork
  runs before it returns), and the fiber opens the run in a scope it owns,
  answers its launcher through one `Deferred`, runs it and ends it
  (`Launch { open, run, end }`; `executeAgent` is that for an agent run,
  over the launch's own preparation). The `opening` state and its
  `launched` `Deferred`, executeAgent's detached `Scope.make`,
  `PreparedRun`, the uninterruptible open-and-fork in the registry, the
  stop kept on an opening entry and the resume's `stopAsked` check are
  gone. A stop is the fiber's interruption plus its row: one that cuts an
  opening refuses the launch (`RunStopped`), and the rows the opening had
  committed (its batch is uninterruptible, so the interruption lands as it
  finishes) end with the stop's reason in the registry (`endUnopened`),
  not in the run's end, which never sees such a stop. A launcher only
  waits for the answer; its interruption leaves the run to its fiber,
  except that an awaited child is released. Three commits: the move with
  behaviour kept, then each behaviour change ("Needs the owner").
- Row 1: a run's open step is a `Ref`.
- Row 8: `withPerKeyLane` is a `Semaphore` per key in a counted map; the
  `Deferred` chain is gone. The agent catalog's one-key lane is a
  `Semaphore(1)`. An approved edit, the desktop editor's save, a
  `JsonStore` write and run storage's snapshot and link share one lane per
  file (`withFileWriteLane`); the JSON store's and run storage's own maps
  are gone.
- Row 10, the leftovers: the agent CLIs' binary resolver and the sandbox's
  QuickJS compile are `Effect.cachedWithTTL`, a success kept for the
  process and a miss or failure for no time; the resolver's
  `SynchronizedRef` is gone.
- Row 11: the settings surface holds its workspace's availability results
  while it follows them. Over the same desktop E2E spec the app's log fell
  from about 400 lines to 76, Zotero probes from 168 to 10 and
  `npm prefix -g` spawns from 85 to 6.
- Row 22, the credential file: a refused refresh adopts a session another
  process stored and deletes only one that is still the stored one.
- Row 22, agent selection: `StateStore.modify` (and `CurrentValues.modify`
  under it) changes a record of keys in one transaction. The selection,
  the hidden list and a removed team's saved list are written in one step;
  a change decided from a team's resolution, read outside the step, is
  decided again when another writer stored a selection in between. The
  in-process lane is gone. The service's `state.get` and `state.set` carry
  the record, so a window's compare-and-set covers every key it changes.
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
  notice, in VS Code and the desktop app; fifteen caller forks are gone
  and two remain, one in each host.
- Row 15: a service link holds one value, the client or why it is away;
  "a run at work" has one reading (`runsAtWork`) for a project's hold, the
  service's load and a drain's end.
- Row 23: the recovery probe tells the gate when its response's first
  event arrives (`RouteAnswered`) and goes on as one of the calls that
  answer admits.
- Row 12, the GitHub deliveries: one fiber a run sends a poll round's
  events in their order, where each event was its own fork.
- Row 18: the Responses model socket reads through `Socket.fromWebSocket`
  (`llm/src/api/openaiResponsesWebSocket.ts`), which owns the listeners,
  the open wait and backpressure (it pauses `ws` at 64 KiB unread); its
  pull is interruptible, so the rejoin of a pending read and the Node
  stream's iterator are gone. Between turns one read waits on the socket,
  started at once so a frame already buffered is seen then: a frame or a
  close it gets before the next turn claims it makes the connection
  unusable, which the phase flag did. A handshake has a 30 s deadline
  where it had none. A scripted local server pins the handshake, an idle
  frame, a close mid-turn, reuse and a slow reader
  (`responsesSocket.mjs` in the evidence directory), run on both versions:
  a frame after a turn's terminal event no longer fails the completed turn
  when it arrives after the turn's last read; the connection is dropped
  instead. The live provider path is not exercised here (no credentials).
- Row 13, the VS Code host: `scopedFork` (`harness/src/platform/processRuntime.ts`,
  exported from `@texra-ai/harness/host`) is `FiberSet.makeRuntime` with
  the fork-failure report a runtime's `runFork` has, so a converted
  callback's failure is still logged once. The activation scope holds one
  (its config warnings, the extension and folder change probes, the
  welcome view's reload, the command registry's two reports, and the
  settings panel's five callbacks, whose follow-then-interrupt pair is
  gone); the progress view's scope holds another (a surface's posts and
  messages, and the tool-edit host's report and warning). A request a
  surface sent outlives that surface and ends with the view. A callback
  after deactivation starts nothing.
- Row 13, the desktop editor pane: `editorPane.ts` enters Effect through
  the webview runtime its workbench hands it (`SessionSurfaces.runtime`)
  and starts its fibers with a `FiberSet.makeRuntime` of the pane's scope;
  its six bare `Effect.run*` calls are gone, and a defect in one of its
  fibers reaches the pane's log.
- Row 13, the terminal chat: `scopeRunner`
  (`cli/src/chat/scopeRunner.ts`) is `scopedFork` plus a synchronous run
  that provides the owner's scope, over one of three owners. A component's
  mount (`useMountScope`, a child of its Ink root's scope) holds its reads,
  timers and followed streams; the chat's scope holds what a form or a key
  starts that must outlive the component (a form's write, a slash form's
  action, a request's decision, the input history); the shutdown scope
  holds a submitted message and the startup resume, which a graceful exit
  waits for after it closed the chat's scope. Run sites in `cli/src` fell
  from 66 to 11: the roots, the chat's startup program, `stop` (below) and
  the headless renderer's heartbeat.
- Row 14, the scoped forks: the desktop window's notice waits on the
  window's fibers, a project's warning dialog on the process scope, and
  the CLI's resume of a document task on the shutdown scope beside the
  chat's own resume.
- Row 20, the buffers: the history store's request and reply queues and
  the sandbox's report queue are `bounded(1)` (strict lockstep); the
  sandbox's settlements are `bounded(MAX_FANOUT)`, the worker's cap on
  calls outstanding; the availability answers are `sliding(1)` with a
  replay of one (rounds rise, and a waiter takes the first at or past its
  own); the deletion markers are `dropping(256)`, and a refused one is
  logged and stays pending in the store for the next open's pass; the
  unhandled-rejection log is `dropping(64)` (each entry ends the host).
- Row 12, the input history (`cli/src/chat/tui/history/inputHistory.ts`):
  each submit forked a push into the chat's scope that took a
  `Semaphore(1)` and appended, so a line typed just before a graceful exit
  died with that scope. One fiber in the platform's scope now appends the
  entries from a `Queue.bounded(64)` in submit order, and that scope's
  close waits until every entry is stored (`inputHistory.mjs`: 190 of 1560
  stored before, 1560 after, in order both ways). A push updates the
  browsable list at once and never waits on the store.
- Row 20, the settings inputs: the unbounded `PubSub` of input names is one
  `SubscriptionRef` of a count per input (`settingsHostBindings.ts`); a page
  rebuilds when a count it follows moved, so only the latest counts matter
  and the reason it stayed unbounded (a dropped name leaves its one page
  stale) no longer applies (`settingsInputs.mjs`: no page left stale in 390
  runs, either shape). A `SubscriptionRef` is itself a `PubSub` with a
  replay of one, so each page's buffer stays the sliding stage of one
  rebuild after it.
- The uninterruptible regions, counted by `surface.mjs` (non-comment lines
  calling `Effect.uninterruptible` or `uninterruptibleMask` under
  `packages/*/src`; the same 50 the table counts): 46. Three repeated a
  mask one level away and are gone: the stdin document write and the
  GitHub workflow write (the process's file system already finishes a
  write it started) and `removeRunDirectories` (only ever the cleanup
  `collect` masks). The desktop registry's construction no longer masks
  its recent-list read; only its no-workspace open stays masked. Nine of
  the 46 hold across a wait not bounded here and are named under "Left,
  with the reason"; each of the other 37 is one of:
  - a durable terminal or stop (row 5's turn, a run's end, a stop row):
    `sessionEventsLayer.ts`, `makeRunHistory.ts` (two), `runLoop.ts`,
    `processRun.ts`, `SessionRequests.ts`'s and `ExecutionsTool.ts`'s
    `runs.stop`, and in row 6's files `AgentRunLifecycle.ts` (two),
    `executeAgent.ts` (two) and `runRegistry.ts`, not touched here;
  - an outside effect with its own deadline and its record (the note's
    other place): the OAuth exchange and store (three), Zotero's save, a
    usage batch, the update notice and its record, a session request and
    its notice (`chatSessionController.ts` 762), the Lean shutdown;
  - a claim and the fork or registration that ends it, with the wait
    restored: the chat's launch and resume, the agent CLI's thread claim,
    the upload cache, the draft recorder's start, the pty start, a GitHub
    bind, the spawner (`nodeServices.ts`), a committed run removal's local
    half (`sessionOwners.ts`);
  - a local write that must not stop half done: `fsDurability.ts`'s
    `writeFile`, `jsonStore.ts`, `fileSecrets.ts`, `acceptedFileTarget.ts`,
    the arXiv rename loop, the store's page reclaim, the deletion
    collector's file removal before its mark;
  - bounded by its own deadline: a session's close (`sessionLayer.ts`).
- Checks: `check-fact-spread.mjs` holds `Effect.forkDetach`,
  `Queue.unbounded`, `PubSub.unbounded` and `SynchronizedRef` shrink-only.
- Row 16, on 2026-11-18: every request between TeXRA's own ends that had a
  hand-written table is `rpc`. `texra/src/shared/rpcOverMessages.ts` turns
  a send and the arriving messages into either end's `Protocol` (JSON
  codecs, acks on); each channel wraps `rpc`'s messages in its own
  envelope.
  - The session channel (the extension's two webviews, the desktop
    renderer, the trace viewer): `SessionRpcs` in
    `texra/src/shared/session/sessionFrames.ts` (`session.frames`,
    `session.host`, `session.actions`, `session.request`,
    `host.request`), one `RpcServer` per port in `SessionBridge.ts`, one
    `RpcClient` per open session in `sessionTransport.ts`, and the trace
    viewer's stand-in host an `RpcServer` over the trace. Gone: the
    transport's pending table and inbox, the request ids
    `sessionSurfaces.ts` and `projectWorkbench.ts` minted,
    `RESPONSE_KIND`, the request envelope, the held-action list, the
    generation echo, and the `SessionFrames` queue with the
    `WebviewSessions` map: a remote view's `SessionInputs.read` is the
    transport's own call (`remoteSessionView`), so the view's `switchMap`
    interrupts the read it replaces, for a webview, a service window
    (`serviceSession.ts`, whose resubscribe lane goes) and
    `texra tasks attach` alike. What the generation guarded, a superseded
    replay and a reloaded webview reusing its port, is `rpc`'s request
    ids plus the envelope's `client`: a page names itself once per load,
    and the server retires a port's previous client when a new one
    speaks. A frame is `{ cursor, inputs }`.
  - The three gaps the measurement named: a handler's defect is caught in
    the bridge and answered `Internal` (rpc would send its text, and a
    stream's defect would end every call of the connection, so a served
    stream ends logged instead); a call whose port closed waits until its
    own scope ends, which is the session's close, as before; the host
    asking the surface is a group the surface serves.
  - The reverse direction. The service asking a window (`hostWindows.ts`):
    the window serves `WindowRpcs` (`hostCalls.ts`) and the service holds
    one client per attachment; `host.attach` frames carry its messages and
    `host.answer` the replies, so the calls map, the per-call ids and
    `Deferred`s, the result table and the detach loop are gone, and a
    cancelled call now reaches the window. The desktop's prompts: the
    renderer serves `DesktopPromptRpcs`, main holds the client, and the
    two prompt commands carry the messages; the pending map and its ids
    are gone.
  - Learned. A view whose read is the transport's call ends with that
    call unless the read ends itself on an interruption: a service window
    that moved to a newer service stopped updating its own view (the
    desktop E2E's tool-edit test caught it). `rpc`'s request ids are a
    module counter, so they repeat after a reload; the envelope's
    `client` is what tells two page loads apart. The bundles grew by
    +14.8 kB (progress webview), +24.4 kB (trace viewer, which carries a
    server too) and +23.2 kB (desktop renderer), before gzip.
  - The service protocol's digest moved twice (the frame's fields, then
    `host.attach` and `host.answer`, whose window procedures now count in
    it); `service.hello` and `service.stop` keep their pinned shapes.
- Row 20, the three buffers in row 16's files: the transport's inbox and
  the `SessionFrames` queue are gone (`rpc`'s stream reads at the
  reader's pace, the server at most 32 chunks ahead); the window table's
  frame queue is `bounded(64)` (a run calling past 64 unread calls waits).
  Two new ones are stated where they are made: a port's held surface
  actions are `sliding(64)` (a surface that has not read 64 is not
  showing, and the newest are the ones meant), and a server's
  retirement queue is `bounded(1)` (one reload at a time is outstanding).

Left, with the reason:

- Row 13: `progressView`'s surface close (`Scope.close` of a surface's
  scope cannot be a fiber of the view scope its close may be running in);
  the CLI chat's `stop` (asked in the signal handler right before the
  shutdown scope closes, so a fiber of that scope would be interrupted
  before its request lands); `texra/src/shared/signals.ts`,
  `desktopWindows.ts` and `processRuntime.ts` (the roots).
- Row 14: `VscodeUiHost.notify` and `instruction.ts`'s deferred dismissal
  (`vscodeUi` is a module singleton reached from fourteen modules and the
  host-neutral `Dialogs` port; a scope there is module state or a run
  function threaded through all of them, and the fiber holds only a
  toast's promise); `HostInteractions.ts`, `ToolUseFollowUp.ts` (row 6),
  `hostRunActions.ts`, `openGuiWindow.ts`, `nodeServices.ts`, and the TUI's
  `sessionCommands.ts`.
- Row 12, the three in-process lanes (`reconcileLane` and `routing` in
  `desktop/src/main/desktopWindow.ts`, `inOrder` in
  `cli/src/chat/chatSessionController.ts`): checked on 2026-11-16 against
  Effect 4.1.4, where a `Semaphore` whose callers all take one permit is
  first come, first served (`takePermits` queues behind any waiter, and a
  release wakes the first in insertion order). Read from the source, not
  re-measured; the gap under "Needs the owner" was measured on
  `withPerKeyLane`'s counted map, not on one long-lived `Semaphore`. So the
  lanes keep call order. Read again on 2026-11-18: all three still take one
  permit each. A queue with one consumer would add an answer channel per caller
  (`inOrder`'s caller awaits its message's route; a workspace route answers
  its request), and `routing` must be held from inside `did-navigate`'s own
  step, which a queued reset cannot do.
- Row 18, a deadline per pull: not added. Whether the provider sends
  anything over the socket while a model reasons for minutes is not known
  here, so a deadline could fail a healthy turn; the 30 s open deadline
  and the ping (a dead TCP connection fails it) stay the liveness checks.
- Row 20, read again on 2026-11-18. `appSignals.ts`: `emit` is called from
  callbacks outside any fiber (a secret store's commit, a registry's
  close), so the producer cannot wait, and every signal is one a
  subscriber needs (a lost `credentialChanged` is a stale credential, a
  lost `workspaceFilesWritten` a file view not refreshed); the producers
  are a person's actions and the app's own writes. `sessionEventsLayer.ts`:
  published inside row 5's turn, which must not wait, and a dropped batch
  is rows a live reader never sees. A bound needs each reader to notice a
  gap (`through` jumps) and read the missing commits from the store, as a
  reader that subscribes late already does; that is the next step there.
  The three in row 16's files are resolved above.
- The uninterruptible regions that hold across a wait not bounded here:
  the chat's send waiting on its forked send (`chatSessionController.ts`
  905: where the message ends, sent or back in the input, is known only
  when the send ends); a desktop project's open and close
  (`desktopProjects.ts` 297, 353, 386: the session's open and the record of it,
  and the record's removal and the session's close, are one step; row 9's
  `ScopedCache` replaces both); the tool-edit preview's diff, proposed
  view and build display (`ToolEditApprovalController.ts`: the request's
  scope deletes the files they read, so its close waits for them) and its
  approval, a session request.

- Row 20, the session events, on 2026-11-19: the hub is
  `PubSub.sliding(1024)` (`KEPT_BATCHES`, `sessionEventsLayer.ts`). The
  publisher still never waits; a subscriber more than 1024 batches behind
  loses the oldest. Each batch names the commit before it (`from`), so the
  loss shows as a gap, and the readers that need every row read the commits
  between from the store, with a warning: `SessionEvents.batches` (which
  `all`, the store's text feed and its presenter feed read) and the view's
  input reader (`sessionInputsLayer.ts`, the same `readInputBatch` as the
  stretch it starts behind). A gap read that fails fails `all` as its first
  read does; it ends the store's two feeds as a logged defect (the presenter's
  end fails `log.drained`), and the session's owner tells the person through
  the host's error notice (`SessionStore.feedStopped`). `appSignals.ts` is the one `PubSub.unbounded`
  left, for the reason above.
- Row 19, on 2026-11-19. `READ_RETRY` ends after eight tries, about a
  minute (`currentValues.ts`): a change read that still fails then answers
  as a change would (`changeRead`), so the values feed emits and the global
  store's poll wakes its readers, whose own reads meet the failure typed;
  nothing waits on a read that may never succeed. The request answerer asks
  its handler once and records the decision again on one schedule, twelve
  times in about two minutes, while the view lists the request
  (`requestAnswerer.ts`, `DECIDE_RETRY`); "the next view" is no longer what
  a retry waits for. When the retries end the failure is logged, the person is told
  through the host's error notice, and the request stays open for another
  surface or its run's end.

Open: slice 7. What the passes learned:

- Row 6 keeps a `Map`, for the reason in its "Stays" cell. Fiber-first
  opening removed the `opening` state and the detached scope but not
  `pending`: a stop of a run id with nothing here and no rows is a launch
  its caller minted and has not handed over (a window's stop racing its
  own start), and without the record the stop is lost and the run runs.
  It now refuses that launch. The stop's reason never had to ride the
  run's end: an interruption that cuts an opening always lands inside the
  opening (an uninterruptible region's end checks for it), so the
  registry, which holds the reason, ends those rows itself. Two orderings
  the old hand-off gave for free had to be kept by hand. The fiber must
  hold its entry before anything can see the id free, so its first step
  takes it and the registry fails loudly if a fork ever only schedules
  its fiber. And a `Deferred`'s completion runs its waiter inside the
  completing fiber's step, so a launcher woken by the answer ran before
  the run reached its loop and found no controls (`crashConformanceResume`
  3 and 4: a model switch right after a resume); the launcher yields once,
  uninterruptibly, after the answer. Still left in this path: the wake's
  `forkDetach` (`wakeIfOwed`, row 14's list): it now only waits for the
  resume's answer to log a refusal, and moving it to the session's
  `FiberSet` is that row's work.
- Row 21, the close deadline: the step with no bound is
  `Fiber.interruptAll` in the run `FiberMap`'s finalizer, which waits for
  a run that does not unwind. No such run was reproduced, and a bounded
  closer would be hand-written, so it is left until one is observed.
- Row 16: `rpc` does the job, measured over a postMessage-shaped pair
  (`rpcFrames.mjs` in the evidence directory) and landed as one change
  across every end (see "Progress"); the VS Code webview was not driven
  here.
- Rows 9 and 10 at the remaining lanes: a reopen must wait for a close and
  nothing shipped does that, so the session and desktop project lanes
  stay. The Codex probe keeps its lane and its map: it caches only what a
  probe said, which `Cache` would need a failure channel to express.
- Row 22's agent selection decided from a team's members and the default
  team, which the app read (`AgentDirectoriesPort.teamMembers`) and the
  global store held; neither could be read inside the repository store's
  step, so a change from a team selection was a compare-and-set that
  decided again. Closed 2026-11-17 by removing teams: a selection is `all`
  or `custom`, both pure, so `setAgentEnabled` decides inside its one
  `modify` step and the decide-again loop is gone.

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
- **A launcher's interruption stops being a `user` stop** (row 6, landed
  as its own commit): an interrupted `session.start` or `resume`, or a
  tool call interrupted while the background child it launched opens,
  gives up only its wait, and the run opens and runs on (an awaited child
  is `released`, as it was once running). `session.start` interrupted just
  after the run opened no longer interrupts it either.
- **A stop that reaches a run before its first rows refuses the launch**
  (row 6, its own commit): the launch fails with "was stopped before it
  started" and no run exists, where the opening used to finish and end
  CANCELLED with the stop's row. The same for a stop of a minted id
  before its launch arrived. A stop of a run that has rows is unchanged.

## What this gives up

- Fairness. A refused caller retries; nothing remembers who asked first.
- Call order, except where row 12 keeps it.
- Side effects inside a state change (rows 2 and 6): a body that re-runs
  may only read and write refs.

## Checks

- `scripts/check-fact-spread.mjs` holds `withPerKeyLane`,
  `Effect.forkDetach`, `Queue.unbounded`, `PubSub.unbounded` and
  `SynchronizedRef` shrink-only, so a slice that raises one fails and names
  the file. The surface table's broader rows (followers, listeners,
  entries into Effect) are not counted: their spellings also match
  legitimate uses.
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
  single-use refresh tokens; `rpc` over the VS Code webview's
  `postMessage` (driven in the trace viewer under headless Chromium and
  in the desktop app's E2E under xvfb; VS Code's download is refused
  here); the model socket against the live provider.
