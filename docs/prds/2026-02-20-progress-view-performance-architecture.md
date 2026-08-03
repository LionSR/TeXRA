---
created: 2026-02-20
updated: 2026-02-21
---

# Progress View Performance & Architecture Analysis

> All claims verified against source code. Corrections from prior drafts noted inline.

---

## Table of Contents

1. [Component Tree & Render Cascade](#1-component-tree--render-cascade)
2. [Data Flow Architecture](#2-data-flow-architecture)
3. [Operation Complexity Table](#3-operation-complexity-table)
4. [Hot Spot Analysis](#4-hot-spot-analysis)
5. [Data Redundancy & Dead Fields](#5-data-redundancy--dead-fields)
6. [The Clobber Bug](#6-the-clobber-bug)
7. [Unnecessary Defensive Coding](#7-unnecessary-defensive-coding)
8. [Coupling & Separation of Concerns](#8-coupling--separation-of-concerns)
9. [Backend Code Smells & Responsibility Distribution](#9-backend-code-smells--responsibility-distribution)
10. [Lit Performance Audit](#10-lit-performance-audit)
11. [Memory & GC Pressure Analysis](#11-memory--gc-pressure-analysis)
12. [Surface Area & Ownership Audit](#12-surface-area--ownership-audit)
13. [Problems Ranked](#13-problems-ranked)
14. [Implementation Plan](#14-implementation-plan)
15. [Remaining Round-Trips & Couplings](#15-remaining-round-trips--couplings-post-refactoring)

---

## 1. Component Tree & Render Cascade

### Component Hierarchy (28 components)

```
ProgressApp (root, provides 3 contexts)
├── StreamTabs                          ← prop: streams[] (from cachedFilteredStreams)
│   └── StreamTab ×N                    ← prop: StreamTabInfo, active flag
├── ToolUseStreamContent                ← consumes: streamStateCtx, permissionsCtx
│   ├── StreamHeader                    ← props: streamInfo, streamState
│   ├── RequestPanels                   ← props: filteredPermissions[]
│   │   ├── ToolEditRequestPanel ×N
│   │   ├── BashRequestPanel ×N
│   │   ├── RetryRequestPanel ×N
│   │   └── ProposalRequestPanel ×N
│   ├── TodoList                        ← props: todos (from streamState)
│   ├── UsagePanel                      ← props: usage, contextState
│   ├── ContextManagement               ← props: contextState
│   ├── FileList                        ← props: files per round
│   ├── FollowUpInput                   ← props: 7 fields (mostly primitives)
│   └── QueuedFollowUps                 ← props: queuedMessages[]
├── WorkflowStreamContent               ← consumes: streamStateCtx, permissionsCtx
│   ├── StreamHeader
│   ├── InstructionPanel
│   ├── RequestPanels
│   ├── FollowupSection
│   └── FollowUpInput
├── LogList                              ← consumes: streamLogCtx ONLY
│   └── TaskGroupList ×N (cached, max 5) ← props: groups[], messages[]
│       ├── UserMessage ×N
│       ├── TerminalOutput ×N
│       ├── ToolTimer ×N
│       └── StatisticsPanel
└── (Shared) PermissionCard              ← props: single PermissionState
```

### Context Separation (Critical Design — already working well)

```
┌──────────────────────────────────────────────────────────────────────┐
│                  ProgressApp (3 context providers)                    │
│                                                                      │
│  ┌─────────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │ streamStateContext   │  │ streamLogContext  │  │ permissionsCtx│  │
│  │ (meta: status, ui,  │  │ (logs[], groups[])│  │ (approvals[]) │  │
│  │  todos, usage, etc) │  │                   │  │               │  │
│  └─────────┬───────────┘  └────────┬──────────┘  └──────┬────────┘  │
│            │                       │                     │           │
│   ┌────────▼──────────┐   ┌───────▼──────┐    ┌────────▼────────┐  │
│   │ToolUseContent     │   │  LogList      │    │ToolUseContent   │  │
│   │WorkflowContent    │   │  TaskGroupList│    │WorkflowContent  │  │
│   │StreamHeader       │   │              │    │RequestPanels    │  │
│   │TodoList, Usage... │   │              │    │                 │  │
│   └───────────────────┘   └──────────────┘    └─────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

Log appends (10Hz) ONLY trigger LogList/TaskGroupList.
Meta components are isolated. This is correct and should be preserved.
```

### Render Cascades by Update Type

#### A. Log Append (APPEND_LOG) — ~10Hz during streaming — EFFICIENT

```
APPEND_LOG arrives
  → streamLogs Map updated, streamStates Map UNCHANGED
  → willUpdate(): streamStateContext ref unchanged → skipped
  → Only LogList → TaskGroupList re-renders
  → appendNewMessages() O(k), guard() prevents re-render of existing messages
```

**Cost**: O(k) where k = new messages (usually 1). Already optimal.

#### B. UPDATE_STREAMS (from updateAll()) — THE PROBLEM

```
UPDATE_STREAMS arrives (ALL StreamTabInfo[] + ALL StreamStates)
  → updateStreamInfo(): O(N) Map copy + O(N) merge + per-stream spread
  → willUpdate(): getFilteredStreams() O(N log N)
  → updateContexts(): find active stream O(N)
  → ALL context consumers re-render (full tree invalidation)
```

**Cost**: O(N log N). Fires at 2Hz during streaming (progress throttle). **This is the main performance problem.**

#### C. Tab Switch — user-initiated — EFFICIENT

```
Tab click → setState({ activeStreamId })
  → willUpdate(): streams unchanged → cachedFilteredStreams skipped
  → updateContexts(): new stream/state/logs → both contexts update
  → LogList: display:none toggle (O(1) DOM, cached TaskGroupList)
  → Content: unmount old, mount new
```

**Cost**: O(1) for DOM (cached). Already optimal.

---

## 2. Data Flow Architecture

### updateAll() Call Sites (9 total, verified)

| #   | Location (ProgressEventHandler.ts) | Trigger                        | What Changed              | Needs Full Rebuild?                  |
| --- | ---------------------------------- | ------------------------------ | ------------------------- | ------------------------------------ |
| 1   | `ProgressViewProvider:312`         | Webview ready/visible          | Everything                | **Yes** — initial load               |
| 2   | `handleSetActiveStream:140`        | Stream becomes active          | Active stream ID only     | **No**                               |
| 3   | `handleSetTaskState:191`           | Task state set                 | Filter + category         | **Partial** — only if filter changes |
| 4   | `flushProgressUpdates:313`         | 500ms throttle fires           | Progress counters only    | **No** — just counters               |
| 5   | `handleUpdateActiveSubagents:349`  | Child agents update            | Subagent list on 1 stream | **No** — badge change                |
| 6   | `handleUpdateActiveProcesses:387`  | Processes update               | Process list on 1 stream  | **No** — badge change                |
| 7   | `handleSetParentStream:406`        | Parent-child set               | Parent stream ID          | **No** — metadata on 1 stream        |
| 8   | `setStreamStatus:582`              | Status on nonexistent stream   | New stream added          | **Yes** — structural                 |
| 9   | `initializeStreamForTaskGroup:641` | First task group on new stream | New stream added          | **Yes** — structural                 |

**Sites 2, 4, 5, 6, 7 are unnecessary full rebuilds.** They send 70-80KB when only ~200B of data changed.

### updateAll() internals (WebviewUpdater.ts:415-452, verified)

```
updateAll(state, statuses?, theme?):
  1. buildStreamInfos(state, statuses, filter)    — O(N log N): rebuild + sort ALL infos
  2. state.pickValidActiveStream(streamNames)      — O(N): validate active stream
  3. state.getAllStreamStates()                     — O(N): Object.fromEntries() copy
  4. this.updateStreams(streams, active, filter, streamStates)  — serializes everything
```

### updateStreamStatus() (targeted, already exists)

```
Used for EXISTING stream status changes.
Sends only: { stream, status, lastTimestamp }  — ~200 bytes.
Mutually exclusive with updateAll() within setStreamStatus() (line 575-586).
```

### Throttle mechanism (verified)

```
PROGRESS_THROTTLE_MS = 500  (exact, not approximate)
Mechanism: setTimeout, leading-edge buffer, flushes once per interval
Only calls updateAll() if ACTIVE stream has pending progress
Result: 10Hz progress events → 2Hz updateAll() calls
```

---

## 3. Operation Complexity Table

### Per updateAll() Call (100 streams)

| Step                          | Location | Complexity             | ~Cost       |
| ----------------------------- | -------- | ---------------------- | ----------- |
| buildStreamInfos()            | Backend  | O(N log N)             | ~1ms        |
| getAllStreamStates()          | Backend  | O(N) copy              | ~0.5ms      |
| JSON.stringify                | IPC      | O(total size) ~70-80KB | ~1-2ms      |
| postMessage                   | IPC      | overhead               | ~0.5ms      |
| updateStreamInfo() merge      | Frontend | O(N)                   | ~0.5ms      |
| getFilteredStreams() sort     | Frontend | O(N log N)             | ~0.5ms      |
| find() active stream          | Frontend | O(N)                   | ~0.1ms      |
| Full component tree re-render | Frontend | O(tree)                | ~2-5ms      |
| **Total**                     |          |                        | **~6-10ms** |

**At 2Hz (progress throttle): 12-20ms/sec of unnecessary work.**

### Efficient Paths (for comparison)

| Operation                  | Complexity | ~Cost  |
| -------------------------- | ---------- | ------ |
| APPEND_LOG → TaskGroupList | O(k)       | <1ms   |
| UPDATE_STREAM_STATUS       | O(1)       | <0.5ms |
| Tab switch (cached)        | O(1) DOM   | <1ms   |

---

## 4. Hot Spot Analysis

### Hot Spot #1: updateAll() on non-structural events (CRITICAL)

**Call sites**: 5 of 9 (sites 2, 4, 5, 6, 7)
**Frequency**: 2Hz (progress) + per-subagent/process/parent change
**Cost**: ~6-10ms per call, full tree invalidation
**At 100 streams, 2Hz**: 12-20ms/sec wasted

### Hot Spot #2: updateStreamInfo() merge clobber risk (MEDIUM)

**Location**: `messageDispatcher.ts:149-205`
**Problem**: `...backendState` spread overwrites ALL fields, then selective preservation re-applies frontend-owned fields. Fragile — see [Section 6: The Clobber Bug](#6-the-clobber-bug).

### Hot Spot #3: cachedFilteredStreams.find() (LOW)

**Location**: `ProgressApp.ts:286`
**Cost**: O(N) per call, on every updateContexts()
**Fix**: Use Map instead.

---

## 5. Data Redundancy & Dead Fields

### Verified Schema Fields

**StreamTabInfoSchema** (`shared/schemas/stream.ts:49-63`):

```
name, label, model?, agent?, agentCategory,
hasMultipleOutputs?, isRemote?, lastTimestamp?,
inputFile?, creationTimestamp?, status? (nullish),
executionId?, parentStreamId?
```

**BaseStreamStateSchema** (`shared/schemas/streamState.ts:53-69`):

```
info? (StreamTabInfo),          ← DEAD: written, never read
status? (optional),             ← CLOBBERED: backend sends undefined
logs[] (prefault []),           ← DEAD: always empty, frontend uses streamLogs Map
taskGroups[] (prefault []),
contextState?,
activeSubagents[], finishedSubagentCount,
activeProcesses[], finishedProcessCount,
conversationProgress
```

### Dead Fields (verified — safe to remove)

| Field                  | Schema                     | Evidence                                                                                                                                                                                               | Savings                  |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| **`StreamState.info`** | `BaseStreamStateSchema:54` | Written at `messageDispatcher.ts:195`, **zero reads** in entire frontend. Components get StreamTabInfo from `streams[]` array or `streamStateContext.streamInfo`.                                      | ~600B/stream             |
| **`StreamState.logs`** | `BaseStreamStateSchema:56` | Backend never populates (always `[]`). Frontend uses separate `streamLogs: Map<StreamTabId, StreamLogs>`. Seed logic at `messageDispatcher.ts:171` checks `backendState.logs.length > 0` — never true. | Schema bloat + confusion |

### Duplicated Fields (verified — need single source of truth)

| Field               | StreamTabInfo                                                              | StreamState                                                                                 | Notes                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`status`**        | `.nullish()` — set by backend `buildStreamInfo()` from StreamStatusService | `.optional()` — set by **frontend** UPDATE_STREAM_STATUS handler; backend sends `undefined` | StreamTabInfo has the backend truth. StreamState has the frontend-set value which gets clobbered by UPDATE_STREAMS.                                              |
| **`lastTimestamp`** | `.optional()` — set by backend from log messages                           | **NOT on StreamState at all**                                                               | ~~Prior draft claimed it's on both~~ — **CORRECTION**: `lastTimestamp` is ONLY on StreamTabInfo. No duplication, but it's a runtime value on an identity object. |

### Correction from prior draft

> The prior draft claimed `lastTimestamp` exists on both `StreamTabInfo` and `StreamState`. **This is wrong.** `lastTimestamp` is only on `StreamTabInfoSchema`. `BaseStreamStateSchema` does NOT have a `lastTimestamp` field. The sort function `compareByTime()` reads only from StreamTabInfo fields (`lastTimestamp ?? creationTimestamp ?? now`). There is no `compareByTimeWithStates` function.

---

## 6. The Clobber Bug

This is a subtle architecture issue discovered during verification:

### How it works

1. **Backend** creates StreamState via `createStreamState()` → `status` field is `undefined` (schema uses `.optional()`, no `.prefault()`)
2. **Backend** manages status separately via `StreamStatusService` (a global singleton), NOT via `_streamStates` Map
3. **Backend** sets status on `StreamTabInfo` via `buildStreamInfo()` reading from StreamStatusService
4. **Backend** sends `UPDATE_STREAMS` with `streamStates` from `getAllStreamStates()` — `status: undefined` for all streams
5. **Frontend** `updateStreamInfo()` does `...backendState` → overwrites `StreamState.status` with `undefined`
6. **Frontend** UPDATE_STREAM_STATUS handler (targeted) correctly sets `StreamState.status` to the real value
7. But if UPDATE_STREAMS arrives AFTER UPDATE_STREAM_STATUS, the spread **clobbers** the correctly-set status back to `undefined`

### Why fallback chains exist

The fallback chains are NOT just defensive coding — they **compensate for the clobber**:

```typescript
// StreamHeader:558 — REAL code
this.streamState?.status || this.stream?.status || STREAM_STATUS.READY
//                          ^^^^^^^^^^^^^^^^^^^^^^^^
//                          Falls back to StreamTabInfo.status (which IS set by backend)

// WorkflowStreamContent:209 — REAL code
.status=${state.status ?? streamInfo.status ?? ''}
//                         ^^^^^^^^^^^^^^^^
//                         Falls back to StreamTabInfo.status

// StreamTab:197 — REAL code (CORRECTION: only 2-level, not 3-level)
const status = stream.status ?? STREAM_STATUS.READY;
//             ^^^^^^^^^^^^^
//             Reads directly from StreamTabInfo (doesn't use StreamState at all)
```

> **Correction from prior draft**: StreamTab has a **2-level** fallback (`stream.status ?? READY`), not 3-level. There is no `liveStatus` variable. Only StreamHeader and WorkflowStreamContent have 3-level fallbacks.

### Implication for Phase 2

**We cannot simply remove `status` from StreamTabInfo** without first fixing the merge direction. If we remove `status` from StreamTabInfo, the fallback chain breaks, and clobbered `undefined` values would show `READY` for actively-running streams.

**Correct order**: Fix merge (Phase 2) → THEN remove status from StreamTabInfo (Phase 3).

---

## 7. Unnecessary Defensive Coding

### Backend guarantees via `.prefault()`

Zod v4 `.prefault()` on the schema guarantees these fields are ALWAYS present after `createStreamState()`:

| Field                        | Guarantee   | Frontend pattern                    | Necessary?                                  |
| ---------------------------- | ----------- | ----------------------------------- | ------------------------------------------- |
| `taskGroups`                 | Always `[]` | `state?.taskGroups ?? []`           | **No** — if state exists, taskGroups exists |
| `activeSubagents`            | Always `[]` | `state?.activeSubagents ?? []`      | **No** — same                               |
| `activeProcesses`            | Always `[]` | `state?.activeProcesses ?? []`      | **No** — same                               |
| `todos` (tool-use)           | Always `[]` | `state?.todos ?? []`                | **No** — same                               |
| `queuedFollowUps` (tool-use) | Always `[]` | `state?.queuedFollowUps ?? []`      | **No** — same                               |
| `finishedSubagentCount`      | Always `0`  | `state?.finishedSubagentCount ?? 0` | **No** — same                               |
| `conversationProgress`       | Always `{}` | `state?.conversationProgress ?? {}` | **No** — same                               |

### Frontend validates at entry point

`dispatchMessage()` in `messageDispatcher.ts` uses `ProgressViewOutboundMessageSchema.safeParse(raw)` — a Zod discriminated union validation. **After this point, all fields are guaranteed by schema.** Individual handlers don't need re-validation.

### What IS necessary

```typescript
stream.model ?? ''; // ✓ model is .optional() in schema
stream.agent ?? ''; // ✓ agent is .optional() in schema
stream.status ?? READY; // ✓ status is .nullish() + clobber bug
this.streamContext?.field; // ✓ context itself can be null (no active stream)
runFiles[runId] ?? {}; // ✓ Map lookup can return undefined
```

### Simplification opportunity

The `?? []` / `?? 0` patterns on `.prefault()` fields add noise and hide the actual contract. Once we trust the schema (which is validated at message entry), we can remove ~20+ unnecessary fallbacks, making the code clearer about what CAN actually be null vs what's guaranteed.

---

## 8. Coupling & Separation of Concerns

### Who Reads What (verified)

```
                    streams[]   streamStates   streamLogs   permissions
                    (TabInfo[])    (Map)          (Map)       (array)
                    ─────────   ────────────   ──────────   ───────────
ProgressApp:
 willUpdate/sort:      ✓
 updateContexts:       ✓            ✓             ✓
 render:               ✓                                       ✓

StreamTabs:            ✓
 └ StreamTab:          ✓(info)

ToolUseContent:                    ✓(ctx)                      ✓(ctx)
 └ StreamHeader:       ✓(prop)     ✓(prop)
 └ TodoList:                       ✓(indirect)
 └ UsagePanel:                     ✓(indirect)
 └ FollowUpInput:                  ✓(indirect)
 └ RequestPanels:                                              ✓(prop)

WorkflowContent:                   ✓(ctx)                      ✓(ctx)
 └ StreamHeader:       ✓(prop)     ✓(prop)
 └ FollowupSection:    ✓(prop)     ✓(indirect)
 └ InstructionPanel:               ✓(indirect)

LogList:                                          ✓(ctx)
 └ TaskGroupList:                                 ✓(indirect)
```

### Coupling Problem: Implicit Field Ownership in Merge

The merge in `updateStreamInfo()` must manually enumerate preserved fields:

```typescript
nextStates.set(stream.name, {
  ...backendState,                          // CLOBBERS everything first
  taskGroups: existing?.taskGroups ?? ...,   // manual recovery
  ...(preserveWorkflow && { ... }),          // manual recovery (6 fields)
  ...(preserveUI && { ui: existing.ui }),    // manual recovery
  info: stream,                             // overwrite with fresh TabInfo
} as StreamState);                          // type cast hides mismatch
```

**Risk**: Adding a new frontend-owned field requires remembering to add it to the preservation list. Forgetting = silent data loss on every UPDATE_STREAMS.

**Fields currently at risk of clobber** (verified by tracing what backend sends as `undefined`):

- `status` — backend sends `undefined`, frontend sets real value → **CLOBBERED** (recovered via fallback chain)
- `toolEditBypass`, `superYoloBypass` — set by frontend handlers, backend sends schema defaults → **potentially clobbered**

---

## 9. Backend Code Smells & What's Actually Worth Fixing

> **Linus test applied**: We investigated whether "domain decomposition" (splitting into StreamLifecycleCoordinator, ContentPublisher, ApprovalCoordinator, StatsPublisher) would reduce complexity. **It would not.** The coupling is linear (Provider → EventHandler → State), approval handling is already isolated via generic `ApprovalRequestHandler<T,K>`, model management is already clean (async + TTL cache). Creating domain classes would add ~200 lines of new interfaces while all classes still share `ProgressViewState`. Same coupling, more files.

### What's Already Well-Designed (Leave Alone)

| Component                      | Why It's Fine                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approval handlers**          | Generic `ApprovalRequestHandler<T,K>` (38 lines) with injected callbacks. Zero coupling to stream state. Already isolated.                                                                                                                        |
| **Model management**           | `getCachedModelOptions()` + `sendProposalModelOptions()`: async + 30s TTL cache. No tangling.                                                                                                                                                     |
| **ProgressViewState managers** | StreamTabsManager, TaskGroupManager, OutputFilesManager, UsageStatsManager are correctly scoped domains. They ARE the right abstraction. 50% of ProgressViewState methods are getter delegation (noise), but inlining wouldn't reduce complexity. |
| **Linear dependency chain**    | Provider → EventHandler → State is a clean hierarchy, not spaghetti. Each layer has a clear role.                                                                                                                                                 |

### What's Actually Wrong

#### Problem 1: refreshStreamSurface() — Bad Name + Opaque Bundling

`refreshStreamSurface()` (ProgressEventHandler.ts:468-557) bundles 4 independent operations:

```
refreshStreamSurface(streamId):
  → Load + send UPDATE_LOGS (messages, groups, files, usage, context)
  → Load + send UPDATE_TODOS
  → Load + send UPDATE_QUEUED_FOLLOW_UPS
  → Load + send UPDATE_INSTRUCTION (conditional)
```

**Verified**: The 4 operations have **zero shared computation**. Logs don't depend on todos. Follow-ups don't depend on instructions. They were lumped together for convenience.

**Verified**: ALL 4 callers need all 4 operations. No caller skips any of them. So the bundling isn't wrong — the name and opacity are.

**Fix** (30 minutes, zero new classes):

```typescript
// BEFORE: opaque name, callers can't tell what it does
this.refreshStreamSurface(streamId, { updateInstruction: true });

// AFTER: rename + extract 4 focused methods
private hydrateStreamContent(stream: ActiveStreamId): StorageKey | null {
  this.sendStreamLogs(stream);       // independent: loads messages+groups, sends UPDATE_LOGS
  this.sendStreamTodos(stream);      // independent: loads todos, sends UPDATE_TODOS
  this.sendStreamFollowUps(stream);  // independent: loads queue, sends UPDATE_QUEUED_FOLLOW_UPS
  return stream ? this.state.getActiveRunId(stream) : null;
}
// sendInstructionUpdate() already exists as a separate method
```

Each extracted method is 10-15 lines, independently testable, and the name tells you exactly what it sends. The orchestrator becomes a 4-line method that composes them.

#### Problem 2: updateWebview() → updateAll() → refreshStreamSurface() Naming

Three methods with overlapping names but completely different scopes:

| Method                   | Actually Does                                                                  | Better Name                              |
| ------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------- |
| `updateWebview()`        | Orchestrates full rebuild: stream metadata + content hydration + bypass states | `rebuildViewState()` or `syncFullView()` |
| `updateAll()`            | Sends stream list + active stream + theme. Does NOT send content.              | `sendStreamMetadata()`                   |
| `refreshStreamSurface()` | Full content hydration: 4 separate messages                                    | `hydrateStreamContent()`                 |

A developer calling `updateAll()` expects everything to update. It doesn't — you also need `refreshStreamSurface()`. The name actively misleads.

#### Problem 3: "update" Naming Collision (15+ methods)

```
updateWebview()               → orchestrates full rebuild (sends 5+ message types)
updateAll()                   → sends stream metadata only (1 message)
updateStreams()               → sends 1 UPDATE_STREAMS message
updateStreamStatus()          → sends 1 UPDATE_STREAM_STATUS message
updateLogContent()            → sends 1 UPDATE_LOGS message
updateTodos() / updateFiles() → sends 1 message each
... (10 more)
```

No naming convention distinguishes "orchestrates multiple messages" from "sends one message." Fix: orchestrators get verbs like `rebuild`/`sync`/`hydrate`. Single-message senders keep `send` prefix on WebviewUpdater.

#### Problem 4: Inconsistent Handler Patterns

ProgressEventHandler uses 3 different patterns with no rule for which to use:

```typescript
// Pattern 1: handle → process (with queue + error wrapper)
handleAddTaskGroup = (data) => {
  withEventErrorHandling('TaskGroup', '...', () =>
    streamEventQueue.enqueue(data.streamId, () => this.processAddTaskGroup(data))
  );
};

// Pattern 2: handle with inline logic (no queue)
handleSetActiveStream = (payload) => {
  withEventErrorHandling('StreamSelection', '...', () => {
    this.state.updateStreamHints(...);
    this.webviewUpdater.updateAll(...);
    this.refreshStreamSurface(...);
  });
};

// Pattern 3: handle with only state mutation
handleUpdateConversationProgress = (data) => {
  withEventErrorHandling('Progress', '...', () => {
    this.state.updateStreamState(...);
    this.pendingProgressUpdates.set(...);
  });
};
```

**Rule that should exist**: Use `handle→process` delegation with queue ONLY for handlers that need per-stream serialization (task groups, logs). All others use inline logic. Document the rule.

#### Problem 5: ProgressViewMessageHandler — 43 Handlers, No Grouping

1362 lines, flat handler registry mixing: UI state, stream lifecycle, execution control, file operations, text enhancement, approval workflows. The followup handlers alone are 310 lines.

**Fix**: Group handlers with comments/sections. Extract followup logic (310 lines) into a separate `FollowupHandler` class — this one IS worth extracting because it has its own state (file mappings, validation, rendering).

### What Domain Decomposition Would Actually Cost (Evaluated and Rejected)

We evaluated creating `StreamLifecycleCoordinator`, `ContentPublisher`, `ApprovalCoordinator`, `StatsPublisher`:

| Question                                   | Answer                                                               | Implication                        |
| ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------- |
| Do coordinators share `ProgressViewState`? | YES — all 4 need it                                                  | Coupling stays the same            |
| Do coordinators reference each other?      | YES — ContentPublisher needs "is stream initialized?" from lifecycle | New cross-domain interfaces needed |
| Can each be tested in isolation?           | NO — all depend on mutable shared state                              | Testing doesn't improve            |
| How many new files + interfaces?           | 4 classes + 4 interfaces + wiring                                    | ~200 lines added                   |
| Net complexity change?                     | **Increases** — same coupling, more indirection                      | Not worth it                       |

**The backend's linear dependency chain (Provider → EventHandler → State) is already a reasonable architecture.** The problems are naming, method decomposition, and one 310-line handler that should be extracted. Not structural.

---

## 10. Lit Performance Audit

### Already Optimal (preserve these)

| Pattern                          | Evidence                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| `repeat()` with stable keys      | StreamTabs (`stream.name`), TaskGroupList (`m.id`), RequestPanels, FileList |
| Separate contexts (logs vs meta) | 10Hz APPEND_LOG only triggers LogList, not meta components                  |
| Per-stream DOM cache (LogList)   | Max 5 cached TaskGroupLists, `display:none` toggle                          |
| Incremental message append       | TaskGroupList: O(k) append, O(1) ref update, guard() directive              |
| Bound method handlers            | `@click=${this.handleXYZ}` throughout, no inline arrows in repeat()         |
| Memoized derived values          | `filteredPermissions`, `runGroups`, `cachedTree` in willUpdate()            |
| Markdown render cache            | LRU 2000 entries with FNV-1a hash                                           |
| Conditional rendering            | `nothing` for collapsed groups, empty states                                |

### Could Improve (minor)

| Pattern                   | Impact | Recommendation                     |
| ------------------------- | ------ | ---------------------------------- |
| CSS `contain`             | Low    | Add to tab containers, log entries |
| Active stream lookup O(N) | Low    | Replace `find()` with `Map.get()`  |

### No Need for Virtual Scrolling Yet

TaskGroupList collapses hide their DOM. Users typically interact with last 50-100 entries. The bottleneck is the data flow (updateAll), not the rendering of visible DOM. Fix the data flow first.

---

## 11. Memory & GC Pressure Analysis

### Problem: Death by a Thousand Allocations

The progress view has no single large memory leak, but constant allocation churn during streaming creates sustained GC pressure that compounds the CPU cost of unnecessary updateAll() calls.

### 10a. Map Copies per Message (verified, messageDispatcher.ts)

Every state mutation creates full Map copies because Lit's `@state()` needs new references to trigger re-render:

| Handler              | Maps Copied                                     | Frequency               |
| -------------------- | ----------------------------------------------- | ----------------------- |
| UPDATE_STREAMS       | `new Map(streamStates)` + `new Map(streamLogs)` | 2Hz (progress throttle) |
| UPDATE_STREAM_STATUS | `new Map(streamStates)`                         | Per status change       |
| APPEND_LOG           | `new Map(streamLogs)` via `setStreamLogs()`     | ~10Hz during streaming  |
| UPDATE_LOG           | `new Map(streamLogs)` via `setStreamLogs()`     | ~10Hz during streaming  |
| SET_FOLLOWUP_OPTIONS | `new Map(followupOptionsByStream)`              | Per followup            |
| DELETE_STREAM        | `new Map(streamStates)` + `new Map(streamLogs)` | Per delete              |

**At 100 streams, 10Hz streaming**: ~10 Map copies/sec, each O(100) entries. Each copy allocates a new Map + 100 entry slots → **~1000 allocations/sec just from Maps**.

### 10b. Object Spreads (verified, messageDispatcher.ts)

**47 `{ ...prev, field }` spreads** across message handlers. During streaming, typical path hits 3-5 nested spreads per message:

- `{ ...state, streamLogs: nextLogs }` (top-level)
- `{ ...prev, logs: [...prev.logs, msg] }` (StreamLogs)
- Each creates a shallow copy for GC

**3 context objects** created per `updateContexts()` call (ProgressApp.ts:318-350). At 10Hz streaming (log updates), that's **~30 context object allocations/sec**, though the ref-equality checks prevent most from actually propagating.

### 10c. Markdown LRU Cache — Unbounded by Content Size

**Location**: `markdownRenderer.ts:29-30`

- Fixed at 2000 entries, evicts by count (not content size)
- No per-entry size tracking
- Worst case: 2000 entries × 20-50KB (large LaTeX/code blocks) = **40-100MB**
- Typical case: 2000 entries × 2-5KB = **4-10MB** — acceptable
- FNV-1a hash is fast but has no collision tracking

**Risk**: Not a problem in normal use, but could spike with many large code blocks or LaTeX renders.

### 10d. streamLogs Map Leak on Clear

**Location**: `messageDispatcher.ts` UPDATE_LOGS handler with `action: 'clear'`

- Sets logs to empty `{ logs: [] }` but **does not delete the Map entry**
- DELETE_STREAM and DELETE_ALL correctly delete entries
- Over a long session with many stream activations/deactivations, empty entries accumulate

**Impact**: Minor (empty entries are small), but violates the principle that clearing should release.

### 10e. LogList DOM Cache — Holding Message Arrays

**Location**: `LogList.ts:108`, `CachedStream` interface at line 64

- 5 cached TaskGroupLists, each holding full `messages: LogMessageData[]` and `groups: TaskGroup[]`
- On cache eviction (LRU, line 208-214), the old `CachedStream` entry is deleted from the Map
- **But** the DOM elements (TaskGroupList) may retain references to their last-rendered data until the element is actually disconnected and GC'd

**Impact**: With 5 cached streams × 500 messages each at ~1KB/message = **~2.5MB** held in cache. Acceptable, but worth noting.

### 10f. getAllStreamStates() Full Copy (backend, on every updateAll)

**Location**: `ProgressViewState.ts:290`

```typescript
return Object.fromEntries(this._streamStates.entries());
```

- Creates a new `Record<string, StreamState>` object + N entry references
- At 100 streams: ~100 property assignments per call, 2Hz = 200/sec
- StreamState objects themselves are shared (references), so the copy is shallow

**Impact**: Low individually, but compounds with the 70-80KB serialization cost.

### Memory Summary

| Source          | Per-Second Cost (100 streams, streaming) | Fix                                                              |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| Map copies      | ~1000 slot allocations                   | Phase 3 eliminates most (targeted messages skip full-state copy) |
| Object spreads  | ~50-150 object allocations               | Structural (Lit needs new refs); reduce nesting depth            |
| Context objects | ~30 small objects                        | Already has ref-equality guards; minor                           |
| Markdown cache  | Static 4-10MB (typical)                  | Add content-size cap                                             |
| streamLogs leak | Grows by empty entries                   | Delete Map entry on clear                                        |
| DOM cache       | Static ~2.5MB (5 streams)                | Acceptable                                                       |

**Key insight**: Phase 3 (targeted messages) fixes both the CPU hot spot AND the memory churn. When flushProgressUpdates sends a 100B `UPDATE_CONVERSATION_PROGRESS` instead of a 70KB UPDATE_STREAMS, we skip: the `Object.fromEntries()` copy, the full JSON serialization, the `new Map()` copies in `updateStreamInfo()`, and the context re-creation cascade. The memory savings compound with the CPU savings.

---

## 12. Surface Area & Ownership Audit

### The Numbers

| Metric                           | Count                                             | Assessment                                                                                                |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Total TypeScript lines           | **18,738** across 92 files                        | Large for a "progress board"                                                                              |
| Message types (backend→frontend) | **34**                                            | Should be ~20                                                                                             |
| Message handlers (frontend)      | **33** (14 trivial one-liners)                    | 14 one-liners = sign of over-fragmented messages                                                          |
| StreamState fields (all schemas) | **44** (25 top-level + nesting)                   | Wide shape flowing through entire system                                                                  |
| WebviewUpdater methods           | **28**                                            | Each sends 1 message — thin passthroughs                                                                  |
| ProgressViewState methods        | **27+** (plus private helpers)                    | God object: delegates to 5 managers                                                                       |
| Manager classes                  | **5** (1 thin wrapper, 2 moderate, 2 non-trivial) | RunInstructionManager: 91 lines, 1 caller (thin); UsageStatsManager: 165 lines, has real validation logic |
| Top 5 files combined             | **2,990 lines**                                   | messageDispatcher(759) + EventHandler(681) + State(591) + App(499) + Updater(460)                         |

### Field Ownership Matrix

Every field on StreamState must have ONE owner. Currently, ownership is implicit and scattered.

```
FIELD                        BACKEND WRITES    FRONTEND WRITES    CLOBBER RISK
─────────────────────────    ──────────────    ───────────────    ────────────
kind                         UPDATE_STREAMS    never              None
status                       (sends undefined) UPDATE_STREAM_STATUS  YES ◄──
info                         UPDATE_STREAMS    never              N/A (dead)
logs                         (sends [])        never              N/A (dead)
taskGroups                   (sends [])        ADD/UPDATE_TASK_GROUP  Preserved*
contextState                 UPDATE_STREAMS    UPDATE_CONTEXT_STATE   YES
activeSubagents              UPDATE_STREAMS    never              None
finishedSubagentCount        UPDATE_STREAMS    never              None
activeProcesses              UPDATE_STREAMS    never              None
finishedProcessCount         UPDATE_STREAMS    never              None
conversationProgress         UPDATE_STREAMS    never              None

── Tool-Use only ──
todos                        (sends [])        UPDATE_TODOS       Preserved*
queuedFollowUps              (sends [])        UPDATE_QUEUED_*    Preserved*
toolEditBypass               (sends undefined) UPDATE_TOOL_EDIT_* YES ◄──
superYoloBypass              (sends undefined) UPDATE_SUPER_YOLO_* YES ◄──
sessionUsage                 (sends null)      UPDATE_RUN_USAGE   YES ◄──
ui.followUpText              never             FOLLOW_UP_TEXT_*   YES ◄──
ui.polishedText              never             FOLLOW_UP_TEXT_*   YES ◄──
ui.polishRevision            never             FOLLOW_UP_TEXT_*   YES ◄──
ui.transcribedText           never             FOLLOW_UP_TEXT_*   YES ◄──
ui.recording                 never             RECORDING_*        YES ◄──
ui.shouldFocusFollowUp       never             multiple           YES ◄──

── Workflow only ──
runInstructions              (sends {})        UPDATE_INSTRUCTION  Preserved*
runUsage                     (sends {})        UPDATE_RUN_USAGE    Preserved*
runFiles                     (sends {})        UPDATE_FILES        Preserved*
runMissingOutputs            (sends {})        UPDATE_MISSING_*    Preserved*
activeRunId                  (sends null)      UPDATE_LOGS         Preserved*
followupMode                 (sends default)   UPDATE_LOGS         Preserved*
ui.selectedRunId             never             UI interaction      YES ◄──

* = Preserved by manual logic in updateStreamInfo() merge
◄── = At risk because ...backendState spread clobbers, then
      selective recovery may not cover it
```

**12+ fields are at clobber risk** (5 top-level + 7 nested `ui.*` sub-fields). The merge manually recovers `ui` (as a block), `taskGroups`, and workflow fields — but `status`, `toolEditBypass`, `superYoloBypass`, `sessionUsage`, and `contextState` have NO preservation logic. They get silently overwritten by backend defaults on every UPDATE_STREAMS. The `ui` block IS preserved via `preserveUI`, but this is fragile — if the conditional fails (e.g., kind mismatch), all 6-7 `ui.*` sub-fields are also clobbered.

### What Clean Ownership Looks Like

**Rule: Each field has exactly ONE writer. The other side never touches it.**

```
BACKEND-OWNED (set by backend, frontend reads only):
  kind, activeSubagents, finishedSubagentCount,
  activeProcesses, finishedProcessCount, conversationProgress

STATUS (special — set by backend StreamStatusService, sent via dedicated message):
  status, lastTimestamp → move to StreamState, backend always populates

FRONTEND-OWNED (set by frontend handlers, backend never sends):
  ui (all sub-fields), taskGroups, todos, queuedFollowUps,
  toolEditBypass, superYoloBypass, sessionUsage,
  contextState (set by targeted UPDATE_CONTEXT_STATE only)

WORKFLOW FRONTEND-OWNED:
  runInstructions, runUsage, runFiles, runMissingOutputs,
  activeRunId, followupMode

DEAD (remove):
  info, logs
```

**With this ownership model, the merge becomes trivial:**

```typescript
// New stream: take backend defaults for backend-owned, create defaults for frontend-owned
// Existing stream: only overwrite backend-owned fields, never touch frontend-owned
```

No manual preservation lists. No `as StreamState` casts. No clobber.

### Message Consolidation Opportunities

34 messages is too many. Many are trivially similar.

**Design principle: Send state, not event names.** If the backend knows the full state transition, send the new state — don't encode the transition as a message type. A `PERMISSION_UPDATE { kind, action, data }` is more self-describing than six separate SHOW/RESOLVE messages that each call the same `prepend`/`filter` on the same array.

**Why SHOW/RESOLVE pairs are over-engineered**: The "complicated" resolve logic exists because each permission type has its own SHOW and RESOLVE message, its own WebviewUpdater method, and its own handler — but they ALL do the same thing:

- SHOW: `permissions = [newPerm, ...permissions]`
- RESOLVE: `permissions = permissions.filter(p => p.requestId !== id)`

That's 6 messages, 6 WebviewUpdater methods, 6 handlers, for two array operations. The out-of-order race for proposals (where RESOLVE arrives before SHOW) becomes a 3-line `if` check inside a single handler instead of needing a separate `resolvedBeforeShown` Set.

**Same pattern repeats**: Recording (3 messages → 1 boolean toggle), follow-up text (3 messages → 1 with `kind`), bypass toggles (2 messages → 1 with `type`).

| Current (34)                                                                | Proposed (~20)                                                    | Reduction |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| SHOW/RESOLVE_TOOL_EDIT (2) + SHOW/RESOLVE_BASH (2) + SHOW/RESOLVE_RETRY (2) | `PERMISSION_UPDATE { kind, action: 'show'\|'resolve', data }` (1) | -5        |
| RECORDING_STARTED, STOPPED, ERROR (3)                                       | `UPDATE_RECORDING { status }` (1)                                 | -2        |
| FOLLOW_UP_POLISHED, POLISH_ERROR, TRANSCRIBED (3)                           | `UPDATE_FOLLOW_UP_TEXT { kind, text }` (1)                        | -2        |
| SHOW/RESOLVE_AGENT_PROPOSAL (2)                                             | `PROPOSAL_UPDATE { action, data }` (1)                            | -1        |
| UPDATE_TOOL_EDIT_STATE + UPDATE_SUPER_YOLO_STATE (2)                        | `UPDATE_BYPASS { type, active }` (1)                              | -1        |
| **NEW**: SET_ACTIVE_STREAM (Phase 3)                                        |                                                                   | +1        |
| **NEW**: UPDATE_STREAM_BADGES (Phase 3)                                     |                                                                   | +1        |
| **NEW**: UPDATE_CONVERSATION_PROGRESS (Phase 3)                             |                                                                   | +1        |

**Net: 34 → ~23 message types** (32% reduction). The resolve/dismiss logic that today spans 12+ functions collapses to 2 array operations in 1 handler.

### Manager Classes: Thin Wrappers to Inline

| Manager               | Lines | Methods | Callers                   | Verdict                                                                        |
| --------------------- | ----- | ------- | ------------------------- | ------------------------------------------------------------------------------ |
| RunInstructionManager | 91    | 6       | **1** (ProgressViewState) | **Inline** — just a Map with serialize                                         |
| TaskGroupManager      | 134   | 7       | 2                         | **Inline** — Map + save + `endRunningGroups()` logic                           |
| UsageStatsManager     | 165   | 5       | 2                         | **Keep** — has schema coercion, validation assertions, `isEmptyUsage()` helper |
| StreamTabsManager     | 234   | 10      | 3                         | **Keep** — debounce logic is non-trivial                                       |
| OutputFilesManager    | 397   | 18      | 3                         | **Keep** — triple-nesting, migration logic                                     |

RunInstructionManager is a thin Map wrapper (91 lines, 1 caller) — safe to inline. TaskGroupManager (134 lines) has some domain logic (`endRunningGroups`) but is still mostly Map delegation — inline with care. UsageStatsManager (165 lines) has real validation logic (schema coercion, compile-time assertions, `isEmptyUsage()`) — should stay as a separate module.

### WebviewUpdater: Thin Passthroughs

28 public methods, most are:

```typescript
updateTodos(stream, todos) {
  this.sendMessage({ command: UPDATE_TODOS, stream, todos });
}
```

This is a message-builder, not a real abstraction. Each method wraps `sendMessage()` with field assignment. Options:

1. **Keep as-is** — it provides type safety at call sites (IDE autocomplete)
2. **Reduce** — consolidate SHOW/RESOLVE pairs, bypass toggles, recording into ~18 methods
3. **Eliminate** — callers construct messages directly, type safety from message schemas

Recommendation: Option 2. The type safety is valuable, but 28 near-identical methods is excessive. ~18 after consolidation.

---

## 13. Problems Ranked

| P       | Problem                                                                 | Impact                                                                                                    | Fix Difficulty | Regression Risk                              |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------- |
| **P0**  | `updateAll()` on 5 non-structural events                                | 70-80KB serialize + full tree invalidation at 2Hz                                                         | Medium         | **Low** — new messages, old ones still work  |
| **P1**  | `...backendState` spread clobbers 12+ frontend fields                   | Silent data loss: status, bypass flags, sessionUsage, contextState + nested ui.\* fields if kind mismatch | Medium         | **Low** — reversing spread direction is safe |
| **P2**  | Dead fields: `info`, `logs` on StreamState                              | Wasted memory + IPC + schema confusion                                                                    | Easy           | **None** — written, never read               |
| **P3**  | No explicit field ownership (backend vs frontend)                       | Merge must enumerate preserved fields; forgetting = data loss                                             | Medium         | **Low** — makes ownership explicit           |
| **P4**  | `status` duplicated on StreamTabInfo + StreamState with fallback chains | 2 components compensate for clobber; stale data confusion                                                 | Medium         | **Medium** — must fix clobber first          |
| **P5**  | 34 message types (14 are one-liner handlers)                            | Surface area bloat, 34 WebviewUpdater methods, 33 handlers                                                | Medium         | **Low** — consolidation, same data           |
| **P6**  | 2 thin manager classes (RunInstruction, TaskGroup)                      | ~225 lines wrapping Maps with 1-2 callers each                                                            | Easy           | **None** — inline into ProgressViewState     |
| **P6b** | GC pressure from Map copies + object spreads                            | ~1000 Map slot allocations/sec + ~150 object copies/sec during streaming                                  | Low            | **None** — internal allocation patterns      |
| **P7**  | ~20+ unnecessary `?? []` fallbacks on `.prefault()` fields              | Code noise, hides actual contracts                                                                        | Easy           | **None** — removing no-ops                   |
| **P8**  | `getAllStreamStates()` O(N) copy + O(N) find()                          | ~0.6ms per updateAll()                                                                                    | Easy           | **None** — internal                          |
| **P9**  | `refreshStreamSurface()` opaque name + bundled 4 independent sends      | Callers can't tell what it triggers; name misleads ("refresh" vs full hydration)                          | Easy           | **None** — rename + extract 4 methods        |
| **P10** | "update" naming collision (15+ methods, all different semantics)        | Developers can't predict what a method does from its name                                                 | Easy           | **None** — rename only                       |
| **P11** | refreshStreamSurface cascade (4 messages → 4 render cycles per switch)  | User-visible latency on tab switch; 4 separate state+render passes for 1 action                           | Medium         | **Low** — batch into 1 message               |
| **P12** | ProgressViewMessageHandler followup logic (310 lines in one handler)    | Hard to test, hard to read, mixes validation + file mapping + rendering + execution                       | Medium         | **Low** — extract to FollowupHandler         |

---

## Implementation Status (as of 2026-02-20)

All 6 phases have been implemented on branch `codex/progress-view-prd-refactor`.

| Phase | Description                                        | Status   | Notes                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Remove Dead Weight (P2 + P6)                       | **DONE** | All 6 sub-items complete. Dead fields (`info`, `logs`) removed from schema. `RunInstructionManager` inlined. `find()` → `Map.get()`. `refreshStreamSurface` → `hydrateStreamContent` with extracted methods. `updateAll` → `sendStreamMetadata`.                                                    |
| **2** | Fix Field Ownership and Merge (P1 + P3)            | **DONE** | `mergeBackendOwnedState()` replaces clobber-then-recover pattern. `as StreamState` casts and `preserveUI`/`preserveWorkflow` conditionals deleted. Frontend-owned fields have ownership comments in schema (backend-owned field comments still missing).                                            |
| **3** | Split updateAll() into Targeted Messages (P0)      | **DONE** | All 5 sites converted: `SET_ACTIVE_STREAM`, `UPDATE_CONVERSATION_PROGRESS`, `UPDATE_STREAM_BADGES` (shared by subagents + processes), `UPDATE_PARENT_STREAM`. Schemas, commands, WebviewUpdater methods, and frontend handlers all in place.                                                        |
| **4** | Single Source of Truth for Status (P4)             | **DONE** | `status` and `lastTimestamp` moved to `BaseStreamStateSchema`, removed from `StreamTabInfoSchema`. Backend writes status to `_streamStates`. Fallback chains simplified. `StreamTab` receives status as primitive prop. Sort reads `lastTimestamp` from `StreamState` via callback.                 |
| **5** | Consolidate Messages (P5)                          | **DONE** | Approvals (6→1 `UPDATE_PERMISSION`), Recording (3→1 `UPDATE_RECORDING`), Follow-up text (3→1 `UPDATE_FOLLOW_UP_TEXT`), Bypass (2→1 `UPDATE_BYPASS`), Proposals merged into `UPDATE_PERMISSION`. Current count: 26 outbound messages (vs target ~23; delta is 4 new targeted messages from Phase 3). |
| **6** | Inline Thin Managers + Remove Noise + Memory Fixes | **DONE** | `TaskGroupManager` inlined. Unnecessary `?? []`/`?? 0` fallbacks removed. CSS `contain: layout style paint` added to log containers. `streamLogs` Map entry properly deleted on clear. Markdown cache has per-entry (200KB) and total (2MB) content-size caps.                                      |

### Remaining Items (Minor)

| Item                                                                                  | Status          | Notes                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend-owned field comments in `BaseStreamStateSchema`                               | **NOT DONE**    | Frontend-owned fields are documented, but `status`, `lastTimestamp`, `conversationProgress`, etc. in `BaseStreamStateSchema` lack ownership comments |
| Section 15 round-trip optimizations (fire-and-forget, optimistic UI, batched surface) | **NOT STARTED** | Lower priority post-refactoring items documented in Section 15                                                                                       |

---

## 14. Implementation Plan (Internal Cleanup, Zero UI Regression)

> **Guiding principle**: Cleaner = faster = less code. Every removed field, every inlined wrapper, every consolidated message is less surface area for bugs and less work for the runtime. We are not adding features. We are removing indirection until the code says exactly what it means.
>
> **Verification per phase**: (1) `npm run typecheck`, (2) visual inspection — same UI, (3) manual test — streams appear, update, switch, show status correctly.
>
> **Anti-mixed-state rule**: Each phase must ship as one atomic PR. New code and legacy removal happen in the same commit. Never leave both old and new paths alive — that's how you get bugs where half the system uses the old path and half uses the new.

### Phase 1: Remove Dead Weight (P2 + P6 — Easy, Zero Risk)

**Goal**: Delete fields and wrappers that exist but serve no purpose.

**1a. Remove `StreamState.info`** (dead field)

- `shared/schemas/streamState.ts:54` — delete `info: StreamTabInfoSchema.optional()`
- `messageDispatcher.ts:195,200` — delete `info: stream` assignments
- Verified: zero reads in entire frontend.

**1b. Remove `StreamState.logs`** (dead legacy field)

- `shared/schemas/streamState.ts:56` — delete `logs: z.array(LogMessageDataSchema).prefault([])`
- `messageDispatcher.ts:171-173` — delete seed logic (`backendState.logs.length > 0` is never true)
- Verified: frontend uses `streamLogs Map` exclusively. This field is always `[]`.

**1c. Inline RunInstructionManager** (91 lines, 1 caller)

- Move its Map + serialize/deserialize into ProgressViewState directly.
- Delete the file. Delete the delegation methods.

**1d. Replace `find()` with Map for active stream lookup**

- `getFilteredStreams()` returns `{ list, map }`. `updateContexts()` uses `map.get()`.

**1e. Rename + decompose `refreshStreamSurface()`** (P9)

- Rename to `hydrateStreamContent()`
- Extract `sendStreamLogs()`, `sendStreamTodos()`, `sendStreamFollowUps()` as independent private methods (10-15 lines each)
- `hydrateStreamContent()` becomes a 4-line orchestrator that composes them
- `sendInstructionUpdate()` already exists separately
- 4 callers updated to call `hydrateStreamContent()` instead

**1f. Rename misleading methods** (P10)

- `updateWebview()` → `syncFullView()` (orchestrates 5+ message types)
- `updateAll()` → `sendStreamMetadata()` (sends 1 message type: stream list + active stream + theme)
- Keep `updateX()` for single-message WebviewUpdater methods (they're fine — clear 1:1 mapping)

**Honest code delta**: The RunInstructionManager file (91 lines) is deleted, but ~40 lines of actual Map logic move into ProgressViewState. Delegation methods (~10 lines) simplify to direct calls. Dead field removals: ~7 lines. refreshStreamSurface decomposition: +30 lines (new methods), -90 lines (old method). Renames: ~0 net. **Net: ~-55 lines** (most "savings" are code moving, not disappearing). **Regression risk**: None.

<details>
<summary><b>Legacy removal checklist (must be in same PR)</b></summary>

| What becomes dead                                               | File                                                                                                    | Action                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `info` field on BaseStreamStateSchema                           | `shared/schemas/streamState.ts:54`                                                                      | Delete field                                                               |
| `info: stream` assignments in merge                             | `messageDispatcher.ts:195,200`                                                                          | Delete lines                                                               |
| `StreamTabInfoSchema` import (if now unused in streamState.ts)  | `shared/schemas/streamState.ts:6`                                                                       | Delete import                                                              |
| `logs` field on BaseStreamStateSchema                           | `shared/schemas/streamState.ts:56`                                                                      | Delete field                                                               |
| `LogMessageDataSchema` import (if now unused in streamState.ts) | `shared/schemas/streamState.ts:5`                                                                       | Delete import                                                              |
| `backendState.logs.length > 0` seed check                       | `messageDispatcher.ts:171-173`                                                                          | Delete block                                                               |
| `RunInstructionManager.ts` (entire file)                        | `src/progressView/managers/RunInstructionManager.ts`                                                    | Delete file                                                                |
| `RunInstructionManager` import in ProgressViewState             | `src/controllers/progressView/backend/ProgressViewState.ts`                                             | Delete import                                                              |
| `_runInstructions` member + delegation methods                  | `ProgressViewState.ts` (getRunInstructions, getRunInstruction, setRunInstruction, deleteRunInstruction) | Delete methods, inline Map logic                                           |
| `refreshStreamSurface` method name                              | `ProgressEventHandler.ts:468`                                                                           | Rename to `hydrateStreamContent`, extract `sendStreamLogs/Todos/FollowUps` |
| `refreshStreamSurface` call sites (4 total)                     | Provider.ts:321, EventHandler.ts:141,184,642                                                            | Update to `hydrateStreamContent`                                           |
| `updateWebview` method name                                     | `ProgressViewProvider.ts:297`                                                                           | Rename to `syncFullView`                                                   |
| `updateAll` method name on WebviewUpdater                       | `WebviewUpdater.ts:415`                                                                                 | Rename to `sendStreamMetadata`                                             |
| All callers of `updateWebview` and `updateAll`                  | Multiple files (~15 call sites for updateWebview, ~9 for updateAll)                                     | Update method names                                                        |

**Verification**: `npm run typecheck` — any surviving reference to deleted fields, methods, or old names will be a compile error. No dead code can hide.

</details>

---

### Phase 2: Fix Field Ownership and Merge (P1 + P3 — Medium, Critical)

**Goal**: Every field has ONE owner. The merge respects ownership by construction, not by manual enumeration.

**Why this must come before Phase 4**: The fallback chains (`state.status ?? info.status ?? READY`) compensate for the clobber bug. Remove the clobber first, then the fallbacks become dead code.

**2a. Flip the merge in `updateStreamInfo()`**

```typescript
// BEFORE (clobber-then-recover):
nextStates.set(stream.name, {
  ...backendState,                          // clobbers ALL
  taskGroups: existing?.taskGroups ?? ...,   // manual recovery
  ...(preserveUI && { ui: existing.ui }),    // manual recovery
} as StreamState);

// AFTER (preserve-then-overwrite backend-owned only):
const BACKEND_OWNED_FIELDS = [
  'kind', 'conversationProgress',
  'activeSubagents', 'finishedSubagentCount',
  'activeProcesses', 'finishedProcessCount',
] as const;

if (existing) {
  const patch: Partial<StreamState> = {};
  for (const key of BACKEND_OWNED_FIELDS) {
    if (key in backendState) patch[key] = backendState[key];
  }
  nextStates.set(stream.name, { ...existing, ...patch });
} else {
  nextStates.set(stream.name, backendState);  // new stream: take everything
}
```

**What this fixes** (12+ fields no longer at clobber risk):

- `status`: stays as frontend set it (not in BACKEND_OWNED_FIELDS)
- `ui`: no longer needs manual recovery
- `taskGroups`, `todos`, `queuedFollowUps`: no longer need manual recovery
- `toolEditBypass`, `superYoloBypass`, `sessionUsage`: no longer silently overwritten
- All workflow run fields: no longer need `preserveWorkflow` check

**2b. Delete** the `as StreamState` type cast, the `preserveUI`/`preserveWorkflow` conditionals, and the manual field recovery lines.

**2c. Add ownership comments to schema.**

**Honest code delta**: The BACKEND_OWNED_FIELDS approach is roughly the same line count as the old preserveUI/preserveWorkflow approach — it's a replacement, not a reduction. Remove type cast + dead conditionals, add field list + loop. **Net: ~-10 lines**. The gain is correctness and maintainability, not line count. **Regression risk**: Low — strictly safer than current behavior.

<details>
<summary><b>Legacy removal checklist (must be in same PR)</b></summary>

| What becomes dead                                                             | File                                      | Action                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| `...backendState` full-spread pattern                                         | `messageDispatcher.ts` (updateStreamInfo) | Replace with BACKEND_OWNED_FIELDS patch |
| `preserveUI` variable + conditional spread                                    | `messageDispatcher.ts`                    | Delete                                  |
| `preserveWorkflow` variable + conditional spread (6 fields)                   | `messageDispatcher.ts`                    | Delete                                  |
| `as StreamState` type cast in merge                                           | `messageDispatcher.ts`                    | Delete                                  |
| `taskGroups: existing?.taskGroups ?? backendState.taskGroups` manual recovery | `messageDispatcher.ts`                    | Delete                                  |

**What stays alive but becomes dead code to remove in Phase 4 (NOT this PR)**:

- `stream.status` fallback in StreamHeader:558 — still needed until Phase 4 removes status from StreamTabInfo
- `streamInfo.status` fallback in WorkflowStreamContent:209 — same

**Mixed-state risk**: LOW. The only change is within `updateStreamInfo()` — one function, same file, same behavior contract. No dual paths.

</details>

---

### Phase 3: Split updateAll() into Targeted Messages (P0 — Medium, Key Perf Fix)

**Goal**: 5 of 9 updateAll() call sites send ~200B targeted messages instead of 70-80KB full rebuild.

| Site | Current                                   | Proposed Message                                    | Payload |
| ---- | ----------------------------------------- | --------------------------------------------------- | ------- |
| 2    | handleSetActiveStream → updateAll()       | `SET_ACTIVE_STREAM { activeStreamId }`              | ~50B    |
| 4    | flushProgressUpdates → updateAll()        | `UPDATE_CONVERSATION_PROGRESS { stream, progress }` | ~100B   |
| 5    | handleUpdateActiveSubagents → updateAll() | `UPDATE_STREAM_BADGES { stream, subagents, count }` | ~200B   |
| 6    | handleUpdateActiveProcesses → updateAll() | `UPDATE_STREAM_BADGES { stream, processes, count }` | ~200B   |
| 7    | handleSetParentStream → updateAll()       | `UPDATE_PARENT_STREAM { stream, parentId }`         | ~100B   |

**Keep updateAll() for**: sites 1 (webview init), 3 (filter change), 8/9 (new stream).

**Frontend handlers**: Each is `setStreamState(stream, s => ({ ...s, ...fields }))` or `setState(prev => ({ ...prev, activeStreamId }))`. 3-5 lines each.

**Edge case**: If `handleSetActiveStream` also changes the filter (via `maybeUpdateFilterForCategory`), fall back to updateAll(). Check: `if (filterChanged) updateAll(); else sendSetActiveStream();`

**Impact at 100 streams during streaming**:

- Before: ~2 UPDATE_STREAMS/sec × 70-80KB = **140-160KB/sec** IPC + full tree invalidation
- After: ~2 targeted messages/sec × ~200B = **~400B/sec** IPC + single-stream patch

**Honest code delta**: This phase ADDS code. 4 new message schemas (~40 lines), 4 new WebviewUpdater methods (~20 lines), 4 new frontend handlers (~20 lines), 4 new commands (~4 lines). Removes 5 `updateAll()` calls (~5 lines). **Net: ~+80 lines**. The gain is performance (400x less IPC), not line count.

**Regression risk**: Low. Each new message carries exactly the data the old updateAll() changed.

<details>
<summary><b>Legacy removal checklist (must be in same PR)</b></summary>

| What becomes dead                                   | File                          | Action                                    |
| --------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| `updateAll()` call in `handleSetActiveStream`       | `ProgressEventHandler.ts:140` | Replace with `sendSetActiveStream()`      |
| `updateAll()` call in `flushProgressUpdates`        | `ProgressEventHandler.ts:313` | Replace with `sendConversationProgress()` |
| `updateAll()` call in `handleUpdateActiveSubagents` | `ProgressEventHandler.ts:349` | Replace with `sendStreamBadges()`         |
| `updateAll()` call in `handleUpdateActiveProcesses` | `ProgressEventHandler.ts:387` | Replace with `sendStreamBadges()`         |
| `updateAll()` call in `handleSetParentStream`       | `ProgressEventHandler.ts:406` | Replace with `sendParentStream()`         |

**What stays alive (intentionally)**:

- `updateAll()` method itself — still used by 4 remaining call sites (webview init, filter change, new stream ×2)
- `updateStreamInfo()` merge logic — still handles UPDATE_STREAMS from those 4 sites
- `getAllStreamStates()` — still called by the 4 remaining updateAll() sites

**New code added (must be in same PR)**:

- 3-4 new message schemas in `progressView.ts`
- 3-4 new WebviewUpdater methods
- 3-4 new frontend handlers in `messageDispatcher.ts`
- 3-4 new commands in `PROGRESS_VIEW_COMMANDS`

**Mixed-state risk**: MEDIUM. During this phase, the system has two paths: `updateAll()` (for structural changes) and targeted messages (for incremental updates). This is the intended end state, NOT a transitional state. But the risk is that future developers call `updateAll()` for convenience when they should use a targeted message.

**Mitigation**: Add a JSDoc comment to `updateAll()`:

```typescript
/**
 * Full stream rebuild — ONLY for structural changes (webview init, filter change, new stream).
 * For incremental updates (status, badges, progress), use targeted messages instead.
 * See: sendSetActiveStream(), sendConversationProgress(), sendStreamBadges()
 */
```

</details>

---

### Phase 4: Single Source of Truth for Status (P4 — Medium, Depends on Phase 2)

**Goal**: `status` and `lastTimestamp` live ONLY on StreamState. Remove from StreamTabInfo.

**Prerequisite**: Phase 2 must be done first (fix clobber before removing fallback targets).

**4a. Backend: write status to `_streamStates`**

- In `setStreamStatus()`, for existing streams, also call `state.updateStreamState(streamId, s => ({ ...s, status }))`
- Ensures `getAllStreamStates()` includes correct status for initial load.

**4b. Add `lastTimestamp` to BaseStreamStateSchema**

- Backend: set alongside status in `updateStreamState()`.

**4c. Remove `status` and `lastTimestamp` from StreamTabInfoSchema**

- Delete from schema, delete from `buildStreamInfo()`.

**4d. Delete fallback chains** (now dead code after Phase 2 fixed clobber)

```typescript
// StreamHeader: streamState?.status || READY       (remove info fallback)
// WorkflowStreamContent: state.status ?? READY     (remove info fallback)
```

**4e. StreamTab: pass status as primitive prop**

- ProgressApp builds `statusByStream: Map<string, StreamStatus>` in willUpdate()
- StreamTabs passes per-tab `status` as a string prop. Cheap equality check. No new context.

**4f. Sort: read lastTimestamp from StreamState**

- Extend comparator to read from `streamStates` Map (frontend already has access).

**Honest code delta**: Remove 2 fields from StreamTabInfo, remove buildStreamInfo status/timestamp logic (~12 lines removed). But add status to BaseStreamStateSchema (+1), backend writes status to \_streamStates (+5), statusByStream Map in willUpdate (+5), status prop plumbing (+3). **Net: ~0 lines** (reshuffling, not reduction). The gain is single source of truth.

**Regression risk**: Medium. Test: status badges, sort order, new stream defaults.

<details>
<summary><b>Legacy removal checklist (must be in same PR)</b></summary>

| What becomes dead                                            | File                                  | Action                                            |
| ------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------- |
| `status` field on StreamTabInfoSchema                        | `shared/schemas/stream.ts`            | Delete `.nullish()` field                         |
| `lastTimestamp` field on StreamTabInfoSchema                 | `shared/schemas/stream.ts`            | Delete `.optional()` field                        |
| Status population in `buildStreamInfo()`                     | `src/progressView/streamInfoUtils.ts` | Delete status assignment                          |
| `lastTimestamp` population in `buildStreamInfo()`            | `src/progressView/streamInfoUtils.ts` | Delete timestamp assignment                       |
| StreamHeader 3-level fallback (`this.stream?.status`)        | `StreamHeader.ts:558`                 | Simplify to `this.streamState?.status \|\| READY` |
| WorkflowStreamContent 3-level fallback (`streamInfo.status`) | `WorkflowStreamContent.ts:209`        | Simplify to `state.status ?? ''`                  |
| `stream.status` access in `StreamTab.ts`                     | `StreamTab.ts:197`                    | Replace with new `status` prop                    |
| `stream.lastTimestamp` access in sort comparator             | `shared/streams/streamSort.ts`        | Read from `streamStates` Map                      |
| `StreamStatusService` reads in `buildStreamInfo()`           | `streamInfoUtils.ts`                  | Delete (status now on StreamState)                |

**What stays alive (intentionally)**:

- `StreamStatusService` itself — backend still needs it as source of truth for status updates
- `UPDATE_STREAM_STATUS` message — still the mechanism for status delivery to frontend

**Mixed-state risk**: HIGH if done partially. If `status` is removed from StreamTabInfoSchema but the fallback chains aren't updated, components show `READY` for running streams. If sort reads from old field, ordering breaks. **All changes must land together.**

**Verification**: After this phase, `grep -r 'stream\.status' src/progressView/frontend/` should return ZERO hits (all status reads go through `streamState.status` or the new prop). `grep -r 'lastTimestamp' src/shared/schemas/stream.ts` should return ZERO hits.

</details>

---

### Phase 5: Consolidate Messages — Send State, Not Event Names (P5 — Medium)

**Goal**: Reduce 34 → ~23 message types. Design interfaces so resolve/dismiss logic is trivial.

**The key insight**: Most SHOW/RESOLVE pairs, recording toggles, and text update variants do the same underlying operation (prepend/filter an array, set a boolean, assign a string). The complexity was in having separate message types, separate WebviewUpdater methods, and separate handlers for each variant — not in the logic itself. With one message per domain, the handler is a short switch on `kind`/`action`, and the "resolve" path is just `permissions.filter(...)`.

| Consolidation          | Before                       | After                                      | What Gets Simpler                                                                                               |
| ---------------------- | ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Approvals (6 → 1)      | 3×SHOW + 3×RESOLVE           | `PERMISSION_UPDATE { kind, action, data }` | 1 handler replaces 6. No separate `addPermission`/`removePrompt` helpers. Out-of-order race = 3-line `if`.      |
| Recording (3 → 1)      | STARTED, STOPPED, ERROR      | `UPDATE_RECORDING { status }`              | 1 handler replaces 3. Just `setStreamState(s => ({ ...s, ui: { ...s.ui, recording: status === 'started' } }))`. |
| Follow-up text (3 → 1) | POLISHED, ERROR, TRANSCRIBED | `UPDATE_FOLLOW_UP_TEXT { kind, text }`     | 1 handler replaces 3. Switch on `kind` for which UI field to set.                                               |
| Bypass (2 → 1)         | TOOL_EDIT_STATE, SUPER_YOLO  | `UPDATE_BYPASS { type, active }`           | 1 handler replaces 2.                                                                                           |
| Proposals (2 → 1)      | SHOW, RESOLVE                | `PROPOSAL_UPDATE { action, data }`         | Folds into PERMISSION_UPDATE or stays separate (has model options).                                             |

Also consolidate WebviewUpdater methods (28 → ~18). Each consolidated message = 1 updater method instead of 2-3.

**Honest code delta**: Replace 16 small handlers with 5 larger ones (each has a switch/if). Old handlers are 3-8 lines each (~80 total), new handlers are 15-25 lines each (~90 total). Old schemas deleted (~60 lines), new schemas added (~30 lines). **Net: ~-20 lines**. The gain is reduced surface area (fewer message types to maintain), not line count.

**Regression risk**: Low — same data, fewer pipes, simpler resolve logic.

<details>
<summary><b>Legacy removal checklist (must be in same PR)</b></summary>

**Per consolidation group — old schemas, handlers, and updater methods must all die together:**

| Group          | Old Schemas to Delete                                                                                                                                                                                                 | Old Handlers to Delete             | Old WebviewUpdater Methods to Delete                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Approvals      | `ShowToolEditApprovalMessageSchema`, `ResolveToolEditApprovalMessageSchema`, `ShowBashApprovalMessageSchema`, `ResolveBashApprovalMessageSchema`, `ShowRetryRequestMessageSchema`, `ResolveRetryRequestMessageSchema` | 6 handlers in messageDispatcher.ts | `showToolEditPermission`, `resolveToolEditPermission`, `showBashPermission`, `resolveBashPermission`, `showRetryRequest`, `resolveRetryRequest` |
| Recording      | `ProgressRecordingStartedMessageSchema`, `ProgressRecordingStoppedMessageSchema`, `ProgressRecordingErrorMessageSchema`                                                                                               | 3 handlers                         | (check if separate methods exist)                                                                                                               |
| Follow-up text | `FollowUpTextPolishedMessageSchema`, `FollowUpTextPolishErrorMessageSchema`, `FollowUpTextTranscribedMessageSchema`                                                                                                   | 3 handlers                         | (check if separate methods exist)                                                                                                               |
| Bypass         | `UpdateToolEditApprovalStateMessageSchema`, `UpdateSuperYoloBypassStateMessageSchema`                                                                                                                                 | 2 handlers                         | `updateToolEditApprovalState`, `updateSuperYoloBypassState`                                                                                     |
| Proposals      | `ShowAgentProposalMessageSchema`, `ResolveAgentProposalMessageSchema`                                                                                                                                                 | 2 handlers                         | `showAgentProposal`, `resolveAgentProposal`                                                                                                     |

**Also delete**:

- Old command constants in `PROGRESS_VIEW_COMMANDS` for each removed message
- Old discriminated union members in `ProgressViewOutboundMessageSchema`
- Any helper functions that only existed to serve the old handler (e.g., `addPermission`, `removePrompt` if they exist as standalone functions)

**Backend callers must switch simultaneously**:

- Every backend call site that calls the old WebviewUpdater methods must switch to the new consolidated methods in the same PR
- Search pattern: `grep -r 'showToolEditPermission\|showBashPermission\|showRetryRequest' src/` — all hits must be updated

**Mixed-state risk**: HIGH if partial. If 3 of 6 approval messages are consolidated but 3 still use the old path, the frontend needs both old and new handlers. **Each consolidation group must be fully migrated in one go.** It's safe to do groups in separate PRs (e.g., approvals first, then recording), but within a group, old and new cannot coexist.

</details>

---

### Phase 6: Inline Thin Managers + Remove Noise + Memory Fixes (P6 + P7 + P6b — Easy, Polish)

**6a. Inline TaskGroupManager** (134 lines, 2 callers) into ProgressViewState
**6b. Remove ~20 unnecessary `?? []` / `?? 0` on `.prefault()` fields** — trust the schema
**6c. Add CSS containment** to hot containers
**6d. Delete streamLogs Map entry on UPDATE_LOGS `clear`** — prevents empty entry accumulation
**6e. Add content-size cap to markdown LRU cache** — prevent unbounded memory from large entries

> **Note**: UsageStatsManager (165 lines) stays as-is — it has real schema validation/coercion logic, compile-time assertions, and `isEmptyUsage()` helper. Not a thin wrapper.

**Honest code delta**: TaskGroupManager (134 lines) deleted but ~60 lines of logic move to ProgressViewState. Remove ~20 unnecessary fallbacks. Add ~10 lines for memory fixes. **Net: ~-85 lines**. **Regression risk**: None.

<details>
<summary><b>Legacy removal checklist (must be in same PR)</b></summary>

| What becomes dead                                                           | File                                            | Action                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `TaskGroupManager.ts` (entire file)                                         | `src/progressView/managers/TaskGroupManager.ts` | Delete file                            |
| `TaskGroupManager` import in ProgressViewState                              | `ProgressViewState.ts`                          | Delete import                          |
| `_taskGroups` member + delegation methods                                   | `ProgressViewState.ts`                          | Replace with inline Map logic          |
| `?? []` on `taskGroups` reads                                               | Multiple frontend components                    | Delete (`.prefault()` guarantees `[]`) |
| `?? []` on `todos`, `queuedFollowUps`, `activeSubagents`, `activeProcesses` | Multiple frontend components                    | Delete (`.prefault()` guarantees)      |
| `?? 0` on `finishedSubagentCount`, `finishedProcessCount`                   | Multiple frontend components                    | Delete                                 |
| `?? {}` on `conversationProgress`                                           | Multiple frontend components                    | Delete                                 |

**Mixed-state risk**: NONE. All changes are strictly internal simplifications with no behavioral change.

</details>

---

### Phase Dependency Graph

```
Phase 1 ──────────────────────────────────────────────┐
Phase 2 ──→ Phase 4 (must fix clobber before           │
             removing fallback targets)                 │  all independently
Phase 3 ──────────────────────────────────────────────┤  shippable except
Phase 5 ──────────────────────────────────────────────┤  2→4 dependency
Phase 6 ──────────────────────────────────────────────┘
```

**Recommended ship order**: 1 → 2 → 3 → 4 → 5 → 6 (sequential gives cleanest reviews, but 1/2/3 can overlap if needed)

**If a phase is abandoned mid-flight**: Each phase is self-contained. Reverting one phase does not break others (except Phase 4 cannot land without Phase 2). There is no state where "half of Phase N" creates a worse system than "none of Phase N."

### Phase Summary

| Phase | What                                                                  | Risk   | Effort    | Real Gain                        | Honest Code Δ  |
| ----- | --------------------------------------------------------------------- | ------ | --------- | -------------------------------- | -------------- |
| **1** | Dead fields + inline RunInstructionManager + rename/decompose methods | None   | Small-Med | Clarity + less IPC bloat         | **~-55 lines** |
| **2** | Fix merge: explicit ownership, no clobber                             | Low    | Small-Med | Correctness (fixes silent bugs)  | **~-10 lines** |
| **3** | Split 5 updateAll() → targeted messages                               | Low    | Medium    | **HIGH** perf (CPU + memory)     | **~+80 lines** |
| **4** | Single source for status/lastTimestamp                                | Medium | Medium    | Single source of truth           | **~0 lines**   |
| **5** | Consolidate 34 → 23 message types                                     | Low    | Medium    | Less surface area to maintain    | **~-20 lines** |
| **6** | Inline TaskGroupManager + noise + memory fixes                        | None   | Small     | Less indirection, memory hygiene | **~-85 lines** |

**Honest total: ~-90 lines net.** Not -300. Most "savings" are code moving between files, not disappearing. The real gains are:

1. **Performance**: Phase 3 eliminates 70-80KB × 2Hz of unnecessary IPC
2. **Correctness**: Phase 2 fixes 12+ fields being silently clobbered
3. **Maintainability**: Fewer message types (34→23), clear ownership, no dual sources of truth

**What Phase 3 fixes beyond CPU**: The targeted message path also eliminates the Map copy cascade and object spread chain that create ~1000+ GC allocations/sec during streaming. A single `UPDATE_CONVERSATION_PROGRESS` message requires 1 Map copy + 1 spread (vs 3 Map copies + 5+ spreads for UPDATE_STREAMS).

---

## 15. Remaining Round-Trips & Couplings (Post-Refactoring)

Even after all 6 phases, the architecture still has unnecessary frontend→backend→frontend round-trips. These are lower priority than the 6 phases but worth documenting as future cleanup.

### Round-trips where frontend already knows the answer

| Flow               | What Happens Today                                                                                                                  | Why It's Unnecessary                                                                                                                                                 | Fix                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FILTER_STREAMS** | Frontend updates `streamFilter` locally, then sends to backend, backend sends UPDATE_STREAMS back                                   | Frontend already applied the filter. Backend only needs it for persistence — no need to echo state back.                                                             | Frontend applies filter + persists locally (already does). Send FILTER_STREAMS as fire-and-forget (backend persists, no response).                                                                                         |
| **SORT_STREAMS**   | Same as filter                                                                                                                      | Same — frontend already sorted locally                                                                                                                               | Same fix: fire-and-forget to backend                                                                                                                                                                                       |
| **SWITCH_STREAM**  | Frontend sends tab click → backend calls `updateWebview()` → sends UPDATE_STREAMS + UPDATE_LOGS + UPDATE_TODOS + UPDATE_INSTRUCTION | The _selection decision_ is pure frontend. The _content refresh_ (logs, todos, instruction) is needed from backend. But today, both are coupled into one round-trip. | Frontend applies `activeStreamId` immediately (optimistic). Backend receives SWITCH*STREAM and sends only the \_content* messages (logs, todos, instruction) — NOT a full UPDATE_STREAMS.                                  |
| **DELETE_STREAM**  | Frontend sends delete → backend removes + sends confirmation → frontend removes from state                                          | Frontend knows which stream to delete. Could remove immediately.                                                                                                     | Optimistic delete: frontend removes stream from its own state. Sends DELETE_STREAM as fire-and-forget. Backend cleans up its own state. If backend fails (unlikely), no recovery needed — stream was already gone from UI. |

### Round-trips where optimistic UI would be better

| Flow                        | What Happens Today                                                               | Fix                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission approve/deny** | Frontend sends action → waits for RESOLVE message → removes from permission list | Frontend removes permission immediately (optimistic). Backend processes the action. No RESOLVE message needed (Phase 5 consolidation already moves toward this). |

### Coupling: refreshStreamSurface() message cascade

When the backend calls `refreshStreamSurface()` (on stream switch, webview init), it sends **4 separate messages** in sequence:

```
refreshStreamSurface(streamId):
  → UPDATE_LOGS { stream, messages, groups, ...extras }     ~2-50KB
  → UPDATE_TODOS { stream, todos }                          ~200B
  → UPDATE_QUEUED_FOLLOW_UPS { stream, messages }           ~100B
  → UPDATE_INSTRUCTION { stream, instruction }              ~500B
```

Each is a separate `postMessage()` call, each parsed separately by the frontend, each triggers its own state update → willUpdate() → re-render cycle. This means **4 render cycles** for what is conceptually one operation: "show this stream's content."

**Fix**: Batch into a single `STREAM_SURFACE { stream, logs, groups, todos, queuedFollowUps, instruction, ...extras }` message. One parse, one state update, one render. This is especially impactful on stream switch where the user is waiting.

### What these would fix

| Metric                          | Current (after Phase 1-6)                          | After round-trip fixes                  |
| ------------------------------- | -------------------------------------------------- | --------------------------------------- |
| Messages per filter change      | 2 (send + receive)                                 | 1 (send only)                           |
| Messages per sort change        | 2                                                  | 1                                       |
| Messages per stream switch      | 1 (send) + 5 (receive: UPDATE_STREAMS + 4 surface) | 1 (send) + 1 (receive: batched surface) |
| Messages per stream delete      | 2                                                  | 1                                       |
| Render cycles per stream switch | 5+ (UPDATE_STREAMS + 4 surface messages)           | 1 (batched)                             |
| Permission latency              | wait for backend RESOLVE                           | instant (optimistic)                    |

### Priority

These round-trips are not urgent — they happen on user actions (clicks), not at 10Hz. But the **stream switch cascade** (4 messages → 4 renders) is worth fixing early because users notice the tab switch latency. The filter/sort/delete round-trips are cosmetic (fast enough that the round-trip isn't visible).

---

## Appendix: Existing Optimizations (Preserve These)

1. **Two-context split** (streamLogContext vs streamStateContext) — isolates 10Hz streaming from meta
2. **Per-stream DOM cache** in LogList — max 5 cached TaskGroupLists, display:none toggle
3. **Incremental message classification** in TaskGroupList — O(k) append, O(1) ref update
4. **guard() directive** for messages — prevents re-render of unchanged messages
5. **500ms conversation progress throttle** — reduces 10Hz to 2Hz
6. **Active-stream-only log sends** — inactive streams get full dump on tab switch only
7. **Markdown render LRU cache** — 2000 entries, FNV-1a hash keys (note: no content-size cap — see Section 10c)
8. **Memoized derived values** in willUpdate() — filteredPermissions, runGroups, cachedTree
9. **No-op short circuits** in setState/setStreamState — skip if `updated === current`
10. **300ms debounce** on StreamTabsManager disk persistence
