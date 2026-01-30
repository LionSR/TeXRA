# PRD: Feature Logic Consolidation

## Verification Status

All claims verified against codebase (2026-01-30):

| Category              | Item                | Status      | Key Files                                                                    |
| --------------------- | ------------------- | ----------- | ---------------------------------------------------------------------------- |
| **View Handlers**     | Commit discovery    | ✅ Verified | `DiffManager.ts:65-112` (7 duplicate lines)                                  |
|                       | Options computation | ✅ Verified | `MainViewMessageHandler.ts:410-448`, `ProgressViewMessageHandler.ts:817-845` |
|                       | State restore       | ✅ Verified | 4 entry points calling `texra.restoreState`                                  |
|                       | Latexdiff assembly  | ⚠️ Partial  | Same handler, minor arg differences                                          |
| **Cross-Layer**       | Stream sorting      | ✅ Verified | Backend `streamInfoUtils.ts:13-22`, Frontend `stateUtils.ts:66-88`           |
|                       | Message schemas     | ✅ Verified | `webview/types/messages.ts` is dead (0 imports)                              |
|                       | Pasted image naming | ✅ Verified | `pasteHandler.ts:40` hardcodes prefix                                        |
|                       | Recording flow      | ✅ Verified | Identical instantiation in both handlers                                     |
|                       | File discovery      | ✅ Verified | FileLister vs `findFilesFromPatterns`                                        |
| **Tool-use/Workflow** | Execution triggers  | ✅ Verified | `ExecutionManager.ts:60-85`, `ProgressViewMessageHandler.ts:318-348`         |
|                       | File operations     | ✅ Verified | Duplicated mapping in both views                                             |
|                       | Run selection       | ✅ Verified | `getEffectiveRunId` vs `resolveActiveRunId`                                  |
|                       | Stream rendering    | ⚠️ Partial  | ~30-40% overlap; follow-up sections intentionally different                  |
|                       | Session-type reset  | ✅ Verified | `clearForNewSession` and `FileSelectGroup` branch on `isToolUse`             |

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

## Phase 1: Quick Wins

- [ ] Delete `webview/types/messages.ts` (0 effort)
- [ ] Fix pasted image prefix (1 line)
- [ ] Extract commit discovery helper

## Phase 2: View Handler Consolidation

- [ ] Options loader helper
- [ ] Evaluate state restore extraction
- [ ] Stream sorting shared module

## Phase 3: Execution & Operations

- [ ] `buildExecutionRequest` / `validateExecutionRequest`
- [ ] `buildFileOperationPayload`
- [ ] `resolveRunId` with mode parameter

## Phase 4: UI Components

- [ ] `NormalizedStreamData` type and adapters
- [ ] Shared `StreamContent` component
- [ ] `SESSION_DEFAULTS` map
- [ ] Recording flow helper

## Cleanup

- [ ] Delete old per-view validation/payload logic
- [ ] Delete `getEffectiveRunId` / `resolveActiveRunId`
- [ ] Verify no behavior changes

---

# Success Metrics

- Single entry point for execution request building/validation
- Single entry point for file operation payload construction
- Stream sorting comparators exist only in `src/shared/streams/`
- `webview/types/messages.ts` deleted
- `getEffectiveRunId`/`resolveActiveRunId` replaced by `resolveRunId`
- ≥50% reduction in session-type branches (measure baseline before Phase 1)

---

# Risks & Mitigations

| Risk                                  | Mitigation                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| Behavior drift during refactor        | Ship one phase at a time; verify after each                         |
| Shared helpers become too broad       | Start with functions, not classes; follow anti-abstraction guidance |
| Consolidation introduces regressions  | Delete old code only after parity verified via tests                |
| Over-abstracting follow-up components | Keep `follow-up-input` and `followup-section` separate by design    |

---

# Priority Summary

| Priority | Item                               | Effort  | Impact |
| -------- | ---------------------------------- | ------- | ------ |
| 1        | Delete `webview/types/messages.ts` | Trivial | High   |
| 2        | Fix pasted image prefix            | 1 line  | Low    |
| 3        | Commit discovery helper            | Small   | High   |
| 4        | Stream sorting consolidation       | Medium  | High   |
| 5        | Options computation helper         | Small   | Medium |
| 6        | Run selection unification          | Small   | Medium |
| 7        | Execution helpers                  | Medium  | Medium |
| 8        | Recording flow helper              | Medium  | Low    |
| 9        | File operations builder            | Medium  | Medium |
| 10       | Stream rendering normalization     | Large   | Medium |
| 11       | Session defaults map               | Small   | Low    |
| 12       | State restore (evaluate)           | Small   | Low    |
| 13       | File discovery (evaluate)          | Medium  | Low    |
| 14       | Latexdiff (defer)                  | Small   | Low    |
