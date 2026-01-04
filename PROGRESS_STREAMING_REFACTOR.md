# Progress View Streaming Refactoring

## Overview
This document tracks the consolidation of the progress view streaming system to eliminate abstraction overhead and duplicate code paths.

**Branch:** `claude/fix-progress-view-streaming-SVWB1`
**Started:** 2026-01-04

---

## Phase 1: High Impact, Low Risk

### 1.1 Eliminate StreamStatusService Redundancy
**Status:** ✅ Completed

**Problem:** Two Maps maintain identical stream status data:
- `StreamStatusService.statusMemory` (src/agent/runtime/StreamStatusService.ts:9)
- `ProgressEventHandler._streamStatus` (src/progressView/events/ProgressEventHandler.ts:39)

**Solution:** Made StreamStatusService the single source of truth. Removed `_streamStatus` from ProgressEventHandler, which now reads from StreamStatusService.

**Files modified:**
- [x] `src/agent/runtime/StreamStatusService.ts` - Added `setLocal()`, `entries()`, `getAll()`, `has()` methods
- [x] `src/progressView/events/ProgressEventHandler.ts` - Removed `_streamStatus`, all reads now go through StreamStatusService
- [x] `src/extension.ts` - Updated comments to reflect new architecture

**Actual reduction:** ~10 LOC + eliminated duplicate data structure

---

### 1.2 Consolidate WebviewUpdater Methods
**Status:** ⏭️ Skipped

**Reason:** The 20+ methods have different signatures and payload structures that provide type safety. Making them generic would sacrifice type safety for minimal code reduction (~200 LOC → ~150 LOC, only ~50 LOC savings).

---

### 1.3 Extract Event Handler Helper Pattern
**Status:** ⏭️ Skipped

**Reason:** The handlers have slightly different patterns - some check `activeStream`, some don't. Adding a helper would save only ~5-10 lines and add complexity.

---

## Phase 2: Medium Impact

### 2.1 Consolidate Log Event Emission
**Status:** ⏭️ Skipped

**Reason:** `AgentLogger.createStream()` and `VSCodeTransport.emitLogEvent()` serve different purposes (streaming vs one-shot logging) with different ID management patterns. Extracting a shared helper would add complexity.

---

### 2.2 Simplify Context Stack Management
**Status:** ✅ Completed

**Problem:** Over-engineered context management in logUtils.ts:
- `previousStacks` Map storing backup of stack before each push
- Complex restore logic on pop
- Unused `getContext` and `setContext` functions

**Solution:**
- Removed `previousStacks` Map entirely (eliminated memory leak risk)
- Removed unused `getContext` and `setContext` functions
- Simplified `popGroupContext` to filter specific groupId instead of restoring backup
- Still supports non-LIFO group endings

**Files modified:**
- [x] `src/logger/logUtils.ts` - Simplified context management

**Actual reduction:** ~30 LOC

---

## Progress Log

### 2026-01-04
- ✅ Completed architecture analysis with 4 subagent investigations
- ✅ Identified major redundancy: duplicate stream status Maps
- ✅ Phase 1.1: Made StreamStatusService single source of truth
- ✅ Phase 2.2: Simplified context stack management
- ⏭️ Skipped Phases 1.2, 1.3, 2.1 (minimal benefit, added complexity)

---

## Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Duplicate stream status Maps | 2 | 1 | **-50%** |
| Context management LOC | ~80 | ~50 | **-30 LOC** |
| previousStacks memory leak | Yes | No | **Fixed** |
| Unused helper functions | 2 | 0 | **Removed** |

## Summary

**Total changes:**
- Eliminated duplicate `_streamStatus` Map from ProgressEventHandler
- Made StreamStatusService the single source of truth for stream status
- Added `setLocal()`, `entries()`, `getAll()`, `has()` to StreamStatusService
- Simplified logUtils.ts context stack management
- Removed unused code and potential memory leak

**Net reduction:** ~40 LOC + architectural simplification

