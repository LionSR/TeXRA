# RoundPersistedFlow Implementation Progress

## Overview

This document tracks the implementation of `RoundPersistedFlow`, a native PocketFlow extension that manages round-based execution at the flow level rather than the node level.

**Key insight**: Rounds are a FLOW-level concern, but currently managed at NODE-level. This creates scattered logic, mutable service fields, and complex node responsibilities.

**Solution**: Extend PersistedFlow (same pattern it uses to extend Flow) and override `run()` to add round iteration.

## Design Goals

1. **Native pattern**: Follow the same inheritance pattern as PersistedFlow extends Flow
2. **Centralized lifecycle**: Stage creation, transition, and cleanup in one place
3. **Immutable services**: No more mutable `roundStage` field
4. **Pure domain nodes**: Nodes focus on domain logic, not orchestration
5. **Preserve resume**: Work with existing PersistedFlow persistence

## Architecture

```
Flow (base orchestration)
  ↓ extends
PersistedFlow (adds node-level persistence via step())
  ↓ extends
RoundPersistedFlow (adds round iteration in run())
```

## Implementation Status

### Phase 1: Core Infrastructure

- [x] RoundAwareState interface
- [x] RoundPersistedFlow base class
- [x] Lifecycle hooks interface
- [x] Helper functions

### Phase 2: ReflectionFlow Migration

- [x] ReflectionFlowShared already extends RoundAwareState (has currentRound, totalRounds, etc.)
- [x] Create reflection-specific hooks (createRoundStage)
- [x] Update runReflectionFlow to use RoundPersistedFlow
- [x] Simplify RoundCompleteNode (removed stage management)

### Phase 3: Cleanup

- [x] Remove mutable roundStage from services (field removed entirely)
- [x] Implement resetForNextRound hook (was declared but never called)
- [x] Move workspace reset from RoundCompleteNode to hook
- [x] Fix 'interrupted' status detection in RoundPersistedFlow
- [ ] Update tests
- [ ] Documentation

---

## Progress Log

### Entry 1: Initial Setup

**Status**: Complete
**Date**: 2026-01-01

Created core infrastructure:

- `src/agent/node/round-persisted-flow.ts` - RoundPersistedFlow class with lifecycle hooks

### Entry 2: Design Revision

**Status**: Complete
**Date**: 2026-01-01

Revised the design to work with existing graph structure:

**Original plan**: External round iteration (flow runs graph once per round)
**Revised plan**: Detect round transitions via shared.currentRound changes

The existing node graph already handles round iteration via internal looping
(RoundCompleteNode returns CONTINUE to loop back to PrepareContextNode).
RoundPersistedFlow now just watches for round transitions and manages stages.

**Key insight**: The graph loops internally, but stage lifecycle is external.

### Entry 3: Implementation Complete

**Status**: Complete
**Date**: 2026-01-01

Files created:

- `src/agent/node/round-persisted-flow.ts` - 380 lines

Files modified:

- `src/agent/implementations/flows/reflection/runReflectionFlow.ts` - Use RoundPersistedFlow
- `src/agent/implementations/flows/reflection/nodes/RoundCompleteNode.ts` - Remove stage management

**Changes summary:**

1. **RoundPersistedFlow.run()** overrides PersistedFlow.run() to:
   - Create initial round stage (r0) before execution
   - Run nodes via inherited step() - graph loops internally
   - Detect round transitions by watching shared.currentRound changes
   - On transition: end old stage, create new stage via hooks
   - End final stage when graph completes

2. **RoundCompleteNode.post()** simplified:
   - Only increments currentRound (this triggers stage transition detection)
   - Removed: stage end/create code, workspace reset (moved to hook)

3. **runReflectionFlow.ts** updated:
   - Use RoundPersistedFlow instead of PersistedFlow
   - Configure createRoundStage hook
   - Configure resetForNextRound hook (workspace reset)
   - Configure checkInterruption hook (status detection)
   - Removed roundStage from services entirely

**Before/After comparison:**

| Aspect                  | Before                            | After                                                |
| ----------------------- | --------------------------------- | ---------------------------------------------------- |
| Stage creation (r0)     | runReflectionFlow.ts:184          | RoundPersistedFlow.run()                             |
| Stage creation (r1+)    | RoundCompleteNode.ts:137          | RoundPersistedFlow.handleRoundTransition()           |
| Stage end               | RoundCompleteNode + finally block | RoundPersistedFlow.handleRoundTransition() + finally |
| Workspace reset         | RoundCompleteNode.post()          | resetForNextRound hook                               |
| services.roundStage     | Mutable field, always null        | Field removed entirely                               |
| Interrupted status      | Never detected                    | checkInterruption hook                               |
| RoundCompleteNode lines | 150                               | ~140 (removed stage + workspace code)                |

---

### Entry 4: Code Review Cleanup

**Status**: Complete
**Date**: 2026-01-01

Code review revealed dead code and incomplete patterns. Fixed:

1. **Removed dead `roundStage` field** from ReflectionServices
   - Was always null, never read by any node
   - Removed from ReflectionServices.ts, ReflectionFlowContext.ts, runReflectionFlow.ts

2. **Implemented `resetForNextRound` hook**
   - Was declared in RoundLifecycleHooks but never called
   - Now called in handleRoundTransition() before creating new stage

3. **Moved workspace reset to flow level**
   - Was: RoundCompleteNode.post() called createFreshWorkspaceSnapshot()
   - Now: resetForNextRound hook in runReflectionFlow.ts handles it
   - RoundCompleteNode only increments currentRound (pure signaling)

4. **Fixed 'interrupted' status detection**
   - Was: status always 'completed' or 'error'
   - Now: detects interruption via checkInterruption hook or continueRounds flag

**Result**: Round logic is now truly invisible to nodes. RoundCompleteNode is pure domain logic (decide continue vs finalize, increment counter).

---

### Entry 5: Code Review Findings

**Status**: Complete
**Date**: 2026-01-01

Comprehensive code review by parallel subagents. Key findings:

**✅ Working Correctly:**

- Progress view integration: Round stages appear with correct parent-child hierarchy
- Serialization: All state fields are natively serializable (structuredClone safe)
- PrepareContextNode skip logic: Works correctly via round detection mechanism
- Tool-use flow: Different pattern, RoundPersistedFlow correctly focused on reflection

**Interface Improvements:**

- Removed `endTurn` from RoundAwareState (not used by flow, only by OutputNode)
- Interface now truly minimal: `currentRound`, `totalRounds`, `continueRounds`

**Architecture Verification:**

- Round logic is 60-70% invisible to nodes (legitimate domain uses remain)
- Nodes legitimately need `currentRound` for domain logic (output naming, media processing)
- Two round progression paths (PrepareContextNode skip, RoundCompleteNode continue) both trigger flow hooks

**Unused Hooks (intentional):**

- `onRoundStart`/`onRoundEnd`/`onFlowEnd` hooks declared but not used in runReflectionFlow
- Could integrate usage tracking via these hooks in future

**Not Generalized (by design):**

- RoundPersistedFlow is reflection-specific (counter-based detection)
- Tool-use flow has different iteration model (session-based cycles)
- Keep abstractions focused rather than over-generalized

---
