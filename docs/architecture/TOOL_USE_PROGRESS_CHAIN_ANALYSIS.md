# Tool Use & Progress View Architecture Analysis

**Date**: 2026-01-22
**Reviewer**: Automated Architecture Review (Linus-style critical analysis)
**Status**: Architecture is SOUND - minimal refactoring needed

---

## Executive Summary

The tool use and progress view display chain is **well-architected** with clean separation of concerns. The codebase has already been refactored to follow the CLAUDE.md guidelines for flattening abstraction layers. There are a few minor opportunities for simplification, but no major structural issues.

**Verdict**: 8/10 - Clean, maintainable, with minor cosmetic improvements possible.

---

## Architecture Diagrams

### 1. Complete Data Flow: Tool Execution → Progress Display

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TOOL EXECUTION LAYER                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  runToolUseFlow()                                                           │
│       │                                                                     │
│       ├─→ resolveTools() [validate against registry]                        │
│       ├─→ createToolUseRunFlow() [PocketFlow graph]                         │
│       │                                                                     │
│       └─→ PersistedFlow.run()                                               │
│               │                                                             │
│               ├─→ ToolUsePrepareNode ──────────────────────────────────┐    │
│               │                                                        │    │
│               └─→ ToolUseCycleNode ←───────────────────────────────────┤    │
│                       │                                                │    │
│                       └─→ createToolUseCycleFlow() ←──NATIVE NESTING   │    │
│                               │                                        │    │
│                               ├─→ ToolUsePrepNode                      │    │
│                               ├─→ ToolUseCallNode ──→ modelHandler     │    │
│                               ├─→ ToolUseProcessNode ──→ metrics       │    │
│                               └─→ ToolUseDispatchNode                  │    │
│                                       │                                │    │
│                                       ├─→ tool.call(input)             │    │
│                                       ├─→ logger.logToolUse()          │    │
│                                       └─→ CONTINUE ────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Events emitted during execution
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            EVENT BUS LAYER                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ProgressEventBus (Singleton with buffering)                                │
│       │                                                                     │
│       ├─→ addLogMessage      ──→ Log content for display                    │
│       ├─→ addTaskGroup       ──→ Execution stage started                    │
│       ├─→ updateTaskGroup    ──→ Stage completed/failed                     │
│       ├─→ updateStreamUsage  ──→ Token usage stats                          │
│       ├─→ addOutputFiles     ──→ Files written by agent                     │
│       ├─→ updateTodos        ──→ Todo list changes                          │
│       └─→ show*Prompt        ──→ UI interactions (retry/approval)           │
│                                                                             │
│  Buffer: MAX_BUFFER_SIZE=1000 events when no listeners                      │
│  Replay: Events replayed on subscription (single pass per event type)       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Subscribed by ProgressEventHandler
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROGRESS VIEW LAYER                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ProgressEventHandler                                                       │
│       │                                                                     │
│       ├─→ Core handlers (inline):                                           │
│       │       setActiveStream, updateStreamStatus, addTaskGroup, etc.       │
│       │                                                                     │
│       └─→ Domain handlers (modular files):                                  │
│               ├─→ LogEventHandlers.ts       ──→ StreamTabsManager           │
│               ├─→ OutputEventHandlers.ts    ──→ OutputFilesManager          │
│               ├─→ UsageEventHandlers.ts     ──→ UsageStatsManager           │
│               ├─→ TodoEventHandlers.ts      ──→ ProgressViewState           │
│               ├─→ FollowUpEventHandlers.ts  ──→ External queue query        │
│               └─→ UIEvents.ts               ──→ Callbacks to Provider       │
│                                                                             │
│  EventHandlerContext: {state, webviewUpdater}                               │
│       ├─→ isWebviewAvailable()  ──→ Broadcast all run-scoped data           │
│       └─→ canUpdateWebview()    ──→ Only current stream updates             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Sends messages via WebviewUpdater
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          WEBVIEW DISPLAY LAYER                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WebviewUpdater                                                             │
│       │                                                                     │
│       ├─→ sendMessage() ──→ Iterates all webviews (sidebar + panel)         │
│       │                                                                     │
│       └─→ Methods:                                                          │
│               updateStreams(), updateLogContent(), appendLogMessage(),      │
│               updateFiles(), updateTodos(), updateStatus(),                 │
│               showRetryRequest(), showToolEditApprovalPrompt(), etc.        │
│                                                                             │
│  Frontend (Browser)                                                         │
│       │                                                                     │
│       ├─→ messageHandlers.js  ──→ Routes incoming messages                  │
│       ├─→ progressViewState.js ──→ Frontend state management                │
│       ├─→ domHandlers.js      ──→ DOM manipulation                          │
│       └─→ uiManagers/         ──→ Stream tabs, file list, etc.              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Tool Use Cycle Flow (Detail)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ToolUseCycleFlow (4-Node Chain)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │ ToolUsePrepNode │◄─────────────────────────────────────┐                 │
│  └────────┬────────┘                                      │                 │
│           │ prep(): checkInterruption()                   │                 │
│           │ post(): resetCycleState(), saveDebug          │                 │
│           ▼                                               │                 │
│  ┌─────────────────┐                                      │                 │
│  │ ToolUseCallNode │  (extends RetryableInvocationNode)   │                 │
│  └────────┬────────┘                                      │                 │
│           │ exec(): modelHandler.createResponse({tools})  │                 │
│           │        └─→ Returns {response, responseTimeMs} │                 │
│           │ post(): shared.response = response            │                 │
│           ▼                                               │                 │
│  ┌──────────────────────┐                                 │                 │
│  │ ToolUseProcessNode   │                                 │                 │
│  └────────┬─────────────┘                                 │                 │
│           │ exec(): (PURE - no side effects)              │                 │
│           │   ├─→ extractToolUse(response)                │                 │
│           │   ├─→ extractResponse(response)               │                 │
│           │   ├─→ normalizeUsage(usage)                   │                 │
│           │   └─→ Determine endTurn                       │                 │
│           │                                               │                 │
│           │ post(): (SIDE EFFECTS)                        │                 │
│           │   ├─→ run.recordCycleMetrics()  ◄─────────────┼─ SINGLE SOURCE  │
│           │   ├─→ onRoundFinalized(run)                   │   OF TRUTH      │
│           │   └─→ Update shared state                     │                 │
│           ▼                                               │                 │
│  ┌────────────────────────┐                               │                 │
│  │ ToolUseDispatchNode    │                               │                 │
│  └────────┬───────────────┘                               │                 │
│           │ prep(): Check interruption                    │                 │
│           │                                               │                 │
│           │ exec(): For each toolCall:                    │                 │
│           │   ├─→ parseToolInput(call.input)              │                 │
│           │   ├─→ toolRegistry.get(call.name)             │                 │
│           │   ├─→ withToolFileInteractionContext()        │                 │
│           │   │       └─→ tool.call(parsedInput)          │                 │
│           │   ├─→ normalizeToolCallError() on failure     │                 │
│           │   └─→ extractToolAttachments(result)          │                 │
│           │                                               │                 │
│           │ post(): Create follow-up messages             │                 │
│           │   ├─→ For Google/DeepSeek: Batch all calls    │                 │
│           │   └─→ For others: Individual follow-ups       │                 │
│           │                                               │                 │
│           └─→ CONTINUE ───────────────────────────────────┘                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3. State Management Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          STATE ARCHITECTURE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FLOW STATE (Mutable, passed as `shared`)                                   │
│  ─────────────────────────────────────────                                  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │ ToolUseCycleShared                                             │         │
│  ├────────────────────────────────────────────────────────────────┤         │
│  │ From BaseCycleFieldsSchema:                                    │         │
│  │   messages, shouldStop, endTurn, responseTimeMs,               │         │
│  │   stopReason, lastError                                        │         │
│  │                                                                │         │
│  │ Tool-use specific:                                             │         │
│  │   response, toolCalls, text, cycleIndex,                       │         │
│  │   cycleResponseTimeMs, cycleNormalizedUsage                    │         │
│  └────────────────────────────────────────────────────────────────┘         │
│                                                                             │
│  SERVICES (Immutable, accessed via `this.services`)                         │
│  ──────────────────────────────────────────────────                         │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │ ToolUseCycleServices                                           │         │
│  ├────────────────────────────────────────────────────────────────┤         │
│  │ Base: logger, modelHandler, client, setting, workspace         │         │
│  │ Tool-use: toolRegistry, modelName, agentName, executionId      │         │
│  │ State: run (AgentRunState), checkInterruption, onRoundFinalized│         │
│  └────────────────────────────────────────────────────────────────┘         │
│                                                                             │
│  PROGRESS STATE (Persisted, managed by ProgressViewState)                   │
│  ─────────────────────────────────────────────────────────                  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │ ProgressViewState (Composes 5 focused managers)                │         │
│  ├────────────────────────────────────────────────────────────────┤         │
│  │ StreamTabsManager    ──→ Log messages per stream (max 1000)    │         │
│  │ TaskGroupManager     ──→ Execution stages by stream            │         │
│  │ OutputFilesManager   ──→ Output files by (stream, run, round)  │         │
│  │ UsageStatsManager    ──→ Token usage by (stream, run)          │         │
│  │ RunInstructionManager ─→ Instruction text by (stream, run)     │         │
│  │                                                                │         │
│  │ Plus: taskStates, executionIds, sessionState (hints/todos)     │         │
│  └────────────────────────────────────────────────────────────────┘         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Critical Analysis (Linus-style)

