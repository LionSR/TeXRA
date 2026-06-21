---
created: 2026-01-30
updated: 2026-02-10
---

# PRD: Feature Logic Consolidation

## Implementation Status

Consolidation complete (2026-01-30):

| Category              | Item                | Status         | Implementation                                                             |
| --------------------- | ------------------- | -------------- | -------------------------------------------------------------------------- |
| **View Handlers**     | Commit discovery    | ✅ Implemented | `@frontend/git/recentCommits.ts` - shared `fetchRecentCommits` function    |
|                       | Options computation | ✅ Implemented | `@frontend/agents/optionsLoader.ts` - shared `loadOptions` function        |
|                       | State restore       | ⏸️ Deferred    | Architectural, not direct duplication - different TaskState builders       |
|                       | Latexdiff assembly  | ⏸️ Deferred    | Minor arg divergence, low maintenance burden                               |
| **Cross-Layer**       | Stream sorting      | ✅ Implemented | `@shared/streams/streamSort.ts` with `StreamSortSchema` (Zod)              |
|                       | Message schemas     | ✅ Implemented | Deleted `webview/types/messages.ts`, types derive from shared schemas      |
|                       | Pasted image naming | ✅ Implemented | `@shared/files/pastedImageConstants.ts` - shared `PASTED_PREFIX`           |
|                       | Recording flow      | ⏸️ Deferred    | Low impact, per-view instantiation acceptable                              |
|                       | File discovery      | ⏸️ Deferred    | Intentionally different (interactive UI vs batch)                          |
| **Tool-use/Workflow** | Execution triggers  | ✅ Implemented | `validateExecutionRequest` + `executeValidated` helper in ProgressView     |
|                       | File operations     | ✅ Implemented | Logic inlined, removed unnecessary `buildFileOperationPayload` abstraction |
|                       | Run selection       | ✅ Implemented | `@shared/streams/runSelection.ts` - `resolveRunId` with mode param         |
|                       | Stream rendering    | ⏸️ Deferred    | ~30-40% overlap but follow-up sections intentionally different             |
|                       | Session-type reset  | ✅ Implemented | `SESSION_DEFAULTS` config map in `sessionDefaults.ts`                      |

## Overview

Consolidate feature-level duplicated logic across three dimensions:

1. **View handlers** - Same logic in MainView, ProgressView, HistoryView
2. **Cross-layer** - Same logic in backend and frontend
3. **Tool-use vs Workflow** - Parallel implementations for session types

Goals: reduce drift, simplify maintenance, make future changes safer.

## Non-Goals

- UI redesigns or layout changes
- Changing workspace state schemas
- Consolidating intentionally distinct follow-up components

---

# Part A: View Handler Consolidation

## A1. Commit Discovery (DiffManager)

**Priority:** Highest - Quick win (7 exact duplicate lines)

**Current State:**

- `handleRequestRecentCommits`: lines 65-97
- `handleRefreshCommits`: lines 99-112
- Both execute: `texra.isGitRepository` → `texra.getRecentCommits` → post `SET_RECENT_COMMITS`

**Refactor:**
Extract into `@frontend/git/recentCommits.ts`:

```ts
fetchRecentCommits(options?: { notifyWhenEmpty?: boolean }): Promise<{ commits: string[], isGitRepo: boolean }>
```

Replace both handlers with the shared function.

---

## A2. Options Computation

**Priority:** Medium

**Current State:**

- MainView `handleWebviewReady()`: lines 410-448
- ProgressView `handleGetFollowupOptions()`: lines 817-845
- Both use identical `Promise.all([computeAgentOptionsData(), computeModelOptionsData()])`
- Both have identical error handling (log only, no fallbacks)

**Refactor:**
Create `@frontend/agents/optionsLoader.ts`:

```ts
loadOptions(): Promise<{ agents: AgentOptionsData, models: ModelOptionsData }>
```

Consistent error handling, default merge model lookup.

---

## A3. State Restore

**Priority:** Medium - Evaluate if worth extracting

**Current State:** 4 entry points calling `texra.restoreState`:

- HistoryView: `handleRestoreAgent()` at lines 114-125
- ProgressView Pattern A: `handleRestoreState()` at lines 427-434
- ProgressView Pattern B: `handleAgentProposalSetup()` at lines 522-588
- ProgressView Pattern C: `processFollowup()` at lines 944-1034

**Recommendation:**
Architectural duplication, not direct code duplication. Each builds TaskState differently.
May not warrant extraction per anti-abstraction guidance. Evaluate after other consolidations.

