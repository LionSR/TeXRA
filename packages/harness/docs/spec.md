# The durable protocol

This document specifies the durable protocol of `@texra-ai/harness`: what the
session store guarantees, what a run writes and when, how a run continues from
its rows, and what survives a crash. It describes the code as it is. It does not
describe planned behavior.

For a walkthrough with code, read the Durable Protocol guide first
([`docs/api/durable-protocol.md`](../../../docs/api/durable-protocol.md), published
at [texra.ai/api/durable-protocol](https://texra.ai/api/durable-protocol)).

## Conventions

The key words MUST, MUST NOT, SHALL, SHALL NOT and MAY are used as in RFC 2119,
and only in capitals. Every sentence that uses one cites the code that enforces
it, as `path#name`. The name is a declaration or other text the file holds
verbatim: a quoted literal, as in
`agent/runtime/loop/toolUseDispatch.ts#'tool.intent'`, a test title, or the
opening words of a message. A citation with no path names text in the file
cited last.

Paths are relative to `packages/harness/src/` unless they start with
`src/test-kernel/` (the repository's test suite), `packages/` or `.agents/`
(the repository's design notes). `scripts/check-guidance-refs.mjs` fails a
citation whose file is missing or does not hold its name, and any line number.
It cannot tell that the named code still does what the sentence says, so a
change to cited code updates the citation.

"The store" is the session database. "A row" is one record of its `event` table;
its kind is its `type` column.

## 1. Terms

- **Process**: One OS process with one process identity,
  `[hostname, pid, processStart]`, stamped on every row it writes
  (`shared/schemas/identifiers.ts#OwnerIdSchema`).
- **Storage root**: One directory holding one store file.
- **Session**: The process's handle on one storage root: its store connection,
  its one publisher, its fold and its live runs.
- **Aggregate**: A keyed sequence of rows. Kinds are `run` (keyed by run id) and
  `plugin` (keyed `<plugin>:<key>`)
  (`shared/schemas/identifiers.ts#AggregateKindSchema`).
- **Run**: One `run` aggregate. It exists while its `run.start` row exists and
  no `run.removed` has closed it
  (`controllers/session/databaseLayer.ts#A run must begin with exactly one run.start`,
  `#closeDependents`).
- **Turn**: One loop cycle, delimited by `turn.begin` and `turn.end`; usually
  one input answered by the model, but a script's handed-down call or a failed
  or cancelled invocation ends a turn with no answer
  (`agent/runtime/loop/runLoop.ts#runTurn`, `#loopBody`).
- **Invocation**: One model call of a turn, a compaction summary or a helper,
  identified by `invocationId`; a helper's invocation lives in memory only and
  records no rows (`shared/schemas/runHistoryEvent.ts#InvocationRefSchema`,
  `agent/runtime/run/modelCall.ts#callModel`).
- **Attempt**: One try of an invocation, numbered from 1; `attempt` grows only
  for a retry of the same invocation
  (`shared/schemas/runHistoryEvent.ts#InvocationRefSchema`,
  `shared/session/inFlight.ts#openedBy`).
- **Step**: One model call as the loop prepares it: its offered tools and system
  text, recorded on `tools.offered` when they change
  (`agent/runtime/loop/step.ts#stepFor`).
- **Response**: One completed provider turn, committed as a `model.message`
  `response` row with a minted `responseId`
  (`shared/schemas/runHistoryEvent.ts#ResponseIdSchema`).
- **Tool call**: One local call of a response, keyed by its `callId`; a call a
  `script` call's guest issued; or a script-configured run's handed-down call,
  which its opening `model.message` `handed-down` carries
  (`shared/schemas/runHistoryEvent.ts#DispatchFactsSchema`,
  `#ScriptCallPayloadSchema`).
- **Request**: A decision that may wait on a person: a `request.opened` row,
  closed by one `request.decided` row; an approval policy that answers at once
  commits both in one batch (`shared/schemas/sessionEvent.ts#'request.opened'`,
  `agent/runtime/requests.ts#policyDecidedRows`).
- **Fold**: `applyRunRows`, the pure function from a run's rows to the
  `RunState` the loop continues from
  (`shared/session/runState.ts#applyRunRows`).
- **Publisher**: `SessionEvents`, the one inbox through which a session writes
  (`agent/runtime/sessionEventsLayer.ts#sessionEventsLayer`).
- **Commit, seq**: `commit` orders rows across the store; `seq` orders rows
  within an aggregate
  (`controllers/session/storeSchema.ts#CREATE TABLE IF NOT EXISTS event`).

## 2. The store

### 2.1 One file per storage root

The store is one SQLite file named `texra.db` under the storage root
(`controllers/session/databaseLayer.ts#SESSION_DATABASE_FILE`); the file name and the
application id (`TeXR`) carry the product's name. An ephemeral session runs the
same schema in memory (`controllers/session/storeSchema.ts#IN_MEMORY_STORE`).

The store MUST carry application id `0x54655852` and schema version 102 in
SQLite's `user_version` (`controllers/session/storeSchema.ts#APPLICATION_ID`,
`#SCHEMA_VERSION`). A process MUST refuse, unchanged, a file with another
application id or a schema stamp at or above 102 other than its own
(`controllers/session/storeSchema.ts#checkStamps`). A store stamped below 102
that holds tables of the pre-1.0 format SHALL be copied whole to the first free
`<file>.pre1` name and started fresh; nothing in it is read again
(`controllers/session/storeSchema.ts#asideName.pre1`). A file SQLite reports
damaged at open SHALL be moved, with its WAL and shared-memory files, to
`<file>.corrupt-<ms>`, and a fresh store opened in its place
(`controllers/session/storeSchema.ts#asideName.corrupt`).

A persistent store runs in WAL mode with `synchronous = NORMAL` and foreign keys
on (`controllers/session/storeSchema.ts#prepareStore`). Every write transaction
the database's transaction wrapper runs MUST begin with `BEGIN IMMEDIATE`
(`controllers/session/databaseLayer.ts#'BEGIN IMMEDIATE'`). File maintenance runs
outside it: the one-time `VACUUM` at setup, page reclaim in autocommit
`incremental_vacuum` steps, and the `VACUUM INTO` copy a store moved aside
takes, none of which writes a row
(`controllers/session/storeSchema.ts#incrementalVacuum`, `#reclaimFreePages`,
`controllers/session/storeAside.ts#'VACUUM INTO ?'`).

### 2.2 The event table and the envelope

Rows live in one table, `event`, keyed by `commit`, unique on `(aggregate, seq)`
(`controllers/session/storeSchema.ts#CREATE TABLE IF NOT EXISTS event`). Each
row carries an envelope that the store stamps and no caller supplies:

- `commit`: SQLite `AUTOINCREMENT` key: strictly increasing across the store,
  never reused
  (`controllers/session/storeSchema.ts#CREATE TABLE IF NOT EXISTS event`).
- `seq`: Dense from 1 per aggregate (`controllers/session/databaseLayer.ts#NEXT_SEQ`).
- `origin`: The writing process's identity
  (`controllers/session/databaseLayer.ts#INSERT_EVENT`).
- `at`: Publish clock in whole milliseconds, one value for a whole batch;
  informational only (`controllers/session/databaseLayer.ts#'Database.appendAll'`).

The first row of a `run` aggregate MUST be its `run.start`, and seq 1 MUST NOT
hold any other row
(`controllers/session/databaseLayer.ts#A run must begin with exactly one run.start`).
A child's `run.start` MUST name an open parent; the store stamps the parent's
incarnation `uid` in the child's creation transaction
(`controllers/session/databaseLayer.ts#Child creation requires an open parent`). A
`run.removed` row closes its aggregate and every dependent, and a row MUST NOT
be appended to a closed aggregate
(`controllers/session/databaseLayer.ts#closeDependents`, `#NEXT_SEQ`).

A payload string of 4096 or more characters is stored once per store as a zstd
blob under the sha256 of its JSON text; the row keeps a reference, and the read
verifies the digest (`controllers/session/rowCodec.ts#encodeDraft`,
`controllers/session/rowReader.ts#inflateBlob`).

### 2.3 One publisher

Every row a session writes is written by a job on one inbox drained by one
fiber. Jobs SHALL run in the order they were enqueued, one at a time, and the
table's commit order is that order (`agent/runtime/sessionEventsLayer.ts#consumer`).
A job other than an ordering barrier (`transact(job, order)`, below) is one
SQLite transaction: its appends commit together or not at all
(`agent/runtime/sessionEventsLayer.ts#inTransaction`,
`controllers/session/databaseLayer.ts#job`).

The publisher offers these doors:

- `transact(job)`: Enqueue a job and wait for its value
  (`agent/runtime/sessionEventsLayer.ts#'transact'`).
- `transact(job, order)`: A barrier with no transaction; its `append` is a
  defect (`agent/runtime/sessionEventsLayer.ts#'An ordering job appends nothing'`,
  `#inTransaction`).
- `detach(job)`: Enqueue a job and return at once, for a producer with no fiber;
  its order is the moment of the call (`agent/runtime/sessionEventsLayer.ts#detach`).
- `removeRun`: Commit a run's deletion marker (`run.removed`) as the next
  job, refused unless the run's start commit is the one the caller read
  (`agent/runtime/sessionEventsLayer.ts#removeRun`).
- `drain`: End the inbox and run what it holds within the close deadline of
  5,000 ms (`agent/runtime/sessionEventsLayer.ts#drain`,
  `#SESSION_CLOSE_DEADLINE_MS`).

A job MUST NOT wait on its own publisher; doing so is a defect
(`agent/runtime/sessionEventsLayer.ts#reentered`). A job body MUST be
database-only: what must follow its commit runs after the transaction
returns (`agent/runtime/sessionEventsLayer.ts#inTransaction`). At the close deadline the running job is cut and every queued
job refused (`agent/runtime/sessionEventsLayer.ts#drain`). An awaited job enqueued
after close is a defect; a detached one is logged and dropped
(`agent/runtime/sessionEventsLayer.ts#'Session publication after the plane closed'`,
`#'Session publication dropped: the plane has closed'`).

Once a job's transaction commits, the publisher SHALL publish what the job
wrote, from memory, to the session's subscribers, one batch per job in commit
order: the batch's display rows as a display read of the same commits returns
them, and the commit it reached (`agent/runtime/sessionEventsLayer.ts#publish`,
`controllers/session/databaseLayer.ts#displayRows`). Nothing in the session reads
its own writes back to learn what it committed. A tail reads from the store only
the rows it starts behind the publisher's last published commit, then follows
the batches (`agent/runtime/sessionEventsLayer.ts#all`); the session's view takes its
rows the same way (`controllers/session/sessionInputsLayer.ts#sessionInputsLayer`).
Every projection is caught up when the store opens, and each append keeps it
current in its own transaction, so a read never checks it
(`controllers/session/databaseLayer.ts#upkeep.catchUp`,
`controllers/session/projections.ts#follow`).

Above the publisher, the session's own door (`SessionLog.transact`) SHALL return
only after the session's view has applied every commit the job made
(`controllers/session/sessionStore.ts#viewApplied`).
A trace row emitted on its own reaches the publisher through
`SessionLog.publish` (`shared/session/sessionLog.ts#SessionLogShape`); a call's
card rows and a turn's closing rows commit inside the run's own batches instead
(`agent/runtime/loop/toolUseDispatch.ts#cardRows`,
`agent/runtime/loop/runLoop.ts#log.closure`). `SessionLog.settled` is the
barrier after every job enqueued before it, once the terminal-result presenter
has run over the view's rows past it
(`controllers/session/sessionStore.ts#settled`).

### 2.4 Row versions and the store gate

Each row kind carries its own version
(`shared/schemas/rowVersions.ts#ROW_KINDS`). A row MUST be written at its kind's
current version (`controllers/session/rowCodec.ts#prepareEventDraft`). The
`stored_kind` table records the highest version each kind was written at
(`controllers/session/databaseLayer.ts#UPSERT_KIND`).

The store gate refuses a store that names a core kind this build lacks, or a
known kind at a version above the one this build reads
(`controllers/session/rowCodec.ts#storeGate`). A plugin kind whose plugin this
build lacks passes the gate; its rows read as written, marked unavailable
(below). The
gate MUST run at open, so no build opens a store holding core rows it cannot
read, or writes beside them (`controllers/session/databaseLayer.ts#storeGate`); a
project store's one writer is the process that opened it (section 7), so what
the store holds cannot change under it. A core kind this build lacks and never retired counts as newer
(`controllers/session/rowCodec.ts#readableVersion`). Kinds a build deleted are
listed as retired, each with what its rows fed
(`shared/schemas/rowVersions.ts#RETIRED_ROW_KINDS`): a `display` row is skipped
on read, logged once, and its run still resumes; an `execution` row makes its
run an earlier build's (`DatabaseRowEarlier`), failing only that run's reads
(`controllers/session/rowCodec.ts#rowRefusal`).

A kind changes with no upcaster: its version is bumped when an older build's
row would read wrong (`shared/schemas/rowVersions.ts#ROW_KINDS`), and a stored
row reads at its kind's version only
(`controllers/session/rowCodec.ts#readableFrom`). A plugin's fact kind versions
its own `value` the same way (`tools/plugins.ts#FactKind`,
`controllers/session/rowCodec.ts#factKindOf`). A row is then classified by the
reader (`controllers/session/rowCodec.ts#decodeRow`):

- **above the kind's current**: `DatabaseStoreNewer`
  (`controllers/session/rowCodec.ts#rowRefusal`)
- **below the kind's current**: `DatabaseRowEarlier`, the run listed as an
  earlier build's (`controllers/session/rowCodec.ts#rowRefusal`)
- **readable, payload fails parse**: `DatabaseRowCorrupt`, naming its commit
  (`controllers/session/rowCodec.ts#decodeRow`)
- **a plugin kind this build lacks**: read as written, its value not
  checked, with `unavailable` saying why; the row is unchanged, and
  a run holding one is refused resume as `pluginUnavailable`, naming the plugin
  (`controllers/session/rowCodec.ts#unavailableFactReason`,
  `agent/storage/resumability.ts#'pluginUnavailable'`); a retired built-in kind
  (`RETIRED_PLUGIN_FACTS`) is an earlier build's (`DatabaseRowEarlier`) instead
  (`controllers/session/rowCodec.ts#factKindOf`)

A read of one run's whole history MUST fail on any row of the aggregate that
does not decode; a read of its records fails on any undecodable row among the
rows it selects, and on any earlier build's row anywhere in the run, selected or
not (`controllers/session/rowReader.ts#RowReader`). A listing or a tail leaves
an earlier build's or a corrupt row out with one warning; when the row is on a
`run` aggregate it also marks that run unreadable and replaces a damaged
`run.start` with a bare one of `unknown` identity, so the run still lists
(`controllers/session/rowReader.ts#warnOnce`, `#bareStart`), and a bad row on a
`plugin` aggregate marks no run (`controllers/session/rowReader.ts#mark`); a
row of a known kind at a version above this build's fails any read that selects
it, listing and tail included, because it means a newer build now writes this
store; a read whose query does not select that row (a display tail of display
kinds, a listing of listing rows) can still succeed, while writes and projection
catch-up stay gated (`controllers/session/rowReader.ts#'DatabaseStoreNewer'`).
Reads do not run the gate: a project store's one writer is the process that
opened it, so a row of a core kind this build lacks can only predate the open,
which the gate refused; a plugin kind whose plugin this build lacks reads
unavailable and passes the gate
(`controllers/session/rowCodec.ts#'an unknown kind'`,
`controllers/session/rowCodec.ts#storeGate`). A run whose rows do not decode
cannot be opened or resumed: a resume of it, and a message to it, is refused as
`earlierBuild` for an earlier build's row and as `unusableCheckpoint` for a
corrupt one, never as a read to retry (`shared/session/runHistory.ts#runReadRefusal`,
`agent/storage/resumability.ts#deriveResumability`,
`agent/runtime/resumeRun.ts#refusalFor`).

## 3. Row kinds

The vocabulary is one Effect Schema union, `SessionRowDraftSchema`, built
from three groups (`shared/schemas/sessionEvent.ts#SessionRowDraftSchema`).
The groups below follow it. A "folded" kind is one `applyRunRows` reads
(`shared/session/runState.ts#ROW_HANDLERS`,
`shared/session/turnRowHandlers.ts#TURN_ROW_HANDLERS`); the fold's reader
selects only those kinds, and a row of any other kind is refused
(`shared/session/runState.ts#RUN_STATE_ROW_TYPES`, `#applyRow`).

### 3.1 Run history rows (private to the runtime)

Read through the run history, and by the store's usage projection, which turns
the priced usage on `response`, `failed` and `context.edit` rows, and on a
model's `run.description`, into a projected `usage` row
(`controllers/session/projections.ts#pricedUsage`), and by
the display reader, which selects `tool.result` to fill the adjacent `tool.end`
card's result before it drops the private row
(`controllers/session/rowReader.ts#DISPLAY_READ_TYPES`, `#settleCards`). The
private rows themselves are never sent to a renderer
(`shared/schemas/sessionEvent.ts#isDisplayRow`).

- `model.message` (folded: yes): One arm per invocation fact: `attempt`,
  `identified`, `accepted`, `cancelled`, `failed`, `response`, `handed-down`,
  `append` (`shared/schemas/runHistoryEvent.ts#ModelMessagePayloadSchema`).
- `context.edit` (folded: yes): Replaces messages `[from, to)` of the model's
  view; cause `compaction` or `fork`
  (`shared/schemas/runHistoryEvent.ts#ContextEditPayloadSchema`).
- `tool.intent` (folded: yes): The point after which a call's body may have run,
  at an attempt number; it commits just before the body starts, so it does not
  prove the body ran (`shared/schemas/runHistoryEvent.ts#ToolIntentPayloadSchema`,
  `agent/runtime/loop/toolUseDispatch.ts#bodyStarts`).
- `script.call` (folded: yes): A call a `script` guest issued, with its
  arguments (`shared/schemas/runHistoryEvent.ts#ScriptCallPayloadSchema`).
- `tool.result` (folded: yes): A call's one settlement and its disposition
  (`shared/schemas/runHistoryEvent.ts#ToolResultPayloadSchema`).
- `tools.offered` (folded: yes): The step's offered tools, system text and
  hooks, when they changed
  (`shared/schemas/offeredTools.ts#ToolsOfferedPayloadSchema`).
- `context.blob` (folded: yes): Model-facing content stored by sha256 address
  (`shared/schemas/offeredTools.ts#ContextBlobSchema`).
- `hook.outcome` (folded: yes): A hook point's recorded outcome; a recorded
  point never runs again (`shared/schemas/hookOutcome.ts#HookOutcomePayloadSchema`,
  `agent/runtime/loop/hooks.ts#hooksAt`).

The `model.message` arms:

- `attempt`: A billed request is about to leave; names its recorded request by
  sha256 and its origin.
- `identified`: The provider's response id, seen before completion.
- `accepted`: A background operation the provider accepted, with its admitted
  deadline.
- `cancelled`: A user stop the provider confirmed for an accepted operation.
- `failed`: The attempt failed, or its outcome is unknown: a person-admitted
  attempt found with no outcome on resume is re-asked under a `failed` row
  (`agent/runtime/ModelInvoker.ts#'ModelInvoker.reask'`). Carries its error and
  the move after it (`retry`, `unchain`, `ask`, `stop`).
- `response`: The completed turn, its dispatch facts per call, and its priced
  usage.
- `handed-down`: The one call a script's run opens on; no model made it.
- `append`: Messages added to history; with `sourceResponse`, the tool group
  that delivers a response.

### 3.2 Run records (private to the runtime)

`run.report` holds the run's report text (a child's delivery, written with its
`run.end`), `process.exit` how a process run's command exited, and
`followup.closed` marks its input closed until the run's next `run.activate`
reopens it (`shared/schemas/sessionEvent.ts#RunRecordEventDraftSchema`,
`shared/session/runRowReads.ts#recordFacts`, `agent/followUp/Inbox.ts#admission`).

### 3.3 Display rows (session-authored and run-authored)

Every renderer folds these
(`shared/schemas/sessionEvent.ts#DisplaySessionEventDraftSchema`; each kind is
the first argument of its `durable(...)` arm there). Kinds marked "folded" are
also read by `applyRunRows`.

- `run.start` (folded: no): The run's existence: identity, parent edge,
  provenance, launch approval policy.
- `run.activate` (folded: yes): One activation: the first launch or a resume.
- `run.config` (folded: yes): What the run runs on: configuration, model,
  binding.
- `run.detach` (folded: no): A stop severed the parent edge.
- `run.end` (folded: no): The terminal fact: outcome, classified error, output.
- `run.removed` (folded: no): The deletion marker: last row of its aggregate, final.
- `run.description` (folded: no): A title, by `model` or `user`.
- `plugin.fact` (folded: no): A plugin's own kind; core never reads `value`.
- `followup.queued` (folded: no): Input not taken yet, whole.
- `followup.consumed` (folded: no): A queued follow-up was taken: delivered as a
  turn's message, answered by a tool, or retired as a control or with the run's
  end.
- `request.opened` (folded: yes): A run asks a person.
- `request.decided` (folded: yes): The answer.
- `approval.policy` (folded: no): A change of the run's approval policy.
- `run.position` (folded: yes): Where the loop stands.

The transcript tier is display rows too
(`shared/schemas/traceEvent.ts#TraceRowFieldsSchema`):
`log`, `stage.start` and `stage.end` (a labelled span no other row bounds,
such as a plugin's section; a stage still open when its run ends closes with
that `run.end`), `tool.start` (a call's card opens; a script's call names
the `script` card that issued it as its `stageId`, the script's stage),
`tool.end` (it closes), `usage` (one priced turn; a run with a run history
stores none), `context.state`, `stream.start`, `stream.end`, and
`response.finalized` (the final text of one provider response; a loop turn that
asks for its final tool may record another,
`agent/runtime/loop/runLoop.ts#afterTextResponse`). `response.finalized` is read
by the fold, which marks that response's answer final
(`shared/session/runState.ts#answerFinalized`).

Streamed text (`stream.chunk`) is transient. It is not an arm of the vocabulary
and never a row (`agent/runtime/loop/toolUseDispatch.ts#'stream.chunk'`).

## 4. Write points

A run's history is written through its run cell, `RunCell.append`, which commits
one batch per call (`agent/runtime/makeRunHistory.ts#'RunCell.commit'`). The loop's
write points are normative:

- **W1**, `model.message` `attempt`: for a turn, commits before the billed
  request leaves the process
  (`agent/runtime/ModelInvoker.ts#'ModelInvoker.attempt'`).
- **W2**, `model.message` `response`: commits, with `run.position`
  `response.ready`, before any tool call dispatches
  (`agent/runtime/ModelInvoker.ts#'ModelInvoker.consume'`;
  `agent/runtime/loop/runLoop.ts#dispatchPendingResponse`).
- **W3**, `tool.intent`: commits after PreToolUse hooks and the guard, before
  the body runs, once per attempt
  (`agent/runtime/loop/toolUseDispatch.ts#bodyStarts`;
  `agent/runtime/loop/toolGuard.ts#guardedToolCall`).
- **W4**, `tool.result`: commits, with the call's card rows, before the delivery
  that lets the loop continue (`agent/runtime/loop/toolUseDispatch.ts#cardRows`,
  `#'toolUse.deliver'`).
- **W5**, `run.position`: commits at every loop-boundary wait and every halt; a
  request's wait keeps the position in force and writes `request.opened` instead
  (`agent/runtime/loop/runLoop.ts#positionRow`;
  `agent/storage/runLifecycle.ts#endIn`).
- **W6**, `model.message` `failed`: for a turn, commits for every recorded
  failure, naming the next move
  (`agent/runtime/ModelInvoker.ts#'ModelInvoker.failed'`,
  `#'ModelInvoker.invoke'`).
- **W7**, `request.opened` / `request.decided`: the opening commits before any
  wait; a decision commits once (`agent/runtime/requests.ts#openRequest`,
  `#decideRequest`).

**W1.** The invoker MUST commit the attempt's rows, the blobs of its request
context and the `attempt` row, before it streams or submits the request
(`agent/runtime/ModelInvoker.ts#'ModelInvoker.attempt'`,
`agent/runtime/run/requestContext.ts#attemptRows`). A call off the rows (a
compaction summary, a helper call) records no row, its attempts and failures
included (`agent/runtime/run/modelCall.ts#'modelCall.attempt'`); a summary's
usage rides the `context.edit` that lands it
(`agent/runtime/run/compaction.ts#'compaction.land'`).

**W2.** A completed provider turn of a loop invocation (one invocation's answer;
a loop turn may hold none, or several as the loop calls the model again after
tool results) MUST commit once, as one `response` row with a fresh `responseId`,
in the batch that moves the position to `response.ready`. It carries one
dispatch fact per local call (`agent/runtime/run/tools.ts#dispatchFactsFor`)
(`agent/runtime/ModelInvoker.ts#'ModelInvoker.consume'`,
`shared/schemas/runHistoryEvent.ts#DispatchFactsSchema`). The loop MUST dispatch
only the pending response its fold holds
(`agent/runtime/loop/runLoop.ts#dispatchPendingResponse`). W2 does not cover a
compaction summary, whose answer its caller lands as a `context.edit`, or a
helper call, which records no row (W1).

**W3.** A call's `tool.intent` MUST commit after its PreToolUse hooks and its
guard, and before its body (`agent/runtime/loop/toolUseDispatch.ts#bodyStarts`,
`agent/runtime/loop/toolGuard.ts#guardedToolCall`). The guard asks for a
command's approval (`agent/runtime/loop/toolGuard.ts#askCommandApproval`). A
slow tool's `tool.start` card MUST commit in the intent's batch
(`agent/runtime/loop/toolUseDispatch.ts#bodyStarts`). An attempt whose intent is
already committed MUST NOT commit another
(`agent/runtime/loop/toolUseDispatch.ts#bodyStarted`).

**W4.** A call that settles from its body MUST commit its `tool.result` with its
whole card: a slow tool's `tool.end`, a fast tool's `tool.start` and `tool.end`
(`agent/runtime/loop/toolUseDispatch.ts#cardRows`). A body interrupted or cut by
a crash commits no result; a resume settles it (section 9, "`tool.intent`, no
result"). A synthetic settlement of a call no body started (a call a recovered
response never started, a duplicate, a call after the turn ended) commits its
`tool.result` with no card (`agent/runtime/loop/toolUseDispatch.ts#skipCall`,
`#commitResult`); one that settles a started call as outcome unknown commits its
card's close, and its open for a fast tool
(`agent/runtime/loop/toolUseDispatch.ts#skipCall`). The delivering `append` MUST
commit only once every call of the response has settled, as one tool group bound
to the response (`agent/runtime/loop/toolUseDispatch.ts#'toolUse.deliver'`). A
delivery its settlements do not match is a defect
(`agent/runtime/makeRunHistory.ts#'mismatched-delivery'`).

**W5.** The positions are `turn.ready`, `turn.begin`, `response.ready`,
`results.ready`, `turn.end` and `waiting`
(`shared/schemas/runHistoryEvent.ts#PositionAtSchema`). A `turn.end` position
MUST carry an outcome, and every other position MUST NOT carry one
(`shared/schemas/runHistoryEvent.ts#RunPositionPayloadSchema`). A run's end
is its `run.end` alone, committed in one transaction with the requests it
leaves open cancelled and its unread input dropped
(`agent/storage/runLifecycle.ts#endIn`); a stop commits a `run.stop` row
naming its reason first, and for a run no fiber here drives, the `run.end`
in the same batch (`agent/storage/runLifecycle.ts#stopRun`). A run whose
history does not load ends with its `run.end` and its requests uncancelled,
with a warning (`agent/storage/runLifecycle.ts#endIn`). Every child is a
run that ends: a native child runs one cycle and ends with its report; a
process child (a background command, an agent CLI's turn) is one turn of
its process, ended with its exit (`agent/runtime/processRun.ts`). A child's
end queues its report on its parent's input in the same transaction, under
`${runId}:${activation}` (`agent/storage/runLifecycle.ts#parentDelivery`),
unless the parent's call awaits it or the child was detached.

**W6.** Every failed attempt of a turn that reaches failure recording MUST
commit a `failed` row whose `next` is the move after it; a call off the rows
records none (`agent/runtime/run/modelCall.ts#callModel`)
(`agent/runtime/ModelInvoker.ts#'ModelInvoker.invoke'`, `#failedRows`). A
`failed` row that asks MUST be
preceded, in its batch, by the `request.opened` of its retry request
(`agent/runtime/ModelInvoker.ts#failedRows`,
`shared/session/turnRowHandlers.ts#a failed attempt asks`).

## 5. The fold

### 5.1 `RunState`

`RunState` is what the loop continues from: the position, the run's facts, the
canonical message history, the open invocation, the pending response, the
requests, and the offered tools and contents. It has no schema and is never
persisted (`shared/session/runState.ts#RunState`).

### 5.2 Grammar

`applyRunRows(state, rows)` folds rows in order
(`shared/session/runState.ts#applyRunRows`). It MUST refuse a row whose commit
is not above the last folded one (`shared/session/runState.ts#applyRow`). Each
folded kind has one handler in a table keyed by row type: the state it requires
(any state, an existing one, or an opened run) and its move
(`shared/session/runState.ts#RowHandler`, `#ROW_HANDLERS`). A handler that
requires an opened run refuses a row before the opening `run.position`
(`shared/session/runState.ts#applyRow`). A row of any other kind is refused as
`unknown-run-row`: its reader selects the kinds the fold reads
(`shared/session/runState.ts#RUN_STATE_ROW_TYPES`, `#isRunStateRow`), so no
display row reaches it. A refusal is a typed `RunHistoryInconsistent` with a
reason: `out-of-order`, `orphan-settlement`, `unknown-run-row`,
`mismatched-delivery` or `unreadable-turn`
(`shared/session/runState.ts#RunHistoryInconsistent`). The fold never defaults a
row it cannot apply (`shared/session/runState.ts#applyRow`).

A run is opened by its first `run.position`. Run history rows without an opening
position MUST fail the load as `inconsistent`
(`agent/runtime/makeRunHistory.ts#'RunHistory.loaded'`).

### 5.3 Phases

The fold maps a position to a loop phase: `turn.ready` and `waiting` to
`waiting`, `turn.begin` to `model.ready`, `response.ready` to `model.submitted`,
`results.ready` to `results.ready`, and `turn.end` to `turn.ended`
(`shared/session/runState.ts#PHASE_AT`).

There is no halted position: a `run.end` is the halt, and a resume continues
from the phase the last `run.position` recorded
(`shared/session/runState.ts#phaseAfter`).

### 5.4 The commit path

`RunCell.append` MUST fold the batch onto the cell's state before it publishes,
and MUST refuse, with nothing committed, a batch the fold rejects
(`agent/runtime/makeRunHistory.ts#'RunCell.commit'`). It MUST check the assembled
message history against `PreparedHistorySchema` from where the batch changes it
(`agent/runtime/makeRunHistory.ts#unprepared`). It MUST refuse a durable model
origin carrying userinfo, a query string or a fragment
(`agent/runtime/makeRunHistory.ts#unsafeEndpoint`). After the commit it folds the
committed rows, at the commits the store assigned, and that state is the one the
loop continues from (`agent/runtime/makeRunHistory.ts#applyStored`). The
read-append-fold region is uninterruptible and serialized per cell
(`agent/runtime/makeRunHistory.ts#'RunHistory.open'`); rows another writer commits
to the run (a decision, a run's end through a cell of its own) are ordered by
the publisher, and a cell folds them on `refresh`
(`agent/runtime/makeRunHistory.ts#refresh`,
`agent/storage/runLifecycle.ts#endIn`).

A batch that carries a `context.edit` with a `response` MUST place the edit
immediately before the response, and an edit MUST be the first message-bearing
row of its batch (`agent/runtime/makeRunHistory.ts#contractViolation`).

### 5.5 Resume is the same function

The loop holds no copy of the conversation. It reads every branch off the fold,
so the live path and the resume path are the same steps
(`agent/runtime/loop/runLoop.ts#loopBody`, `#runTurn`). A resume enters the
same program, `runToolUse`, with `resume: true`, through the same run program as
a fresh launch, `executeAgent` without a registration
(`agent/runtime/executeAgent.ts#executeAgent`), reached from `resumeRun`
(`agent/runtime/resumeRun.ts#resumeRun`).

A resume MUST be refused when the rows hold no opened run
(`agent/runtime/loop/runProgram.ts#NOT_RESUMABLE_MESSAGE`). A fresh launch MUST
be refused when the run already holds history state
(`agent/runtime/loop/runProgram.ts#already has run history state`).

## 6. Retry

A turn's model call MUST go through one loop over its rows,
`ModelInvoker.invoke` (`agent/runtime/ModelInvoker.ts#'ModelInvoker.invoke'`).
Its next move is `nextAttempt(invocation, requests, retries)`, read off the
invocation's rows before every move (`shared/session/inFlight.ts#nextAttempt`). A call off the rows (a compaction
summary, a helper call) is the other loop, `callModel`
(`agent/runtime/run/modelCall.ts#callModel`): `Effect.retry` while llm says the
same request can succeed, under the same gate, with no row and no person:

| Rows show                                                        | Move                                        |
| ---------------------------------------------------------------- | ------------------------------------------- |
| no open invocation                                               | send attempt 1                              |
| open attempt, no outcome, an accepted operation                  | observe it; never resubmit                  |
| open attempt, no outcome, an earlier `failed` row asked a person | ask again (`reask`)                         |
| open attempt, no outcome, the automatic retries spent            | ask again (`reask`)                         |
| open attempt, no outcome, otherwise                              | send the next attempt                       |
| open attempt a clean close stopped (`run.end` says `shutdown`)   | as above; the stopped attempt spent nothing |
| `failed` with `retry` or `unchain`                               | send the next attempt                       |
| `failed` with `stop`                                             | end the invocation failed                   |
| `failed` with `ask`, request undecided                           | wait for the decision                       |
| `failed` with `ask`, decided `retry`                             | rebind on the chosen credentials, then send |
| `failed` with `ask`, decided `deny`                              | end the invocation failed                   |
| `failed` with `ask`, any other decision                          | end the invocation cancelled                |

The move a `failed` row records is decided once, by `failedNext`
(`shared/session/inFlight.ts#failedNext`), except for the row of a re-ask,
which names its move itself, `ask` under a fresh request id
(`agent/runtime/ModelInvoker.ts#'ModelInvoker.reask'`):

- A `continuation-gone` failure of an attempt that sent a continuation answers
  `unchain`, once per invocation (`shared/session/inFlight.ts#failedNext`,
  `agent/runtime/ModelInvoker.ts#moveAfter`).
- A retryable failure answers `retry` while the invocation's earlier failures,
  `unchain` ones excluded, are fewer than the budget
  (`shared/session/inFlight.ts#failuresBefore`, `#spentRetries`,
  `#failedNext`). Every earlier failure counts, whichever move followed it: one
  that a person's retry allowed spends the budget as an automatic resend does,
  and so does an attempt with no recorded outcome, which may have been billed,
  so a crash that recurs on every open does not resend it every time. An
  attempt a clean session close stopped is the exception: its run's `run.end`
  says `shutdown` (its `reason`), its request was cut by the stop, not lost,
  and the fold leaves it out of the count
  (`shared/session/runFacts.ts#closedBy`,
  `shared/session/inFlight.ts#failuresBefore`).
  For a turn's invocation the budget is
  counted from rows, so a crash does not refill it. A call off the rows counts
  its resends in memory (`agent/runtime/run/modelCall.ts#callModel`): a
  compaction cut short is made anew, with a fresh budget.
- Past the budget, a failure a person may retry answers `ask` under a fresh
  request id; where nobody can be asked, `stop`
  (`shared/session/inFlight.ts#failedNext`).
- A failed observation of an accepted operation never resubmits it automatically
  (`agent/runtime/ModelInvoker.ts#moveAfter`).

Every automatic send MUST run under the process's `ModelRetryGate`
(`agent/runtime/ModelRetryGate.ts#RouteRetries`,
`agent/runtime/ModelInvoker.ts#tryAttempt`,
`agent/runtime/run/modelCall.ts#callModel`). The gate cools
two keys per binding: a 429 the provider scoped to the model cools that model on
its wire route, and a failure scoped to the route cools the wire route itself,
which every model on that route shares. The wire key is the binding's own tuple:
provider, credential route, endpoint and key fingerprint for a credential-backed
HTTP route; provider for the validation model
(`agent/runtime/modelAccess/binding.ts#routePolicies`,
`agent/runtime/modelAccess/failureInfo.ts#routePolicies`). An observation runs
outside it (`agent/runtime/ModelInvoker.ts#tryAttempt`). A cooling route lets
one call through at a time as its recovery probe, after a backoff that doubles
from 1,000 ms with each failure the route owns (up to five minutes, and never
less than the provider's `retryAfterMs`); the probe's end opens the route
unless it failed the same way, and a success admitted while the route was
healthy ends the failure count
(`agent/runtime/ModelRetryGate.ts#through`, `#settle`). Before a `retry` or
`unchain` that follows a recorded failure the loop pauses as long as the
provider asked (`retryAfterMs`), else 1,000 ms, and not at all after a failure
llm scoped to a route, which the gate cools and waits out
(`agent/runtime/ModelRetryGate.ts#resendDelayMs`); a resend after a crash, of
an attempt no row recorded an outcome for, goes out without it.

An attempt of an invocation a person admitted, whose outcome no row recorded and
which holds no accepted operation, MUST be asked about again and MUST NOT be
resent unasked (`shared/session/inFlight.ts#nextAttempt`); one that holds an
accepted operation is observed before another submission is considered. The ask
is a new `failed` row on that attempt, with `next: ask`
(`agent/runtime/ModelInvoker.ts#'ModelInvoker.reask'`). An attempt no person
admitted, whose outcome no row recorded, is resent only while automatic retries
remain; otherwise it is asked about again
(`shared/session/inFlight.ts#nextAttempt`).

A subscription session's token is llm's to renew, inside the request: the
binding hands the transport the session's token
(`agent/runtime/modelAccess/credentials.ts#subscriptionCredential`), which llm
reads before each request and, when the provider rejects it, renews once and
sends the request again; the rejected request was not billed, and neither loop
sees it. A session that cannot give or renew a token fails the attempt as the
route's own failure, which says how to sign in again
(`agent/runtime/modelAccess/failureInfo.ts#routeFailureOf`).

## 7. One process per project store

There is no daemon and no claim. A project store is held by the one process
that opened it, for its connection's life: the open takes
`locking_mode = EXCLUSIVE` and the first write lock, and a second opener is
refused at once with `STORE_HELD_MESSAGE`, never waited for
(`controllers/session/databaseLayer.ts#STORE_HELD_MESSAGE`, `#exclusive`). The
holder is the store's one writer and one reader; a cold listing of a held
project fails the same way (`controllers/session/readSessionView.ts`). The
global store is shared across processes and holds values alone; a change
another process makes to it is seen through a 250 ms poll of SQLite's
`data_version` (`controllers/session/databaseLayer.ts#'PRAGMA data_version'`). A
project store runs no poll: its holder learns what it committed from its own
publisher.

### 7.1 Aggregates

The first append to an aggregate creates it
(`controllers/session/databaseLayer.ts#NEXT_SEQ`). A later append MUST be refused
with `DatabaseAggregateClosed`, and nothing written, once the aggregate is
closed (`controllers/session/databaseLayer.ts#NEXT_SEQ`, `#refuseWriter`). Which
runs this process drives is the session's run registry's one fact, published
to the fold as `runsHere` (`agent/runtime/runRegistry.ts#runsHere`,
`shared/schemas/sessionViewInput.ts#LocalRuntimeStateSchema`): a run that has
not ended and is not among them is interrupted
(`shared/session/sessionViewUpdate.ts#withAggregates`).

### 7.2 Resume

A resume is one launch of the run on the session's registry
(`agent/runtime/resumeRun.ts#resumeRun`, `agent/runtime/runRegistry.ts#start`):
its opening reads the run's records, its queued input, whether an open call of
its parent owns it, and whether its rows can be continued, then commits the
run's activation (`agent/runtime/resumeRun.ts#openResume`). A run whose
records are gone, or deleted or whose input closed while those reads ran, is
refused, as the opening's failure, with no fiber behind it
(`agent/runtime/resumeRun.ts#openResume`). The registry holds the run from the
resume's first read: a second resume, or any launch, of the run meanwhile is
refused (`agent/runtime/runRegistry.ts#RunLive`), and a stop asked meanwhile
is applied as the opening answers: a failed opening's run ends cancelled on
its rows, and a committed one is forked and interrupted at once, so its one
terminal ends it (`agent/runtime/runRegistry.ts#stopAsked`,
`agent/runtime/runRegistry.ts#stopRows`). A child an open call of its parent
owns resumes through that parent (`agent/runtime/resumeRun.ts#owningCall`; a
resume a wake took follows it itself, whoever opened it,
`agent/followUp/ToolUseFollowUp.ts#wakeRun`, and the package's resume through
`effect/sessionPrograms.ts#redirectedFrom`).

The activation is one transaction: it folds the stored rows and commits the
activation rows with a `request.decided` `cancel` for every request the
previous process left unbound (`agent/runtime/makeRunHistory.ts#activate`). A
request is unbound unless it is the turn's open retry ask, the request a
pending call's resumed attempt re-enters, the request a pending `script`
call's guest calls share (attempt 0), or one that does not block its caller
(`shared/session/runState.ts#unboundRequests`).

### 7.3 Refusals

A write to a closed aggregate gets `RunHistoryRefused` `not-owner` from the
run's next append, with nothing written
(`agent/runtime/makeRunHistory.ts#notOwner`,
`shared/session/runHistory.ts#runRefusal`). A tool call that meets a storage
refusal fails the dispatch instead of settling
(`agent/runtime/loop/toolUseDispatch.ts#findStorageRefusal`). A request on a
run a launch here holds that would need the run stopped first is refused as
`RunActive` (`controllers/session/deletionCleanup.ts#deleteAdmittedRun`).

## 8. Requests

### 8.1 Kinds

The request kinds are the harness's own six and one plugin case
(`shared/schemas/request.ts#RequestPayloadSchema`):

| Kind           | Asks                                    | Blocks its caller |
| -------------- | --------------------------------------- | ----------------- |
| `toolEdit`     | approval of a file edit                 | yes               |
| `bash`         | approval of a command                   | yes               |
| `retry`        | whether to retry a failed model attempt | yes               |
| `proposal`     | approval of a proposed agent run        | yes               |
| `planApproval` | approval of a plan                      | yes               |
| `userQuestion` | answers to questions                    | yes               |
| `plugin`       | whatever its plugin asks, in its `data` | as declared       |

Every own kind blocks its caller (the tool call that opened it, or for
`retry` the model invocation). A plugin's request declares whether it does
(`blocksCaller`) and which actions answer it (`answers`); its plugin's
decision hook records each answer (`shared/schemas/request.ts#blocksCaller`).

### 8.2 Decisions

A decision is one of `approve`, `approve_and_goal`, `setup`, `submit`, `answer`,
`skip`, `retry`, `reject`, `deny` and `cancel`
(`shared/schemas/request.ts#RequestDecisionSchema`).

### 8.3 Protocol

- A request's id is part of its payload
  (`agent/runtime/requests.ts#payload.data.requestId`). A tool call's
  request id is derived from the response, call, attempt and ordinal, so a
  resumed attempt rejoins the request it left standing
  (`shared/session/inFlight.ts#callRequestId`).
- The opening and any decision the approval policy gives at once MUST commit in
  one batch, through the asker's cell, so no surface lists it pending
  (`agent/runtime/requests.ts#openRequest`); a grant turned on answers every
  open request it covers in the grant's own transaction
  (`agent/runtime/runApprovalQueue.ts#approvalsUnder`).
- A decision MUST commit only if its request is open and undecided; the first
  decision wins, and a later one writes nothing
  (`agent/runtime/requests.ts#decideRequest`).
- The asker waits on the committed `request.decided` row, read from the tail
  (`agent/runtime/requests.ts#decisionOf`). If the session closes first, the
  asker goes on as cancelled with no row written, and the request stays open
  (`agent/runtime/requests.ts#ended without one`).
- An interrupted asker writes nothing: the request a stopped or failed run
  leaves open is cancelled with the run's end, in the end's batch, so no
  surface keeps offering it (`agent/storage/runLifecycle.ts#cancelledRequests`);
  one a dead process left is the next resume's to cancel as unbound.
- A request is a row, so it outlives its process. A resume cancels the unbound
  ones (section 7.2) and re-enters the bound ones under the same id
  (`shared/session/inFlight.ts#resumedAttempt`). An open request that does not
  block its caller is neither: no attempt re-enters it and it is not unbound; it
  stays open until its `request.decided` commits, or until `run.removed`
  closes the run, which retires it with no decision row
  (`controllers/session/SessionRequests.ts#admit`). What its plugin's
  decision hook does with the answer (the external inquiry delivers it as a
  follow-up) is the plugin's.

## 9. Crash guarantees

The crash-point suite is the source of truth for this section
(`src/test-kernel/support/crashConformance.ts#crashConformanceSuite`). It runs
under the harness's built-ins alone
(`packages/harness/test/controllers/session/crashConformanceResume.1.vitest.ts#crashConformanceSuite`
and its siblings, each a shard of a scenario's crash points).

Its method: drive a clean run over a real store, record the event commit each
event-writing transaction ended at (the points are deduplicated by commit),
and for each such commit N copy the store, cut it to commits 1..N, reopen it
in a fresh session and resume the root run
(`src/test-kernel/support/crashConformance.ts#cleanPass`, `#resumeFrom`).

The guarantees, numbered as in the package README. The suite's header lists
each as a failure mode under its number, and `violations` checks it at every
commit point (`src/test-kernel/support/crashConformance.ts#violations`) of
`#'resumes from every commit point to the clean outcome, running nothing twice'`,
unless the item names another test:

- **I1**: Under the suite's deterministic model, recovery reaches the clean
  run's outcome: its answers, view edits, call results, owned children and fork.
- **I2**: A call settled before the crash is not executed again, and no call
  settles twice.
- **I3**: One model invocation has at most one committed response.
- **I4**: A command subject to approval runs only after its approval; an
  unfinished call that is not replay-safe and that recovery classifies as
  outcome-unknown runs again only after a person's retry (a call rejoining a
  standing or newly decided request runs at once, section 9).
- **I5**: An owned child that ended cleanly answers its call; it is not launched
  again without a person's retry; no child is left without a terminal row. Also
  asserted by
  `src/test-kernel/support/crashConformance.ts#'reads every child result settled before the crash, exactly once'`.
- **I6**: A child's result is delivered to its parent at most once; a result
  whose child was detached, or whose parent cannot take it, stays in the
  child's run report with a warning
  (`agent/storage/runLifecycle.ts#parentDelivery`). Asserted by
  `src/test-kernel/support/crashConformance.ts#'reads every child result settled before the crash, exactly once'`.
- **I7**: A fork keeps the history it was registered with; compaction keeps
  the context it committed.
- **I8**: A run's halt commits with its end; a stopped run never reads as
  interrupted.
- **I9**: Turning off a run's shell bypass is acknowledged only after its row is
  durable.

I1 is equality with a clean run because the suite's validation model is
deterministic. Against a live model, a resent attempt (section 6) may answer
differently; what recovery preserves is every committed row; it reaches a
terminal outcome once the provider answers or a person decides each request the
run opens, such as a retry request past the automatic budget. The suite also
asserts that a crash between a request and its answer leaves the request pending
and the resume answers that same request; that a crash between the answer and
the body honours the answer; and that a crash inside one publisher job leaves
neither half on disk (`src/test-kernel/support/crashConformance.ts#violations`,
`#'a crash between two appends of one job leaves neither'`).

What survives at each commit point follows from sections 2 to 8:

- `attempt`: The attempt has no outcome: resent, or asked again if a person
  admitted the invocation (section 6). A summary's attempt is not resumed: the
  summary starts a new invocation (section 6).
- `accepted`: The operation is observed under its recorded deadline, not
  resubmitted (`shared/session/inFlight.ts#nextAttempt`).
- `response`: The response is reused; no new invocation is made for it
  (`agent/runtime/loop/runLoop.ts#runTurn`).
- **a call's requests, no intent**: The call re-enters the request it asked
  (`shared/session/inFlight.ts#resumedAttempt`).
- `tool.intent`, no result: If the call opened a request that still stands, or
  one decided since this process activated the run, the call runs again and
  rejoins that request under its id
  (`shared/session/inFlight.ts#resumedAttempt`). Otherwise it is re-run only if
  both the stored and the current tool declare `replay: 'safe'`, the stored
  arguments validate, and it has not started three times already; else settled
  as outcome unknown, naming spent starts as the reason
  (`agent/runtime/loop/toolUseDispatch.ts#skipCall`,
  `agent/runtime/run/tools.ts#replayable`, `#unknownOutcome`).
- `tool.result`: The settlement is reused; the call is not run again
  (`agent/runtime/loop/toolUseDispatch.ts#finishCall`).
- **delivery `append`**: The loop continues to the next step from
  `results.ready` (`shared/session/runState.ts#PHASE_AT`).
- `request.opened`: The request stays pending under the same id, or is cancelled
  if unbound (section 7.2).
- `run.end`: The lifecycle is over. A recipe task stays finished, and a
  resume answers `finished`
  (`agent/storage/resumability.ts#deriveResumability`); a loop-driven
  conversation continues on a resume in a new lifecycle
  (`shared/session/runActions.ts#continuesFromRows`), from the phase its
  last `run.position` kept (`shared/session/runState.ts#phaseAfter`).

These are guarantees about committed state. An external effect that finished
before its result committed stays uncertain; I4 governs it, and the suite cannot
place a cut between an effect and its result. One real kill covers that case: a
process killed after its command's effect and before its result reports the
command as outcome unknown and never reruns it automatically; the model may
still issue a new command, which runs under I4
(`src/test-kernel/controllers/session/goldenStore.vitest.ts#'reports the command as an unknown outcome and never reruns it'`).

## 10. Conformance

These existing suites check the sections above. Each citation names a test by
its title.

- **2.1 file and schema**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts#'retires a store written before 1.0 whole and starts clean'`,
  `#refuses another application's SQLite file untouched`,
  `#'moves a truncated store aside and opens a fresh one'`,
  `#'refuses a store of a newer schema and changes nothing'`
- **2.2 envelope**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts#'assigns a dense seq per aggregate and one commit order across them'`,
  `#'reopens at the committed ordinal and never reuses one'`,
  `#'stores a large string once, compressed, and reads it exact'`
- **2.3 publisher**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts#'publishes complete replay and finite live batches in order'`;
  `src/test-kernel/support/crashConformance.ts#'a crash between two appends of one job leaves neither'`
- **2.4 versions and gate**:
  `src/test-kernel/schemas/rowVersions.vitest.ts#'names every stored kind once'`,
  `#'reads or retires every row kind ever stored'`,
  `#'$name reads its released version'`;
  `src/test-kernel/controllers/session/goldenStore.vitest.ts#'refuses a store a newer build wrote to, and rewrites nothing'`,
  `#'refuses a run holding %s before any request, and adds no row'`,
  `#'decodes every row to an event, and holds every row kind, a fork, owned children and shared blobs'`;
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts#'fails a run history read of a row that does not decode, and the session still opens and lists it damaged'`
- **3 row kinds**:
  `src/test-kernel/controllers/session/goldenStore.vitest.ts#'decodes every row to an event, and holds every row kind, a fork, owned children and shared blobs'`;
  `src/test-kernel/schemas/rowVersions.vitest.ts#'names every stored kind once'`
- **4 write points**:
  `src/test-kernel/support/crashConformance.ts#'resumes from every commit point to the clean outcome, running nothing twice'`
- **5 fold**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts#'holds the batch contract: a mismatched delivery dies, a loose-keyed attachment is accepted'`;
  `src/test-kernel/controllers/session/goldenStore.vitest.ts#'folds to the pinned session view and run states'`
- **6 retry**:
  `src/test-kernel/agent/runtime/RetryState.vitest.ts#'admits a manual retry through a durable approval'`,
  `#'stops automatic attempts at the configured limit'`,
  `#'spends a retry on each attempt the process stopped during'`;
  `packages/harness/test/agent/runtime/ModelRetryGate.vitest.ts#'admits one recovery probe and releases siblings after success'`
- **7 one process per store**:
  `src/test-kernel/controllers/session/sessionEvents.vitest.ts#'closes a run tree with its dependents and collects it'`,
  `#'refuses a store another OS process holds'`;
  `src/test-kernel/agent/runtime/resumeRun.vitest.ts#"a store read that fails under a resume fails it with the store's error, activates nothing and keeps the queued input"`
- **8 requests**:
  `src/test-kernel/support/crashConformance.ts#'resumes from every commit point to the clean outcome, running nothing twice'`
- **9 crash guarantees**:
  `packages/harness/test/controllers/session/crashConformance*.vitest.ts`,
  `src/test-kernel/controllers/session/goldenStore.vitest.ts#'reports the command as an unknown outcome and never reruns it'`

## 11. Non-goals

- **No daemon.** The CLI or SDK process is the unattended runner; a project
  store is held by one process at a time (section 7), and several processes
  work on several projects
  (`.agents/docs/implemented/architecture/2026-10-02-durable-harness.md`,
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
- **No once-only billing.** The code may resend an attempt that no person admitted
  and whose outcome no row recorded while automatic retries remain
  (`shared/session/inFlight.ts#nextAttempt`); the
  earlier attempt may have been billed. The suite asserts at most one committed
  response per invocation (I3), not one billing.

## 12. Open questions

1. `packages/harness/AGENTS.md` says `tool.intent` commits after a call's hooks,
   guard and approval. The guard asks only for tools with a declared command
   guard or `requiresApproval: true`, or when a `PreToolUse` hook asks; a tool
   whose body opens its own request, such as a file edit's review
   (`tools/approval/toolEditApproval.ts#requestToolEditApproval`), asks after
   its intent committed (`agent/runtime/loop/toolGuard.ts#guardedToolCall`).
   Resume handles that case (`shared/session/inFlight.ts#resumedAttempt`), but
   the stated order is not universal.
2. The durable-harness note says "The tests are the contract." This document
   restates the tests and the code; where it and they disagree, they win.
