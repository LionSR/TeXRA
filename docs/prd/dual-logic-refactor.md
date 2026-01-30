# PRD: Dual Logic Path Consolidation

## Overview

Reduce high-impact duplicated logic paths by consolidating tool-use vs workflow handling into shared
utilities and controllers. The focus is to lower change amplification across the MainView,
ProgressView, and run-selection flows without altering user-facing behaviors.

## Problem Statement

The codebase contains multiple "dual logic paths" where the same feature is implemented separately
for tool-use and workflow flows (or for MainView vs ProgressView). This increases drift, makes
features harder to ship, and complicates reasoning about the system.

Five high-impact dual paths to refactor:

1. **Agent execution triggers (MainView vs ProgressView)**
   - `ExecutionManager.handleExecute` validates and dispatches `texra.execute` with UI-specific
     handling for tool-use vs workflow configuration.
   - `ProgressViewMessageHandler.handleRunNew` and `handleResume` re-dispatch `texra.execute` with
     separate resume logic and execution ID handling.
   - Impact: two execution entry points with different semantics and validation rules.

2. **File operation dispatch (MainView vs ProgressView)**
   - `ExecutionManager.handleFileOperation`/`handleMultipleOperation` issue commands for pack, clean,
     merge, compare, etc., based on MainView command messages.
   - `ProgressViewMessageHandler.handlePackStream`, `handleCleanStream`, and `handleDiffStream` build
     similar command payloads from run state.
   - Impact: duplicated mapping from view state → command invocation; changes require updating both.

3. **Run selection resolution (ProgressView)**
   - `getEffectiveRunId` returns explicit selections for workflow streams.
   - `resolveActiveRunId` provides fallback behavior to the latest root group when no selection is
     available.
   - Impact: two different "run selection" semantics in the same view, which risks mismatched
     behavior across components.

4. **Tool-use vs workflow stream rendering (ProgressView)**
   - `ToolUseStreamContent` and `WorkflowStreamContent` render overlapping structures
     (headers, logs, usage, follow-up), but do so in separate components with similar logic for
     permissions, run groups, and header wiring.
   - Impact: UI parity and behavior changes require edits in two code paths.

5. **Session-type state reset and file handling (MainView)**
   - `MainApp.clearForNewSession` performs tool-use-specific resets by branching on session type.
   - Multiple session-type branches in `MainApp` and `FileSelectGroup` (e.g., disabling file inputs)
     create duplicated "session-type behavior" logic split between components.
   - Impact: MainView behavior changes require coordinated edits across multiple session-specific
     branches.

## Goals

- Establish a single source of truth for agent execution and file-operation dispatch.
- Provide a unified run-selection resolver with explicit modes (strict vs fallback).
- Reduce tool-use vs workflow branching in view components by introducing shared abstractions.
- Keep logic changes internal (no user-visible behavior changes, no workspace storage format changes).

## Non-Goals

- UI redesigns or layout changes.
- Changing saved workspace state schemas.
- Large-scale renames across unrelated domains.

## Proposed Solution

### Design Principle: Prefer Helpers Over Wrappers

Per CLAUDE.md guidelines, avoid unnecessary abstraction layers. Each proposal below should result in
shared _helper functions_ rather than coordinator/dispatcher classes unless the shared logic is
substantial enough to justify a class. If a proposed abstraction would only forward calls, inline it.

### 1) Shared Execution Helpers

Extract shared validation and request-building logic into helper functions (in `@common`) that both
MainView and ProgressView call directly:

- `buildExecutionRequest(params)` — normalizes tool-use/workflow config, resume state, and execution
  ID into a unified `ExecutionRequest`.
- `validateExecutionRequest(request)` — shared validation (model availability, required fields).

Both views call these helpers then dispatch `texra.execute` themselves. This avoids a coordinator
class that would be a thin pass-through. Promote to a class only if shared pre/post-execution logic
(e.g., telemetry, error normalization) grows beyond two helpers.

**Location:** `@common` (imported by both webview and progressView extension-host code).

### 2) Shared File Operation Payload Builder

Introduce a `buildFileOperationPayload(runState, operation)` function (not a dispatcher class) that:

- Maps run state or MainView inputs into a consistent command payload.
- Covers `pack`, `clean`, `merge`, `compare`, and `diff` operations.
- Each view calls the builder, then issues the command through its own message handler.

Promote to a `FileOperationDispatcher` class only if operation-specific pre/post logic accumulates
beyond simple payload construction.

**Location:** `@common`.

### 3) Run Selection Strategy

Replace ad-hoc run selection with a single helper:

```ts
resolveRunId(state, { mode: 'strict' | 'fallback' }): string | undefined;
```

- `strict`: returns only explicitly selected run IDs (current `getEffectiveRunId` semantics).
  Returns `undefined` when no explicit selection exists.
- `fallback`: returns explicit selection if available, otherwise falls back to latest root group
  (current `resolveActiveRunId` semantics). Never returns `undefined` for non-empty state.

**Authoritative behavior:** `strict` mode is authoritative. Components that currently use
`resolveActiveRunId` are convenience consumers that should clearly opt in to fallback behavior via
the `mode` parameter. When both helpers are called in the same flow, the `strict` result takes
precedence — `fallback` is only used when no explicit selection exists and a reasonable default is
acceptable (e.g., initial page load). This means callers must consciously choose their mode; the
unified function makes the semantic difference explicit rather than hiding it behind two separate
function names.

### 4) Shared Stream Content via Data Normalization

Normalize the stream data model upstream so a single renderer can handle both tool-use and workflow
streams. This follows the repo's "fix the data model, not the renderer" principle:

- Define a `NormalizedStreamData` type that contains common fields (header info, permissions, log
  entries, usage stats, follow-up state) plus a `sections: StreamSection[]` discriminated union for
  type-specific content (tool-use instruction panel vs workflow file list).
- Create `normalizeToolUseStream(raw)` and `normalizeWorkflowStream(raw)` adapter functions that
  produce `NormalizedStreamData`.
- Build a single `StreamContent` component that renders `NormalizedStreamData`.

This is a data-adapter approach (normalize model → single renderer), not a render-props/slot pattern.
The adapters live at the data boundary; the renderer has zero type-branching.

### 5) Session-Type Defaults Map

Replace `SessionStateAdapter` with a simple defaults lookup:

```ts
const SESSION_DEFAULTS: Record<SessionType, SessionDefaults> = {
  'tool-use': { fileInputEnabled: false, ... },
  'workflow': { fileInputEnabled: true, ... },
};

function getSessionDefaults(type: SessionType): SessionDefaults {
  return SESSION_DEFAULTS[type];
}
```

`clearForNewSession` applies the defaults from this map instead of branching. No class needed —
a lookup table and a single function suffice for the current scope.

**Location:** `@common` or co-located with `MainApp` if only consumed there.

## Milestones

### Phase 1: Execution and file operations

- Extract `buildExecutionRequest`, `validateExecutionRequest`, and `buildFileOperationPayload`.
- Migrate MainView and ProgressView to use shared helpers.
- **Cleanup:** Delete old per-view validation/payload logic once migration is verified. Do not
  leave deprecated wrappers — per CLAUDE.md, delete unused code entirely.
- **Tests:** Unit tests for `buildExecutionRequest`, `validateExecutionRequest`, and
  `buildFileOperationPayload` covering both tool-use and workflow inputs.

### Phase 2: Run selection unification

- Replace `getEffectiveRunId` / `resolveActiveRunId` usage with `resolveRunId(state, { mode })`.
- **Cleanup:** Delete `getEffectiveRunId` and `resolveActiveRunId` after migration.
- **Tests:** Unit tests for strict vs fallback behavior, including edge cases (empty state,
  missing selection, stale IDs).

### Phase 3: UI component consolidation

- Implement `NormalizedStreamData` type and adapter functions.
- Build unified `StreamContent` component.
- Extract `SESSION_DEFAULTS` map and migrate `clearForNewSession`.
- **Cleanup:** Delete `ToolUseStreamContent` and `WorkflowStreamContent` after migration.
- **Tests:** Unit tests for stream normalization adapters. Snapshot or integration tests for
  `StreamContent` rendering both stream types.

## Success Metrics

- Single entry point for `texra.execute` request building and validation.
- Single entry point for file operation payload construction.
- `getEffectiveRunId` and `resolveActiveRunId` fully replaced by `resolveRunId`.
- Reduced number of session-type branches in MainView and ProgressView components.
  - **Baseline target:** measure current branch count before Phase 1; aim for ≥50% reduction by
    Phase 3 completion.

## Risks & Mitigations

- **Risk:** Consolidation could introduce regressions in view-specific behavior.
  - **Mitigation:** Phase rollout; delete old code only after parity is verified via tests.

- **Risk:** Shared abstractions add indirection without reducing complexity.
  - **Mitigation:** Start with plain functions, not classes. Promote to a class only when shared
    logic exceeds simple data transformation. Review each abstraction against CLAUDE.md's
    "Flattening Abstraction Layers" and "Discouraged Factory Patterns" guidelines.
