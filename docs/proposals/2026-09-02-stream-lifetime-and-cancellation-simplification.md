# Stream lifetime and cancellation: one owner per fact (2026-09-02)

> **Status:** survey + proposal. Grounded on branch
> `claude/texra-cli-heap-leak-ji9o1d` at `a13b28b` (origin/main `646475d`
> plus the per-subagent signal-retention fix). Every claim carries a
> `path:line` at that revision; re-open before acting. Produced by three
> read-only evidence sweeps (stream-identity owners, approval and child
> lifetimes, cancellation channels) with the load-bearing claims re-read
> first-hand.

## 0. Why this survey exists

A multi-day `texra` orchestration with many subagents died at V8's ~4 GB
old-space ceiling with 3.9 GB still live after a full mark-compact. The
narrow fix landed first (`a13b28b`): every subagent run, launch, and tool
request derived its cancellation signal with `AbortSignal.any` from the
parent run's signal, and Node keeps such a composite — and every abort
listener still attached to it — reachable from its sources until the
composite aborts, which for a finished child never happens. Measured on
Node 22.22.2: ~9 KB retained per composite carrying one listener, 0 bytes
once the link is detached. `linkAbortSignals` (`src/utils/core/index.ts:189`)
replaced the composites.

That fix is a symptom-level repair. What the sweeps found underneath is not
"leaks" in the sense of forgotten `delete` calls. It is that the same fact
is held by several owners, and only one of them has a lifecycle:

- "this stream is resident / released / removed" is encoded **eleven** ways
  across three planes (§2.B);
- the parent→child stream edge exists in **five** places, four of them on
  one fact rail and one (`parentOf`) off it (§2.D);
- "the user asked this run to stop" fans out through **four** controllers and
  a signal→handle→signal loop that aborts the controller that owns the
  signal it was attached to (§2.A);
- a finished child stream keeps its snapshot record forever because the
  store's only non-deletion eviction path has no production caller left
  (§2.C).

Each copy without a lifecycle is a place where memory accumulates and where
the next refactor has to remember a second write. The proposals below are
deletions of copies, not additions of managers. Where a candidate would net
new elements it is marked rejected.

The 2026-08-10 memory investigation
(`docs/dev/audits/2026-08-10-long-lived-session-memory-investigation.md`)
is the prior record. Its Finding 1 (all historical sidecars hydrated at
startup) landed as the bounded startup seed (#9947,
`SessionHandle.ts:302-317`); Findings 5 and 6 landed with the shared
applier's terminal eviction (`SessionFactApplier.ts:872-874`) and the
per-slice fold. Finding 4 (no residency budget) is still true and is the
context for §2.C, which this proposal treats as an ownership gap rather than
a budget to add.

## 1. Settled surfaces honored (do not re-file)

- **#9947** bounded the startup seed. Not re-proposed; §2.C is about steady
  state, which #9947 explicitly left lazy-but-never-released.
- **#11456** collapsed three per-kind ancestry maps into one `parentOf`
  (`streamApprovalQueue.ts:232-236`) and **round 4B** folded
  `clearForStream` into `forgetStreamAncestry` (`:324`). Both shipped; §2.D
  starts from that shape.
- **#10805** made `SessionState._removedStreams` the single owner of the
  removal rejection and ruled it deliberately uncapped
  (`SessionState.ts:144-160`). §2.B.1 keeps it uncapped and merges its
  sibling into it; it does not reintroduce an eviction policy.
- **`docs/design/2026-08-01-execution-interaction-ownership.md`** names
  `AgentExecutionHandle.parentStreamId` as the lineage the runtime owns.
  §2.D takes that as the authority claim.
- **`docs/proposals/2026-08-15-lifecycle-ownership.md` §2** rules
  "AbortSignal as the only cancellation channel" with the `onAbort` bridge
  as the sanctioned signal→disposer adapter. Its recommendation of
  `AbortSignal.any` for mechanical upgrades is superseded by
  `linkAbortSignals` (reason recorded at `src/utils/core/index.ts:189-201`);
  that supersession strengthens §2, it does not weaken it. The same doc
  settled `DisposableStore` as the house idiom; §3 records why a `remove()`
  is not proposed.
