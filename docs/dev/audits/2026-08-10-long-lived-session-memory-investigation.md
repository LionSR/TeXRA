# Long-lived multi-agent session memory investigation

**Status:** investigation. No remediation implemented. Findings 1 and 6 were verified against code on 2026-08-10; see the per-finding verification notes. Finding 1 is confirmed (and its fix surface is narrower than originally proposed); Finding 6's severity is downgraded. The remaining findings still require a heap snapshot to prove dominance.

**Scope:** recurring Node/V8 out-of-memory failures in long-lived TeXRA CLI sessions with many subagents. This report distinguishes retained JavaScript heap from persistent on-disk artifacts. It is written as a handoff for a deeper architecture review.

## Executive summary

Three failures (`errorLogs/error4.txt`, `error5.txt`, and `error8.txt`) ended with:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

All failed near Node's approximately 4 GB old-space limit. The best current explanation is **unbounded process-wide retention combined with allocation-heavy TUI projections**, not a single active agent response, a single workflow, or LaTeX/PDF output files.

The strongest concrete code issue is that startup currently hydrates and retains a full sidecar `StreamRecord` for **every historical transcript in the workspace**. In the affected `TNLean` workspace, that means 1,923 stream IDs. Additional strong candidates are the TUI's whole-transcript re-projection on a 16 ms cadence, unbounded static terminal scrollback representations, and retention structures not tied to central transcript eviction.

A heap snapshot is still required to prove the dominant retaining path. The evidence is sufficient to prioritize explicit byte-budgeted residency and incremental projections over raising Node's heap limit or deleting build artifacts.

## Incident evidence

### OOM logs

All three available logs report V8 being unable to recover space after GC near a 4 GB heap:

| Log                    | Approximate GC clock at failure | Final error                               |
| ---------------------- | ------------------------------: | ----------------------------------------- |
| `errorLogs/error4.txt` |         128,305 s, about 35.6 h | ineffective mark-compacts near heap limit |
| `errorLogs/error5.txt` |         116,404 s, about 32.3 h | ineffective mark-compacts near heap limit |
| `errorLogs/error8.txt` |         167,824 s, about 46.6 h | ineffective mark-compacts near heap limit |

`error8.txt` displayed a run duration of `1h 3m`, 154k/500k tokens, and 3 subagents. That displayed duration does **not** equal Node process lifetime. The GC clock shows the process had lived for about 46.6 hours, consistent with gradual accumulation across sessions or runs inside a long-lived process.

The final `error8` GC messages included roughly:

```text
4030.2 MB -> 3998.3 MB
4004.6 MB -> 3972.6 MB
```

The native stack includes `Array.map` and `Set` construction. Those frames identify the final failed allocation, not necessarily the object graph retaining the preceding gigabytes.

### The active run was not large enough to explain 4 GB

Inspection of the exact `error8` root context found approximately:

- root stream log: 375 entries, about 602 KB;
- root persisted flow: about 126 KB;
- listed child execution directories: at most about 684 KB each.

Therefore, the active workflow alone cannot explain the failure. The relevant state is process-wide retained history and/or repeated projection of it.

## Affected persistent workspace: TNLean

The principal workspace is:

```text
~/.texra/workspace-storage/TNLean-ad72a6a8
```

Its total persisted size is approximately **2.7 GB**:

| Area                  |   Size |                       Count | Interpretation                                            |
| --------------------- | -----: | --------------------------: | --------------------------------------------------------- |
| `streamLogs/`         | 991 MB |                 1,922 files | canonical transcript records                              |
| `executions/`         | 1.7 GB | 2,270 execution directories | durable execution inputs, outputs, records, and artifacts |
| `streamData/`         |  22 MB |                 5,274 files | stream sidecars                                           |
| `streamLogSummaries/` | 7.5 MB |                 1,922 files | lightweight transcript summaries                          |
| `recordings/`         | 1.8 MB |                     2 files | recordings                                                |

Other workspaces are much smaller. Across 438 workspaces, total storage is about 5.27 GB; TNLean alone is 2.70 GB, MIPStarRE is 1.50 GB, and coauthor is 0.68 GB. The top three account for about 93% of retained storage.

This persistent size is evidence of an unusually large historical workload. It is **not proof that 2.7 GB is resident in V8**. The code must be examined to see which pieces are eagerly parsed, cached, copied, or re-projected.

### Important non-cause: LaTeX/PDF artifacts

