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
The two-aggregate shape that makes this consistent is in §2.1; no
contradiction between the two documents remains.

## 0. Recommendation

Move both flow families onto one shape: **each family is a plain Effect loop
whose only durable act is appending rows to the session event table on the
execution's own aggregate**. Provider messages, tool intents and results,
flow coordinates, and a periodic state snapshot are the rows; run state is a
pure fold of those rows, computed by the same function on resume and in the
trace viewer, and never persisted (substrate C10). There is no node, no
graph, no action string, no cursor, and no flow record. Resume loads rows
and continues the loop. Stepping a run in the trace viewer folds rows up to
a chosen seq.

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

| Design | Shape | Fatal refutations | Verdict |
|---|---|---|---|
| A. Ratified kernel + one event | Typed node transitions over the existing cursor record | Private working copy discards mid-step `switchModel` commit (silent wrong-model resume). No replay from trace by construction. | Rejected. Does not meet the ruling; would be a stepping stone, which is the dual system. |
| B. Journaled activities, replayed program | Deterministic program re-executed against journaled activity results by logical key | Tool-mutated run/workspace state never journaled; model payload has no Zod schema (raw SDK response); post-compaction injection uses `Date.now()` so every resume across a compaction faults; sequencing re-migrates the checkpoint twice | Rejected as written. Its keys and intent rows are grafted. |
| C. Effect `unstable/workflow` with a custom engine | Workflow bodies + Activities memoized in our table | Requires Effect Schema (binding ruling 6); `Schema.Unknown` removes the Zod boundary on memo hits; memoized failures replay as failures so resume-after-failure is impossible; `DurableDeferred` completes once so batched follow-ups drop | Rejected. The module is not the way to the ledger model. |
| D. Ledger loop | Two `Effect.fn` loops over appended conversation rows + run_state projection | Sequencing kept a blob writer beside the new rows across three PRs; no intent rows (R4.2/R4.3 unmet); assistant text durable twice; layers placed at process scope instead of per session root | Selected, with the fixes below applied. |
| E. The flow is a fold | Pure reducer over Zod state emitting commands; generic interpreter | None fatal. Two-exit interpreter cannot halt on cancel; tools activity breaks the one-outcome shape; Stage 5 carve-out is the lazy import §9 forbids. (Its refuter's "raw output file written before commit" finding was itself wrong: the per-continuation file is the mid-cycle checkpoint and stays.) | Runner-up. Its fold rule and checkpoint policy are grafted; its reducer and command machinery are not. |

Findings all refuters agreed on, regardless of design:

- The tool-use durable state is not only messages. `stateSlices` (run
  snapshot with usage accumulator, workspace snapshot with work plan and
  file interactions, user channels) is rewritten from live state at the end
  of every cycle (`ToolUseCycleNode.ts:200-204`, schema at
  `nodes/types.ts:26-30`). Tools mutate it through the session, not through
  their results. Any row-based design must snapshot it per turn.
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
- Today a COMPLETED run deletes its checkpoint
  (`executionLifecycle.ts:227`, `AgentRunLifecycle.ts:562`). Every design
  that kept unredacted rows forever was a retention regression.
- Every "after the cutover, with Stage 5 carved out" sequencing is the lazy
  checkpoint import the substrate proposal §9 rejects, or a double migration
  of the same datum. The fix is the same in all four refutations: the cutover
  writes the row shape this program will keep.
- Deletion lists were incomplete everywhere. Seven production modules outside
  the flow directories import `persistedFlow.ts`; `deriveResumability` has
  callers in `src/tools`, `SessionHandle`, `runClassification`, and three CLI
  files. They are in the ledger below.

## 2. The shape

### 2.1 Rows

Two aggregates per run in the substrate's `event` table, keyed
`(aggregate_id, seq)` (contract C1), with the execution id as an aggregate
kind (C2) beside the stream and session ids. The `commit` column (`INTEGER
PRIMARY KEY AUTOINCREMENT`) is the database-wide total order; nothing
relies on the implicit rowid. The split is the one that exists today as two
files, made explicit:

- The **stream aggregate** holds what people see: the existing trace rows
  (`tool.start`/`tool.end`, `response.finalized`, `usage`, stages) and
  `flow.step`. Every row is scrubbed at publish (C3 applies in full) and
  lives until the C9 retention setting removes the stream. This is today's
  transcript sidecar.
- The **execution aggregate** holds what the model sees: `model.message`,
  `model.compaction`, `tool.intent`, `tool.result`, `flow.snapshot`. Rows
  are byte-exact and never scrubbed (C3, second owner). They are read by
  `RunLedger.load` and by the in-process fold; the lease gates writes, not
  reads. No row is ever rewritten and nothing is removed at completion:
  single-owner D8 (#11304, "a checkpoint is deleted only by the user")
  keeps a completed run continuable, and once the view-state
  fold collapses these rows are the only copy of the conversation. The
  aggregate lives for the C9 retention window like every other row, which
  is shorter than today's "forever" for cancelled and failed checkpoints.
  Every transport framer to a renderer process and every export applies
  display redaction and truncation (C3, third owner), so nothing outside the
  process receives a byte-exact row.

Flow row types, all Zod-validated at the boundary, all carried as
`AgentEvent` arms so the existing trace plumbing, fold, and viewer see them:

| Row | Written when | Payload |
|---|---|---|
| `flow.step` (stream aggregate) | round begin/end (reflection), turn begin/end, `waiting`, `halted`, terminal outcome | `{ family, step, round?, turn?, outcome? }`; small. The listing tier reads the latest one through the `(aggregate_id, type, seq)` index |
| `model.message` | every provider-native message appended: round prompt, assistant response, user follow-up, synthetic continuation | handler-built `ProviderMessage[]` delta (z.custom), plus the extracted `toolCalls: { callId, name, input }[]` for assistant rows |
| `model.compaction` | a handler returns `updatedMessages` that is not a prefix extension, or a reflection round opens | the full replacement array; later loads start here |
| `tool.intent` | unconditionally at the barrier dispatch site, before any barrier (non parallel-safe) call starts (`ToolUseDispatchNode._exec` today). Not from an approval hook: `onExecutionReady` exists for three tools only (`bash`, `codex`, `wolfram`), while about 38 of 50 tools are barriers | `{ callIds }` |
| `tool.result` | after each tool call settles, one row per call including duplicates (`duplicateOf`) | provider tool-result message + attachment references, byte-exact. The display result is the existing `tool.end` row on the stream aggregate, scrubbed at publish as today |
| `flow.snapshot` | at `turn.end` / `round.end`, before WAITING, and whenever bytes appended since the last snapshot exceed its size | the family's full Zod state (`ToolUseRunSharedSchema`, `ReflectionFlowStateSchema`), messages included: `structured`, `lastError`, `userCancelledRetry`, `shouldSkipCycle`, `systemPrompt`, `continuationGenerationId`, `stateSlices`, `modelId`, `modelHandlerCompatibilityKey`; `outputLocation`, `roundOutputs`, `continueRounds`, `endTurn`, `context`, compile-repair state, round counters |

The snapshot is a real base point: resume folds the latest snapshot plus
the rows since it, which is at most one turn or one round. The price is one
whole-state write per turn (today it is one per outer node step, two to
three per turn, and none inside the inner round), so write amplification
drops but does not vanish; the byte-amortized rule bounds it. Rows between
snapshots are deltas. `toolCalls` entries on assistant rows carry
`parallelSafe` stamped at append time so the fold and the resume rule stay
data-only and need no registry.

Redaction: `redactSecrets` runs at publish on every stream-aggregate row
(C3, unchanged from today's recorder), and never on execution-aggregate
rows. There is no projection table (C10): the transcript surfaces and
`readCompletedRunConversation` (executions tool, chat export, CLI history)
fold the stream aggregate through `aggregate(aggregateId, fromSeq)` (C7;
a transcript subscriber names the stream aggregate and, when it steps the
run, the execution aggregate, each with its own `fromSeq`), and the
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
execution aggregate is the only conversation and display is a fold of it
with redaction at the transport framer. A secret in a payload is on disk
for the C9 retention window, the owner's decision 6 in the substrate
proposal.

Resumability follows single-owner D8: "resumable" is "a `flow.snapshot`
exists and nobody alive holds the lease", independent of the outcome, so a
completed run can be continued; the fold is the same in every case, and
the viewer steps any run from the same rows.

Mid-run model switch: today `persistModelSwitch`
(`runToolUseFlow.ts:254`, called at `:330`) is a two-phase write, record
first and `config.json` second, and A's durability refuter showed it is a
mid-step durable commit that a private working copy loses. In the row
model a switch is one transaction that appends a `flow.snapshot` with the
new `modelId` and `modelHandlerCompatibilityKey` on the execution aggregate
and the existing `run.config` event on the stream aggregate. Resume order
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
`flow.snapshot` is the family state schema and gets the treatment the
importer gives `flow_<id>.json` today: one boundary migration per schema
version, nothing downstream branching on version.

### 2.2 Loops

```ts
// src/agent/runtime/loop/toolUse.ts (replaces runToolUseFlow.ts and the six tool-use nodes)
export const runToolUse = Effect.fn('toolUse.run')(function* (start: ToolUseStart) {
  const ledger = yield* RunLedger;     // append(row) -> Effect<RunState>; load(executionId)
  const run = yield* RunContext;       // executionId, streamId, modelCell, setting, logger, session
  const followUps = yield* FollowUps;  // ToolUseSessionLifecycle behind Effect.callback
  const model = yield* ModelInvoker;   // ModelInvocationNode's ladder as a service
  let s = yield* ledger.load(run.executionId);          // fold of rows, or null on a fresh run
  if (s === null) s = yield* prepareSession(start);     // was ToolUsePrepareNode
  for (;;) {
    s = yield* runTurn(s);                              // was RoundPrep -> Invoke -> Process -> Dispatch
    if (s.halt) return s.halt;                          // 'cancelled' | 'failed'
    if (run.isSubagent) { yield* ledger.append(step('waiting')); return 'waiting'; }
    const batch = yield* followUps.wait;                // Effect.callback, onInterrupt cancels the wait
    if (batch === null) return 'cancelled';
    s = yield* ledger.append(userMessages(batch));
  }
});
```

`runTurn` re-yields the services it needs (they are in Context, not
closures), drains queued follow-ups non-blockingly, calls `model.invoke`,
appends the assistant row, partitions tool calls into parallel-safe runs and
barriers as `ToolUseDispatchNode` does today, writes `tool.intent` for a
barrier from the post-approval hook, runs a parallel-safe group with
`Effect.forEach(..., { concurrency: MAX_PARALLEL_TOOL_CALLS })` and a typed
`TurnEnded` failure for the `endsToolUseTurn` short-circuit, appends one
`tool.result` per call, and ends with `flow.snapshot` + `flow.step turn.end`.

Follow-up batches are consumed under a lease, not on receipt. Today a batch
is acknowledged only after every item has landed in `messages`; an append
that fails (oversized or corrupt media in `addMediaToUserMessage`,
`followUpMessages.ts:100-104`) leaves it unacknowledged, and
`resumeQueuedToolUse` restores it to the queue on the next resume. The
sketch's `ledger.append(userMessages(batch))` keeps that: `FollowUps.wait`
and `drain` hand the batch to the loop under a lease that is released only
after the `model.message` rows commit; on append failure the batch returns
to the queue and `updateQueuedFollowUps` is re-emitted, and the same inject
is never re-run on the next resume.

The reflection loop is the same shape with one outer coordinate:

```ts
export const runReflection = Effect.fn('reflection.run')(function* (start) {
  ...
  for (let round = s.round; round < s.totalRounds; round++) {
    yield* Effect.scoped(Effect.gen(function* () {
      yield* Effect.acquireRelease(openStage(`r${round}`), (st, exit) => st.end(outcomeOf(exit)));
      s = yield* ledger.append(step('round.begin', round));
      s = yield* prepareContext(s);          // PrepareContext + TeXCount + MediaExtraction as functions
      for (;;) {                             // ResponseCycleFlow's continuation loop, flattened
        const r = yield* model.invoke(s);
        s = yield* ledger.append(assistant(r));
        const next = decideContinuation(s, r);   // 'end' | 'continue' | 'compact'
        if (next === 'end') break;
        if (next === 'compact') s = yield* ledger.append(compaction(r.updatedMessages));
      }
      const out = yield* produceOutput(s);   // OutputNode's body; output/ untouched
      s = yield* ledger.append(snapshot(s), step('round.end', round, out));
    }));
    if (!shouldContinue(s, out)) break;      // RoundPersistedFlow's decision as a pure function
  }
});
```

The response-cycle `complete` fan-in, the only non-trivial branch in the
repo, becomes `break`. Compile-repair state rides on `flow.snapshot`. The
raw output file keeps today's per-continuation append
(`ResponseCycleFlow.ts:321-337`): it is the mid-cycle checkpoint that
`initializeOutputAndPrefill` reads back on resume, prefills, and uses to
short-circuit the model call when the end tag is already present, and users
watch it grow. E's "write it from folded state at cycle end" was wrong and is
not adopted.

### 2.3 Fold, resume, and the viewer

`foldRunState(rows) -> RunState` is one pure, data-only function in
`src/shared`: start from the latest `flow.snapshot`, apply later
`model.compaction`, `model.message`, `tool.result`, and `flow.step` rows in
order. It runs in `RunLedger.load` on resume and in the trace viewer's
stepper, and nowhere else: there is no `run_state` summary, no projection
table, and no `executions` table (contract C10). The listing tier reads the
latest `flow.step` outcome through the `(aggregate_id, type, seq)` index, and
"resumable" means a `flow.snapshot` exists and no live owner holds the
lease (single-owner D8; the outcome does not enter into it). Because the
same function produces the
state the loop saw when it appended step `k`, "state at step k" and "resume
would continue after step k" are the same fact. This is the
replay-along-the-flow property, obtained without re-executing anything.

Ordering across aggregates: flow rows and trace rows live on different
aggregates, so per-aggregate `seq` is not a total order between them. Every
row also carries the database-wide `commit` value, exported under the same
name, and the scrubber keys on that. `StreamLogEntry.seqNo` is
renumbered on merge and is explicitly not foldable, so it is not the key.
What the viewer can show depends on what it reads: against the local
database of a resumable run, full state at step `k`; for an exported
document, coordinates, the tool-call graph, and display-redacted rows,
because every export applies C3's display redaction and never carries a
byte-exact row.

Resume: `runAgent({kind:'resume'})` acquires the lease first (as today at
`runAgent.ts:168` and `executeAgent.ts:648`), then `RunLedger.load`. The
resume rules live in the runtime, not the fold, and read only row data:
a barrier `tool.intent` without a matching `tool.result` is an explicit
outcome-unknown state, whether the tool ran, was mid-approval, or never
started; the loop appends a synthetic result naming it and surfaces an
`approval.requested` row (one-fold PRD §6 item 1) asking to re-run or skip,
never re-running a destructive call blindly and never fabricating CANCELLED
for a tool that may have run. Parallel-safe calls without results re-run. A
`waiting` step re-enters the follow-up wait; a subagent's per-cycle WAITING
resumes from the snapshot written just before it, so the fold is one
snapshot plus a handful of rows, not the whole aggregate. A fresh launch
onto a non-empty aggregate is refused (keeps #11313 semantics). The nine
preservation reasons in `runToolUseFlow.ts:606-685` are enumerated against
the row model in PR 2; the follow-up-queue versus record divergence
(`persistenceRecoveryPending`) is a separate decision there.

Unpaired tool calls: an assistant row whose `tool_use` blocks have no
paired `tool.result` rows is resolved per call on resume, so the model
never sees an unpaired `tool_use`: re-run if parallel-safe, outcome-unknown
as above if a `tool.intent` exists, and a synthetic cancelled result if
neither, which is the pairing `ToolUseDispatchNode.ts:527-543` enforces
today. Blank-continuation synthetic messages
(`ToolUseProcessNode.ts:208-275`) are ordinary `model.message` rows and
fold without special handling.

Manual retry across process death: `ModelInvoker`'s approval loop blocks
the fiber on `session.interactions.requestRetry`, and a death during the
prompt loses it. The prompt is therefore an `approval.requested` row
(one-fold PRD §6 item 1) and the decision an `approval.resolved` row, so a
resumed run re-asks from the row instead of re-firing the model call. It is
the same mechanism as the outcome-unknown barrier tool and lands with it
(§7 item 3).

### 2.4 Services and layers

`Context.Service` classes with static layers, `Data.TaggedError` errors, Zod
payloads, no Effect Schema. Per session root (inside the one-fold PRD 7.3
`LayerMap`): `Database`, `SessionEvents`, `RunLedger`. Per run, provided at
the Promise boundary in `executeAgent`: `RunContext`, `ModelInvoker`
(`ModelCell`, `ModelRetryGate`, the auto-retry batch as
`Effect.retry` with a `Schedule`, the manual approval loop, `prepareRetry`
rebind), `Tools` (overlay registry plus the `submit_output` terminal tool),
`FollowUps` (scoped lease over the follow-up queue, `wait` and `drain`).
`OutputPipeline` wraps the untouched `output/` directory for reflection.

Interruption: the host's stop is `Fiber.interrupt` delivered through
`runtime.runPromiseExit(program, { signal })`; model handlers and tools are
called through `Effect.tryPromise((signal) => ...)` so the fiber's signal
reaches the in-flight request. The append is the single uninterruptible
region: the loop body runs under `Effect.uninterruptibleMask((restore) =>
...)` with only the activity itself under `restore`, so a user stop cannot
lose a completed model response between completion and its row. Process
death in that window still re-runs the call, as today; the mask is a fiber
construct, not crash protection. The append runs inside the publisher's
`Semaphore(1)` and `BEGIN IMMEDIATE`, so stop latency is bounded by the
largest in-flight row on that session root; PR 2 must budget it or move the
payload write out of the seq-assignment critical section. `linkAbortSignals`,
`onAbort`, the startup-cancellation window, and `p-retry` in the runtime
delete, together with `RunScope.signal`; its two Promise-tier readers
(`executeAgent.ts:440`, `AgentRunLifecycle.ts:706`) move onto the fiber's
exit in the same PR rather than keeping the field alive for them.

Child dispatch: unchanged in shape. Native delegation and workflow-script
`agent()` re-enter `runAgent`; a child is its own aggregate; the parent's
`tool.result` for the delegation call is the launch acknowledgement for
detached children and the terminal result for in-band ones, exactly as
today. R4.6's single activity protocol (the script journal moving into the
event table, `persistence.ts` deleted) is PR 4 and is in scope.

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
`flow_<id>.json` directly into the execution's first `flow.snapshot` event
(whole `shared`, bytes unchanged, `modelHandlerCompatibilityKey` included)
and never writes any other shape. `persistedFlow.ts`, `src/agent/node/`,
and the three interpreters are deleted in the same branch, so no whole-state
rewrite survives the cutover and the amplifier is fixed in the release that
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

| Path | LoC | Replaced by |
|---|---|---|
| `src/agent/node/index.ts` | 158 | nothing |
| `src/agent/node/persistedFlow.ts` | 531 | `RunLedger` + `foldRunState` |
| `reflection/RoundPersistedFlow.ts` | 270 | round loop + `shouldContinue` |
| `reflection/ResponseCycleFlow.ts` (nodes and graph) | 593 | continuation loop |
| `reflection/nodes/*` as classes | 751 | functions; bodies move |
| `reflection/ReflectionFlowState.ts` latches | 68 | `flow.snapshot` |
| `tooluse/ToolUseRoundFlow.ts`, `nodes/*`, `toolUseRound/*` as classes | ~1,650 | `runToolUse`, dispatch functions; bodies move |
| `tooluse/runToolUseFlow.ts` graph rebuild, disposition ladder, attachment and startup-window code | ~500 of 719 | loop + scope finalizers |
| `core/flows/ModelInvocationNode.ts` | 846 | `ModelInvoker` (~500; the retry, gate, and credential logic does not shrink) |
| `core/flows/{FlowTransitions,CycleServices,BaseFlowServices}.ts` | 122 | Context services |
| `src/agent/storage/resumability.ts` full-checkpoint parse | 120 | latest-of-type index read (`flow.snapshot` present) plus the C5 liveness probe |
| `SessionResumeRetrieval.ts` checkpoint read | ~170 of 234 | fold; model id from the latest `flow.snapshot` |
| `runtime/persistedCompileRejection.ts` | 46 | snapshot field |
| Tests: `PocketFlowNode`, `PersistedFlow`, `ReflectionFlowStateRecovery` suites; 13 record-format pins reduced to importer fixtures | ~900 | fold test, ledger test, repair-policy test (~400) |

Rewired, not deleted (the refuters' missing list): `AgentLaunchContext.ts`
(compat key from snapshot row), `executionLifecycle.ts`,
`executionListing.ts`, `tools/executions/executionKvFiles.ts`,
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
   `flow_<id>.json` to `flow.snapshot` arm. Deletes `src/agent/node/`,
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
   scrubber over `foldRunState`, the `flow.transition` arm in the session
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
  C10; `flow.snapshot` is the one derived row, sanctioned by the contract
  under the byte-amortized rule. `foldRunState` runs on load and in the
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
  redaction at every transport framer and export). This document's
  "null on COMPLETED" and "removed at completion" were withdrawn because
  C1 forbids rewriting a row, single-owner D8 keeps completed runs
  continuable, and after the fold collapse these rows are the only
  conversation. Exposure is the C9 retention window.
- One-fold PRD line 102: reversed by the owner's ruling; its `fold(view,
  event)` gains the `flow.step` arm and its §6 durable set gains six rows.
- Single-owner §6: its single door at admission stays for the stream
  aggregate; for the execution aggregate the door is the transport framer
  and the export (C3, third owner); its "checkpoint content" list is false
  of the table, by design. Single-owner D8 is upheld and extended: nothing
  deletes a completed run's rows, not even completion.

## 7. Decisions requested from the owner

1. Ratify the shape (§2) and the sequencing (§3): the runtime is lane D of
   the cutover branch, with no interim column and no shim, accepting a
   larger branch in exchange for one revert point.
2. Retention of byte-exact conversation rows. Settled between the two
   documents that they are never scrubbed and never removed early; what
   remains is the substrate's decision 6, the C9 retention default. A
   shorter window for these rows than for the rest is not available once
   they are the only copy of the conversation, so decision 6 is one window.
3. Whether `approval.requested` / `approval.resolved` for outcome-unknown
   barrier tools and for the manual retry prompt (§2.3) land in PR 2 or
   wait for the one-fold PRD's approval events.
4. Confirm that the child-protocol unification (PR 4) is in scope, since
   leaving the script journal as a second ledger would be an intermediate.

## 8. Risks

- The `flow.snapshot` byte-amortized policy is the only bound on fold cost
  at resume; a bug there is the CLI-startup slowness class again. A
  load-time warning on rows-since-snapshot is required in PR 1.
- Anthropic image blocks and pasted attachments inline base64 in provider
  messages; one `model.message` row can be megabytes. Accept in N+1 (it is
  what the file holds today); route to the assets store later.
- Handlers that return `updatedMessages` on every call would write a
  compaction row per call; the prefix check in `RunLedger.append` must be
  exact.
- Effect rc churn: every name below is verified in rc.112; the next rc may
  rename. All uses sit behind the five service classes.
- Raw provider content lives in the database for the retention window (§7
  item 2). Any new reader of the `event` table that bypasses the fold is a
  redaction leak. Preferred: the `Database` layer exposes the four
  byte-exact row types only through `RunLedger`, so the raw query is
  unconstructible elsewhere and no test is needed. Otherwise the
  architecture test that fails persistence writes outside the database
  (substrate Stage 1) needs a sibling that fails raw reads of those rows
  outside `RunLedger` and the fold.
- A dedicated durability refutation of this text ran on 2026-09-04 and found
  two fatals and six majors in the first draft (the approval-hook intent row,
  the retention rule nulling display results, ten snapshot fields with no
  home, the reflection output file, fold cost without a message base point,
  cross-aggregate ordering in the viewer, the fold needing the registry, and
  the mutable event row in release N). All eight are corrected above. A
  second pass should run on the PR 2 design before it opens.

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
`ProviderMessage.ts:25-28`, substrate Stage 3/5 rows and §9 text, the seven
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
