# One run model: one log, one fold, one vocabulary

Status: implemented

"A run" is declared once. Every layer derives its identity, parent, phase,
result, events, pending questions and view from that one declaration, rather
than each layer keeping its own copy. Code comments cite this note by
section ("one run model, 3.7"); keep the numbering when editing.

## 1. Why

Duplicated run vocabulary had one cause: a run was declared once per layer
and once per era, and every layer kept its own copy of the run's facts. Each
copy was defensible on its own; together they were a dual system. Fixing
them family by family would leave the cause in place, so the run model is
stated once and everything else is derived or deleted.

## 2. The four rules

**R1. One fact log, one fold per question, one immutable view.** The
runtime writes facts to one append-only log. State is a pure fold over that
log, published as a value; a renderer is a function of the value. A fact is
written as exactly one row type; a derived value has exactly one fold;
nothing derived is persisted and nothing persisted is derived. Two folds are
legitimate only when they answer different questions over the same rows
(display, `sessionViewUpdate.ts`, versus resume, `applyRunRows`); rows both read go
through one reducer (`shared/session/runRows.ts`). There is no snapshot: a
run resumes by folding its rows.

**R2. Commands in, facts out.** A UI never calls the runtime. It sends an
intent from one command vocabulary; the runtime answers with facts. A request
awaiting a person is a request fact with no decision fact yet. Hosts render
"pending" from the view and send a decision command. Host adapters hold no
state, and the runtime holds no promise across the wait: the run parks, and
after a restart it resumes from the log.

**R3. One protocol at every process boundary.** In-process, IPC and stdio
carry the same view and command types. An external contract is a versioned
projection of the view, never a second vocabulary with renamed keys.

**R4. Identity is minted once and never encoded.** One id per run, assigned
at `run.start`, keying every fact about that run. Display names are fields
on facts. A name glued onto an id is the tell that a second vocabulary grew.

Per-viewer state (selection, expansion, drafts, scroll) is the viewer's and
stays out of the view (`packages/texra/src/shared/session/surface.ts`).

## 3. The model

Schemas below are in `packages/harness/src/shared/schemas/` unless named
otherwise.

| Fact about a run   | Declared once as                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Identity           | `RunId` (branded, `identifiers.ts`); `RunIdentity` for what kind of run it is (`runIdentity.ts`) |
| Parent edge        | `parent` on `run.start`; `run.detach` severs it                                                  |
| Phase and outcome  | `RunPhase`, folded from lifecycle rows; `RunOutcome` its terminal subset (`run.ts`)              |
| Tool-call outcome  | `ToolCallStatus` on the call's card; the card's status is the fold of it                         |
| Result             | The `run.end` row (`RunEndRowSchema`, `runRecords.ts`); cost is `usage.totalCost` only           |
| Events             | `sessionEvent.ts` is the vocabulary; the trace union is the same arms                            |
| Waiting on a human | `request.opened` / `request.decided` over the `PermissionPayload` kinds; pending is the fold     |

### 3.1 Identity

`RunIdSchema` is branded, so a site that confuses a run id with another
string fails `npm run typecheck`. One run owns one aggregate,
`('run', runId)`: display rows and the run's private history rows land on
the same aggregate, and whether a row reaches a renderer is a property of
its type (`isDisplaySessionEvent`), not of a second aggregate. One sequence
counter, one claim per run.

The run's kind and name travel as `RunIdentity` on `run.start` and on every
`RunView`; `runIdentityName` and `runIdentityDisplayName` are the one owner
of its name. No id carries a name prefix.

### 3.2 Parent edge

`run.start` carries `parent: { id, uid, callId } | null`: the launching
run, that run's incarnation (stamped by the database in the child's creation
transaction), and the tool call that launched it. Every other spelling of
"is a child" is `parent !== null`, computed from the fold or the handle.

A run has two edges, and they are read separately:

- **The creation edge** is immutable: `run.start.parent`, held in memory as
  `RunHandle.launchParent` ("the parent its birth writes, never cut").
- **The current edge** moves once at most: `run.detach`, written when a stop
  detaches the run from its parent, severs it. `RunRegistry.parentOf` reads
  the current edge from the rows. A run never gets a new parent.

Deriving creation-edge behavior from the current edge would flip a detached
child into root behavior mid-flight; keep the two readings apart.