### What's GOOD

1. **Clean separation of concerns** - Tools don't know about UI, UI doesn't know about tools. The event bus is the **only** coupling point. This is correct.

2. **Native nesting pattern** - Cycle flows run directly on outer shared state. No translation layer, no indirection. This is what code should look like.

3. **Single source of truth for metrics** - `AgentRunState.recordCycleMetrics()` is called by both reflection and tool-use flows. Not two methods doing the same thing.

4. **Event buffering** - The `ProgressEventBus` buffers events when no listeners exist and replays them on subscription. Handles race conditions elegantly without complex locking.

5. **Domain event handlers** - Each event type has its own file (LogEventHandlers, OutputEventHandlers, etc.). Not one giant 2000-line handler.

6. **Zod schemas as source of truth** - `ToolUseCycleFieldsSchema`, `BaseCycleFieldsSchema`, etc. Types derived from schemas, not duplicated.

### What's QUESTIONABLE

1. **Task group buffering inconsistency** (minor)
   - `addTaskGroup` buffers in `pendingTaskGroups` Map (in-memory)
   - `addLogMessage` persists to `StreamTabsManager` (workspace state)
   - Different strategies for similar problems

2. **Three separate pending prompt Maps** (minor)
   - `pendingApprovalPrompts`, `pendingRetryRequests`, `pendingAgentProposals`
   - Could be unified into single `pendingUIRequests` map

