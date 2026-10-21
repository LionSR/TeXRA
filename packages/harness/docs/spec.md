# The durable protocol

This document specifies the durable protocol of `@texra-ai/harness`: what the
session store guarantees, what a run writes and when, how a run continues
from its rows, and what survives a crash. It describes the code as it is. It
does not describe planned behavior.

## Conventions

The key words MUST, MUST NOT, SHALL, SHALL NOT and MAY are used as in
RFC 2119, and only in capitals. Every sentence that uses one cites the code
that enforces it, as `path:line` or `path:first-last`.

Paths are relative to `packages/harness/src/` unless they start with
`src/test-kernel/` (the repository's test suite) or `.agents/` (the
repository's design notes). Line numbers are those of the commit that added
this document.

"The store" is the session database. "A row" is one record of its `event`
table; its kind is its `type` column.

## 1. Terms

| Term         | Meaning                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process      | One OS process with one process identity, `[hostname, pid, processStart]`, stamped on every row it writes (`shared/schemas/sessionEvent.ts:55-75`).                                   |
| Storage root | One directory holding one store file.                                                                                                                                                 |
| Session      | The process's handle on one storage root: its store connection, its one publisher, its fold and its live runs.                                                                        |
| Aggregate    | A keyed sequence of rows. Kinds are `run` (keyed by run id) and `plugin` (keyed `<plugin>:<key>`) (`shared/schemas/sessionEvent.ts:103-112`).                                         |
| Run          | One `run` aggregate. It exists iff its `run.start` row exists (`controllers/session/Database.ts:674-683`).                                                                            |
| Turn         | One input answered by the model: from `turn.begin` to `turn.end` (`agent/runtime/loop/toolUse.ts:288-294`, `:534-537`).                                                               |
| Invocation   | One model call of a turn or a compaction summary, identified by `invocationId` (`shared/schemas/runHistoryEvent.ts:49-52`).                                                           |
| Attempt      | One try of an invocation, numbered from 1; `attempt` grows only for a retry of the same invocation (`shared/schemas/runHistoryEvent.ts:44-48`, `shared/session/inFlight.ts:111-118`). |
| Step         | One model call as the loop prepares it: its offered tools and system text, recorded on `tools.offered` when they change (`agent/runtime/loop/toolUse.ts:371-374`).                    |
| Response     | One completed provider turn, committed as a `model.message` `response` row with a minted `responseId` (`shared/schemas/runHistoryEvent.ts:188-206`).                                  |
| Tool call    | One local call of a response, keyed by its `callId`, or a call a `script` call's guest issued (`shared/schemas/runHistoryEvent.ts:349-370`).                                          |
| Request      | A wait on a person: a `request.opened` row, closed by one `request.decided` row (`shared/schemas/sessionEvent.ts:373-386`).                                                           |
| Claim        | The write authority over one aggregate: the `owner_id` column of its sequence row (`controllers/session/storeSchema.ts:56-67`).                                                       |
| Fold         | `foldRunState`, the pure function from a run's rows to the `RunState` the loop continues from (`shared/session/runStateFold.ts:535-552`).                                             |
| Publisher    | `SessionEvents`, the one inbox through which a session writes (`agent/runtime/SessionEvents.ts:219-370`).                                                                             |
| Commit, seq  | `commit` orders rows across the store; `seq` orders rows within an aggregate (`controllers/session/storeSchema.ts:72-82`).                                                            |

## 2. The store

### 2.1 One file per storage root

The store is one SQLite file named `texra.db` under the storage root
(`controllers/session/Database.ts:104`, `:228-231`); the file name and the
application id (`TeXR`) carry the product's name. An ephemeral session runs
the same schema in memory (`controllers/session/Database.ts:228-239`).

The store MUST carry application id `0x54655852` and schema version 101 in
SQLite's `user_version` (`controllers/session/storeSchema.ts:33-39`,
`:265-266`). A process MUST refuse, unchanged, a file with another
application id or a schema stamp at or above 101 other than its own
(`controllers/session/storeSchema.ts:204-217`). A store stamped below 101
that holds tables of the pre-1.0 format SHALL be copied whole to the first
free `<file>.pre1` name and started fresh; nothing in it is read again
(`controllers/session/storeSchema.ts:271-290`). A file SQLite reports damaged
at open SHALL be moved, with its WAL and shared-memory files, to
`<file>.corrupt-<ms>`, and a fresh store opened in its place
(`controllers/session/storeSchema.ts:374-411`).

A persistent store runs in WAL mode with `synchronous = NORMAL` and foreign
keys on (`controllers/session/storeSchema.ts:243-250`). Every write
transaction MUST begin with `BEGIN IMMEDIATE`
(`controllers/session/Database.ts:418-425`).

### 2.2 The event table and the envelope

Rows live in one table, `event`, keyed by `commit`, unique on
`(aggregate, seq)` (`controllers/session/storeSchema.ts:72-82`). Each row
carries an envelope that the store stamps and no caller supplies:

| Field    | Meaning                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `commit` | SQLite `AUTOINCREMENT` key: strictly increasing across the store, never reused (`controllers/session/storeSchema.ts:73`).           |
| `seq`    | Dense from 1 per aggregate (`controllers/session/Database.ts:115-122`).                                                             |
| `origin` | The writing process's identity, not the claim holder's (`controllers/session/Database.ts:730-738`).                                 |
| `at`     | Publish clock in whole milliseconds, one value for a whole batch; informational only (`controllers/session/Database.ts:1015-1021`). |

