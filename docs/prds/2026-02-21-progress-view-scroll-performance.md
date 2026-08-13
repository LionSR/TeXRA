---
created: 2026-02-21
updated: 2026-02-21
---

# Progress View Scroll Performance

> **Status: Complete.** All fixes implemented including the `sendStreamMetadata` payload trim.
>
> Post-refactor analysis. All claims verified by tracing code paths at HEAD of `codex/progress-view-prd-refactor`. Second-pass deep investigation (2026-02-21) audited the full pipeline — event bus → backend handlers → postMessage → Zod dispatch → Lit render — and added 7 new entries to [Debunked concerns](#debunked-concerns). Third-pass audit (2026-02-21) confirmed all fixes are committed.

---

## Root Causes (Resolved)

Two independent issues existed after the initial refactor. Both are now fixed.

### 1. Browser paints all DOM nodes regardless of viewport visibility — FIXED

We render the entire log history as DOM nodes in a single scroll container. The browser must maintain layout boxes and paint all of them during scroll, regardless of viewport visibility.

A stream with 500 tool-use entries produces 2,500–50,000 DOM nodes (collapsed vs expanded). CSS `contain: layout paint` on the scroll container (already applied in `logStyles.ts:47-52`) prevents reflow cascades but does NOT prevent the browser from doing layout and paint work for off-screen children. The browser still computes layout boxes for every node and paints every visible one per frame.

During manual scroll, **zero JS runs** — there are no scroll event listeners. `scrollToBottomIfNearEnd` only runs inside `TaskGroupList.updated()` after Lit renders, not during user scroll. The lag is entirely in the browser's rendering pipeline.

No amount of Lit optimization, message batching, state management improvement, or timeline memoization changes this. The root cause is the browser doing work for content the user cannot see.

**Fix:** `content-visibility: auto` applied in `groupStyles.ts` and `logEntryStyles.ts`. See [Fix 1](#fix-1-content-visibility-auto-done) below.

### 2. Overly broad `willUpdate` guards trigger unnecessary StreamTabs rebuilds — FIXED

**File: `ProgressApp.ts`**

Both `willUpdate` guard blocks previously checked `prevAppState.streamStates !== this.appState.streamStates` as a proxy for "did status or lastTimestamp change?" But `streamStates` Map identity changes on ANY `setStreamState` call — including updates that don't affect sort order or tab display at all.

**Messages that change `streamStates` identity without changing `status`/`lastTimestamp`:**

| Message                        | Frequency during streaming | What it changes                  |
| ------------------------------ | -------------------------- | -------------------------------- |
| `UPDATE_CONVERSATION_PROGRESS` | ~2Hz                       | `conversationProgress`           |
| `UPDATE_CONTEXT_STATE`         | ~1Hz                       | `contextState`                   |
| `ADD_TASK_GROUP`               | ~0.5Hz                     | `taskGroups`                     |
| `UPDATE_TASK_GROUP`            | variable                   | `taskGroups`                     |
| `UPDATE_STREAM_BADGES`         | variable                   | badge counts                     |
| `UPDATE_RUN_USAGE`             | variable                   | `runUsage`/`sessionUsage`        |
| `UPDATE_TODOS`                 | variable                   | `todos`                          |
| `UPDATE_QUEUED_FOLLOW_UPS`     | variable                   | `queuedFollowUps`                |
| `UPDATE_BYPASS`                | rare                       | bypass flags                     |
| `UPDATE_FILES`                 | variable                   | `runFiles`                       |
| `UPDATE_MISSING_OUTPUTS`       | variable                   | `runMissingOutputs`              |
| `UPDATE_INSTRUCTION`           | variable                   | `runInstructions`                |
| `SYNC_STREAM_CONTENT`          | on tab switch              | calls `setStreamState` 3-4 times |

That was ~3.5 `setStreamState` calls per second during active streaming that didn't change sort order or tab status.

**Fix:** Guards narrowed to compare actual `status` and `lastTimestamp` values, not Map identity. See [Fix 2](#fix-2-narrow-willupdate-guards-to-sort-relevant-fields-done) below.

---

## Fix 1: `content-visibility: auto` — DONE

> Commit: `353878c33` (perf: narrow willUpdate guards and clean up status SSOT)

The browser has a built-in mechanism for this: [`content-visibility: auto`](https://developer.chrome.com/blog/content-visibility). Chromium 85+ (2020). VS Code's Electron webview supports it.

It tells the browser: "skip layout and paint for elements outside the viewport." The browser natively handles viewport detection, render scheduling, and scroll compensation. Zero JS. Zero architectural changes.

Combined with `contain-intrinsic-size`, the browser reserves space for off-screen elements so scroll height stays stable and the scrollbar doesn't jump.

### Applied in

**File: `groupStyles.ts:74-77`** — `.log-group`:

```css
content-visibility: auto;
contain-intrinsic-size: auto 200px;
```

**File: `logEntryStyles.ts:30-31`** — `.log-line`:

```css
content-visibility: auto;
contain-intrinsic-size: auto 24px;
```

**File: `logEntryStyles.ts:246-247`** — `.banner-details`:

```css
content-visibility: auto;
contain-intrinsic-size: auto 40px;
```

### How `contain-intrinsic-size: auto Npx` works

- `Npx` is the initial height estimate before the element has been rendered.
- `auto` tells the browser: once the element has been rendered and its actual height is known, remember it. Subsequent passes use the real height, not the estimate.
- Off-screen elements are treated as empty boxes with the reserved height. Scroll position and scrollbar size stay stable.
- When an element scrolls into the viewport, the browser renders it on demand.

### What this solves

| Problem                                                                   | How `content-visibility: auto` addresses it                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Scroll lag with 500+ entries                                              | Browser skips layout/paint for off-screen entries                                |
| Uncached tab switch blocks main thread (100-300ms formatting 500 entries) | Only viewport-visible entries need immediate formatting; browser defers the rest |
| DOM node count pressure                                                   | Nodes still exist but the browser skips their rendering work                     |

### Risk: `vscode-scrollable` compatibility

`vscode-scrollable` tracks `scrollPos`/`scrollMax` properties for its own scroll logic. If `content-visibility: auto` causes `scrollHeight` instability during initial render (before elements have been measured), it could affect scroll position tracking.

Mitigation: `contain-intrinsic-size: auto Npx` stabilizes `scrollHeight` with height estimates, and the `auto` keyword ensures measured heights are remembered. If `vscode-scrollable` still misbehaves, fall back to applying `content-visibility` only on leaf nodes (`.banner-details`, `.log-line`) rather than container nodes (`.log-group`).

**This needs to be tested, not assumed.** Apply the CSS, open a stream with 300+ entries, scroll through it, switch tabs, and verify scroll position stability.

---

## Fix 2: Narrow `willUpdate` guards to sort-relevant fields — DONE

> Commit: `353878c33` (perf: narrow willUpdate guards and clean up status SSOT)

**File: `ProgressApp.ts:186-244`**

The guard condition previously used `prevAppState.streamStates !== this.appState.streamStates` as a proxy check — Map identity as a stand-in for "did any sort-relevant field change?" The proxy was too broad because the Map changes for 13+ different reasons, but only `status` and `lastTimestamp` affect sorting and tab display.

### What was changed

When `streamStates` identity changes without a structural change (streams added/removed/filtered), the guard now iterates `cachedFilteredStreams` (~30 entries) and compares actual `status` and `lastTimestamp` values against the cached Maps. Only rebuilds when values differ:

- **Re-sort** only when sorting by time and timestamps actually changed.
- **Rebuild status/timestamp maps** only when values differ. This preserves Map identity → StreamTabs skips re-render.

### Why this works

- O(30) pointer comparisons ≈ 0.003ms. Negligible.
- Prevents ~3.5 wasted StreamTabs render cycles per second during streaming.
- No architectural changes. No data model restructuring. Just narrower guards.
- Follows the principle: **the guard condition should match the actual dependency, not a proxy.**

### Related: Backend status SSOT cleanup — DONE

> Commit: `353878c33`

Stream status previously lived in three places:

| Copy | Location                                         | Role                                                                                       |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1    | `StreamStatusService.statusMemory`               | Runtime truth. Agent execution writes here. Concurrency control (`tryAcquire`) reads here. |
| 2    | `ProgressViewState._streamStates[stream].status` | Backend view state. **Was a dead write — never authoritatively consumed.**                 |
| 3    | Frontend `streamStates.get(stream).status`       | Rendering state. Necessary (postMessage boundary).                                         |

**Copy 2 was redundant** and has been removed. `setStreamStatus()` no longer writes status into `_streamStates`. Status is read exclusively from `StreamStatusService` at message-sending time.

---

## What's Already Fixed (For Context)

### By the refactor (committed)

| Problem                                | Fix                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Single context triggers all components | Split into 3 contexts (meta, log, permissions)                               |
| Tab switch recreates entire DOM        | Per-stream DOM cache in LogList (LRU, max 5)                                 |
| Every metadata update re-renders logs  | `streamStates` vs `streamLogs` split in store                                |
| Full tree rebuild on every message     | Incremental append + ref-update paths in TaskGroupList                       |
| No CSS containment                     | `contain: layout style paint` on host, `contain: layout paint` on scrollable |

### By performance commits

| Problem                                        | Fix                                                               | Commit      |
| ---------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| Tab switch sends 4 separate messages           | Batched `SYNC_STREAM_CONTENT` (1 message)                         | `8832c5b79` |
| Tab switch waits for backend round-trip        | Optimistic `activeStreamId` set locally                           | `8832c5b79` |
| Stream delete waits for `syncFullView` rebuild | Optimistic local removal, fire-and-forget to backend              | `8832c5b79` |
| Permission action waits for backend resolve    | Optimistic local removal                                          | `8832c5b79` |
| Sort/filter triggers full backend sync         | Frontend-only state change, backend notified for persistence only | `8832c5b79` |
| O(n) log lookups during streaming              | `logIndex` Map for O(1) lookups                                   | `2edc4c401` |
| Broad `willUpdate` guards waste render cycles  | Narrowed to compare actual `status`/`lastTimestamp` values        | `353878c33` |
| Redundant status dead-write in `_streamStates` | Removed; `StreamStatusService` is sole SSOT                       | `353878c33` |
| Browser paints all DOM nodes during scroll     | `content-visibility: auto` on groups and entries                  | `353878c33` |
| Wasted serialization in `sendStreamMetadata`   | Trimmed to `StreamMetadata` (7 backend-owned fields + `kind`)     | uncommitted |

### Debunked concerns

| Claimed bottleneck                                                                | Why it's not real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| StreamTabs re-render during streaming                                             | `UPDATE_LOG` only touches `streamLogs`, not `streamStates`. Map identity unchanged. Status maps not rebuilt. Zero tab re-renders.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Map copies on every message                                                       | `new Map(30 entries)` ≈ 0.01ms. Noise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `repeat()` + `guard()` O(n) diffing                                               | 500 pointer comparisons ≈ 0.05ms. Noise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `updateCachedMessageRefs` full scan                                               | 500 pointer comparisons ≈ 0.01ms. Noise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `insertMessageSorted` array spread                                                | Only runs on APPEND_LOG (new messages), not UPDATE_LOG (streaming tokens). 500 pointer copies ≈ 0.005ms. Noise.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Unbatched messages during streaming                                               | Lit already coalesces synchronous state changes. Per-message cost ~1.5ms at 10Hz = 15ms/s. Within budget.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| O(n) `findIndex`/`some` in log handlers (`messageDispatcher.ts:465,476`)          | `UPDATE_LOG` handler calls `prev.logs.findIndex(entry => entry.id === logId)`. `APPEND_LOG` handler calls `prev.logs.some(entry => entry.id === logId)`. Both are O(n) per call. At 500 messages × 10Hz: 5,000 string comparisons/sec ≈ 0.05ms/sec. The array spread `[...prev.logs]` at line 491 adds another ~0.01ms/sec. Combined total ~0.1ms/sec. Noise. A `Map<id, index>` would make these O(1) but the absolute cost doesn't justify the complexity.                                                                        |
| O(n) `findIndex` in `replaceSingleMessage` (`TaskGroupList.ts:236,246`)           | After `updateCachedMessageRefs` identifies changed messages, `replaceSingleMessage` does `findIndex` within a single group's messages (O(k) where k = group size, typically 5–50). Not the full log array. Noise.                                                                                                                                                                                                                                                                                                                   |
| Full `streamStates` payload in `sendStreamMetadata` (`WebviewUpdater.ts:476-488`) | `getAllStreamStates()` sends full `StreamState` objects (including `taskGroups`, `runInstructions`, `runUsage`, `runFiles`) for all visible streams. The frontend's `mergeBackendOwnedState` (`messageDispatcher.ts:145-162`) only extracts 7 fields (`status`, `lastTimestamp`, `conversationProgress`, badges) and discards the rest. Wasted serialization — but all 4 call sites are structural events (new stream, filter change, visibility change, initialization), never the streaming hot path. Not a streaming bottleneck. |
| Redundant `conversationProgress`/badges in overlapping messages                   | Claimed: data sent in both `UPDATE_STREAMS` (embedded in `streamStates`) and `UPDATE_CONVERSATION_PROGRESS`/`UPDATE_STREAM_BADGES` (separate messages). Debunked: `handleSetActiveStream` (`ProgressEventHandler.ts:148-162`) uses mutually exclusive branches — `sendStreamMetadata` for new/filtered streams OR `syncActiveStreamState` for known streams. Never both. Frontend hydration via `mergeBackendOwnedState` + incremental messages is correct design.                                                                  |
| Zod `safeParse` on every incoming message                                         | `ProgressViewOutboundMessageSchema` is a discriminated union on `command`. Zod reads the discriminator field to select the matching branch — O(1) dispatch, not O(n) trial-and-error across all 30+ message types. Single parse at entry point (`dispatchMessage`), no re-parsing in handlers. Negligible overhead.                                                                                                                                                                                                                 |

---

## Cleanup: Trim `sendStreamMetadata` Payload — DONE

**Not a streaming bottleneck** but eliminated wasted serialization.

`sendStreamMetadata()` previously called `getAllStreamStates()` and sent full `StreamState` records (including `taskGroups`, `runInstructions`, `runUsage`, `runFiles`, etc.) for every visible stream. The frontend's `mergeBackendOwnedState()` discarded everything except 7 fields.

**Fix:** Introduced `StreamMetadataSchema` — a lightweight schema containing only `kind` + the 7 backend-owned fields. `sendStreamMetadata()` now builds `StreamMetadata` objects directly instead of passing through full `StreamState` records. The `UPDATE_STREAMS` message schema uses `StreamMetadataSchema` instead of `StreamStateSchema`.

**Files changed:**

- `src/shared/schemas/streamState.ts` — Added `StreamMetadataSchema` (extracted `BackendOwnedFieldsSchema` from `BaseStreamStateSchema`)
- `src/shared/schemas/progressView.ts` — `UpdateStreamsMessageSchema.streamStates` uses `StreamMetadataSchema`
- `src/progressView/managers/WebviewUpdater.ts` — `sendStreamMetadata()` builds trimmed metadata; `updateStreams()` accepts `StreamMetadata`
- `src/progressView/frontend/messageDispatcher.ts` — `mergeBackendOwnedState()` and `updateStreamInfo()` accept `StreamMetadata`; new-stream path uses `createStreamState(kind, metadata)` for proper defaults

---

## How to Verify

### Fix 1: `content-visibility: auto`

1. **Chrome DevTools → Performance tab** — Record while scrolling a stream with 300+ entries. Check the **Frames** row for dropped frames. In the flame chart, look for **Paint** task duration during scroll. After the fix, paint tasks should be shorter because the browser skips off-screen elements.

2. **Chrome DevTools → Rendering → Paint flashing** — Green rectangles show repainted regions. Before: entire scroll container repaints. After: only newly-visible entries repaint on scroll.

3. **Subjective scroll feel** — Open a stream with 300+ tool-use entries, scroll up and down rapidly, compare smoothness before and after.

### Fix 2: Narrower `willUpdate` guards

1. **Add `console.count('streamTabs-render')` to `StreamTabs.render()`** — During active streaming with 30 tabs, count should drop from ~3.5/s to near-zero (only firing on actual status changes).

2. **Chrome DevTools → Performance tab** — Record during active streaming. In the flame chart, look for `willUpdate` and `render` calls on `stream-tabs`. After the fix, these should only appear when `UPDATE_STREAM_STATUS` fires, not on every `UPDATE_CONVERSATION_PROGRESS` or `ADD_TASK_GROUP`.
