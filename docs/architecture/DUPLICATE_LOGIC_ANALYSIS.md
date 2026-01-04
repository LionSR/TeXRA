# Duplicate Logic Analysis: Agent/Node/PocketFlow System

This document details the findings from a comprehensive analysis of code duplication and abstraction overhead in the agent flow architecture.

## Executive Summary

- **Total duplicated/extractable code:** ~250-290 lines (12-15% of cycle flows)
- **Dead code identified:** 57 lines (BatchNode variants, completely unused)
- **Primary overlap:** ResponseCycleFlow vs ToolUseCycleFlow (89% overlap in invocation nodes)
- **Architectural inconsistency:** Native nesting vs separate state patterns

## 1. Dead Code (Immediate Removal)

### Location: `src/agent/node/index.ts`

Four batch-related classes that are exported but never used:

```typescript
// Lines ~214-302 - DEAD CODE
BatchNode<S, P, Svc>        // 12 lines
ParallelBatchNode<S, P, Svc> // 9 lines
BatchFlow<S, P, Svc>         // 19 lines
ParallelBatchFlow<S, P, Svc> // 17 lines
// Total: 57 lines
```

**Evidence:** Zero imports or instantiations found anywhere in codebase.

**Recommendation:** Delete these classes.

## 2. High-Overlap Duplication: Cycle Flows

### ResponseCycleFlow.ts vs ToolUseCycleFlow.ts

| Node Pair | Lines (Resp/Tool) | Overlap | Extractable |
|-----------|-------------------|---------|-------------|
| Prep Nodes | 61 / 40 | 55% | ~20 lines |
| Invocation Nodes | 95 / 82 | **89%** | ~75 lines |
| Process Nodes | 254 / 180 | 65% | ~90 lines |
| Continuation/Dispatch | 130 / 256 | 45% | ~40 lines |

### Invocation Node Pattern (89% overlap)

Both `ResponseModelInvocationNode` and `ToolUseCallNode` extend `RetryableInvocationNode` with nearly identical implementations:

```typescript
// Both follow this pattern:
async prep(shared): Promise<BaseInvocationPrepResult>
async exec(prepRes): Promise<InvocationResult<BaseInvocationSuccessData>>
async execFallback(_prepRes, error): Promise<InvocationResult>
async post(shared, _prepRes, execRes): Promise<string | undefined>
```

**Differences:**
- Response: Includes `systemPrompt`, sets streaming=false
- ToolUse: Includes `tools` parameter, sets streaming=true

**Recommendation:** Create `GenericRetryableInvocationNode` base class.

### Process Node Patterns (65% overlap)

Duplicated patterns:
- Thinking block extraction and logging
- Usage normalization with `modelHandler.normalizeUsage()`
- Response text preview logging
- Group ID capture for logging

**Recommendation:** Extract `extractCommonProcessingData()` helper.

## 3. Implementation Flow Overlap

### ReflectionFlow vs ToolUseRunFlow

| Aspect | Reflection | ToolUse | Overlap |
|--------|------------|---------|---------|
| Context factory | createReflectionFlowContext | createToolUseFlowContext | 70% |
| Cycle node | ResponseCycleNode | ToolUseCycleNode | **85%** |
| Prepare node | PrepareContextNode | ToolUsePrepareNode | 70% |
| Entry point | runReflectionFlow | runToolUseFlow | 80% |

### Architectural Inconsistency

**ReflectionFlow (preferred pattern):**
- Uses "native nesting" - cycle runs directly on parent shared state
- Uses `RoundPersistedFlow` for round management
- Located properly in `reflection/` directory

**ToolUseRunFlow (inconsistent pattern):**
- Uses "separate state" - creates separate `cycleShared` object
- Uses basic `PersistedFlow`
- Misplaced at parent level (`implementations/flows/ToolUseRunFlow.ts`)

**Recommendation:**
1. Move `ToolUseRunFlow.ts` into `tooluse/` directory
2. Adopt native nesting pattern for consistency

## 4. Services Pattern Redundancy

### Duplicated State Slices

**Core definition (CycleServices.ts:59-83):**
```typescript
export interface CycleStateSlices extends BaseCycleStateSlices {
  round: ConversationRoundState;
}
```

**Local copy (ResponseCycleNode.ts:63-67):**
```typescript
interface CycleStateSlices {  // Duplicate definition
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
}
```

**Recommendation:** Remove local copy, import from CycleServices.

### FlowServiceAccessors Redundancy

Creates dual access paths to the same data:
```typescript
services.logger  // via FlowServiceAccessors shortcut
services.executionContext.logger  // original path
```

**Recommendation:** Consider removing shortcuts in favor of explicit paths.

## 5. Refactoring Plan

### Phase 1: Quick Wins (Immediate)

1. **Delete dead Batch classes** - 57 lines saved
   - Location: `src/agent/node/index.ts:214-302`

2. **Remove duplicate CycleStateSlices** - 5 lines saved
   - Location: `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts:63-67`
   - Import from `@agent/core/flows/CycleServices` instead

3. **Move ToolUseRunFlow.ts** - 0 lines, better structure
   - From: `src/agent/implementations/flows/ToolUseRunFlow.ts`
   - To: `src/agent/implementations/flows/tooluse/ToolUseRunFlow.ts`

### Phase 2: Extract Common Patterns

4. **Create GenericRetryableInvocationNode** - ~30-40 lines extracted
   ```typescript
   abstract class GenericRetryableInvocationNode<C, TOptions> {
     protected abstract getInvocationParams(prepRes): InvocationParams;
     protected abstract getPostDebugOptions(): DebugFileOptions;
     // Shared prep() and post() implementations
   }
   ```

5. **Create shared debug saving helper** - ~20-25 lines extracted
   ```typescript
   async function saveResponseDebugObject(response, services, options)
   ```

6. **Create thinking/usage extraction helper** - ~25-30 lines extracted
   ```typescript
   function extractCommonProcessingData(response, modelHandler, workspace, responseTimeMs)
   ```

### Phase 3: Architecture Alignment (Future)

7. Standardize on native nesting pattern for ToolUseFlow
8. Unify cycle options with discriminated union
9. Evaluate FlowServiceAccessors necessity

## 6. File References

### Core Files with Duplication
- `src/agent/core/flows/ResponseCycleFlow.ts` (975 lines)
- `src/agent/core/flows/ToolUseCycleFlow.ts` (1022 lines)
- `src/agent/core/flows/CycleServices.ts` (225 lines)

### Implementation Files with Overlap
- `src/agent/implementations/flows/ToolUseRunFlow.ts` (misplaced)
- `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts`
- `src/agent/implementations/flows/reflection/ReflectionServices.ts`
- `src/agent/implementations/flows/tooluse/ToolUseServices.ts`

### Node Base Classes
- `src/agent/node/index.ts` (311 lines, includes 57 dead)
- `src/agent/node/persisted-flow.ts` (228 lines)
- `src/agent/node/round-persisted-flow.ts` (407 lines)
- `src/agent/core/flows/RetryState.ts` (559 lines)

## 7. Summary Statistics

| Category | Lines | Notes |
|----------|-------|-------|
| Dead code (Batch classes) | 57 | Safe to delete |
| Invocation node overlap | 75-80 | 89% similarity |
| Process node overlap | 90-100 | 65% similarity |
| Prep node overlap | 20 | 55% similarity |
| Debug pattern duplication | 20-25 | 4 nodes |
| Services redundancy | 15-20 | Multiple files |
| **Total Extractable** | **~250-290** | 12-15% of flows |
