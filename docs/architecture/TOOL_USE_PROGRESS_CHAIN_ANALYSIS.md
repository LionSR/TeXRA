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

## Detailed Improvement Opportunities

### HIGH PRIORITY: Code Duplication (50+ instances)

#### 1. Tool Edit Approval Flow - Repeated 5+ times

**Problem**: The 6-step approval sequence is copy-pasted across WriteTool, EditTool, and TextEditorTool (5 times in TextEditorTool alone).

**Pattern repeated:**
```typescript
// Step 1: Check read gate
const readGate = requireFileReadForEdit(path, exists);
if (readGate) return readGate;

// Step 2: Request approval
const approval = await requestToolEditApproval({ path, originalContent, proposedContent, sourceTool });

// Step 3: Handle rejection
if (!approval.accepted) {
  return buildApprovalRejectedResult(path, 'tool_name', approval.userMessage);
}

// Step 4: Write content
const finalContent = getApprovedContent(approval, proposedContent);
const { appliedContent } = await writeApprovedContent(path, originalContent, finalContent);

// Step 5: Record read
recordToolFileRead(path);

// Step 6: Return result
return { summary: 'Wrote...', output: '...', edits: [...] };
```

**Files affected:**
- `src/tools/WriteTool.ts:37-87`
- `src/tools/EditTool.ts:49-115`
- `src/tools/TextEditorTool.ts:314-360, 404-464, 520-592, 610-685`

**Fix**: Extract to single helper:
```typescript
async function executeApprovedEdit(params: {
  path: string;
  exists: boolean;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
  buildResult: (appliedContent: string) => ToolResult;
}): Promise<ToolResult> {
  // All 6 steps in one place
}
```

**Impact**: ~200 lines removed, single source of truth for edit flow.

---

#### 2. Event Handler State→Webview Pattern - Repeated ~10 times

**Problem**: Every event handler follows identical 3-step sequence.

**Pattern repeated:**
```typescript
// Step 1: Update state
await ctx.state.outputFiles.addFiles(stream, storageKey, filesByRound);

// Step 2: Check webview
if (!isWebviewAvailable(ctx)) return;

// Step 3: Update webview
ctx.webviewUpdater.updateFiles(stream, { runId: storageKey, rounds });
```

**Files affected:**
- `src/progressView/events/LogEventHandlers.ts:36-50`
- `src/progressView/events/OutputEventHandlers.ts:46-61`
- `src/progressView/events/UsageEventHandlers.ts:36-61`
- `src/progressView/events/TodoEventHandlers.ts:29-40`

**Fix**: Create helper that encapsulates pattern:
```typescript
async function updateStateAndWebview<T>(
  ctx: EventHandlerContext,
  stateUpdate: () => Promise<T>,
  webviewUpdate: (result: T) => void,
): Promise<void> {
  const result = await stateUpdate();
  if (isWebviewAvailable(ctx)) {
    webviewUpdate(result);
  }
}
```

---

#### 3. Debug Saving Pattern - Repeated 4 times

**Problem**: Identical `maybeSaveDebugObject()` calls with same structure.

**Files affected:**
- `src/agent/core/flows/ResponseCycleFlow.ts:210-222, 353-365`
- `src/agent/core/flows/ToolUseCycleFlow.ts:218-229, 319-330`

**Fix**: Extract to shared helper with default context builder.

---

### MEDIUM PRIORITY: Unnecessary Abstractions

#### 1. Factory Functions Called Once

| Factory | Location | Caller |
|---------|----------|--------|
| `createResponseCycleFlow()` | ResponseCycleFlow.ts:875 | ResponseCycleNode.ts:168 only |
| `createToolUseCycleFlow()` | ToolUseCycleFlow.ts:814 | ToolUseCycleNode.ts:74 only |

**Assessment**: These factories exist for testability and could be kept for that reason. However, per CLAUDE.md, if they're only called from one place, consider inlining.

---

#### 2. PersistentMapManager - 5 Thin Subclasses

**Problem**: All 5 subclasses (UsageStatsManager, OutputFilesManager, TaskGroupManager, StreamTabsManager, RunInstructionManager) only override `serialize()`/`deserialize()` with 1-line implementations.

**Current**:
```typescript
// RunInstructionManager.ts - 94 lines for essentially:
protected override serialize(value: InstructionMap): unknown {
  return mapToRecord(value);  // 1 line
}
protected override deserialize(data: unknown): InstructionMap {
  return recordToMap<InstructionUpdate>(data);  // 1 line
}
```

**Fix**: Consolidate to configurable manager:
```typescript
class PersistentMapManager<K, V> {
  constructor(
    private key: WorkspaceStateKey,
    private serializer: (v: V) => unknown,
    private deserializer: (d: unknown) => V,
  ) {}
}

// Usage:
const instructionManager = new PersistentMapManager(
  WorkspaceStateKey.RUN_INSTRUCTIONS,
  mapToRecord,
  recordToMap<InstructionUpdate>,
);
```

**Impact**: ~400 lines → ~150 lines.

---

#### 3. Separate Event Handler Files - Could Be Inlined

**Current**: 5 separate files each with `registerXxxEventHandlers()` function called from one place.

