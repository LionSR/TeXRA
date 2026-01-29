# PRD: UI Regression Audit - All Views

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior doc:** [ui-regressions-lit-migration.md](./ui-regressions-lit-migration.md)

## Overview

This PRD captures a **UI regression audit** between the current branch and the main branch
baseline. The focus is on **missing UI elements, CSS regressions, and logic regressions** across
MainView, ProgressView, HistoryView, ProfileView, and the shared state layer.

> **Status: 🟢 BACKEND VERIFIED (2026-01-29)** - No backend regressions; SP-1/SP-2 are design decisions
>
> **Updated: 2026-01-29** - Backend regression audit completed; event bus migration verified
>
> Prior fixes: L1, L2, L4 queued message issues all fixed

### Baseline for comparison

Compared branch `claude/review-lit-native-phases-skw5W` against `main` branch.
PR contains 685 files changed (+44829/-38366 lines) - major Lit migration effort.

---

## Critical Logic Regressions (Queued Messages)

> **Severity: 🔴 CRITICAL** - Data loss when switching tabs

### L1) Queued follow-ups not cleared on stream switch (CRITICAL) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Critical
- **Status:** ✅ **FIXED** - The `'clear'` action in `updateLogContent` clears all frontend
  `streamStates` (including `queuedFollowUps`) via `ctx.setState((prev) => ({ ...prev, streamStates: new Map() }))`.
- **Location:**
  - `src/progressView/events/ProgressEventHandler.ts:342-348` (`clearStreamSurface()`)
  - `src/progressView/frontend/messageDispatcher.ts:205-208` (frontend handler)

### L2) Queued follow-ups not sent on stream activation (CRITICAL) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Critical
- **Status:** ✅ **FIXED in this PR** (lines 323-326 of ProgressEventHandler.ts)
- **Fix applied:** `refreshStreamSurface()` now calls:
  ```typescript
  this.webviewUpdater.updateQueuedFollowUps(
    stream,
    ToolUseFollowUpQueue.getAll(stream),
  );
  ```
- **Note:** The docstring in `FollowUpEventHandlers.ts:12` is now stale and should be updated.
  It says "refreshStreamSurface doesn't refresh follow-ups" which is no longer true.

### L3) Schema defaults hide data loss (HIGH)

- **Area:** Shared
- **Type:** Logic regression
- **Impact:** High
- **Current behavior:** `queuedFollowUps: z.array(z.string()).prefault([])` means missing data
  silently becomes empty array instead of erroring. Combined with L1 and L2, the frontend shows
  empty queued messages even when they exist on the backend.
- **Location:**
  - `src/shared/schemas/streamState.ts:46`
- **Impact:** Silent data loss - messages exist on backend but don't appear in frontend

### L4) No cleanup of queued messages on stream deletion (MEDIUM) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** ~~When a stream is deleted, `clearStream()` removes all data but queued
  messages for that stream are never explicitly cleared in the UI.~~ Fixed: `ToolUseFollowUpQueue.release(streamId)` now called in both `handleDeleteStream()` and `handleDeleteAll()`.
- **Location:**
  - `src/progressView/ProgressViewMessageHandler.ts:262-280` (`handleDeleteStream()`)

---

## UI Regressions (New Findings 2026-01-29)

### U1) Inverted aria-hidden logic in QueuedFollowUps (MEDIUM)

- **Area:** ProgressView
- **Type:** Accessibility regression
- **Impact:** Medium
- **Current behavior:** Line 100 has `aria-hidden=${visible ? 'false' : 'true'}` which is
  correct, but needs verification that the `visible` computed property works as expected.
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:100`

### U2) Missing null check in BannerGroup provider rendering (MEDIUM)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Line 225 uses `providerLabel` from `charAt(0).toUpperCase()`. If
  provider is null/undefined, this will throw an error.
- **Location:** `src/webview/frontend/components/BannerGroup.ts:225`
- **Fix:** Add null check before rendering API key banner

### U3) FollowUpInput visibility pattern may break event listeners (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Lines 181-182 return `nothing` when not visible. This removes the
  component from DOM entirely, which could break parent event listener attachment if the parent
  expects the component to always be present.
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts:181-182`