---

## A4. Latexdiff Assembly

**Priority:** Low - Consider deferring

**Current State:**

- DiffManager: passes `(inputFile, baseFile, editedFile)`
- ProgressView: passes `(undefined, baseFile, editedFile)`
- Same underlying handler uses `baseFile ?? inputFile` fallback

**Recommendation:**
Minor argument divergence. Underlying command handles both patterns. Low maintenance burden.

---

# Part B: Cross-Layer Consolidation

## B1. Stream Sorting (Double Execution)

**Priority:** High - Performance impact

**Current State:**

- Backend: `streamInfoUtils.ts:13-22` defines `sortComparators`
- Frontend: `stateUtils.ts:66-88` defines `streamComparators`
- **Identical logic** for `time`, `agent`, `inputFile`
- Backend sorts → sends to frontend → frontend sorts again

**Refactor:**
Create `src/shared/streams/streamSort.ts`:

```ts
export const streamComparators: Record<StreamSort, Comparator<StreamTabInfo>>;
export function sortStreams(
  streams: StreamTabInfo[],
  sort: StreamSort,
): StreamTabInfo[];
```

Use in both backend and frontend. Remove double sorting.

**Acceptance Criteria:**

- Stream sorting comparators exist only in `src/shared/streams/`
- No double sorting occurs

---

## B2. Message Schemas (Dead Code)

**Priority:** High - Immediate cleanup

**Current State:**

- `src/webview/types/messages.ts` (344 lines) has **zero imports** in codebase
- `src/shared/schemas/mainView.ts` (889 lines) is the active, canonical location

**Refactor:**
Delete `src/webview/types/messages.ts` entirely.

**Acceptance Criteria:**

- File deleted
- `npm run compile:fast` passes

---

## B3. Pasted Image Naming

**Priority:** Low - Single line fix

**Current State:**

- `PASTED_PREFIX` constant: `pastedImageUtils.ts:7`
- `isPastedImage()` detection: uses constant correctly
- **Hardcoded:** `pasteHandler.ts:40`: `` `pasted_${timestamp}_${random}.${extension}` ``

**Refactor:**
Replace hardcoded `pasted_` with `PASTED_PREFIX` import. Optionally add:

```ts
createPastedImageName(extension: string): string
```

**Acceptance Criteria:**

- `grep -r "pasted_"` in code (not comments) returns only `PASTED_PREFIX` definition

---

## B4. Recording Flow

**Priority:** Medium

**Current State:**

- MainView constructor: lines 32-40, creates `RecordingManager` with MAIN_VIEW_COMMANDS
- ProgressView constructor: lines 85-97, creates `RecordingManager` with PROGRESS_VIEW_COMMANDS
- 10-15 lines of similar wiring

**Refactor:**
Create helper function (not a class):

```ts
wireRecordingFlow(context: ExtensionContext, commands: RecordingCommandMap): RecordingManager
```

**Acceptance Criteria:**

- No duplicate `RecordingManager` instantiation patterns

---

## B5. File Discovery

**Priority:** Medium - May not warrant full consolidation

**Current State:**

- `FileLister` (`src/frontend/files/fileLister.ts:24-184`): VS Code workspace API, 8 config keys
- `findFilesFromPatterns` (`src/housekeeping/utils.ts:58-97`): `glob.sync()`, hardcoded excludes

**Recommendation:**
Intentionally different use cases (interactive UI vs batch operations). Consider:

- Extract shared ignore/normalization rules as helpers
- Keep separate discovery mechanisms
- Use VS Code `workspace.findFiles` as primary only if no performance regression

---

# Part C: Tool-Use vs Workflow Consolidation

## C1. Execution Triggers

**Current State:**

- `ExecutionManager.handleExecute`: validates, dispatches with UI-specific handling
- `ProgressViewMessageHandler.handleRunNew/handleResume`: re-dispatches with separate resume logic

**Refactor:**
Extract shared helpers (not a coordinator class):

```ts
buildExecutionRequest(params): ExecutionRequest
validateExecutionRequest(request): ValidationResult
```

Both views call helpers then dispatch `texra.execute` themselves.

**Location:** `@common`

---

## C2. File Operation Dispatch

**Current State:**

- `ExecutionManager.handleFileOperation/handleMultipleOperation`: MainView command messages
- `ProgressViewMessageHandler.handlePackStream/handleCleanStream/handleDiffStream`: run state

**Refactor:**

