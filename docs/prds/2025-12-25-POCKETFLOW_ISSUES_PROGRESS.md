---
created: 2025-12-25
updated: 2026-02-10
---

# PocketFlow Implementation Issues - Progress Tracker

This document tracks the resolution of architectural issues identified in the agent flow system.

**Created**: 2025-12-25
**Branch**: `claude/refactor-agent-flows-L8njh`

---

## Summary

| Priority | Total | Fixed | Analyzed/Documented | Remaining    |
| -------- | ----- | ----- | ------------------- | ------------ |
| Critical | 5     | 2     | 0                   | 3 (deferred) |
| High     | 5     | 1     | 4                   | 0            |
| Medium   | 7     | 2     | 0                   | 5            |
| Low      | 3     | 0     | 0                   | 3            |

---

## 🔴 CRITICAL Issues

### 1. Response Time Unit Mismatch (Data Corruption)

**Status**: ✅ FIXED

**Files**:

- `src/agent/core/flows/ToolUseCycleFlow.ts:319`
- `src/agent/core/flows/ResponseCycleFlow.ts:292`

**Problem**: Response time calculated in seconds but consumers expect milliseconds.

**Fix Applied**: Removed `/ 1000` division to keep time in milliseconds:

```typescript
// BEFORE (wrong):
const responseTime = (Date.now() - start) / 1000; // seconds

// AFTER (fixed):
const responseTime = Date.now() - start; // milliseconds
```

---

### 2. PocketFlow Violation: ResponseProcessNode.exec() accesses shared state

**Status**: 🔲 DEFERRED - Requires model handler interface change

**File**: `src/agent/core/flows/ResponseCycleFlow.ts:439,474`

**Problem**: exec() accesses `store.workspace` instead of extracting in prep().

**Reason for Deferral**: `processThinkingBlock()` mutates workspace state. Fixing this requires:

1. Changing model handler interface to return thinking data without mutation
2. Moving workspace mutation to post()

This is a larger refactoring that affects all model handlers.

---

### 3. PocketFlow Violation: ResponseContinuationNode.exec() accesses shared state

**Status**: 🔲 DEFERRED - Requires model handler interface change

**File**: `src/agent/core/flows/ResponseCycleFlow.ts:742,766-767`

**Problem**: exec() accesses `store.round`, `store.run` for decision logic.

**Reason for Deferral**: `checkStopConditions()` uses mutable store state. Similar to issue #2.

---

### 4. PocketFlow Violation: ToolUseProcessNode.exec() accesses shared state

**Status**: 🔲 DEFERRED - Requires model handler interface change

**File**: `src/agent/core/flows/ToolUseCycleFlow.ts:451,457`

**Problem**: exec() accesses `store.workspace` directly.

**Reason for Deferral**: Same as issue #2 - `processThinkingBlock()` mutates workspace.

---

### 5. PocketFlow Violation: ReflectionRoundNode.exec() performs mutations

**Status**: ✅ FIXED

**File**: `src/agent/implementations/flows/ReflectionRunFlow.ts:150-154`

**Problem**: exec() called `agent.beginRound()` which mutates agent state.

**Fix Applied**: Moved `beginRound()` call to prep() where state initialization belongs:

```typescript
// BEFORE (in exec):
prepRes.agent.beginRound(prepRes.roundIndex, ...);

// AFTER (in prep):
if (!shouldFinalize) {
  agent.beginRound(state.currentRound, state.runState, state.conversation);
}
```

---

## 🟠 HIGH Issues

### 6. Flows Typed to Concrete Agent Implementations

**Status**: ✅ FIXED

**Files**:

- `src/agent/core/IAgent.ts` - Added `IFlowAgent` base interface
- `src/agent/implementations/flows/ToolUseRunFlow.ts` - Added `IToolUseFlowAgent`
- `src/agent/implementations/flows/ReflectionRunFlow.ts` - Added `IReflectionFlowAgent`
- `src/agent/implementations/flows/common/AgentRunFlowRunner.ts` - Updated constraint
- `src/agent/implementations/BaseAgent.ts` - Updated `executeAgentRunFlow` constraint

**Problem**: `ToolUseRunShared` was typed to `BaseToolUseAgent<C>` instead of an interface.

**Fix Applied**:

1. Created `IFlowAgent` base interface with `isInterruptionRequested()` and `getRunHooks()`
2. Created `IToolUseFlowAgent extends IFlowAgent` with session lifecycle methods
3. Created `IReflectionFlowAgent extends IFlowAgent` with round execution methods
4. Updated `AgentRunShared` constraint from `BaseAgent<any>` to `IFlowAgent`
5. Updated flow type aliases to use the new interfaces

