# PRD: Dual Logic Path Consolidation

## Overview

Reduce high-impact duplicated logic paths by consolidating tool-use vs workflow handling into shared
utilities and controllers. The focus is to lower change amplification across the MainView,
ProgressView, and run-selection flows without altering user-facing behaviors.

## Problem Statement

The codebase contains multiple “dual logic paths” where the same feature is implemented separately
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
   - Impact: two different “run selection” semantics in the same view, which risks mismatched
     behavior across components.

4. **Tool-use vs workflow stream rendering (ProgressView)**
   - `ToolUseStreamContent` and `WorkflowStreamContent` render overlapping structures
     (headers, logs, usage, follow-up), but do so in separate components with similar logic for
     permissions, run groups, and header wiring.
   - Impact: UI parity and behavior changes require edits in two code paths.

5. **Session-type state reset and file handling (MainView)**
   - `MainApp.clearForNewSession` performs tool-use-specific resets by branching on session type.
   - Multiple session-type branches in `MainApp` and `FileSelectGroup` (e.g., disabling file inputs)
     create duplicated “session-type behavior” logic split between components.
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

### 1) Execution Orchestrator

Create a shared execution controller (e.g., `ExecutionCoordinator`) that:

- Accepts a unified `ExecutionRequest` from both MainView and ProgressView.
- Owns validation, tool-use/workflow branching, and resume behavior.
- Exposes a single `execute(request)` API so both views share the same logic.

### 2) File Operation Router

Introduce a shared command router (e.g., `FileOperationDispatcher`) that:

- Receives view-agnostic file operation requests.
- Builds a consistent command payload from run state or MainView inputs.
- Provides helpers for `pack`, `clean`, `merge`, `compare`, and `diff`.

### 3) Run Selection Strategy

Replace ad-hoc run selection with a single helper:

```ts
resolveRunId(state, { mode: 'strict' | 'fallback' });
```

- `strict`: current `getEffectiveRunId` semantics.
- `fallback`: current `resolveActiveRunId` semantics.

### 4) Shared Stream Content Shell

Factor a shared `StreamContentShell` component (or mixin) that:

- Owns common layout (header, permissions, log list, usage panel, follow-up shell).
- Accepts a typed adapter for tool-use/workflow-specific sections (instruction panel, file list).

### 5) MainView Session State Adapter

Create a `SessionStateAdapter` that:

- Centralizes session-type resets and field defaults.
- Provides a clear API for `resetForSessionType(sessionType)`.
- Exposes a derived view model for file-selection enablement.

## Milestones

1. **Phase 1: Execution and file operations**
   - Implement `ExecutionCoordinator` and `FileOperationDispatcher`.
   - Migrate MainView and ProgressView to use shared APIs.

2. **Phase 2: Run selection unification**
   - Replace `getEffectiveRunId` / `resolveActiveRunId` usage with shared helper.
   - Add targeted unit tests for strict vs fallback behavior.

3. **Phase 3: UI component consolidation**
   - Build `StreamContentShell` + adapters.
   - Extract `SessionStateAdapter` and migrate MainView.

## Success Metrics

- Single entry point for `texra.execute` orchestration.
- Single entry point for file operation dispatch.
- Eliminate duplicate run selection helpers.
- Reduced number of session-type branches in MainView and ProgressView components.

## Risks & Mitigations

- **Risk:** Consolidation could introduce regressions in view-specific behavior.
  - **Mitigation:** Phase rollout, keep existing APIs until parity verified.

- **Risk:** Shared abstractions add indirection without reducing complexity.
  - **Mitigation:** Only extract logic that appears in multiple locations and removes duplication.

## Open Questions

- Which existing run-selection behaviors should be considered authoritative when modes conflict?
- Should `ExecutionCoordinator` live under `@frontend` or `@common`, given both view origins?
- Can ProgressView stream rendering share a shell without affecting performance?