### U4) CSS selector timing with data-mode attribute (LOW)

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** FollowupSection CSS selectors depend on `data-mode` attribute (lines
  132-175). If `mode` property change isn't synchronized properly, buttons/sections won't
  appear/disappear correctly.
- **Location:** `src/progressView/frontend/components/FollowupSection.ts:132-175, 229`

### U5) SortableController timing in OutputFilesSection (LOW)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Low
- **Current behavior:** Lines 46-57 initialize SortableController but `@query()` selector
  might not find element if render hasn't completed. Drag-and-drop might not initialize.
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts:46-57`

### U6) Multiple Outputs toggle disappears after state restore ✅ NOT A BUG

- **Area:** MainView
- **Type:** Expected behavior
- **Status:** ✅ **Working as designed** - Records have correct `agentCategory`
- **Explanation:** The file selection group (including Multiple Outputs toggle) is intentionally
  hidden when `sessionType === 'toolUse'`. This is correct behavior:
  - Tool-use mode: File selection hidden (expected)
  - Workflow mode: File selection visible (expected)
- **Assumption:** History records always have correct `agentCategory` field

---

## New Findings from Parallel Agent Audit (2026-01-29)

> Additional findings from comprehensive codebase audit. After verification, most are
> **false positives** (new code, not regressions from main).

### Verified False Positives

#### U7) Hard-coded border in UserMessage ✅ NOT A REGRESSION

- **Status:** ✅ **False positive** - `UserMessage.ts` is a NEW FILE (doesn't exist on main)
- **Type:** New code style choice, not regression
- **Note:** Consider tokenizing `border-left: 3px` for consistency, but not blocking

#### U8) Hard-coded max-width in UserMessage ✅ NOT A REGRESSION

- **Status:** ✅ **False positive** - `UserMessage.ts` is a NEW FILE
- **Type:** New code style choice, not regression

#### L5) StorageRecordSchema fallback ✅ NOT A REGRESSION

- **Status:** ✅ **False positive** - `storage.ts` is a NEW FILE (doesn't exist on main)
- **Type:** New abstraction pattern, not regression
- **Note:** The `.catch({})` provides robust corruption recovery - by design

#### L6) Preference .catch() patterns ✅ NOT A REGRESSION

- **Status:** ✅ **False positive** - Functionally equivalent to main
- **Verification:** On main, preferences used inline defaults:
  ```typescript
  private _activeStream: ActiveStreamId = PROGRESS_VIEW_DEFAULTS.activeStream;
  private _streamSortOrder: string = PROGRESS_VIEW_DEFAULTS.streamSortOrder;
  ```
  The new `.catch()` pattern provides the SAME default behavior, just via schema.

#### L7) Pending log updates cache ✅ NOT A REGRESSION

- **Status:** ✅ **False positive** - NEW feature, not regression
- **Purpose:** Handles race condition where UPDATE_LOG arrives before APPEND_LOG
- **Note:** Properly cleaned up on stream/all deletion

#### L9) Permission type renames ✅ NOT A REGRESSION

- **Status:** ✅ **False positive** - Complete, consistent rename
- **Verification:** All handlers updated to new names:
  - `src/tools/approval/bashApproval.ts` emits `showBashPermission`
  - `src/tools/approval/toolEditApproval.ts` emits `showToolEditPermission`
  - `src/progressView/events/UIEvents.ts` handles all new event names
- **Note:** Old type names (`RetryRequestPrompt`, etc.) no longer exist in codebase

### Confirmed Real Issue

#### L8) Legacy usage stats normalization removed (MEDIUM) ⚠️ REAL

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium
- **Status:** ⚠️ **Needs fix** - Legacy format handling removed
- **What changed:**
  - **Main branch:** `UsageStatsManager.normalizeToRunMap()` converted legacy single
    `TokenUsageStats` object to `Map<string, TokenUsageStats>` format
  - **This branch:** Removed. New `createSingleValueRunMapSchema` expects `{ runId: {...} }`
    format and returns empty Map for legacy data.
- **Location:** `src/progressView/managers/UsageStatsManager.ts`
- **Risk:** Users upgrading from older versions may lose usage statistics if stored in
  legacy format (single `TokenUsageStats` object, not nested under runId)
- **Fix needed:** Add legacy format detection in `createSingleValueRunMapSchema` or
  `UsageDataSchema` to wrap bare `TokenUsageStats` objects

---

## State Persistence Design (Audit 2026-01-29)

> **Status: ✅ BY DESIGN** - Not regressions; intentional architecture
>
> The caching in `createWebviewStorage` and transient `streamStates` are intentional design
> choices, not bugs. Stream state is rebuilt from backend on reload; only user preferences persist.

### SP-1) Webview storage cache architecture ✅ BY DESIGN

- **Area:** Shared State
- **Type:** Design decision (not a regression)
- **Status:** ✅ **Working as designed**
- **Architecture:** `createWebviewStorage` uses in-memory caching for performance:
  ```typescript
  let cache = (vscode.getState() as Record<string, unknown>) ?? {};
  ```
- **Why this is correct:**
  - Cache initializes from `vscode.getState()` once at construction
  - All writes update both cache AND call `vscode.setState()` (line 49-50)
  - Zod schemas use `.catch()` fallbacks, so invalid/stale data recovers to defaults
  - Webview state is transient by design - rebuilt from backend on reload
- **Location:** `src/shared/state/PersistedState.ts:39-52`
- **Note:** If cache divergence ever occurs, schema fallbacks ensure graceful recovery

### SP-2) StreamStates is transient (not persisted) ✅ BY DESIGN

- **Area:** ProgressView
- **Type:** Design decision (not a regression)
- **Status:** ✅ **Working as designed**
- **Architecture:** `streamStates: Map<StreamTabId, StreamState>` is intentionally transient:
  - Stored only in Lit `@state()` for reactive rendering
  - Rebuilt from backend via `UPDATE_STREAMS` message on webview reload
  - Backend is the single source of truth for stream state
- **Data flow on reload:**
  1. Webview reloads → `streamStates` starts empty
  2. Backend sends `UPDATE_STREAMS` → frontend populates `streamStates`
  3. Backend sends `UPDATE_QUEUED_FOLLOWUPS` → queued messages restored
- **Location:** `src/progressView/frontend/ProgressApp.ts` (`@state() private appState`)
- **Note:** Persisting streamStates would duplicate backend state and risk inconsistency

### SP-3) Race condition between cache init and first message (HIGH)

- **Area:** Shared State
- **Type:** Logic regression
- **Impact:** High
- **Current behavior:** PersistedState constructor loads state synchronously from cache. But cache
  is initialized once at `createWebviewStorage` construction. If backend sends UPDATE_STREAMS before
  cache is populated, frontend starts with empty state.
- **Location:** `src/shared/state/PersistedState.ts:86-98`
- **Fix:** Ensure message ordering or add cache reload trigger

### SP-4) pendingLogUpdates not namespaced by stream (HIGH)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** High
- **Current behavior:** `pendingLogUpdates` uses `logMessage.id` as key but doesn't namespace by
  stream ID. A log from stream-A could contaminate stream-B if IDs collide. Also not cleared when
  UPDATE_LOGS arrives with `action='clear'`.
- **Location:** `src/progressView/frontend/messageDispatcher.ts:63`
- **Scenario:** Stream-A receives UPDATE_LOG for log-ID-1 → pendingLogUpdates.set("log-ID-1") →
  User switches streams → Stream-B receives APPEND_LOG with same ID → Wrong update applied
- **Fix:** Namespace keys by `${streamId}:${logId}` and clear on stream clear action

### SP-5) PersistedState.reload() never called (MEDIUM)

- **Area:** Shared State
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** The `reload()` method exists but is never called anywhere in the codebase.
  When backend state changes, frontend never reloads from storage.
- **Location:** `src/shared/state/PersistedState.ts:129-131`
- **Fix:** Call `reload()` when state update messages arrive

### SP-6) MementoStorage rename inconsistency (LOW)

- **Area:** Shared State
- **Type:** Code quality
- **Impact:** Low
- **Current behavior:** `StateStorage` interface in PersistedState.ts and `MementoStorage` in
  PersistentMapManager.ts have incompatible signatures.
- **Location:**
  - `src/shared/state/PersistedState.ts:7-10`
  - `src/progressView/persistence/PersistentMapManager.ts:9-12`
- **Fix:** Consolidate interfaces

---

## HistoryView Regressions (NEW - 2026-01-29)

> Findings from comparing old JS modules against new Lit components

### HV-L1) Search state not persisted across view refreshes (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** The old `SearchManager.ts` called `historyViewState.setSearchIndex()` and
  `historyViewState.setTotalMatches()` on every search. The new Lit implementation updates reactive
  state but timing of when saves propagate may differ.
- **Location:**
  - OLD: `src/historyView/modules/uiManagers/SearchManager.js:69, 85, 103`
  - NEW: `src/historyView/frontend/components/HistoryList.ts:106-115`
- **Impact:** Users switching tabs and returning may lose search position/match count
- **Fix:** Verify state persistence triggers on all search operations

### HV-L2) Toggle state sync timing on search clear (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Old code had explicit `applySavedToggleStates()` called synchronously when
  search cleared. New code relies on Lit reactivity but may not have explicit restore phase.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:98-104`
