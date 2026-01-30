# PRD: UI & Logic Regression Audit - Round 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md), [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD documents **15 distinct UI or logic regressions** (20 affected locations) identified in a
fresh audit of the current branch. Six Shadow DOM `target.closest()` issues are consolidated into
one systemic item (P5–P10). Each issue includes code references verified against the current source
and **root-cause fixes** instead of band-aid workarounds.

> **Status: 🟡 IN PROGRESS (2026-01-30)**

### Baseline for comparison

Findings are based on direct inspection of current code paths and their observable behaviors.
Items already captured in prior regression PRDs are excluded.

---

## ProgressView Regressions

### P1) `updateNestedRounds` resets unrelated runs when `reset + runId + rounds` (HIGH)

- **Area:** ProgressView (state updates)
- **Type:** Logic regression
- **Impact:** High (clears data for other runs when resetting a single run)
- **Location:** `src/progressView/frontend/stateUtils.ts:26-54`
- **Root cause:** `updateNestedRounds()` uses `const base = reset ? {} : current` even when
  `runId` is provided, wiping all other runs.
- **Fix (root):** When `reset` is true and `runId` is provided, only clear the specific run's
  rounds (e.g., `const base = { ...current }; delete base[runId];`) before merging new rounds.

### P2) Tool-use instruction never renders if first log batch is empty (HIGH)

- **Area:** ProgressView (tool-use logs)
- **Type:** Logic regression
- **Impact:** High (user sees blank log until a message arrives)
- **Location:** `src/progressView/frontend/stateUtils.ts:119-145`
- **Root cause:** `prependInstructionForToolUse()` exits early when `messages.length === 0`, so
  the synthetic userMessage is never inserted for empty log batches.
- **Fix (root):** Allow injection even when the message list is empty by creating a new array
  containing the instruction message as the first entry.

### P3) Active stream content disappears when filter excludes it (HIGH)

- **Area:** ProgressView (stream switching)
- **Type:** UX regression
- **Impact:** High (active stream becomes blank when filter is changed)
- **Location:** `src/progressView/frontend/ProgressApp.ts:248-258`
- **Root cause:** `getActiveStreamInfo()` searches within `getFilteredStreams()` instead of
  the full stream list, so filtered-out streams return `null` and clear the content area.
- **Fix (root):** Resolve the active stream from the full stream list and keep rendering it
  even if it’s not shown in the filtered tab list.

### P4) Default run usage/files never render when `runId` is null (MEDIUM)

- **Area:** ProgressView (workflow stream content)
- **Type:** Logic regression
- **Impact:** Medium (usage/files missing for single/default runs)
- **Location:** `src/progressView/frontend/components/WorkflowStreamContent.ts:154-168`
- **Root cause:** `computeRunValues()` uses `runId ? ... : null/{}` for usage and files but
  uses `runKey ?? 'default'` for instructions. When `runId` is `null`, default-run usage/files
  are ignored.
- **Fix (root):** Use the same `runKey` fallback for `usage` and `files` (e.g., `const runKey = runId ?? 'default'`).

### P5–P10) `target.closest()` fails inside Shadow DOM — systemic issue across 6 locations (HIGH)

- **Area:** ProgressView (multiple components)
- **Type:** UI regression (systemic)
- **Impact:** High (clicks on interactive elements silently fail)
- **Root cause:** Multiple click/change handlers use `target.closest(selector)`, which does not
  traverse Shadow DOM boundaries. When clicks originate inside `vscode-toolbar-button` or
  `vscode-radio` shadow roots, the closest ancestor lookup fails and the event is silently dropped.
- **Fix (root):** Replace all `target.closest()` usages with `event.composedPath()` traversal
  (same pattern as `LogList.findTargetInPath()`). A shared utility could centralize this.
