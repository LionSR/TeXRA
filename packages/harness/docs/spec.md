# The durable protocol

This document specifies the durable protocol of `@texra-ai/harness`: what the
session store guarantees, what a run writes and when, how a run continues from
its rows, and what survives a crash. It describes the code as it is. It does not
describe planned behavior.

## Conventions

The key words MUST, MUST NOT, SHALL, SHALL NOT and MAY are used as in RFC 2119,
and only in capitals. Every sentence that uses one cites the code that enforces
it, as `path:line` or `path:first-last`.

Paths are relative to `packages/harness/src/` unless they start with
`src/test-kernel/` (the repository's test suite) or `.agents/` (the repository's
design notes). Line numbers follow the current tree:
`scripts/check-guidance-refs.mjs` fails a citation whose file is missing or
whose range runs past the end of it, but it cannot tell that a range still
holds what the sentence says, so a change to cited code updates the citation.

"The store" is the session database. "A row" is one record of its `event` table;
its kind is its `type` column.

## 1. Terms

- **Process**: One OS process with one process identity,
  `[hostname, pid, processStart]`, stamped on every row it writes
  (`shared/schemas/sessionEvent.ts:55-75`).
- **Storage root**: One directory holding one store file.
- **Session**: The process's handle on one storage root: its store connection,
  its one publisher, its fold and its live runs.
- **Aggregate**: A keyed sequence of rows. Kinds are `run` (keyed by run id) and
  `plugin` (keyed `<plugin>:<key>`) (`shared/schemas/sessionEvent.ts:103-112`).
- **Run**: One `run` aggregate. It exists while its `run.start` row exists and
  no `run.removed` has closed it (`controllers/session/Database.ts:648-657`,
  `:749-761`).
- **Turn**: One loop cycle, delimited by `turn.begin` and `turn.end`; usually
  one input answered by the model, but a script's handed-down call or a failed
  or cancelled invocation ends a turn with no answer
  (`agent/runtime/loop/toolUse.ts:275-281`, `:342-343`, `:502-505`).
- **Invocation**: One model call of a turn, a compaction summary or a helper,
  identified by `invocationId`; a helper's invocation lives in memory only and
  records no rows (`shared/schemas/runHistoryEvent.ts:49-52`,
  `agent/runtime/run/modelCall.ts:107-119`).
- **Attempt**: One try of an invocation, numbered from 1; `attempt` grows only
  for a retry of the same invocation (`shared/schemas/runHistoryEvent.ts:44-48`,
  `shared/session/inFlight.ts:111-118`).
- **Step**: One model call as the loop prepares it: its offered tools and system
  text, recorded on `tools.offered` when they change
  (`agent/runtime/loop/toolUse.ts:358-361`).
- **Response**: One completed provider turn, committed as a `model.message`
  `response` row with a minted `responseId`
  (`shared/schemas/runHistoryEvent.ts:188-206`).
- **Tool call**: One local call of a response, keyed by its `callId`; a call a
  `script` call's guest issued; or a script-configured run's handed-down call,
  which its opening `model.message` `handed-down` carries
  (`shared/schemas/runHistoryEvent.ts:348-369`).
- **Request**: A decision that may wait on a person: a `request.opened` row,
  closed by one `request.decided` row; an approval policy that answers at once
  commits both in one batch (`shared/schemas/sessionEvent.ts:373-386`,
  `agent/runtime/requestPolicy.ts:340-352`).
- **Claim**: The write authority over one aggregate: the `owner_id` column of
  its sequence row (`controllers/session/storeSchema.ts:54-65`).
- **Fold**: `applyRunRows`, the pure function from a run's rows to the
  `RunState` the loop continues from (`shared/session/runState.ts:533-546`).
- **Publisher**: `SessionEvents`, the one inbox through which a session writes
  (`agent/runtime/SessionEvents.ts:219-371`).
- **Commit, seq**: `commit` orders rows across the store; `seq` orders rows
  within an aggregate (`controllers/session/storeSchema.ts:70-80`).

## 2. The store

### 2.1 One file per storage root

The store is one SQLite file named `texra.db` under the storage root
(`controllers/session/Database.ts:107`, `:200-203`); the file name and the
application id (`TeXR`) carry the product's name. An ephemeral session runs the
same schema in memory (`controllers/session/Database.ts:200-214`).

The store MUST carry application id `0x54655852` and schema version 101 in
SQLite's `user_version` (`controllers/session/storeSchema.ts:31-37`,
`:263-264`). A process MUST refuse, unchanged, a file with another application
id or a schema stamp at or above 101 other than its own
(`controllers/session/storeSchema.ts:202-215`). A store stamped below 101 that
holds tables of the pre-1.0 format SHALL be copied whole to the first free
`<file>.pre1` name and started fresh; nothing in it is read again
(`controllers/session/storeSchema.ts:269-288`). A file SQLite reports damaged at
open SHALL be moved, with its WAL and shared-memory files, to
`<file>.corrupt-<ms>`, and a fresh store opened in its place
(`controllers/session/storeSchema.ts:372-409`).

A persistent store runs in WAL mode with `synchronous = NORMAL` and foreign keys
on (`controllers/session/storeSchema.ts:241-248`). Every write transaction the
database's transaction wrapper runs MUST begin with `BEGIN IMMEDIATE`
(`controllers/session/Database.ts:394-401`). File maintenance runs outside it:
the one-time `VACUUM` at setup, page reclaim in autocommit `incremental_vacuum`
steps, and the `VACUUM INTO` copy a store moved aside takes, none of which
writes a row (`controllers/session/storeSchema.ts:180-184`, `:316`,
`controllers/session/storeAside.ts:133-149`).

### 2.2 The event table and the envelope

Rows live in one table, `event`, keyed by `commit`, unique on `(aggregate, seq)`
(`controllers/session/storeSchema.ts:70-80`). Each row carries an envelope that
the store stamps and no caller supplies:

- `commit`: SQLite `AUTOINCREMENT` key: strictly increasing across the store,
  never reused (`controllers/session/storeSchema.ts:71`).
- `seq`: Dense from 1 per aggregate (`controllers/session/Database.ts:118-125`).
- `origin`: The writing process's identity, not the claim holder's
  (`controllers/session/Database.ts:704-712`).
- `at`: Publish clock in whole milliseconds, one value for a whole batch;
  informational only (`controllers/session/Database.ts:994-1000`).

