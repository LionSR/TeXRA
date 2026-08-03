---
created: 2026-01-29
updated: 2026-02-10
---

# PRD: UI & Logic Regression Audit - Round 2

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)
> **Prior audit:** [2026-01-27-prd-ui-regression-audit.md](./2026-01-27-prd-ui-regression-audit.md)

## Overview

This PRD documents **20 additional UI or logic regressions** identified during a follow-up audit.
These items are **not covered** in the existing regression audit document.
The focus is on **missing or degraded UI behavior, incorrect state transitions, and logic regressions**
across MainView, ProgressView, HistoryView, ProfileView, and shared state handling.

> **Status: 🟡 IN PROGRESS (2026-01-30)** - NEW-7/8/9 fixes pending commit

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

### P10) Pending log update cache is not cleared for non-active stream deletes (MEDIUM) ✅ FIXED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (stale updates leak)
- **Status:** ✅ **FIXED** - Removed conditional check; now always calls `clearPendingLogUpdatesForStream(streamId)` when deleting any stream
- **Location:** `src/progressView/frontend/messageDispatcher.ts:192-193`
- **Commit:** `13ce63ab0`

### P11) New streams default to workflow state when category is missing (MEDIUM) ✅ DOCUMENTED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (tool-use stream may render as workflow)
- **Status:** ✅ **DOCUMENTED** - Added docstring warning that callers MUST pass `agentCategory` to avoid incorrect defaults. All current call sites correctly look up category from `streamInfo`.
- **Location:** `src/progressView/frontend/store.ts:52-60`
- **Commit:** `13ce63ab0`

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

### H1) Mark.js instance is never cleared on item swap (LOW) ✅ FIXED

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (stale highlights + memory)
- **Status:** ✅ **FIXED** - Added `willUpdate()` to clear markInstance when item changes, and `disconnectedCallback()` to clean up on unmount
- **Location:** `src/historyView/frontend/components/HistoryItem.ts:50-70`
- **Commit:** `13ce63ab0`

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
| **P10** | ✅ Fixed              | MEDIUM   | Now clears for all stream deletions             |
| **P11** | ✅ Documented         | MEDIUM   | Added docstring warning for callers             |
| **P12** | ✅ False positive     | -        | Sorts newest-first (correct)                    |
| **M1**  | ✅ False positive     | -        | Uses HTMLSelectElement correctly                |
| **M2**  | ✅ False positive     | -        | Uses `?hidden` attribute correctly              |
| **M3**  | ✅ Already fixed      | -        | Uses `resolveTextareaTarget()` helper           |
| **H1**  | ✅ Fixed              | LOW      | Added willUpdate + disconnectedCallback cleanup |
| **PR1** | ✅ False positive     | -        | Uses `.replaceAll()` correctly                  |

### Real Issues - All Fixed ✅

1. **P10** ✅ - Removed conditional; always clears pending log updates on stream delete
2. **P11** ✅ - Added docstring warning; all call sites correctly pass category
3. **H1** ✅ - Added `willUpdate()` and `disconnectedCallback()` for Mark.js cleanup

---

## Fixes Applied (2026-01-30)

### NEW-1) Missing codiconStyles in Shadow DOM components (CRITICAL) ✅ FIXED

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Critical (buttons invisible)
- **Status:** ✅ **FIXED** - Added `codiconStyles` import to components using codicon classes
- **Root cause:** Components using Shadow DOM have isolated styles. The codicon font-face was only included in `MainApp.ts` but not in child components.
- **Fix applied to:**
  - `src/webview/frontend/components/FileSelectGroup.ts`
  - `src/webview/frontend/components/OutputFilesSection.ts`
  - `src/webview/frontend/components/BannerGroup.ts`
  - `src/webview/frontend/components/LatexDiffsSection.ts`
- **Commit:** `4079461ac`

### NEW-2) Multiple files container always visible (MEDIUM) ✅ FIXED

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Medium ("No files selected." always showing)
- **Status:** ✅ **FIXED** - Changed from `?hidden` attribute (which CSS `display:flex` overrides) to Lit conditional rendering with `when()`
- **Fix applied to:**
  - `src/webview/frontend/components/FileSelectGroup.ts`
  - `src/webview/frontend/components/OutputFilesSection.ts`
- **Commit:** `4079461ac`

### NEW-3) Multiple Outputs not including input files (MEDIUM) ✅ FIXED

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium (default output files incomplete)
- **Status:** ✅ **FIXED** - `resolveInitialOutputFiles()` now includes both single input file AND multiple input files
- **Location:** `src/webview/frontend/MainApp.ts:1014-1028`
- **Commit:** `13ce63ab0`