---

### 7. Incomplete Hook Interfaces - Direct Agent Calls

**Status**: 📝 DOCUMENTED AS INTENTIONAL

**File**: `src/agent/implementations/flows/ToolUseRunFlow.ts:67-70`

**Problem**: ~5 session lifecycle methods called directly on agent instead of via hooks:

- `waitForFollowUp()`
- `applyFollowUp()`
- `clearPersistedSnapshot()`
- `checkInterruption()`
- `hasQueuedFollowUp()`

**Analysis**: The code comment at lines 67-70 documents this as intentional:

> "Session lifecycle methods are called directly on the agent, not via hooks.
> This follows PocketFlow's pattern where nodes interact with the domain object
> (agent) directly for stateful operations."

The `IToolUseSession` interface now focuses only on follow-up queue operations. Stream status
transitions (`WAITING`, `RUNNING`) are handled directly by flow nodes via `StreamStatusService`
for explicit control flow visibility.

**Consideration for future**: Interruption checks (`isInterruptionRequested()`) happen in multiple
places across flows. Could potentially be centralized at a higher abstraction layer, but this
would require significant architectural changes to the PocketFlow node execution model.

---

### 8. Unhandled I/O Errors in post() Methods

**Status**: 📝 ANALYZED - Documented as Intentional

**Files**:

- `ResponseCycleFlow.ts` - ResponseProcessNode.post() file writes
- `ToolUseCycleFlow.ts` - ToolUseDispatchNode.post() message processing
- `ToolUseRunFlow.ts` - ToolUseCycleNode.post() checkpoint persistence
- `ToolUseRunFlow.ts` - ToolUseWaitNode.post() agent lifecycle calls

**Problem**: I/O operations not wrapped in try/catch.

**Analysis**: These I/O operations (checkpoint persistence, round finalization, file writes) are
critical to agent state consistency. Making them silently fail could lead to:

- Lost user progress
- Inconsistent conversation state
- Orphaned resources

**Decision**: Errors are intentionally fatal. If critical I/O fails, the run should abort with
a clear error rather than continue in a corrupted state. Non-critical operations (debug files)
already have appropriate handling.

---

### 9. AgentCycleBaseOptions Too Wide

**Status**: 📝 ANALYZED - Low Priority

**File**: `src/agent/core/AgentCycleOptions.ts`

**Problem**: Exposes `userVarChannels` internal architecture to cycles.

**Analysis**: Checked usage - `userVarChannels` in the options is never accessed directly
by cycle code (verified via grep). Only `userVars` (which is `userVarChannels.transient`)
is actually used. The field is passed through but unused.

**Recommendation**: Future cleanup - mark as deprecated or remove in next major version.
Not urgent as it doesn't affect functionality.

---

### 10. Extension Points Bypass Hook System

**Status**: 📝 ANALYZED - Intentional Pattern

**Files**:

- `src/agent/implementations/flows/common/StandardInitNode.ts` - beforeStart()
- `src/agent/implementations/flows/common/StandardFinalizeNode.ts` - beforeEnd()

**Problem**: These extension points bypass the hook abstraction.

**Analysis**: `beforeStart()` and `beforeEnd()` are protected template methods designed for
subclass extension, not for external hook injection. This is the Template Method pattern,
which is different from the Hook pattern used by `AgentRunHooks`.

The two patterns serve different purposes:

- Template Methods: Allow subclasses to customize specific steps
- Hooks: Allow external callers to inject behavior

Both patterns are valid and coexist appropriately.

---

## 🟡 MEDIUM Issues

### 11. Identical Hook Implementations Should Be Internalized

**Status**: ✅ FIXED

**Files Modified**:

- `src/agent/core/IAgent.ts` - Added lifecycle methods to `IFlowAgent`, removed `AgentRunHooks`
- `src/agent/implementations/BaseAgent.ts` - Added lifecycle method implementations, removed `getRunHooks()`
- `src/agent/implementations/BaseToolUseAgent.ts` - Added lifecycle overrides, simplified `run()`
- `src/agent/implementations/BaseReflectionAgent.ts` - Added lifecycle overrides, simplified `run()`
- `src/agent/implementations/flows/common/StandardInitNode.ts` - Calls agent lifecycle directly
- `src/agent/implementations/flows/common/StandardFinalizeNode.ts` - Calls agent lifecycle directly
- `src/agent/implementations/flows/common/AgentRunFlowRunner.ts` - Simplified to accept hooks directly