The first row of a `run` aggregate MUST be its `run.start`, and seq 1 MUST NOT
hold any other row (`controllers/session/Database.ts:648-657`). A child's
`run.start` MUST name an open parent; the store stamps the parent's incarnation
`uid` in the child's creation transaction
(`controllers/session/Database.ts:666-688`). A `run.removed` row closes its
aggregate and every dependent; it requires this process's claim on every open
dependent, and a row MUST NOT be appended to a closed aggregate
(`controllers/session/Database.ts:118-125`, `:749-761`).

A payload string of 4096 or more characters is stored once per store as a zstd
blob under the sha256 of its JSON text; the row keeps a reference, and the read
verifies the digest (`controllers/session/rowCodec.ts:196-202`, `:252-254`).

### 2.3 One publisher

Every row a session writes is written by a job on one inbox drained by one
fiber. Claims are not rows: a hold inside a job takes its claim in that job's
transaction, a hold outside one in a write transaction of its own, and either is
released in the transaction of the scope that closes it, which need not be a job
(`controllers/session/sessionStore.ts:143-202`). Jobs SHALL run in the order
they were enqueued, one at a time, and the table's commit order is that order
(`agent/runtime/SessionEvents.ts:241-249`). A job other than an ordering barrier
(`transact(job, order)`, below) is one SQLite transaction: its appends commit
together or not at all (`agent/runtime/SessionEvents.ts:234-240`,
`controllers/session/Database.ts:976-990`).

The publisher offers these doors:

- `transact(job)`: Enqueue a job and wait for its value
  (`agent/runtime/SessionEvents.ts:294-310`).
- `transact(job, order)`: A barrier with no transaction; its `append` is a
  defect (`agent/runtime/SessionEvents.ts:193-195`, `:237-239`).
- `detach(job)`: Enqueue a job and return at once, for a producer with no fiber;
  its order is the moment of the call
  (`agent/runtime/SessionEvents.ts:320-343`).
- `removeRun`: Prove owners, then commit a run's tombstone as the next job
  (`agent/runtime/SessionEvents.ts:311-319`).
- `drain`: End the inbox and run what it holds within the close deadline of
  5,000 ms (`agent/runtime/SessionEvents.ts:252-290`,
  `agent/runtime/SessionHandle.ts:408`).

A job MUST NOT wait on its own publisher; doing so is a defect
(`agent/runtime/SessionEvents.ts:197-202`, `:299`). A job MAY run again whole
when SQLite reports the database busy, so a job body MUST be database-only
(`controllers/session/Database.ts:426-444`). Effects a job schedules with
`afterCommit` SHALL run only after its transaction commits, never for an attempt
that rolled back (`shared/session/sessionEvents.ts:53-85`). At the close
deadline the running job is cut and every queued job refused
(`agent/runtime/SessionEvents.ts:263-288`). An awaited job enqueued after close
is a defect; a detached one is logged and dropped
(`agent/runtime/SessionEvents.ts:304-308`, `:337-342`).

Above the publisher, the session's own door (`SessionLog.transact`) SHALL return
only after the session's fold has folded every commit the job made
(`controllers/session/sessionStore.ts:254-263`). A claim a failed transaction
took is released best effort: a refused release is logged and the claim stays
until another process proves this one dead
(`controllers/session/sessionStore.ts:222-234`, `:261`). A trace row emitted on
its own reaches the publisher through `SessionLog.publish`
(`agent/runtime/SessionHandle.ts:97-100`); a call's card rows and a turn's
closing rows commit inside the run's own batches instead
(`agent/runtime/loop/toolUseDispatch.ts:548-551`,
`agent/runtime/loop/toolUse.ts:502-505`). `SessionLog.settled` is the barrier
after every job enqueued before it
(`controllers/session/sessionStore.ts:305-307`).

### 2.4 Row versions and the store gate

Each row kind carries its own version (`shared/schemas/rowVersions.ts:72-152`).
A row MUST be written at its kind's current version
(`controllers/session/rowCodec.ts:173-178`). The `stored_kind` table records the
highest version each kind was written at
(`controllers/session/Database.ts:581-582`).

The store gate refuses a store that names a core kind this build lacks, or a
known kind at a version above the one this build reads
(`controllers/session/rowCodec.ts:373-399`). A plugin kind whose plugin this
build lacks passes the gate; its rows are left out of every read (below). The
gate MUST run at open and inside every outermost transaction that writes or
derives rows, so no build opens a store holding core rows it cannot read, or
writes beside them (`controllers/session/Database.ts:273`, `:426-442`).
Releasing claims is the one write it skips: it writes no row and only gives back
this process's claims (`controllers/session/Database.ts:426-430`, `:967-975`). A
core kind this build lacks and never retired counts as newer
(`controllers/session/rowCodec.ts:375-381`). Kinds a build deleted are listed as
retired; their rows fail only their own run's reads
(`shared/schemas/rowVersions.ts:44-56`, `controllers/session/rowCodec.ts:288`).

Before 1.0 a core kind changes with no upcaster. Its version is bumped when an
older build's row would read wrong (`shared/schemas/rowVersions.ts:72-152`). A
plugin's arm versions its own `value` and may carry upcasters for it
(`tools/plugins.ts:78`, `controllers/session/rowCodec.ts:330`). A row is then
classified by the reader (`controllers/session/rowCodec.ts:269-335`):

- **above the kind's current**: `DatabaseStoreNewer`
  (`controllers/session/rowCodec.ts:291-292`)
- **below the lowest readable**: `DatabaseRowEarlier`, the run listed as an
  earlier build's (`controllers/session/rowCodec.ts:293-296`)
- **readable, payload fails parse**: `DatabaseRowCorrupt`, naming its commit
  (`controllers/session/rowCodec.ts:309-321`)
- **a plugin kind this build lacks**: left out of every read, kept in the store
  (`controllers/session/rowCodec.ts:327-328`)

A read of one run's whole history MUST fail on any row of the aggregate that
does not decode; a read of its records fails on any undecodable row among the
rows it selects, and on any earlier build's row anywhere in the run, selected or
not (`controllers/session/rowReader.ts:167-168`, `:273-298`). A listing or a tail
leaves an earlier build's or a corrupt row out with one warning; when the row is
on a `run` aggregate it also marks that run unreadable and replaces a damaged
`run.start` with a bare one of `unknown` identity, so the run still lists
(`controllers/session/rowReader.ts:309-310`, `:323-339`), and a bad row on a
`plugin` aggregate marks no run (`controllers/session/rowReader.ts:299-308`); a
row of a known kind at a version above this build's fails any read that selects
it, listing and tail included, because it means a newer build now writes this
store; a read whose query does not select that row (a display tail of display
kinds, a listing of listing rows) can still succeed, while writes and projection
catch-up stay gated (`controllers/session/rowReader.ts:297-298`). Reads do not
run the gate: a row of a core kind this build lacks, written by a newer build
after this one opened the store, reads as corrupt until the next write's gate
refuses the store; a plugin kind whose plugin this build lacks is left out of
reads and passes the gate (`controllers/session/rowCodec.ts:288`,
`controllers/session/Database.ts:431-442`). A run whose rows do not decode
cannot be opened or resumed (`shared/session/runHistory.ts:140-146`,
`agent/runtime/resumeRun.ts:251-252`).

