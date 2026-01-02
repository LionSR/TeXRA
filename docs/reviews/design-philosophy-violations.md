# Design Philosophy Violations Report

This document catalogs violations of PocketFlow philosophy and Ousterhout's software design principles found in the TeXRA codebase.

## Summary

| Category                          | Severity | Status              | Primary Files          |
| --------------------------------- | -------- | ------------------- | ---------------------- |
| Node Lifecycle (exec() mutations) | CRITICAL | Acceptable (no retry) | MediaExtractionNode.ts |
| State Slice Exposure in Services  | HIGH     | Acceptable (method APIs) | CycleServices.ts       |
| Snapshot Pattern Complexity       | MEDIUM   | Documented          | ReflectionFlowState.ts |
| Services Interface Size           | MEDIUM   | Documented          | BaseFlowServices.ts    |

---

## Acceptable Patterns

### 1. exec() Mutates State via latexMediaManager

**File**: `src/agent/implementations/flows/reflection/nodes/MediaExtractionNode.ts`

**Observation**: `exec()` mutates `workspaceState` via `latexMediaManager.processInputFiles()`.

**Why It's Acceptable**: The node uses `NODE_NO_RETRY`, meaning no retries occur. Without retries, there's no risk of duplicate mutations. The pattern is simpler than creating an isolated workspace.

```typescript
constructor() {
  super(NODE_NO_RETRY, NODE_NO_WAIT);  // No retries - mutation is safe
}
```

The workflow is straightforward:
- `prep()`: Reconstruct workspace from snapshot
- `exec()`: Extract media (mutates workspace)
- `post()`: Update snapshot

### 2. State Slices Exposed via Services

**File**: `src/agent/core/flows/CycleServices.ts:72-87`

**Observation**: Services expose state slices (`round`, `run`, `workspace`) directly.

**Why It's Acceptable**: The state objects use **method-based APIs** for all mutations:

- `round.reset(nextRoundIndex)`
- `round.setNormalizedUsage(usage)`
- `run.incrementRounds()`
- `workspace.resetReasoning()`

No direct field assignments occur. The state classes encapsulate mutations behind controlled methods, which is proper OOP encapsulation.

---

## Known Complexity (Documented)

### 3. Snapshot Pattern Complexity

**File**: `src/agent/implementations/flows/reflection/ReflectionFlowState.ts`

**Issue**: The "reconstruct → mutate → update snapshot" pattern adds cognitive overhead.

**Why It Exists**: Necessary for `PersistedFlow` serialization. The flow must support `structuredClone()` for persistence.

**Mitigation**: Helper functions (`getWorkspaceState`, `updateWorkspaceSnapshot`) centralize the pattern with documentation.

### 4. Services Interface Size

**File**: `src/agent/implementations/flows/common/BaseFlowServices.ts:52-82`

**Issue**: `BaseFlowContextInit` has 9+ fields across multiple concerns.

**Why It Exists**: Agent flows require access to many dependencies. The design trades interface size for explicit dependency declaration.

---

## Changelog

- **2025-01-02**: Renamed MediaPreparationNode → MediaExtractionNode for clarity.
- **2025-01-02**: Re-evaluated exec() mutation as acceptable (NODE_NO_RETRY makes it safe).
- **2025-01-01**: Initial review of design philosophy violations.