**Problem**: All 5 base hooks (start, init, initializeClient, end, cleanup) had identical implementations
spread across BaseToolUseAgent and BaseReflectionAgent.

**Fix Applied**:

1. Moved lifecycle methods to `IFlowAgent` interface (startRun, initRun, endRun, cleanupRun)
2. Implemented lifecycle methods in `BaseAgent` with standard behavior
3. Agent subclasses override only when they need different behavior:
   - `BaseToolUseAgent`: Reuses stages, custom cleanup with session dispose
   - `BaseReflectionAgent`: Requires run stage, sets up storageKey
4. Flow-specific hooks (e.g., `resetPromptBuilder`, `prepareState`) remain as separate interfaces
5. Eliminated the `extendHooks` pattern - callers now provide hooks directly
6. Removed unused `AgentRunHooks` interface and `getRunHooks()` method

### 12. Inconsistent State Naming (conversation vs messages)

**Status**: 🔲 Not Started

**Problem**: Run flows use `conversation`, cycle flows use `messages`.

### 13. Phase Transition Timing Inconsistency

**Status**: 🔲 Not Started

**Problem**: Different nodes set phase at different points (prep vs exec vs post).

### 14. Confusing Hook Override Pattern

**Status**: ✅ FIXED (part of Issue #11)

**File**: `src/agent/implementations/BaseToolUseAgent.ts:160-187`

**Problem**: Uses both `hookOverrides` and `extendHooks` in same call.

**Fix Applied**: Eliminated the `extendHooks`/`hookOverrides` pattern entirely.
Now callers provide flow-specific hooks directly and lifecycle methods are on the agent.

### 15. RetryableInvocationNode Requires Agent Context

**Status**: 🔲 Not Started

**File**: `src/agent/core/flows/RetryState.ts:165-200`

**Problem**: Nodes reach up to get streamId from agent context.

### 16. runState Reference Replacement Risk

**Status**: 🔲 Not Started

**File**: `src/agent/implementations/flows/ReflectionRunFlow.ts:214`

**Problem**: runState object reference is replaced, may cause sync issues.

### 17. shouldSkipCycle Mutation Pattern

**Status**: 🔲 Not Started

**File**: `src/agent/implementations/flows/ToolUseRunFlow.ts:268,299,347`

**Problem**: Flag state might be inconsistent during retries.

---

## 🟢 LOW Issues

### 18. FlowTransition Constants Location

**Status**: 🔲 Not Started

**Problem**: PocketFlow-specific constants in core/flows instead of agent/node.

### 19. core/index.ts Exports Cycle Modules

**Status**: 🔲 Not Started

**Problem**: Blurs boundary between public and private abstractions.

### 20. Async Style Inconsistency

**Status**: 🔲 Not Started

**Problem**: Some hooks return `void | Promise<void>` instead of `Promise<void>`.

---

## Change Log

| Date       | Commit  | Issues Fixed                                                   |
| ---------- | ------- | -------------------------------------------------------------- |
| 2025-12-25 | 5169dd4 | #1 Response time units, #5 ReflectionRoundNode mutation        |
| 2025-12-25 | aec2efc | #6 Flow agent interface decoupling                             |
| 2025-12-25 | 7953c64 | #11 Internalized lifecycle, #14 Eliminated extendHooks pattern |

---

## Notes

### Lifecycle Method Consolidation

The `startRun()` and `initRun()` methods were combined into a single `startAndInitRun()` method
since they were always called together sequentially. This simplifies:

- The `IFlowAgent` interface (4 methods instead of 5)
- Call sites in `StandardInitNode` (one call instead of two)
- Eliminates the pass-through of runStage from start to init

Each agent type retains its custom behavior:

- `BaseAgent`: Creates stage and initializes
- `BaseToolUseAgent`: Reuses stages, no new stage during init
- `BaseReflectionAgent`: Requires stage, sets storageKey before init

### Issues #2, #3, #4: Model Handler Interface Refactoring

These issues share a common root cause: `processThinkingBlock()` and `checkStopConditions()`
access and mutate shared state from within exec().

**Proper fix requires**:

1. Change `processThinkingBlock(response, workspace)` to return thinking data without mutation
2. Change `checkStopConditions(...)` to take snapshots instead of mutable state references
3. Move all workspace/state mutations to post()

This is a cross-cutting change affecting:

- All model handlers (Anthropic, OpenAI, Google, DeepSeek, etc.)
- IModelHandler interface
- All cycle flow nodes that call these methods

**Recommendation**: Create a separate issue/PR for this refactoring.
