---
created: 2026-09-25
status: proposed
---

# Fold session events straight to rows

Baseline: `origin/main` at `ccd6d71a88`. Owner goals this serves: one state
system every UI renders, one source of truth, no dual systems, and the
deepseek-harness rule that the log is the only truth and everything else is a
fold of it. The fold stays pure; Effect stays at the readers.

## Problem

Between the session event table and the `TranscriptRow` every host paints sits
one more vocabulary, `StreamLogEntry` (`src/shared/schemas/streamLogEntry.ts`,
160 L): a flat `{type, messageType, data, text, seqNo, settlementSeqNo}`
record. It is never persisted. It exists only because the transcript fold was
written against the old stream-log files and kept that shape when the files
were retired (one-fold PRD, section 5.2 "Legacy": the importer turned old
entries into events and no `legacy.entry` kind exists).

The path today, per committed row:

1. `applyTraceRow` (`src/shared/session/traceFold.ts:468`) hands a typed
   `TranscriptEvent` to `createTranscriptFold` (`traceFold.ts:62`, 500 L).
   Its switch (`:99` to `:401`) flattens each arm into an entry through a
   mutable writer.
2. That writer is the `StreamLog` class (`src/shared/session/traceEntries.ts`,
   188 L), which assigns `seqNo`/`settlementSeqNo`, keeps appended and dirtied
   buffers, and builds every entry with `as StreamLogEntry` (`:124`, `:175`).
   The typed `data` is a cast, not a parse: `StreamLogEntrySchema` is parsed
   only in tests and sits in `config/ratchets/knip-baseline.json` as
   `production-dead`.
3. `sessionFold.foldTraceEvent` (`src/shared/session/sessionFold.ts:1770`)
   drains the buffers and runs `applyEntry` (`:1029`) per entry, which feeds
   four re-projections: `projectTranscriptRow`
   (`src/ui/transcript/projectTranscriptRow.ts:279`, 526 L, one production
   caller), `upsertTaskGroupFromStreamLog`
   (`src/shared/runs/taskGroupProjection.ts:80`),
   `applyCompactionActivityEntry`
   (`src/shared/runs/compactionActivityProjection.ts:79`) and
   `workflowMarkerOf` (`src/shared/runs/workflowRunModel.ts:81`).

Because step 2 never validated `data`, step 3 re-derives what step 1 knew:

- `workflow.plan` is a schema-validated event. `traceFold.ts:242` rewrites it
  as an `INTERNAL` entry with `data: unknown`; `workflowMarkerOf` re-parses it
  with `WorkflowPlanMarkerSchema.safeParse` and carries a `malformedPlan`
  branch for a shape the event schema already rejects.
- `tool.end` is parsed with `ToolUseLogSchema` at `traceFold.ts:206`, then
  `normalizeToolUseForRender` (`src/shared/toolUse.ts:180`) parses the same
  payload again at render. `withToolOutput` (`sessionFold.ts:976`) casts a
  third copy to splice live output back in.
- `skills.snapshot` is re-parsed (`traceFold.ts:295`) into an `ACTIVE_SKILLS`
  entry that no row renders; its one reader is the CLI status line
  (`packages/cli/src/chat/tui/commands/handlers/sessionCommands.ts:71`).
- `context.state` becomes a `CONTEXT_STATE` entry (`traceFold.ts:321`) that
  nothing reads: `projectTranscriptRow.ts:516` drops it, and `sessionFold.ts:1413`
  already folds the event itself into `RunView.context`.
- `latexdiff` domain data is reparsed at render by `parseDiffResultEntries`.