The execution tree has generated PDFs, TeX, build logs, and intermediate artifacts. Some PDFs are physically duplicated between compiler output, `output/rN`, and `output/latest`. That is a disk-efficiency issue, but it is not a credible direct cause of the Node OOM unless the process reads and retains their bytes. This investigation deliberately does not treat PDF cleanup as the heap fix.

## Code-level findings

### Finding 1: all historical stream sidecars are eagerly hydrated and retained

**Severity:** highest-confidence retained-heap candidate.

**Locations:**

- `src/agent/runtime/SessionHandle.ts:408`
- `src/transcript/StreamSnapshotStore.ts:1572`

At startup, `SessionHandle` calls snapshot loading with every transcript key. In TNLean, this is 1,923 stream IDs. `StreamSnapshotStore.load()` creates and retains a `StreamRecord` per stream. Each full record can include:

- output and missing-output structures;
- compile failures;
- usage maps;
- work plans;
- parsed run config and identity;
- metadata and overlays;
- two `KVStore` handles.

The subsequent eviction excludes the same full input set, so all seeded records remain. This is long-lived heap retention, not a temporary allocation spike.

The raw `streamData` sidecars are about 22 MB on disk. Parsed JSON, object/Map/Set overhead, Zod parsing, config objects, and related references can cost materially more than disk bytes, especially for 1,923 separate records.

**Why it matches the incident:** it creates a growing baseline proportional to every historical stream in the current workspace. A process may survive initially, then later fail when TUI projection, workflow serialization, or a large response needs temporary headroom.

**Required proof:**

1. Export `StreamSnapshotStore.records.size` and estimated retained bytes per field.
2. Take a heap snapshot after startup and inspect dominators rooted at `StreamSnapshotStore.records`.
3. Compare startup with all historical IDs against startup limited to active plus unfinished streams.
4. After switching away from an inactive seeded stream, force GC in a diagnostic harness and verify output/work-plan/config objects are collectible.

**Candidate remediation:** split an all-stream lightweight metadata index from full sidecar records. Hydrate full sidecars only for active, running, visible, or explicitly queried streams. Give inactive records a byte-accounted LRU.

**Verification (2026-08-10, code-confirmed):** the startup path is confirmed and sharper than the original finding. The CLI constructor enqueues `repairStoresAfterRestart` (`SessionHandle.ts:242-249`), which at `:408` calls `this.snapshots.load(this.transcripts.keys())`; desktop defers the same call to `waitUntilReady()` (`:272-276`). It runs once per session. `StreamLogStore.keys()` (`StreamLogStore.ts:436-438`) returns `[...this.summaries.keys()]`, populated from `kv.listKeys()` at open (`:1111-1132`) — every persisted stream, unfiltered. `load()` (`StreamSnapshotStore.ts:1572-1577`) applies no filter: it `evictStreamsExcept`s to the passed set, then `seedStreams` reads 6 sidecar files per stream (`streamSnapshotRead.ts:144-175`) and retains them in `records`.

Two facts narrow the fix: (1) a bounding filter already exists — `getUnfinishedStreamIds()` (`StreamLogStore.ts:441-445`) — but is applied only to the post-load status/repair phases (`markUnfinishedStreamsRunning` `:539-547`, `runRestartRepair` `:585`,`:596`), never to the snapshot `load()`; (2) lazy hydration already partially works — `readOutputFiles` (`StreamSnapshotStore.ts:1555-1562`) serves unseeded streams from disk via `awaitSeeded`.

Element accounting: the candidate remediation above (split a metadata index + byte-accounted LRU) **adds** subsystems. The element-reducing fix is instead to bound the startup load to the unfinished set plus active lineage via the _existing_ filter, relying on the _existing_ disk fallback for the rest — this deletes wasted eager seeding of finished streams (less retained state, no new cache). Pending: an audit of which callers assume eager seeding (Q6).

**Safety audit (2026-08-10, code-confirmed) — the lazy-hydrate/LRU fix is larger than it looks and has a data-loss landmine:**