### 3.3 Phase, outcome and tool-call status

`RunPhase` is `running`, `waiting`, and the three `RunOutcome` values. It is
folded from rows that already exist, and no row carries the phase itself:
`run.start` and `run.activate` put a run in `running`, a `run.position` at a
waiting position parks it, a later `run.activate` resumes it, and `run.end`
ends it. The terminal fact is written once, as `run.end { outcome, error?,
output }`, by the storage finalizer after the run's last transcript row; the
fold derives the terminal phase from it and from nothing else. What a
producer recorded beside it goes in `run.result` (`ResultMetaSchema`), which
never copies outcome, error, usage or files.

A tool call's status is one `ToolCallStatus` (`progressView/data.ts`) on its
card's `tool.end`; there is no `isError` boolean beside it and no
render-time repair.

### 3.4 Result

`RunEndSchema` (`runRecords.ts`) is the one declaration of what a run
produced: outcome, classified error, usage and output (`response`, `files`,
`structured`). Every in-memory result reader returns it; usage is derived on
read from the run history's priced response rows, so the stored row omits
it (`RunEndRowSchema`). Cost is `usage.totalCost` and nothing else. A run's
description is one row, `run.description`.

### 3.5 Events

`sessionEvent.ts` is the only event vocabulary. The SDK trace union
(`AgentEvent`, `packages/harness/src/agent/trace/events.ts`) is the same
arms minus the aggregate qualification, which `runEventDraft` adds back at
publication. `stream.chunk` is the one transient arm and never becomes a
row. `run.end` is not a trace arm: the storage finalizer writes it once.

### 3.6 The CLI projection

The headless CLI's NDJSON output is a versioned projection of
`SessionEvent` and `SessionView`: each display row goes out as one
`kind: "progress"` record whose `event` is the row's `type` and whose
`payload` is the rest of the row, field names untouched
(`packages/cli/src/runtime/sessionProgressSubscription.ts`), stamped with the
contract version (`CLI_NDJSON_CONTRACT`, `packages/cli/src/schemas/cliOutput.ts`).
There is no rename table.

The usage-log edge function's `stream_id` column is ruled the one
permanently frozen external spelling of the run id (see the
[rulings ledger](2026-08-01-architecture-rulings-ledger.md)); do not rename
it.

### 3.7 Waiting on a person

The things a run asks a person are one list, `PermissionPayload['kind']`
(`progressView/data.ts`). There is one pair of rows over all of them,
`request.opened { requestId, payload }` and
`request.decided { requestId, decision }`, and one decision union,
`RequestDecision` (`request.ts`). Pending is the fold: opened without
decided. Hosts read pending from the view and send a decision command; the
runtime holds no promise, and after a restart the fold sees the open
request and the run parks again. Every surface's decision enters through one
door (`SessionRequests`, `packages/harness/src/controllers/session/`).

Whether a kind parks the run is a property of the tool, not of the
protocol. The external inquiry does not park: its tool returns at once, its
thread keeps a cross-project record (a current value, because cross-project
scope is a real difference), and its answer reaches the run by the one rule
**a `request.decided` for a request its run is not parked on is delivered as
a follow-up** (`packages/texra/src/tools/inquiry/inquiryActions.ts`). There
is no second inquiry protocol.

### 3.8 Views

There is one view fold, `SessionView` with `RunView` entries in
`SessionView.runs` (`packages/harness/src/shared/session/sessionView.ts`),
and backend readers take the same view as renderers. The resume fold
(`applyRunRows`) is a different question over the same rows and stays
separate.

### 3.9 Model identity

Usage is billed per wire surface, so a usage record's provider is the
protocol of the turn that produced it (`TurnProtocolSchema`,
`packages/llm/src/protocol.ts`), read off the origin the package attaches to
every response, not a hand-kept provider list.

### 3.10 Names: one word, and it is "run"

A run is a run in every layer, row, service and file name: `RunId`, the
`run` aggregate, the `run.*` rows, `RunView` in `SessionView.runs`,
`RunPhase`, `RunHandle`, `RunRegistry`. The per-run service is `AgentRun`
(`packages/harness/src/agent/runtime/run/AgentRun.ts`). In the code,
"execution" names no run type, row or service (the model-facing `executions`
tool keeps its name), and "stream" names only what streams, such as a
provider's token stream. Nothing new is named with either retired word.
