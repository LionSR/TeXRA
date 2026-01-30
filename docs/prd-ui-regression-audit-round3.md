# PRD: UI & Logic Regression Audit - Round 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md), [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD documents **20 additional UI or logic regressions** identified in a fresh audit of the
current branch. Each issue is double-checked against implementation details (no false positives),
with concrete code references and **root-cause fixes** instead of band-aid workarounds.

> **Status: 🟡 IN PROGRESS (2026-02-02)**

### Baseline for comparison

Findings are based on direct inspection of current code paths and their observable behaviors.
Items already captured in prior regression PRDs are excluded.

---

## ProgressView Regressions

### P1) `updateNestedRounds` resets unrelated runs when `reset + runId + rounds` (HIGH)

- **Area:** ProgressView (state updates)
- **Type:** Logic regression
- **Impact:** High (clears data for other runs when resetting a single run)
- **Location:** `src/progressView/frontend/stateUtils.ts:22-55`
- **Root cause:** `updateNestedRounds()` uses `const base = reset ? {} : current` even when
  `runId` is provided, wiping all other runs.
- **Fix (root):** When `reset` is true and `runId` is provided, only clear the specific run's
  rounds (e.g., `const base = { ...current }; delete base[runId];`) before merging new rounds.

### P2) Tool-use instruction never renders if first log batch is empty (HIGH)

- **Area:** ProgressView (tool-use logs)
- **Type:** Logic regression
- **Impact:** High (user sees blank log until a message arrives)
- **Location:** `src/progressView/frontend/stateUtils.ts:61-92`
- **Root cause:** `prependInstructionForToolUse()` exits early when `messages.length === 0`, so
  the synthetic userMessage is never inserted for empty log batches.
- **Fix (root):** Allow injection even when the message list is empty by creating a new array
  containing the instruction message as the first entry.

### P3) Active stream content disappears when filter excludes it (HIGH)

- **Area:** ProgressView (stream switching)
- **Type:** UX regression
- **Impact:** High (active stream becomes blank when filter is changed)
- **Location:** `src/progressView/frontend/ProgressApp.ts:214-233`
- **Root cause:** `getActiveStreamInfo()` searches within `getFilteredStreams()` instead of
  the full stream list, so filtered-out streams return `null` and clear the content area.
- **Fix (root):** Resolve the active stream from the full stream list and keep rendering it
  even if it’s not shown in the filtered tab list.

### P4) Default run usage/files never render when `runId` is null (MEDIUM)

- **Area:** ProgressView (workflow stream content)
- **Type:** Logic regression
- **Impact:** Medium (usage/files missing for single/default runs)
- **Location:** `src/progressView/frontend/components/WorkflowStreamContent.ts:149-171`
- **Root cause:** `computeRunValues()` uses `runId ? ... : null/{}` for usage and files but
  uses `runKey ?? 'default'` for instructions. When `runId` is `null`, default-run usage/files
  are ignored.
- **Fix (root):** Use the same `runKey` fallback for `usage` and `files` (e.g., `const runKey = runId ?? 'default'`).

### P5) Stream tab select/delete clicks fail inside Shadow DOM (HIGH)

- **Area:** ProgressView (stream tabs)
- **Type:** UI regression
- **Impact:** High (clicks on tab action buttons don’t register)
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:368-392`
- **Root cause:** `handleTabClick()` uses `target.closest(...)`, which fails when the click
  originates inside `vscode-toolbar-button` shadow DOM.
- **Fix (root):** Traverse `event.composedPath()` to find the element with `data-stream` and
  `data-action` (same pattern as `LogList.findTargetInPath()`).

### P6) Sort button clicks fail inside Shadow DOM (MEDIUM)

- **Area:** ProgressView (stream tabs)
- **Type:** UI regression
- **Impact:** Medium (sorting buttons feel unresponsive)
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:395-409`
- **Root cause:** `handleSortClick()` uses `target.closest('[data-sort]')`, which doesn’t
  traverse Shadow DOM boundaries.
- **Fix (root):** Replace with `event.composedPath()` lookup for an element containing `data-sort`.

### P7) Toolbar actions fail inside Shadow DOM (HIGH)

- **Area:** ProgressView (stream header)
- **Type:** UI regression
- **Impact:** High (critical toolbar actions ignored)
- **Location:** `src/progressView/frontend/components/StreamHeader.ts:432-446`
- **Root cause:** `handleToolbarClick()` uses `target.closest('[data-command]')`, which misses
  clicks inside `vscode-toolbar-button` shadow roots.
- **Fix (root):** Walk `event.composedPath()` and locate the first element with `data-command`.

### P8) File action buttons fail inside Shadow DOM (HIGH)

- **Area:** ProgressView (file list)
- **Type:** UI regression
- **Impact:** High (compare/merge/accept buttons don’t work)
- **Location:** `src/progressView/frontend/components/FileList.ts:286-298`
- **Root cause:** `handleFileClick()` uses `target.closest('[data-command]')`, which doesn’t
  cross Shadow DOM boundaries.
