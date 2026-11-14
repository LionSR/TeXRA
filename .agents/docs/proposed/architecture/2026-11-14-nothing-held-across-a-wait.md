# Nothing held across a wait: one concurrency model for the tree

**Status:** proposed, 2026-11-14. Read at main `7547ab0`. Origin: a
concurrency audit of every package (seven read-only passes, then four
root-cause passes), the owner's verdicts during it ("most of these are design
problems", "many of the refusals are caused by other structural problems",
"a universal simple system beats this"), and PR 14927, which landed the first
instance. This note builds on
[root designs, Effect-native](./2026-11-05-root-designs-effect-native.md) and
[decisions read the log](./2026-11-09-decisions-read-the-log-not-the-view.md)
and does not repeat them: it names the one rule their designs share, and the
order that follows from it.

## Summary

The audit found no nested-lock deadlock anywhere. It found about forty defects
of four shapes, and they have one cause: **something is held while the code
waits.** A lane, a semaphore permit, a registry entry, an open transaction, a
claimed turn: each is taken, then the fiber waits (for IO, for another fiber,
for a person, or only for the scheduler), and during the wait the holder can
be interrupted, overtaken or left waiting for good.

The model is one sentence: **nothing is held across a wait.** Two cases
follow, and there is no third.

1. **The work does not wait.** Then it is one synchronous step, and a
   synchronous step in a single-threaded runtime needs no lock.
2. **The work must wait.** Then it holds nothing while it does: it carries
   what it read, and when the wait ends it writes only if that is still true.
   A conflict is an error the caller sees.

Everything else in this note is those two cases applied: to SQLite, to files,
to credentials, to a run's lifetime, to derived values and to the hosts.

Counts at `7547ab0`, non-test source. Each falls with the slices below and
none rises:

| Construct                                       | Sites | What it becomes                                           |
| ----------------------------------------------- | ----- | --------------------------------------------------------- |
| `withPerKeyLane` lane maps                      | 16    | 0 to 3 (slice 5)                                          |
| `Semaphore.make(1)` used as a lock or an order  | 15    | try-and-refuse where the resource is exclusive, else gone |
| `Effect.uninterruptible`, `uninterruptibleMask` | 50    | one `atomic`, plus durable terminals                      |
| `Deferred.make` request and hand-off tables     | 30    | rows and their watchers; one scoped request table per RPC |
| `Effect.forkDetach`                             | 25    | 0                                                         |
| `Queue.unbounded`, `PubSub.unbounded`           | 15    | bounded, or deleted with the queue's reason               |
| `SynchronizedRef`                               | 3     | plain refs updated in one step                            |
| forks with `startImmediately` to claim an order | 21    | the two that order inbound messages go; the rest stay     |

## Why the earlier root designs grew back

R1 to R10 were right in direction and landed in early November with
compromises. Each rested on a premise one layer down, and the premise did not
hold:

- R1's store interface ("append in one `BEGIN IMMEDIATE`, delete
  `PublisherJob`") needed a transaction nothing could run inside. A
  transaction written as Effect steps can be interleaved at the scheduler's
  step budget, so the queue stayed. PR 14927 removed it by making the
  transaction one turn.
- R2 ("a run is one fiber") assumed "the opening is one transaction". It is
  resource acquisition in the caller's fiber, so the `opening` state, the
  detached scope and five entry kinds came back.
- O1 ("one process per store") landed the lock and not the attach, so the
  two session modes and their in-process lanes stayed.

The lowest premise is case 1. With it in place the others can be finished as
designed.

The refusals in `.agents/docs/refuted-candidates.json` read the same way.
Seven of the concurrency ones are correct inside the current structure and
stop being questions under this model (`DISPATCH-script-lanes-semaphore`
stays refused: the script door orders calls, which is a real queue):