The first row of a `run` aggregate MUST be its `run.start`, and seq 1
MUST NOT hold any other row (`controllers/session/Database.ts:674-683`). A child's
`run.start` MUST name an open parent; the store stamps the parent's
incarnation `uid` in the child's creation transaction
(`controllers/session/Database.ts:692-714`). A `run.removed` row closes its
aggregate and every dependent; it requires this process's claim on every
open dependent, and a row MUST NOT be appended to a closed aggregate
(`controllers/session/Database.ts:115-122`, `:772-784`).

A payload string of 4096 or more characters is stored once per store as a
zstd blob under the sha256 of its JSON text; the row keeps a reference, and
the read verifies the digest (`controllers/session/rowCodec.ts:191-197`,
`:248-251`).

### 2.3 One publisher

Every write of a session is a job on one inbox drained by one fiber. Jobs
SHALL run in the order they were enqueued, one at a time, and the table's
commit order is that order (`agent/runtime/SessionEvents.ts:240-248`). A job
is one SQLite transaction: its appends commit together or not at all
(`agent/runtime/SessionEvents.ts:233-239`,
`controllers/session/Database.ts:997-1011`).

The publisher offers these doors:

| Door                   | What it does                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transact(job)`        | Enqueue a job and wait for its value (`agent/runtime/SessionEvents.ts:293-309`).                                                                            |
| `transact(job, order)` | A barrier with no transaction; its `append` is a defect (`agent/runtime/SessionEvents.ts:193-195`, `:236-238`).                                             |
| `detach(job)`          | Enqueue a job and return at once, for a producer with no fiber; its order is the moment of the call (`agent/runtime/SessionEvents.ts:319-342`).             |
| `removeRun`            | Prove owners, then commit a run's tombstone as the next job (`agent/runtime/SessionEvents.ts:310-318`).                                                     |
| `drain`                | End the inbox and run what it holds within the close deadline of 5,000 ms (`agent/runtime/SessionEvents.ts:251-289`, `agent/runtime/SessionHandle.ts:408`). |

A job MUST NOT wait on its own publisher; doing so is a defect
(`agent/runtime/SessionEvents.ts:197-202`, `:298`). A job MAY run again
whole when SQLite reports the database busy, so a job body MUST be
database-only (`controllers/session/Database.ts:450-468`). Effects a job
schedules with `afterCommit` SHALL run only after its transaction commits,
never for an attempt that rolled back (`shared/session/sessionEvents.ts:49-81`).
At the close deadline the running job is cut and every queued job refused
(`agent/runtime/SessionEvents.ts:262-287`). An awaited job enqueued after
close is a defect; a detached one is logged and dropped
(`agent/runtime/SessionEvents.ts:303-307`, `:336-341`).

Above the publisher, the session's own door (`SessionLog.transact`) SHALL
return only after the session's fold has folded every commit the job made
(`controllers/session/sessionStore.ts:257-266`). A claim a failed
transaction took SHALL be released (`controllers/session/sessionStore.ts:224-236`,
`:264`). Trace rows reach the publisher through `SessionLog.publish`
(`agent/runtime/SessionHandle.ts:102-106`), and `SessionLog.settled` is the
barrier after every job enqueued before it
(`controllers/session/sessionStore.ts:308-310`).

### 2.4 Row versions and the store gate

Each row kind carries its own version (`shared/schemas/rowVersions.ts:72-141`).
A row MUST be written at its kind's current version
(`controllers/session/rowCodec.ts:178-180`). The `stored_kind` table records
the highest version each kind was written at
(`controllers/session/Database.ts:606-607`).

The store gate refuses a store that names a kind or version this build does
not read (`controllers/session/rowCodec.ts:385-397`). It MUST run at open and
inside every outermost write transaction, so no build reads part of a store
or writes beside rows it cannot read (`controllers/session/Database.ts:296`,
`:463-466`). A core kind this build lacks and never retired counts as newer
(`controllers/session/rowCodec.ts:372-378`). Kinds a build deleted are listed
as retired; their rows fail only their own run's reads
(`shared/schemas/rowVersions.ts:44-56`, `controllers/session/rowCodec.ts:285`).

Before 1.0 a kind changes with no upcaster. Its version is bumped when an
older build's row would read wrong (`shared/schemas/rowVersions.ts:72-141`).
A row is then classified by the reader (`controllers/session/rowCodec.ts:267-332`):

| Stored version                 | Result                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| above the kind's current       | `DatabaseStoreNewer` (`controllers/session/rowCodec.ts:288-289`)                                       |
| below the lowest readable      | `DatabaseRowEarlier`, the run listed as an earlier build's (`controllers/session/rowCodec.ts:290-293`) |
| readable, payload fails parse  | `DatabaseRowCorrupt`, naming its commit (`controllers/session/rowCodec.ts:306-318`)                    |
| a plugin kind this build lacks | left out of every read, kept in the store (`controllers/session/rowCodec.ts:324-325`)                  |

A read of one run's history or records MUST fail on any row that does not
decode (`controllers/session/rowReader.ts:159-182`). A listing or a tail
leaves such a row out with one warning and marks its run unreadable
(`controllers/session/rowReader.ts:183-191`). A run whose rows do not decode
cannot be opened or resumed (`shared/session/runHistory.ts:98-104`,
`agent/runtime/resumeRun.ts:251-252`).

## 3. Row kinds

The vocabulary is one Zod discriminated union,
`SessionEventDraftSchema`, built from three groups
(`shared/schemas/sessionEvent.ts:441-445`). The groups below follow it. A
"folded" kind is one `foldRunState` reads (`shared/session/runStateFold.ts:352-474`,
`shared/session/turnMoves.ts:249-330`); every other kind on a run aggregate
is ignored by name, and an unknown kind is refused
(`shared/session/runStateFold.ts:175-206`, `:498-499`).

### 3.1 Run history rows (private to the runtime)

Read only through the run history; never sent to a renderer
(`shared/schemas/sessionEvent.ts:412-440`).

| Kind            | Folded | Meaning                                                                                                                                                                     |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.message` | yes    | One arm per invocation fact: `attempt`, `identified`, `accepted`, `cancelled`, `failed`, `response`, `handed-down`, `append` (`shared/schemas/runHistoryEvent.ts:136-235`). |
| `context.edit`  | yes    | Replaces messages `[from, to)` of the model's view; cause `compaction`, `reset`, `handoff` or `fork` (`shared/schemas/runHistoryEvent.ts:316-339`).                         |
| `tool.intent`   | yes    | A call's body starts, at an attempt number (`shared/schemas/runHistoryEvent.ts:385-392`).                                                                                   |
| `script.call`   | yes    | A call a `script` guest issued, with its arguments (`shared/schemas/runHistoryEvent.ts:349-370`).                                                                           |
| `tool.result`   | yes    | A call's one settlement and its disposition (`shared/schemas/runHistoryEvent.ts:401-450`).                                                                                  |
| `tools.offered` | yes    | The step's offered tools, system text and hooks, when they changed (`shared/schemas/sessionEvent.ts:424`).                                                                  |
| `context.blob`  | yes    | Model-facing content stored by sha256 address (`shared/schemas/sessionEvent.ts:425`).                                                                                       |
| `hook.outcome`  | yes    | A hook point's recorded outcome; a recorded point never runs again (`shared/session/runStateFold.ts:465-473`).                                                              |
| `child.turn`    | no     | A child loop's turn identity and fate, `accepted` or `settled` (`shared/schemas/sessionEvent.ts:435-439`).                                                                  |