- **Fix (root):** Use `event.composedPath()` to find the data-command element reliably.

### P9) Request panel menu actions fail inside Shadow DOM (MEDIUM)

- **Area:** ProgressView (approval/request panels)
- **Type:** UI regression
- **Impact:** Medium (menu actions appear to do nothing)
- **Location:** `src/progressView/frontend/components/RequestPanels.ts:761-785`
- **Root cause:** `handleMenuClick()` uses `target.closest('vscode-context-menu-item')`, which
  doesn’t reach the host element when clicks originate inside Shadow DOM.
- **Fix (root):** Resolve the menu item using `event.composedPath()` and match on node type/class.

### P10) Radio change extraction fails under Shadow DOM (MEDIUM)

- **Area:** ProgressView (filters)
- **Type:** Logic regression
- **Impact:** Medium (filter changes occasionally ignored)
- **Location:** `src/progressView/frontend/utils.ts:11-20`
- **Root cause:** `getRadioValue()` relies on `target.closest('vscode-radio')`, which doesn’t
  cross Shadow DOM boundaries.
- **Fix (root):** Find the radio element via `event.composedPath()` and fall back to
  `event.currentTarget.value` if needed.

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
- **Location:** `src/progressView/frontend/components/LatexdiffResults.ts:109-123`
- **Root cause:** `repeat()` key uses only `${entry.baseFile}-${entry.revisedFile}` which
  collides when the same file appears across rounds.
- **Fix (root):** Include `runId` and/or round identifiers in the key (e.g., `${runId}-${baseRound}-${revisedRound}-${diffFile}`).

### P14) Queued follow-up list uses unstable keys (LOW)

- **Area:** ProgressView (queued follow-ups)
- **Type:** UI regression
- **Impact:** Low (DOM reuse glitches when messages reorder)
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:99-121`
- **Root cause:** Keys use `index` + message prefix, which changes when items are inserted/removed
  and collides for similar prefixes.
- **Fix (root):** Use stable IDs (hash of full message + timestamp/sequence) or include full
  message content in the key for uniqueness.

### P15) Follow-up options stored globally instead of per stream (HIGH)

- **Area:** ProgressView (follow-up setup)
- **Type:** Logic regression
- **Impact:** High (options bleed between streams)
- **Location:** `src/progressView/frontend/store.ts:23-41`,
  `src/progressView/frontend/messageDispatcher.ts:516-526`
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
- **Location:** `src/progressView/frontend/components/StreamTabs.ts:307-346`
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
- **Location:** `src/historyView/frontend/components/HistoryList.ts:68-166`
- **Root cause:** `applySearchToItems()` is asynchronous but has no cancellation/versioning,
  so slower searches can overwrite newer results when the term changes quickly.
- **Fix (root):** Add a request counter/abort token and ignore stale search responses.

---

## Verification Summary (2026-02-02)

| Issue   | Status       | Severity | Notes                                  |
| ------- | ------------ | -------- | -------------------------------------- |
| **P1**  | ✅ Confirmed | HIGH     | Reset wipes unrelated runs             |
| **P2**  | ✅ Confirmed | HIGH     | Instruction not injected for empty log |
| **P3**  | ✅ Confirmed | HIGH     | Filter hides active stream content     |
| **P4**  | ✅ Confirmed | MEDIUM   | Default run usage/files omitted        |
| **P5**  | ✅ Confirmed | HIGH     | Shadow DOM breaks tab actions          |
| **P6**  | ✅ Confirmed | MEDIUM   | Shadow DOM breaks sort actions         |
| **P7**  | ✅ Confirmed | HIGH     | Shadow DOM breaks toolbar actions      |
| **P8**  | ✅ Confirmed | HIGH     | Shadow DOM breaks file actions         |
| **P9**  | ✅ Confirmed | MEDIUM   | Shadow DOM breaks context menu         |
| **P10** | ✅ Confirmed | MEDIUM   | Radio value extraction unreliable      |
| **P11** | ✅ Confirmed | MEDIUM   | Buttons enabled without validation     |
| **P12** | ✅ Confirmed | MEDIUM   | Polish spinner sticks on failure       |
| **P13** | ✅ Confirmed | LOW      | Non-unique diff keys                   |
| **P14** | ✅ Confirmed | LOW      | Unstable queue keys                    |
| **P15** | ✅ Confirmed | HIGH     | Options bleed between streams          |
| **P16** | ✅ Confirmed | MEDIUM   | Follow-up state leak                   |
| **P17** | ✅ Confirmed | LOW      | Clear-all enabled when empty           |
| **M1**  | ✅ Confirmed | MEDIUM   | Sortable dies after collapse           |
| **M2**  | ✅ Confirmed | MEDIUM   | Menus stay open on outside click       |
| **H1**  | ✅ Confirmed | MEDIUM   | Search results race                    |