The same fold also runs a second time in one process. `StreamLogStore`
(`src/transcript/StreamLogStore.ts`, 267 L) builds its own `StreamLog` plus
`createTranscriptFold` per resident run (`:78`, `:242`) beside the one inside
the session view. It is already "a cache of the view" (#12944), and it has
exactly five production readers, none of which renders:

| Reader                                                                                                 | Reads                                 | What it actually needs                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------- |
| `SessionHandle.streamClosureFacts` (`SessionHandle.ts:649`)                                            | `transcripts.get`, running text       | open stream ids and their last text                 |
| CLI `activeSkillNamesFor` (`sessionCommands.ts:71`)                                                    | `transcripts.get`, last skills        | the newest `skills.snapshot`                        |
| host-exit settlement (`SessionHandle.ts:1292`)                                                         | `readEntries`, open groups/text/calls | open stages, streams, workflow calls                |
| `/executions/{id}/output` (`src/tools/ExecutionsTool.ts:699`, `src/tools/executions/processOutput.ts`) | `readEntries`, default logs           | the run's `log` rows and their source tag           |
| completed-run export (`src/transcript/completedRunArchive.ts:167`)                                     | `readEntries`, conversation kinds     | user, assistant, thinking, tool, web-search content |

Everything else that renders already reads `SessionView`: the progress view,
desktop and CLI TUI through the frames, headless `texra run` and NDJSON through
`packages/cli/src/runtime/runProgressRenderer.ts` and `sessionViewFollow.ts`,
and the trace viewer through `sessionFrames`/`hostSnapshot`. Trace export ships
the aggregate's display events (`src/transcript/traceAssembler.ts:81`), not
entries. `packages/agent`, `packages/trace-viewer`, `packages/desktop/src`,
`packages/extension/src` and `packages/llm` have zero references.

Measured footprint: 13 production files reference `StreamLogEntry` or its
helpers (the table above plus `taskGroup.ts`, `transcriptRow.ts`, the three
`src/shared/runs/` projections and the dev script
`packages/cli/scripts/tui-harness.tsx`), and 24 test files under
`src/test-kernel/` build entries or a `StreamLog` directly.

## Target shape

One pure reducer per run transcript, in `src/shared/session/`, owned by the
session fold: `TranscriptEvent -> TranscriptView` (rows, task groups,
compaction blocks, run-model inputs) plus fold-private indexes. Each event arm
writes the value it means:

- `stage.start`/`stage.end` upsert the task group, or the `phase` row, directly.
  Whether run/round/session headings go to task groups stays one boolean per
  run, decided from the identity (`lifecycleToTaskGroups`, `sessionFold.ts:1003`).
- `tool.start`/`tool.end` build the `ToolRow` from one `ToolUseLogSchema` parse;
  live output from `inflight` is joined when the row is built, not by patching
  an entry.
- `stream.*` and `response.finalized` write the streaming text rows; the
  inflight join in `applyEntry` moves into these arms unchanged.
- `workflow.plan` sets the plan index from the typed event. No marker entry.
- `workflow.call`, `usage`, `domain` build their rows from typed fields.
- `log` is the one arm whose payload is still `data: unknown` with a free
  `messageType` string in the durable row (`src/shared/schemas/traceEvent.ts`).
  The per-type payload table in `streamLogEntry.ts:33` survives as that arm's
  boundary decoder: decode once with `safeParse`, and a payload that fails
  becomes a visible error row with the diagnostic (the policy
  `malformedToolUseFallback` already applies to tools). This is the first
  place those payloads are validated at all.
- `skills.snapshot` folds into a `RunView` field; `context.state` already does.

Row ordering stays a fold output: `seqNo` is the row's first-appearance ordinal
and `settlementSeqNo` the settlement counter, held in the fold's indexes instead
of a `StreamLog`. Both are display-only and compared only for order
(`packages/cli/src/chat/tui/state/transcript.ts:36`,
`packages/cli/src/chat/tui/panes/transcriptEntries.ts:186`).

The fold exports one cold entry for a single aggregate,
`foldRunTranscript(events, debug)`, used where no session view is resident.
The same reducer serves live and cold; there is no second instance.

No type replaces `StreamLogEntry`. Where a consumer needs a flat log:

- export reads `TranscriptRow[]` from `foldRunTranscript`. Two rows gain the
  fields export needs and a renderer can use: `UserRow.attachments` and
  `WebSearchRow.query`. `ToolRow` keeps the decoded `ToolUseLog` it was built
  from, so `toolResultText` keeps its own formatter.
- `/executions/{id}/output` reads the run's durable `log` rows from
  `readEvents` directly: process output needs no correlation, so it folds the
  log itself.
- open-work questions (host exit, parked-run closure) read an `openWork`
  accessor on the fold state: open stage ids, open stream ids with last text,
  nonterminal workflow calls. The fold already tracks the first two
  (`traceFold.ts:66-72`) and the third is one set it already keeps.

## Staged PRs

Each lands alone and keeps rows byte-identical except where stated.

**S1. Readers that never needed entries** (about -70). `processOutput` takes
`log` events from `readEvents`; `skills.snapshot` folds into `RunView` and the
CLI status line reads it; `streamClosureFacts` reads the resident view's open
streams; the dead `CONTEXT_STATE` and `ACTIVE_SKILLS` outputs of `traceFold`
go. `StreamLogStore.get` loses its last caller and is deleted.

**S2. Side projections take events** (about -120). In `foldTraceEvent`, task
groups fold from `stage.start`/`stage.end`, the plan from `workflow.plan`, and
compaction from decoded `log` payloads. `workflowMarkerOf`, its malformed-plan
branch, the `INTERNAL` plan entry and `isTaskGroupLifecycleEntry` are deleted.

**S3. Rows straight from events** (about -500). `traceFold.ts` and the switch in
`projectTranscriptRow.ts` merge into the one reducer; the row builders move
with it. Deleted: `StreamLog` and `traceEntries.ts`, the `StreamLogEntry`
union and its knip entry, `applyEntry`/`projectRow`/`withToolOutput`/
`isRunningToolEntry` and the drain loop in `sessionFold.ts`, the second
`normalizeToolUseForRender` parse. `STREAM_LOG_ENTRY_TYPES` goes with the
last group entry. Tests that built entries rebuild through events with
`src/test-kernel/support/sessionTestUtils.ts`; `StreamLog.vitest.ts` is
deleted.

**S4. Cold reads through the same fold; the cache retires** (about -250).
Export and host-exit settlement call `foldRunTranscript(readEvents(...))`.
With no reader left, `StreamLogStore`'s cache, residency leases and
`acceptCommitted` delete, along with the lease calls in
`src/tools/delegation/childRun.ts`, `src/agent/runtime/AgentLaunchContext.ts`
and `packages/cli/src/chat/chatSessionController.ts:794`. `readEvents` moves
beside `Database.readAggregate`. The `StreamLogStore` list in
`config/ratchets/store-public-surface-baseline.json` shrinks to nothing in the
same PR (a shrink, never a widening). `StreamLogStoreLoad.vitest.ts` goes.
Landed ahead of S3 (cache half): `StreamLogStore.ts` is deleted outright.
`readEvents` is `SessionHandle.readRunEvents`, beside `readAggregate`; the
cold entry fold is `readRunEntries` (`src/transcript/runEntries.ts`) until
S3's `foldRunTranscript` replaces it. With the leases gone, `createRunTrace`
wrapped nothing and went too, as did the child-run `autoClose` option, whose
only effect was the eviction. The store-public-surface ratchet and its
baseline are deleted with the class they budgeted.

S1 and S2 are independent. S3 needs S2 (the side projections must not still
want entries). S4 needs S3 (`foldRunTranscript` and `openWork` exist). Net
production change about -940 lines across the four, before test deletions.

## Risks

- **Persisted formats: none change.** No event schema, no
  `SESSION_EVENT_FORMAT` bump, no store migration. `MESSAGE_TYPES` stays: it is
  the persisted discriminator of the `log` row. The chat-export `ExportNode`
  shape, the trace document and the result JSON `texra-action` consumes are
  unchanged.
- **Headless parity.** Headless and NDJSON already read rows from
  `SessionView`, so parity reduces to row equality. `seqNo` values shift where
  entries that never became rows used to occupy a number (plan markers, skills,
  context state); relative order is unchanged and nothing persists them.
- **Compaction interruption.** `interruptRunningBlocks`
  (`compactionActivityProjection.ts:61`) compares the entry's `seqNo`, and a
  dirtied tool entry carries its start position. S2 must compare the tool
  row's first-seen position, not the `tool.end` event's seq, or a tool that
  started before a compaction and ended after it would newly interrupt it.
- **Log payload validation is new.** Decoding `log` payloads once may surface
  rows that today render through a cast. A failure becomes a loud error row,
  never a silent drop; count them in the replay check before S3 merges.
- **View residency for closure.** S1's `streamClosureFacts` switch assumes the
  view folds every run the loop parks. If a parked run's aggregate is not
  folded in the view, S1 reads it through `readEvents` and the cold fold
  instead (then it moves to S4).
  Checked in S1: it does not. The view folds a run's transcript tier only
  while some port subscribes it (`foldSubscriptions`), and a headless or
  child run parks unsubscribed, so S1 took the alternative
  (`readEntries`, the cold fold over the run's committed rows). The same
  holds for `skills.snapshot`: it is no listing row, so a `RunView` field
  would be filled only for subscribed runs, and making it one would add every
  run's snapshot to each listing read. The CLI status line reads the newest
  row through `readEvents` instead. After S1 the store's cache has no reader,
  so S4's cache deletion no longer waits on S3.
- **`sessionFold.ts` is 1 932 L**, over the file-size budget. S3 lands the
  reducer in its own file so `sessionFold.ts` shrinks; it must not grow.

## What stays and why

- `TranscriptRow` and its builders: the one value all three hosts render.
- `MESSAGE_TYPES` and the per-type payload schemas: the durable `log` row's
  vocabulary, now decoded at one boundary instead of cast.
- The task-group, compaction and run-model logic: correct, only retargeted
  from entries to events.
- The `debug` fold input (#13005): unchanged, still a parameter, never a row.
- Effect at the readers only: `Database.readAggregate`, `readEvents` and the
  session tail. The reducer takes no service and returns no Effect.

## Acceptance

- `rg StreamLogEntry src packages` returns nothing; `traceEntries.ts`,
  `streamLogEntry.ts` and `StreamLogStore.ts` are gone.
- One transcript reducer instance per run per process.
- Replay equivalence, run once per stage as a scratch script, not a committed
  test: over local session databases, every run's rows, task groups and run
  model deep-equal the pre-change fold after normalizing `seqNo` to order.
- `completedRunArchive.vitest.ts` and the `/executions` output suites pass
  unchanged in expectation; `validate-tui` scenarios match the clean-main local
  baseline; `npm run test:pure` passes (architecture and ratchets).
- `check:dead-code-ratchet` shrinks the knip baseline by the `StreamLogEntrySchema`
  entry; no baseline widens.

## Prior rulings

- [One fold, three renderers](../../implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md):
  hosts render one `SessionView`; old entries were imported as events, with no
  `legacy.entry` kind. This proposal removes the last entry-shaped step inside
  that fold.
- [Single-owner liveness and one fold](../../implemented/architecture/2026-09-20-single-owner-liveness-and-one-fold.md),
  step 5: `StreamLogStore` becomes a cache of the view (landed, #12944). S4
  finishes it: a cache with no reader is deleted.
- [Effect-native runtime system design](./2026-09-10-effect-native-runtime-system-design.md):
  "the view replaces `StreamLogStore`" and one fold per question.
- [Session systems survey](../simplification/2026-09-09-session-systems-survey.md):
  measured the two `createTranscriptFold` copies per resident run.
- [Synchronous facades](./2026-09-21-effect-design-synchronous-facades.md):
  transcript verbosity is a fold input; preserved.
- `config/ratchets/refuted-candidates.json` has no entry for `StreamLogEntry`,
  `traceFold` or `projectTranscriptRow`; nothing here reopens a refused refactor.
