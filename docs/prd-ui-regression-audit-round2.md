# PRD: UI & Logic Regression Audit - Round 2

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audit:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)

## Overview

This PRD documents **17 additional UI or logic regressions** identified during a follow-up audit.
These items are **not covered** in the existing regression audit document.
The focus is on **missing or degraded UI behavior, incorrect state transitions, and logic regressions**
across MainView, ProgressView, HistoryView, ProfileView, and shared state handling.

> **Status: ⬜ Not Started**

### Baseline for comparison

Findings are based on a targeted code review of the current branch against the
expected main-branch behaviors. Each issue includes a concrete code location
for verification.

---

## ProgressView Regressions

### P1) Followup initial-question styles target a non-existent element (LOW)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (styles fail to apply)
- **Current behavior:** CSS targets `vscode-text-area` (hyphenated), but the rendered
  element is `vscode-textarea`, so the width rule never applies.
- **Location:** `src/progressView/frontend/components/FollowupSection.ts:146, 289-295`

### P2) Stream tabs show “53 years ago” for streams without timestamps (LOW)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (misleading metadata)
- **Current behavior:** `formatRelativeTime(stream.lastTimestamp ?? 0)` renders epoch
  time when timestamps are missing, yielding misleading values.
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:323-327`

### P3) READY status is normalized to STOPPED in stream tabs (MEDIUM)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (Ready state never shown)
- **Current behavior:** `normalizeStatus()` maps READY → STOPPED, so the tab
  never displays the Ready indicator.
- **Note:** Shares the READY normalization root cause with P4.
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:428-430`

### P4) READY status is normalized to STOPPED in stream header (MEDIUM)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (status tooltip and indicator never show Ready)
- **Current behavior:** `resolveStatus()` maps READY → STOPPED, hiding the Ready state
  in the header and status tooltip.
- **Note:** Shares the READY normalization root cause with P3.
- **Location:** `src/progressView/frontend/components/StreamHeader.ts:415-417`

### P5) Log list always auto-scrolls to bottom on update (HIGH)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** High (prevents reading older logs)
- **Current behavior:** Every update triggers `scrollToBottom()`, which snaps
  the scroll even when the user is reading earlier entries.
- **Location:** `src/progressView/frontend/components/LogList.ts:128-133`

### P6) Log group toggle state is global, not per stream (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (state leaks across streams)
- **Current behavior:** Toggle state is persisted under a single `logListState`
  storage key, so collapsed groups in one stream affect another.
- **Location:** `src/progressView/frontend/components/LogList.ts:73-92`

### P7) TaskGroup completion tracking is never cleared (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (memory leak + stale comparisons)
- **Current behavior:** `previousStatuses` is never cleared when groups disappear,
  so stale entries accumulate and could trigger incorrect completion sounds.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:77-112`

### P8) Message ordering skews when timestamps are missing (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (log ordering unstable)
- **Current behavior:** Messages sort by `timestamp ?? 0`, causing untimestamped
  messages to float to the top and reorder unexpectedly.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:128-146`

### P9) Root group ordering breaks when startTime is missing (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (run ordering jumps)
- **Current behavior:** Root groups sort by `startTime`; missing values collapse
  to `0`, so newer runs can appear above older ones unpredictably.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:160-171`

### P10) Pending log update cache is not cleared for non-active stream deletes (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (stale updates leak)
- **Current behavior:** `pendingLogUpdates` only clears when deleting the active stream
  or deleting all, leaving stale update entries for other streams.
- **Location:** `src/progressView/frontend/messageDispatcher.ts:116-157`

### P11) New streams default to workflow state when category is missing (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (tool-use stream may render as workflow)
- **Current behavior:** `getStreamState()` falls back to workflow when no category is
  passed, but several call sites omit the category, so new tool-use streams may
  render with the wrong state shape.
- **Location:** `src/progressView/frontend/store.ts:57-66`,
  `src/progressView/frontend/eventHandlers.ts:103-147`

### P12) Run selector sorts sessions oldest-first (LOW)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Low (most recent session buried)
- **Current behavior:** `sortedRuns` sorts by ascending timestamp. If main shows
  newest-first, this reverses the expected order.
- **Location:** `src/progressView/frontend/components/RunSelector.ts:30-41`

---

## MainView Regressions

### M1) File select change handler reads from HTMLInputElement (LOW)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Low (value may not resolve on custom element)
- **Current behavior:** `@change` handler casts to `HTMLInputElement` even though
  the element is `vscode-single-select`.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:468-478`

### M2) File select list toggle state uses `display: none` instead of `hidden` (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (accessibility + layout)
- **Current behavior:** The list container uses `styleMap({ display: 'none' })`,
  which can break focus trapping and screen reader semantics.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:481-492`

### M3) Instruction paste handler assumes textarea event target (LOW)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Low (paste handler may fail on custom element)
- **Current behavior:** `event.target` is cast to `HTMLTextAreaElement`, but the
  actual target can be a `vscode-textarea` wrapper, so `.value` may be missing.
- **Location:** `src/webview/frontend/components/InstructionPanel.ts:218-236`

## HistoryView Regressions

### H1) Mark.js instance is never cleared on item swap (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (stale highlights + memory)
- **Current behavior:** `markInstance` persists across item changes with no cleanup,
  so DOM references can linger after history items change.
- **Location:** `src/historyView/frontend/components/HistoryItem.ts:38-83`

## ProfileView Regressions

### PR1) Category class normalization drops hyphens only (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (CSS badge mismatch)
- **Current behavior:** Category class uses `.replace('-', '')`, which only
  removes the first hyphen. Multi-hyphen categories keep invalid class names.
- **Location:** `src/profileView/frontend/components/AgentsTable.ts:60-66`

---

## Out of Scope

- Backend regressions covered in `prd-ui-regression-audit.md`.
- Any issues already documented in `ui-regressions-lit-migration.md` or prior PRDs.
