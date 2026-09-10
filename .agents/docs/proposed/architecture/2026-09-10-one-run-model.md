# One run model for TeXRA 1.0: one log, one fold, one vocabulary

Status: proposed — the target shape the
[duplicate-concept census](2026-09-10-collapse-duplicate-concepts.md) was
circling, stated as one design with its deletion ledger and its order against
the runtime lane. It supersedes the census's Section 4 families: they are
symptoms of one cause and are resolved here together, not one at a time.

This note examines `main` at `2b4e9ffcba` on 2026-09-10, the commit after
#12189 and #12199 landed. Every family in the census was re-investigated
against live code before this was written; the corrections that came out of
that are in section 8, so nobody re-derives them.

## 1. The cause, and why the census is a local minimum

The census counted eight families of duplicated vocabulary. Read together
they have one cause: **"a run" has been declared once per layer and once per
era**, and every layer kept its own copy of the run's identity, its parent,
its phase, its result, its events, its pending questions, and its view. Each
copy is individually defensible. Collectively they are the dual system the
1.0 direction forbids.

Fixing them family by family would leave the cause in place, because each
fix would still be negotiated between two owners of the same fact. The
alternative is to state the run model once, derive everything from it, and
delete whatever is left. That is what the rest of this note does.

The four rules below are the whole design. Everything in sections 3 to 6 is
a consequence of applying them to what the code does today.

## 2. The four rules

These are how a runtime with several UIs stays single-sourced. TeXRA has
already ruled each of them somewhere; what is missing is applying them to the
runtime's own private state, not only to the hosts' rendering.

**R1. One fact log, one fold per question, one immutable view.** The runtime
writes facts to one append-only log. State is a pure fold over that log,
published as a value. A renderer is a function of the value. A fact is
written as exactly one row type; a derived value has exactly one fold;
nothing derived is persisted and nothing persisted is derived. Two folds are
legitimate only when they answer different questions over the same rows
(display versus resume). Two folds answering the same question is the
defect. The one admissible persisted derivation is a checkpoint: a snapshot
the rows can always rebuild and that loses every conflict with them, kept
only to bound replay cost. A snapshot that carries a fact no row carries is
not a checkpoint, it is a second store; PR1's `flow.snapshot` is written to
"restore what no row carries" ([PR1 §2.6](2026-09-08-pr1-run-ledger-foundation.md)),
and that gap closes by giving those facts rows, not by keeping the snapshot
authoritative.

**R2. Commands in, facts out.** A UI never calls the runtime. It sends an
intent from one command vocabulary; the runtime answers with facts. A request
awaiting a human is a request fact with no decision fact yet. Hosts render
"pending" from the view and send a decision command. Host adapters hold no
state, and the runtime holds no promise across the wait: the run parks
inside its own scope, and after a restart it resumes from the log.

**R3. One protocol at every process boundary.** In-process, IPC, and stdio
carry the same view and command types. An external contract is a versioned
projection of the view, never a second vocabulary with renamed keys.

**R4. Identity is minted once and never encoded.** One id per run, assigned
at `run.start`, keying every fact about that run. Display names are fields on
facts. A name glued onto an id is the tell that a second vocabulary grew.

Per-viewer state (selection, expansion, drafts, scroll) is the viewer's and
stays out of the view. The `Surface` split already does this correctly and is
not touched.

## 3. The model: seven facts, one declaration each