**Files**:
- `LogEventHandlers.ts` (89 lines)
- `OutputEventHandlers.ts` (111 lines)
- `UsageEventHandlers.ts` (80 lines)
- `TodoEventHandlers.ts` (~40 lines)
- `FollowUpEventHandlers.ts` (~50 lines)

**Assessment**: This is a **judgment call**. Separate files provide organization, but add ~30 lines of boilerplate per file. If each handler is <50 lines of actual logic, consider consolidating into `ProgressEventHandler.ts`.

---

### HIGH PRIORITY: Error Handling Issues

#### 1. Event Handler Failures Silent to UI

**File**: `src/progressView/events/errorHandling.ts:40-42`

**Problem**:
```typescript
Promise.resolve(result).catch((error) =>
  logError(moduleName, context, error),  // Logged but UI never knows
);
```

**Fix**: Emit error event for UI notification:
```typescript
Promise.resolve(result).catch((error) => {
  logError(moduleName, context, error);
  bus.emit('eventHandlerError', { moduleName, context, error: toErrorMessage(error) });
});
```

---

#### 2. Tool Errors Lose Context

**File**: `src/agent/core/flows/ToolUseCycleFlow.ts:111-112`

**Problem**:
```typescript
return {
  message: `${toolName}: Invalid parameters provided`,  // Generic, no param info
};
```

**Fix**: Include parameter path:
```typescript
return {
  message: `${toolName}: Invalid parameter at ${issue.path.join('.')}: ${issue.message}`,
};
```

---

#### 3. Zod Detection Uses Duck Typing

**File**: `src/agent/core/flows/ToolUseCycleFlow.ts:89-97`

**Problem**: Duck typing (`'issues' in error`) could match non-Zod errors.

**Fix**:
```typescript
import { ZodError } from 'zod';
function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
```

---

#### 4. Silent Tool Registry Fallbacks

**File**: `src/tools/registry.ts:154, 160`

**Problem**:
```typescript
return ToolDefinitionSchema.catch({ name }).parse(item);  // Silent fallback to name-only
```

**Fix**: Throw with context instead:
```typescript
const result = ToolDefinitionSchema.safeParse(item);
if (!result.success) {
  throw new Error(`Tool '${name}' has invalid schema: ${result.error.message}`);
}
return result.data;
```

---

### MEDIUM PRIORITY: Type Safety Gaps

#### 1. 16 Message Handlers Accept `any`

**File**: `src/progressView/ProgressViewMessageHandler.ts`

**Lines**: 206, 214, 218, 226, 246, 255, 279, 287, 301, 305, 336, 342, 348, 353, 362, 369

**Problem**:
```typescript
private async handleSwitchStream(message: any): Promise<void> {
  this.provider.setActiveStream(message.stream);  // No validation
}
```

**Fix**: Define message schemas:
```typescript
const SwitchStreamMessageSchema = z.object({ stream: StreamTabIdSchema });

private async handleSwitchStream(message: unknown): Promise<void> {
  const parsed = SwitchStreamMessageSchema.safeParse(message);
  if (!parsed.success) return;
  this.provider.setActiveStream(parsed.data.stream);
}
```

---

#### 2. Model Handler Uses `any[]` and `any` Parameters

**File**: `src/agent/modelHandlers/ModelHandler.ts:603, 612-613`

**Problem**:
```typescript
abstract createMediaContent(mediaMessage: MediaEntry[]): any[];
abstract extractResponse(responseObject: any, endTag: string): ExtractResponseResult;
```

**Fix**: Define proper types:
```typescript
abstract createMediaContent(mediaMessage: MediaEntry[]): MediaContentPart[];
abstract extractResponse(responseObject: unknown, endTag: string): ExtractResponseResult;
```

---

#### 3. Persisted Flow Unsafe Casts

**File**: `src/agent/node/persisted-flow.ts:127, 134-145`

**Problem**:
```typescript
const params = flow.params as P;  // No validation
const shared = flow.shared as S;  // No validation
cursor.setParams(params as any);  // Double cast
```

**Fix**: Add Zod validation at deserialization.

---

## Refactoring Priority Matrix

| Category | Items | Lines Saved | Risk | Priority |
|----------|-------|-------------|------|----------|
| Tool approval extraction | 1 helper | ~200 | Low | **HIGH** |
| Event handler pattern helper | 1 helper | ~50 | Low | **HIGH** |
| Error handling improvements | 4 fixes | 0 | Low | **HIGH** |
| Type safety (message handlers) | 16 handlers | 0 | Medium | **MEDIUM** |
| PersistentMapManager consolidation | 5 classes | ~250 | Medium | **MEDIUM** |
| Debug saving helper | 1 helper | ~40 | Low | **LOW** |
| Factory inlining | 2 factories | ~20 | Low | **LOW** |

---

## Recommended Action Plan

**Phase 1 - Quick Wins (Low Risk)**:
1. Extract tool edit approval helper → Single PR
2. Add error context to tool failures → Single PR
3. Fix Zod detection to use `instanceof` → Single PR

**Phase 2 - Event Handlers (Medium Risk)**:
1. Add UI notification for event handler errors
2. Create state→webview update helper
3. Add message schemas for 16 handlers

**Phase 3 - Abstractions (Medium Risk)**:
1. Evaluate PersistentMapManager consolidation
2. Consider event handler file consolidation
3. Add type safety to model handlers

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
