# Architectural Fixes Progress

## Summary

This document tracks the progress of architectural fixes to reduce complexity, eliminate circular references, and establish consistent patterns.

## Issues by Priority

### 1. 🔴 CRITICAL: Circular Reference in ToolUseFlow
**Status**: ✅ COMPLETE

**Problem**:
- `ToolUseCycleNode` calls `services.runCycle()`
- Which is bound to `runToolUseCycle()` in ToolUseFlowContext
- Which creates a new `ToolUseCycleFlow` each time
- Results in 6 layers of indirection and circular function references

**Solution**:
Make `ToolUseCycleNode` directly instantiate and run `ToolUseCycleFlow` (like `ResponseCycleCompositionNode` does)

**Files to modify**:
- `src/agent/implementations/flows/ToolUseRunFlow.ts` - Refactor ToolUseCycleNode
- `src/agent/implementations/flows/tooluse/ToolUseServices.ts` - Remove runCycle from interface
- `src/agent/implementations/flows/tooluse/ToolUseFlowContext.ts` - Remove runCycle binding

**Impact**: Reduces 6 layers → 4 layers, eliminates circular reference

---

### 2. 🟠 HIGH: Inconsistent Finalization Pattern
**Status**: 🔄 IN PROGRESS

**Problem**:
- ResponseCycleFlow has dedicated `ResponseCycleFinalizeNode` as convergence point
- ToolUseCycleFlow inlines finalization in `ToolUseProcessNode.post()`
- Mixes business logic with finalization, harder to trace

**Solution**:
Add `ToolUseFinalizeNode` to match ResponseCycle pattern

**Files to modify**:
- `src/agent/core/flows/ToolUseCycleFlow.ts` - Add ToolUseFinalizeNode, update flow wiring

**Impact**: Consistent pattern, clearer separation of concerns

---

### 3. 🟡 MEDIUM: Store vs Slices Redundancy
**Status**: ⏳ PENDING

**Problem**:
- `AgentSharedStore` wraps round/run/workspace/user
- `CycleStateSlices` has same fields (minus user, plus onRoundFinalized)
- Pattern: Store → Unwrap → Slices → Services (redundant unwrapping)

**Solution**:
Consider replacing Store class with static snapshot helpers, use slices directly

**Files affected**:
- `src/agent/core/AgentSharedStore.ts`
- `src/agent/core/flows/CycleServices.ts`
- Multiple consumers

**Impact**: Eliminates wrapper class, removes unwrapping pattern

---

### 4. 🟡 MEDIUM: runReflectionFlow Wrapper
**Status**: ⏳ PENDING

**Problem**:
- `runReflectionFlow` is ~300 lines of orchestration
- Just builds context, creates flow, wraps in PersistedFlow, runs
- Adds unnecessary abstraction layer

**Solution**:
Either inline to caller or minimize to pure setup

**Files affected**:
- `src/agent/implementations/flows/reflection/runReflectionFlow.ts`

**Impact**: Removes unnecessary abstraction layer

---

## Completed Fixes

| Date | Fix | Lines Changed |
|------|-----|---------------|
| 2026-01-01 | #1 Circular Reference - ToolUseCycleNode direct composition | -15 net (removed runCycle indirection) |

