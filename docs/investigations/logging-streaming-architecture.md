# Logging & Streaming Architecture Investigation

> Investigation Date: 2026-01-03
> Branch: claude/investigate-logging-streaming-scOEg

## Overview

This document summarizes the investigation into the logging and streaming systems, focusing on the "spaghetti" of round-trips between components.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NORMAL LOGGING PATH                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  AgentLogger.info/debug/warn/error()                                        │
│      ↓                                                                       │
│  logUtils.logWithGroup() → registry.ensure() → winston.Logger               │
│      ↓                                                                       │
│  VSCodeTransport.log()                                                       │
│      ├→ writeToChannel() → VS Code Output Channel (with emoji + timestamp) │
│      └→ emitLogEvent() → ProgressViewSink → bus.emit('addLogMessage')      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         STREAMING PATH (BYPASS)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  AgentLogger.createStream() → returns AgentLogStream                         │
│      ↓                                                                       │
│  stream.append()/finalize()                                                  │
│      ↓                                                                       │
│  bus.emit('addLogMessage'/'updateLogMessage') [DIRECT - SKIPS TRANSPORT]   │
│      ↓                                                                       │
│  [NO OUTPUT CHANNEL - Content never appears in VS Code output]               │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Files

### Logger Layer
- `src/logger/AgentLogger.ts` - High-level API for agents
- `src/logger/logUtils.ts` - Core logging + AsyncLocalStorage context
- `src/logger/LogChannelRegistry.ts` - Transport creation & caching
- `src/logger/transports/VSCodeTransport.ts` - Winston transport
- `src/logger/sinks/ProgressViewSink.ts` - Event emission to bus

### Event Bus Layer
- `src/eventBus/ProgressEventBus.ts` - Central event bus with buffering
- `src/eventBus/schemas.ts` - Event payload schemas

### Progress View Layer
- `src/progressView/events/ProgressEventHandler.ts` - Event orchestration
- `src/progressView/events/LogEvents.ts` - Log message handling
- `src/progressView/events/TaskGroupEvents.ts` - Task group handling
- `src/progressView/managers/WebviewUpdater.ts` - Webview message dispatch
- `src/progressView/state/ProgressViewState.ts` - State management

### Frontend (Webview)
- `src/progressView/script.js` - Entry point
- `src/progressView/modules/messageHandlers.js` - Message dispatch
- `src/progressView/modules/formatters/` - Message formatting
- `src/progressView/modules/taskManagers.js` - DOM management

## Identified Issues

### 1. Dual State for Active Group ID

**Locations:**
- `logUtils.ts`: AsyncLocalStorage stack (`contextStorage`)
- `VSCodeTransport.ts`: Instance field (`activeGroupId`)

**Problem:** Both track the same information independently. Can diverge in edge cases.

### 2. Double Filtering

**Locations:**
- `ProgressViewSink.ts` lines 27-38
- `LogEvents.ts` lines 39-46

**Filters:** Debug level (if not debugMode) and INTERNAL message type

**Problem:** Redundant filtering at two layers.

### 3. Double Task Group Sending

**Flow:**
1. `initializeStreamForTaskGroup()` sends `UPDATE_LOGS` with all groups
2. `TaskGroupEvents` then sends `addTaskGroup` for the same group

**Problem:** Frontend receives duplicate data.

### 4. Streaming Bypasses Output Channel

**Normal path:** Logs appear in VS Code output with formatting
**Streaming path:** Content goes directly to event bus, skipping output channel

**Consequences:**
- No output channel record of streamed content
- Different timestamp handling

### 5. OutputChannels Never Disposed

**Location:** `LogChannelRegistry.ts`

**Problem:** Agent channels created per `streamId` are never disposed, causing memory accumulation.

### 6. Group Map Accumulation

**Location:** `VSCodeTransport.ts` - `groups` Map

**Problem:** Entries added on `startGroup()` but never removed after `endGroup()`.

## Round-Trip Analysis

### Full path for one log message:

```
AgentLogger.info()
  → logUtils.info()
    → logWithGroup()
      → registry.ensure() [Map lookup]
      → resolveActiveGroup() [AsyncLocalStorage query]
      → logger.log() [Winston]
        → VSCodeTransport.log()
          → serializeLogData() [data transformation]
          → writeToChannel() [Output Channel write]
          → emitLogEvent()
            → ProgressViewSink.handleLogMessage()
              → Filter check 1 (debug/INTERNAL)
              → randomUUID() [ID generation]
              → bus.emit('addLogMessage')
                → EventEmitter.emit() OR buffer.push()
                  → LogEvents.handleAddLogMessage()
                    → Filter check 2 (debug/INTERNAL) [REDUNDANT]
                    → state.streamTabs.addMessage() [Persistence]
                    → updater.appendLogMessage()
                      → webview.postMessage()
                        → messageHandlers.handleAppendLog()
                          → pendingLogUpdates check
                          → LogEntryFormatter.format()
                          → insertChronologically()
                          → scrollToBottom()
```

**Estimated hops: 15+ function calls across 10+ files**

## Resource Management Summary

| Resource | Created | Disposed | Issue |
|----------|---------|----------|-------|
| OutputChannels | Per streamId | Never | Memory leak |
| VSCodeTransport.groups | On startGroup | Never | Unbounded growth |
| previousStacks Map | On group push | On pop only | Leak on error |
| pendingLogUpdates | On early UPDATE_LOG | On merge | Orphan risk |

## Recommendations

1. **Consolidate group ID tracking** - Use one source of truth
2. **Remove redundant filtering** - Keep only at sink level
3. **Fix double task group sending** - Send once only
4. **Add OutputChannel disposal** - In `extension.deactivate()`
5. **Clean up group maps** - Remove entries after `endGroup()`
6. **Consider logging streamed content** - Optionally write to output channel
