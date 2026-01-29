# PRD: Dual Logic Path Consolidation

## Overview

This PRD proposes consolidating five high-impact "dual logic paths" where the same behavior
is implemented in two places and can drift over time. The goal is to reduce divergence,
make behavior predictable across the extension and webviews, and lower maintenance cost.

## Goals

- Eliminate duplicated logic that can drift and cause inconsistent behavior.
- Make shared rules (sorting, file discovery, message schemas, media naming) a single source
  of truth.
- Keep refactors internal (not user-facing) and avoid changing workspace state formats.

## Non-goals

- No UI redesigns or visual changes.
- No new feature work beyond consolidation.
- No workspace storage schema migrations.

## Problem Statement: Five Gross Dual Logic Paths

1. **Stream sorting/filtering in ProgressView (backend + frontend)**
   - Backend builds `StreamTabInfo` and sorts in `buildStreamInfos`.
   - Frontend also sorts/filters the same shape for rendering.
   - Drift risk: differing comparator logic or future sort modes.

2. **Webview message schema duplication (main view)**
   - `src/webview/types/messages.ts` defines message schemas for the main view.
   - `src/shared/schemas/mainView.ts` defines overlapping message shapes and commands.
   - Two schema sources makes it easy to update one and forget the other.

3. **File discovery implemented via two different systems**
   - `FileLister` uses `getFilesRecursively` with VS Code APIs and custom filtering.
   - Housekeeping uses `findFilesFromPatterns` with globbing over workspace paths.
   - Divergent filtering/normalization rules create inconsistent results.

4. **Pasted image naming and detection split across layers**
   - Frontend generates names with a hard-coded `pasted_` prefix and MIME mapping.
   - Backend detects pasted images using `PASTED_PREFIX` and resolves paths.
   - The prefix and naming logic can drift without a shared helper.

5. **Recording flow duplicated in MainView and ProgressView**
   - Both `MainViewMessageHandler` and `ProgressViewMessageHandler` instantiate
     `RecordingManager` with similar command wiring.
   - Frontend recording state is also handled separately per view.
   - This creates two ways to define recording behavior and state transitions.

## Proposed Approach

### 1) Consolidate stream sorting/filtering

- Move comparator logic into a shared module (e.g., `src/shared/streams/streamSort.ts`).
- Export a `sortStreams(streams, sort)` function used by both backend (`streamInfoUtils.ts`)
  and frontend (`stateUtils.ts`).
- Keep filtering in one place (frontend) but reuse shared comparator map.

### 2) Unify webview message schemas

- Make `src/shared/schemas/mainView.ts` the single source of truth.
- Replace `src/webview/types/messages.ts` with imports from `@shared/schemas`.
- If local-only schemas are needed, place them under `src/shared/schemas` and re-export.

### 3) Centralize file discovery

- Introduce a `FileDiscoveryService` in `src/frontend/files` that wraps both glob-based
  and VS Code API search behind a single interface.
- Migrate housekeeping utilities to use the same ignore/normalization rules as FileLister.
- Standardize path normalization (symlink preservation, hidden file rules) in one helper.

### 4) Single pasted-image helper

- Add a `createPastedImageName(mimeType)` helper in `pastedImageUtils.ts`.
- Reuse the shared prefix and MIME extension mapping across frontend/backend.
- Keep the frontend responsible for data reading, but delegate naming to the shared helper.

### 5) Shared recording flow abstraction

- Create a `RecordingFlow` helper that wires `RecordingManager` to view commands.
- MainView and ProgressView supply only view-specific labels and command mappings.
- Consolidate UI recording state updates in shared controller utilities.

## Milestones

### Milestone 1: Audit & Shared Utilities

- Build shared utilities for stream sorting, pasted image naming, and file discovery.
- Add tests for shared utilities where feasible.

### Milestone 2: Migrate Call Sites

- Update ProgressView frontend/back-end to use shared sorting utilities.
- Replace main view webview message schemas with shared schema imports.
- Update housekeeping to use shared file discovery.

### Milestone 3: Cleanup & Validation

- Remove obsolete local utilities.
- Run lint/format/compile checks.
- Verify no behavior changes in workspace state serialization.

## Success Metrics

- No duplicate comparator or schema definitions for the same feature.
- One source of truth for pasted image naming and identification.
- Housekeeping file discovery matches FileLister outputs for the same inputs.
- Recording flows share the same command wiring and state transitions.

## Risks & Mitigations

- **Risk:** Refactors touch multiple subsystems.  
  **Mitigation:** Stage changes by milestone, with diff-friendly commits.
- **Risk:** Inconsistent behavior during migration.  
  **Mitigation:** Add tests to shared utilities and run manual smoke checks.

## Open Questions

- Should file discovery always use VS Code APIs, or is globbing required for performance
  in specific housekeeping flows?
- Is there any user-facing dependency on pasted image names beyond the prefix?
- Should recording flow UI state live in a shared controller to avoid per-view drift?