```ts
buildFileOperationPayload(runState | mainViewInput, operation): CommandPayload
```

Each view calls builder, issues command through its own handler.

---

## C3. Run Selection Resolution

**Current State:**

- `getEffectiveRunId`: returns explicit selections (strict)
- `resolveActiveRunId`: falls back to latest root group

**Refactor:**
Single helper with explicit mode:

```ts
resolveRunId(state, { mode: 'strict' | 'fallback' }): string | undefined
```

- `strict`: only explicit selection (current `getEffectiveRunId`)
- `fallback`: explicit or latest root (current `resolveActiveRunId`)

Delete both old functions after migration.

---

## C4. Stream Rendering

**Current State:**

- `ToolUseStreamContent` and `WorkflowStreamContent` have ~30-40% overlap
- Headers, logs, usage, permissions are similar
- Follow-up sections are intentionally different (`<follow-up-input>` vs `<followup-section>`)

**Refactor:**
Normalize upstream data model:

```ts
type NormalizedStreamData = {
  header: HeaderInfo;
  permissions: PermissionInfo;
  logs: LogEntry[];
  usage: UsageStats;
  sections: StreamSection[]; // discriminated union for type-specific content
};
```

Build single `StreamContent` component for shared sections. Keep follow-up components separate.

---

## C5. Session-Type State Reset

**Current State:**

- `MainApp.clearForNewSession` branches on session type
- `FileSelectGroup` has `isToolUse` branching

**Refactor:**
Simple defaults lookup:

```ts
const SESSION_DEFAULTS: Record<SessionType, SessionDefaults> = {
  'tool-use': { fileInputEnabled: false, ... },
  'workflow': { fileInputEnabled: true, ... },
};
```

`clearForNewSession` applies defaults from map instead of branching.

---

# Milestones

## Phase 1: Quick Wins ✅ COMPLETE

- [x] Delete `webview/types/messages.ts` (0 effort)
- [x] Fix pasted image prefix - moved to `@shared/files/pastedImageConstants.ts`
- [x] Extract commit discovery helper - `@frontend/git/recentCommits.ts`

## Phase 2: View Handler Consolidation ✅ COMPLETE

- [x] Options loader helper - `@frontend/agents/optionsLoader.ts`
- [x] Stream sorting shared module - `@shared/streams/streamSort.ts` with `StreamSortSchema`
- [ ] Evaluate state restore extraction (deferred - architectural, not direct duplication)

## Phase 3: Execution & Operations ✅ COMPLETE

- [x] `validateExecutionRequest` - `@common/execution/executionRequests.ts`
- [x] `resolveRunId` with mode parameter - `@shared/streams/runSelection.ts`
- [x] Removed `buildFileOperationPayload` - logic inlined, abstraction removed per guidelines

## Phase 4: UI Components ✅ COMPLETE

- [x] `SESSION_DEFAULTS` map - `src/webview/frontend/sessionDefaults.ts`
- [ ] `NormalizedStreamData` type and adapters (deferred)
- [ ] Shared `StreamContent` component (deferred)
- [ ] Recording flow helper (deferred - low impact)

## Cleanup

- [x] Delete old per-view validation logic - replaced with `executeValidated` helper
- [x] Delete `getEffectiveRunId` / `resolveActiveRunId` - replaced by `resolveRunId`
- [x] Delete `fileOperationPayload.ts` - unnecessary abstraction removed
- [x] Fixed type safety: `StreamSort` schema added, removed `as StreamSort` casts
- [x] Fixed race condition in `AgentDirectoryManager.ensureAgentWatchers` - promise set before `getAllLocal()`
- [x] Fixed config watcher disposal bug in `AgentDirectoryManager`
- [x] Added `model` field to `POLISH_INSTRUCTION_TEXT` schema (was missing, caused validation failures)
- [x] Added `MultiFileCategory` type for type-safe multi-file command maps
- [x] Removed unnecessary `PASTED_PREFIX` re-export from `pastedImageUtils.ts`
- [x] Fix Windows path separators in `AgentDirectoryManager` minimatch calls - normalize to forward slashes
- [x] Add `satisfies` to `SESSION_DEFAULTS` per project conventions

---

# Success Metrics ✅ Achieved