| Fact about a run   | Declared today (spellings)                                                                                                                          | Declared in 1.0                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Identity           | `ExecutionId`, `StreamTabId`, `runId`, `storageKey`, `RunScope.agentName`, four stream prefixes                                                     | `RunId` (branded, today's `ExecutionId`); `RunIdentity` for what kind of thing it is                          |
| Parent edge        | `parentStreamId`, `parentExecutionId`, `isSubagent`, `isChildExecution`, `background`, five persisted carriers, two "is child of" implementations   | `parent: { id, startCommit } \| null` on `run.start`; everything else is `parent !== null`                    |
| Phase and outcome  | `StreamPhase`, `StreamLifecycleStatus`, `ExecutionStatus`, `HistoryRunStatus`, `ExecutionMeta.outcome`, the `status` fact, the `result` fact        | `RunPhase` folded from `run.start`, `run.activate`, `flow.step`, `run.end`; `RunOutcome` its terminal subset  |
| Tool-call outcome  | `ToolResult.status`, `ToolStatus`, `TOOL_USE_STATUS`, `ToolUseLog.isError`, `normalizeToolUseData`                                                  | `ToolCallStatus` on `tool.result`; the card's status is the fold of it                                        |
| Result             | `AgentFlowResult`, `AgentFinalResult`, `ResultEvent`, `ResultMeta`; `totalCostUsd`, `cost`, `usage.totalCost`                                       | The `run.end` payload; every in-memory result type is `z.infer` of it; one `usage`                            |
| Events             | `AgentEvent` interfaces, `TranscriptEventSchemas`, the `durable(...)` arms, the CLI NDJSON rename table                                             | `sessionEvent.ts` is the vocabulary; trace and CLI projections are `.pick()`s of it                           |
| Waiting on a human | Four decision vocabularies, an in-memory pending set, a fold, a parallel inquiry database and protocol, three refusal switch tables, `useOwnApiKey` | `request.opened` / `request.decided` over the seven kinds; pending is the fold; inquiry is a threaded request |

### 3.1 Identity

`ExecutionIdSchema` gains `.brand<'ExecutionId'>()` and becomes the run id.
Branding is what makes the migration compiler-checked; without it both types
are `string` and a missed site is invisible to `npm run typecheck`.

`StreamTabId` is deleted, not aliased. It is `${getCleanAgentName(name)}#${executionId}`
([streamTab.ts:24](../../../../src/agent/runtime/streamTab.ts)), the run id
with a label glued on. The database already enforces that a stream and its
execution are one thing for life: `run.start` is the only row allowed at
seq 1 of a stream and the only stream row that names an execution id
([Database.ts:623](../../../../src/controllers/session/Database.ts),
[sessionEvent.ts:205-219](../../../../src/shared/schemas/sessionEvent.ts)),
resume reuses the caller's execution id and looks the stream up from it
([runAgent.ts:105-133](../../../../src/agent/runtime/runAgent.ts)), and a
workflow-script retry regenerates the same pair from one checkpoint id
([WorkflowScriptTool.ts:324-361](../../../../src/tools/delegation/WorkflowScriptTool.ts)).
The one-fold PRD's decision 9 ruled the same thing. Two names for one
identity is that ruling not having reached the schema.

The label the prefix carried is not lost. `RunIdentity` already travels on
`run.start` and on every `StreamView`, and `runIdentityDisplayName` is the
one owner of the display name. The four synthetic prefixes (`bash@tool`,
`workflow-script`, `codex@codex-sdk`, `claude@agent-sdk`) are today the only
place a process or external-CLI run's display name is minted; under this
model they become the `RunIdentity` of those runs, which is where the census's
own calibration example said the name already lived. The roughly fifteen
`logger.warn` sites that read better with a prefix get identity from the
fiber's log annotations, as the
[observability plane](2026-09-09-observability-plane.md) §3.1 specifies.

`storageKey` stays only inside the CLI's versioned NDJSON projection
(section 3.6); internally it is the run id. `runId` is an internal alias with
no frozen consumer and is renamed.

`RunScope` loses `streamId` and `agentName`: the first is the run id, the
second is `runIdentityName(identity)`, and the handle already derives it that
way ([ExecutionHandle.ts:183-185](../../../../src/agent/runtime/ExecutionHandle.ts)).
Two sources of one agent name is how the model node and the delegation tools
came to read different fields for it.

**Aggregates.** Today a run owns two aggregates, `('stream', streamId)` and
`('execution', executionId)`, with two sequence counters and two ownership
claims ([execution ownership](2026-09-10-execution-ownership-lane-and-lease.md)
§1, row 1). The split was meant to separate display rows from ledger rows.
That distinction is a property of a row type, not of an aggregate, and the
PR1 ledger's `foldRunState` already has to read both aggregates in one commit
order ([PR1 §4.2](2026-09-08-pr1-run-ledger-foundation.md)). The recommended
shape is **one aggregate kind, `run`, keyed by the run id**, with row types
marked display-visible or ledger-private. That deletes the second sequence
counter, the second claim, the `RunAggregates` two-key signature that PR1
documents as a deviation it was forced into, and the reverse index the
deviation exists to avoid. `parentStartCommit` and the deletion tombstone
work unchanged on one aggregate. This is the one place this note departs from
a ratified detail (one-fold PRD 5.1's per-kind sequence), and it is listed
for ruling in section 7; the fallback, two kinds sharing one logical id,
still deletes every name above and keeps only the second counter.

### 3.2 Parent edge

`run.start` carries `parent: { id: ExecutionId, startCommit } | null`. That
is the whole edge. `parentStreamId` and `parentExecutionId` are
one pointer; the one site that used both, the inquiry continuation's "the
stream now runs a different execution" guard
([inquiryContinuation.ts:198-209](../../../../src/tools/inquiry/inquiryContinuation.ts)),
tests a condition the seq-1 rule makes unrepresentable, and the field it
guards is explicitly a legacy-manifest reader the 1.0 policy retires.
`isSubagent` is never stored, it is projected from `handle.isChildExecution`
at every write; `isChildExecution` is `parent !== null`. So is `background`:
every writer sets it `true` beside a parent
([bash.ts:546](../../../../src/tools/bash.ts),
[agentCliShared.ts:312](../../../../src/tools/agentCliShared.ts),
[detachedChildRun.ts:71](../../../../src/tools/delegation/detachedChildRun.ts)),
the default is `parentExecutionId !== undefined`
([executionLifecycle.ts:151](../../../../src/agent/storage/executionLifecycle.ts)),
in-band children set it too, and its one production reader turns it into a
CLI "don't switch view to this child" hint
([sessionProgressSubscription.ts:80](../../../../packages/cli/src/runtime/sessionProgressSubscription.ts)).
The census's first draft of this note called it a launch mode; it is not, it
is the parent edge spelled as a boolean a fourth time, and it is deleted. The
five persisted carriers of the parent pointer collapse to the `run.start`
row; "is a direct child of X" has one implementation, over the fold.

### 3.3 Phase, outcome, and tool-call status

`RunPhase` is `running`, `waiting`, and the three `RunOutcome` values. It is
already that today under the name `StreamPhase`
([stream.ts:80-89](../../../../src/shared/schemas/stream.ts)); the name
changes because there is no stream. It is folded from rows that already
exist or that PR1 defines, and no row exists to carry it: `run.start` and
`run.activate` put a run in `running`, `flow.step` with `waiting` or `halted`
parks it (PR1 §2.2 writes that row for every wait, including the ordinary
tool-use turn that parks for a future follow-up with no request open), a
later `run.activate` resumes it, and `run.end` ends it. Today the `status`
fact ([sessionEvent.ts:291-299](../../../../src/shared/schemas/sessionEvent.ts))
carries those transitions as a phase-plus-previous-phase pair beside the
rows that cause them; under R1 the transition is the fold of the cause, and
the `status` row is deleted once `flow.step` lands.

Workflow scheduling keeps its own lifecycle. A workflow call is a
scheduling unit, not a run: its `waiting` means "not yet started" and its
`skipped` has no run counterpart, so folding it into `RunPhase` would be
lossy. The duplicate there is different: `WORKFLOW_CALL_STATUS`
([workflowExecutionSnapshot.ts:18-27](../../../../src/shared/schemas/workflowExecutionSnapshot.ts))
and `WorkflowCallProgress.status`
([workflowCallProgress.ts:96-141](../../../../src/shared/schemas/workflowCallProgress.ts))
are two nine-value enums for one call, joined by a translator that collapses
`stageBlocked` into `declared`. One enum, on the row, and the progress
projection is a `.pick()`. `ExecutionStatus` and `HistoryRunStatus` are
projections of `RunOutcome` with one translator each, and survive only
inside the CLI projection.

The terminal fact is written once, as `run.end { outcome, error?, usage,
output }`. Today it is written twice, as the `status` fact and the `result`
fact, reconciled before the write in `finalizeRunTerminal`
([AgentRunLifecycle.ts:195-201](../../../../src/agent/runtime/AgentRunLifecycle.ts))
and again at read time in the CLI
([terminalStatus.ts:72](../../../../packages/cli/src/runtime/terminalStatus.ts)),
while the fold treats `result` as a no-op and reads the phase from `status`.
`ExecutionMeta.outcome`, "the ONE persisted terminal fact", is a third copy
derived by a third fold (`executionMetaFromEvents`). One row, one fold.

Tool-call status has one lossy write and one render-time repair. The
dispatcher discards `ToolResult.status` into an `isError` boolean and lets the
card's own status default to `completed`
([ToolUseDispatchNode.ts:448-462](../../../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts)),
so a persisted log can say `completed` and `isError: true` at once, and
`normalizeToolUseData` ([toolUse.ts:107-134](../../../../src/shared/toolUse.ts))
exists to notice and flip it. This is the render-time compensation the
guardrails forbid. `tool.result` carries one `ToolCallStatus`; the card's
status is folded from it; the boolean and the repair are deleted. The
settings view's `ToolStatus` is a different concept (dependency
availability) that only shares a name, and is renamed rather than merged.

### 3.4 Result

`AgentFlowResult`, `AgentFinalResult`, `ResultEvent`, and `ResultMeta` are
four declarations of the `run.end` payload, with one conversion point that
renames `totalCostUsd` to `cost`
([AgentFinalResult.ts:70](../../../../src/agent/runtime/AgentFinalResult.ts))
and a third name, `usage.totalCost`, computed independently along the usage
path. In 1.0 the payload schema is declared once beside the row, every
in-memory result type is `z.infer` of it or of a `.pick()`, and cost is
`usage.totalCost` and nothing else. The `execution.description` /
`updateStreamDescription` pair, always published together
([sessionDescription.ts:138-149](../../../../src/agent/runtime/sessionDescription.ts)),
becomes one `run.description` row.

### 3.5 Events

`sessionEvent.ts` is the only event vocabulary. The `AgentEvent` interfaces in
[events.ts](../../../../src/agent/trace/events.ts) are hand-written mirrors of
`TranscriptEventSchemas`, identical in every arm but `usage` (where the
durable arm flattens the payload) and `goalPaused` (where the durable arm
drops a field). The trace union becomes a `.pick()` of the session union's
display-visible arms, exported as a type; `runEventDraft`'s special cases
disappear with the divergences. `stream.chunk` stays a fold input that never
enters the vocabulary, as ruled. `goalPaused` is deleted: it has no fold
consumer, and its one reader is the CLI bridge, which reads
`goalStateChanged` already.

### 3.6 The CLI projection

The CLI's NDJSON progress table
([cliNdjsonProgressEvents.ts:71-124](../../../../packages/cli/src/runtime/cliNdjsonProgressEvents.ts))
is a hand-curated rename of the session vocabulary, frozen by comment, with
its own key names (`storageKey`, `updateStreamStatus`, `setParentStream`),
and the validation script recovers a child's id by slicing `workflow-script#`
off a stream id
([validate-run.mjs:989-1005](../../../../packages/cli/scripts/validate-run.mjs)).
Under R3 the 1.0 CLI emits a **versioned projection** of `SessionEvent` and
`SessionView`: the same row types, the same field names, a `version: 2`
envelope, and `ExecutionStatus` / `HistoryRunStatus` as the only renames,
because those are the words the contract already promises to humans. The
0.40 line keeps the current table. texra-action is pinned by SHA and has no
field-level contract in this repository; it is updated in lockstep. This is
the one external break in the note, and it is the kind of break 1.0 exists
to make once.

### 3.7 Waiting on a human

There are seven kinds of thing a run asks a person, and one list of them,
`PERMISSION_KIND` ([uiConstants.ts:1-9](../../../../src/shared/utils/uiConstants.ts)).
Around that one list sit four decision vocabularies, each dropping a kind
the next one has; an in-memory `pending` set in `SessionHostInteractions`
([HostInteractions.ts:471](../../../../src/agent/runtime/HostInteractions.ts))
beside the fold's `approvals` array built from the durable
`approval.requested` / `approval.resolved` rows; and, for one of the seven
kinds, a wholly separate protocol: the external inquiry writes its own record
to a separate persistent database, returns immediately, and is re-injected
after any restart by its own continuation module.

The consequence is the sharpest defect in the census. Approval facts are
durable, but the prompt is a promise held in memory, so **a restart loses
every pending approval, retry, and question**, while an inquiry survives only
because it was built twice. One concept, two durabilities.

In 1.0 there is one pair of rows, `request.opened { kind, requestId, payload,
thread? }` and `request.decided { requestId, decision }`, over all seven
kinds. Pending is the fold: opened without decided. Hosts read pending from
the view and send `decide` as a command (R2). The runtime holds nothing: the
run parks in its scope, which is lane D3 of the
[ownership note](2026-09-10-execution-ownership-lane-and-lease.md), and after a
restart the run-state fold sees the open request and parks again. An inquiry
is a request whose `thread` names an earlier request, which gives it
multi-turn for free; its record in the global database stays, because
cross-project scope is a real difference, but it carries the same schema and
no second protocol.

An inquiry today does not park the run: the tool returns `dispatched` and
the answer, whenever it comes, is turned into a `[inquiry]` user follow-up
that wakes or resumes the run
([inquiryContinuation.ts:172-234](../../../../src/tools/inquiry/inquiryContinuation.ts)).
That delivery path is not inquiry-specific. "A follow-up arrives for a run
that is not live, so resume it" is exactly what `submitFollowUp` already does
for every recoverable target
([ToolUseFollowUp.ts:139-197](../../../../src/agent/followUp/ToolUseFollowUp.ts)).
So the rule is one sentence: **a `request.decided` for a request its run is
not parked on is delivered as a follow-up.** The run either resumes from the
fold or, if live, drains it at its next turn boundary. The continuation
module, its staleness guard, and its legacy-manifest reader are that sentence
implemented a second time, and are deleted. Whether a given kind parks the
run or returns immediately is a property of the tool, not of the protocol.
`useOwnApiKey` is a host command that ends in
`request.decided { action: 'retry', credentials: 'personal' }` and is
documented as exactly that today
([runtimeRequest.ts:96-98](../../../../src/shared/session/runtimeRequest.ts)).
`RequestDecision` is one discriminated union; the frontend action vocabulary,
the host-interaction result vocabulary, and `ApprovalDecision` become
`.pick()`s of it or are deleted; refusal wording is one function over the
union instead of three switch tables.

### 3.8 Views

`StreamSnapshot` and `StreamView` are two independent folds of the same rows
with no conversion between them: the snapshot store is wired off the event
log in `sessionLayer.ts` for backend readers, the view is folded from the same
log for renderers. Under R1 that is one question folded twice.
`StreamSnapshotStore`, `StreamSnapshotSchema`, and `executionMetaFromEvents`
are deleted; backend readers take `SessionView` from the service. The
resume fold (`foldRunState`, PR1) is a different question over the same rows
and stays. `StreamView.usage`, which every consumer immediately totals,
carries the total.

### 3.9 Model identity (independent of the run model)

The catalogs derive from llm-zoo correctly except for three hand copies:
`UsageProviderSchema`, `ReasoningEffort` spelled three times with a
drop-on-miss inverse, and availability computed once and fanned into four
wire fields plus a fifth settings-only flag.

`UsageProviderSchema` ([usage.ts:6-20](../../../../src/shared/schemas/usage.ts))
is not `ModelProvider` with mistakes; it is a different fact. It carries
`openai-response` beside `openai` because usage is recorded per wire surface,
and the Responses API bills differently from Chat Completions. The wire
surface already has one declaration in the 1.0 provider package: the
origin's `protocol` ([turn.ts:29-44](../../../../packages/llm/src/turn.ts)),
`openai-responses`, `openai-chat`, `anthropic-messages`, and so on. A usage
record's provider is the protocol of the turn that produced it, read off the
origin the package already attaches to every response. `unknown` disappears
because every turn has an origin; the unchecked casts in the two OpenAI
handlers disappear with the handlers. The usage-log edge function's
`provider` column is an external contract and takes the protocol names under
the same versioning rule as the CLI. `ReasoningEffort` is llm-zoo's, and
availability is one discriminated field. This family is real but touches
nothing above and can land in any order.

### 3.10 Names: one word, and it is "run"

Collapsing the concepts and leaving the words is half a collapse. Today the
same thing is called an execution in the runtime and storage layers
(`ExecutionId`, `AgentExecutionHandle`, `executionRegistry`, `executionLanes`,
`executionLifecycle`, `ExecutionMeta`, the `execution.*` rows), a stream in
the session and view layers (`StreamView`, `SessionView.streams`,
`StreamPhase`, `streamStatus`, `stream.removed`, `StreamSelection`, every
`streamId` field), and a run at the seams between them (`runAgent`,
`RunIdentity`, `RunOutcome`, `run.start`). The proposal notes disagree with
each other the same way: the runtime note's per-run service is `RunContext`,
the injection note's is `AgentRun`, the code's is `RunScope`. A reader has to
know which layer wrote a file to know whether "execution" and "stream" mean
the same object, and after this note they always do.

The rule is one word. **A run is a run** in every layer, every row, every
service, every file name. `ExecutionId` becomes `RunId`, the aggregate kind
is `run`, the rows are `run.*`, the view is `RunView` in `SessionView.runs`,
the phase is `RunPhase`, the handle is `RunHandle`, the registry and lanes
are the run registry and run lanes, and the one per-run service the runtime
lane provides is `Run`. "Execution" survives nowhere; "stream" survives only
for what streams, a provider's token stream. The rename is compiler-driven
once the id is branded, and it lands inside S1, because doing the id and the
words in two passes touches the same 150 files twice. Cost, measured on
`main`: 35 production files named after one of the retired words, and about
2,900 spellings of `streamId` and `executionId` across the hosts and core.
That number is the reason to do it once and not gradually.

The same rule binds the proposal tree. The injection note's `AgentRun` and
the runtime note's `RunContext` are the `Run` service; the PR1 note's
`RunAggregates` is the run id; nothing new is named with either retired word.

## 4. What this deletes

| Deleted                                                                                                                                                                                                               | Lines (measured)       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `streamTab.ts`, `StreamTabIdSchema`, four prefixes, `streamPrefix` threading, `streamTabIdOverride`, `getAgentHandleByStream`, the `endsWith('#')` guard                                                              | ~28 + call sites       |
| `StreamSnapshotStore.ts`, `streamSnapshot.ts`, `executionMetaFromEvents`                                                                                                                                              | 382 + meta fold        |
| `AgentEvent` hand interfaces in `events.ts` (kept: the `.pick()` type)                                                                                                                                                | most of 295            |
| `AgentFlowResult.ts`, `AgentFinalResult.ts`, `executionRecords.ts` result arms (kept: `z.infer`s)                                                                                                                     | most of 317            |
| `normalizeToolUseData`, `ToolUseLog.isError`, the second tool status enum                                                                                                                                             | ~60                    |
| `SessionHostInteractions.pending`, the inquiry continuation module, three refusal tables, three of four decision vocabularies                                                                                         | ~400 of 1001 + 262     |
| `goalPaused`, the `status`/`result` twin, `ExecutionMeta.outcome`, the description pair, `parentStreamId`, `isSubagent`, `background`, five parent carriers, the second `isChild` impl, the second workflow-call enum | scattered              |
| One aggregate kind, one sequence counter, one claim per run; `RunAggregates`                                                                                                                                          | in PR1 before it lands |
| The CLI NDJSON rename table                                                                                                                                                                                           | 124                    |

The numbers are file sizes, not a promise; the point is that every row is a
deletion of a vocabulary, and none is a rename with an alias left behind. Per
the 1.0 direction no transitional alias outlives its PR, and
`check:effect-migration` already fails on any `@adapter-until` marker.

## 5. What this does not change

- The ledger rows PR1 defines (`flow.step`, `model.message`, `tool.intent`,
  `tool.result`, `flow.snapshot`) and the money-window semantics. This note
  changes what aggregate they land on and what key names them, nothing
  about when they are written. `flow.snapshot` stays as the checkpoint R1
  admits, under PR1 §4.4's reconcile-never-overwrite rule; its §2.6 open
  problem (reflection state no row carries) is closed by rows, per R1.
- The `Surface`, per-viewer state, and the one-fold renderer contract.
- `RunIdentity`, `AgentCategory`, and `aggregateId`'s canonical encoding.
  `aggregateId` accepts the branded run id for the `run` kind; Codex's review
  note on the census that the current signature rejects branded strings is
  correct and is a two-line change in the same PR as the brand.
- Retention (C9): rows are never scrubbed by age; one aggregate does not
  change that.
- Persisted host state keyed by run id (`PersistedSurface` maps, the goal
  key). 1.0 state lives in its own namespace and old state is left untouched
  under the accepted policy, so no dual-read or key migration is written.
  Codex's review note that rebasing the key would reset saved drafts applies
  to an in-place cutover, which the policy rules out.

## 6. Order

The identity and vocabulary changes are **schema work that precedes the
runtime lane**, because PR1 of that lane declares its rows against the
vocabulary it finds. Landing PR1 first hardens the duplicate; landing this
first removes a documented deviation from PR1 before it is written.

1. **S0, docs, same day.** Amend the
   [PR1 note](2026-09-08-pr1-run-ledger-foundation.md) (`RunAggregates` to
   the run id; rows land on the `run` aggregate), the
   [Tier-1 manifest](2026-09-10-agent-sdk-tier-1-manifest.md) (drop
   `StreamTabId` and `StreamTabIdSchema` from all three entries), and the
   `CLAUDE.md` `p-queue` bullet the census flagged. Move the census's
   Section 4 to point here.
2. **S1, identity and aggregate.** Brand the run id; delete `StreamTabId`
   and its minting; one `run` aggregate; `parent` on `run.start`, `background`
   gone; `RunScope` shrinks; the one-word rename of section 3.10 in the same
   PR. One PR, compiler-driven, about 150 files. The
   persisted-state keys change in the fresh namespace only.
3. **S2, vocabulary.** `sessionEvent.ts` as the only declaration; the trace
   `.pick()`; `run.end`, `run.description`; one `ToolCallStatus`; delete the
   twins and the render-time repair. One PR.
4. **S3, requests.** `request.opened` / `request.decided`; delete the
   pending set and the inquiry protocol; one `RequestDecision`. This is the
   runtime lane's D3 and lands with it, not before.
5. **S4, views.** Delete the snapshot store and the meta fold. Any time
   after S2.
6. **S5, the CLI projection.** Version 2 envelope; retire the rename table;
   update the validation script and the texra-action pin together. After S2.
7. **S6, model identity.** Independent; any time.

## 7. For the owner to rule

1. **One aggregate per run** (recommended) versus two kinds sharing one
   logical id. The first deletes a counter, a claim, and the PR1 deviation;
   the second keeps a ratified sentence intact and one duplicate with it.
2. **The CLI contract is versioned at 1.0.** The rename table is frozen by a
   comment, not by an external consumer this repository can see; texra-action
   is SHA-pinned. If the 0.40 contract must be emitted verbatim by 1.0, S5
   becomes a projection module instead of a deletion, and R3 is violated on
   purpose in one named place.
3. **Inquiry joins the request protocol.** Its cross-project record stays;
   its second protocol does not. If the owner wants inquiry to remain a
   fire-and-forget tool call that never parks the run, that is still one
   `request.opened` row with no waiting, not a separate module.

## 8. Corrections to the census, so they are not re-derived

The re-investigation refuted or amended these census claims:

- `parentStreamId` and `parentExecutionId` are one edge. The one site using
  both guards a state the database forbids (section 3.2).
- `StreamTabInfo` and the per-host grouping tables were both deleted today,
  in #12199 and #12189, before this note was written. Two of the five
  entries in family B are closed.
- The `AgentEvent` duplication is hand-written interfaces mirroring Zod
  schemas, identical in all but two arms, not twenty-one divergent
  declarations. It is cheaper than the census implied.
- `ExecutionStatus` and `HistoryRunStatus` are justified projections with
  one translator each, not accidental duplicates; they survive inside the
  CLI projection only.
- `runId` appears on no frozen boundary. `storageKey` does, in the NDJSON
  table.
- Supabase carries a `stream_id` only in the usage-log edge function; there
  is no execution table. SQLite stores the id inside the aggregate key, so
  the collapse changes the key's contents, not a column.
- `RunKind`, `RunDescriptor`, and `ExecutionMeta.category` do not exist; an
  earlier consolidation note that named them is historical.
- `background` looked like a launch-mode fact in the first search pass (bash
  sets it) and is not: every writer sets it beside a parent, in-band children
  included, and its one reader is a CLI view-switch hint. It is the parent
  edge as a boolean (section 3.2).
- `WORKFLOW_EXECUTION_LIFECYCLE` is not `StreamPhase` renamed: a workflow
  call has `skipped` and a "not started" `waiting` that a run does not. The
  duplicate in that family is the pair of nine-value call-status enums
  (section 3.3).
- The `ChildStreamPort` copy is a voluntary layering convention, not a
  ratchet workaround; it is not blocked by the dependency rule and stays or
  goes on its own merits, outside this note.
- The two "queue a follow-up onto a child" paths serve different admission
  contracts (live-only versus recoverable). Under S3 the recoverable path is
  the run resuming from the fold, so the distinction dissolves there rather
  than by merging the two functions now.
