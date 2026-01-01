# Design Philosophy Violations Report

This document catalogs violations of PocketFlow philosophy and Ousterhout's software design principles found in the TeXRA codebase.

## Summary

| Category                          | Severity | Status           | Primary Files           |
| --------------------------------- | -------- | ---------------- | ----------------------- |
| Node Lifecycle (exec() mutations) | CRITICAL | **FIXED**        | MediaPreparationNode.ts |
| State Slice Exposure in Services  | HIGH     | Re-evaluated: OK | CycleServices.ts        |
| Snapshot Pattern Complexity       | MEDIUM   | Documented       | ReflectionFlowState.ts  |
| Services Interface Size           | MEDIUM   | Documented       | BaseFlowServices.ts     |

---

## Fixed Violations

### 1. exec() Mutates State via latexMediaManager ✅ FIXED

**File**: `src/agent/implementations/flows/reflection/nodes/MediaPreparationNode.ts`

**Original Problem**: `exec()` mutated `workspaceState` via `latexMediaManager.processInputFiles()`, violating PocketFlow's principle that `exec()` should be compute-only.

**Fix Applied**:

- `prep()` now creates an **isolated** `AgentWorkspaceState` for media extraction
- `exec()` mutates only the isolated workspace (not shared state)
- `post()` merges the extracted media into the actual shared state

This follows the correct PocketFlow pattern:

```typescript
// prep() - create isolated workspace for extraction
const isolatedWorkspace = AgentWorkspaceState.create();

// exec() - extract into isolated workspace (compute-only from shared state perspective)
await latexMediaManager.processInputFiles(files, isolatedWorkspace, ...);
return { mediaFiles: isolatedWorkspace.media.files };

// post() - merge extracted media into actual shared state
const workspaceState = getWorkspaceState(shared);
workspaceState.media.addMediaFiles(execRes.mediaFiles);
updateWorkspaceSnapshot(shared, workspaceState);
```

---

## Re-evaluated Issues

### 2. State Slices Exposed via Services — Re-evaluated: Acceptable Pattern

**File**: `src/agent/core/flows/CycleServices.ts:72-87`

**Original Concern**: Services expose state slices (`round`, `run`, `workspace`) directly.

**Re-evaluation**: Upon closer inspection, the state objects use **method-based APIs** for all mutations:

- `round.reset(nextRoundIndex)`
- `round.setNormalizedUsage(usage)`
- `run.incrementRounds()`
- `workspace.resetReasoning()`

No direct field assignments occur (e.g., `services.round.someField = value`). The state classes encapsulate their mutations behind controlled methods, which is proper OOP encapsulation.

**Conclusion**: This is an acceptable pattern. The state objects expose a controlled mutation API, not raw fields.

---

## Known Complexity (Documented, Not Fixed)

### 3. Snapshot Pattern Complexity

**File**: `src/agent/implementations/flows/reflection/ReflectionFlowState.ts`

**Issue**: The "reconstruct → mutate → update snapshot" pattern adds cognitive overhead:

```typescript
// 1. Reconstruct class instance from snapshot
const workspaceState = getWorkspaceState(shared);

// 2. Mutate the instance
workspaceState.media.addMediaFiles(mediaFiles);

// 3. Update snapshot to persist changes
updateWorkspaceSnapshot(shared, workspaceState);
```

**Why It Exists**: This pattern is necessary for `PersistedFlow` serialization. The flow must support `structuredClone()` for persistence, which requires plain JSON snapshots instead of class instances.

**Mitigation**: The helper functions (`getWorkspaceState`, `updateWorkspaceSnapshot`) centralize the pattern and include detailed documentation explaining when and how to use them.

### 4. Services Interface Size

**File**: `src/agent/implementations/flows/common/BaseFlowServices.ts:52-82`

**Issue**: `BaseFlowContextInit` has 9+ fields across multiple concerns (model handling, configuration, interruption, etc.).

**Why It Exists**: Agent flows require access to many dependencies. The current design trades interface size for explicit dependency declaration.

**Future Improvement**: Could split into smaller, composable interfaces if the number of flow types grows significantly.

---

## Low Severity (Accepted)

### 5. Imperative Array Mutations in post()

**File**: `src/agent/implementations/flows/reflection/nodes/ResponseCycleCompositionNode.ts:323`

```typescript
shared.roundStateSnapshots.push(prepRes.context.stateRoundSnapshot);
```

**Status**: Accepted. Mutations in `post()` are allowed by PocketFlow. Using `.push()` is idiomatic JavaScript.

### 6. Sub-flow Composition in exec()

**File**: `src/agent/implementations/flows/reflection/nodes/ResponseCycleCompositionNode.ts:147-253`

**Status**: Accepted. Running sub-flows in `exec()` is a valid pattern for flow composition. The state passed to sub-flows is managed through the node's prep/post lifecycle.

---

## Changelog

- **2025-01-01**: Fixed CRITICAL issue in MediaPreparationNode. Re-evaluated state slice exposure as acceptable pattern.
