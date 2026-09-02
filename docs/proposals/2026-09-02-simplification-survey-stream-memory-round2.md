# Simplification survey, round 2: transcript and session memory (2026-09-02)

> **Status:** survey + proposal. Grounded on branch
> `claude/texra-cli-heap-leak-ji9o1d` at `e271a04` (origin/main `646475d`
> plus the round-1 commits `a13b28b..e271a04`). Companion to
> `2026-09-02-stream-lifetime-and-cancellation-simplification.md` (round 1),
> which this round does not re-litigate. Three read-only sweeps — the CLI's
> per-stream transcript representations, the transcript persistence and delta
> model, the session-state projections and runtime per-key maps — each
> deduped against the five 2026-08 survey rounds, the 2026-08-10 memory
> investigation, and round 1; every load-bearing claim below was re-read
> first-hand and two sweep claims were corrected on that read (noted inline).

## 0. What round 2 asked

Round 1 established that the retained memory of a long `texra` session is
copies of facts without a lifecycle, and deleted the ones in the run and
stream-identity layers. Round 2 asks the same question one layer down, in
the three places round 1 named but left alone: what the CLI holds per
transcript entry, what the persistence model rewrites and retains, and what
the session-state projections copy from the registry and status machine.

The headline is smaller than round 1's, and it should be said plainly: for
one settled row of the focused stream, the CLI retains **one** copy of the
text (the `StreamLogEntry`) and **one** projected row object, shared by
reference through every downstream structure. The unbounded term is the
_element count_ of the focused stream (no budget anywhere on
`StreamLog.entries`, `fold.items`, or `slice.entries` while the stream is
focused), not duplicated payload. Everything else below is small: fields
with no readers, mirrors with one reader, a dead defense, and one
write-amplification defect on the persistence rail.

## 1. Settled surfaces honored (do not re-file)

- **`docs/prds/2026-08-16-sqlite-workspace-state.md` §1** names the
  whole-array rewrite of a transcript every 300 ms as the storage-engine
  defect and **supersedes** the JSONL journal prescription of
  `2026-08-23-single-owner-sessions.md` §6. No storage-engine or journal
  change is proposed here; §2.T1 is a bound inside the current model.
- **2026-08-10 memory investigation, Findings 2, 6, 7** shipped: the
  incremental fold (`subscribeStreamLog.ts:8-12`), the slice-local task-group
  memo (`cliState.ts:69-74`), and `StreamingTextAccumulator` (`StreamLog.ts:169-204`).
  Finding 3 shipped for the `<Static>` ring only; its fold/slice half is
  §2.C6 below, recorded as a shape, not a one-PR item.
