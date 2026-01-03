# Logging & Streaming Architecture Refactoring Plan

## Executive Summary

This plan addresses the architectural complexity ("spaghetti") identified in the logging and streaming systems. The refactoring is organized into 4 phases, prioritized by impact and risk.

**Estimated Impact:**
- Reduce message round-trips by ~40%
- Eliminate 2 redundant filtering layers
- Consolidate dual status maps into single source of truth
- Simplify stream initialization to single path

---

## Phase 1: Eliminate Redundant Filtering (Low Risk, High Impact)

### Problem
Debug messages are filtered in 3 places:
1. `ProgressViewSink.handleLogMessage()` - filters before bus emit
2. `LogEvents.handleAddLogMessage()` - filters again after bus delivery
3. Output channel receives ALL messages (no filtering)

### Solution
Remove the redundant filter in `LogEvents.handleAddLogMessage()`.

### Files to Modify
- `src/progressView/events/LogEvents.ts`

### Changes
```typescript
// REMOVE lines 39-42 in LogEvents.ts:
// if (logMessage.level === 'debug' && !getConfig<boolean>('texra.logger.debugMode', false)) {
//   return;
// }
```

### Impact
- Fewer config lookups per log message
- Clearer ownership: ProgressViewSink owns filtering policy
- No behavioral change (messages already filtered upstream)

---

## Phase 2: Unify Stream Status Management (Medium Risk, High Impact)

### Problem
Two separate maps track stream status:
- `StreamStatusService._statusMemory` (runtime, in agent layer)
- `ProgressEventHandler._streamStatus` (event-driven copy, in UI layer)

This creates potential sync issues and unnecessary complexity.

### Solution
Make `StreamStatusService` the single source of truth. ProgressEventHandler queries it directly instead of maintaining a copy.

### Files to Modify
- `src/agent/runtime/StreamStatusService.ts` - export singleton or add getter
- `src/progressView/events/ProgressEventHandler.ts` - remove `_streamStatus` map
- `src/progressView/events/StreamStatusEvents.ts` - query service instead of local map

### Changes

**StreamStatusService.ts:**
```typescript
// Add method to get all statuses for UI
getAllStatuses(): Map<StreamTabId, StreamStatus> {
  return new Map(this._statusMemory);
}

// Export singleton for direct access
export const streamStatusService = new StreamStatusService();
```

**ProgressEventHandler.ts:**
```typescript
// REMOVE: private readonly _streamStatus = new Map<string, StreamStatus>();

// REPLACE getAllStreamStatuses():
getAllStreamStatuses(): Map<string, StreamStatus> {
  return streamStatusService.getAllStatuses();
}

// REMOVE setStreamStatus local map update, keep only webview dispatch
```

### Impact
- Single source of truth for status
- Eliminates sync issues
- Reduces memory footprint
- Simpler mental model

---

## Phase 3: Consolidate Stream Initialization (Medium Risk, Medium Impact)

### Problem
Two paths can initialize a stream:
1. `setActiveStream` event → `ensureStream()` + `updateStreamHints()`
2. `addTaskGroup` event → `initializeStreamForTaskGroup()` → full refresh

If `addTaskGroup` arrives before `setActiveStream`, causes redundant rebuilds.

### Solution
Create a single `StreamInitializer` that handles all initialization, with idempotent checks.

### Files to Modify
- `src/progressView/events/StreamStatusEvents.ts`
- `src/progressView/events/TaskGroupEvents.ts`
- New: `src/progressView/services/StreamInitializer.ts`

### New Abstraction
```typescript
// src/progressView/services/StreamInitializer.ts
export class StreamInitializer {
  private readonly initializedStreams = new Set<StreamTabId>();

  constructor(
    private readonly state: ProgressViewState,
    private readonly updater: WebviewUpdater,
  ) {}

  /**
   * Idempotent stream initialization.
   * Returns true if this call performed initialization, false if already done.
   */
  async ensureInitialized(
    stream: StreamTabId,
    options: {
      hints?: StreamHints;
      status?: StreamStatus;
      forceRefresh?: boolean;
    } = {},
  ): Promise<boolean> {
    if (this.initializedStreams.has(stream) && !options.forceRefresh) {
      return false;
    }

    await this.state.streamTabs.ensureStream(stream);

    if (options.hints) {
      this.state.updateStreamHints(stream, options.hints);
    }

    if (options.status) {
      streamStatusService.set(stream, options.status);
    }

    this.initializedStreams.add(stream);
    return true;
  }

  markUninitialized(stream: StreamTabId): void {
    this.initializedStreams.delete(stream);
  }
}
```

### Impact
- Single code path for initialization
- Idempotent - safe to call multiple times
- Eliminates race condition between events
- Reduces redundant refreshes

---

## Phase 4: Message Coalescing (Higher Risk, High Impact)

### Problem
`refreshStreamSurface()` sends 4 separate messages:
- `UPDATE_LOGS`
- `UPDATE_FILES`
- `UPDATE_MISSING_OUTPUTS`
- `UPDATE_USAGE`