### NEW-4) selectMultipleFiles schema mismatch (CRITICAL) ✅ FIXED

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Critical (file selection broken)
- **Status:** ✅ **FIXED** - Aligned frontend, backend, and schema to use lowercase fileType format
- **Root cause:** Schema expected `'input'|'output'|...` but frontend sent `'InputFiles'|'OutputFiles'|...`
- **Fix applied to:**
  - `src/webview/frontend/MainApp.ts` - Send lowercase fileType
  - `src/webview/managers/FileManager.ts` - Update map keys to lowercase
- **Commit:** `13ce63ab0`

### NEW-5) HistoryList NodeList.map error (CRITICAL) ✅ FIXED

- **Area:** HistoryView
- **Type:** Runtime error
- **Impact:** Critical (history tab crashes)
- **Status:** ✅ **FIXED** - `@queryAll` returns NodeList, not Array. Added `Array.from()` conversion.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:203-205`
- **Commit:** `758ad2faf`

### NEW-6) Remove button red color (LOW) ✅ FIXED

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (visual)
- **Status:** ✅ **FIXED** - Changed from `--vscode-errorForeground` (red) to `--vscode-icon-foreground` with hover effect
- **Location:** `packages/extension/src/webview/frontend/fileSelectStyles.ts:168-176`
- **Commit:** `61fd61638`

### NEW-7) UPDATE\_\*\_FILES schema missing files field (CRITICAL) ✅ FIXED

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Critical (file updates rejected by backend)
- **Status:** ✅ **FIXED** - Added `files: z.array(z.string())` to all UPDATE\_\*\_FILES schemas
- **Root cause:** Schema only had `command` and `fileType` fields, but frontend sends `files` array
- **Symptom:** `Unknown command: updateInputFiles` and validation errors in logs
- **Location:** `src/shared/schemas/mainView.ts:755-779`

### NEW-8) updateMultiFiles missing fileType field (CRITICAL) ✅ FIXED

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Critical (file updates rejected by backend)
- **Status:** ✅ **FIXED** - Added `fileType` to message payload
- **Root cause:** Frontend sent `{ files }` but schema expected `{ fileType, files }`
- **Location:** `src/webview/frontend/MainApp.ts:525-534`

### NEW-9) Output files reordering not working (MEDIUM) ✅ FIXED

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Medium (can't drag-and-drop to reorder output files)
- **Status:** ✅ **FIXED** - Added `updated()` lifecycle to reinitialize Sortable when list becomes visible
- **Root cause:** When output list is conditionally rendered with `when()`, the DOM element is destroyed and recreated, but SortableController's `this.sortable` was still set from the old element, so it never reinitialized
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts:75-82`

---

---

## PR Review Bot Comments Analysis (2026-01-30)

Three review comments were left by automated bots. Investigation results:

### BOT-1) Codicon font exclusion breaks icons (cursor[bot]) ✅ FALSE POSITIVE

- **Claim:** The pattern `**/codicon.ttf` in `.vscodeignore:42` excludes the font, breaking all icons
- **Status:** ✅ **FALSE POSITIVE** - Verified by inspecting `releases/texra-0.35.8.vsix`:
  - The font IS included at `extension/node_modules/@vscode/codicons/dist/codicon.ttf`
  - The negation pattern `!node_modules/@vscode/codicons/dist/**` takes precedence
  - All webviews load the font correctly via VS Code webview URI
- **No action needed**

### BOT-2) Unused vscodeignore pattern (cursor[bot]) ✅ FALSE POSITIVE

- **Claim:** Pattern `!src/shared/styles/*.css` matches no files since directory only has `.ts` files
- **Status:** ✅ **FALSE POSITIVE** - The directory contains `src/shared/styles/tokens.css`
- **No action needed**

### BOT-3) Pre-run instruction storage under 'default' key (chatgpt-codex-connector[bot]) ⚠️ LOW RISK

- **Claim:** Instructions stored under `'default'` key when runId is null won't migrate when a real runId arrives
- **Location:** `src/progressView/frontend/messageDispatcher.ts:394`
- **Status:** ⚠️ **LOW RISK** - Technically valid concern, but:
  - Backend at `ProgressEventHandler.ts:272-277` always passes `runId` when sending instruction updates
  - Instructions are only sent when there's an active run context (`taskState` exists)
  - The `'default'` fallback is defensive and unlikely to be triggered in practice
- **Recommendation:** Monitor for issues. If users report missing instructions, add migration logic to `ADD_TASK_GROUP` handler.

---

## Out of Scope

- Backend regressions covered in `2026-01-27-prd-ui-regression-audit.md`.
- Any issues already documented in `2026-01-26-ui-regressions-lit-migration.md` or prior PRDs.
