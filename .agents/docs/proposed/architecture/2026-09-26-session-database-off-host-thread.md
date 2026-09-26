# Session database off the host thread

Date: 2026-09-26

Status: proposed — measurement first; no implementation is authorized by this note

Audit baseline: `origin/main` `0f07499` (2026-09-26).

Peer baseline: OpenCode `b65de4d` (2026-09-26), cloned for this note.

## Summary

Every TeXRA host runs its session database synchronously on the thread that
also renders, streams and dispatches tools. `@effect/sql-sqlite-node` drives
`node:sqlite`'s `DatabaseSync`, so a statement, and SQLite's busy wait on a
locked database, blocks the whole process. The substrate decision already
recorded this and deferred it until measured
([persistence substrate decision](../../archived/architecture/2026-09-03-persistence-substrate-decision.md),
"Client selection at the approved host floor"). The delivery plan named the
two candidates: a short busy wait with bounded Effect retry of
database-only transactions, or a dedicated database worker
([delivery plan](./2026-09-06-effect-runtime-delivery-plan.md), SQLite
paragraph).

This note turns that deferral into a staged, gated plan:

1. **Stage 0: measure.** Add one reading to the existing measurement record:
   the longest host event-loop stall while a second process writes the same
   `texra.db`.
2. **Stage 1: short busy wait plus retry (A0).** About 50 lines in `Database.ts`.
   Stop here if Stage 0 shows the stall is lock waiting, not statement cost.
3. **Stage 2: database worker (A1).** The connection moves to a
   `worker_threads` worker behind the unchanged `Database` service, using
   Effect's own RPC-over-worker protocol. Take this only if Stage 0 or
   Stage 1 shows statement execution itself stalls the host.

It deliberately does **not** propose OpenCode's background-server design
(one daemon owning the database, with every host as a thin HTTP client). That
is the complete answer to "three hosts at once", but it moves the run loop out
of every host and needs host-only capabilities called back across a process
boundary. §6 records why it is deferred and which part of A1 it would reuse.

## 1. What runs on the host thread today

One connection per database identity: each project root, the global root,
and each profile's application state (`src/controllers/session/projectDatabase.ts:16`,
`src/controllers/session/Database.ts:1211`,
`src/controllers/session/appStateStore.ts:83`). Each is opened by
`SqliteClient.make({ filename, busyTimeout: '5 seconds' })`
(`src/controllers/session/Database.ts:279-283`). All three hosts and the SDK
open these in-process through `installProcessRuntime`
(`packages/extension/src/extension.ts:233`,
`packages/desktop/src/main/platform/index.ts:169`,
`packages/cli/src/runtime/cliProcessRuntime.ts:235`,
`packages/agent/src/effect/runtime.ts:236`). All of them resolve the same
`~/.texra` data root by default, so desktop and the CLI on one project share
one `texra.db` by design (`packages/desktop/src/main/platform/index.ts:106-108`).

Four kinds of main-thread work, from most to least likely to stall:

| Source                                                            | Where                                                                                                                     | Worst case                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| SQLite busy handler while another connection holds the write lock | every `BEGIN IMMEDIATE` (`Database.ts:468`) and, rarely, a WAL recovery read                                              | the full 5 s `busy_timeout`, the whole process frozen |
| Statement execution                                               | `READ_LISTING` with `json_each` and grouped `MAX(seq)` (`Database.ts:164-191`), `readAll` of a long run, `readInputBatch` | grows with history, unmeasured                        |
| Commit and fsync                                                  | WAL, `synchronous = NORMAL` (`Database.ts:1303-1307`)                                                                     | small; WAL `NORMAL` does not fsync per commit         |
| Change poll                                                       | `PRAGMA data_version` every 250 ms per connection (`Database.ts:405-435`)                                                 | negligible per tick                                   |

Draft validation and serialization already run before `BEGIN IMMEDIATE`
(`Database.ts:1183-1188`, C6). That work stays on the calling thread in
every option below and is not what this note is about.