No batching means 4 separate postMessage calls and 4 DOM updates.

### Solution
Introduce a `CompositeUpdate` message type that combines related updates.

### Files to Modify
- `src/common/webview/commands.ts` - add new command
- `src/progressView/managers/WebviewUpdater.ts` - add composite method
- `src/progressView/events/ProgressEventHandler.ts` - use composite in refreshStreamSurface
- Frontend: Handle composite message

### New Message Type
```typescript
// In commands.ts
COMPOSITE_STREAM_UPDATE: 'compositeStreamUpdate',

// Payload structure
interface CompositeStreamUpdatePayload {
  stream: StreamTabId;
  logs?: { messages: LogMessageData[]; groups: TaskGroup[]; extras: LogContentExtras };
  files?: { runId?: string; rounds?: Map<number, OutputFileInfo[]>; reset?: boolean };
  missingOutputs?: { runId?: string; rounds?: Map<number, string[]>; reset?: boolean };
  usage?: { usageByRun: Map<string, TokenUsageStats> };
}
```

### WebviewUpdater Addition
```typescript
updateStreamSurface(
  stream: StreamTabId,
  payload: CompositeStreamUpdatePayload,
): void {
  this.sendMessage({
    command: PROGRESS_VIEW_COMMANDS.COMPOSITE_STREAM_UPDATE,
    ...payload,
  });
}
```

### Impact
- Reduces 4 messages to 1
- Frontend can batch DOM updates
- Reduces postMessage overhead
- Better perceived performance on stream switch

---

## Phase 5: Optional - Unify Logging Paths (Higher Risk, Medium Impact)

### Problem
Two separate paths emit to the same event bus:
1. `AgentLogger.createStream()` → direct `bus.emit()`
2. `AgentLogger.info()` → Winston → VSCodeTransport → ProgressViewSink → `bus.emit()`

### Consideration
This may be intentional - streaming content (thinking, responses) needs immediate updates while regular logs can be batched.

### Recommendation
**Do not unify** - the dual paths serve different purposes:
- `createStream()` for real-time streaming content (low latency critical)
- Winston path for structured logging with output channel support

### Alternative Improvement
Add documentation clarifying when to use each path:

```typescript
// In AgentLogger.ts

/**
 * Use for real-time streaming content (thinking, responses).
 * Updates appear immediately in progress view.
 * Does NOT write to output channel.
 */
createStream(type: MessageType, options?: AgentLogStreamOptions): AgentLogStream;

/**
 * Use for structured log messages.
 * Writes to both output channel AND progress view.
 * Slight latency due to Winston pipeline.
 */
info(message: string, options?: LogOptions): void;
```

---

## Implementation Order

| Phase | Risk | Impact | Dependencies | Estimated Effort |
|-------|------|--------|--------------|------------------|
| 1. Remove redundant filter | Low | High | None | 1 hour |
| 2. Unify status maps | Medium | High | None | 4-6 hours |
| 3. Consolidate initialization | Medium | Medium | Phase 2 | 4-6 hours |
| 4. Message coalescing | Higher | High | None | 8-12 hours |
| 5. Document paths | Low | Low | None | 1 hour |

**Recommended order:** 1 → 5 → 2 → 3 → 4

Start with low-risk wins (Phase 1, 5), then tackle status unification (Phase 2), which enables cleaner initialization (Phase 3). Message coalescing (Phase 4) requires frontend changes and can be done independently.

---

## Testing Strategy

### Phase 1
- Verify debug messages still filtered in debug mode off
- Verify debug messages appear in debug mode on
- No unit test changes needed

### Phase 2
- Add integration test: status changes reflect in UI within 100ms
- Add test: concurrent status updates don't cause race conditions
- Mock StreamStatusService in existing ProgressEventHandler tests

### Phase 3
- Add test: `ensureInitialized` is idempotent
- Add test: rapid `addTaskGroup` + `setActiveStream` events don't cause double refresh
- Verify no regressions in stream tab creation

### Phase 4
- Add frontend test: composite message updates all sections
- Performance test: measure postMessage count reduction
- Verify no visual regressions on stream switch

---

## Rollback Plan

Each phase is independent and can be rolled back:

1. **Phase 1**: Restore the removed filter (3 lines)
2. **Phase 2**: Restore `_streamStatus` map in ProgressEventHandler
3. **Phase 3**: Remove StreamInitializer, restore original initialization paths
4. **Phase 4**: Remove composite message, restore individual calls

---

## Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Messages per stream switch | 6+ | 2-3 |
| Status map instances | 2 | 1 |
| Stream init code paths | 2 | 1 |
| Debug filter locations | 3 | 1 |
| Config lookups per log | 2 | 1 |

---

## Open Questions

1. **Phase 2**: Should StreamStatusService be a VS Code service registered via dependency injection, or remain a simple singleton?

2. **Phase 4**: Should we implement request coalescing with debounce (e.g., 16ms frame budget), or send composite immediately?

3. **General**: Are there performance benchmarks we should establish before refactoring to measure improvement?
