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
   - `FileLister` (in `src/frontend/files/fileLister.ts`) uses `getFilesRecursively` with
     VS Code APIs and custom filtering.
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

- `src/shared/schemas/mainView.ts` already exists and partially defines message schemas.
  The consolidation work is to make it the **complete** single source of truth by migrating
  all message type definitions currently in `src/webview/types/messages.ts` into the shared
  schema file, then removing the webview-local copy.
- All unified schemas must be **Zod-based**, consistent with the project convention that Zod
  schemas are the single source of truth for data structures (see CLAUDE.md). TypeScript types
  should be derived via `z.infer<>` rather than manually defined.
- Replace `src/webview/types/messages.ts` with re-exports from `@shared/schemas`.
- If local-only schemas are needed, place them under `src/shared/schemas` and re-export.

### 3) Centralize file discovery

- `src/frontend/files/` already contains `fileLister.ts`, `listing.ts`, and `index.ts`.
  Rather than introducing a new wrapper class, the consolidation should **extend the existing
  `FileLister`** to also serve the housekeeping use case. This avoids adding an unnecessary
  abstraction layer (per CLAUDE.md guidance against trivial wrappers).
- Concretely: extract the ignore/normalization rules from `FileLister` into shared helpers
  that housekeeping utilities can also call, then migrate housekeeping call sites to use
  those shared helpers directly.
- Standardize path normalization (symlink preservation, hidden file rules) in one helper.
- **Design decision (resolved):** Use VS Code `workspace.findFiles` as the primary API for
  both interactive and housekeeping flows. Fall back to direct globbing only if profiling
  shows a measurable performance regression in housekeeping batch operations. This avoids
  maintaining two discovery mechanisms.

### 4) Single pasted-image helper

- Add a `createPastedImageName(mimeType)` helper to the **existing**
  `src/utils/files/pastedImageUtils.ts` file (not a new file). This follows the CLAUDE.md
  convention of editing existing files rather than creating new ones.
- Reuse the shared prefix and MIME extension mapping across frontend/backend.
- Keep the frontend responsible for data reading, but delegate naming to the shared helper.

### 5) Shared recording flow helper

- Both views currently contain ~10-15 lines of similar `RecordingManager` wiring and command
  registration. This is enough duplication to justify a small shared helper, but the helper
  should remain a plain function (not a class or service) to avoid unnecessary abstraction
  per CLAUDE.md guidelines.
- Create a `wireRecordingFlow(context, manager, commandMap)` function that handles the
  common wiring. MainView and ProgressView supply only view-specific labels and command
  mappings.
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

### Measurable Acceptance Criteria

- `grep -r "PASTED_PREFIX"` returns hits in exactly one file (the shared helper).
- Stream sorting comparators exist only in `src/shared/streams/`.
- `src/webview/types/messages.ts` contains only re-exports from `@shared/schemas`, no
  standalone type definitions.
- No duplicate `RecordingManager` instantiation patterns across view message handlers.

## Risks & Mitigations

- **Risk:** Refactors touch multiple subsystems.
  **Mitigation:** Stage changes by milestone, with diff-friendly commits.
- **Risk:** Inconsistent behavior during migration.
  **Mitigation:** Add tests to shared utilities and run manual smoke checks.

## Open Questions

- Is there any user-facing dependency on pasted image names beyond the prefix?
- Should recording flow UI state live in a shared controller to avoid per-view drift?