## 3. Row kinds

The vocabulary is one Effect Schema union, `SessionEventDraftSchema`, built
from three groups (`shared/schemas/sessionEvent.ts:441-445`). The groups below
follow it. A "folded" kind is one `applyRunRows` reads
(`shared/session/runState.ts:343-472`,
`shared/session/turnRowHandlers.ts:161-256`, `:268-372`); every other kind on a
run aggregate is ignored by name, and an unknown kind is refused
(`shared/session/runState.ts:166-202`, `:496-499`).

### 3.1 Run history rows (private to the runtime)

Read through the run history, and by the store's usage projection, which turns
the priced usage on `response` and `context.edit` rows into a projected `usage`
row (`controllers/session/projections.ts:101-120`, `:140-159`), and by the
display reader, which selects `tool.result` to fill the adjacent `tool.end`
card's result before it drops the private row
(`controllers/session/rowCodec.ts:83-83`,
`controllers/session/rowReader.ts:341-363`). The private rows themselves are
never sent to a renderer (`shared/schemas/sessionEvent.ts:412-440`).

- `model.message` (folded: yes): One arm per invocation fact: `attempt`,
  `identified`, `accepted`, `cancelled`, `failed`, `response`, `handed-down`,
  `append` (`shared/schemas/runHistoryEvent.ts:136-235`).
- `context.edit` (folded: yes): Replaces messages `[from, to)` of the model's
  view; cause `compaction` or `fork`
  (`shared/schemas/runHistoryEvent.ts:315-338`).
- `tool.intent` (folded: yes): The point after which a call's body may have run,
  at an attempt number; it commits just before the body starts, so it does not
  prove the body ran (`shared/schemas/runHistoryEvent.ts:384-391`,
  `agent/runtime/loop/toolUseDispatch.ts:542-559`).
- `script.call` (folded: yes): A call a `script` guest issued, with its
  arguments (`shared/schemas/runHistoryEvent.ts:348-369`).
- `tool.result` (folded: yes): A call's one settlement and its disposition
  (`shared/schemas/runHistoryEvent.ts:400-449`).
- `tools.offered` (folded: yes): The step's offered tools, system text and
  hooks, when they changed (`shared/schemas/sessionEvent.ts:424`).
- `context.blob` (folded: yes): Model-facing content stored by sha256 address
  (`shared/schemas/sessionEvent.ts:425`).
- `hook.outcome` (folded: yes): A hook point's recorded outcome; a recorded
  point never runs again (`shared/session/runState.ts:464-471`).
- `child.turn` (folded: no): A child loop's turn identity and fate, `accepted`
  or `settled` (`shared/schemas/sessionEvent.ts:435-439`).

The `model.message` arms:

- `attempt`: A billed request is about to leave; names its recorded request by
  sha256 and its origin.
- `identified`: The provider's response id, seen before completion.
- `accepted`: A background operation the provider accepted, with its admitted
  deadline.
- `cancelled`: A user stop the provider confirmed for an accepted operation.
- `failed`: The attempt failed, or its outcome is unknown: a person-admitted
  attempt found with no outcome on resume is re-asked under a `failed` row
  (`agent/runtime/ModelInvoker.ts:737-752`). Carries its error and the move
  after it (`retry`, `unchain`, `ask`, `stop`, `cancel`).
- `response`: The completed turn, its dispatch facts per call, and its priced
  usage.
- `handed-down`: The one call a script's run opens on; no model made it.
- `append`: Messages added to history; with `sourceResponse`, the tool group
  that delivers a response.

### 3.2 Run records (private to the runtime)

`run.report` holds the run's report text, `run.result` its result metadata, and
`followup.closed` marks its input closed until the run's next `run.activate`
reopens it (`shared/schemas/sessionEvent.ts:404-411`,
`agent/followUp/Inbox.ts:38-41`, `:361-371`); taking the run's claim does not.

### 3.3 Display rows (session-authored and run-authored)

Every renderer folds these (`shared/schemas/sessionEvent.ts:294-403`; the list's
line numbers are in that file). Kinds marked "folded" are also read by
`applyRunRows`.

- `run.start` (folded: no): The run's existence: identity, parent edge,
  provenance, launch approval policy (`:251-265`).
- `run.activate` (folded: yes): One activation: the first launch or a resume
  (`:303-305`).
- `run.config` (folded: yes): What the run runs on: configuration, model,
  binding (`:306-310`).
- `run.model` (folded: no): A model switch; projected by the store, never stored
  (`:311`).
- `run.detach` (folded: no): A stop severed the parent edge (`:312-314`).
- `run.end` (folded: no): The terminal fact: outcome, classified error, output
  (`:315-322`).
- `conversation.progress` (folded: no): Conversation progress (`:323`).
- `run.fact` (folded: no): One family of run facts, latest per key (`:324`).
- `child.park` (folded: no): A child loop's park: `parked`, `resumed`, `paused`
  (`:325-341`).
- `run.removed` (folded: no): The tombstone: last row of its aggregate, final
  (`:268-270`).
- `run.description` (folded: no): A title, by `model` or `user` (`:343-348`).
- `plugin.fact` (folded: no): A plugin's own kind; core never reads `value`
  (`:280-292`).
- `followup.queued` (folded: no): Input not taken yet, whole (`:350-365`).
- `followup.consumed` (folded: no): A queued follow-up was taken: delivered as a
  turn's message, answered by a tool, or retired as a control or with the run's
  end (`:366-368`).
- `request.opened` (folded: yes): A run asks a person (`:369-376`).
- `request.decided` (folded: yes): The answer (`:377-386`).
- `approval.policy` (folded: no): A change of the run's approval policy
  (`:387`).
- `run.position` (folded: yes): Where the loop stands (`:388-394`).