- ✅ Single entry point for execution request validation: `validateExecutionRequest`
- ✅ File operation payload abstraction removed (per anti-abstraction guidelines)
- ✅ Stream sorting comparators exist only in `src/shared/streams/streamSort.ts`
- ✅ `webview/types/messages.ts` deleted
- ✅ `getEffectiveRunId`/`resolveActiveRunId` replaced by `resolveRunId`
- ✅ Session-type branches replaced with `SESSION_DEFAULTS` config map
- ✅ `StreamSortSchema` added for type safety (no more `as StreamSort` casts)

---

# Code Review Findings (2026-01-30)

Issues reported during code review and their verification status:

## Verified as NOT Bugs

| Issue                                         | Location                           | Verdict             | Explanation                                                                                                                       |
| --------------------------------------------- | ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ExecutionManager argument shape change        | `ExecutionManager.ts`              | ✅ Not a bug        | `texra.execute` explicitly supports both raw config and wrapped `{ config, executionId? }` format (see `executeCommand.ts:37-45`) |
| handleInputFileSelected clears wrong category | `FileManager.ts:130-142`           | ✅ Intentional      | Function updates Edited files when Input file changes; clearing Edited when Input is empty is correct (no base to filter by)      |
| Race condition in ensureAgentWatchers         | `AgentDirectoryManager.ts:299-301` | ✅ Theoretical only | Both operations execute synchronously in same microtask; promise callbacks queue for next microtask after null assignment         |
| minimatch dependency                          | `package.json`                     | ✅ Already exists   | `"minimatch": "^10.1.1"` is already a production dependency                                                                       |

## Valid Suggestions (Style/Cleanup)

| Issue                                   | Location                   | Status       | Notes                                                                                              |
| --------------------------------------- | -------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| SESSION_DEFAULTS should use `satisfies` | `sessionDefaults.ts:12`    | ✅ Fixed     | Changed to use `satisfies` pattern                                                                 |
| Consolidate file selection Maps         | `fileSelectionRegistry.ts` | 📝 Backlog   | Three Maps could get out of sync; single declarative structure preferred                           |
| `?? undefined` coercion                 | `DiffManager.ts:77`        | ✅ Not a bug | Schema uses `.nullish()` (returns `null`); coercion converts to `undefined` for function signature |

## Real Bugs Found

| Issue                                  | Location                       | Status   | Fix                                                                                       |
| -------------------------------------- | ------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| Windows path separators with minimatch | `AgentDirectoryManager.ts:230` | ✅ Fixed | Added `normalizePath()` helper to convert backslashes to forward slashes before minimatch |

---

# Risks & Mitigations

| Risk                                  | Mitigation                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| Behavior drift during refactor        | Ship one phase at a time; verify after each                         |
| Shared helpers become too broad       | Start with functions, not classes; follow anti-abstraction guidance |
| Consolidation introduces regressions  | Delete old code only after parity verified via tests                |
| Over-abstracting follow-up components | Keep `follow-up-input` and `followup-section` separate by design    |
| Cross-platform path handling          | Normalize paths to forward slashes before glob matching             |

---

# Priority Summary

| Priority | Item                               | Status      | Notes                                           |
| -------- | ---------------------------------- | ----------- | ----------------------------------------------- |
| 1        | Delete `webview/types/messages.ts` | ✅ Done     | Types now derived from shared schemas           |
| 2        | Fix pasted image prefix            | ✅ Done     | `@shared/files/pastedImageConstants.ts`         |
| 3        | Commit discovery helper            | ✅ Done     | `@frontend/git/recentCommits.ts`                |
| 4        | Stream sorting consolidation       | ✅ Done     | `@shared/streams/streamSort.ts` with Zod schema |
| 5        | Options computation helper         | ✅ Done     | `@frontend/agents/optionsLoader.ts`             |
| 6        | Run selection unification          | ✅ Done     | `@shared/streams/runSelection.ts`               |
| 7        | Execution helpers                  | ✅ Done     | `validateExecutionRequest` + `executeValidated` |
| 8        | Recording flow helper              | ⏸️ Deferred | Low impact                                      |
| 9        | File operations builder            | ✅ Removed  | Unnecessary abstraction per guidelines          |
| 10       | Stream rendering normalization     | ⏸️ Deferred | Follow-up sections intentionally different      |
| 11       | Session defaults map               | ✅ Done     | `sessionDefaults.ts`                            |
| 12       | State restore (evaluate)           | ⏸️ Deferred | Architectural, not direct duplication           |
| 13       | File discovery (evaluate)          | ⏸️ Deferred | Intentionally different use cases               |
| 14       | Latexdiff (defer)                  | ⏸️ Deferred | Minor arg divergence, low maintenance           |