- **`docs/prds/2026-08-03-prd-approval-policy-unification.md` §6** fences
  `streamApprovalQueue.ts` as a non-goal of that migration. The round 3
  verifier already ruled this a scope fence, not a design rationale; §2.D
  cites it and does not treat it as a KEEP.
- **`docs/prds/2026-08-26-effect-4-runtime-migration.md`** proposes Effect
  scopes as a future replacement for `DisposableStore`. Nothing below adds
  to that store.

## 2. Candidates

Each entry states the fact, its owners, the deletion, consumer counts, and
the element delta (files / exported symbols / declarations / LoC, estimated).

### 2.A Cancellation: one signal, no loop

**Chain as written, root tool-use run.** Stop →
`chatSessionController.ts:880` → `stopAgentStream` (`executionRegistry.ts:610`)
→ `terminate` (`:763`) → `handle.interrupt()` (`ExecutionHandle.ts:276`) →
`runInterruptHandler` (`AgentRunLifecycle.ts:509-515`: `ctx.interrupt()`
**and** `interactions.cancel`) → `runAbortController.abort()`
(`AgentLaunchContext.ts:530`) → `runScope.signal` → provider abort
(`modelHandlerAnthropic.ts:553`, `modelHandlerOpenAI.ts:402`). Then, on the
same signal, the listener `attachToolUseFlow` registered
(`ExecutionHandle.ts:253`, attached at `executeAgent.ts:184`) fires
`flowContext.interrupt()` (`runToolUseFlow.ts:364-368`), which calls
`input.interrupt()` — the controller that already aborted — and
`interactions.cancel` again, plus the one effect that is genuinely new,
`sessionLifecycle.interrupt(...)`.

**Per subagent turn** three controllers are created:
`childRunLoop.ts:378` (loop, owns the WAITING gap), `childRunLoop.ts:416`
(`turnAbortController`), `runAgent.ts:109` (`launchAbortController`), then
`AgentLaunchContext.ts:461` (`runAbortController`, the sink). The only
`.abort()` calls on the loop path are `childRunLoop.ts:394` and `:396`, in
the same statement block (grepped `\.abort()` over `src/tools/delegation`,
`src/tools/agentCliShared.ts`, `src/tools/bash.ts`, `childRunLoop.ts`: no
strategy aborts the controller it is handed; all four strategies read
`.signal` only — `workflowScriptStrategy.ts:289`, `agentCliShared.ts:519`,
`bash.ts:310`, `nativeSubagentStrategy.ts:242`).

**A1. Delete `turnAbortController`.** It is bit-for-bit `loop.signal`
(`childRunLoop.ts:411`), which is already public and already passed to
`queue.waitAndDrainAll(loop.signal)` (`:1086`). `startTurn`/`finishTurn`
(`:415-421`), the `abortController` parameter through `attemptTurn`
(`:455-474`) and `ChildRunStrategy.launch`/`runTurn` (`:211`, `:226`),
and the two-fact guards `abortController.signal.aborted || loop.isInterrupted()`
(`:472-474`) and `loop.isInterrupted() || ac.signal.aborted` (`:938`) all
exist to carry a value equal to one the loop already exposes. The per-turn
reset never matters: `while (!loop.isInterrupted())` (`:976`) guarantees no
turn starts after an interrupt. Strategy contract change: `launch(ports,
signal)` / `runTurn(items, ports, signal)` — four implementors, all
`.signal` readers. Delta: −1 field, −2 methods, −1 parameter on two
interface methods, ~−25 LoC, zero behavior change.