- `awaitSeeded` (`StreamSnapshotStore.ts:1521`) is a status check, **not** a self-heal: it only awaits an already-in-flight `seedChain`, and returns `false` otherwise without touching disk. The lazy fallback in `read`/`readOutputFiles` works only because they carry an explicit disk read after `awaitSeeded` — not because `awaitSeeded` hydrates anything.
- Nine synchronous accessors assume the record is seeded and return empty/default/undefined for an unseeded stream, with no fallback: `getOutputFiles` (`:883`), `getMissingOutputs` (`:887`), `getCompileFailures` (`:891`), `getRunUsage` (`:895`), `getKnownFilePaths` (`:900`), `getWorkPlan` (`:1101`), `getRunMetadata` (`:1231`), `getParentStreamId` (`:1273`), `getExecutionIdMap` (`:1294`).
- Callers that would break for finished streams: `SessionState.load` all-streams metadata loop (`src/controllers/session/SessionState.ts:550`); desktop presentation seed all-streams loops (`packages/desktop/src/main/desktopAgentExecution.ts:437-448`); extension `ProgressViewProvider.setActiveStream` → `syncStreamContent` with no preload (`packages/extension/src/progressView/ProgressViewProvider.ts:393-414`); `resumeFromResumeData` (`packages/extension/src/commands/agent/resumeFromResumeData.ts:53,62`). The active-stream progress-view controllers/handlers are safe _iff_ `setActiveStream` preloads first.
- **Data-loss landmine:** `canMutateSynchronously` (`StreamSnapshotStore.ts:430-440`) flips `seeded = true` without reading disk when `hasAuthoritativeStreamSet === true` and no `seedChain` is in flight. A subsequent mutation merges onto an empty base and persists, overwriting the real sidecar with empty+delta — silent data loss. A lazy design must **never** set `hasAuthoritativeStreamSet = true` while finished streams with sidecars remain unseeded; use `preload()` semantics (which leaves the flag false) for the partial set, or split `load()` so the flag reflects only the genuinely-authoritative set.
- Safe model to generalize: `subscribeStreamArtifacts.ts:66` does `await store.preload([streamId])` before its synchronous reads. Already self-healing and needing no change: `SessionStores.executionIdForStream`, `SessionHandle.runRestartRepair`, the CLI/desktop resume paths, and all `read()`/`readOutputFiles()` consumers (which construct fresh stores).

### Finding 2: the TUI rebuilds the entire transcript repeatedly

**Severity:** highest-confidence temporary-allocation candidate; it may also retain derived state.

**Location:** `packages/cli/src/chat/tui/state/subscribeStreamLog.ts:810-966`

At a 16 ms cadence, transcript synchronization can create/recreate:

- `allEntries`;
- an ID map;
- synthetic/candidate/rendered arrays;
- sorted and filtered arrays;
- sliced and mapped arrays;
- a `Set` of dashboard IDs;
- another filtered array.

The `filter -> slice -> map -> new Set` chain at lines 1021-1026 fits the final `Array.map` then `Set` frames from `error8`. `error5` also reports `Array.map` and `Array.prototype.reverse`, consistent with this general projection/render family.

This likely creates large temporary allocation pressure proportional to total resident transcript history rather than to the new delta. Some rendered entries are then retained by TUI signals and static transcript state.

**Required proof:** log per-sync input-entry count, derived-output count, elapsed time, and heap before/after. Allocation profiling should attribute churn to `syncStreamLog`, `renderLogEntry`, and this filter/map/Set chain. A benchmark should compare a multi-megabyte log at high update rate before and after incremental projection.

**Candidate remediation:** cursor-based projection. Consume appended/changed entries since the last projection, update an ID index incrementally, and keep workflow dashboard membership incrementally. Per-tick work should be proportional to changed entries, not total transcript size.

### Finding 3: TUI static transcript / Ink scrollback keeps multiple representations indefinitely

**Severity:** high-confidence retained-heap candidate for long root sessions.

**Locations:**

- `packages/cli/src/chat/tui/panes/StaticConversationTranscript.tsx:245-344,391-445`
- `patches/ink@7.1.1.patch:71-118`

Finalized transcript data is retained as:

1. source `StreamLogEntry` values;
2. React `ConversationEntry` / `StaticTranscriptItem` objects;
3. Ink's rendered ANSI `fullStaticOutput` string.

This duplicates assistant text and tool results. It resets when the scrollback owner changes, but a long root session can retain output for its entire lifetime without a row or byte budget.

**Required proof:** inspect heap dominators for `StaticTranscriptState.items`, React fibers rooted under `Static`, and Ink `fullStaticOutput`. Record item count, total entry/tool-output text length, and `fullStaticOutput.length` over a long run.

**Candidate remediation:** after terminal scrollback acknowledges finalized output, release rich React item objects. If resize replay is required, retain a bounded/disk-backed compact ANSI replay buffer rather than React data plus a second complete rendered string. Define explicit row and byte budgets.

