# The agent runtime on Effect: one ledger, two loops, no graph (2026-09-04)

Status: proposal for owner ratification. Reverses migration PRD R4 and 13.C,
amends persistence proposal §6 Stage 5 and §7, and the one-fold PRD non-goal
at line 102. Companion to `2026-09-03-persistence-substrate-decision.md` and
`docs/prds/2026-09-03-prd-one-fold-three-renderers.md` (PR #11821).
Amended 2026-09-04 against substrate contract §6.1 after it adopted the §2.1
row vocabulary: C1/C2 name the columns (`aggregate_id`, `commit`), C10
forbids the `run_state` and transcript projections this draft had, C1
forbids rewriting a row (so no null-on-complete), and C3 was rewritten the
same day with three owners so that execution-aggregate rows stay byte-exact.
The two-aggregate shape and its transaction boundaries are in §2.1.

## 0. Recommendation

Move both flow families onto one shape: **each family is a plain Effect loop
whose durable state is recorded by appending rows to the session event table
on the execution and stream aggregates**. Provider messages, tool intents and results,
flow coordinates, and a periodic state snapshot are the rows; run state is a
pure fold of those rows, computed by the same function on resume and in the
trace viewer, and never persisted as a separate projection (substrate C10).
There is no graph interpreter or flow record. Durable phases are explicit
row data rather than graph-node paths. Resume loads rows
and continues the loop. Stepping a run in the trace viewer folds rows up to
a chosen commit.

This is design D from the panel (the OpenCode, Codex, and Claude Code shape)
hardened with three ideas the refuters forced from the other designs: intent
rows for side-effecting tools and logical keys per row (from B), the
per-turn state snapshot row and "state is a fold" rule (from E), and
retention plus redaction rules that no design got right on its own.

The reason it wins: it is the only shape that satisfies the owner's four
rulings at once with the fewest elements. It deletes the engine, the
checkpoint file, and the two orchestration interpreters; it gives replay
along the flow without requiring deterministic re-execution (which is what
sank B and C); it needs no reducer or command vocabulary (which is what made
E heavier than the problem); and it fits the reflection family with one
extra coordinate rather than a second framework.

## 1. What was evaluated

Five independent designs were produced from fixed angles, each attacked by
two adversarial refuters (durability and gracefulness lenses), against a
verified brief (PocketFlow inventory, OpenCode survey, Effect rc.112 facts).
Nine of ten refutations completed; D's durability refutation did not run,
and its concerns are covered below by the B and E durability findings, which
attack the same row shape.

| Design                                             | Shape                                                                               | Fatal refutations                                                                                                                                                                                                                                                                                        | Verdict                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A. Ratified kernel + one event                     | Typed node transitions over the existing cursor record                              | Private working copy discards mid-step `switchModel` commit (silent wrong-model resume). No replay from trace by construction.                                                                                                                                                                           | Rejected. Does not meet the ruling; would be a stepping stone, which is the dual system.               |
| B. Journaled activities, replayed program          | Deterministic program re-executed against journaled activity results by logical key | Tool-mutated run/workspace state never journaled; model payload has no Zod schema (raw SDK response); post-compaction injection uses `Date.now()` so every resume across a compaction faults; sequencing re-migrates the checkpoint twice                                                                | Rejected as written. Its keys and intent rows are grafted.                                             |
| C. Effect `unstable/workflow` with a custom engine | Workflow bodies + Activities memoized in our table                                  | Requires Effect Schema (binding ruling 6); `Schema.Unknown` removes the Zod boundary on memo hits; memoized failures replay as failures so resume-after-failure is impossible; `DurableDeferred` completes once so batched follow-ups drop                                                               | Rejected. The module is not the way to the ledger model.                                               |
| D. Ledger loop                                     | Two `Effect.fn` loops over appended conversation rows + run_state projection        | Sequencing kept a blob writer beside the new rows across three PRs; no intent rows (R4.2/R4.3 unmet); assistant text durable twice; layers placed at process scope instead of per session root                                                                                                           | Selected, with the fixes below applied.                                                                |
| E. The flow is a fold                              | Pure reducer over Zod state emitting commands; generic interpreter                  | None fatal. Two-exit interpreter cannot halt on cancel; tools activity breaks the one-outcome shape; Stage 5 carve-out is the lazy import §9 forbids. (Its refuter's "raw output file written before commit" finding was itself wrong: the per-continuation file is the mid-cycle checkpoint and stays.) | Runner-up. Its fold rule and checkpoint policy are grafted; its reducer and command machinery are not. |

Findings all refuters agreed on, regardless of design:

- The tool-use durable state is not only messages. `stateSlices` (run
  snapshot with usage accumulator, workspace snapshot with work plan and
  file interactions, user channels) is rewritten from live state at the end
  of every cycle (`ToolUseCycleNode.ts:200-204`, schema at
  `nodes/types.ts:26-30`). Tools mutate it through the session, not through
  their results. The new result row must persist the state mutations that
  settle with each call; a turn-end snapshot alone leaves a crash window.
- Provider messages cannot get a native Zod schema; `ProviderMessage` is
  `z.custom` over external SDK unions by design (`ProviderMessage.ts:25-28`).
  Rows must carry the handler-built message delta, never the raw SDK
  response.
- `previous_response_id` chains are handler instance state
  (`ServerChainState.ts`), deliberately not in messages; a resumed handler
  starts with a null anchor today. Single-owner §6 listed them as checkpoint
  content; they are not, and the row design does not need to carry them.
- The Google handler synthesizes `callId` at extraction time
  (`modelHandlerGoogleInteractions.ts:1237`), so tool rows must be keyed by
  the extracted call list stored in the model row, not by re-extraction.
- Completion alone must not delete a checkpoint or conversation. The
  single-owner D8 rule keeps completed runs continuable; C9 preserves their
  history and recovery data until the user explicitly deletes the run.
- Every "after the cutover, with Stage 5 carved out" sequencing is the lazy
  checkpoint import the substrate proposal §9 rejects, or a double migration
  of the same datum. The fix is the same in all four refutations: the cutover
  writes the row shape this program will keep.
- Deletion lists were incomplete everywhere. Ten production modules outside
  the flow directories import `persistedFlow.ts`; `deriveResumability` has
  callers in `src/tools`, `SessionHandle`, `runClassification`, and three CLI
  files. They are in the ledger below.

## 2. The shape

### 2.1 Rows

Two aggregates per run in the substrate's `event` table, keyed
`(aggregate_id, seq)` (contract C1). Their storage keys are
`aggregateId('execution', executionId)` and `aggregateId('stream', streamId)`
under C2; a logical id alone is never an aggregate key, even if a stream and
an execution happen to share that id. `RunLedger.load` accepts the logical
execution id and qualifies its database reads internally. The `commit` column (`INTEGER
PRIMARY KEY AUTOINCREMENT`) is the database-wide total order; nothing
relies on the implicit rowid. The split is the one that exists today as two
files, made explicit:

- The **stream aggregate** holds what people see: the existing trace rows
  (`tool.start`/`tool.end`, `response.finalized`, `usage`, stages) and
  `flow.step`. Every row is scrubbed at publish (C3 applies in full) and
  lives until the user explicitly deletes the stream under C9. This is today's
  transcript sidecar.
- The **execution aggregate** holds what the model sees: `model.message`,
  `model.compaction`, `tool.intent`, `tool.result`, `flow.snapshot`. Rows
  are byte-exact and never scrubbed (C3, second owner). Raw reads belong to
  `RunLedger`, including the input it supplies to the shared display fold;
  the lease gates writes, not reads. No row is ever rewritten and nothing is removed at completion:
  single-owner D8 (#11304, "a checkpoint is deleted only by the user")
  keeps a completed run continuable, and once the view-state
  fold collapses these rows are the only copy of the conversation. The
  aggregate remains with the stream until explicit user deletion (C9).
  There is no age-based expiry for completed, cancelled, or failed runs.
  The shared display fold applies redaction before updating view state,
  including the in-process CLI's `SessionViewService.ref`. Transport framers
  and exports also enforce display redaction and truncation (C3, third
  owner); no display surface receives a byte-exact row.

Flow row types, all Zod-validated at the boundary, all carried as
`AgentEvent` arms so the existing trace plumbing, fold, and viewer see them:

| Row                            | Written when                                                                                                                                                                                                                                                                          | Payload                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow.step` (stream aggregate) | round begin/end (reflection), turn begin/end, response ready/processed, `waiting`, `halted`                                                                                                                                                                                           | `{ family, step, round?, turn?, continuation?, outcome? }`; replay coordinates. Listing status comes from the canonical `status` fact, including failures before the runtime starts                                                                                                                                                                                                   |
| `model.message`                | a completed model response is recorded, or provider-native messages are appended: initial/round prompt, completed tool-follow-up batch, user follow-up, synthetic continuation                                                                                                        | a discriminated payload: `pending-tools` stores normalized response and builder inputs plus ordered extracted calls; `append` stores the handler-built `ProviderMessage[]` delta (z.custom), with `sourceResponseCommit` for a completed tool-follow-up batch. No raw SDK response                                                                                                    |
| `model.compaction`             | a handler returns `updatedMessages` that is not a prefix extension, or a reflection round opens                                                                                                                                                                                       | the full replacement array after runtime context injection; later loads start here                                                                                                                                                                                                                                                                                                    |
| `tool.intent`                  | unconditionally at the barrier dispatch site, before any barrier (non parallel-safe) call starts (`ToolUseDispatchNode._exec` today). Not from an approval hook: `onExecutionReady` exists for three tools only (`bash`, `codex`, `wolfram`), while about 38 of 50 tools are barriers | `{ callIds, attempt }`; the attempt increases only after an explicit re-run decision                                                                                                                                                                                                                                                                                                  |
| `tool.result`                  | after each tool call settles, one row per call including duplicates (`duplicateOf`)                                                                                                                                                                                                   | `{ sourceResponseCommit, callId, attempt, result, attachments, stateMutation }`: normalized `ToolResult`, immutable attachment payloads encoded as below, and that call's settled `stateSlices` mutation, without a provider message. Its terminal `tool.end` commits in the same cross-aggregate batch, scrubbed at publish                                                          |
| `flow.snapshot`                | initially before the first external activity; at `turn.end` / `round.end`, before WAITING, and whenever bytes appended since the last snapshot exceed its size                                                                                                                        | the family's non-message Zod state: `structured`, `lastError`, `userCancelledRetry`, `shouldSkipCycle`, `systemPrompt`, `continuationGenerationId`, `stateSlices`, `modelId`, `modelHandlerCompatibilityKey`; `outputLocation`, `roundOutputs`, `continueRounds`, `endTurn`, `context`, compile-repair state, round counters, durable phase, pending intents, and `messageBaseCommit` |

Snapshots omit the accumulated provider message array. `messageBaseCommit`
references the latest `model.compaction`, or the first `model.message` append if
there has been no compaction (null for an empty initial conversation).
`RunLedger.load` reconstructs messages from `append` payloads and compactions
from that row, inclusive, through the snapshot's commit; `pending-tools`
payloads are recovery inputs, not additions to the provider conversation.
It restores the snapshot's non-message state and then
folds later rows. Thus mandatory turn-end snapshots do not repeatedly store
the complete conversation. The non-message tail is at most one turn or
round; reading the current conversation necessarily scales with its size.
The additional size-triggered snapshots bound non-message replay work, not
the cost of loading all provider messages. `toolCalls` entries on assistant rows carry
`parallelSafe` stamped at append time so the fold and the resume rule stay
data-only and need no registry.

The dispatch service captures each call's state mutations in the same
settlement boundary as its result. Parallel calls record only their own
changes, with the existing field operations (set, delete, or accumulation)
and deterministic settlement order; a whole-state copy taken while another
call is mutating state is not a valid delta. Folding the result applies its
mutation exactly once and removes its pending intent. A crash after the row
commits therefore cannot retain the result while losing work-plan,
file-interaction, or usage changes. Each settlement is one
`RunLedger.appendBatch`, backed by C6 `publishBatch`: its `tool.result` and
terminal stream-aggregate `tool.end` commit together, with the same call and
attempt identity. The settlement owner constructs both rows; the executor
must not publish completion earlier from `logAndProcessMediaFiles` or its
cancellation path. A card can become terminal only when its recovery fact
is durable, and a durable result cannot leave a running card behind.
Each call's card correlation (`logId` and stage) is saved with the pending
response, so a resumed settlement closes the same card. If no start card
was published, the settlement batch includes its `tool.start` as well.
Turn snapshots include the resulting state, pending intents, and references
to any pending response and its already-settled calls.

Attachment settlement uses a JSON-safe representation rather than persisting
`ToolFileAttachment` directly: its `bytes` field is a `Uint8Array`, which
JSON does not reconstruct (`src/shared/schemas/toolResult.ts:23-29`). Each
stored attachment preserves `path`, `mimeType`, and optional `description`,
with `content: { kind: 'base64', data: string }` for captured bytes or
`content: { kind: 'metadata-only', reason: string }` for a settled omission.
Raw `result.files` attachments are extracted into this one ordered list;
the saved `result.files` contains metadata only, as in
`extractToolAttachments` today. Neither it nor the attachment list may retain
a typed array in the JSON payload.

Before the settlement batch commits, capture the bytes from `bytes` or
`base64Data`, or perform any workspace-path read the provider follow-up would
otherwise require. Encode one immutable base64 payload in the `tool.result`
row; a path alone is not recoverable content. Capture failures retain the
settled omission or failure and its explanation, never a claim that bytes
were included. At the provider-builder boundary, validate the stored form
and decode each base64 payload into a fresh `Uint8Array` in the expected
`ToolFileAttachment.bytes` field, preserving its metadata and call order.
The delivery loader recognizes payload **presence**, including empty base64
and zero-length bytes, rather than today's `loadAttachmentBuffer` length
checks (`src/agent/modelHandlers/utils/toolAttachmentUtils.ts:133-145`). It
never falls back to the current workspace path during pending follow-up
delivery, including after a crash. Explicit metadata-only entries keep the
existing summary/fallback behavior without an automatic file read; a later
explicit `read_file` call can still read the current file. Thus recovery
before the completed provider-message append uses the settled bytes even if
the source was edited or deleted. This requires no separate asset store.

Per-call settlement and provider-message delivery are separate boundaries.
The latter preserves `ModelHandler.requiresBatchedParallelToolResults` and
`createBatchedToolUseFollowUpMessages` (`ToolUseDispatchNode.ts:566-605`).
After **all calls from one model response** settle, including barriers and
synthetic skips, the handler receives their normalized results and
attachments in the original call order. For handlers requiring batching,
it receives the complete set in one invocation; otherwise the current
ordered single-entry invocations remain, with assistant text supplied only
to the first. The complete returned message array is then persisted as one
`model.message` append payload. Settlement order never changes provider
message order, and the group is the response's complete call set, not an
individual parallel execution partition.

Some handlers return the original assistant message together with the
results: Anthropic returns one assistant with every `tool_use` followed by
one user message with every `tool_result`; Google returns the saved thought
and function-call steps before the result steps. Accordingly, a response
with tools first commits a `model.message` **`pending-tools` payload** and
enters the tools phase; it does not append an independent assistant message
to `RunState.messages`. Its row commit identifies the response. This payload
preserves the exact extracted provider-specific calls, assistant text,
reasoning/thinking blocks and their signatures, server-tool content, and
every other normalized input the handler's follow-up builder consumes.
Before dispatch it also records each call's partition and duplicate-primary
identity. An `endTurn` settlement atomically records skipped dispositions
and their normalized synthetic results for later undispatched partitions
in its non-message state; other calls in
the already admitted parallel partition still settle normally. These facts
survive a snapshot and are consulted before any recovery dispatch.
Private handler caches are not presumed to survive a restart: construction
of a resumed handler restores these inputs from the row before building
follow-ups. An unsupported input shape fails validation rather than silently
omitting reasoning. Non-tool responses remain ordinary `append` payloads.
The shared display fold uses the source response identity for one assistant
entry: it may show the pending content, then updates that entry when the
completed batch arrives instead of adding a second copy.

The completed batch names `sourceResponseCommit` and commits atomically with
the builder's resulting non-message snapshot and `flow.step results.ready`.
The append transaction requires that response to remain pending and
undelivered. Folding the append installs its entire message array once,
consumes the pending response, and clears its settlement references; neither
the earlier pending payload nor a `tool.result` independently adds provider
messages. The snapshot retains the delivery phase and, while still pending,
the response/settlement row references needed for reconstruction even if
they precede the snapshot. A crash before delivery rebuilds the batch from
those facts without repeating settled tools or the model invocation. A
crash after delivery sees the consumption and skips both rebuilding and
reinsertion. Builder-side changes, such as clearing reasoning caches, are
applied to reconstructed state and become durable only with this batch.

Settlement data necessarily overlaps the eventual provider-formatted tool
content: that per-call recovery record is deliberate. It does not
justify copying complete message history into snapshots or installing the
same assistant/tool turn twice in the provider conversation.

Redaction: `redactSecrets` runs at publish on every stream-aggregate row
(C3, unchanged from today's recorder), and never on execution-aggregate
rows. There is no projection table (C10): the transcript surfaces and
`readCompletedRunConversation` (executions tool, chat export, CLI history)
read through C7's aggregate queries. After the conversation fold collapses,
display also consumes the execution aggregate through `RunLedger` and the
shared redaction boundary. Each aggregate has its own `fromSeq`, and the
50 KB display bound is a fold and render decision, not a stored one. The
first draft's transcript projector and `transcript_entries` table are
withdrawn, as is its "null payloads on COMPLETED" rule, since C1 forbids
rewriting a row.

Why the execution aggregate is exempt from C3, and why that is not a second
store: `redactSecrets` rewrites JSON string values under token, secret,
password, and API-key names and any `sk-`, `AIza`, `xai-`, or `Bearer`
token (`src/logger/redaction.ts:5-14`). Applied to model-visible content it
changes assistant text and thinking blocks, whose Anthropic signature then
fails verification on replay (`modelHandlerAnthropic.ts:1372` records that
the blocks must go back byte-exact), so the provider rejects the resumed
run; and it changes `tool_use` inputs and tool results the model has
already reasoned over, so the resumed context is not the one the model saw.
That is why today's checkpoint is never redacted (single-owner §6). The two
aggregates do not duplicate a store: the stream aggregate never holds
provider messages, and the execution aggregate never holds display rows.
One residue, named in C3 as well: until the view-state PRD collapses the
fold, message text is durable twice (redacted trace rows and
`model.message`); the collapse deletes the trace copy, after which the
execution aggregate is the only conversation and the shared display fold
redacts it before any view state is exposed, including direct in-process
subscribers. A secret in a payload remains on disk until explicit user deletion under
C9; display redaction does not remove it from the recovery data.

Resumability follows single-owner D8: "resumable" is "a `flow.snapshot`
exists and no live owner holds either run aggregate's current claim",
independent of the outcome, so a
completed run can be continued; the fold is the same in every case, and
the viewer steps any run from the same rows.

Mid-run model switch: today `persistModelSwitch`
(`runToolUseFlow.ts:254`, called at `:330`) is a two-phase write, record
first and `config.json` second, and A's durability refuter showed it is a
mid-step durable commit that a private working copy loses. In the row
model a switch calls `RunLedger.appendBatch`, backed by substrate C6's
`SessionEvents.publishBatch(events)`: all target ownership checks, sequence
assignments, and inserts share one transaction. It appends the existing
`run.config` event on the stream aggregate and a `flow.snapshot` with the
new `modelId` and `modelHandlerCompatibilityKey` on the execution aggregate
as the final row. Neither event is visible unless both commit. Resume order
is fixed by that: read the latest `flow.snapshot` for the model id and
compat key, build the handler, then fold, which is what
`SessionResumeRetrieval.ts:165-175` does today when it overrides
`agentConfig.model` from the checkpoint before the launch context builds
the handler.

Row versioning: the substrate's `type` column is versioned (`run.start.1`,
C1), and the six flow row types carry a version in their type string the
same way. `foldRunState` reads rows through the house `z.union` pattern at
the event boundary, with the legacy member `.transform()`ed into the
current shape and never `.catch`, since these are persisted data.
`flow.snapshot` is the family's non-message state schema and gets the treatment the
importer gives `flow_<id>.json` today: one boundary migration per schema
version, nothing downstream branching on version.

### 2.2 Loops

```ts
// src/agent/runtime/loop/toolUse.ts (replaces runToolUseFlow.ts and the six tool-use nodes)
export const runToolUse = Effect.fn('toolUse.run')(function* (
  start: ToolUseStart,
) {
  const ledger = yield* RunLedger; // append/appendBatch -> Effect<RunState>; load(executionId)
  const run = yield* RunContext; // executionId, streamId, modelCell, setting, logger, session
  const followUps = yield* FollowUps; // ToolUseSessionLifecycle behind Effect.callback
  let s = yield* ledger.load(run.executionId); // fold of rows, or null on a fresh run
  if (s === null) {
    const initial = yield* prepareSession(start); // no model or tool activity
    s = yield* ledger.appendBatch([
      initialMessages(initial),
      snapshot(initial), // committed before runTurn can invoke an external activity
    ]);
  }
  for (;;) {
    if (s.phase === 'waiting') {
      const receive = run.isSubagent ? followUps.drain : followUps.wait;
      const batch = yield* receive;
      if (batch === null) return run.isSubagent ? 'waiting' : 'cancelled';
      s = yield* followUps.consume(batch); // atomic messages + queue removal + turn.ready
    }
    s = yield* runTurn(s); // resumes at the folded phase
    if (s.halt) return s.halt; // 'cancelled' | 'failed'
    s = yield* ledger.appendBatch([
      snapshot({ ...s, phase: 'waiting' }),
      step('waiting'),
    ]);
    if (run.isSubagent) return 'waiting'; // one child cycle per invocation
  }
});
```

`runTurn` re-yields the services it needs (they are in Context, not
closures), drains queued follow-ups non-blockingly, calls `model.invoke`,
appends any replacement `model.compaction` before the normalized response
row in one batch (`pending-tools` for a tool-bearing response, `append`
otherwise), partitions tool calls into parallel-safe runs and barriers as
`ToolUseDispatchNode` does today, writes `tool.intent` unconditionally at
the dispatch site before invoking every barrier tool, runs a parallel-safe group with
`Effect.forEach(..., { concurrency: MAX_PARALLEL_TOOL_CALLS })` and raises
the typed `TurnEnded` short-circuit only after the current partition settles,
appends one
`tool.result` with its state mutation and `tool.end` per call, commits the
handler-built provider-message batch once the response's full call set has
settled, and ends with one batch
containing the resulting `flow.snapshot` and `flow.step turn.end`. Like the
reflection loop below, `runTurn` examines the folded phase and persisted
assistant/tool rows before choosing its next activity; it does not restart
a model invocation merely because the turn-end snapshot is absent.

Follow-up batches are consumed under a lease, not on receipt. Today a batch
is acknowledged only after every item has landed in `messages`; an append
that fails (oversized or corrupt media in `addMediaToUserMessage`,
`followUpMessages.ts:100-104`) leaves it unacknowledged, and
`resumeQueuedToolUse` restores it to the queue on the next resume. The
sketch's `FollowUps.consume` keeps that: `wait` and `drain` reserve a batch
without removing it durably. `consume` validates and builds its messages,
then uses `RunLedger.appendBatch` to commit the `model.message` rows on the
execution aggregate, `flow.step turn.ready`, and the post-consumption
queued-follow-ups snapshot on the stream aggregate in the same C6
transaction. The step makes the consumed batch ready for the next turn.
Queue mutations, including
new enqueues, are serialized through that transaction and remove only the
reserved item ids from the current queue, so a concurrent enqueue is not
overwritten. The consumer lease releases after commit. On failure neither
side changes and the batch returns to the queue; after a crash either both
the messages and removal exist or neither does. No intermediate queue
acknowledgement is written.

The reflection loop is the same shape with one outer coordinate:

```ts
export const runReflection = Effect.fn('reflection.run')(function* (start) {
  const ledger = yield* RunLedger;
  const model = yield* ModelInvoker;
  let s = yield* loadOrInitializeReflection(start); // initial messages + snapshot committed first
  while (!s.done) {
    s = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(openStage(`r${s.round}`), (st, exit) =>
          st.end(outcomeOf(exit)),
        );
        if (s.phase === 'round.ready') s = yield* prepareRound(s);
        while (s.phase === 'model.ready' || s.phase === 'response.ready') {
          if (s.phase === 'model.ready') {
            const r = yield* model.invoke(s);
            // Replacement history precedes this completed response, even on the final continuation.
            s = yield* ledger.appendBatch([
              ...replacementRows(r),
              assistant(r),
              step('response.ready', s.round, s.continuation),
            ]);
          }
          s = yield* processCommittedResponse(s); // uses the saved response; never calls the model
        }
        const out = yield* produceOutput(s); // commits output.pending plan, or reconciles that saved phase
        const next = finishRound(s, out, shouldContinue(s, out));
        return yield* ledger.appendBatch([
          ...out.facts, // output/compile facts settle once with the phase
          snapshot(next), // includes next round/phase, or done; never repeats a settled round
          step('round.end', s.round, out),
        ]);
      }),
    );
  }
  return s;
});
```

These helpers have explicit durable boundaries. `prepareRound` commits the
prepared context, round prompt/replacement, a snapshot with phase
`model.ready`, and `round.begin` before invoking the model. Assistant rows carry
the handler-normalized stop reason, usage, and output-processing metadata
needed by `decideContinuation`, in addition to provider messages. The
assistant and `response.ready` commit together. `processCommittedResponse`
uses that saved data, records the output progress, and commits the next
phase (`model.ready` or `output.ready`) and non-message state in one batch.
An interrupted run therefore processes a committed response before it can
issue another invocation. `replacementRows` emits a compaction only for a
non-prefix replacement; the full replacement precedes the assistant so
folding cannot discard the completed response. That replacement includes
the provider-formatted post-compaction context appended by
`ModelInvocationNode.post` (`ModelInvocationNode.ts:760-773`), not just the
handler's `updatedMessages`. Capture the context once, including its
clock-dependent values, before recording the response. If the completed
array is a prefix extension, persist its entire appended delta instead.
Both paths commit the exact post-injection history before the assistant
in the same batch; resume never regenerates that context.

`produceOutput` first commits an `output.pending` snapshot with a stable
round/operation identity, planned targets, and the immutable input content
or existing run-owned artifact references and digests needed for extraction,
latexdiff, and compilation. Re-entry reconciles that plan with the files and
canonical facts: matching completed artifacts are reused, matching partial
writes can finish, and a changed user file is never blindly overwritten.
Each external build's start and observed result are saved through the same
snapshot/activity boundaries; a started build with no recoverable result
requires explicit retry or reconciliation, rather than being run again
automatically. The output and compile-failure facts returned by this phase
commit once with the resulting snapshot and `round.end`, conditional on the
saved operation still being pending. Host open-file/instruction actions run
only after that new commit and are not emitted by replay. They are
best-effort, at-most-once notifications: a crash can lose an automatic open,
and no exactly-once UI delivery is promised. PR 3 must exercise interruptions
after file writes, builds, and fact publication against these boundaries;
wrapping today's `OutputNode.exec`/`post` in a replayed activity is insufficient.

The raw output file still grows per continuation, as at
`ResponseCycleFlow.ts:321-337`, and compile-repair state stays in the
snapshot. Replaying a saved response must not append its text twice:
response metadata records the target byte offset and the information needed
to derive the exact output fragment from its provider message. Processing
checks that interval, completes a matching partial write, or skips an
already complete write before committing `flow.step response.processed`; conflicting
file content is surfaced for repair. This preserves live output and the
resume prefill used by `initializeOutputAndPrefill` without treating an
unrecorded file append as evidence that another model call is needed.

### 2.3 Fold, resume, and the viewer

`foldRunState(rows) -> RunState` is one pure, data-only function in
`src/shared`: restore the latest `flow.snapshot` and its referenced message
history and any referenced pending tool response/settlements, then apply
later `model.compaction`, `model.message`, `tool.intent`,
`tool.result`, `flow.step`, and the existing approval rows in commit order.
`RunState.pendingIntents` is keyed by call id and records its latest attempt;
an explicitly approved new intent supersedes the previous attempt, and only
a result for the current attempt removes the pending call. Settled results
remain available under the pending response until its single handler-built
message batch is delivered, following §2.1. Snapshots retain
these maps, pending approval decisions, the `pendingRetry` gate below,
durable phase, and the reference to
any response still awaiting processing. It runs in
`RunLedger.load` on resume and in the trace viewer's
stepper, and nowhere else: there is no `run_state` summary, no projection
table, and no `executions` table (contract C10). The listing tier reads the
latest canonical `status` fact through the `(aggregate_id, type, seq)` index,
including a reservation that fails before any `flow.step` exists, and
"resumable" means a `flow.snapshot` exists and no live owner holds either
run aggregate's current claim (single-owner D8; the outcome does not enter into it). Because the
same function produces the
state the loop saw when it appended step `k`, "state at step k" and "resume
would continue after step k" are the same fact. This is the
replay-along-the-flow property, obtained without re-executing anything.

Ordering across aggregates: execution-aggregate flow rows and
stream-aggregate rows have independent `seq` values. `flow.step` shares the
stream aggregate and is ordered with trace rows by that stream's `seq`. Every
row also carries the database-wide `commit` value, exported under the same
name, and the scrubber keys on that. `StreamLogEntry.seqNo` is
renumbered on merge and is explicitly not foldable, so it is not the key.
`RunLedger.load` uses C7's indexed
`aggregatesAfterCommit([aggregateId('execution', executionId),
aggregateId('stream', streamId)], snapshot.commit)` for the
tail, so it neither confuses the two sequence spaces nor scans unrelated
runs. A snapshot includes the preceding rows on both aggregates and its
explicit non-message state; `appendBatch` resolves any reference to an
earlier message in the same batch while assigning commits. When a step
checkpoints new non-message state, its snapshot precedes the `flow.step`
in that same transaction. The viewer's cut at the step's commit therefore
includes those fields, and resume folds the step after the snapshot without
repeating the associated activity. Referenced message history is read separately on
the execution aggregate, through that snapshot boundary. The viewer sees
coordinates, the tool-call graph, and display-redacted state at step `k`;
the runtime alone receives byte-exact provider content. Both local display
and exported documents pass through C3's display redaction.

Resume: `runAgent({kind:'resume'})` acquires the current claims for the
execution and stream aggregates first (C5), then calls `RunLedger.load`.
Claims come from current aggregate state, never the writer on a historical
event. It restores the recoverable approval bindings below before retiring
any stale process-local request. The
resume rules live in the runtime, not the fold, and read only row data:
a barrier `tool.intent` without a matching `tool.result` is an explicit
outcome-unknown state, whether the tool ran, was mid-approval, or never
started; the loop surfaces an `approval.requested` row (one-fold PRD §6
item 1), keyed by call id and attempt, asking to re-run or skip,
never re-running a destructive call blindly and never fabricating CANCELLED
for a tool that may have run. No provider result is appended while the
decision is pending. Skip atomically commits `approval.resolved`, the
single synthetic `tool.result`, and its terminal `tool.end`; re-run atomically
commits the resolution
and a new attempt's `tool.intent`, then invokes the tool and appends its
single settled result with `tool.end`. A second crash before that result
returns the new
attempt to outcome-unknown; an earlier approval never authorizes another
attempt implicitly. Each original call supplies one settled result to the
provider's complete follow-up batch; provider messages are installed only
at that batch boundary. Eligible parallel-safe calls without results re-run. A
`waiting` step re-enters the follow-up wait; a subagent's per-cycle WAITING
resumes from the snapshot committed with that transition, drains any queued
batch, and returns WAITING only if none is available. Its non-message fold
is one snapshot plus a handful of rows; message restoration follows §2.1.
A fresh launch
onto a non-empty aggregate is refused (keeps #11313 semantics). The nine
preservation reasons in `runToolUseFlow.ts:606-685` are enumerated against
the row model in PR 2; follow-up consumption uses the atomic queue/message
transaction in §2.2.

Unpaired tool calls first consult the saved dispatch dispositions. A
duplicate waits for its primary's settlement, then derives the same
`duplicateOf` result as the live dispatcher, with empty edits, attachments,
and state mutation; it never executes or reapplies the primary's effects.
A call skipped by an earlier `endTurn` receives its saved synthetic skip
result even if parallel-safe. Only the remaining eligible calls use the
ordinary rule: re-run if parallel-safe, outcome-unknown if a `tool.intent`
exists, and a synthetic cancelled result if neither. Once all are resolved,
the handler builds the complete paired
message batch before the next model invocation; no partial group or
independently appended pending assistant enters provider history. This
preserves the pairing `ToolUseDispatchNode.ts:527-605` enforces today.
Blank-continuation synthetic messages
(`ToolUseProcessNode.ts:208-275`) are ordinary `model.message` rows and
fold without special handling.

Manual retry across process death: `ModelInvoker` currently blocks on
`session.interactions.requestRetry` (`ModelInvocationNode.ts:554-598`).
Before presenting that prompt, the ledger atomically commits its
`approval.requested` and a snapshot containing `pendingRetry`: the request
id, invocation identity, failed attempt, failed model/compatibility key,
credential-route requirements without secrets, and a `waiting` recovery
substate. The family phase can remain `model.ready`; `ModelInvoker` checks
this gate before any invocation. Absence of a response is not permission
to retry while the gate is waiting.

Only two approval purposes have a durable recovery binding: `model-retry`
names that saved invocation/request, and `tool-outcome` names the pending
response/call/attempt above. Resume validates these bindings against the
ledger and reconnects each unresolved request's original id to a new
listener before admitting model or tool activity. The companion's generic
`approval.resolved { cause: 'interrupted' }` cleanup applies only to
unrecoverable process-local requests; it must not retire these two kinds.
A missing or inconsistent recovery binding refuses resume with a diagnostic
rather than converting the request into consent. Pending requests before a
snapshot remain reachable through its saved request references.

A retry decision and the snapshot's `authorized` substate commit together;
denial/cancellation instead commits the resolution and the corresponding
halt state. Authorization permits exactly one named attempt. Before its
external invocation, `ModelInvoker` durably consumes that authorization by
recording `started` for the attempt. A resumed `authorized` attempt can
consume its unused permit; a `started` attempt without a committed response
requires a new retry decision and cannot reuse the earlier permit. The
response row identifies the invocation/attempt and clears the gate when
folded. Thus a crash before a decision preserves the prompt, one after the
decision preserves unused consent, and one after consumption cannot launch
another billed attempt implicitly. These recovery rules land with the
approval events in PR 2 (§7 item 3).

### 2.4 Services and layers

`Context.Service` classes with static layers, `Data.TaggedError` errors, Zod
payloads, no Effect Schema. Per session root (inside the one-fold PRD 7.3
`LayerMap`): `Database`, `SessionEvents`, `RunLedger`. Per run, provided at
the Promise boundary in `executeAgent`: `RunContext`, `ModelInvoker`
(`ModelCell`, `ModelRetryGate`, the auto-retry batch as
`Effect.retry` with a `Schedule`, the manual approval loop, `prepareRetry`
rebind), `Tools` (overlay registry plus the `submit_output` terminal tool),
`FollowUps` (scoped lease over the follow-up queue, `wait` and `drain`).
`OutputPipeline` keeps reflection's output helpers and adds the phase
boundaries and reconciliation specified in §2.2.

Interruption: the host's stop is `Fiber.interrupt` delivered through
`runtime.runPromiseExit(program, { signal })`; model handlers and tools are
called through `Effect.tryPromise((signal) => ...)` so the fiber's signal
reaches the in-flight request. Each activity/append pair uses
`Effect.uninterruptibleMask((restore) => ...)`, with the activity and all
asynchronous preparation under `restore`: normalization, attachment capture,
and provider-message construction remain interruptible. The activity returns
a fully prepared append payload; only its synchronous handoff and durable
append stay masked, never the entire loop. An interruption during preparation
leaves no settlement: a barrier retains its outcome-unknown intent, and other
activities follow their saved phase/retry rules. After preparation returns,
a user stop cannot split the handoff from its append. Process death still
has the documented unknown-outcome window; the mask is a fiber construct,
not crash protection. A manually authorized retry is the narrow
exception: its consumed permit requires renewed consent under §2.3.
The append runs inside the publisher's
`Semaphore(1)` and `BEGIN IMMEDIATE`, so stop latency is bounded by the
largest in-flight row on that session root; PR 2 must budget it or move the
payload write out of the seq-assignment critical section. `linkAbortSignals`,
`onAbort`, the startup-cancellation window, and `p-retry` in the runtime
delete, together with `RunScope.signal`; its two Promise-tier readers
(`executeAgent.ts:440`, `AgentRunLifecycle.ts:706`) move onto the fiber's
exit in the same PR rather than keeping the field alive for them.

Child dispatch: native delegation and workflow-script
`agent()` re-enter `runAgent`; a child has its own stream and execution
aggregates, independent of its parent's owning lifecycle (C9). The parent's
`tool.result` for the delegation call is the launch acknowledgement for
detached children and the terminal result for in-band ones, exactly as
today. R4.6's single activity protocol (the script journal moving into the
event table, `persistence.ts` deleted) is PR 4 and is in scope.

Detachment after parent deletion is reconstructed from durable parent
state, not just the live registry. `run.start.parentStreamId` and
`parentStartCommit` record the declared parent and that parent's particular
`run.start` commit, captured together when the child is registered. Before
admission, resume, a new child turn after
WAITING, or parent-directed delivery/approval routing, the runtime resolves
`aggregateId('stream', parentStreamId)` through C7 `aggregateState` and the
indexed current `run.start` lookup. A missing or closed parent, or a current
start commit unequal to `parentStartCommit`, gives **no effective parent**;
the matching open parent remains the parent even when it has no live owner.
Missing view residency or an
unsubscribed transcript is never evidence of deletion. Snapshot fields and
cached launch options cannot restore a parent that this check removed.

Local deletion and cross-process aggregate-state reconciliation apply the
existing `activation.detach()`, `handle.detach()`, and approval-ancestry
detachment to live children. Waiting and persisted children receive the same
result when their runtime is reconstructed. Their standalone approval policy
comes from the child's durable `approval.policy` snapshot; routing never
consults the deleted parent's grants or follow-up queue. Before a parent
delivery commits, C6 also checks that its target remains open with the same
`parentStartCommit`; a concurrent
deletion detaches the child instead of recreating the target. Thus no result,
approval, or later follow-up can return to a deleted parent merely because
its immutable launch edge or an old snapshot still names it. The commit
comparison also prevents a reused logical id from adopting the child after
retention erased the original parent. It uses the existing non-reused commit
ordinal, so removing `setParentStream` requires no new detachment event.
Legacy import retains a parent edge only when the import manifest identifies
that exact parent run; otherwise the imported child is detached.

### 2.5 What OpenCode confirms and what it does not

Verified against `/tmp/opencode-src` (V2 in `packages/core/src/session`):
the loop is an `Effect.fn` `while` loop with no step cursor; durability is
the event table plus projected message rows plus a durable input inbox;
resume fails interrupted tools then re-drains; deltas are live-only with the
text-ended event as the replayable boundary; publication is serialized under
one semaphore; tool settlement is under `uninterruptibleMask`. All of that
is this design. What OpenCode does not have and this design adds: a
document-transform family (reflection rounds), intent rows for barrier
tools, a periodic state snapshot, and resume at all (V2 defers post-crash
continuation and has no sub-agents yet). OpenCode does not use
`effect/unstable/workflow`.

## 3. Sequencing: the runtime is lane D of the cutover

The owner's rule is no intermediate projectors or adapters, only the target
architecture. The first draft of this section had two intermediates: a
release-N `checkpoint` column that the old `persistedFlow.ts` would update
for one release and the next release would drop, and a Promise shim so
reflection could call the new model service while still running on
PocketFlow. Both are dual systems with a retirement clock, and both are
withdrawn.

The clean sequencing is that **this program is Stage 5 and lane D of the
substrate cutover**. The cutover already has zero code, so nothing is
re-done: lane D's deliverable is the two loops, the row vocabulary of §2.1,
`RunLedger`, `foldRunState`, and the one importer, which converts each
supported `flow_<id>.json` directly into canonical rows. It preserves the
provider messages byte-exact in the initial message base and stores the
remaining validated `shared` fields, including
`modelHandlerCompatibilityKey`, in `flow.snapshot`. The import transaction
also translates the authoritative `FlowRecord.cursor.nextNodeId` and
`lastAction` into the new durable phase and any necessary `flow.step` or
repair rows; copying `shared` alone is insufficient. The mapping is explicit
for each supported family and cursor:

- A cursor before invocation becomes `model.ready` only when no completed
  response is present; a saved response awaiting processing becomes
  `response.ready`, with all required normalized metadata present.
- A cursor at tool dispatch uses the saved extracted calls and paired
  results. Every unresolved barrier that might already have been dispatched
  gets a `tool.intent` requiring outcome-unknown approval; absence of a
  legacy intent is not evidence that the call never ran.
- Round/output boundaries and terminal edges preserve the last action and
  next round or waiting state, without replaying a settled round.

Unknown cursor paths, missing response metadata, or a continuation whose
next activity cannot be established safely stop the import for that run
with an explicit unsupported-resume diagnostic. No resumable snapshot is
committed for it, and its source files remain available for recovery;
there is no guessed fresh-run fallback. Legacy owners must be stopped and
the substrate §8 migration claim must be held throughout this conversion.
The temporary input schemas and cursor mappings retire with that section's
three-month compatibility window. `persistedFlow.ts`, `src/agent/node/`,
and the three interpreters are deleted in the same branch, so no overwrite
of a whole conversation checkpoint survives the cutover and the amplifier is fixed in the release that
fixes the substrate. The substrate proposal's Stage 5 text (`messages` rows,
checkpoint envelope) is replaced by this, and its §8 freeze on
`src/agent/node` and the flow directories becomes the freeze on lane D's
files.

The cost is that the cutover branch is larger: five substrate lanes plus
one runtime lane, and the runtime lane is the riskiest behavioral change in
the program. Three things keep it bounded without an intermediate:

- The runtime lane is developed against the `RunLedger` interface with an
  in-memory layer, `TestClock`, and `Layer.mock`, so it does not wait for
  the SQLite lanes to be green; it is integrated once, on the branch.
- Both families convert in the same lane so `ModelInvocationNode` is deleted
  with its last constructor; no shim exists because nothing runs on the old
  engine while the new service exists.
- Rollback is the cutover's rollback: revert the branch merge. There is no
  half-migrated state to reason about, which is exactly the property the
  intermediates would have destroyed.

"Two cutovers at once" is answered by the fact that there is one cutover
with one importer, one row vocabulary, one writer per datum, and one revert
point. The pain the phrase names came from two formats coexisting with two
readers, and this sequencing has neither.

What lands on main before the branch merges: the substrate amendment as a
docs PR (this document and the Stage 5 rewrite), and nothing under
`src/agent/node`, `src/agent/core/flows`, `implementations/flows`,
`src/agent/storage`, or `src/transcript`.

## 4. Elimination ledger

Deleted (with the replacement in the same PR, R10):

| Path                                                                                                                               | LoC         | Replaced by                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `src/agent/node/index.ts`                                                                                                          | 158         | nothing                                                                        |
| `src/agent/node/persistedFlow.ts`                                                                                                  | 531         | `RunLedger` + `foldRunState`                                                   |
| `reflection/RoundPersistedFlow.ts`                                                                                                 | 270         | round loop + `shouldContinue`                                                  |
| `reflection/ResponseCycleFlow.ts` (nodes and graph)                                                                                | 593         | continuation loop                                                              |
| `reflection/nodes/*` as classes                                                                                                    | 751         | functions; bodies move                                                         |
| `reflection/ReflectionFlowState.ts` latches                                                                                        | 68          | `flow.snapshot`                                                                |
| `tooluse/ToolUseRoundFlow.ts`, `nodes/*`, `toolUseRound/*` as classes                                                              | ~1,650      | `runToolUse`, dispatch functions; bodies move                                  |
| `tooluse/runToolUseFlow.ts` graph rebuild, disposition ladder, attachment and startup-window code                                  | ~500 of 719 | loop + scope finalizers                                                        |
| `core/flows/ModelInvocationNode.ts`                                                                                                | 846         | `ModelInvoker` (~500; the retry, gate, and credential logic does not shrink)   |
| `core/flows/{FlowTransitions,CycleServices,BaseFlowServices}.ts`                                                                   | 122         | Context services                                                               |
| `src/agent/storage/resumability.ts` full-checkpoint parse                                                                          | 120         | latest-of-type index read (`flow.snapshot` present) plus the C5 liveness probe |
| `SessionResumeRetrieval.ts` checkpoint read                                                                                        | ~170 of 234 | fold; model id from the latest `flow.snapshot`                                 |
| `runtime/persistedCompileRejection.ts`                                                                                             | 46          | snapshot field                                                                 |
| Tests: `PocketFlowNode`, `PersistedFlow`, `ReflectionFlowStateRecovery` suites; 13 record-format pins reduced to importer fixtures | ~900        | fold test, ledger test, repair-policy test (~400)                              |

Rewired, not deleted (the refuters' missing list): `AgentLaunchContext.ts`
(compat key from snapshot row), `executionLifecycle.ts`,
`executionListing.ts`, `tools/executions/executionKvFiles.ts`,
`tools/executions/executionLiveness.ts` and
`controllers/session/SessionState.ts` (replace `flowKey` reads with ledger
queries), `runtime/resumeRun.ts` (handle the ledger's persisted-state error
instead of `PersistedFlowStateError`),
`SessionHandle.ts`, `runClassification.ts`, `ExecutionsTool.ts`, and the
CLI's `toolUseResumeData.ts`, `runExecution.ts`, `commands/workflow.ts`
(all `deriveResumability` callers; the host-agent import ratchet must not
widen), `stateSettings.ts` honoredBy provenance,
`ResponseCycleContinuation.vitest.ts`, `childRunLoop.ts` (turn-state
persistence only).

Net: about -3,000 production lines (range -2,000 to -3,500). The certain
part is the ~2,100 lines of engine, interpreters, graph builders, and
disposition code; the uncertain part is how much of the node bodies
compresses when the phase ceremony goes. `output/` (3,482) and
`workflowScript/` (3,284) are untouched.

## 5. PR plan (stacked on the cutover branch, lane D)

0. Docs, on main now: replace substrate §6 Stage 5 and the §8 freeze list
   as in §3; record the R4 and 13.C reversal in the migration PRD; add the
   six row types to the one-fold PRD §6 durable set; state the retention
   rule.
1. Foundation: `RunLedger` service over `SessionEvents`, the six
   `AgentEvent` arms with Zod schemas, `foldRunState` in `src/shared`, the
   in-memory ledger layer, one ledger test and one fold test. Nothing
   deleted yet; nothing in production calls it yet.
2. Both families on the ledger, one PR: `ModelInvoker`, `Tools`,
   `FollowUps`, `RunContext`, `OutputPipeline`, `runToolUse`,
   `runReflection`; `executeAgent` and every resume arm call
   `runtime.runPromiseExit` with the fiber's signal; the importer's
   `flow_<id>.json` to canonical rows/cursor mapping, and the existing
   `approval.requested` / `approval.resolved` rows required for safe repair
   and manual retry. Deletes `src/agent/node/`,
   `ModelInvocationNode`, `RoundPersistedFlow`, `ResponseCycleFlow`,
   `ToolUseRoundFlow`, all sixteen node classes, the disposition ladder,
   `linkAbortSignals`, `onAbort`, the startup window, `p-retry` in the
   runtime, `resumability.ts`'s parse, the checkpoint arm of
   `SessionResumeRetrieval`, the engine tests, and the PocketFlow sections
   of CLAUDE.md, AGENTS.md, and
   `docs/architecture/2026-06-20-pocketflow-state.md`. This is the large PR
   of the program; it is reviewed as one because splitting it is what
   creates the shim.
3. Replay along the flow: `TraceDocument.steps` with `commit`, the viewer
   scrubber over `foldRunState`, the `flow.step` arm in the session
   fold so the CLI's waiting-on row and the progress board read
   `StreamView.flow`. Deletes the stage-row derivations those surfaces use
   today.
4. One child protocol: workflow-script journal rows into the event table
   under the script run's aggregate; native `ChildTurnRef` and the script
   journal entry become one attempt identity. Deletes
   `workflowScript/persistence.ts`, `ChildTurnState`, and the turn-state
   writes in `childRunLoop.ts`. In scope, not optional: leaving two ledgers
   is the intermediate this program refuses.

Each PR deletes what it replaces. There is no shim, no interim column, and
no window in which two runtimes or two checkpoint formats exist on the
branch.

## 6. Rules reversed or amended

- Migration PRD R4 and 8.4: reversed. No PocketFlow authority, no graph
  kernel. The durability requirements R4.1 to R4.6 are met by rows: explicit
  membrane (the append), declared replay classes (intent rows for barriers,
  re-run for parallel-safe), finer tool-use checkpoints (per-call rows),
  stable identity (logical keys: round, turn, callId; never a traversal
  path), rounds as durable coordinates (`flow.step`), one child protocol
  (unified in PR 4).
- Migration PRD 13.C: upheld on the module, moot on the reason. Effect's
  workflow module stays out; the persistence redesign it feared mixing is
  now the prerequisite.
- Persistence proposal §6 Stage 5: replaced by this program as lane D
  (§3); the substrate's §6.1 contract (C1, C2, C10, D4) now owns the schema
  and references this document for the row names. §7 last bullet
  ("the agent runtime, model handlers, and flows are not migrated to Effect
  in this release"): reversed for the runtime and flows; model handlers
  still are not migrated and are called through `Effect.tryPromise`.
- On projections: none. The first draft's transcript projector,
  `transcript_entries` table, and `run_state` summary are withdrawn under
  C10; `flow.snapshot` is the one checkpoint row, sanctioned by the contract
  for non-message state and references to canonical conversation rows.
  `foldRunState` runs on load and in the
  viewer only. This program adds no derived table and no layer whose
  purpose is to bridge two formats.
- On secret redaction (contract C3): C3 scrubs provider error bodies and
  approval payloads at publish, before the row. That rule must not extend
  to the `payload` of `model.message`, `model.compaction`, and
  `tool.result`. `redactSecrets` rewrites JSON string values whose key
  matches token, secret, password, or API key, and any `sk-`, `AIza`,
  `xai-`, or `Bearer` token (`src/logger/redaction.ts:5-14`). Applied to
  model-visible content it (a) changes assistant text and thinking blocks,
  whose Anthropic signature then fails verification when replayed
  (`modelHandlerAnthropic.ts:1372`), so a resumed run is rejected by the
  provider; (b) changes `tool_use` inputs and tool results the model has
  already reasoned over, so the resumed context diverges from the one the
  model actually saw; and (c) is exactly why today's checkpoint is never
  redacted (single-owner §6). Settled with the substrate owner on
  2026-09-04: C3 now has three owners (scrub at publish for stream rows,
  error and approval payloads; byte-exact execution-aggregate rows; display
  redaction in the shared display fold before exposing view state, and at
  every transport framer and export). This document's
  "null on COMPLETED" and "removed at completion" were withdrawn because
  C1 forbids rewriting a row, single-owner D8 keeps completed runs
  continuable, and after the fold collapse these rows are the only
  conversation. Those bytes remain until explicit user deletion under C9.
- One-fold PRD line 102: reversed by the owner's ruling; its `fold(view,
event)` gains the `flow.step` arm and its §6 durable set gains six rows.
- Single-owner §6: its single door at admission stays for the stream
  aggregate; for the execution aggregate display redaction precedes every
  view-state update, including in-process CLI views, as well as transport
  and export (C3, third owner); its "checkpoint content" list is false
  of the table, by design. Single-owner D8 is upheld and extended: nothing
  deletes a completed run's rows, not even completion.

## 7. Decisions requested from the owner

1. Ratify the shape (§2) and the sequencing (§3): the runtime is lane D of
   the cutover branch, with no interim column and no shim, accepting a
   larger branch in exchange for one revert point.
2. Preserve byte-exact conversation rows with the user's history until
   explicit deletion under C9. They are never scrubbed or expired by age.
   Removing recovery rows earlier than display rows would discard the only
   conversation after the folds merge and violate the completed-run resume
   contract.
3. Confirm that the existing `approval.requested` / `approval.resolved`
   events land with PR 2. They are required for outcome-unknown barrier
   tools and manual retry (§2.3); those resume paths cannot ship before the
   events and their decision handling are available.
4. Confirm that the child-protocol unification (PR 4) is in scope, since
   leaving the script journal as a second ledger would be an intermediate.

## 8. Risks

- Snapshots bound the non-message tail; restoring the current conversation
  still reads its canonical message base and deltas. PR 1 measures both
  costs separately and warns on an unexpectedly large non-message tail.
  Mandatory snapshots must never regain an accumulated message array.
- Anthropic image blocks and pasted attachments inline base64 in provider
  messages; one `model.message` row can be megabytes. Pending tool attachment
  recovery also stores immutable base64 in `tool.result`, overlapping the
  eventual provider content. Accept both in N+1; a later asset store may
  address this cost without weakening recovery.
- Handlers that return `updatedMessages` on every call would write a
  compaction row per call; the prefix check in `RunLedger.append` must be
  exact.
- Effect rc churn: every name below is verified in rc.112; the next rc may
  rename. All uses sit behind the five service classes.
- Raw provider content lives in the database until explicit user deletion
  (§7 item 2). Any new reader of the `event` table that bypasses the fold is a
  redaction leak. The `Database` layer exposes the five
  execution-aggregate row types only through `RunLedger`, so the raw query is
  unconstructible elsewhere and no test is needed. Otherwise the
  architecture test that fails persistence writes outside the database
  (substrate Stage 1) needs a sibling that fails raw reads of those rows
  outside `RunLedger` and the fold.
- A dedicated durability refutation of this text ran on 2026-09-04 and found
  two fatals and six majors in the first draft (the approval-hook intent row,
  the retention rule nulling display results, ten snapshot fields with no
  home, the reflection output file, fold cost without a message base point,
  cross-aggregate ordering in the viewer, the fold needing the registry, and
  the mutable event row in release N). The revised contracts above address
  these findings; PR 2 still needs verification at each crash boundary.

## 9. Verified

Against source on 2026-09-04: Effect rc.112 exports `when` (no `unless`),
`tryPromise` with signal, `uninterruptibleMask`, `forEach` with
`concurrency`, `callback`, `retry`, `runPromiseExit` with
`RunOptions.signal`, `fn`, `LayerMap`, `Semaphore`, `ManagedRuntime`,
`PubSub`, `SubscriptionRef`, `testing/TestClock`; `Effect.fn` returns a
plain function (pipeables are trailing arguments). Repo: `StateSlicesSchema`
at `nodes/types.ts:26`, snapshot rewrite at `ToolUseCycleNode.ts:36-43`,
`retainFlowRecordUnlessCompleted` at `executionLifecycle.ts:227` and
`AgentRunLifecycle.ts:562`, Google `callId` synthesis at
`modelHandlerGoogleInteractions.ts:1237`, `Date.now` in
`postCompactionContext.ts:60`, `z.custom` rationale at
`ProviderMessage.ts:25-28`, substrate Stage 3/5 rows and §9 text, the ten
non-flow importers of `persistedFlow.ts`, and the `deriveResumability`
callers. From the 2026-09-04 refutation: `deferLogUntilApproval: true` in
exactly three tool files and `parallelSafe: true` in twelve;
`onExecutionReady` constructed only for deferred tools
(`ToolUseDispatchNode.ts:345-351`); `readCompletedRunConversation` read by
`ExecutionsTool.ts:640`, `loadChatExportInput.ts:79`, and the CLI
`history.ts:183`; `initializeOutputAndPrefill` called at
`ResponseCycleNode.ts:78` and defined at `ModelHandler.ts:1519`. OpenCode facts from the 2026-09-03 survey of
`/tmp/opencode-src` at `f12e14c`. Panel artifacts: workflow run
`wf_70dfff59-094`, five design JSONs and nine refutation JSONs in the
session scratchpad under `panel/`.

The settlement and provider-batching amendment was checked against
`toolUseRound/ToolUseDispatchNode.ts:443-605`,
`ModelHandler.ts:1679-1713`,
`anthropic/anthropicToolResults.ts:190-232`, and
`google/modelHandlerGoogleInteractions.ts:1304-1345`: display completion
currently precedes message construction, the provider requires original
call order, and the builders can return the assistant content as well as
results while consuming saved reasoning state.