The transcript tier is display rows too (`shared/schemas/traceEvent.ts:22-88`):
`log`, `stage.start`, `stage.end`, `tool.start` (a call's card opens),
`tool.end` (it closes), `usage` (one priced turn; a run with a run history
stores none), `context.state`, `stream.start`, `stream.end`, and
`response.finalized` (the final text of one provider response; a loop turn that
asks for its final tool may record another,
`agent/runtime/loop/toolUse.ts:306-318`). `response.finalized` is read by the
fold, which marks that response's answer final
(`shared/session/runState.ts:387-390`).

Streamed text (`stream.chunk`) is transient. It is not an arm of the vocabulary
and never a row (`agent/runtime/loop/toolUseDispatch.ts:500-518`).

## 4. Write points

A run's history is written through its run cell, `RunCell.append`, which commits
one batch per call (`agent/runtime/RunHistory.ts:388-399`). The loop's write
points are normative:

- **W1**, `model.message` `attempt`: for a turn or a summary, commits before the
  billed request leaves the process (`agent/runtime/ModelInvoker.ts:480-502`;
  summary: `:789-801`).
- **W2**, `model.message` `response`: commits, with `run.position`
  `response.ready`, before any tool call dispatches
  (`agent/runtime/ModelInvoker.ts:366-382`;
  `agent/runtime/loop/toolUse.ts:329-336`).
- **W3**, `tool.intent`: commits after PreToolUse hooks and the guard, before
  the body runs, once per attempt
  (`agent/runtime/loop/toolUseDispatch.ts:527-559`;
  `agent/runtime/loop/toolGuard.ts:119-129`).
- **W4**, `tool.result`: commits, with the call's card rows, before the delivery
  that lets the loop continue (`agent/runtime/loop/toolUseDispatch.ts:382-408`,
  `:660-684`, `:1107-1111`).
- **W5**, `run.position`: commits at every loop-boundary wait and every halt; a
  request's wait keeps the position in force and writes `request.opened` instead
  (`agent/runtime/loop/toolUse.ts:250`, `:279-281`, `:448`, `:502-513`;
  `agent/storage/runLifecycle.ts:243-277`).
- **W6**, `model.message` `failed`: for a turn or a summary, commits for every
  recorded failure, naming the next move
  (`agent/runtime/ModelInvoker.ts:616-676`, `:708-710`;
  `agent/runtime/run/invocation.ts:383-393`).
- **W7**, `request.opened` / `request.decided`: the opening commits before any
  wait; a decision commits once (`agent/runtime/requestPolicy.ts:271-289`,
  `:340-352`).

**W1.** The invoker MUST commit the attempt's rows, the blobs of its request
context and the `attempt` row, before it streams or submits the request
(`agent/runtime/ModelInvoker.ts:480-502`,
`agent/runtime/run/requestContext.ts:139-167`). A compaction summary records its
attempt the same way, with `purpose: 'summary'`
(`agent/runtime/ModelInvoker.ts:772-819`). A helper call belongs to no run
history and records no row, its attempts and failures included
(`agent/runtime/run/modelCall.ts:66-67`, `:142-144`, `:166`).

**W2.** A completed provider turn of a loop invocation (one invocation's answer;
a loop turn may hold none, or several as the loop calls the model again after
tool results) MUST commit once, as one `response` row with a fresh `responseId`,
in the batch that moves the position to `response.ready`. It carries one
dispatch fact per local call the harness dispatches; an editor's language-model
turn carries none, because its host runs its calls
(`agent/runtime/run/tools.ts:59-60`) (`agent/runtime/ModelInvoker.ts:359-382`,
`shared/schemas/runHistoryEvent.ts:236-296`). The loop MUST dispatch only the
pending response its fold holds (`agent/runtime/loop/toolUse.ts:329-336`). W2
does not cover a compaction summary, whose answer its caller lands as a
`context.edit`, or a helper call, which records no row (W1).

**W3.** A call's `tool.intent` MUST commit after its PreToolUse hooks and its
guard, and before its body (`agent/runtime/loop/toolUseDispatch.ts:527-559`,
`agent/runtime/loop/toolGuard.ts:119-129`). The guard asks for a command's
approval (`agent/runtime/loop/toolGuard.ts:40-47`, `:103-113`). A slow tool's
`tool.start` card MUST commit in the intent's batch
(`agent/runtime/loop/toolUseDispatch.ts:548-551`). An attempt whose intent is
already committed MUST NOT commit another
(`agent/runtime/loop/toolUseDispatch.ts:547`).

**W4.** A call that settles from its body MUST commit its `tool.result` with its
whole card: a slow tool's `tool.end`, a fast tool's `tool.start` and `tool.end`
(`agent/runtime/loop/toolUseDispatch.ts:435-455`, `:647-650`). A body
interrupted or cut by a crash commits no result; a resume settles it (section 9,
"`tool.intent`, no result"). A synthetic settlement of a call no body started (a
call skipped by a replan, a duplicate, a call after the turn ended) commits its
`tool.result` with no card (`agent/runtime/loop/toolUseDispatch.ts:388`, `:706`,
`:988-999`); one that settles a started call as outcome unknown commits its
card's close, and its open for a fast tool
(`agent/runtime/loop/toolUseDispatch.ts:713-718`). The delivering `append` MUST
commit only once every call of the response has settled, as one tool group bound
to the response (`agent/runtime/loop/toolUseDispatch.ts:1107-1111`). A delivery
its settlements do not match is a defect
(`agent/runtime/RunHistory.ts:260-262`).

**W5.** The positions are `turn.ready`, `turn.begin`, `response.ready`,
`results.ready`, `turn.end`, `waiting` and `halted`
(`shared/schemas/runHistoryEvent.ts:83-91`). A `halted` position MUST carry an
outcome, and every other position MUST NOT carry one
(`shared/schemas/runHistoryEvent.ts:106-109`). The `halted` position MUST commit
in the same batch as the run's `run.end`
(`agent/storage/runLifecycle.ts:243-277`, `agent/runtime/loop/rows.ts:66-79`). A
run whose history does not load ends with its `run.end` and no `halted`
position, with a warning (`agent/storage/runLifecycle.ts:284-288`). A child the
child loop drives has no run history and writes no position; it parks on
`child.park` rows (`shared/schemas/sessionEvent.ts:325-341`).

**W6.** Every failed attempt of a turn or a summary that reaches failure
recording MUST commit a `failed` row whose `next` is the move after it; a
renewed observation of an accepted operation repeats without one (section 6),
and a helper call records none (`agent/runtime/run/modelCall.ts:166`)
(`agent/runtime/run/invocation.ts:383-393`,
`agent/runtime/ModelInvoker.ts:616-633`). A `failed` row that asks MUST be
preceded, in its batch, by the `request.opened` of its retry request
(`agent/runtime/ModelInvoker.ts:664-675`, `shared/session/runHistory.ts:183`).

## 5. The fold

### 5.1 `RunState`

`RunState` is what the loop continues from: the position, the run's facts, the
canonical message history, the open invocation, the pending response, the
requests, and the offered tools and contents
(`shared/session/runState.ts:93-148`). It has no schema and is never persisted
(`shared/session/runState.ts:88-92`).

### 5.2 Grammar

`applyRunRows(state, rows)` folds rows in order
(`shared/session/runState.ts:533-546`). It MUST refuse a row whose commit is not
above the last folded one (`shared/session/runState.ts:495-499`). Each folded
kind has one handler in a table keyed by row type: the state it requires (any
state, an existing one, or an opened run) and its move
(`shared/session/runState.ts:293-310`, `:343-472`). A handler that requires an
opened run refuses a row before the opening `run.position`
(`shared/session/runState.ts:506-510`). Every other row kind is listed by name
as one the fold skips, so a kind in neither list is refused as `unknown-run-row`
and a new kind does not compile until it is placed
(`shared/session/runState.ts:166-202`, `:496-499`). A refusal is a typed
`RunHistoryInconsistent` with a reason: `out-of-order`, `orphan-settlement`,
`unknown-run-row`, `mismatched-delivery` or `unreadable-turn`
(`shared/session/runState.ts:75-86`). The fold never defaults a row it cannot
apply (`shared/session/runState.ts:525-534`).

A run is opened by its first `run.position`. Run history rows without an opening
position MUST fail the load as `inconsistent`
(`agent/runtime/RunHistory.ts:212-221`).

### 5.3 Phases

The fold maps a position to a loop phase: `turn.ready` and `waiting` to
`waiting`, `turn.begin` to `model.ready`, `response.ready` to `model.submitted`,
`results.ready` to `results.ready`, and `turn.end` to `halted`
(`shared/session/runRows.ts:97-110`).

A `halted` position keeps the phase the loop stopped in, so a resume continues
from there (`shared/session/runRows.ts:110`).

### 5.4 The commit path

`RunCell.append` MUST fold the batch onto the cell's state before it publishes,
and MUST refuse, with nothing committed, a batch the fold rejects
(`agent/runtime/RunHistory.ts:257-263`). It MUST check the assembled message
history against `PreparedHistorySchema` from where the batch changes it
(`agent/runtime/RunHistory.ts:264-277`). It MUST refuse a durable model origin
carrying userinfo, a query string or a fragment
(`agent/runtime/RunHistory.ts:249-256`). After the commit it folds the committed
rows, at the commits the store assigned, and that state is the one the loop
continues from (`agent/runtime/RunHistory.ts:301-307`). The read-append-fold
region is uninterruptible and serialized per cell
(`agent/runtime/RunHistory.ts:388-399`); rows another writer commits to the run
(a decision, a run's end through a cell of its own) are ordered by the
publisher, and a cell folds them on `refresh`
(`agent/runtime/RunHistory.ts:400-406`,
`agent/storage/runLifecycle.ts:276-278`).

A batch that carries a `context.edit` with a `response` MUST place the edit
immediately before the response, and an edit MUST be the first message-bearing
row of its batch (`agent/runtime/RunHistory.ts:72-83`).

### 5.5 Resume is the same function

The loop holds no copy of the conversation. It reads every branch off the fold,
so the live path and the resume path are the same steps
(`agent/runtime/loop/toolUse.ts:413-426`, `:428-482`). A resume enters the same
program, `runToolUse`, with `resume: true`
(`agent/runtime/executeAgent.ts:128-138`), reached from `resumeRun` through
`resumeToolUseFromResumeData` (`agent/runtime/resumeRun.ts:315-319`,
`agent/runtime/executeAgent.ts:359-362`).

A resume MUST be refused when the rows hold no opened run
(`agent/runtime/loop/runProgram.ts:81-87`). A fresh launch MUST be refused when
the run already holds history state (`agent/runtime/loop/runProgram.ts:96-101`).

## 6. Retry

Every model call the harness makes MUST go through one loop, `runInvocation`
(`agent/runtime/run/invocation.ts:355-395`; callers
`agent/runtime/ModelInvoker.ts:682`, `agent/runtime/run/modelCall.ts:119`). Its
next move is `nextAttempt(invocation, requests)`, read off the invocation's rows
before every move but the repeat of a renewed observation
(`agent/runtime/run/invocation.ts:367-369`, `:384-387`,
`shared/session/inFlight.ts:203-238`):

| Rows show                                                        | Move                                        |
| ---------------------------------------------------------------- | ------------------------------------------- |
| no open invocation                                               | send attempt 1                              |
| open attempt, no outcome, an accepted operation                  | observe it; never resubmit                  |
| open attempt, no outcome, an earlier `failed` row asked a person | ask again (`reask`)                         |
| open attempt, no outcome, otherwise                              | send the next attempt                       |
| `failed` with `retry` or `unchain`                               | send the next attempt                       |
| `failed` with `stop`                                             | end the invocation failed                   |
| `failed` with `cancel`                                           | end the invocation cancelled                |
| `failed` with `ask`, request undecided                           | wait for the decision                       |
| `failed` with `ask`, decided `retry`                             | rebind on the chosen credentials, then send |
| `failed` with `ask`, decided `deny`                              | end the invocation failed                   |
| `failed` with `ask`, any other decision                          | end the invocation cancelled                |

The move a `failed` row records is decided once, by `failedNext`
(`shared/session/inFlight.ts:259-278`), except for two rows that name their move
themselves: a renewed credential's resend, `retry`
(`agent/runtime/run/invocation.ts:343-346`), and a re-ask, `ask` under a fresh
request id (`agent/runtime/ModelInvoker.ts:737-753`):

- A `continuation-gone` failure of an attempt that sent a continuation answers
  `unchain`, once per invocation (`shared/session/inFlight.ts:265-270`,
  `agent/runtime/run/invocation.ts:292-296`).
- A retryable failure answers `retry` while the invocation's earlier failures,
  `unchain` ones excluded, are fewer than the budget
  (`shared/session/inFlight.ts:81-89`, `:271-274`). Every earlier failure
  counts, whichever move followed it: one that a person's retry admitted spends
  the budget as an automatic resend does, and an attempt with no recorded
  failure spends none. For a turn's invocation the budget is counted from rows,
  so a crash does not refill it. A compaction summary or a helper call holds its
  invocation in memory (`agent/runtime/run/modelCall.ts:107-123`); a summary's
  `attempt` and `failed` rows are an audit the run fold skips
  (`shared/session/turnRowHandlers.ts:273-283`, `:374-379`), so a resumed
  summary starts a fresh budget.
- Past the budget, a failure a person may retry answers `ask` under a fresh
  request id; where nobody can be asked, `stop`
  (`shared/session/inFlight.ts:275-277`).
- A failed observation of an accepted operation never resubmits it automatically
  (`agent/runtime/run/invocation.ts:292-301`). The one automatic repeat is a
  renewed observation after a rejected subscription token, which observes the
  same operation again (`agent/runtime/run/invocation.ts:336-346`, `:383-386`).

Every automatic send MUST run under the process's `ModelRetryGate`
(`agent/runtime/run/invocation.ts:42-47`, `:205-221`). The gate cools two keys
per binding: a 429 the provider scoped to the model cools that model on its wire
route, and a failure scoped to the route cools the wire route itself, which
every model on that route shares. The wire key is the binding's own tuple:
provider, credential route, endpoint and key fingerprint for a credential-backed
HTTP route; vendor and version for an editor's language-model route; provider
for the validation model (`agent/runtime/modelAccess/binding.ts:152-155`,
`:195`) (`agent/runtime/modelAccess/failureInfo.ts:125-159`). An observation
runs outside it (`agent/runtime/run/invocation.ts:222`). The loop pauses 1,000
ms before a `retry` or `unchain` that follows a recorded failure
(`agent/runtime/run/invocation.ts:50`, `:257-274`, `:388-393`); a resend after a
crash, of an attempt no row recorded an outcome for, goes out without it.

An attempt of an invocation a person admitted, whose outcome no row recorded and
which holds no accepted operation, MUST be asked about again and MUST NOT be
resent unasked (`shared/session/inFlight.ts:211-217`); one that holds an
accepted operation is observed (`shared/session/inFlight.ts:211-212`). The ask
is a new `failed` row on that attempt, with `next: ask`
(`agent/runtime/ModelInvoker.ts:737-753`). An attempt no person admitted, whose
outcome no row recorded, is resent (`shared/session/inFlight.ts:217`).

A rejected subscription token MAY be renewed once per execution of
`runInvocation` (`agent/runtime/run/invocation.ts:152-175`, `:362`). The limit
is held in memory, not in a row, so a resume may renew the same invocation
again. On a send, the renewal records a `failed` row with `next: retry` (a
helper call records none) and the attempt is resent; while observing an accepted
operation, the renewed observation repeats with no row and is never a resend
(`agent/runtime/run/invocation.ts:336-348`, `:378-393`).

## 7. Claims and several processes

There is no daemon. Several processes MAY open one store at once; each holds its
own connection, publisher and fold, and sees the others' commits through a 250
ms poll of SQLite's `data_version` (`controllers/session/Database.ts:333-364`).

### 7.1 Claims

Each aggregate has at most one owner, the `owner_id` of its sequence row
(`controllers/session/storeSchema.ts:54-65`). The first append to an aggregate
creates it and claims it for the writer
(`controllers/session/Database.ts:118-125`). A later append MUST be refused with
`DatabaseNotOwner`, and nothing written, unless the writer holds the claim and
the aggregate is open (`controllers/session/Database.ts:118-125`, `:615-627`). A
`plugin.fact` on a `plugin` aggregate borrows an unheld claim for its own
transaction only (`controllers/session/Database.ts:595-598`, `:743-748`).

A process takes a claim in one write transaction that reads the claim state and
moves it (`controllers/session/Database.ts:882-900`). It MUST NOT take a claim
from another owner unless that owner is proven dead, or its liveness is
unprovable and the user is deleting a single run
(`controllers/session/storeAside.ts:70-84`,
`controllers/session/Database.ts:521-534`). The transaction reads the owners
itself; one it holds no verdict for rolls it back whole, is proven off the write
lock, and the transaction runs again with that verdict
(`controllers/session/storeAside.ts:86-111`). A live owner refuses with
`DatabaseClaimRefused`, and so does an unprovable one on every other path
(`controllers/session/storeAside.ts:79-83`).

Liveness is proven from the owner identity alone, with no clock
(`agent/storage/leaseOwnerLiveness.ts:42-90`):

| Observed                                     | Verdict      |
| -------------------------------------------- | ------------ |
| owner recorded on another host               | `unprovable` |
| `kill(pid, 0)` reports `ESRCH`               | `dead`       |
| pid exists, start identity equals the record | `alive`      |
| pid exists, start identity differs           | `dead`       |
| pid exists, start identity unreadable        | `unprovable` |

Releasing a claim sets `owner_id` to null where this process holds it, and
writes no row (`controllers/session/Database.ts:464-465`, `:967-975`).

### 7.2 Resume under a claim

A resume MUST hold the run's claim before it folds the run's history or decides
who owns the run, and holds it until the launched run holds its own
(`agent/runtime/resumeRun.ts:188-200`). Its earlier reads only refuse a run
whose records are gone, and one deleted or whose input closed while they ran
(`agent/runtime/resumeRun.ts:175-187`). A run another live process holds answers
`owned_elsewhere` (`agent/runtime/resumeRun.ts:196`). A second resume of a run
another resume in this process is already handling joins that resume and gets
its result (`agent/runtime/resumeRun.ts:6`, `:130`); otherwise a run live in
this process is refused (`agent/runtime/resumeRun.ts:174`). A child an open call
of its parent owns resumes through that parent
(`agent/runtime/resumeRun.ts:199-200`, `:104-114`).

The resume first takes the run's claim in its own transaction, before its
ownership, admission and blocker checks (`agent/runtime/resumeRun.ts:158-166`,
`:195`); a crash after it leaves the claim moved and no activation row. The
activation is then one transaction: it verifies the claim the process holds,
folds the stored rows, and commits the activation rows with a `request.decided`
`cancel` for every request the previous owner left unbound
(`agent/runtime/RunHistory.ts:338-368`). A request is unbound unless it is the
turn's open retry ask, the request a pending call's resumed attempt re-enters,
the request a pending `script` call's guest calls share (attempt 0), or an
`externalInquiry` (`shared/session/runState.ts:243-264`).

### 7.3 What a second process may and may not do

A process MAY:

- read every committed row its build can read, listing and tail
  (`controllers/session/Database.ts:775-881`)
- create a new run, which it then owns
  (`controllers/session/Database.ts:118-125`)
- fork a conversation another process holds, at a settled turn end
  (`controllers/session/SessionRequests.ts:160-163`,
  `agent/runtime/forkRun.ts:78-81`, `:92-122`)
- take over a run whose owner is proven dead
  (`controllers/session/storeAside.ts:70-84`)

A process MUST NOT:

- append to an aggregate another process holds
  (`controllers/session/Database.ts:615-627`)
- answer a request of a run a live process holds (`NotOwner`)
  (`controllers/session/SessionRequests.ts:159-171`)
- resume a run a live process holds (`agent/runtime/resumeRun.ts:195-196`)
- write rows to a store a newer build wrote (giving back its own claims is
  allowed) (`controllers/session/Database.ts:439-442`)

A run that loses its claim mid-run gets `RunHistoryRefused` `not-owner` from its
next append, with nothing written (`agent/runtime/RunHistory.ts:169-183`,
`:295-300`, `shared/session/runHistory.ts:101-127`). A tool call that meets a
storage refusal fails the dispatch instead of settling
(`agent/runtime/loop/toolUseDispatch.ts:598-600`).

## 8. Requests

### 8.1 Kinds

The request kinds are a closed union
(`shared/schemas/progressView/data.ts:160-180`):

| Kind              | Asks                                       | Parks its caller |
| ----------------- | ------------------------------------------ | ---------------- |
| `toolEdit`        | approval of a file edit                    | yes              |
| `bash`            | approval of a command                      | yes              |
| `retry`           | whether to retry a failed model attempt    | yes              |
| `proposal`        | approval of a proposed agent run           | yes              |
| `planApproval`    | approval of a plan                         | yes              |
| `externalInquiry` | an answer from an external model, as input | no               |
| `userQuestion`    | answers to questions                       | yes              |

Every kind parks its caller (the tool call that opened it, or for `retry` the
model invocation) except `externalInquiry`, whose answer arrives as a follow-up
(`shared/schemas/progressView/data.ts:196-200`).

### 8.2 Decisions

A decision is one of `approve`, `approve_and_goal`, `setup`, `submit`, `answer`,
`skip`, `retry`, `reject`, `deny` and `cancel`
(`shared/schemas/request.ts:20-55`).

### 8.3 Protocol

- A request's id is part of its payload (`agent/runtime/requestPolicy.ts:324`).
  A tool call's request id is derived from the response, call, attempt and
  ordinal, so a resumed attempt rejoins the request it left standing
  (`shared/session/inFlight.ts:309-312`).
- The opening and any decision the approval policy gives at once MUST commit in
  one batch, so no surface lists it pending
  (`agent/runtime/requestPolicy.ts:340-352`).
- A decision MUST commit only if its request is open and undecided; the first
  decision wins, and a later one writes nothing
  (`agent/runtime/requestPolicy.ts:271-289`).
- The asker waits on the committed `request.decided` row, read from the tail
  (`agent/runtime/requestPolicy.ts:291-317`). If the session closes first, the
  asker goes on as cancelled with no row written, and the request stays open
  (`agent/runtime/requestPolicy.ts:353-366`).
- An interrupted asker decides its request `cancel` through the same door,
  unless the session is closed. This is best effort: a write the session refuses
  (it is draining, or the claim is gone) is logged and leaves the request open,
  for the next resume to cancel as unbound
  (`agent/runtime/requestPolicy.ts:369-394`).
- A request is a row, so it outlives its process. A resume cancels the unbound
  ones (section 7.2) and re-enters the bound ones under the same id
  (`shared/session/inFlight.ts:347-371`). An open `externalInquiry` is neither:
  it parks no caller, so no attempt re-enters it and it is not unbound; it stays
  open until its `request.decided` commits, or until `run.removed` closes the
  run, which retires it with no decision row
  (`controllers/session/SessionRequests.ts:145-156`). Delivering the answer (or
  the drop) as a follow-up is a separate, best-effort step
  (`shared/session/runState.ts:243-264`).

## 9. Crash guarantees

The crash-point suite is the source of truth for this section
(`src/test-kernel/support/crashConformance.ts:1-55`). It runs under a full
app's plugins, which include every harness built-in
(`src/test-kernel/controllers/session/crashConformanceTexra.vitest.ts:9`).

Its method: drive a clean run over a real store, record the event commit each
event-writing transaction ended at (claim-only writes leave no distinct point;
the points are deduplicated by commit), and for each such commit N copy the
store, cut it to commits 1..N, hand its claims to a dead owner, reopen it in a
fresh session and resume the root run
(`src/test-kernel/support/crashConformance.ts:7-26`).

The guarantees, numbered as in the package README:

- **I1**: Under the suite's deterministic model, recovery reaches the clean
  run's outcome: its answers, view edits, call results, owned children and fork.
  Asserted by `src/test-kernel/support/crashConformance.ts:29-31`, `:756`.
- **I2**: A call settled before the crash is not executed again, and no call
  settles twice. Asserted by `src/test-kernel/support/crashConformance.ts:32`,
  `:756`.
- **I3**: One model invocation has at most one committed response. Asserted by
  `src/test-kernel/support/crashConformance.ts:37`, `:756`.
- **I4**: A command subject to approval runs only after its approval; an
  unfinished call that is not replay-safe and that recovery classifies as
  outcome-unknown runs again only after a person's retry (a call rejoining a
  standing or newly decided request runs at once, section 9). Asserted by
  `src/test-kernel/support/crashConformance.ts:33-34`, `:756`.
- **I5**: An owned child that ended cleanly answers its call; it is not launched
  again without a person's retry; no child is left without a terminal row,
  except one deliberately paused with a `child.park` `paused` row so it can be
  called again (`tools/delegation/childRun.ts:163-172`). Asserted by
  `src/test-kernel/support/crashConformance.ts:38-39`, `:867`.
- **I6**: A child's result is delivered to its parent at most once and is not
  lost while the parent was held elsewhere; a result whose child was detached,
  or whose parent cannot take it, stays in the child's run report with a warning
  (`agent/runtime/childTurnResult.ts:226-234`, `:259-265`). Asserted by
  `src/test-kernel/support/crashConformance.ts:859-880`.
- **I7**: A fork keeps the history it was registered with; compaction keeps
  the context it committed. Asserted by
  `src/test-kernel/support/crashConformance.ts:40`, `:756`.
- **I8**: A run's halt commits with its end; a stopped run never reads as
  interrupted. Asserted by `src/test-kernel/support/crashConformance.ts:42-43`,
  `:756`.
- **I9**: Turning off a run's shell bypass is acknowledged only after its row is
  durable. Asserted by `src/test-kernel/support/crashConformance.ts:52-53`,
  `:756`.

I1 is equality with a clean run because the suite's validation model is
deterministic. Against a live model, a resent attempt (section 6) may answer
differently; what recovery preserves is every committed row; it reaches a
terminal outcome once the provider answers or a person decides each request the
run opens, such as a retry request past the automatic budget. The suite also
asserts that a crash between a request and its answer leaves the request pending
and the resume answers that same request; that a crash between the answer and
the body honours the answer; and that a crash inside one publisher job leaves
neither half on disk (`src/test-kernel/support/crashConformance.ts:48-55`,
`:1114`).

What survives at each commit point follows from sections 2 to 8:

- `attempt`: The attempt has no outcome: resent, or asked again if a person
  admitted the invocation (section 6). A summary's attempt is not resumed: the
  summary starts a new invocation (section 6).
- `accepted`: The operation is observed under its recorded deadline, not
  resubmitted (`shared/session/inFlight.ts:211-212`).
- `response`: The response is reused; no new invocation is made for it
  (`agent/runtime/loop/toolUse.ts:329-340`).
- **a call's requests, no intent**: The call re-enters the request it asked
  (`shared/session/inFlight.ts:364-365`).
- `tool.intent`, no result: If the call opened a request that still stands, or
  one decided since this process activated the run, the call runs again and
  rejoins that request under its id (`shared/session/inFlight.ts:347-370`).
  Otherwise it is re-run only if both the stored and the current tool declare
  `replay: 'safe'` and the stored arguments validate; else settled as outcome
  unknown (`agent/runtime/loop/toolUseDispatch.ts:692-719`,
  `agent/runtime/run/tools.ts:107-138`).
- `tool.result`: The settlement is reused; the call is not run again
  (`agent/runtime/loop/toolUseDispatch.ts:986-987`).
- **delivery `append`**: The loop continues to the next step from
  `results.ready` (`shared/session/runRows.ts:97-105`).
- `request.opened`: The request stays pending under the same id, or is cancelled
  if unbound (section 7.2).
- `run.end` with `halted`: The lifecycle is over. A recipe task stays finished,
  and a resume answers `finished` (`agent/runtime/resumeRun.ts:203-206`); a
  loop-driven conversation continues on a resume in a new lifecycle, from the
  phase `halted` kept (`shared/session/runActions.ts:94-96`).

These are guarantees about committed state. An external effect that finished
before its result committed stays uncertain; I4 governs it, and the suite cannot
place a cut between an effect and its result. One real kill covers that case: a
process killed after its command's effect and before its result reports the
command as outcome unknown and never reruns it automatically; the model may
still issue a new command, which runs under I4
(`src/test-kernel/controllers/session/goldenStore.vitest.ts:666`).

## 10. Conformance

These existing suites check the sections above.

- **2.1 file and schema**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts:1479` (pre-1.0
  moved aside), `:1533`, `:1579` (foreign file refused), `:1613` (damaged file
  moved aside), `:1852` (newer schema refused)
- **2.2 envelope**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts:2058` (dense seq,
  one commit order), `:2097` (parent incarnation), `:2372` (ordinals never
  reused), `:2423` (blobs)
- **2.3 publisher**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts:414` (enqueue
  order), `:2311` (a rejected batch rolls back whole), `:1876`, `:1974`;
  `src/test-kernel/support/crashConformance.ts:1114` (one job, one transaction)
- **2.4 versions and gate**:
  `src/test-kernel/schemas/rowVersions.vitest.ts:114`, `:132`, `:166`;
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts:1646` (newer
  build refused), `:1724` (undecodable row), `:1793` (earlier build's row);
  `src/test-kernel/controllers/session/goldenStore.vitest.ts:216`
- **3 row kinds**:
  `src/test-kernel/controllers/session/goldenStore.vitest.ts:216` (every golden
  row decodes); `src/test-kernel/schemas/rowVersions.vitest.ts:114`
- **4 write points**: `src/test-kernel/support/crashConformance.ts:756`, `:1168`
- **5 fold**: `src/test-kernel/controllers/session/sessionEvents.vitest.ts:3318`
  (live state equals reloaded state), `:3350` (batch contract);
  `src/test-kernel/controllers/session/goldenStore.vitest.ts:389`
- **6 retry**: `src/test-kernel/agent/runtime/RetryState.vitest.ts:605`, `:683`,
  `:847` (asks again after a stop), `:921` (budget), `:979` (unchain once),
  `:1063`; `src/test-kernel/agent/runtime/ModelRetryGate.vitest.ts:119`
- **7 claims**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts:675`, `:896`,
  `:2599`, `:2838` (another OS process), `:2950` (dead owner reclaimed), `:3022`
  (second writer fenced); `src/test-kernel/agent/runtime/resumeRun.vitest.ts:97`
- **8 requests**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts:620`;
  `src/test-kernel/support/crashConformance.ts:48-51`
- **9 crash guarantees**:
  `src/test-kernel/controllers/session/crashConformanceTexra.vitest.ts`,
  `src/test-kernel/controllers/session/goldenStore.vitest.ts:666`

## 11. Non-goals

- **No daemon.** The CLI or SDK process is the unattended runner; the permanent
  shape is several processes on one store, each aggregate held by one claim
  (`.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md`,
  "No daemon; several processes on one store (D4)";
  `.agents/docs/implemented/architecture/2026-10-02-durable-harness.md`,
  "Considered and dropped").
- **No third-party code in process.** Third-party plugins are data, MCP servers
  and out-of-process hooks
  (`.agents/docs/implemented/architecture/2026-10-02-durable-harness.md`, "Owner
  rulings", item 1).
- **No second storage backend or dialect.** There is one SQLite store on purpose
  (`.agents/docs/implemented/architecture/2026-10-02-durable-harness.md`,
  "Considered and dropped").
- **Closed request kinds.** The request kinds of section 8.1 are fixed;
  typed-RPC code plugins and an open schema registry wait for a named plugin
  that cannot be MCP plus hooks plus data
  (`.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md`,
  "SDK and typed-RPC deferral (D11)").
- **No exactly-once external effects.** The protocol promises one settlement per
  call, not one execution of an arbitrary external effect (section 9).
- **No once-only billing.** The code resends an attempt that no person admitted
  and whose outcome no row recorded (`shared/session/inFlight.ts:217`); the
  earlier attempt may have been billed. The suite asserts at most one committed
  response per invocation (I3), not one billing.

## 12. Open questions

1. `packages/harness/AGENTS.md` says `tool.intent` commits after a call's hooks,
   guard and approval. The guard asks only for tools with a declared command
   guard or `requiresApproval`; a tool whose body opens its own request, such as
   a file edit's approval (`tools/approval/toolEditApproval.ts:236`), asks after
   its intent committed (`agent/runtime/loop/toolGuard.ts:45-47`). Resume
   handles that case (`shared/session/inFlight.ts:347-371`), but the stated
   order is not universal.
2. The durable-harness note says "The tests are the contract." This document
   restates the tests and the code; where it and they disagree, they win.