### Finding 4: transcript eviction is request-driven and has no global byte budget

**Location:** `src/transcript/StreamLogStore.ts:467-503,1428-1538`

`requestEviction()` works when called, but no central resident-log maximum, byte budget, age limit, or pin accounting exists. A missed terminal transition, writer ownership, dirty state, failed flush, or rehydration with no later release can keep a full parsed stream log resident indefinitely.

TNLean currently has 41 summaries marked with running groups, representing 44 MB of authoritative JSON before parsed-object and projection overhead. The recovery path limits I/O concurrency and requests eviction afterward, but ordinary residency has no backstop.

**Required proof:** identify `StreamLog` dominators under `StreamLogStore.streams`, including stream ID, estimated bytes, and pin reason. After a child reaches terminal status and flush completes, its full log should vanish after GC.

**Candidate remediation:** central byte-accounted residency manager. Active writer, visible stream, flushing, and recovery can pin logs. All other logs participate in LRU eviction.

### Finding 5: CLI terminal status does not directly release a stream

**Location:** `packages/cli/src/chat/tui/state/subscribeStreamStatus.ts:18-48`

The CLI status subscriber depends on later projection or focus changes to set `releaseAfterSync` in `syncStreamLog`. This makes lifecycle cleanup dependent on render ordering. A terminal, non-visible stream with no later usable projection can remain resident.

**Candidate remediation:** terminal lifecycle ownership should request release directly after writes and writers settle. Rendering can pin visible state, but should not own durability eviction.

### Finding 6: process-global task-group projections outlive transcript eviction

**Location:** `packages/cli/src/chat/tui/state/subscribeStreamLog.ts:681-710`

`TASK_GROUP_PROJECTIONS` is process-global. It is cleared only by whole-CLI reset or explicit child removal. Evicting a stream log does not clear its task projection. The projection retains original group-entry objects in `applied`, plus working/snapshot representations.

This is a genuine cross-stream retention leak. It may not explain 4 GB alone, but it defeats transcript eviction for projected streams.

**Required proof:** project then evict hundreds of streams, force GC, and inspect `TASK_GROUP_PROJECTIONS.size` plus retained `StreamLogEntry` objects. The size should track visible/resident streams, not every stream ever projected.

**Candidate remediation:** tie projection lifecycle to stream eviction/removal, or retain only minimal group version metadata.

**Verification (2026-08-10, code-confirmed — severity downgraded):** the structural facts hold (`TASK_GROUP_PROJECTIONS` at `subscribeStreamLog.ts:681` is module-level; cleared only by the reset hook (`:683`) or `.delete()` on explicit `removeStream` (`:796` via `isChildStreamRemoved`); eviction at `:996` → `requestEviction` does not touch it). However, "defeats transcript eviction" is overstated. `requestEviction` (`StreamLogStore.ts:473-504`) sets `state.log = undefined`, which **does** release the heavy per-message transcript (model responses, tool output, user text). The leaked `applied` map (`:704`) retains only `GROUP_START`/`GROUP_END` boundary entries — the loop at `:695-701` filters to those — whose `data` payload is small scalars (`GroupLogPayload`: status, kind, index, total, name, endTime). Heavy entries are not retained. The leak also self-heals: on re-sync, rehydrated entries are new objects, so the identity check at `:702` fails and `:704` overwrites stale references. This is a minor structural nit, not a material 4 GB contributor; a fix here would not cut elements that matter. Deprioritize relative to Finding 1.

### Finding 7: streaming text has duplicate retention and superlinear copying

**Location:** `src/transcript/StreamLog.ts:241-262`

During streaming, text is retained both in `entries[index].text` and in `dirtyTextDeltas[id].appendText`. Both are repeatedly rebuilt through string concatenation. A CLI-only consumer does not acknowledge the delta, so the second copy can remain until settlement.

This is both temporary allocation churn and duplicate retained payload during a large response or tool output.

**Required proof:** stream a synthetic 50-200 MB entry under CLI-only subscriptions. Measure `entry.text.length`, dirty-delta length, allocation, and CPU. The current design should show near-equal retained strings and superlinear allocation.

**Candidate remediation:** retain chunks/rope-like segments until settlement and use per-consumer cursors rather than a single accumulated dirty string.

### Finding 8: workflow and flow persistence clone and serialize full state

**Locations:**

- `src/agent/node/persistedFlow.ts:211-231,282-288,311-355,468-482`
- `src/agent/workflowScript/workflowExecutionState.ts:87-89,434-442`