| Refused candidate                  | Its reason                                        | What removes the question                         |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `EFF-ADOPT-per-key-lane-semaphore` | a write's order must survive a scheduler yield    | the write is one step; there is no lane (slice 5) |
| `M7-file-lanes-as-references`      | a lane is a fact about a file every layer shares  | no lane (slice 5)                                 |
| `LEAN-lake-lane-server-semaphore`  | the lane outlives the server                      | try-and-refuse on the directory (slice 8)         |
| `RT-desktop-projects-rcmap`        | a project needs an explicit close                 | a project is a scope the registry holds (slice 4) |
| `RT-desktop-window-fiberhandle`    | a reopen during a close would be dropped          | the same                                          |
| `RT-tui-approve-handler`           | a service-backed session takes no approve handler | O1's attach half (slice 6)                        |
| `SESSION-one-view-service`         | the remote view needs a second layer              | the same                                          |

## The rules

**Rule 1. A change of state this process can reach without waiting is one
step.** Memory, the session's SQLite connection and a small file are all
reachable synchronously. A read-modify-write of any of them is a plain
synchronous function, or, where it must be Effect-typed (the SQL client), one
`atomic` region: uninterruptible, with `Scheduler.PreventSchedulerYield`.
There is one definition of `atomic`. No lock exists for such state, because
nothing can run between its steps.

**Rule 2. Work that waits holds nothing.** A network exchange, a child
process, a person's answer: read, wait, then write on the condition that what
was read still stands (a file's content, a token, a row's commit). A failed
condition fails the call, or adopts what the other writer left. A resource
only one user can have at a time (a build directory, a socket, the terminal's
stdin) is taken with try-and-refuse: the second caller is told it is busy.
Nobody queues behind anybody.

**Rule 3. A fact is a row, a running thing is a fiber in a scope, a derived
value has one computation.** To make something happen, append a row. To wait
for it, watch the rows. To stop something, interrupt its fiber, and write the
row that says so. A value computed from others is computed from its inputs
only: a reader never causes the computation it reads, and a result whose
inputs did not change is not published again.

**Rule 4. Every wait names what ends it.** A row, a ref's change, the closing
of the waiter's own scope, or a deadline. A wait on a party outside the
process (a peer, a server, a person at a terminal) has a deadline or ends
with the connection.

## What each open item is, under the rules

### The items the owner listed

**The availability probe that never stops** (found while reading PR 14927's
CI). The desktop app runs a probe round back to back, every 120 to 150 ms,
for as long as a settings surface is open on a workspace no local session
holds: each round spawns `npm prefix -g`, checks `wolframscript` and asks
Zotero twice. Measured: 85 spawns and about 400 log lines in 14 s, the same
on `main` and on the PR.

The loop, read from the code:

1. The Plugins page finds no result for its workspace and calls `refresh`
   (`packages/texra/src/controllers/settingsView/settingsToolCommands.ts`).
2. `refresh` holds the workspace's probe for its own scope
   (`packages/harness/src/tools/toolAvailability.ts`, `RcMap.get` under
   `Effect.scoped`). The round publishes its result.
3. The scope closes. It was the last holder, so the entry's finalizer deletes
   the result.
4. The page's follower saw a result appear and rebuilds the page. The page
   finds no result. Go to 1.