3. **`parseToolInput()` is local function** (trivial)
   - Located in `ToolUseCycleFlow.ts` at line 64
   - Could be extracted to `@tools/utils` for reuse
   - But it's only used in one place, so YAGNI applies

4. **`normalizeToolCallError()` duplicates some logic** (trivial)
   - Similar error normalization exists in `@tools/result`
   - But the current implementation is clear and correct

### What's WRONG

**Nothing major.** The architecture has already been cleaned up according to CLAUDE.md guidelines:

- ✅ No wrapper functions that just call another function
- ✅ No factory patterns that add indirection without value
- ✅ Nodes create and run flows directly
- ✅ Services passed flat, not nested in wrapper objects

---

## Simplification Opportunities

### Low Priority (Cosmetic)

| Issue | Location | Effort | Impact |
|-------|----------|--------|--------|
| Unify pending prompt Maps | `ProgressViewProvider.ts` | Low | Code organization |
| Extract `parseToolInput()` | `ToolUseCycleFlow.ts:64` | Trivial | Reusability |
| Consistent task group buffering | `ProgressEventHandler.ts` | Medium | Consistency |

### Not Recommended

| Anti-refactoring | Reason |
|------------------|--------|
| Extract services creation into factory | Only called from one place |
| Create "ToolExecutor" abstraction | Would add indirection without value |
| Merge domain event handlers | Would create monolithic file |
| Add EventBus "middleware" | Over-engineering for current needs |