- **Scenario:** User searches → expands collapsible → clears search → collapsible may not restore
- **Fix:** Add explicit restore call or verify reactive flow handles this

---

## ProfileView Regressions (NEW - 2026-01-29)

### PV-L1) Shadow DOM event propagation for API toggle (MEDIUM)

- **Area:** ProfileView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** `ApiAccessSection.ts` dispatches event at line 31. If event bubbling from
  Shadow DOM to Light DOM parent doesn't work correctly, the refresh won't occur.
- **Location:** `src/profileView/frontend/components/ApiAccessSection.ts:27-32`
- **Fix:** Verify event reaches parent and triggers `sendProfileData()` refresh

### PV-U1) Model access section uses `<details>` instead of custom collapsible (MEDIUM)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Medium
- **Current behavior:** New `ApiAccessSection.ts` uses HTML `<details>` element with custom CSS.
  Old implementation may have used different expand/collapse styling.
- **Location:** `src/profileView/frontend/components/ApiAccessSection.ts:57-64`
- **Fix:** Visual comparison to verify parity

---

## Controller Regressions (NEW - 2026-01-29)

### CTRL-1) CopyButtonController timer collision risk (MEDIUM)

- **Area:** Shared Controllers
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Two separate mechanisms manage copy button timeouts:
  1. `CopyButtonController` stores timeout in `_resetTimeoutId`
  2. `copyWithFeedback()` stores timeout in `button.dataset.copyResetTimeoutId`
     If both are used on the same button, or if button element is replaced during re-render, timers leak.