**A2. Delete the signal→handle→signal loop.** Remove
`ExecutionHandle.detachToolUseAbortListener` (`:128`, `:249`, `:253-255`,
`:260-261`) and the `signal` parameter of `attachToolUseFlow` (1 caller,
`executeAgent.ts:184`); have `runToolUseFlow` register its own
`onAbort(runScope.signal, ...)` for the one effect that is not cancellation
(`sessionLifecycle.interrupt(inStartupWindow ? 'preserve' : 'clear')`,
`runToolUseFlow.ts:367`), disposed with the flow. Then delete the second
`interactions.cancel` (`runToolUseFlow.ts:366` duplicates
`AgentRunLifecycle.ts:511`) and the `handle.getToolUseFlow()?.interrupt()`
hop in `ChildRunInterruptible.interrupt` (`childRunLoop.ts:400`), whose
justifying comment (`:373-375`, "the one place a currently-running turn's
real interrupt reaches") is stale: the flow already aborts off
`runScope.signal`, which is downstream of the same `handle.interrupt()` at
`:396`. `getToolUseFlow()` itself stays (`executionRegistry.ts:404` reads
it for `isActiveOrResuming` and follow-up routing). **Verify before
deleting** the `interrupt()` fallback to `toolUseFlowContext.interrupt()`
(`ExecutionHandle.ts:282-286`, rationale at `:90-94`): if a tracked handle
can carry a flow without an interrupt handler, keep that fallback and delete
only the listener. Delta: −1 field, −1 parameter, −2 duplicate calls,
−1 stale comment, ~−30 LoC. After A1+A2 the handle has one interrupt entry
point and the signal is the single downstream channel, which is what
lifecycle-ownership §2 asks for.

**A3. `launchAbortController` (`runAgent.ts:109`) — KEEP, recorded.** Its
outbound edge is a straight link into `runAbortController`, but it has an
independent producer: the pre-lifecycle launch handle (`runAgent.ts:121-133`)
that covers the window before `AgentRunLifecycle.ts:494` mints the real
handle. Deleting it means the launch handle must carry a deferred signal the
launch context adopts; that is a redesign of the launch window, not a
deletion, and is out of scope here.

**A4. `runWorkflowScript.ts:706-707`** checks `runAbort.signal` and then
`callController.signal`, where `:699-700` already cascades the first into
the second. One `throwIfAborted` suffices. Bounded; batch with A1.

### 2.B Stream identity: one counter, one pin set, one barrier

The full inventory is 36 `StreamTabId`-keyed collections; the ones below
are the copies that have no lifecycle of their own.

**B1. Merge `_streamIncarnations` into `_removedStreams`.**
`SessionState._streamIncarnations` (`:142`) is written at exactly one site
(`claimStreamIdentity`, `:493`) and **never deleted anywhere** (reads
`:599`, `:661`, `:664`); `_removedStreams` (`:161`) holds the same value
type and every mutation touches both in the same block (`:493-503`, `:636`,
`:677`). The uncapped ruling on `_removedStreams` stands; this merges the
map that has no delete path into the one that has a documented lifecycle:
`Map<StreamTabId, { incarnation: number; removedAt?: number }>`, where
"removed at the current incarnation" becomes a field comparison instead of
two-map agreement. `isStreamRemoved` has 10 production call sites
(`SessionState.ts:191,:281,:399`; `SessionFactApplier.ts:284,:300,:435,:841,:866`;
`ProgressBackend.ts:219`; `sessionSignalsAdapter.ts:224`) and keeps its
signature. The desktop main-process copy
(`desktopProcessStores.ts:14`, also set-only at `:29-32`) is cross-process
and stays. Delta: −1 map, ~−15 LoC.

**B2. Move the snapshot generation onto the record.**
`ResidentStreamRegistry` (`src/transcript/ResidentStreamRegistry.ts`) exists
so that "dropping a stream's state is one `.delete()`" — and keeps a
parallel `generations` map (`:31`) beside `records` (`:24`), with `delete()`
(`:48`) dropping one and `evict()` (`:92`) dropping both. The generation
half (`generation`, `isCurrentGeneration`, `invalidateGeneration`, `evict`)
has exactly one consumer, `StreamSnapshotStore` (26 use sites); its
doc-comment justification (`:16-18`, "`StreamLogStore`, which tracks a
single store-wide revision instead") names a field that does not exist —
`grep revision src/transcript/StreamLogStore.ts` is empty. Put the symbol on
`StreamRecord` next to the `seedRefreshGeneration` it already carries
(`StreamSnapshotStore.ts:439`); `isCurrentGeneration(stream, g)` becomes
`records.get(stream)?.generation === g`, and eviction becomes the plain
`delete()` the container was built for. Delta: −1 map, −4 registry methods,
−1 stale paragraph, ~−40 LoC. Follow-up check in the PR: whether
`seedRefreshGeneration` (5 sites) and the new symbol can be one value.

**B3. One pin set in `StreamLogStore`.** `StreamState.leases` (`:192`,
8 sites) and `presentationLeases` (`:194`, 9 sites) are both "something is
keeping this transcript resident"; `tryRelease` (`:1336-1343`) and
`pruneStreamState` (`:378-383`) test them identically, and the only place
that distinguishes them is `requestEviction` dropping the `'focus'` reason
(`:592-593`). A single `pins: Set<TranscriptResidencyLeaseReason | symbol>`
keeps that one special case and deletes the second container and the
duplicated conditions. Delta: −1 field, ~−20 LoC.

**B4. `releaseRequests` (`:295`) — needs a ruling, not filed.** It is an
uncapped `Set` documented to outlive the record it names ("this policy
outlives resident state so a terminal stream remains cold after a late
writer", `:291-294`). The same fact — the stream is finished — is already
derived from the always-resident summaries by `getUnfinishedStreamIds`
(`:512-516`), so `tryRelease` could read "finished and unpinned" instead of
"requested and unpinned" and the set could go. What blocks filing: the
recovery sweep (`:1035`) and presentation-lease close (`:747`) request
eviction for streams the summary may still call unfinished. Whether those
two should evict at all is the ruling.

**B5. Removal barrier copies — recorded, not filed.** The in-flight half of
the barrier lives in `SessionFactApplier.pendingDeletions` (`:155`),
`SessionStores.pendingStreamDeletions`/`streamDeletionClaims`
(`SessionStores.ts:111,:115`, needed because the desktop process store
cannot see the applier — `:163-170`), and the CLI's slice absence plus
`RETIRED_STREAMS` (`cliState.ts:233-234`, `:259-261`). These are transient
or bounded and each has a stated reason; they are listed so the count is
honest, not as deletions.

### 2.C Retire a finished child stream's snapshot record

**The fact.** `StreamSnapshotStore.records` (`:452`) mints a record on any
read-through (`getOrCreateRecord`, `:605`) and drops one only from
`evict()` (`:1128`), which is reached from staged deletion
(`StagedDeletionCoordinator.ts:526`) and from `load()`'s
`evictStreamsExcept` (`:1680`, `:1714`). `load()` has one production caller:
the CLI resume path, `chatSessionController.ts:580`, which calls it for the
single resumed stream **on purpose** — the comment above it says "`load`
evicts every other record synchronously before its async seed, and the store
reports no provenance for an evicted record, so nothing projects an
evicted/unseeded stream". So in the CLI every finished child's record is
already evicted whenever the user resumes, and the CLI's readers already
tolerate it: `readStreamArtifacts` (`subscribeStreamArtifacts.ts:75-79`) is
gated on `hasProvenance`. In the extension and desktop the record of every
stream touched in a session lives until process exit. Per record: three
round-indexed artifact maps, two usage maps, a work plan, and the full
`AgentConfig` (`runConfig`, `StreamSnapshotStore.ts:389-449`) whose
authority is `config.json` on disk.

**The deletion.** The transcript already has the lifecycle this record
lacks: `SessionFactApplier.setStreamStatus` requests transcript eviction on
every non-active phase (`:872-874`, "Terminal lifecycle requests release
unconditionally; exact presentation and writer leases decide whether the
store can satisfy it yet"). Add the same request for the snapshot record of
a stream that has a parent (`this.state.getStreamMetadata(streamId).parentStreamId`)
when it reaches a terminal outcome phase. The store honors it after its
seed chain and dirty sidecar writes settle — the same predicate shape as
`tryRelease` — then `evict()`s. No new manager, no budget: one more line at
the existing lifecycle owner and one public method on the store (which
lowers nothing in `config/ratchets/store-public-surface-baseline.json`, and
adds one row, stated).

**Consumers.** Nine synchronous accessors, 30 production call sites, 3 of
which preload first (`subscribeStreamArtifacts.ts:127`,
`chatSessionController.ts:723`, `ProgressViewMessageHandler.ts:801`); the
four progress controllers also preload (`ProgressFollowUpController.ts:74`,
`ProgressWorkflowRunActionsController.ts:106`, verified). The remaining sync
readers are `LitSessionRenderer.ts` (7 sites, selected stream),
`SessionHandle.ts:357,:393,:446,:472` (startup repair, before any child
finishes), `SessionStores.ts:456,:515`, `ExecutionsTool.ts:106`,
`StatusBarUsageTracker.ts:37`, `WorkPlanReader.tsx:137`,
`sessionCommands.ts:83`, `desktopProcessStores.ts:23`,
`desktopAgentExecution.ts:185-189,:1005,:1153-1155`, `ToolUseFollowUp.ts:186`,
`runProgressRenderer.ts:158`. Every one of them reads through
`warnIfUnseeded` (`:590-602`), which warns once per accessor per stream with
the instruction "Await preload([stream]) first" (#9947). That gate is the
migration tool: a reader that regresses says so in the log rather than
rendering silently wrong.

**What is given up.** The CLI subagent list (`SubagentList.tsx:318`,
`App.tsx:377`) and the resume hint (`resumeHint.ts:88`) show a finished
child's token usage from its record; after retirement they show nothing
until the child is focused (which preloads). Either accept that, or mirror
`cumulativeUsage` into the summary meta the way description already is
(`publishSummaryMeta`, `:560-575`). Decide in review; the second option is
one field on an existing mirror, not a new store.

**Acceptance.** A soak test in the kernel that runs N child executions to
completion through a real `SessionHandle` and asserts
`snapshots`' record count returns to the parent set; the existing
`warnIfUnseeded` warning count in the CLI and extension suites stays zero.
Delta: +1 store method, +1 applier line, −0 elsewhere until readers are
audited; the memory term it removes is the only unbounded per-stream heap
left after #9947.

### 2.D Approval ancestry: the one edge that is off the rail

`parentOf` (`streamApprovalQueue.ts:236`) is the fifth copy of the
parent→child stream edge. The other four — `AgentExecutionHandle.parentStreamId`
(`ExecutionHandle.ts:125,:205`), `ChildExecutionActivation.parentStreamId`
(`executionRegistry.ts:61`), the snapshot sidecar
(`StreamSnapshotStore.ts:1381-1386,:1478`), and `SessionState` metadata
(`:317`) — are one fact on one rail: `emitParentStreamUpdate`
(`executionRegistry.ts:713-728`) publishes `setParentStream` at registration
(`:277`) and detach (`:597`), and the last two are projections of it.
`parentOf` alone is written beside that rail, in the very loop that emits
it: `detachActiveChildren` calls `approvals.detachStreamFromParent` **and**
`emitParentStreamUpdate({parentStreamId: null})` for the same child
(`executionRegistry.ts:584-600`). Its readers are two closures in the same
file (`resolveParent :237`, `resolveDescendants :239`); `resolveDescendants`
rescans the whole map per BFS level, and a non-silent `setBypass` does that
walk three times through `setDelegatedWorkBypasses` (`:302-310`).

**Why it cannot simply read the registry today.** One of its two production
writers is not a lineage edge: `chatSessionController.ts:462-478` links
round N's root stream to round N−1's so bypass grants survive across CLI
conversation rounds. That is a CLI policy ("bypass follows the conversation,
not the stream") encoded as a fake parent edge.

**Proposal (design-level, needs the CLI ruling first).** Decide where
cross-round bypass inheritance lives. If it is a session fact (the bypass
value follows the _session_, and each round's root stream starts from the
session value), then `parentOf` collapses to a read of the registry's
lineage — `resolveParent` becomes `registry.getHandle(...)?.parentStreamId`
or the activation's parent, and `registerStreamParent`,
`detachStreamFromParent`, `forgetStreamAncestry`, and the second
`parentOf.delete` in the detach loop all go. Deleted with them: the only
reason `releaseStreamResources` (`tools/approval/index.ts:93-98`) has to run
on stream deletion is the ancestry cleanup; the interaction cancel and
`followUps.terminalize` stay. Delta if ruled that way: −1 map, −3 methods
on `SessionApprovals`, −1 exported helper, ~−70 LoC; the
`'proposal'`/`'superYolo'` label split (PRD §7.4) is untouched. If the ruling
goes the other way, the honest alternative is to name the CLI edge for what
it is (a per-session inherited bypass value) rather than keep a graph for
one non-graph caller.

### 2.E Bounded deletions (batch into one PR)

**E1. Missed-terminal-result replay is unreachable.**
`SessionHandle.missedTerminalResults` (`:627-633`) is written only at
`publishRunEvent` `:716`, which requires `replayMissedResultsEnabled` and
`replayResultListenerCount === 0`. The latch is set in the same statement
that increments the count (`:661-662`), the count decrements only on
listener disposal (`:680`), and both enabling hosts attach once before any
run and detach only at teardown (desktop `index.ts:1302-1316`, extension
`ProgressViewProvider.ts:177-186`, provider built once at
`extension.ts:627`). The CLI never enables it. So the `set` branch has no
production path, zero tests assert it, and the latch never resets. Delete
the map, both counters, `isReplayableTerminalResult` (`:81-85`), the
`replayMissed` option on `onResult`, the `queueMicrotask` drain
(`:663-674`), and the `replayWhenAttached` option of
`attachTerminalResultToast` (`terminalResultToast.ts:138-155`; 2 callers).
Check `git log -S missedTerminalResults` in the PR for the incident that
motivated it and confirm that path no longer exists. Delta: −3 fields,
−1 predicate, −2 options, ~−45 LoC.

**E2. Artifact flushers remove themselves at dispose.** The per-run
flushers (`childStream.ts:107-110`, `AgentLaunchContext.ts:380-383`) defer
their own removal to "the next flush after `traceDisposed`", but the run's
own flush runs _before_ its trace disposes (`finalizeRunTerminal` flushes at
`AgentRunLifecycle.ts:234-242`; `disposeTrace()` follows at
`childStream.ts:353`), so the flusher is reclaimed only by some later,
unrelated flush. Its only remaining effect after dispose is surfacing one
late `pendingSpillFailure` to whoever that unrelated caller is
(`TexraTranscriptRecorder.ts:885-892`). Await `flushSpills()` once inside
`disposeTrace` and remove the flusher there. Delta: −2 `traceDisposed`
flags, −2 deferred closures, ~−15 LoC; the late failure reaches the run
that produced it.

**E3.** `ToolUseFollowUpQueueManager.hasLiveOwner` (`:202`) has zero
production readers (declared for "diagnostics and teardown assertions").
Delete. **E4.** The `interactions.cancel` duplicate and the double
`throwIfAborted` from §2.A ride here if A2/A4 are not taken whole.

### 2.F Recorded, not filed

- **`DisposableStore.remove()`** — rejected as an addition. The evidence
  that it is missed is real: `chatSessionController.ts:365-372` hand-rolls
  a `Set` of releasable scopes with a comment naming the gap, and
  `SessionHandle` keeps two more removable-disposer sets
  (`resultListenerDetachers :639`, `artifactFlushers :135`) beside the store
  it owns. But adding the method nets +1 element on a surface the Effect-4
  PRD proposes to replace, and E2 deletes one of the three hand-rolled sets
  without it. Revisit only if a consumer deletes a set in the same PR.
- **Abandoned WAITING children keep a follow-up queue entry** for the
  session (`ToolUseFollowUpQueueManager.ts:229` keeps the entry on a
  `'recoverable'` release; reclaimed only by a later stop reaching
  `AgentRunLifecycle.ts:733`, a host deletion, or session dispose). The
  recoverable-vs-terminal decision has two owners
  (`runToolUseFlow.ts:666-668` and `AgentRunLifecycle.ts:733`). This is a
  correctness question about parked runs, not a copy of a fact; it belongs
  with the single-owner-sessions decisions (D3/D4 in
  `2026-08-23-single-owner-sessions.md`), not here.
- **The focused stream's transcript is held three ways in the TUI** (log
  entries, fold items, rendered rows) with no in-stream trimming. That is a
  rendering budget (memory investigation Finding 3/4), a policy to set, not
  a duplicate owner to delete; out of scope for this survey.
- **`WebviewBridge.streams`** (`WebviewBridge.ts:41`) and
  `SessionFactApplier.registeredWithRenderer` (`:146`) keep one entry per
  finished child until deletion. Small, and both become moot if §2.C's
  retirement event is what the renderer keys on; fold into that PR.

## 3. Order of work

1. **A1 + A4 + E3** — mechanical, zero behavior change, one PR.
2. **E1 + E2** — bounded deletions with a `git log -S` check each, one PR.
3. **B1 + B2 + B3** — one owner per stream-identity fact; three small PRs
   or one, each with the R6 element table.
4. **A2** — after 1, with the `ExecutionHandle.ts:90-94` verification
   recorded in the PR body.
5. **2.C** — the memory term. Needs the usage-mirror decision from review;
   ships with the soak test as its acceptance criterion.
6. **2.D** — needs the CLI cross-round bypass ruling; blocked until then.
7. **B4** — needs the recovery-sweep ruling; blocked until then.

Every step deletes a copy of a fact and adds at most one method at the
fact's existing owner. None adds a manager, a budget, a cache, or a table.

## 4. Verified

Opened first-hand at `a13b28b`: `childRunLoop.ts:370-425,:468-478,:934-980`;
`runToolUseFlow.ts:355-372`; `ExecutionHandle.ts:276-290`;
`AgentRunLifecycle.ts:185-280,:505-520`; `AgentLaunchContext.ts:440-535,:612-660`;
`runAgent.ts:95-135,:160-260`; `nativeSubagentStrategy.ts:180-260`;
`SessionHandle.ts:275-335,:620-720`; `SessionState.ts:100-215,:416-440`;
`SessionFactApplier.ts:800-875`; `StreamLogStore.ts:150-200,:286-300,:372-388,:505-520,:575-610,:1320-1352,:1424-1500`;
`StreamSnapshotStore.ts:380-560,:590-604,:1128-1140,:1405-1450,:1555-1725`;
`ResidentStreamRegistry.ts:1-80`; `streamApprovalQueue.ts:207-331`;
`tools/approval/index.ts:40-120`; `childStream.ts:60-245,:280-380`;
`chatSessionController.ts:355-440,:462-480,:548-586`;
`terminalResultToast.ts:138-155`; `src/platform/disposable.ts`;
`store-public-surface-baseline.json`. Node retention numbers from
`AbortSignal.any` and `fetch` micro-benchmarks run on Node 22.22.2 with
`--expose-gc` during the `a13b28b` investigation.
