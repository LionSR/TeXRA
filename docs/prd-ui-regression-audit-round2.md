# PRD: UI & Logic Regression Audit - Round 2

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audit:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)

## Overview

This PRD documents **17 additional UI or logic regressions** identified during a follow-up audit.
These items are **not covered** in the existing regression audit document.
The focus is on **missing or degraded UI behavior, incorrect state transitions, and logic regressions**
across MainView, ProgressView, HistoryView, ProfileView, and shared state handling.

> **Status: 🟢 VERIFIED (2026-01-30)** - All issues investigated; most are false positives or already fixed

### Baseline for comparison

Findings are based on a targeted code review of the current branch against the
expected main-branch behaviors. Each issue includes a concrete code location
for verification.

---

## ProgressView Regressions

### P1) Followup initial-question styles target a non-existent element (LOW) ✅ FALSE POSITIVE

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (styles fail to apply)
- **Status:** ✅ **FALSE POSITIVE** - Both CSS selector and rendered element use `vscode-textarea` (not hyphenated)
- **Location:** `src/progressView/frontend/components/FollowupSection.ts:146, 289-295`

### P2) Stream tabs show "53 years ago" for streams without timestamps (LOW) ✅ ALREADY FIXED

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (misleading metadata)
- **Status:** ✅ **ALREADY FIXED** - Code uses ternary `stream.lastTimestamp ? formatRelativeTime(...) : ''` plus guard in `formatRelativeTime()` that returns `''` for falsy values
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:328-332`

### P3) READY status is normalized to STOPPED in stream tabs (MEDIUM) ✅ NOT AN ISSUE

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (Ready state never shown)
- **Status:** ✅ **NOT AN ISSUE** - `normalizeStatus()` returns status unchanged or defaults to READY if undefined. No READY→STOPPED mapping exists. This is working as designed (undefined status = READY).
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:430-432`

### P4) READY status is normalized to STOPPED in stream header (MEDIUM) ✅ NOT AN ISSUE

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (status tooltip and indicator never show Ready)
- **Status:** ✅ **NOT AN ISSUE** - `resolveStatus()` returns `streamState?.status || stream?.status || READY`. No READY→STOPPED mapping exists; this is the correct fallback chain.
- **Location:** `src/progressView/frontend/components/StreamHeader.ts:414-418`

### P5) Log list always auto-scrolls to bottom on update (HIGH) ✅ ALREADY FIXED

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** High (prevents reading older logs)
- **Status:** ✅ **ALREADY FIXED** - Code calls `scrollToBottomIfNearEnd()` which checks `isNearBottom(threshold=32)` before scrolling. Only scrolls if user is already near the bottom.
- **Location:** `src/progressView/frontend/components/LogList.ts:140-143`, `TaskGroupList.ts:89-93`

### P6) Log group toggle state is global, not per stream (MEDIUM) ✅ ALREADY FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (state leaks across streams)
- **Status:** ✅ **ALREADY FIXED** - Storage key is parameterized with streamId: `logListState:${streamId}`. Each stream has its own separate toggle state storage.
- **Location:** `src/progressView/frontend/components/LogList.ts:162-178`

### P7) TaskGroup completion tracking is never cleared (LOW) ✅ ALREADY FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (memory leak + stale comparisons)
- **Status:** ✅ **ALREADY FIXED** - Lines 118-122 have cleanup loop that removes stale entries when groups disappear: `for (const key of previousStatuses.keys()) { if (!knownGroups.has(key)) { previousStatuses.delete(key); } }`
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:102-123`

### P8) Message ordering skews when timestamps are missing (MEDIUM) ⚠️ BEHAVIOR DIFFERENT

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (log ordering unstable)
- **Status:** ⚠️ **DIFFERENT BEHAVIOR** - Code uses `timestamp ?? MAX_SAFE_INTEGER` (not 0), so untimestamped messages float to BOTTOM, not top. Falls back to insertion order via `messageOrder` map.
- **Note:** This is arguably better behavior than floating to top, but untimestamped messages should ideally maintain insertion order without being pushed to the end.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:147-152`

### P9) Root group ordering breaks when startTime is missing (LOW) ⚠️ BEHAVIOR DIFFERENT

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (run ordering jumps)
- **Status:** ⚠️ **DIFFERENT BEHAVIOR** - Uses `startTime ?? MAX_SAFE_INTEGER` (not 0), causing groups without startTime to sort to bottom. Falls back to `groupOrder` for insertion order.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:183-188`

### P10) Pending log update cache is not cleared for non-active stream deletes (MEDIUM) ⚠️ REAL ISSUE

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (stale updates leak)
- **Status:** ⚠️ **REAL ISSUE** - `clearPendingLogUpdatesForStream(streamId)` only called when `state.activeStreamId === streamId`. Non-active stream deletions leave stale entries.
- **Fix needed:** Call `clearPendingLogUpdatesForStream(streamId)` unconditionally in DELETE_STREAM handler
- **Location:** `src/progressView/frontend/messageDispatcher.ts:181-202`

### P11) New streams default to workflow state when category is missing (MEDIUM) ⚠️ REAL ISSUE

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (tool-use stream may render as workflow)
- **Status:** ⚠️ **REAL ISSUE** - `getStreamState()` defaults to `AGENT_CATEGORY.WORKFLOW` when agentCategory is undefined. If `streamInfo` is not found or lacks `agentCategory`, tool-use streams silently become workflow state.
- **Location:** `src/progressView/frontend/store.ts:57-66`, `src/progressView/frontend/eventHandlers.ts:150-155`

### P12) Run selector sorts sessions oldest-first (LOW) ✅ FALSE POSITIVE

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Low (most recent session buried)
- **Status:** ✅ **FALSE POSITIVE** - Code uses `bTime - aTime` which is descending order (newest first). The code is correct.
- **Location:** `src/progressView/frontend/components/RunSelector.ts:39-43`

---

## MainView Regressions

### M1) File select change handler reads from HTMLInputElement (LOW) ✅ FALSE POSITIVE

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Low (value may not resolve on custom element)
- **Status:** ✅ **FALSE POSITIVE** - Code correctly casts to `HTMLSelectElement`, not `HTMLInputElement`. The handler is safe.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:149-152`