---

## Event Flow Timeline

```
T=0ms    executeAgent() launches
         │
T=1ms    bus.emit('setActiveStream', {stream, agentCategory})
         │  └─→ ProgressEventHandler.processSetActiveStream()
         │       ├─→ state.streamTabs.ensureStream()
         │       ├─→ state.updateStreamHints()
         │       └─→ webviewUpdater.updateAll()
         │
T=2ms    ToolUseCycleFlow starts
         │
T=10ms   bus.emit('addTaskGroup', {stream, id, name, status='running'})
         │  └─→ ProgressEventHandler.handleAddTaskGroup()
         │       ├─→ state.taskGroups.addGroup()
         │       └─→ webviewUpdater.addTaskGroup() OR buffer if not active
         │
T=50ms   Model API call completes
         │  └─→ ToolUseProcessNode.post()
         │       ├─→ run.recordCycleMetrics()  ◄── SINGLE SOURCE OF TRUTH
         │       └─→ onRoundFinalized(run)
         │            └─→ AgentUsageReporter.reportUsage()
         │                 └─→ bus.emit('updateStreamUsage')
         │
T=60ms   Tool execution
         │  └─→ ToolUseDispatchNode.exec()
         │       ├─→ tool.call(input)
         │       └─→ logger.logToolUse()
         │            └─→ bus.emit('addLogMessage')
         │                 └─→ webviewUpdater.appendLogMessage()
         │
T=100ms  Cycle completes
         │  └─→ bus.emit('updateTaskGroup', {status='completed'})
         │       └─→ webviewUpdater.updateTaskGroup()
         │
         ▼
         Frontend renders updates
```

---

## Conclusion

The tool use and progress view architecture is **production-ready**. The codebase follows good practices:

1. **PocketFlow pattern** - Clean node graph with prep/exec/post separation
2. **Event-driven decoupling** - Tools emit events, UI subscribes
3. **Modular handlers** - Each domain has focused responsibility
4. **Schema-first types** - Zod schemas as source of truth
5. **Minimal indirection** - No unnecessary wrapper layers

**Recommendation**: No major refactoring needed. Address the low-priority cosmetic issues only if touching those files for other reasons.

---

## Files Reference

| Layer | Key Files |
|-------|-----------|
| Tool Execution | `src/agent/core/flows/ToolUseCycleFlow.ts` |
| Tool Dispatch | `src/agent/implementations/flows/tooluse/runToolUseFlow.ts` |
| Event Bus | `src/eventBus/ProgressEventBus.ts` |
| Event Handlers | `src/progressView/events/ProgressEventHandler.ts` |
| Domain Handlers | `src/progressView/events/{Log,Output,Usage,Todo,FollowUp}EventHandlers.ts` |
| State Management | `src/progressView/state/ProgressViewState.ts` |
| Webview Updater | `src/progressView/managers/WebviewUpdater.ts` |
| Tool Registry | `src/tools/registry.ts` |
| Tool Base | `src/tools/core/base.ts` |