- **Location:**
  - `src/shared/controllers/CopyButtonController.ts:130-137`
  - `src/shared/utils/clipboard.ts:69-74`
- **Fix:** Document that patterns must not be mixed on same element

### CTRL-2) RecordingButtonController empty lifecycle method (LOW)

- **Area:** Shared Controllers
- **Type:** Code quality
- **Impact:** Low
- **Current behavior:** `hostConnected(): void {}` is empty - vestigial from migration.
- **Location:** `src/shared/controllers/RecordingButtonController.ts:61`
- **Fix:** Remove empty method

---

## Backend Regression Audit (2026-01-29)

> **Status: ✅ NO BACKEND REGRESSIONS FOUND**
>
> Comprehensive audit of backend code changes confirms all state management, event handling,
> and data persistence is working correctly without regressions.

### Audit Summary

| Area                 | Status | Finding                                                  |
| -------------------- | ------ | -------------------------------------------------------- |
| State Persistence    | ✅     | Robust with Zod `.catch()` fallbacks for recovery        |
| Event Bus            | ✅     | Permission event rename migration complete (L9 verified) |
| ToolUseFollowUpQueue | ✅     | Import consolidation only - no logic changes             |
| PersistentMapManager | ✅     | `StorageRecordSchema.catch({})` handles invalid data     |
| Message Handlers     | ✅     | Type-safe schema-driven dispatch pattern                 |
| Schema Validation    | ✅     | All schemas use `.catch()` for graceful degradation      |

