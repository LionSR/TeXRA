---
created: 2026-01-03
updated: 2026-02-10
---

# Logging & Streaming Architecture Investigation

> Investigation Date: 2026-01-03
> Branch: claude/investigate-logging-streaming-cWNQJ

## Overview

This document captures the architecture analysis of TeXRA's logging and streaming systems, identifying complexity, round trips, and spaghetti patterns.

## Key Components

### Logging Pipeline

```
AgentLogger
    │
    ├─ createStream() ──────────────────────┐
    │  (Direct bus.emit)                    │
    │                                       │
    └─ info/debug/warn/error                │
           │                                │
           ▼                                │
       logUtils.ts                          │
           │                                │
           ▼                                │
    LogChannelRegistry                      │
           │                                │
           ▼                                │
    winston.Logger                          │
           │                                │
           ▼                                │
    VSCodeTransport                         │
    ├─ writeToChannel() ──► OutputChannel   │
    └─ sink?.handleLogMessage()             │
              │                             │
              ▼                             │
       ProgressViewSink                     │
              │                             │
              ▼                             │
       bus.emit('addLogMessage') ◄──────────┘
              │
              ▼
       ProgressEventBus
              │
              ▼
       ProgressEventHandler
              │
              ▼
       WebviewUpdater ──► Frontend
```

### Stream Status Flow

```
StreamStatusService.set()
    │
    ▼
bus.emit('updateStreamStatus')
    │
    ▼
StreamStatusEvents listener
    │
    ▼
ProgressEventHandler.setStreamStatus()
    │
    ├─ _streamStatus Map (duplicate state!)
    │
    └─ WebviewUpdater
           │
           ├─ updateAll() (full refresh)
           └─ updateStreamStatus() (targeted)
```

## Identified Issues

### 1. Dual Logging Paths (HIGH)

**Problem**: Two paths to progress view with different behavior.

| Aspect          | Path A: createStream() | Path B: logger methods        |
| --------------- | ---------------------- | ----------------------------- |
| Target          | Progress view only     | OutputChannel + Progress view |
| Filtering       | None                   | Debug/Internal filtered       |
| Type Validation | None                   | Validated                     |
| ID Generation   | Caller-provided        | Sink generates UUID           |

**Files**:

- `src/logger/AgentLogger.ts` (createStream: lines 509-596)
- `src/logger/sinks/ProgressViewSink.ts` (filtering: lines 26-38)

### 2. Duplicate Stream Status State (HIGH)

**Problem**: Two separate Maps track stream status without synchronization.

```typescript
// In src/agent/runtime/StreamStatusService.ts
const statusMemory = new Map<StreamTabId, StreamStatus>();

// In src/progressView/events/ProgressEventHandler.ts
private _streamStatus: Map<string, StreamStatus> = new Map();
```

**Issue**: `RetryState.ts` directly emits events, bypassing `StreamStatusService`, causing drift.

### 3. Triple Update on Stream Switch (MEDIUM)

**Problem**: `handleSetActiveStream()` triggers up to 3 overlapping updates.

```typescript
// In StreamStatusEvents.ts
updater.updateAll(state, shared.streamStatus);      // [1] UPDATE_STREAMS
shared.setStreamStatus(stream, status);             // [2] May updateAll() AGAIN
shared.refreshStreamSurface(stream, {...});         // [3] UPDATE_LOGS
shared.sendInstructionUpdate(stream, activeRunId);  // [4] UPDATE_INSTRUCTION
```

### 4. AsyncLocalStorage Context Management (LOW-MEDIUM)

**Problem**: Group context uses `AsyncLocalStorage` with potential issues.

- `previousStacks` Map can accumulate if groups aren't ended
- Same Map object mutation with `enterWith()` may not isolate contexts
- New async contexts lose group stack

**File**: `src/logger/logUtils.ts` (lines 26-127)

### 5. Complex State Resolution (LOW-MEDIUM)

**Problem**: `refreshStreamSurface()` performs 7 separate state lookups.

```typescript
const messages = state.streamTabs.getMessages(stream);
const groups = state.taskGroups.getStreamGroups(stream);
const runInstructions = state.runInstructions.getInstructions(stream);
const filesByRun = nestedMapToRecord(state.outputFiles.getFiles(stream));
const missingByRun = nestedMapToRecord(
  state.outputFiles.getMissingOutputs(stream),
);
const usageByRun = state.usageStats.getRunUsage(stream);
const todos = state.getTodos(stream);
```

## Task Group Lifecycle

### Init Group Creation

1. `executeAgent()` starts agent execution
2. `prepareFlowExecution()` emits `setActiveStream` **BEFORE** Init stage
3. `logger.stage('Init')` creates the Init group (now after setActiveStream)
4. `ProgressViewSink.handleGroupStarted()` emits `addTaskGroup`
5. `TaskGroupEvents` adds to state and sends to frontend