Active flow persistence retains a full `cachedRecord`, then applies `structuredClone` and `JSON.stringify` to full shared state at transitions. Workflow execution snapshots are also fully cloned and serialized on publication. These paths cause temporary duplication proportional to the full history/snapshot.

For the exact `error8` run, the root flow was only 126 KB and its children were small. Therefore this is not sufficient by itself for that crash. It can still trigger OOM once the baseline heap is already high.

**Candidate remediation:** separate append-only conversation storage from small resumability state; checkpoint/chunk large state; publish deltas or coalesced snapshots rather than a full clone on every micro-transition.

### Finding 9: full Progress View synchronization scales with all workspace history

**Locations:**

- `src/controllers/progressView/backend/WebviewUpdater.ts:325-370`
- `src/controllers/session/SessionState.ts:217-225`

A full Progress View synchronization rebuilds metadata for every historical stream, copies the all-stream list, creates metadata records, and sends a structured-cloned bridge payload. With 1,923 streams, this is a material temporary allocation spike in the extension host and webview.

This is not the CLI path shown in `error8`, but it is the analogous GUI risk.

**Candidate remediation:** page/virtualize historical tabs and send incremental metadata patches. Initial synchronization should send a bounded recent set plus active lineage.

## Important negative findings

These observations avoid attributing the OOM to irrelevant disk data:

- `ExecutionKVStore` uses an LRU of only 50 thin store wrappers. It does not cache parsed execution values. The 1.7 GB execution directory is not automatically resident.
- `StreamLogStore` startup uses the 7.5 MB summary sidecars and does not normally load all 991 MB of transcript files. In TNLean, all summaries were present and non-stale, so no full-log fallback read was required at startup.
- The exact active root workflow and its children were far too small to explain a 4 GB heap by themselves.
- PDF/LaTeX output duplication is a disk-efficiency concern, not the direct heap diagnosis.

## Recommended architecture, not ad hoc cleanup

1. **Separate metadata from payloads.** Keep a small all-history index. Hydrate full transcript/snapshot details only for active, running, visible, or explicitly opened streams.
2. **Use byte-budgeted hot caches.** Track resident bytes, pins, and eviction reasons for logs, sidecars, and rendered history.
3. **Make terminal cleanup lifecycle-owned.** A terminal child must release heavy transcript state after flush even if no UI update follows.
4. **Use incremental projections.** TUI and GUI updates should process deltas, not rescan full history.
5. **Bound terminal rendering.** Do not retain unbounded source entries, React objects, and ANSI scrollback simultaneously.
6. **Keep one canonical large payload.** UI projections and parent child rosters should use references and bounded summaries, not full copies.

## Measurement plan for a deeper reviewer

Before changing behavior, add or use a diagnostic mode that emits:

```text
resident StreamLog count, entry count, estimated text bytes, dirty-delta bytes, pin reason
StreamSnapshotStore record count and bytes by field
TUI stream/slice count, rendered entry count, task-projection count
static transcript item count/text bytes and Ink fullStaticOutput byte length
active flow count and approximate cached shared-state bytes
workflow snapshot clone count and serialized byte count
```

Then reproduce with the long-lived CLI against TNLean and collect:

1. an early baseline heap snapshot;
2. a snapshot after many child completions;
3. a snapshot after stream-focus changes;
4. automatic near-limit heap snapshots using Node options such as:

```text
--heapsnapshot-near-heap-limit=3
--track-heap-objects
--trace-gc
```

Compare dominators rooted at:

```text
StreamSnapshotStore.records
StreamLogStore.streams
TASK_GROUP_PROJECTIONS
TUI signal-backed stream maps
StaticTranscriptState / Ink fullStaticOutput
PersistedFlow.cachedRecord
```

A synthetic soak test should launch hundreds of short child executions and assert that, after terminal transitions and forced GC, retained heap returns to a bounded envelope. The current correctness tests cover transcript/delta behavior but not long-session memory bounds.

## Questions for the next reviewer

1. Which of the identified structures dominates retained bytes in a heap snapshot?
2. Can `StreamSnapshotStore` load only metadata at startup while preserving current resume/recovery guarantees?
3. What is the minimum durable state needed for a completed child to remain inspectable and resumable?
4. Can TUI static output be delegated to terminal scrollback without retaining rich React rows indefinitely?
5. What precise byte and item budgets preserve useful UX while bounding a long session?
6. Which existing execution/history APIs still require legacy full records, and can they load them lazily?