The 5 s timeout is a correctness setting. It must be set before WAL is enabled,
and a zero timeout lost 26–55% of concurrent appends in the stage 0 spike
(`Database.ts:1294-1301`). Any option that shortens the wait must keep the
open-time value and replace the lost patience with a retry. Lowering the
timeout alone is not an option.

## 2. What is measured today: nothing

The runtime performance record keeps "commit latency under contention" as a
measure-once item (budget p95 ≤ 50 ms, no commit over 1,000 ms) and records it
as NOT TAKEN ([measurement record](../process/2026-09-21-runtime-performance-measurement-record.md), §3).
The same record's amendment **struck** "missed event-loop deadlines" as a
criterion. That is the reading this decision needs: commit latency says how
long the writer waited, not whether the host's UI froze while it did.

**Question for the owner (Q1):** reinstate one event-loop reading, scoped to
this decision and taken once, not as a standing gate.

## 3. Stage 0: the reading

Extend the §3 harness of the measurement record rather than building a second
one:

- **Topology.** Two processes on one project's `texra.db`, both through
  `databaseLayer('persistent')`, not a raw `DatabaseSync`, so the reading
  includes the real transaction wrapper and claim checks.
- **Load.** Process A appends session-event batches shaped like a parallel
  subagent burst (N concurrent `appendAll` calls, N ∈ {1, 8, 32}). Process B
  does the same. A third configuration runs `readListing` and `readAll`
  against a seeded 10,000-row store (the record's §1 dataset) while B writes.
- **Instrument.** `perf_hooks.monitorEventLoopDelay({ resolution: 10 })` in
  process A, plus a span around each `Database` operation.
- **Report.** Max and p99 event-loop delay; per-operation p95 split into "time
  in busy wait" and "time executing". The split decides the stage. To get it,
  run once with `busy_timeout` at 5 s and once with it at 0 plus retry; the
  difference is the lock wait.
- **Hosts.** CLI (Node ≥ 22.19 floor), Electron main (desktop's pinned
  `electron ^44.4.3`), and the VS Code extension host on its current Electron.
  The delivery plan already warns that the CLI floor does not establish
  Electron compatibility.

**Proposed budget (unvalidated):** no host event-loop stall over **100 ms**
attributable to the database under the N = 8 load. The number is a starting
point for the owner to revise, not a claim.

**Decision rule:**

- Stalls within budget → close this note as not needed and record the reading.
- Over budget and dominated by busy wait → Stage 1.
- Over budget and dominated by statement execution, or Stage 1 still over
  budget → Stage 2.

## 4. Stage 1 (A0): short busy wait, bounded retry

Keep `busyTimeout: '5 seconds'` for `SqliteClient.make` and `configure`, where
the WAL ordering needs it. After `configure`, set the connection's
`PRAGMA busy_timeout` to a short slice (for example 20 ms). Wrap each **write
transaction** in `transactions('write')` (`Database.ts:440-497`) in an
`Effect.retry` whose schedule retries only `SQLITE_BUSY` / `SQLITE_LOCKED`,
exponential from 5 ms with jitter, capped so the total stays within the
current 5 s. Other fibers run between attempts; that is the whole point.

Why it is safe here:

- Every body passed to `transact` is database-only: SQL, Zod parsing of rows,
  and the in-transaction claim checks. The owner-liveness probes that spawn
  processes already run **before** the transaction
  (`acquireClaims` → `proveReclaimable`, `Database.ts:1003-1010`;
  `removeRun`, `Database.ts:1044`; cleanup, `Database.ts:1102-1110`). The
  delivery plan's rule "never replay a transaction body containing
  provider/tool work" holds by construction today; Stage 1 adds a
  kernel-architecture assertion so it keeps holding.
- `BEGIN IMMEDIATE` takes the write lock first, so a busy failure happens
  before any statement of the body has run. A retry replays nothing
  observable.
- The committed-wake finalizer only publishes on a successful exit
  (`Database.ts:449-463`), so a failed attempt publishes nothing.

What it does not fix: statement execution cost, and fairness. SQLite's own
busy handler also polls, so neither side is a queue; the harness should report
the worst writer's wait under N = 32, not only p95.

Size: one schedule, one error predicate, one pragma, one assertion. No new
file.

## 5. Stage 2 (A1): the connection in a worker

### 5.1 Shape

`databaseLayer(mode)` keeps its signature and its `Database` service shape
(`src/shared/session/database.ts:168-335`). For `persistent`, it spawns one
worker per database identity. That worker owns the `SqliteClient`, the schema,
`configure`, every transaction, and the `data_version` poll.
The layer becomes a client that forwards each service operation.
`ephemeral` (`:memory:`) keeps the in-thread connection: an in-memory
database cannot be shared across threads and is never contended.

The service surface is already message-shaped. Its six consumers
(`src/agent/runtime/SessionEvents.ts`, `src/agent/runtime/RunLedger.ts`,
`src/controllers/session/sessionLayer.ts`,
`src/controllers/session/sessionInputs.ts`,
`packages/desktop/src/main/desktopProjectRecords.ts`,
`packages/cli/src/chat/tui/history/inputHistory.ts`) call named operations
with data arguments. None holds a connection, none runs SQL, and no
production file outside `Database.ts` and `storeFormat.ts` imports
`SqlClient`. That is why the consumer diff should be zero and the change
stays inside `src/controllers/session/`.

### 5.2 Transport: Effect's own, not hand-rolled

The pinned Effect family already ships RPC over a worker:
`RpcClient.layerProtocolWorker` / `RpcServer.layerProtocolWorkerRunner`
(`effect/unstable/rpc`) over `NodeWorker.layer` / `NodeWorkerRunner.layer`
(`@effect/platform-node`, already a workspace dependency at
`4.0.0-rc.117`). It carries request IDs, interruption, stream responses and
typed errors. Using it keeps to AGENTS.md's rule of serializing async work
through Effect and adds no promise-chain protocol.

**Question for the owner (Q2):** RPC groups are declared with Effect `Schema`,
while the repo's schema single source of truth is Zod. Two ways to reconcile:
(a) the RPC payloads are the already-serialized forms (`JSON` strings for
drafts and rows, which `prepareEventDraft` and `decodeEvent` produce today),
declared as `Schema.String` plus a small number of scalar fields, with Zod
remaining the authority on both ends; or (b) accept Effect `Schema` at this
one internal wire. This note recommends (a): no second schema of any
session type, and the worker decodes nothing it does not already decode.

### 5.3 The four non-mechanical pieces

1. **Wake levels.** `level` and `observedCommit` are `SubscriptionRef`s
   consumers subscribe to (`src/agent/runtime/SessionEvents.ts:347`,
   `src/controllers/session/sessionLayer.ts:352`). The worker owns the
   finalizer and the poll, and pushes each change over one stream RPC. The
   client folds it into local `SubscriptionRef`s with the same names. The
   finalizer's rule stays: publish the committed high-water mark before the
   reserved connection is released. Only the transport of that publication
   changes, and a write's response is sent only after its wake is enqueued,
   so a caller never sees its own commit before its wake.
2. **`updateInquiryRecord` takes a closure** (`src/shared/session/database.ts:253`,
   sole caller `src/controllers/session/inquiryRecords.ts:30`). A function
   cannot cross a thread. Replace it with a compare-and-set: read the record
   and its `seq`, apply the transition on the caller's side, then call an
   `appendIfSeq(expectedSeq, draft)` operation that fails typed on mismatch,
   and retry. Alternatively keep `GlobalDatabase` in-thread for this stage;
   it carries application records only, at human rates. **Recommended:** keep
   the global database in-thread in Stage 2 and decide the compare-and-set
   only if Stage 0 shows the global root stalling.
3. **Liveness probes stay on the host.** `proveOwnerLiveness` needs
   `ChildProcessSpawner` and `ProcessProbe`. The worker must not spawn. The
   operations that probe are already structured as read → probe → transact
   (`acquireClaims`, `removeRun`, cleanup). Each becomes two RPCs, with the
   probe between them on the host, and the transact RPC re-verifies the
   observed rows exactly as `claimObserved` does today (`Database.ts:578-590`).
   No invariant changes; C5's "compare each stored owner with the owner whose
   liveness was probed" is already the contract.
4. **Typed errors.** `DatabaseNotOwner`, `DatabaseClaimRefused`,
   `DatabaseReadFailed`, `DatabaseWriteFailed` and `DatabaseOpenFailed` are
   `Data.TaggedError`s. Structured clone drops their class. They cross as RPC
   error schemas keyed by `_tag` and are reconstructed on the client, so
   `typedRefusal` (`Database.ts:571-575`) and every `catchTag` downstream
   keep working. `cause` fields cross as a message-and-name pair; a
   non-serializable cause is logged in the worker at `warn` before it is
   reduced, not dropped silently.

### 5.4 Shipping the worker file

No production code spawns a `Worker` today, so this is the first. Each of the
four bundles needs a second entry point and a way to find it at run time:

| Bundle       | Config                                  | Format          | Worker entry resolution                                    |
| ------------ | --------------------------------------- | --------------- | ---------------------------------------------------------- |
| Extension    | `packages/extension/esbuild.config.mjs` | CJS             | `path.join(__dirname, 'databaseWorker.js')`                |
| Desktop main | `packages/desktop/esbuild.main.mjs`     | ESM, splitting  | `new URL('./databaseWorker.js', import.meta.url)`          |
| CLI          | `packages/cli/scripts/build-bundle.mjs` | ESM single file | as desktop; check the `harness` variant too                |
| SDK          | `packages/agent/scripts/build.mjs`      | package build   | exported file path; an SDK consumer's bundler must copy it |

The worker's own entry calls `Effect.run*` once. The `effect-migration`
ratchet admits a new `Effect.run*` file only under
`packages/{extension,desktop,cli,agent}/src/`
(`scripts/check-effect-migration-ratchet.mjs`). The worker program itself
(the RPC handlers over the existing transaction code) lives in
`src/controllers/session/`, and the entry is one small file under
`packages/agent/src/` that every host bundles. **Question for the owner
(Q3):** confirm that placement, or name a boundary entry in
`BOUNDARY_RUNTIME_ENTRIES`.

Vitest cannot start a TypeScript worker without a loader. The in-thread
transport already exists for `ephemeral`, so kernel suites keep running the
same handlers in-thread. One E2E per host starts the real bundled worker, and
the desktop `stateStoreStartup` E2E
(`packages/desktop/tests/e2e/stateStoreStartup.spec.ts`) is the natural one to
extend. This is two permanent transports with production callers each, not a
test-only adapter.

### 5.5 What it costs and what it leaves

- **Files.** `Database.ts` (1,395 lines) splits into the worker-side
  program (schema, transactions, operations: today's body) and the client
  layer. Both stay under the `file-size-baseline` budget or shrink the
  current entry; neither widens it.
- **Latency.** One structured-clone hop per operation (tens of microseconds
  for the payload sizes here) replaces zero. Stage 0's harness is rerun after
  Stage 2 to show the per-operation p95 did not regress the §3 commit budget.
- **Memory.** One extra V8 isolate per open project (desktop can hold
  several, `packages/desktop/src/main/desktopProjects.ts`). Report the
  idle RSS delta in the Stage 2 PR.
- **Unchanged.** C1 schema, C5 claims, C6 validation, C7 reads, the
  one-publisher rule on the `SessionEvents` inbox (CLAUDE.md "One publisher,
  loop-owned cards"), `SESSION_EVENT_FORMAT`, the driver. The worker is the
  same single connection per identity, in another thread.

Rough size: 1–3 weeks of focused work across Stages 1 and 2, most of it
bundling and the four pieces in §5.3. This is an estimate from structure, not
a measured plan.

## 6. Considered and deferred: one background server (OpenCode V2's shape)

OpenCode runs one detached `opencode serve --register` process per user state
directory. It records `{ id, version, url, pid }` in `server.json`, and
`opencode service start` reuses a healthy server of the same version or
replaces it (`packages/cli/src/services/daemon.ts` in OpenCode). Desktop
discovers or starts it (`packages/desktop/src/main/background-cli.ts`) and
talks HTTP with a password from a `0600` file; the TUI is a client of the same
URL (`packages/cli/src/tui.ts`). Its database setup uses the same pragmas as
TeXRA: WAL, `synchronous = NORMAL`, `busy_timeout = 5000`
(`packages/core/src/database/database.ts:27-29`). The difference is that only
one process ever opens it.

It would give TeXRA what A0 and A1 cannot: no cross-process lock waits at all,
live cross-host views without the 250 ms poll, and handing a run from the TUI
to desktop without waiting for the owner to die. It is deferred because:

- TeXRA's hosts run the agent loop in-process and serve host-only
  capabilities as in-process ports: VS Code editor diffs and diagnostics,
  approval UI, SecretStorage, desktop dialogs. A server would need each one
  as a callback from server to client. OpenCode avoids this because its
  server owns every tool.
- VS Code Remote runs the extension host on the remote machine, so its server
  cannot be the one desktop uses locally.
- Lifecycle (discovery, start race, version replacement, crash, local auth)
  is new surface with no current owner.

What carries over if it is ever taken: A1's RPC group is a list of the
`Database` operations as request/response pairs. A server would serve the
same group over a socket instead of a worker port. Nothing in A0 or A1
needs to be undone to get there.

## 7. Non-goals

- Changing the ownership model (C5), including live handoff of a run between
  hosts.
- Replacing `@effect/sql-sqlite-node`, adding a VFS, or vendoring a driver (the
  September 8 ruling stands).
- A connection pool or concurrent readers inside one process. One connection
  per identity stays the rule; WAL already lets another _process_ read while
  one writes.
- A standing performance gate. Stage 0 is measure-once, like the record it
  extends.

## 8. Risks

- **Retry starvation (A0).** A writer that keeps losing the lock could wait
  near the cap every time. The N = 32 worst-writer reading exists to catch it.
- **Wake ordering (A1).** A response that overtakes its wake would let a
  reader see a commit its subscription has not yet reported. §5.3's rule
  (enqueue the wake, then respond, on one ordered port) prevents it. Keep a
  single regression test for this ordering, written from the failure mode
  before the code.
- **Worker crash (A1).** A dead worker must fail every pending and later
  operation with `DatabaseReadFailed`/`DatabaseWriteFailed`, loudly, and
  must not reopen silently. Recovery is a scope rebuild of the project, the
  same path as a failed open today.
- **Host runtime differences.** `node:sqlite` in a worker inside Electron's
  main process and inside the VS Code extension host is assumed, not verified.
  Stage 0 runs on all three hosts partly to verify it before Stage 2 is built.

## 9. Questions for the owner

- **Q1.** Reinstate one event-loop reading (§2), scoped to this decision and
  taken once?
- **Q2.** RPC payloads as the existing serialized strings with Zod as the
  authority, or Effect `Schema` at this internal wire (§5.2)?
- **Q3.** Worker entry under `packages/agent/src/`, or a named
  `BOUNDARY_RUNTIME_ENTRIES` entry (§5.4)?
- **Q4.** Keep `GlobalDatabase` in-thread through Stage 2 (§5.3, item 2)?