The correct ordering is enforced in `prepareFlowExecution()` which emits
`setActiveStream` before calling `logger.stage('Init')`. This ensures
the frontend has `state.activeStream` set when `addTaskGroup` arrives.

### Historical Init Group Issues (FIXED)

| Issue                            | Commit    | Root Cause                           | Fix                  |
| -------------------------------- | --------- | ------------------------------------ | -------------------- |
| Stream not activated first       | `59d84b5` | setActiveStream after Init           | Moved emission order |
| Race in ensureStream             | `da11dda` | Async timing with activeStream check | Await ensureStream   |
| Stale groups on session switch   | `509592a` | Groups not cleared                   | Clear on switch      |
| Groups dropped before activation | `87679a4` | addTaskGroup before setActiveStream  | Backend buffering    |
| Source ordering incorrect        | (latest)  | prepareFlowExecution order           | Emit before Init     |

### Current Session Kind Switching

Commit `509592a` clears task groups when switching between session kinds (workflow ↔ tool-use). This prevents stale groups but may cause Init groups from previous sessions to disappear when switching contexts.

### Source Order Fix (executeAgent.ts)

The root cause fix: `prepareFlowExecution()` now emits `setActiveStream` before
creating the Init stage. The `setupFlowUIState()` helper only sets stream status
(no longer emits setActiveStream to avoid duplicate emissions).

For resume scenarios, `streamTabIdOverride` option ensures the snapshot's stream
ID is used instead of the regenerated one.

### Backend Buffering Safety Net (87679a4)

As a safety net for edge cases, when `addTaskGroup` arrives before `setActiveStream`
for a stream, the group is buffered in `ProgressEventHandler.pendingTaskGroups`.
When `setActiveStream` is processed, buffered groups are replayed.

```
ProgressEventHandler.handleAddTaskGroup()
    │
    ├─ stream === state.activeStream?
    │     ├─ YES: webviewUpdater.addTaskGroup() immediately
    │     └─ NO:  bufferTaskGroupForReplay(stream, group)
    │
ProgressEventHandler.handleSetActiveStream()
    │
    ├─ state.activeStream = stream
    └─ replayPendingTaskGroups(stream)
          └─ sends buffered groups via this.webviewUpdater.addTaskGroup()
```

## Round Trip Analysis

| Operation            | Layers | Events | Redundancy                 |
| -------------------- | ------ | ------ | -------------------------- |
| Log message (Path B) | 5      | 1-2    | None                       |
| Log message (Path A) | 2      | 1      | Bypasses filters           |
| Stream status        | 4      | 1-2    | Potential double updateAll |
| Stream switch        | 4      | 3-4    | Triple update possible     |
| Task group add       | 4      | 1-3    | Full refresh if new stream |

## Recommendations

### Short-term Fixes

1. **Unify logging paths**: Have `createStream()` use the same sink filtering as regular logging
2. **Single status state**: Remove `StreamStatusService.statusMemory` or make `ProgressEventHandler` read from it
3. **Avoid double updateAll**: Don't call `setStreamStatus()` after `updateAll()` in `handleSetActiveStream()`

### Medium-term Refactoring

1. **Batch webview messages**: Accumulate updates and send together
2. **Cache resolved runIds**: Avoid repeated resolution in same operation
3. **Consolidate state managers**: Reduce from 5 to 2-3 with clear boundaries

### Long-term Architecture

1. **Single source of truth**: Each piece of state owned by exactly one module
2. **Explicit message flow**: Remove implicit callbacks and indirect updates
3. **Typed event payloads**: Enforce schema validation on all bus events

## Files Reference

### Logging

- `src/logger/AgentLogger.ts` - Main logger interface
- `src/logger/logUtils.ts` - Low-level utilities + AsyncLocalStorage
- `src/logger/LogChannelRegistry.ts` - Channel lifecycle
- `src/logger/transports/VSCodeTransport.ts` - Transport to OutputChannel
- `src/logger/sinks/ProgressViewSink.ts` - Progress view event emission

### Event Bus

- `src/eventBus/ProgressEventBus.ts` - Central event hub with buffering
- `src/eventBus/schemas.ts` - Event payload schemas

### Progress View

- `src/progressView/events/ProgressEventHandler.ts` - Event orchestration
- `src/progressView/events/StreamStatusEvents.ts` - Status event handling
- `src/progressView/events/TaskGroupEvents.ts` - Task group handling
- `src/progressView/events/LogEvents.ts` - Log message handling
- `src/progressView/managers/WebviewUpdater.ts` - Webview messaging
- `src/progressView/managers/StreamTabsManager.ts` - Stream state
- `src/progressView/managers/TaskGroupManager.ts` - Task group state
- `src/controllers/progressView/backend/ProgressViewState.ts` - Combined state

### Runtime

- `src/agent/runtime/StreamStatusService.ts` - Status service (duplicate state!)
- `src/agent/runtime/executeAgent.ts` - Agent execution entry point
- `src/agent/core/flows/RetryState.ts` - Bypasses StreamStatusService