The `model.message` arms:

| Arm           | Meaning                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `attempt`     | A billed request is about to leave; names its recorded request by sha256 and its origin.           |
| `identified`  | The provider's response id, seen before completion.                                                |
| `accepted`    | A background operation the provider accepted, with its admitted deadline.                          |
| `cancelled`   | A user stop the provider confirmed for an accepted operation.                                      |
| `failed`      | The attempt failed: its error and the move after it (`retry`, `unchain`, `ask`, `stop`, `cancel`). |
| `response`    | The completed turn, its dispatch facts per call, and its priced usage.                             |
| `handed-down` | The one call a script's run opens on; no model made it.                                            |
| `append`      | Messages added to history; with `sourceResponse`, the tool group that delivers a response.         |

### 3.2 Run records (private to the runtime)

`run.report` holds the run's report text, `run.result` its result
metadata, and `followup.closed` marks its input closed until a claim
reopens it (`shared/schemas/sessionEvent.ts:404-411`).

### 3.3 Display rows (session-authored and run-authored)

Every renderer folds these (`shared/schemas/sessionEvent.ts:294-403`; the
table's line numbers are in that file). Kinds marked "folded" are also read
by `foldRunState`.

| Kind                    | Folded | Meaning                                                                                      |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `run.start`             | no     | The run's existence: identity, parent edge, provenance, launch approval policy (`:251-265`). |
| `run.activate`          | yes    | One activation: the first launch or a resume (`:303-305`).                                   |
| `run.config`            | yes    | What the run runs on: configuration, model, binding (`:306-310`).                            |
| `run.model`             | no     | A model switch; projected by the store, never stored (`:311`).                               |
| `run.detach`            | no     | A stop severed the parent edge (`:312-314`).                                                 |
| `run.end`               | no     | The terminal fact: outcome, classified error, output (`:315-322`).                           |
| `conversation.progress` | no     | Conversation progress (`:323`).                                                              |
| `run.fact`              | no     | One family of run facts, latest per key (`:324`).                                            |
| `child.park`            | no     | A child loop's park: `parked`, `resumed`, `paused` (`:325-341`).                             |
| `run.removed`           | no     | The tombstone: last row of its aggregate, final (`:268-270`).                                |
| `run.description`       | no     | A title, by `model` or `user` (`:343-348`).                                                  |
| `plugin.fact`           | no     | A plugin's own kind; core never reads `value` (`:280-292`).                                  |
| `followup.queued`       | no     | Input not taken yet, whole (`:350-365`).                                                     |
| `followup.consumed`     | no     | That input became a turn's message, in the message's batch (`:366-368`).                     |
| `request.opened`        | yes    | A run asks a person (`:369-376`).                                                            |
| `request.decided`       | yes    | The answer (`:377-386`).                                                                     |
| `approval.policy`       | no     | A change of the run's approval policy (`:387`).                                              |
| `run.position`          | yes    | Where the loop stands (`:388-394`).                                                          |

The transcript tier is display rows too (`shared/schemas/traceEvent.ts:22-88`):
`log`, `stage.start`, `stage.end`, `tool.start` (a call's card opens),
`tool.end` (it closes), `usage` (one priced turn; a run with a run history
stores none), `context.state`, `stream.start`, `stream.end`, and
`response.finalized` (the final text of a turn). `response.finalized` is
read by the fold (`shared/session/runStateFold.ts:166`).

Streamed text (`stream.chunk`) is transient. It is not an arm of the
vocabulary and never a row (`agent/runtime/loop/toolUseDispatch.ts:549-567`).

## 4. Write points

A run's history is written through its run cell, `RunCell.append`, which
commits one batch per call (`agent/runtime/RunHistory.ts:404-415`). The
loop's write points are normative:

| #   | Fact                                 | Rule                                                                                 | Code                                                                                                         |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| W1  | `model.message` `attempt`            | commits before the billed request leaves the process                                 | `agent/runtime/ModelInvoker.ts:489-511`; summary: `:789-801`                                                 |
| W2  | `model.message` `response`           | commits, with `run.position` `response.ready`, before any tool call dispatches       | `agent/runtime/ModelInvoker.ts:385-401`; `agent/runtime/loop/toolUse.ts:342-349`                             |
| W3  | `tool.intent`                        | commits after PreToolUse hooks and the guard, before the body runs, once per attempt | `agent/runtime/loop/toolUseDispatch.ts:576-608`; `agent/runtime/loop/toolGuard.ts:119-129`                   |
| W4  | `tool.result`                        | commits, with the call's card rows, before the delivery that lets the loop continue  | `agent/runtime/loop/toolUseDispatch.ts:434-457`, `:709-732`, `:1164-1169`                                    |
| W5  | `run.position`                       | commits at every wait and every halt                                                 | `agent/runtime/loop/toolUse.ts:263`, `:292-294`, `:461`, `:534-545`; `agent/storage/runLifecycle.ts:239-273` |
| W6  | `model.message` `failed`             | commits for every failed attempt, naming the next move                               | `agent/runtime/ModelInvoker.ts:622-682`, `:714-716`; `agent/runtime/run/invocation.ts:383-393`               |
| W7  | `request.opened` / `request.decided` | the opening commits before any wait; a decision commits once                         | `agent/runtime/requestPolicy.ts:272-290`, `:341-353`                                                         |

**W1.** The invoker MUST commit the attempt's rows, the blobs of its request
context and the `attempt` row, before it streams or submits the request
(`agent/runtime/ModelInvoker.ts:489-511`,
`agent/runtime/run/requestContext.ts:136-164`). A compaction summary records
its attempt the same way, with `purpose: 'summary'`
(`agent/runtime/ModelInvoker.ts:789-801`).

**W2.** A completed turn MUST commit once, as one `response` row with a
fresh `responseId` and one dispatch fact per local call, in the batch that
moves the position to `response.ready` (`agent/runtime/ModelInvoker.ts:378-401`,
`shared/schemas/runHistoryEvent.ts:236-296`). The loop MUST dispatch only
the pending response its fold holds (`agent/runtime/loop/toolUse.ts:342-349`).

**W3.** A call's `tool.intent` MUST commit after its PreToolUse hooks and its
guard, and before its body (`agent/runtime/loop/toolUseDispatch.ts:576-608`,
`agent/runtime/loop/toolGuard.ts:119-129`). The guard asks for a command's
approval (`agent/runtime/loop/toolGuard.ts:40-47`, `:103-113`). A slow tool's
`tool.start` card MUST commit in the intent's batch
(`agent/runtime/loop/toolUseDispatch.ts:597-600`). An attempt whose intent is
already committed MUST NOT commit another
(`agent/runtime/loop/toolUseDispatch.ts:596`).

**W4.** A call's `tool.result` MUST commit with its whole card: a slow tool's
`tool.end`, a fast tool's `tool.start` and `tool.end`
(`agent/runtime/loop/toolUseDispatch.ts:484-504`, `:696-699`). The delivering
`append` MUST commit only once every call of the response has settled, as
one tool group bound to the response (`agent/runtime/loop/toolUseDispatch.ts:1164-1169`).
A delivery its settlements do not match is a defect
(`agent/runtime/RunHistory.ts:275-277`).

**W5.** The positions are `turn.ready`, `turn.begin`, `response.ready`,
`results.ready`, `turn.end`, `waiting` and `halted`
(`shared/schemas/runHistoryEvent.ts:83-91`). A `halted` position MUST carry
an outcome, and every other position MUST NOT carry one
(`shared/schemas/runHistoryEvent.ts:106-109`). The `halted` position MUST
commit in the same batch as the run's `run.end`
(`agent/storage/runLifecycle.ts:239-273`, `agent/runtime/loop/rows.ts:66-79`).

**W6.** Every failed attempt MUST commit a `failed` row whose `next` is the
move after it (`agent/runtime/run/invocation.ts:383-393`,
`agent/runtime/ModelInvoker.ts:622-639`). A `failed` row that asks MUST be
preceded, in its batch, by the `request.opened` of its retry request
(`agent/runtime/ModelInvoker.ts:670-681`, `shared/session/runHistory.ts:141`).

## 5. The fold

### 5.1 `RunState`

`RunState` is what the loop continues from: the position, the run's facts,
the canonical message history, the open invocation, the pending response,
the requests, and the offered tools and contents
(`shared/session/runStateFold.ts:95-153`). It has no schema and is never
persisted (`shared/session/runStateFold.ts:90-94`).

### 5.2 Grammar

`foldRunState(state, rows)` folds rows in order. It MUST refuse a row whose
commit is not above the last folded one (`shared/session/runStateFold.ts:493-497`).
Each folded kind has one line of the grammar: where it may fold (on any
state, on a held one, on an opened run, on an unopened one) and its move
(`shared/session/runStateFold.ts:303-319`, `:500-523`). A refusal is a typed
`RunHistoryInconsistent` with a reason: `out-of-order`, `orphan-settlement`,
`unknown-run-row`, `mismatched-delivery` or `unreadable-turn`
(`shared/session/runStateFold.ts:77-88`). The fold never defaults a row it
cannot apply (`shared/session/runStateFold.ts:540-551`).

A run is opened by its first `run.position`. Run history rows without an
opening position MUST fail the load as `inconsistent`
(`agent/runtime/RunHistory.ts:227-236`).

### 5.3 Phases

The fold maps a position to a loop phase: `turn.ready` and `waiting` to
`waiting`, `turn.begin` to `model.ready`, `response.ready` to
`model.submitted`, `results.ready` to `results.ready`, and `turn.end` to
`halted` (`shared/session/runRows.ts:96-109`).

A `halted` position keeps the phase the loop stopped in, so a resume
continues from there (`shared/session/runRows.ts:109`).

### 5.4 The commit path

`RunCell.append` MUST fold the batch onto the cell's state before it
publishes, and MUST refuse, with nothing committed, a batch the fold rejects
(`agent/runtime/RunHistory.ts:272-278`). It MUST check the assembled message
history against `PreparedHistorySchema` from where the batch changes it
(`agent/runtime/RunHistory.ts:279-292`). It MUST refuse a durable model
origin carrying userinfo, a query string or a fragment
(`agent/runtime/RunHistory.ts:264-271`). After the commit it folds the
committed rows, at the commits the store assigned, and that state is the one
the loop continues from (`agent/runtime/RunHistory.ts:317-323`). The
read-append-fold region is uninterruptible and serialized per run
(`agent/runtime/RunHistory.ts:404-415`).

A batch that carries a `context.edit` with a `response` MUST place the edit
immediately before the response, and an edit MUST be the first
message-bearing row of its batch (`agent/runtime/RunHistory.ts:76-87`).

### 5.5 Resume is the same function

The loop holds no copy of the conversation. It reads every branch off the
fold, so the live path and the resume path are the same steps
(`agent/runtime/loop/toolUse.ts:426-439`, `:441-514`). A resume enters the
same program, `runToolUse`, with `resume: true`
(`agent/runtime/executeAgent.ts:128-138`), reached from `resumeRun` through
`resumeToolUseFromResumeData` (`agent/runtime/resumeRun.ts:315-319`,
`agent/runtime/executeAgent.ts:359-362`).

A resume MUST be refused when the rows hold no opened run
(`agent/runtime/loop/runProgram.ts:82-88`). A fresh launch MUST be refused
when the run already holds history state
(`agent/runtime/loop/runProgram.ts:97-102`).

## 6. Retry

Every model call MUST go through one loop, `runInvocation`
(`agent/runtime/run/invocation.ts:355-395`; callers
`agent/runtime/ModelInvoker.ts:688`, `agent/runtime/run/modelCall.ts:119`).
Its next move is `nextAttempt(invocation, requests)`, read off the
invocation's rows before every move (`agent/runtime/run/invocation.ts:367-369`,
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
(`shared/session/inFlight.ts:259-278`):

- A `continuation-gone` failure of an attempt that sent a continuation
  answers `unchain`, once per invocation (`shared/session/inFlight.ts:265-270`,
  `agent/runtime/run/invocation.ts:292-296`).
- A retryable failure answers `retry` while the automatic attempts the rows
  record, `unchain` excluded, are fewer than the budget
  (`shared/session/inFlight.ts:271-274`). The budget is counted from rows,
  so a crash does not refill it.
- Past the budget, a failure a person may retry answers `ask` under a fresh
  request id; where nobody can be asked, `stop`
  (`shared/session/inFlight.ts:275-277`).
- A failed observation of an accepted operation is never automatic
  (`agent/runtime/run/invocation.ts:292-301`).

Every automatic send MUST run under the process's `ModelRetryGate`, so all
runs on one credential share its cooling (`agent/runtime/run/invocation.ts:42-47`,
`:205-221`). An observation runs outside it
(`agent/runtime/run/invocation.ts:222`). The loop pauses 1,000 ms before an
automatic resend (`agent/runtime/run/invocation.ts:50`, `:257-274`).

An attempt of an invocation a person admitted, whose outcome no row
recorded, MUST be asked about again and MUST NOT be resent unasked
(`shared/session/inFlight.ts:213-217`). The ask is a new `failed` row on that
attempt, with `next: ask` (`agent/runtime/ModelInvoker.ts:743-759`). An
attempt no person admitted, whose outcome no row recorded, is resent
(`shared/session/inFlight.ts:217`).

A rejected subscription token MAY be renewed once per invocation; the
renewed attempt is resent without a `failed` row
(`agent/runtime/run/invocation.ts:152-175`, `:336-348`).

## 7. Claims and several processes

There is no daemon. Several processes MAY open one store at once; each holds
its own connection, publisher and fold, and sees the others' commits through
a 250 ms poll of SQLite's `data_version`
(`controllers/session/Database.ts:357-388`).

### 7.1 Claims

Each aggregate has at most one owner, the `owner_id` of its sequence row
(`controllers/session/storeSchema.ts:56-67`). The first append to an
aggregate creates it and claims it for the writer
(`controllers/session/Database.ts:115-122`). A later append MUST be refused
with `DatabaseNotOwner`, and nothing written, unless the writer holds the
claim and the aggregate is open (`controllers/session/Database.ts:115-122`,
`:641-653`). A `plugin.fact` on a `plugin` aggregate borrows an unheld claim
for its own transaction only (`controllers/session/Database.ts:620-624`,
`:766-771`).

A process takes a claim in one write transaction that reads the claim state
and moves it (`controllers/session/Database.ts:905-923`). It MUST NOT take a
claim from another owner unless that owner is proven dead in the same
attempt (`controllers/session/storeAside.ts:69-83`,
`controllers/session/Database.ts:546-559`). A live owner refuses with
`DatabaseClaimRefused`. An owner whose liveness is unprovable is treated as
live, except when the user deletes a single run
(`controllers/session/storeAside.ts:78-82`).

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
writes no row (`controllers/session/Database.ts:480-481`, `:988-996`).

### 7.2 Resume under a claim

A resume MUST hold the run's claim before it reads the run's state, and
holds it until the launched run holds its own
(`agent/runtime/resumeRun.ts:188-196`). A run another live process holds
answers `owned_elsewhere` (`agent/runtime/resumeRun.ts:196`). A run live in
this process is refused (`agent/runtime/resumeRun.ts:174`). A child an open
call of its parent owns resumes through that parent
(`agent/runtime/resumeRun.ts:199-200`, `:104-114`).

The resume's activation is one transaction: it takes the claim, folds the
stored rows, and commits the activation rows with a `request.decided`
`cancel` for every request the previous owner left unbound
(`agent/runtime/RunHistory.ts:354-384`). A request is unbound unless it is
the turn's open retry ask, the request a pending call's resumed attempt
re-enters, or an `externalInquiry` (`shared/session/runStateFold.ts:249-270`).

### 7.3 What a second process may and may not do

| A process MAY                                             | Code                                             |
| --------------------------------------------------------- | ------------------------------------------------ |
| read every committed row, listing and tail                | `controllers/session/Database.ts:798-904`        |
| create a new run, which it then owns                      | `controllers/session/Database.ts:115-122`        |
| fork a run another process holds, from its committed rows | `controllers/session/SessionRequests.ts:160-163` |
| take over a run whose owner is proven dead                | `controllers/session/storeAside.ts:69-83`        |

| A process MUST NOT                                          | Code                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| append to an aggregate another process holds                | `controllers/session/Database.ts:641-653`        |
| answer a request of a run a live process holds (`NotOwner`) | `controllers/session/SessionRequests.ts:159-171` |
| resume a run a live process holds                           | `agent/runtime/resumeRun.ts:195-196`             |
| write to a store a newer build wrote                        | `controllers/session/Database.ts:463-466`        |

A run that loses its claim mid-run gets `RunHistoryRefused` `not-owner` from
its next append, with nothing written (`agent/runtime/RunHistory.ts:176-198`,
`:311-316`). A tool call that meets a storage refusal fails the dispatch
instead of settling (`agent/runtime/loop/toolUseDispatch.ts:647-649`).

## 8. Requests

### 8.1 Kinds

The request kinds are a closed union (`shared/schemas/progressView/data.ts:160-180`):

| Kind              | Asks                                       | Parks its caller |
| ----------------- | ------------------------------------------ | ---------------- |
| `toolEdit`        | approval of a file edit                    | yes              |
| `bash`            | approval of a command                      | yes              |
| `retry`           | whether to retry a failed model attempt    | yes              |
| `proposal`        | approval of a proposed agent run           | yes              |
| `planApproval`    | approval of a plan                         | yes              |
| `externalInquiry` | an answer from an external model, as input | no               |
| `userQuestion`    | answers to questions                       | yes              |

Every kind parks the tool that opened it except `externalInquiry`, whose
answer arrives as a follow-up (`shared/schemas/progressView/data.ts:196-200`).

### 8.2 Decisions

A decision is one of `approve`, `approve_and_goal`, `setup`, `submit`,
`answer`, `skip`, `retry`, `reject`, `deny` and `cancel`
(`shared/schemas/request.ts:20-55`).

### 8.3 Protocol

- A request's id is part of its payload (`agent/runtime/requestPolicy.ts:325`).
  A tool call's request id is derived from the response, call, attempt and
  ordinal, so a resumed attempt rejoins the request it left standing
  (`shared/session/inFlight.ts:308-311`).
- The opening and any decision the approval policy gives at once MUST
  commit in one batch, so no surface lists it pending
  (`agent/runtime/requestPolicy.ts:341-353`).
- A decision MUST commit only if its request is open and undecided; the
  first decision wins, and a later one writes nothing
  (`agent/runtime/requestPolicy.ts:272-290`).
- The asker waits on the committed `request.decided` row, read from the
  tail (`agent/runtime/requestPolicy.ts:292-318`).
- An interrupted asker MUST decide its request `cancel` through the same
  door, unless the session is closed
  (`agent/runtime/requestPolicy.ts:370-395`).
- A request is a row, so it outlives its process. A resume cancels the
  unbound ones (section 7.2) and re-enters the bound ones under the same id
  (`shared/session/inFlight.ts:346-370`).

## 9. Crash guarantees

The crash-point suite is the source of truth for this section
(`src/test-kernel/support/crashConformance.ts:1-56`). It runs under the
harness's built-ins and under a full app's plugins
(`src/test-kernel/controllers/session/crashConformanceBuiltins.vitest.ts:9`,
`src/test-kernel/controllers/session/crashConformanceTexra.vitest.ts:9`).

Its method: drive a clean run over a real store, record the commit each
write transaction ended at, and for each such commit N copy the store, cut
it to commits 1..N, hand its claims to a dead owner, reopen it in a fresh
session and resume the root run
(`src/test-kernel/support/crashConformance.ts:8-27`).

The guarantees, numbered as in the package README:

| #   | Guarantee                                                                                                                                       | Asserted by                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| I1  | Recovery reaches the clean run's outcome: its answers, view edits, call results, owned children and fork.                                       | `crashConformance.ts:30-32`, `:761` |
| I2  | A call settled before the crash is not executed again, and no call settles twice.                                                               | `crashConformance.ts:33`, `:761`    |
| I3  | One model invocation has at most one committed response.                                                                                        | `crashConformance.ts:38`, `:761`    |
| I4  | A command runs only after its approval; an unfinished call whose outcome is unknown runs again only after a person's retry.                     | `crashConformance.ts:34-35`, `:761` |
| I5  | An owned child that ended cleanly answers its call; it is not launched again without a person's retry; no child is left without a terminal row. | `crashConformance.ts:39-40`, `:873` |
| I6  | A child's result is delivered to its parent once, never lost, including while the parent was held elsewhere.                                    | `crashConformance.ts:865-886`       |
| I7  | A fork keeps the history it was registered with; handoff and compaction keep the context they committed.                                        | `crashConformance.ts:41`, `:761`    |
| I8  | A run's halt commits with its end; a stopped run never reads as interrupted.                                                                    | `crashConformance.ts:43-44`, `:761` |
| I9  | Turning off a run's shell bypass is acknowledged only after its row is durable.                                                                 | `crashConformance.ts:53-54`, `:761` |

The paths in this table are under `src/test-kernel/support/`. The suite also
asserts that a crash between a request and its answer leaves the request
pending and the resume answers that same request; that a crash between the
answer and the body honours the answer; and that a crash inside one
publisher job leaves neither half on disk
(`src/test-kernel/support/crashConformance.ts:49-56`, `:1120`).

What survives at each commit point follows from sections 2 to 8:

| Cut after                    | On resume                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempt`                    | The attempt has no outcome: resent, or asked again if a person admitted the invocation (section 6).                                                                                                                                      |
| `accepted`                   | The operation is observed under its recorded deadline, not resubmitted (`shared/session/inFlight.ts:211-212`).                                                                                                                           |
| `response`                   | The response is reused; no new invocation is made for it (`agent/runtime/loop/toolUse.ts:342-353`).                                                                                                                                      |
| a call's requests, no intent | The call re-enters the request it asked (`shared/session/inFlight.ts:363-364`).                                                                                                                                                          |
| `tool.intent`, no result     | Re-run only if both the stored and the current tool declare `replay: 'safe'` and the stored arguments validate; else settled as outcome unknown (`agent/runtime/loop/toolUseDispatch.ts:740-767`, `agent/runtime/run/tools.ts:107-138`). |
| `tool.result`                | The settlement is reused; the call is not run again (`agent/runtime/loop/toolUseDispatch.ts:1034-1035`).                                                                                                                                 |
| delivery `append`            | The loop continues to the next step from `results.ready` (`shared/session/runRows.ts:96-104`).                                                                                                                                           |
| `request.opened`             | The request stays pending under the same id, or is cancelled if unbound (section 7.2).                                                                                                                                                   |
| `run.end` with `halted`      | The run is finished; a resume answers `finished` (`agent/runtime/resumeRun.ts:203-206`).                                                                                                                                                 |

These are guarantees about committed state. An external effect that
finished before its result committed stays uncertain; I4 governs it, and
the suite cannot place a cut between an effect and its result. One real kill
covers that case: a process killed after its command's effect and before
its result reports the command as outcome unknown and never reruns it
(`src/test-kernel/controllers/session/goldenStore.vitest.ts:638`).

## 10. Conformance

These existing suites check the sections above. Paths are under
`src/test-kernel/`.

| Section               | Suite and case                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 file and schema   | `controllers/session/sessionEvents.vitest.ts:1604` (pre-1.0 moved aside), `:1658`, `:1704` (foreign file refused), `:1738` (damaged file moved aside), `:1977` (newer schema refused)                                                    |
| 2.2 envelope          | `controllers/session/sessionEvents.vitest.ts:2183` (dense seq, one commit order), `:2222` (parent incarnation), `:2496` (ordinals never reused), `:2546` (blobs)                                                                         |
| 2.3 publisher         | `controllers/session/sessionEvents.vitest.ts:429` (enqueue order), `:2435` (a rejected batch rolls back whole), `:2001`, `:2099`; `support/crashConformance.ts:1120` (one job, one transaction)                                          |
| 2.4 versions and gate | `schemas/rowVersions.vitest.ts:113`, `:131`, `:165`; `controllers/session/sessionEvents.vitest.ts:1771` (newer build refused), `:1849` (undecodable row), `:1918` (earlier build's row); `controllers/session/goldenStore.vitest.ts:215` |
| 3 row kinds           | `controllers/session/goldenStore.vitest.ts:215` (every golden row decodes); `schemas/rowVersions.vitest.ts:113`                                                                                                                          |
| 4 write points        | `support/crashConformance.ts:761`, `:1176`                                                                                                                                                                                               |
| 5 fold                | `controllers/session/sessionEvents.vitest.ts:3419` (live state equals reloaded state), `:3451` (batch contract); `controllers/session/goldenStore.vitest.ts:367`                                                                         |
| 6 retry               | `agent/runtime/RetryState.vitest.ts:630`, `:708`, `:872` (asks again after a stop), `:972` (budget), `:1004` (unchain once), `:1088`; `agent/runtime/ModelRetryGate.vitest.ts:119`                                                       |
| 7 claims              | `controllers/session/sessionEvents.vitest.ts:843`, `:924`, `:2722`, `:2961` (another OS process), `:3073` (dead owner reclaimed), `:3123` (second writer fenced); `agent/runtime/resumeRun.vitest.ts:98`                                 |
| 8 requests            | `controllers/session/sessionEvents.vitest.ts:717`; `support/crashConformance.ts:49-52`                                                                                                                                                   |
| 9 crash guarantees    | `controllers/session/crashConformanceBuiltins.vitest.ts`, `controllers/session/crashConformanceTexra.vitest.ts`, `controllers/session/goldenStore.vitest.ts:638`                                                                         |

## 11. Non-goals

- **No daemon.** The CLI or SDK process is the unattended runner; the
  permanent shape is several processes on one store, each aggregate held by
  one claim (`.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md`,
  "No daemon; several processes on one store (D4)";
  `.agents/docs/proposed/architecture/2026-10-02-durable-harness.md`,
  "Considered and dropped").
- **No third-party code in process.** Third-party plugins are data, MCP
  servers and out-of-process hooks
  (`.agents/docs/proposed/architecture/2026-10-02-durable-harness.md`,
  "Owner rulings", item 1).
- **No second storage backend or dialect.** There is one SQLite store on
  purpose (`.agents/docs/proposed/architecture/2026-10-02-durable-harness.md`,
  "Considered and dropped").
- **Closed request kinds.** The request kinds of section 8.1 are fixed;
  typed-RPC code plugins and an open schema registry wait for a named plugin
  that cannot be MCP plus hooks plus data
  (`.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md`,
  "SDK and typed-RPC deferral (D11)").
- **No exactly-once external effects.** The protocol promises one
  settlement per call, not one execution of an arbitrary external effect
  (section 9).

## 12. Open questions

1. CLAUDE.md names the publisher's jobs `publish`, `exclusive`, `detach` and
   `settle`, and the core-concepts note names `publish`, `exclusive` and
   `detach`. The code's doors are `transact`, `detach`, `removeRun` and
   `drain` on `SessionEvents` (`agent/runtime/SessionEvents.ts:357-368`), and
   `transact`, `publish` and `settled` on `SessionLog`
   (`agent/runtime/SessionHandle.ts:89-110`). This spec uses the code's names.
2. CLAUDE.md, the durable-harness note and a comment in
   `shared/session/runStateFold.ts:2` name the commit path
   `RunHistory.appendBatch`. No such member exists; the code's path is
   `RunCell.append` (`shared/session/runHistory.ts:151-156`).
3. The brief for this spec names `RunHistory.activate`. It is a private
   function of `makeRunHistory`, reached as `RunHistory.open` with an
   `activation` (`agent/runtime/RunHistory.ts:354`, `:390-394`).
4. `packages/harness/AGENTS.md` and the README say `tool.intent` commits
   after a call's hooks, guard and approval. The guard asks only for tools
   with a declared command guard or `requiresApproval`; a tool whose body
   opens its own request, such as a file edit's approval
   (`tools/approval/toolEditApproval.ts:239`), asks after its intent
   committed (`agent/runtime/loop/toolGuard.ts:45-47`). Resume handles that
   case (`shared/session/inFlight.ts:346-370`), but the stated order is not
   universal.
5. The durable-harness note states the contract as "no attempt is billed
   twice". The code resends an attempt that no person admitted and whose
   outcome no row recorded (`shared/session/inFlight.ts:217`); the earlier
   attempt may have been billed. The suite asserts at most one committed
   response per invocation (I3), not one billing.
6. The durable-harness note says "the fold refuses `run.end` on a parent
   whose projection holds an open owned call". The refusal found is in the
   run lifecycle, not the fold (`agent/storage/runLifecycle.ts:282-296`, `:319`).
7. The core-concepts note says an uncertain storage failure is fatal for the
   session. The code ends the run and fails the call
   (`shared/session/runHistory.ts:68-86`); no code was found that closes the
   session on such a failure.
8. The durable-harness note says "the specification is the tests, not
   prose". This document restates the tests and the code; where it and they
   disagree, they win.