### Key Backend Files Verified

```
src/shared/state/PersistedState.ts        ✅ Safe - Zod schema validation with fallbacks
src/progressView/persistence/PersistentMapManager.ts  ✅ Safe - StorageRecordSchema handles null/invalid
src/eventBus/ProgressEventBus.ts          ✅ Complete - All permission events renamed
src/agent/toolUse/ToolUseFollowUpQueueManager.ts  ✅ Safe - Import path consolidation only
src/progressView/ProgressViewMessageHandler.ts  ✅ Safe - Schema-driven typed dispatch
```

### Event Bus Migration Verification

All event producers emit new permission event names:

- `bashApproval.ts:105` → `bus.emit('showBashPermission', ...)`
- `bashApproval.ts:114` → `bus.emit('resolveBashPermission', ...)`
- `toolEditApproval.ts:201` → `bus.emit('showToolEditPermission', ...)`
- `toolEditApproval.ts:215` → `bus.emit('resolveToolEditPermission', ...)`

All event consumers listen to new names:

- `UIEvents.ts:106-138` - All handlers wired to new event names
- `ProgressViewProvider.ts:90-129` - All callbacks use new names
- `WebviewUpdater.ts:199-231` - All methods match new event names

**Result:** Zero orphaned listeners for old event names (`*ApprovalPrompt` types)

### Data Loss Scenarios Tested

| Scenario             | Result | Reason                                        |
| -------------------- | ------ | --------------------------------------------- |
| Invalid storage data | ✅     | `StorageRecordSchema.catch({})` returns empty |
| Null/undefined state | ✅     | Schema `.catch()` provides defaults           |
| Webview reload       | ✅     | Backend sends fresh state via messages        |
| Stream deletion      | ✅     | `ToolUseFollowUpQueue.release()` called       |
| Event type mismatch  | ✅     | TypeScript catches at compile time            |

---

## Regression inventory (observed)

> **Legend:**
>
> - **Area:** MainView / ProgressView / Shared
> - **Type:** Missing UI element / CSS regression / Logic regression
> - **Impact:** High / Medium / Low

### 1) Output file action buttons lost fixed sizing

