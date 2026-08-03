---
created: 2026-02-21
updated: 2026-02-21
---

# PRD: Progress View Streaming Cleanup

> **Parent doc:** [2026-02-20-progress-view-performance-architecture.md](./2026-02-20-progress-view-performance-architecture.md)
> **Branch:** `codex/progress-view-prd-refactor`

## Problem Statement

The progress view streaming pipeline has three structural problems that compound during streaming:

1. **Redundant serialization**: The same data is serialized, sent over postMessage, parsed by Zod, and written into frontend state multiple times — for streams the user isn't even looking at.
2. **Split ownership**: Backend `_streamStates` stores full `StreamState` objects but only reads/writes 5 fields. The other ~15 fields are dead weight from the Zod parse, creating a false impression that the backend manages them.
3. **Inconsistent message batching**: Tab switch sends 5 unbatched messages (known-stream path) when a batch message (`SYNC_STREAM_CONTENT`) already exists for exactly this purpose. Three of those messages carry data that's already inside `sendStreamMetadata`.

These aren't theoretical — they fire on every streaming token, every status change, and every tab switch.

## What's Already Done (This Branch)

From the [architecture doc's implementation plan](./2026-02-20-progress-view-performance-architecture.md#14-implementation-plan-internal-cleanup-zero-ui-regression):

| Arch Doc Phase                                   | Status      | Key Commits                                                                                                                 |
| ------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Phase 1: Dead fields, renames, decomposition     | **Done**    | Renames, `sendStreamMetadata`, `syncStreamContent`, extracted helpers                                                       |
| Phase 2: Fix merge clobber                       | **Done**    | `mergeBackendOwnedState()` explicit field list                                                                              |
| Phase 3: Split `updateAll()` → targeted messages | **Done**    | `UPDATE_CONVERSATION_PROGRESS`, `UPDATE_STREAM_BADGES`, `UPDATE_PARENT_STREAM`, `SET_ACTIVE_STREAM`, `UPDATE_STREAM_STATUS` |
| Phase 4: Status SSOT                             | **Partial** | `lastTimestamp` moved to `cachedStreamLastTimestampById`; status still on `StreamTabInfo`                                   |
| Phase 5: Consolidate message types               | **Partial** | Permission messages unified; recording/bypass/follow-up already consolidated                                                |
| Phase 6: Inline thin managers + cleanup          | **Partial** | RunInstructionManager inlined; TaskGroupManager still separate                                                              |

## What Remains

### R1. Stop broadcasting to non-active streams

**The problem.** Six backend event handler modules send messages for ANY stream, not just the active one. The frontend dutifully processes them — Map copy, appState spread, willUpdate cycle — then renders nothing because the stream isn't visible. On tab switch, `syncStreamContent` re-sends everything anyway, making the incremental updates pure waste.

| Handler module                                | Filters by active? | Should it? |
| --------------------------------------------- | ------------------ | ---------- |
| `LogEventHandlers` (add/update)               | **Yes**            | Yes        |
| `ProgressEventHandler` (conversationProgress) | **Yes** (throttle) | Yes        |
| `ProgressEventHandler` (badges)               | **Yes**            | Yes        |
| `TodoEventHandlers`                           | **No**             | **Yes**    |
| `UsageEventHandlers` (contextState)           | **No**             | **Yes**    |
| `UsageEventHandlers` (runUsage)               | **No**             | **Yes**    |
| `OutputEventHandlers` (files, missing)        | **No**             | **Yes**    |
| `FollowUpEventHandlers`                       | **No**             | **Yes**    |

**The fix.** Add `streamId === ctx.state.activeStream` guard to the four non-conforming modules. Backend state is already updated regardless (the guard only skips the `webviewUpdater` call). On tab switch, `syncStreamContent` hydrates the full state from backend. No data is lost.

**Edge case — follow-ups.** The `FollowUpEventHandlers` module has a doc comment saying it intentionally skips the active-stream filter. Review whether that rationale still holds now that `syncStreamContent` includes `queuedFollowUps`.

**Files changed:**

- `src/progressView/events/TodoEventHandlers.ts`
- `src/progressView/events/UsageEventHandlers.ts`
- `src/progressView/events/OutputEventHandlers.ts`
- `src/progressView/events/FollowUpEventHandlers.ts`

**Impact:** Eliminates ~4-8 wasted postMessage + frontend state churn cycles per event for non-active streams during streaming.

---

### R2. Fold `syncActiveStreamState` into `syncStreamContent`

**The problem.** When switching to a known stream, `handleSetActiveStream` sends:

```
1. setActiveStream(streamId)                    → SET_ACTIVE_STREAM
2. syncActiveStreamState(streamId)              → UPDATE_CONVERSATION_PROGRESS
                                                → UPDATE_STREAM_BADGES
                                                → UPDATE_PARENT_STREAM
3. syncStreamContent(streamId)                  → SYNC_STREAM_CONTENT (batched)
```

Five messages, five parse+handle cycles. `SYNC_STREAM_CONTENT` was created to batch tab-switch messages, but `syncActiveStreamState` still sends 3 messages outside the batch. The new-stream path sends only 2 messages (`UPDATE_STREAMS` + `SYNC_STREAM_CONTENT`), making it more efficient than the known-stream path — inverted from what you'd expect.

**The fix.** Extend `SyncStreamContentPayload` to include the fields `syncActiveStreamState` sends:

```typescript
interface SyncStreamContentPayload {
  // ... existing fields ...
  conversationProgress?: ConversationProgress;
  badges?: StreamBadgeSnapshot;
  parentStreamId?: StreamTabId;
}
```

Delete `syncActiveStreamState`. The known-stream tab switch becomes:

```
1. setActiveStream(streamId)    → SET_ACTIVE_STREAM
2. syncStreamContent(streamId)  → SYNC_STREAM_CONTENT (now includes progress + badges + parent)
```

Two messages, matching the new-stream path.

**Frontend change.** The `SYNC_STREAM_CONTENT` handler applies the new optional fields if present. Three lines each:

```typescript
if (data.conversationProgress) {
  ctx.setStreamState(data.stream, (prev) => ({
    ...prev,
    conversationProgress: data.conversationProgress,
  }));
}
// same for badges, parentStreamId
```

**Files changed:**

- `src/progressView/managers/WebviewUpdater.ts` — extend payload, delete syncActiveStreamState calls
- `src/progressView/events/ProgressEventHandler.ts` — delete `syncActiveStreamState`, fold data into `syncStreamContent`
- `src/progressView/frontend/messageDispatcher.ts` — handle new optional fields in SYNC_STREAM_CONTENT handler
- `src/shared/schemas/progressView.ts` — extend schema

**Impact:** Known-stream tab switch: 5 messages → 2. Five frontend state write cycles → 2.

---

### R3. Narrow backend `_streamStates` to what it actually stores

**The problem.** `ProgressViewState._streamStates` is typed as `Map<StreamTabId, StreamState>` where `StreamState` is a discriminated union with ~20 fields per variant. But the backend only reads/writes **5 fields**:

| Field                   | Written by                         | Read by                                       |
| ----------------------- | ---------------------------------- | --------------------------------------------- |
| `conversationProgress`  | `handleUpdateConversationProgress` | `syncActiveStreamState`, `sendStreamMetadata` |
| `activeSubagents`       | `updateActiveChildren`             | `syncActiveStreamState`, `sendStreamMetadata` |
| `finishedSubagentCount` | `updateActiveChildren`             | `syncActiveStreamState`, `sendStreamMetadata` |
| `activeProcesses`       | `updateActiveChildren`             | `syncActiveStreamState`, `sendStreamMetadata` |
| `finishedProcessCount`  | `updateActiveChildren`             | `syncActiveStreamState`, `sendStreamMetadata` |

The other ~15 fields (`taskGroups`, `todos`, `runInstructions`, `runFiles`, `ui`, etc.) are created by `createStreamState()` → Zod parse, then **never touched**. They exist because the type says `StreamState` but the usage says "badge/progress counters."

Additionally, `status` and `lastTimestamp` are fields on `StreamState` (from the schema) but **never updated** in `_streamStates`. Status comes from `StreamStatusService`; lastTimestamp comes from `StreamTabsManager`. Dead fields.

**The fix.** Replace `_streamStates: Map<StreamTabId, StreamState>` with a dedicated type:

```typescript
/** Backend-owned ephemeral counters, updated during streaming. */
interface StreamExecutionState {
  kind: AgentCategory;
  conversationProgress: ConversationProgress;
  activeSubagents: ActiveChildInfo[];
  finishedSubagentCount: number;
  activeProcesses: ActiveChildInfo[];
  finishedProcessCount: number;
}
```

- `getOrCreateStreamState` → `getOrCreateExecutionState`: plain object literal, no Zod parse.
- `updateStreamState` → `updateExecutionState`: same signature, narrower type.
- `getAllStreamStates` → `getAllExecutionStates`: returns `Record<StreamTabId, StreamExecutionState>`.
- `sendStreamMetadata` reads from the new type (already only reads these fields).

**What this does NOT change:** The frontend `StreamState` type stays as-is. The frontend owns the full type (todos, ui, taskGroups, etc.). Only the backend's in-memory representation changes.

**Files changed:**

- `src/controllers/progressView/backend/ProgressViewState.ts` — new type, rename methods
- `src/progressView/events/ProgressEventHandler.ts` — update method calls
- `src/progressView/managers/WebviewUpdater.ts` — update `sendStreamMetadata` to use new type

**Impact:** Eliminates ~15 dead fields per stream from backend memory. Removes misleading Zod parse on stream creation. Makes the data model honest about what the backend owns.

---

### R4. Extract shared log-update logic from handler-calls-handler pattern

**The problem.** `SYNC_STREAM_CONTENT` handler (messageDispatcher.ts:697) calls the `UPDATE_LOGS` handler by constructing a fake message payload:

```typescript
handlers[PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]?.(
  { command: PROGRESS_VIEW_COMMANDS.UPDATE_LOGS, stream: data.stream, ... },
  ctx,
);
```

This is an internal handler invoking another handler with a synthetic message object. It works but it's a code smell — the shared logic should be a function, not a handler calling another handler with a manufactured message.

**The fix.** Extract the body of the `UPDATE_LOGS` handler into a function:

```typescript
function applyLogUpdate(data: LogUpdatePayload, ctx: MessageHandlerContext): void { ... }
```

Both `UPDATE_LOGS` and `SYNC_STREAM_CONTENT` call `applyLogUpdate` directly. Delete the fake-message dispatch.

**Files changed:**

- `src/progressView/frontend/messageDispatcher.ts`

**Impact:** Clarity. No runtime change.

---

### R5. `sendStreamMetadata` called on single-stream events

**The problem.** `handleSetTaskState` (line 232) calls `sendStreamMetadata` when `isActiveStream && !filterChanged`. This rebuilds and serializes metadata for ALL visible streams (30+) because one stream's task state changed. The other 29 streams' metadata hasn't changed.

**The fix.** When `isActiveStream && !filterChanged`, send a targeted status update instead of a full metadata rebuild. The frontend already has all other streams' metadata.

```typescript
if (filterChanged) {
  this.webviewUpdater.sendStreamMetadata(
    this.state,
    StreamStatusService.getAll(),
  );
} else if (isActiveStream) {
  // Only the active stream's metadata changed — don't rebuild all 30 streams.
  this.syncStreamContent(streamId, { updateInstruction: true });
}
```

**Files changed:**

- `src/progressView/events/ProgressEventHandler.ts`

**Impact:** Avoids O(N) metadata rebuild + serialization for single-stream events.

---

## Phase Order

```
R1 (active-stream guards) ─────────────────────┐
R4 (extract shared log logic) ──────────────────┤  independent, ship in any order
R5 (targeted metadata for single-stream) ───────┤
R2 (fold syncActiveStreamState into batch) ─────┤
R3 (narrow _streamStates type) ─────────────────┘
```

All five are independent. R1 is the lowest-risk, highest-impact change. R3 is the largest refactor.

## Verification

Per phase:

1. `npm run typecheck` — any type error = incomplete migration
2. `npm run compile:fast` — builds clean
3. Manual test: open progress view, run an agent, switch tabs, verify status/badges/logs/todos all update correctly
4. Verify: no regressions in non-active stream data after tab switch (data must appear when switching to a previously-inactive stream)

---

### R6. Fix StreamEventQueue false serialization

**The problem.** `StreamEventQueue` claims to serialize async operations per-stream, and the comment in `processUpdateTaskGroup` (line 299) says "StreamEventQueue serializes events per stream, so addTaskGroup always completes before updateTaskGroup." This is wrong.

`processAddTaskGroup` (lines 252-279) does this:

```typescript
async processAddTaskGroup(data): Promise<void> {
  const addGroupPromise = this.state.addTaskGroup(streamId, id, group);  // starts async write
  // ... sends to webview IMMEDIATELY, without awaiting ...
  this.webviewUpdater.addTaskGroup(streamId, group);
  await addGroupPromise;  // awaits at the END
}
```

The queue serializes _handler execution_, not _state mutation completion_. `addTaskGroup` returns a Promise (it persists to workspace storage), but the handler sends the webview update and returns before the persistence finishes. If `updateTaskGroup` fires next, it calls `this.state.getTaskGroups(data.streamId)` — which queries the in-memory Map that IS updated synchronously (line 431 of ProgressViewState.ts: `streamGroups.set(groupId, { ...group })`), so the race is between the synchronous Map set and the async disk write, not between two in-memory operations.

**Actual severity: LOW.** The in-memory state IS consistent because `Map.set()` is synchronous. The queue serializes the in-memory mutation correctly. The `await addGroupPromise` at the end only waits for disk persistence. So the comment is misleading but the behavior is correct _in practice_ — the race is only between persistence writes, not between in-memory state reads.

**The fix.** Fix the misleading code structure. Either:

1. Await `addGroupPromise` before sending to webview (makes the intent match the code), or
2. Document that serialization is for in-memory state only, not persistence.

**Files changed:**

- `src/progressView/events/ProgressEventHandler.ts`

**Impact:** Code clarity. Prevents future bugs if someone adds logic that depends on persistence completing before the next handler runs.

---

### R7. Deduplicate UPDATE_LOGS and SYNC_STREAM_CONTENT schemas

**The problem.** `UpdateLogsMessageSchema` and `SyncStreamContentMessageSchema` in `progressView.ts` duplicate 10 fields character-for-character:

```
stream, messages, groups, action, runInstructions, activeRunId,
runUsage, runFiles, runMissingOutputs, contextState
```

`SYNC_STREAM_CONTENT` is literally `UPDATE_LOGS` plus `todos`, `queuedFollowUps`, `instruction`, `agentCategory`, `runId`. Any field change requires updating both schemas. The frontend handler for `SYNC_STREAM_CONTENT` calls the `UPDATE_LOGS` handler with a fake message (R4) _because_ the schemas are copies of each other.

**The fix.** Extract a shared base:

```typescript
const LogsPayloadSchema = z.object({
  stream: z.union([StreamTabIdSchema, z.literal('')]),
  messages: z.array(LogMessageDataSchema),
  groups: z.array(TaskGroupSchema).optional(),
  action: z.enum(['render', 'clear']).optional(),
  runInstructions: z.record(z.string(), InstructionUpdateSchema).optional(),
  activeRunId: z.string().nullable().optional(),
  runUsage: z.record(z.string(), TokenUsageStatsSchema).optional(),
  runFiles: /* ... */.optional(),
  runMissingOutputs: /* ... */.optional(),
  contextState: ContextStateSchema.optional(),
});

const UpdateLogsMessageSchema = LogsPayloadSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_LOGS),
});

const SyncStreamContentMessageSchema = LogsPayloadSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
  todos: z.array(TodoItemSchema).optional(),
  queuedFollowUps: z.array(z.string()).optional(),
  instruction: InstructionUpdateSchema.nullable().optional(),
  agentCategory: z.string().optional(),
  runId: z.string().nullish(),
});
```

This makes R4 (extract shared log-update function) natural — the shared function takes `z.infer<typeof LogsPayloadSchema>`.

**Files changed:**

- `src/shared/schemas/progressView.ts`

**Impact:** DRY. One place to change log payload fields. Enables R4 cleanly.

---

### R8. Eliminate double-sync on webview initialization

**The problem.** When a webview initializes, two full syncs fire in quick succession:

1. `resolveWebviewView()` line 301 → `syncFullView()` — fires immediately when VS Code resolves the view
2. Frontend sends `WEBVIEW_READY` → `markWebviewReady()` line 359 → `syncFullView({ forceRebuild: true })` — fires when frontend JS is ready

The first sync is wasted — the webview can't process messages until its JS has loaded and sent `WEBVIEW_READY`. The `_pendingUpdateOptions` pattern handles queueing when the view isn't ready, but `resolveWebviewView` calls `syncFullView` _after_ setting up the view (line 301), which passes the `isAnyViewReady()` check because the sidebar flag is set. The messages go to a webview that hasn't loaded its JS yet.

**The fix.** Remove the `syncFullView()` call from `resolveWebviewView`. The `markWebviewReady` path already handles the initial sync correctly, and it fires only when the frontend is actually ready to receive messages.

**Files changed:**

- `src/progressView/ProgressViewProvider.ts`

**Impact:** Eliminates one wasted full sync (metadata + content + bypass state) per webview init.

---

## Verified Non-Issues (Investigated and Dismissed)

These were flagged by audits but don't warrant changes:

| Claim                                                    | Verdict                 | Why                                                                                                                               |
| -------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `buildStreamInfos()` is expensive and uncached           | **Not a problem**       | Only called during structural events (init, filter change, new stream), NOT during streaming. Cost <1ms for typical 3-10 streams. |
| `EventHandlerContext` is a gratuitous abstraction        | **Not worth removing**  | It's a 2-field interface. The indirection is minimal. Removing it saves nothing.                                                  |
| `ProgressEventBus` buffer can lose events                | **Theoretical**         | 1000-event buffer is adequate for init timing. No evidence of actual data loss.                                                   |
| `polishRevision` is dead/hack code                       | **False**               | It's a valid Lit change-detection token. FollowUpInput uses it to clear the polish spinner on revision change.                    |
| Frontend permission filtering duplicated in 2 components | **Not worth fixing**    | Fires on context change (not streaming hot path). Moving upstream saves ~2 lines per component.                                   |
| `StreamHeader` recreates Set per button per render       | **True but negligible** | ~10 buttons, Set creation from small array. Cost is noise compared to DOM work.                                                   |

## Phase Order

```
R1 (active-stream guards) ─────────────────────┐
R4 (extract shared log logic) ─────────────────┤
  R7 (deduplicate schemas) ────────────────────┤  all independent
R5 (targeted metadata for single-stream) ──────┤
R8 (eliminate double-sync on init) ────────────┤
R6 (fix misleading queue comment/structure) ───┤
R2 (fold syncActiveStreamState into batch) ────┤
R3 (narrow _streamStates type) ────────────────┘
```

R7 → R4 is a natural sequence (deduplicate schemas first, then extract shared function that uses the base type). Everything else is independent.

## Verification

Per phase:

1. `npm run typecheck` — any type error = incomplete migration
2. `npm run compile:fast` — builds clean
3. Manual test: open progress view, run an agent, switch tabs, verify status/badges/logs/todos all update correctly
4. Verify: no regressions in non-active stream data after tab switch (data must appear when switching to a previously-inactive stream)

## Out of Scope

- Virtual scrolling for log lists (architectural, not cleanup)
- Frontend `willUpdate` optimizations (already well-optimized with narrow guards)
- `StreamStatusService` removal (still needed as backend authority; the frontend just needs to not duplicate it)
- `buildStreamInfos` caching (not called during streaming; cost is negligible)
- Permission filtering deduplication (not a hot path; 2 lines per component)
- `StreamTabsManager` debounce rewrite (complex but correct; not worth touching)