- **Affected locations:**

  | ID  | Component     | Handler              | Location                                                        | Severity |
  | --- | ------------- | -------------------- | --------------------------------------------------------------- | -------- |
  | P5  | StreamTabs    | `handleTabClick`     | `src/progressView/frontend/components/StreamTabs.ts:370-391`    | HIGH     |
  | P6  | StreamTabs    | `handleSortClick`    | `src/progressView/frontend/components/StreamTabs.ts:399-410`    | MEDIUM   |
  | P7  | StreamHeader  | `handleToolbarClick` | `src/progressView/frontend/components/StreamHeader.ts:435-445`  | HIGH     |
  | P8  | FileList      | `handleFileClick`    | `src/progressView/frontend/components/FileList.ts:286-300`      | HIGH     |
  | P9  | RequestPanels | `handleMenuClick`    | `src/progressView/frontend/components/RequestPanels.ts:780-802` | MEDIUM   |
  | P10 | utils (radio) | `getRadioValue`      | `src/progressView/frontend/utils.ts:14-20`                      | MEDIUM   |

### P11) Follow-up buttons remain enabled with invalid selections (MEDIUM)

- **Area:** ProgressView (follow-up section)
- **Type:** UX regression
- **Impact:** Medium (clicking does nothing without feedback)
- **Location:** `src/progressView/frontend/components/FollowupSection.ts:295-408`
- **Root cause:** `emitSetup()`/`emitRun()` silently return if `getFormData()` is null, but the
  buttons never disable or show a validation hint when required selections are missing.
- **Fix (root):** Disable buttons until agent/model selections are valid and optionally show an
  inline message for required fields.

### P12) Follow-up polish spinner can get stuck on failure (MEDIUM)

- **Area:** ProgressView (follow-up input)
- **Type:** Logic regression
- **Impact:** Medium (UI stuck in loading state after failure)
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts:117-214, 274-284`
- **Root cause:** `polishing` is set to `true` in `emitPolish()` and only cleared when
  `polishedText` arrives; no error/timeout path resets it.
- **Fix (root):** Add a failure or timeout message from the backend to reset `polishing`, or
  clear it on a known error command.

### P13) Latexdiff entries reuse keys across rounds (LOW)

- **Area:** ProgressView (latexdiff results)
- **Type:** UI regression
- **Impact:** Low (stale DOM reuse in multi-round diffs)
- **Location:** `src/progressView/frontend/components/LatexdiffResults.ts:155-159`
- **Root cause:** `repeat()` key uses only `${entry.baseFile}-${entry.revisedFile}` which
  collides when the same file appears across rounds.
- **Fix (root):** Include `runId` and/or round identifiers in the key (e.g., `${runId}-${baseRound}-${revisedRound}-${diffFile}`).

### P14) Queued follow-up list uses unstable keys (LOW)

- **Area:** ProgressView (queued follow-ups)
- **Type:** UI regression
- **Impact:** Low (DOM reuse glitches when messages reorder)
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:106-108`
- **Root cause:** Keys use `index` + message prefix, which changes when items are inserted/removed
  and collides for similar prefixes.
- **Fix (root):** Use stable IDs (hash of full message + timestamp/sequence) or include full
  message content in the key for uniqueness.

### P15) Follow-up options stored globally instead of per stream (HIGH)

- **Area:** ProgressView (follow-up setup)
- **Type:** Logic regression
- **Impact:** High (options bleed between streams)
- **Location:** `src/progressView/frontend/store.ts:32-39`,
  `src/progressView/frontend/messageDispatcher.ts:539-546`
- **Root cause:** `ProgressState` stores `followupOptions` as a single value, and inbound
  `SET_FOLLOWUP_OPTIONS` overwrites it without a stream key.
- **Fix (root):** Store follow-up options per stream ID (e.g., `Map<streamId, options>` or
  `Record<streamId, options>`) and select the correct entry for the active stream.

### P16) Follow-up form state leaks between streams (MEDIUM)