- **`2026-08-26-simplification-survey-round3.md:2531`** deferred the
  `StreamSummaryMeta.executionId` residue ("even that should wait") and
  `:1792` records that retiring the summary tier (PR #10820) died with its
  parent migration, not on merit, and "will look dead again next round". It
  is not dead; nothing here touches it.
- **`2026-08-27-...-round5-deep-read.md:6401-6425`** proposed the loud
  transcript write failure; it shipped as the `writeFailureWarned` latch.
- **`2026-08-26-...-round2.md:3522-3530`** refuted the
  `AgentCliSessionRegistry` two-map dedupe; not re-filed.
- **`2026-08-26-...-round3.md:315-351`** wrote the migration for the
  `getAllStreamStates` round trip on the metadata-push path; it has **not**
  shipped (all three `SessionFactApplier` call sites still present at HEAD).
  Cited, not re-discovered.
- **Round 1 §2.B5, §2.F, §5:** the removal-transaction copies
  (`pendingDeletions`, `pendingStreamDeletions`, `streamDeletionClaims`,
  `RETIRED_STREAMS`) are recorded-not-filed; `registeredWithRenderer` and
  `WebviewBridge.streams` fold into §2.C of round 1, which is blocked on the
  store-surface ratchet ruling; the `_streamMetadataCache` /
  `_streamIncarnations` / `_removedStreams` split carries an in-code ruling
  (`SessionState.ts:92-100`) that round 1's B1 withdrawal honored.
- **`SessionState.ts:96-100`** rules `_streamMetadataCache` a separate map;
  its referential stability is what let the CLI drop deep-compare (U2/#10805).
- **`RETAINED_FINISHED_CHILDREN_CAP`** (`SessionFactApplier.ts:35`) is the
  sole owner of its bound; the CLI's copy was deleted in #10892.

## 2. Candidates

Each entry: the fact, its owners, the deletion, consumer counts, and the
element delta (files / exported symbols / declarations / LoC, estimated).

### 2.T Transcript persistence and delta model

**T1. Bound a running streaming entry on the persistence rail.**
`TexraTranscriptRecorder.flushStream` applies `boundedTranscriptPreview`
(50 KB / 2,000 lines, `:68-70`) only when the stream has ended (`:380-382`,
via `boundModelResponse`). While it runs, `:376` appends every delta to the
persisted entry unbounded, and `StreamLogStore.runWriteBatch` rewrites the
whole entries array of every dirty stream each 300 ms window
(`SAVE_MAX_WAIT_MS`, `:47`; `writeStream :1233` →
`toPersistedEntries :571`). A 500 KB response streaming for a minute is
rewritten in full on the order of 200 times for a final 50 KB row. The
delta rail already keeps chunks live-only (Finding 7's remediation); the
persistence rail does not. Fix inside the current model: `toPersistedEntries`
maps entries for which `isRunningStreamingTextEntry` holds (`StreamLog.ts:226`)
through the same head/tail preview before serialization, leaving the
in-memory entry and the live render untouched; a crash-time resume then
shows exactly what settlement would have persisted. The preview helper moves
from the recorder to `StreamLog` (one exported function, two callers).
Delta: +0 elements net (one function relocates), ~+10 LoC; the disk and
serialization traffic of every long streaming turn drops by the ratio of
its length to 50 KB. **New.**

**T2. One name for the entry count.** `StreamLog.seqCounter` (`:264`) is
`entries.length` by construction (the constructor comment at `:299-301`
states the invariant; both advance in the same statement at `:455-458`;
entries are never removed), and the class exposes it twice: `head` (`:335`,
returns `seqCounter`) and `size` (`:339`, returns `entries.length`). The
CLI reads both names for the same watermark (`transcript.ts:97` `head`,
`transcriptFold.ts:254,269` `size`, fed straight to `getRange`). Delete the
field and `size`; `head` returns `entries.length`; two reader edits.
Delta: −1 field, −1 getter, ~−8 LoC. **New.**

**T3. The `'failed'` flusher entry surfaces in the wrong place; throw at
dispose instead.** `createRunTrace`'s dispose parks a cleanup failure as
`{state:'failed'}` in the session's flusher map (`runTrace.ts:148-158`) for
a later `flush()` to throw. Both production dispose sites already run inside
failure-collecting cleanup: `childStream.ts:224-238` iterates a `cleanups`
array and aggregates every throw, and `AgentRunLifecycle.ts:827` is the last
statement of the run's `finally`, whose sibling steps follow the
collect-don't-mask rule the file states at `:805-816`. Meanwhile the
"successor inherits the failure" arm (`:107-120`) is unreachable in
production because the owner key is the execution id at every call site
(`AgentLaunchContext.ts:356-360`, `childStream.ts:99-104`) and execution
ids are never reused; its only exercise is `RunTraceDispose.vitest.ts:83-108`.
Worse, the parked entry is drained not only at session teardown but by the
CLI's transcript sync, which calls `flushPendingTraces()` on every tick
(`subscribeStreamLog.ts:277`): a trace-cleanup failure of a finished child
would surface as an exception inside the TUI's render path. Throw at
dispose (guarded with `collectFailure` at the lifecycle site), and
`RunTraceFlushEntry` collapses to `() => void`: −1 union type, −1 state
arm, −1 `pendingFailures` array, −1 successor branch, ~−35 LoC; the test
that pins the successor arm retires with the mechanism. **New.**
Cross-reference round 1 §5 E2 (withdrawn): the _artifact_ flusher's
deferred removal is deliberate and stays; this is the _trace_ flusher.

**T4. Two producers of the summary cache file.** `recordSummaryMeta`
(`StreamLogStore.ts:539-557`) enqueues its own
`summaryCache.maintainSummaryCache(streamId, {...current})` on the shared
write queue, guarded by a `dirtyIds.has` re-check, while `writeStream`
(`:1240-1247`) writes the same file with `toSummary(log) + meta` after every
transcript save. Two writers of one derived file coordinated by a guard
instead of an owner. The smaller fix: one private `writeSummary(streamId)`
that both call, so the payload shape has one author; the larger question
(whether a meta-only write earns its own path, given every transcript save
carries meta anyway) needs the crash-time-cache reasoning in the comment at
`:547-551` re-examined. Delta for the smaller fix: ~−6 LoC, one fewer place
that spells the summary payload. **New.**

**T5. Positional fidelity for rows nobody can read.** `preservedRawEntries`
(the #7464 loud-preserve of unparseable persisted rows) is a KEEP, and
`2026-08-16-overdefensive-top10.md` entry 1 (landed, #10799) narrows the
schema they fail against, so the path grows, not expires. What does not
earn its place is `toPersistedEntries`' interleave (`StreamLog.ts:574-595`):
a `Map<number, unknown[]>` bucketed by `beforeTypedIndex` plus a
`length + 1` merge loop, preserving the _position_ of rows whose content is
uninterpretable, against a typed array the constructor has already
**renumbered** (`:298-306`). Appending them after the typed rows round-trips
the same bytes. Delta: −1 field on the preserved-entry type, −1 map,
~−20 LoC; the persisted order of unparseable rows changes, which no reader
can observe. **New.**

**T6. Sweep `stageMetadata` at the transcript boundary.** `handleStatus`'s
boundary sweep (`TexraTranscriptRecorder.ts:852-869`) drains `streams` and
`activeToolEntries` and documents skipping `workflowCallEntries`
(`:848-852`), but says nothing about `stageMetadata` (`:327`), which is
deleted only on `stage.end` (`:477`): a cancelled or crashed stage keeps its
metadata for the recorder's life. One line in the sweep. (The sweep's claim
that `spillQueues` also leaks was wrong: `runOnPerKeyQueue` deletes idle
queues, `src/utils/core/perKeyQueue.ts:41-45`.) Delta: +1 line. **New.**

**T7. The CLI accumulates text chunks it discards.** The
value-supersedes-chunks precedence is implemented three times —
`drainEmission` (`StreamLog.ts:396-400`), `StreamLogDeltaBuffer.push`
(`:112-122`), and the fold site (`subscribeStreamLog.ts:355-390`), which
resolves every chunk id back to `log.getById` and takes the current entry
value. So the CLI's `PENDING_DELTAS` buffer retains every streamed chunk
between sync ticks only to drop them; the one consumer that transmits
chunks is `WebviewBridge.ts:161`, where the log is across a `postMessage`
boundary. Give the buffer a chunk-free mode for consumers that hold the log
(record the dirtied id, not the text), or split the id-only buffer out.
Delta: −1 map per CLI buffer, less retained streaming text between ticks;
+1 option. Medium; measure the retained bytes on a long response before
filing the PR. **New.**

**Recorded, not filed.** The three `running*Count` caches
(`StreamLog.ts:284-286`) have one reader each through `refreshSummary`, and
a full-scan twin in `summarizeEntries` (`StreamSummaryCacheStore.ts:300-312`);
they are defensible on the append hot path and should be measured, not
deleted. The three nested throttles (recorder 50 ms, store 300 ms, CLI
sync) repeat one "throttle, not debounce" idiom on `createFlushableDebounce`;
consolidating it adds a mode, so it waits for a fourth copy.
`endRunningEntriesInLoadedLogs` passes `getRange`'s default as an argument
(`StreamLogStore.ts:1047`); batch with T2.

### 2.C CLI transcript state

**C1. `StreamSlice.streamId` has no reader.** Written by `emptySlice`
(`cliState.ts:210`) only; the one apparent reader (`statusBarDisplay.ts:863`)
reads the map key returned by `nearestActiveStreamAncestor`, not the field.
Test fixtures spread it. Delete the field and `emptySlice`'s parameter.
Delta: −1 field, −1 parameter. **New.**

**C2. `fold.lastEntriesOutput` is subsumed by the change flags.** Set to
the same reference the slice stores (`subscribeStreamLog.ts:479` vs `:499`),
read once (`:452`) to detect an out-of-band `slice.entries` patch. The only
out-of-band writers (`transcript.ts:100-111`, `:144-149`) change the local
row set, which `reconcileSynthetics` already turns into
`itemsChanged`/`compactAffected`/`syntheticsChanged` (`transcriptFold.ts:617-622`),
covering all three output branches. `lastOutputFull` stays (mode flips are
not flagged). Delta: −1 field, −1 comparison, −2 writes. **New.** Verify
with the fold suites; the equivalence rests on the writer census above.

**C3. `TranscriptFoldItem.block` duplicates `rendered.block`.**
`compactionActivityRow` puts the block on the row
(`transcriptRow.ts:389-397`) and `transcriptRowForPaint` returns
compaction rows unchanged (`transcriptFold.ts:136-138`), so the guard at
`:584` can compare `rendered.block`. Delta: −1 optional field on every fold
item, −2 writes. **New.**

**C4. `StreamSlice.bypass` mirrors the runtime's bypass state.** One writer
(`setTuiApprovalBypassState`, `subscribeApprovals.ts:552-562`, fed by the
host hook), two readers (`StatusBar.tsx:303`, `sessionCommands.ts:172`).
The owner is `StreamApprovalBypass.isBypassed` (`streamApprovalQueue.ts`),
which the controllers read directly (`progressStreamControls.ts:37`).
Reading it at paint deletes the field, `BypassState`, `NO_BYPASS`, and the
value copy; the host hook shrinks to a repaint signal (a revision bump),
which is the one thing paint cannot derive. Delta: −1 field, −1 type,
−1 constant; +0 (the hook stays, its payload goes). **New.**

**C5. `styledLinesCache`'s inner map has no cap.** `toolRenderers.tsx:425-445`
keys a `Map` by `elide|compactOutput|width|headerPreview` inside a `WeakMap`
per tool row; a resize storm adds one entry per width per live row. The
identical cache for `transcriptToLines` became a single-slot memo in #11546
(`2026-08-28-simplification-survey-cli.md:99-101`). Same fix. Delta: −1
inner map, ~−10 LoC. **New for tool rows.**

**C6. No budget on the focused stream (shape only).** The `<Static>` ring is
bounded (`DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS`), compacted workflow
projections are bounded (`MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES`),
released streams are dropped; the focused stream's `StreamLog.entries`,
`fold.items`, and `slice.entries` grow one element per projected entry for
the session, and `releaseInactiveStreamTranscript` refuses the focused
stream by design (`subscribeStreamLog.ts:535-541`). Rows below
`finalizedFrontier` are already in terminal scrollback and can never be
un-printed (`cliState.ts:185-188`). The cheapest shape is a dropped-prefix
origin offset on the fold, an id-keyed (not index-keyed)
`StaticTranscriptScanCursor` (`transcriptEntries.ts:346-359`), and the
Ctrl-T reader reading from `StreamLogStore` under a presentation lease
instead of the slice (`TranscriptReader.tsx:79,168`). Eleven `slice.entries`
consumers and seven `fold.items` consumers were classified: only the scan
cursor, the reader, `compactWorkflowEntries`, and the release-time
`issuedWorkflowPlanTaskIds` need the whole history. This is Finding 3's
unshipped half and the only term in this round that scales with session
length; it is a design change with a wire-adjacent cursor, not a deletion,
and is recorded so the next person does not re-derive the consumer list.

### 2.S Session projections and runtime maps

**S1. Resume the half-shipped roster row: delete `ActiveChildInfo.status`
and `recordChildPhase`.** `2026-08-03-ssot-consolidation-plan.md:352`
proposed deleting the roster's cached `status` and `elapsed`, shipping
`childStreamId` and `startedAt`, and letting renderers join the status
machine. `elapsed` went and the two ids arrived; `status` stayed, and with
it `recordChildPhase` (`SessionState.ts:416-440`, an O(streams × roster)
scan of every ephemeral entry on **every** status fact, called at
`SessionFactApplier.ts:849`), the regression guard (`:763-771`), and the
extra roster push (`:885`). The schema itself declares the field
display-only and allowed to lag (`streamState.ts:36-51`). Every in-process
consumer holds `childStreamId` and the status machine keeps an entry for
every finished, undeleted stream (round 1 §2.B, table row 16), so the join
is a map lookup; the webview already receives the per-stream phase map on
`onStreamMetadataChanged` (`SessionFactApplier.ts:683,705,934`). Delta:
−1 method, −1 schema field, −1 guard, −1 notify path, ~−45 LoC in `src`,
~+5 in the webview join. **Prior, unfinished — resume, do not re-discover.**

**S2. `StreamStatusMachine.holds` is a third entry kind wearing a second
map.** `holds` (`StreamStatusService.ts:78`) has two writers, both at
startup (`restartRepair.ts:240`, `SessionHandle.ts:431`), one clearer
(`restartRepair.ts:277`), and one reader (`LitSessionRenderer.ts:429`); a
hold means "this stream has no phase in this process, and here is why",
which is exactly the shape the same file forbids as a second structure:
`:47-50` — "A reservation is **not** a second structure overlaying the
phase: it is the entry itself … so every reader sees the same state without
merging two collections." A `{ kind: 'hold'; detail }` arm on `StreamEntry`
makes `effectiveState` return `undefined`, makes `transition`'s overwrite
the clear (deleting `:208`), and makes `clearStream`/`clearAll` one line.
Verify first that a held stream never also carries a phase entry
(`markUnavailable` is guarded by the generation check at
`SessionHandle.ts:426-430` and the hold comment says held streams carry no
phase; confirm against `markUnfinishedStreamsRunning`). Delta: −1 map,
−2 delete calls, +1 union arm, ~−8 LoC. **New.**

**S3. A dead defense and a duplicated scan in the registry.** The
"backstop against listener leaks" (`executionRegistry.ts:813-817`) protects
against a persistent listener on an untracked execution, which the only
caller of the private `addListener` — `waitForAnyChange`, two production
consumers in `ExecutionsTool.ts:273,287` — structurally cannot leave behind
(its own doc says so, `:654-656`). And the status subscription
(`:188-200`) hand-rolls the first-match scan that `getAgentHandleByStream`
(`:386-395`) already is. Delta: ~−8 LoC combined, −1 conditional. **New.**

**S4. Desktop re-claim gate drift (observation).**
`desktopProcessStores.ts:20-32` re-implements `claimStreamIdentity`'s
admission conditions (`removeStream` pending, workflow identity, live handle
by stream) condition-for-condition beside `SessionFactApplier.ts:281-296`,
in a process that cannot reach `SessionState`. Round 1 ruled the map
cross-process and staying; the _expression_ duplication is a two-writer
hazard nobody has named: if the applier's gate changes, the desktop copy
diverges silently. Record; the fix is a shared predicate over the facts both
sides hold, which is a design call for the single-owner-sessions work.

**Recorded, not filed.** `ExecutionInteractionOwnership.liveExecutions`
(`:115`) is the last copy of "which executions are live" beside the
registry, but its untrack arm needs the execution → stream edge after the
handle is gone; replacing it with a scan of `streamOwners` is a map traded
for a cold-path scan, not a deletion. `StreamStatusMachine.clearAll` has no
production caller (test reset only); round 1 withdrew E3 on the same shape.
`ModelRetryGate.routes` creates an entry per healthy route (`:231`), bounded
by routes actually used, and lazy-create-on-failure is unsafe as written
(`markRouteFailure` returns early on a missing state, `:245`).
`rosterParentsContaining`/`scrubStreamFromRosters` (`SessionState.ts:560-587`)
are one iteration with two bodies; ~−10 LoC if S1 does not already dissolve
them. `UsageMonitor`, `BackgroundPoller`, `fileInteractions`,
`ToolFileInteractionContext`, and `StreamSubscriptionRegistry` hold no
session-lifetime per-key map; nothing to file.

## 3. Order of work

1. **T2 + C1 + C3 + S3 + T6** — mechanical, zero behavior change, one PR
   with the R6 element table.
2. **T3** — the trace flusher union; ships with the `collectFailure` guard at
   `AgentRunLifecycle.ts:827` and retires `RunTraceDispose.vitest.ts`'s
   successor-arm test with the arm.
3. **C2 + C5** — CLI fold and cache; the fold suites are the acceptance.
4. **T1** — the persistence bound; acceptance is a test that a running
   streaming entry serializes at the preview size while the in-memory entry
   keeps the full text.
5. **S2 + T5 + T4 (small form) + C4** — each with the one verification named
   in its entry.
6. **S1** — resume the 2026-08-03 row; touches the wire schema and the
   webview join, so it is its own PR.
7. **T7 and C6** — measure first (retained chunk bytes on a long response;
   retained rows of a multi-hour focused stream), then design.

Every step deletes a copy or a dead branch; the only additions are one
union arm (S2), one relocated function (T1), and one repaint signal (C4).

## 4. Verified

Opened first-hand at `e271a04`: `TexraTranscriptRecorder.ts:258-280,338-384`;
`StreamLog.ts:296-342,560-600`; `StreamLogStore.ts:536-560,1226-1252`;
`runTrace.ts` (full); `AgentRunLifecycle.ts:820-832`;
`childStream.ts:224-238`; `SessionHandle.ts:424-434,491-506,557`;
`subscribeStreamLog.ts:277,448-482`; `transcriptFold.ts:132-140,578-596,610-626`;
`cliState.ts:205-214`; `subscribeApprovals.ts:552-566`;
`StreamStatusService.ts:28-82,270-312`; `restartRepair.ts:225-245`;
`executionRegistry.ts:184-202,384-396,806-820`;
`executionInteractionOwnership.ts:50-62,110-205`;
`docs/proposals/2026-08-03-ssot-consolidation-plan.md:345-360`;
`docs/proposals/2026-08-28-simplification-survey-cli.md` (full);
`src/utils/core/perKeyQueue.ts:31-46`. Grep counts for readers and writers
were re-run for C1, C2, C3, C4, S2, S3, and T2.