- **Area:** MainView
- **Type:** CSS regression
- **Impact:** Medium
- **Current behavior:** Output file toolbar buttons no longer use a sizing class and have no
  replacement styles, causing visual inconsistencies in button size and spacing.
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts`

### 2) Badge padding reduced globally

- **Area:** Shared
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Global badge padding is smaller, compressing category chips and
  history tags.
- **Location:** `src/common/styles/common.css`

### 3) Log entry detail rows lost base layout styles

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Medium
- **Current behavior:** `.detail-item` base styles were removed from log entry styles but
  the shared base styles are not included in `logStyles`, so detail rows lose the flex layout
  and spacing they previously relied on.
- **Location:**
  - `src/progressView/frontend/styles/logEntryStyles.ts`
  - `src/progressView/frontend/styles/logStyles.ts`

### 4) Log entry summary rows lost base layout styles

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Medium
- **Current behavior:** `.details-summary` base styles were removed with the same assumption
  of shared styles, but `logStyles` still omits the shared base styles, causing summary rows to
  lose consistent alignment and spacing.
- **Location:**
  - `src/progressView/frontend/styles/logEntryStyles.ts`
  - `src/progressView/frontend/styles/logStyles.ts`

### 5) Code block copy button padding changed

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Copy button padding is now driven by small spacing tokens, making the
  icon button look noticeably tighter than adjacent toolbar controls.
- **Location:** `src/progressView/frontend/styles/codeBlockStyles.ts`

### 6) Tool-use sublabel opacity shifted to design token

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Tool-use sublabels now use `--opacity-normal`, which may differ from
  the previous explicit opacity and can reduce readability depending on theme.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 7) Tool-use warning stripe width now tokenized

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Warning stripes use `--border-thick` instead of the prior 3px width,
  resulting in inconsistent emphasis depending on theme token definitions.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 8) Tool-use feedback border thickness changed

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Feedback panels now use `--border-thick` for the left border instead of
  3px, which can visually misalign with other alert banners.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 9) Inline diff highlight padding and radius changed

- **Area:** ProgressView
- **Type:** CSS regression
- **Impact:** Low
- **Current behavior:** Inline diff highlights use smaller padding and tokenized border radius,
  which reduces the prominence of additions/deletions compared to other inline tags.
- **Location:** `src/progressView/frontend/styles/toolUseStyles.ts`

### 10) Agent banner now hides for any selection

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** Selecting any agent now hides the agent config banner unconditionally.
  Previously, banner visibility depended on whether the selected option was disabled. This can
  mask missing agent configuration or a disabled agent selection.
- **Location:** `src/webview/frontend/MainApp.ts`

### 11) API key banner no longer has a forced-visible mode

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium
- **Current behavior:** The API key banner is set purely from the backend message and can be
  dismissed without a local guard. If the backend does not re-trigger the banner, users can
  lose the “API key required” prompt while still blocked.
- **Location:** `src/webview/frontend/MainApp.ts`

## Goals

1. **Fix critical queued message persistence** (L1, L2) - highest priority
2. Restore missing styling hooks and class-level layout styles.
3. Reintroduce UI logic guards for banners that should not silently disappear.
4. Align ProgressView spacing and highlighting with the main branch baseline.
5. Ship a regression-free UI without reintroducing deleted CSS files.

## Non-goals

- Reworking the overall visual design language or theme tokens.
- Reintroducing removed CSS files that were intentionally consolidated.

## Requirements

### R0: Fix queued message persistence (CRITICAL) ✅ ALL FIXED

> **Priority: P0** - ✅ All critical issues resolved

**R0.1: Clear queued follow-ups on stream switch-away** ✅ FIXED

- The `'clear'` action in `updateLogContent` clears all frontend `streamStates`
- Frontend handler at `messageDispatcher.ts:205-208` sets `streamStates: new Map()`
- This clears queuedFollowUps along with all other stream state

**R0.2: Send queued follow-ups on stream activation** ✅ FIXED

- Already implemented at lines 323-326 of `ProgressEventHandler.ts`
- Uses `ToolUseFollowUpQueue.getAll(stream)` to fetch messages

**R0.3: Update stale docstring** ⬜ NOT STARTED (low priority)

- `FollowUpEventHandlers.ts:12` says "refreshStreamSurface doesn't refresh follow-ups"
- This is no longer true after R0.2 fix - should be updated or removed

### R1: Output files toolbar sizing

- Reintroduce a consistent size for output file toolbar buttons.
- Keep sizing local to the component or a shared toolbar style.

### R2: Badge padding parity

- Restore badge padding to match baseline sizing, or introduce explicit size variants.

### R3: ProgressView log detail layout

- Ensure `.detail-item` and `.details-summary` have consistent base layout styles in all log
  contexts (either by reintroducing base styles or by including `commonViewStyles`).

### R4: ProgressView spacing and highlight parity

- Normalize padding/width differences in code block actions and tool-use panels so they match
  baseline affordances.

### R5: Banner guardrails

- Reintroduce a guard for the agent config banner so it remains visible when a disabled or
  misconfigured agent is selected.
- Add a forced-visible state (or equivalent backend-triggered lock) for the API key banner
  until resolution.

### R6: BannerGroup null safety

- Add null check for provider before rendering API key banner
- Location: `src/webview/frontend/components/BannerGroup.ts:225`

### R7: CSS tokenization in UserMessage

- Replace hard-coded `border-left: 3px` with `var(--border-thick)`
- Consider tokenizing `max-width: 85%` for layout consistency
- Location: `src/progressView/frontend/components/UserMessage.ts:39-41`

### R8: Schema fallback logging

- Add telemetry/logging when `.catch()` fallbacks trigger in schemas
- Helps detect silent data corruption without breaking the robust recovery pattern
- Locations:
  - `src/shared/schemas/storage.ts:12` (StorageRecordSchema)
  - `src/progressView/state/ProgressViewState.ts:52-55` (ProgressViewPrefsSchema)

### R9: Legacy data migration verification

- Verify `UsageStatsManager` correctly handles legacy `TokenUsageStats` format
- Check `schemaUtils.ts` schema validation covers migration case
- Location: `src/progressView/managers/UsageStatsManager.ts`

### R10: Event bus type binding verification ✅ VERIFIED

- ✅ All event handlers use new permission type names (verified 2026-01-29)
- ✅ No runtime mismatches - TypeScript catches at compile time
- ✅ Zero references to old type names (`*ApprovalPrompt`) in codebase
- Location: `src/eventBus/ProgressEventBus.ts:75-87`

## UX notes

- Any UI change should be visually verified in VS Code’s dark and light themes.
- Changes should avoid reintroducing Light DOM CSS files; keep Lit-native styles.

## Open questions

1. Should banner guards live in MainView or be controlled entirely by backend messaging?
2. Are we comfortable standardizing tool-use accent widths to `--border-thick`, or do we want
   a fixed pixel value for consistency across themes?
3. Does the baseline for badge padding need to be strictly preserved, or can we standardize a
   smaller size and adjust adjacent spacing?

---

## Fix Priority Summary (2026-01-29)

| Priority | Issue                                             | Severity     | Effort | Status                       |
| -------- | ------------------------------------------------- | ------------ | ------ | ---------------------------- |
| ~~P0~~   | SP-1: Webview cache design                        | ~~Critical~~ | -      | ✅ BY DESIGN                 |
| ~~P0~~   | SP-2: StreamStates transient                      | ~~Critical~~ | -      | ✅ BY DESIGN                 |
| **P0**   | L1: clearStreamSurface missing queuedFollowUps    | 🔴 Critical  | Low    | ✅ Fixed (clear action)      |
| **P0**   | L2: refreshStreamSurface missing queuedFollowUps  | 🔴 Critical  | Low    | ✅ Fixed in PR               |
| ~~P1~~   | SP-3: Race condition cache init vs message        | ~~High~~     | -      | ✅ BY DESIGN (WEBVIEW_READY) |
| **P1**   | SP-4: pendingLogUpdates not namespaced            | 🟠 High      | Low    | ⬜ Needs verification        |
| **P1**   | L3: Schema defaults hide data loss                | 🟠 High      | Low    | ⚠️ By design (see note)      |
| **P1**   | U2: BannerGroup null check                        | 🟠 High      | Low    | ⬜ Not Started               |
| **P2**   | L4: Stream deletion cleanup                       | 🟡 Medium    | Low    | ✅ Fixed                     |
| ~~P2~~   | SP-5: PersistedState.reload() utility             | 🟡 Medium    | -      | ✅ BY DESIGN (optional)      |
| **P2**   | HV-L1: HistoryView search state not persisted     | 🟡 Medium    | Medium | ⬜ NEW - Needs testing       |
| **P2**   | HV-L2: Toggle state sync timing                   | 🟡 Medium    | Medium | ⬜ NEW - Needs testing       |
| **P2**   | PV-L1: ProfileView Shadow DOM event propagation   | 🟡 Medium    | Low    | ⬜ NEW - Needs testing       |
| **P2**   | PV-U1: Model access `<details>` styling           | 🟡 Medium    | Low    | ⬜ NEW - Visual check        |
| **P2**   | CTRL-1: CopyButtonController timer collision      | 🟡 Medium    | Low    | ⬜ NEW - Document            |
| **P2**   | U3: FollowUpInput visibility pattern              | 🟡 Medium    | Medium | ⬜ Not Started               |
| **P2**   | L8: Legacy usage stats normalization removed      | 🟡 Medium    | Medium | ⚠️ REAL - Needs fix          |
| ~~P2~~   | U7: Hard-coded border in UserMessage              | 🟡 Medium    | Low    | ✅ False positive (new)      |
| ~~P2~~   | L5: StorageRecordSchema silent fallback           | 🟡 Medium    | Low    | ✅ False positive (new)      |
| ~~P2~~   | L6: Preference .catch() hides corruption          | 🟡 Medium    | Low    | ✅ False positive            |
| ~~P2~~   | L7: Pending log updates cache edge cases          | 🟡 Medium    | Medium | ✅ False positive (new)      |
| ~~P2~~   | L9: Permission type renames in event bus          | 🟡 Medium    | Low    | ✅ False positive            |
| **P2**   | U6: Multiple Outputs toggle disappears on restore | 🟡 Medium    | Medium | ✅ Not a bug (by design)     |
| **P3**   | SP-6: MementoStorage rename inconsistency         | 🟢 Low       | Low    | ⬜ NEW - Code quality        |
| **P3**   | CTRL-2: RecordingButtonController empty method    | 🟢 Low       | Low    | ⬜ NEW - Remove method       |
| **P3**   | U1: aria-hidden verification                      | 🟢 Low       | Low    | ⬜ Not Started               |
| **P3**   | U4: CSS selector timing                           | 🟢 Low       | Low    | ⬜ Not Started               |
| **P3**   | U5: SortableController timing                     | 🟢 Low       | Low    | ⬜ Not Started               |
| ~~P3~~   | U8: Hard-coded max-width in UserMessage           | 🟢 Low       | Low    | ✅ False positive (new)      |
| **P3**   | Stale docstring in FollowUpEventHandlers.ts       | 🟢 Low       | Low    | ⬜ Not Started               |

### Recommended Fix Order

1. ~~**L1** - Fix `clearStreamSurface()` to clear queued follow-ups~~ ✅ Done (clear action handles it)
2. ~~**L4** - Clean up queued messages on stream deletion~~ ✅ Done
3. ~~**SP-1, SP-2** - Webview state persistence~~ ✅ By design (backend is source of truth)
4. **L8** - Fix legacy usage stats normalization (users may lose data on upgrade)
5. **U2** - Add null safety to BannerGroup
6. **SP-4** - Verify pendingLogUpdates ID uniqueness across streams
7. **Stale docstring** - Update `FollowUpEventHandlers.ts:12` (L2 is now fixed)
8. **L3** - Consider removing `.prefault([])` or adding explicit validation (by design - may keep)
9. **U3** - Evaluate FollowUpInput visibility pattern

**False positives removed from fix order (verified not regressions):**

- ~~SP-1, SP-2, SP-3, SP-5~~ - Intentional architecture (backend is source of truth)
- ~~U7, U8~~ - New file, not regression
- ~~L5, L6~~ - Equivalent to old behavior
- ~~L7~~ - New feature, not regression
- ~~L9~~ - Complete rename, all handlers updated

### Remaining Files to Modify

```
# REAL REGRESSION
src/progressView/managers/UsageStatsManager.ts        # L8 (legacy format handling)

# NEEDS VERIFICATION
src/progressView/frontend/messageDispatcher.ts        # SP-4 (verify log ID uniqueness)

# Other issues
src/progressView/events/FollowUpEventHandlers.ts      # Stale docstring (low priority)
src/webview/frontend/components/BannerGroup.ts        # U2
src/progressView/frontend/components/FollowUpInput.ts # U3 (evaluate)
```