### M2) File select list toggle state uses `display: none` instead of `hidden` (LOW) ✅ FALSE POSITIVE

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (accessibility + layout)
- **Status:** ✅ **FALSE POSITIVE** - Code correctly uses native `?hidden` binding which sets the `hidden` attribute. This is correct for focus trapping and accessibility.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:480-490`

### M3) Instruction paste handler assumes textarea event target (LOW) ✅ ALREADY FIXED

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Low (paste handler may fail on custom element)
- **Status:** ✅ **ALREADY FIXED** - Code uses `resolveTextareaTarget()` helper function that safely handles both `HTMLTextAreaElement` and `vscode-textarea` wrappers.
- **Location:** `src/webview/frontend/components/InstructionPanel.ts:218-233`

## HistoryView Regressions

### H1) Mark.js instance is never cleared on item swap (LOW) ⚠️ REAL ISSUE

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (stale highlights + memory)
- **Status:** ⚠️ **REAL ISSUE** - `markInstance` is created once and never cleaned up when `item` property changes or component disconnects. This can cause incorrect highlighting or memory leaks.
- **Fix needed:** Add `willUpdate` or `disconnectedCallback` hook to clear/reset markInstance
- **Location:** `src/historyView/frontend/components/HistoryItem.ts:47, 100-125`

## ProfileView Regressions

### PR1) Category class normalization drops hyphens only (LOW) ✅ FALSE POSITIVE

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (CSS badge mismatch)
- **Status:** ✅ **FALSE POSITIVE** - Code uses `.replaceAll('-', '')` which correctly removes ALL hyphens, not just the first one.
- **Location:** `src/profileView/frontend/components/AgentsTable.ts:55-57`

---

---

## Verification Summary (2026-01-30)

| Issue   | Status                | Severity | Notes                                           |
| ------- | --------------------- | -------- | ----------------------------------------------- |
| **P1**  | ✅ False positive     | -        | CSS selector is correct                         |
| **P2**  | ✅ Already fixed      | -        | Ternary + guard prevents epoch time             |
| **P3**  | ✅ Not an issue       | -        | No READY→STOPPED mapping exists                 |
| **P4**  | ✅ Not an issue       | -        | Correct fallback chain                          |
| **P5**  | ✅ Already fixed      | -        | `scrollToBottomIfNearEnd()` checks position     |
| **P6**  | ✅ Already fixed      | -        | Per-stream storage keys                         |
| **P7**  | ✅ Already fixed      | -        | Cleanup loop exists                             |
| **P8**  | ⚠️ Different behavior | LOW      | Uses MAX_SAFE_INTEGER, not 0                    |
| **P9**  | ⚠️ Different behavior | LOW      | Same pattern as P8                              |
| **P10** | ⚠️ **REAL ISSUE**     | MEDIUM   | Non-active stream deletions leave stale entries |
| **P11** | ⚠️ **REAL ISSUE**     | MEDIUM   | Missing category defaults to workflow           |
| **P12** | ✅ False positive     | -        | Sorts newest-first (correct)                    |
| **M1**  | ✅ False positive     | -        | Uses HTMLSelectElement correctly                |
| **M2**  | ✅ False positive     | -        | Uses `?hidden` attribute correctly              |
| **M3**  | ✅ Already fixed      | -        | Uses `resolveTextareaTarget()` helper           |
| **H1**  | ⚠️ **REAL ISSUE**     | LOW      | Mark.js instance not cleaned up                 |
| **PR1** | ✅ False positive     | -        | Uses `.replaceAll()` correctly                  |

### Real Issues Requiring Fixes

1. **P10** - Add `clearPendingLogUpdatesForStream(streamId)` unconditionally in DELETE_STREAM handler
2. **P11** - Ensure agentCategory is always passed to `getStreamState()` or make default more appropriate
3. **H1** - Add cleanup for Mark.js instance in `willUpdate` or `disconnectedCallback`

---

## Critical Fix Applied (2026-01-30)

### NEW-1) Missing codiconStyles in Shadow DOM components (CRITICAL) ✅ FIXED

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Critical (buttons invisible)
- **Status:** ✅ **FIXED** - Added `codiconStyles` import to components using codicon classes
- **Root cause:** Components using Shadow DOM have isolated styles. The codicon font-face was only included in `MainApp.ts` but not in child components like `FileSelectGroup`, `OutputFilesSection`, `BannerGroup`, and `LatexDiffsSection`. This made all codicon icons (chevrons, plus signs, etc.) invisible.
- **Fix applied to:**
  - `src/webview/frontend/components/FileSelectGroup.ts`
  - `src/webview/frontend/components/OutputFilesSection.ts`
  - `src/webview/frontend/components/BannerGroup.ts`
  - `src/webview/frontend/components/LatexDiffsSection.ts`

---

## Out of Scope

- Backend regressions covered in `prd-ui-regression-audit.md`.
- Any issues already documented in `ui-regressions-lit-migration.md` or prior PRDs.