- **Area:** ProgressView (follow-up section)
- **Type:** Logic regression
- **Impact:** Medium (stale settings persist across streams)
- **Location:** `src/progressView/frontend/components/FollowupSection.ts:169-232, 419-458`
- **Root cause:** `includeInstruction`, `attachOutputs`, and `initialQuestion` are component
  state that never resets when the active stream changes or options refresh.
- **Fix (root):** Add a `streamId` prop and reset these fields when it changes, or hydrate them
  from follow-up options/state per stream.

### P17) Stream tabs “Clear all” button stays active with no streams (LOW)

- **Area:** ProgressView (stream tabs)
- **Type:** UX regression
- **Impact:** Low (spurious delete-all commands when nothing exists)
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:285-290`
- **Root cause:** The “Clear all” button is always enabled regardless of `streams.length`.
- **Fix (root):** Disable the button when there are no streams (or hide it altogether).

---

## MainView Regressions

### M1) File list drag/drop stops after collapsing list (MEDIUM)

- **Area:** MainView (file selection)
- **Type:** UI regression
- **Impact:** Medium (sortable list stops working after toggle)
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:63-90, 334-386`
- **Root cause:** `SortableController` instance is never reinitialized when the list is hidden
  and re-rendered; the old DOM element is destroyed while the controller still holds a handle.
- **Fix (root):** Track list visibility and call `sortableController.reinitialize()` when
  expanding (same pattern used in `OutputFilesSection`).

### M2) Dropdown menus don’t close on outside clicks (MEDIUM)

- **Area:** MainView (file selection tool menus)
- **Type:** UX regression
- **Impact:** Medium (menus remain stuck open)
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:147-214, 352-364`
- **Root cause:** Menus are only closed on `focusout`, not on document-level outside clicks.
- **Fix (root):** Add a document click listener while menus are open, and close them when the
  click is outside the menu container (dispose listener on close/disconnect).

---

## HistoryView Regressions

### H1) Search results can apply out of order during rapid typing (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium (stale match counts and highlights)
- **Location:** `src/historyView/frontend/components/HistoryList.ts:163-189`
- **Root cause:** `applySearchToItems()` is asynchronous but has no cancellation/versioning,
  so slower searches can overwrite newer results when the term changes quickly.
- **Fix (root):** Add a request counter/abort token and ignore stale search responses.

---

## Verification Summary (2026-01-30)

Status legend: ✅ Confirmed (code path verified) · 🔍 Needs test (code inspection suggests issue, no reproduction test)

| Issue      | Status                  | Severity | Notes                                     |
| ---------- | ----------------------- | -------- | ----------------------------------------- |
| **P1**     | ✅ Confirmed            | HIGH     | Reset wipes unrelated runs (line 48)      |
| **P2**     | 🔍 Needs test           | HIGH     | Instruction skipped for empty log         |
| **P3**     | 🔍 Needs test           | HIGH     | Filter hides active stream content        |
| **P4**     | 🔍 Needs test           | MEDIUM   | Default run usage/files omitted           |
| **P5–P10** | ✅ Confirmed (systemic) | HIGH     | Shadow DOM breaks `target.closest()` (×6) |
| **P11**    | 🔍 Needs test           | MEDIUM   | Buttons enabled without validation        |
| **P12**    | 🔍 Needs test           | MEDIUM   | Polish spinner sticks on failure          |
| **P13**    | ✅ Confirmed            | LOW      | Non-unique diff keys                      |
| **P14**    | ✅ Confirmed            | LOW      | Unstable queue keys                       |
| **P15**    | ✅ Confirmed            | HIGH     | Options bleed between streams             |
| **P16**    | 🔍 Needs test           | MEDIUM   | Follow-up state leak                      |
| **P17**    | ✅ Confirmed            | LOW      | Clear-all enabled when empty              |
| **M1**     | 🔍 Needs test           | MEDIUM   | Sortable dies after collapse              |
| **M2**     | 🔍 Needs test           | MEDIUM   | Menus stay open on outside click          |
| **H1**     | ✅ Confirmed            | MEDIUM   | Search results race (no abort token)      |