Rule 3 names both faults: the reader causes the computation it reads, and a
result's lifetime is the reader's scope. Design: a surface that shows a
workspace's results holds them for as long as it is open (`hold`, in the
surface's scope, as a session does), and `refresh` only asks for a round. A
round runs when an input changes (the workspace, a declared secret, the
person's Re-check) and at no other time.

**A stop of a run that is still opening does not reach its children**
(`packages/harness/src/agent/runtime/runRegistry.ts`, `stop`, case
`opening`). Three stop paths exist and one of them never calls `stopUnder`,
so a resumed parent's background children keep running and billing after
Stop. Rule 3: a run is one fiber in one scope, and a stop is one path.
Slice 3.

**A refresh that loses a race deletes the winner's session**
(`packages/llm/src/oauth/SubscriptionOAuthCoordinator.ts`, `refresh`). The
lock is in-process; the credential file is shared by every host. Rule 2: the
exchange is a wait, so nothing is held across it. After it, store on the
condition that the file still holds the token the exchange used; on a fatal
answer, read the file again and adopt a session whose refresh token differs,
and delete only one that is unchanged. Slice 6.

**An approved edit and an editor save guard one file with two lane maps**
(`packages/harness/src/tools/approval/approvedWrite.ts`,
`packages/desktop/src/main/desktopWorkspaceIpc.ts`). Rule 1: reading a source
file, comparing or merging, and writing it is one synchronous step, so there
is no lane and the two writers cannot interleave. Slice 5.

**`transact` waits for another fiber to apply the view**
(`packages/harness/src/controllers/session/sessionStore.ts`, `viewApplied`).
The writer holds its turn until a reader has run. Rule 1: the view's update
is a pure function of the rows, so the commit applies it in its own step.
Slice 2.

**The log viewer test races the app's own log**
(`packages/desktop/tests/e2e/trajectories.spec.ts`, "logs workbench renders
the desktop log viewer"). The viewer's content has one owner, the main
process's snapshot (`packages/desktop/src/main/desktopLogIpc.ts`, `follow`).
The test is a second writer: it posts a snapshot into the renderer, and the
next real one replaces it. Design: the test writes its entry through the
app's log sink and asserts on that entry; nothing posts `desktop:setLog` but
the main process.

### The rest of the audit, by rule

| Rule | Findings it covers                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | registry entries set one step before their release is registered (three sites in `runRegistry.ts`); the JSON-RPC pending table; the draft recorder's reservation; the script door's `inLane`                                                           |
| 2    | the retry gate's probe permit held for a whole turn, up to three hours; `selectionLane` held across a project's dispose; `inOrder` held across a root launch; the lake lane queueing builds for ten minutes each; cold reads taking the exclusive lock |
| 3    | "is a task at work" computed two ways, so a service drain can wait for good; the link's client derived in four places and followed by five loops; a run's result pinned as failed by one transient disconnect; the resume cursor moved before delivery |
| 4    | an approval prompt on stdin that never returns at end of input; a WebSocket handshake and a half-open socket with no deadline; a Lean request with none; the TUI's exit; a session close that is 5 s, then unbounded, then 5 s                         |

## Slices, in the order they depend on each other

Each slice is a deletion whose callers are known. A slice that changes a
stored format, a public name or a behaviour says so under "Needs the owner".

1. **One `atomic`.** One exported definition in the harness; the four
   regions PR 14927 wrote by hand use it (`databaseLayer.ts` `own`,
   `sessionEventsLayer.ts` `commit` and `awaited`, `runTrace.ts`
   `updateText`). The registry's three "set, then register the release"
   sites become one step each. Deletes: the hand-written regions.
2. **The commit applies the view.** The view updater's steady state is a
   pure reducer over committed batches; the commit runs it before it
   publishes. Deletes: `viewApplied`, the view half of `settled`, the
   barrier reasoning at the sites
   [decisions read the log](./2026-11-09-decisions-read-the-log-not-the-view.md)
   lists. To verify first: the cold read at open, which is the one part of
   the updater that reads the store.
3. **A run opens in its own fiber.** The registry forks the run's fiber
   first; the fiber acquires its resources in its own scope, commits its
   opening and answers one `Deferred` the launcher awaits, so a launch that
   cannot open still fails at the launcher with no run behind it. A stop is
   the row and the interruption, on one path, and the cascade reads children
   from the rows. Deletes: the `opening` kind, the detached `Scope.make` and
   its two closers, the inferred stop reason on a launcher's interruption,
   fork-then-interrupt, the `opened` flag. Stays: a stop asked before the
   run's rows exist (`pending`), and the hold a file operation or a deletion
   takes on a run id (`busy`).
4. **A close is one deadline, and it is the scope's.** Stopping the runs and
   waiting for them is the session scope's first finalizer, with one
   deadline computed once; a run still running at the deadline is reported
   and detached, never joined without limit. The per-root lane goes with it:
   open and close of one root are the acquisition and release of one keyed
   resource. The desktop's projects and window take the same shape.
5. **A small file is changed in one step.** One primitive beside the other
   Node file primitives (`packages/harness/src/utils/files/fsDurability.ts`):
   read, decide, write, synchronously, returning a conflict when the file is
   not what the caller read. Users: approved edits, the desktop editor's
   save, agent YAML customization, `config.json`, the memory tool, inline
   criticism, credential writes, a run's file snapshots. Deletes: their lane
   maps (eight of the sixteen) and the two-lanes finding. The lanes that remain are the ones
   around a language server's document order; each is re-read against rule 2
   when its turn comes.
6. **One arbiter for each shared fact.** Finish O1: `texra run` and the
   project listing attach to the store's holder or hold it, through the one
   link function; a cold read uses the open connection. Agent selection is
   one `modify` in the global store. The OAuth session follows rule 2 as
   above. A shared store is never moved aside at open by a process that does
   not hold it.
7. **Derived values.** The availability fix above. The link's state has one
   owner that the four readers and five followers read. "A task is at work"
   has one definition, and the drain waits on it.
8. **Exclusive things refuse.** `lake build`, the model socket, the window
   open, the terminal prompt: try, or say busy. The retry gate records a
   route's health at the first evidence and holds no permit across the turn.
9. **The hosts.** One ordered inbound queue per desktop window and one for
   the chat's submit, which is what `routing`, `reconcileLane` and `inOrder`
   stand in for. `Dialogs.notify` returns when the notice is shown, so its
   callers stop detaching it. Every wait on a person or a peer gets its end
   (rule 4).
10. **The log viewer test**, as above. It can land at any time.

## Needs the owner

- **Synchronous file IO for a read-modify-write (slice 5).** It holds the
  event loop for the length of one read and one write of a source file. On a
  slow network disk that is felt in the UI. The alternative keeps
  asynchronous IO behind one shared lane keyed by the file's real path; it
  keeps a lock and its lifetime questions, and still protects nothing across
  processes.
- **A failed refresh no longer signs out (slice 6)** unless the stored
  session is the one that failed.
- **Busy is an answer (slice 8).** An agent's second `lake build` on a root
  is told one is running, where today it waits its turn.
- **A launcher's interruption stops being a `user` stop (slice 3),** and a
  child interrupted while it opens under "Keep agents running" would keep
  opening.
- **`@effect/sql` stays.** The transaction is made one turn through a public
  Effect reference; the ledger's ruling on the SQL client is not reopened.

## What this gives up

- Fairness. A refused caller retries; nothing remembers that it asked first.
- Interrupting a step. A synchronous step runs to its end; it must stay
  short, which is a property of what it touches (rows, a source file), not a
  promise.
- Queued work at shutdown. Nothing is queued, so nothing is flushed.

## Checks

- `scripts/check-fact-spread.mjs` already holds `withPerKeyLane` shrink-only.
  Add the other constructs in the summary table to its list, so a slice that
  raises one fails and names the file.
- Each slice's PR cites its rule and deletes everything the slice names for
  the files it touches, or says which item it leaves and why.
- The two tests PR 14927 added stay as the model's pins: a detached job has
  committed when the call returns, and no job runs after the publisher
  closed, at every scheduler budget from 2 to 79.

## Verified

- The four root-cause passes and their verdicts, in the session that wrote
  this note: the transaction's interleaving (measured, 0 / 3 / 41 intrusions
  at 90 / 400 / 5000 statements and 0 with yields prevented), the run
  lifecycle (five entry kinds, one removable by fiber-first), the host
  boundary (about five ordering locks removable), ownership of shared state
  (O1's attach half open).
- The availability loop: read from the two files named above, and measured
  from the desktop log of `trajectories.spec.ts` run under xvfb on both
  `main`'s and the PR's sources.
- The counts in the summary table: `grep` over `packages/*/src` at
  `7547ab0`.
- Not verified: that every lane in slice 5 guards a read-modify-write short
  enough for one step (each site is re-read in its slice); the cold-read
  phase of the view updater (slice 2); provider behaviour for single-use
  refresh tokens (slice 6 assumes the file's own comments).
