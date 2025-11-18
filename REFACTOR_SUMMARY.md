# Agent/Flow Round-Trip Refactoring Summary

## Problem Statement

The agent/flow system had severe round-trip anti-patterns with ~30 boundary crossings per round where it should have 3-5 one-way calls:

- **Hook indirection**: Flow → Hook → Agent method (7 crossings for init)
- **Nested flow creation**: Flow → Agent → New Flow → Hooks → Agent (9+ crossings)
- **Direct mutation**: Flows mutating agent internals violating encapsulation

## Solution Overview

### Architecture Principles Applied

1. **Single Source of Truth**: Agent owns its state and execution logic
2. **DRY (Don't Repeat Yourself)**: No duplication of orchestration logic
3. **Balanced Abstractions**: No pass-through layers that add cognitive overhead
4. **Clear Boundaries**: Flows orchestrate, agents execute, results flow back cleanly

### Phase 1: Remove Hook Indirection ✓

**Changes:**

- Made agent methods public: `prepareAgentWorkspaceState()`, `prepareRoundContext()`, `runRoundPipeline()`, `getOutputFileLocation()`
- Made `withRoundStage()` public in BaseAgent
- Made `resetPromptBuilder()` public in BaseReflectionAgent
- **Eliminated**: ReflectionRoundHooks interface (was just wrappers)
- **Impact**: Reduced from 7 boundary crossings to 0

**Files Modified:**

- `src/agent/implementations/BaseAgent.ts`
- `src/agent/implementations/BaseReflectionAgent.ts`
- `src/agent/implementations/MergeAgent.ts`

### Phase 2: Consolidate Round Execution ✓

**Changes:**

- Added `agent.executeRound()` - single entry point that composes all round steps:
  1. Prepare workspace state
  2. Prepare round context
  3. Handle skip case or execute pipeline
- **Deleted**: `ReflectionRoundFlow.ts` (unnecessary abstraction layer)
- ReflectionRunFlow now calls `agent.executeRound()` directly
- **Impact**: Eliminated 9+ boundary crossings, collapsed 2 abstraction layers into 1

**Files Modified:**

- `src/agent/implementations/BaseReflectionAgent.ts` (added `executeRound()`)
- `src/agent/implementations/flows/ReflectionRunFlow.ts` (simplified)
- **Deleted**: `src/agent/implementations/flows/ReflectionRoundFlow.ts`

### Phase 3: Respect Boundaries ✓

**Changes:**

- Added `agent.recordRoundResult()` method for state recording
- Flows return results, agent records them (no direct mutation)
- Removed direct mutations: `agent.roundStates.push()`, `agent.workspaceStates.push()`, etc.
- **Impact**: Clean separation - flows orchestrate, agents own state

**Data Flow:**

```
Before: Flow → Agent → Flow mutates agent internals
After:  Flow → Agent.executeRound() → Result → Agent.recordRoundResult()
```

### Phase 4: Tool-Use Consistency ✓

**Changes:**

- Made session management methods public:
  - `waitForFollowUp()`
  - `hasQueuedFollowUp()`
  - `enterWaitingState()`
  - `markRunning()`
  - `clearPersistedSnapshot()`
  - `prepareInitialSessionState()`
  - `buildToolUseCycleOptions()`
  - `applyFollowUpMessage()` (adds logging + state update logic)
- **Removed pass-through wrappers**: `runToolUseCycle()`, `logFinalizeWarning()`
- Flows call `runToolUseCycle()` from core module directly (no agent wrapper)
- Flows call `logger.warn()` directly (no wrapper)
- **Impact**: Only methods that add meaningful logic or manage agent state remain

### Phase 5: Finalize Node Enhancement ✓

**Changes:**

- Updated `FinalizeNodeContext` to include `agent` parameter
- Finalize/cleanup callbacks can now call agent APIs directly
- **Impact**: More flexible finalization, can access agent state/methods

**Files Modified:**

- `src/agent/implementations/flows/common/nodeExecution.ts`
- `src/agent/implementations/flows/common/createFinalizeNode.ts`

## Results

### Boundary Crossing Reduction

- **Before**: ~30 crossings per round
- **After**: ~3 crossings per round
- **Improvement**: ~90% reduction

### Abstraction Layers

- **Removed**: ReflectionRoundFlow (entire file)
- **Removed**: ReflectionRoundHooks interface
- **Removed**: Pass-through wrapper methods
- **Added**: Single entry point methods that compose internal steps

### Code Quality Improvements

1. **Single Source of Truth**: Agent methods are the canonical implementation
2. **No Duplication**: Round orchestration logic exists in one place (`executeRound()`)
3. **Clear Boundaries**:
   - Agents: Own state, execute rounds, expose composed operations
   - Flows: Orchestrate runs, handle lifecycle, pass results
   - No bidirectional coupling or hidden mutations
4. **Balanced Abstractions**:
   - Kept: Methods that manage agent state or add business logic
   - Removed: Pass-through wrappers that just call other modules
   - Result: Each layer adds clear value

### API Surface

**Public Agent Methods (Reflection):**

- `executeRound()` - Single entry point for round execution
- `recordRoundResult()` - Record results without mutation
- `prepareAgentWorkspaceState()` - Prepare workspace (can be overridden)
- `prepareRoundContext()` - Prepare round context (can be overridden)
- `runRoundPipeline()` - Execute pipeline (can be overridden)
- `getOutputFileLocation()` - Get output location (can be overridden)
- `resetPromptBuilder()` - Reset builder state
- `withRoundStage()` - Execute within logging stage

**Public Agent Methods (Tool-Use):**

- `prepareInitialSessionState()` - Initialize session
- `buildToolUseCycleOptions()` - Build cycle options
- `waitForFollowUp()` - Wait for user input
- `hasQueuedFollowUp()` - Check for queued input
- `enterWaitingState()` - Enter waiting state
- `markRunning()` - Mark as running
- `clearPersistedSnapshot()` - Clear snapshot
- `applyFollowUpMessage()` - Apply follow-up (adds logging + state update)

## Breaking Changes

**None.** All changes are internal refactoring:

- Public API preserved (run(), interrupt(), etc.)
- Serialization format unchanged
- Method overrides still work (CoTAgent, DirectAgent, MergeAgent)
- Interruption handling preserved
- Logging and progress tracking maintained

## Testing Recommendations

1. Verify all agent types (Direct, CoT, Merge, ToolUse)
2. Test round execution and state management
3. Verify interruption handling
4. Test hydration/serialization
5. Verify override behavior in subclasses
6. Test tool-use follow-up cycles

## Benefits

- **Maintainability**: Clearer separation of concerns
- **Debuggability**: Fewer layers to trace through
- **Extensibility**: Public APIs make customization easier
- **Performance**: Fewer function calls and boundary crossings
- **Cognitive Load**: Direct calls instead of callback chains
