# PRD: UI & Logic Regression Audit - Round 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:**
>
> - [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)
> - [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD documents **20 additional UI or logic regressions** identified during a follow-up audit.
These items are **not covered** in the existing regression audit documents.
The focus is on **high-impact behaviors** across MainView, ProgressView, and HistoryView, plus
shared logic affecting stream/task state.

> **Status: 🟡 IN PROGRESS (2026-01-30)** - Newly identified issues pending fixes

### Baseline for comparison

Findings are based on a targeted code review of the current branch versus expected main-branch
behavior and documented UX. Each issue includes a concrete code location for verification.

> **Note:** Line numbers are approximate as of commit `30e7f19`. Use function/method names as the
> primary anchor when navigating the source.

### Acceptance criteria

An issue is considered resolved when:

1. The described behavior is no longer reproducible at the listed location.
2. The fix addresses the **root cause** (not a surface-level workaround).
3. Existing tests pass and, where applicable, a regression test covers the scenario.

---

## MainView Regressions (sorted by severity)

### M1) Clearing a single file does not notify the backend (HIGH)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** High (backend keeps stale file selection; follow-up runs use old file)
- **Current behavior:** `handleEmptyFile()` only updates local state and saves, but never posts
  a command to clear the selection in the extension host.
- **Location:** `handleEmptyFile()` in `src/webview/frontend/MainApp.ts` (~line 1060)
- **Root cause:** Clear handlers were refactored to local-only state updates without sending
  `INPUT_FILE_SELECTED`/`REFERENCE_FILE_SELECTED`-style messages.
- **Fix (root cause):** When a single file is cleared, post the same command used for selection
  with an empty `filePath`. Keep backend in sync rather than relying on local-only state.

### M2) Clearing multi-file lists does not notify the backend (HIGH)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** High (backend still operates on stale multi-file lists)
- **Current behavior:** `handleEmptyFiles()` wipes local list state but never calls
  `updateMultiFiles()` or posts an update to the extension host.
- **Location:** `handleEmptyFiles()` in `src/webview/frontend/MainApp.ts` (~line 1075)
- **Root cause:** Empty-list flow bypasses the standard update pipeline that posts
  `UPDATE_*_FILES` messages.
- **Fix (root cause):** Route empty-list actions through `updateMultiFiles()` so the backend
  receives a definitive empty list and resets its state too.

### M5) Multi-file updates merge instead of replace (HIGH)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** High (removed files never disappear; ordering becomes stale)
- **Current behavior:** `handleSetMultipleFiles()` merges new lists with existing entries
  via `mergeUnique`, preventing removals and overwriting ordering from the backend.
- **Location:** `handleSetMultipleFiles()` in `src/webview/frontend/MainApp.ts` (~line 628)
- **Root cause:** Merge-first strategy was introduced to avoid duplicates but now blocks
  authoritative refreshes from the backend.
- **Fix (root cause):** Replace the list with the backend-provided ordering. If deduping is
  required, do it on the backend before sending, not in the UI.
- **Related:** M8 is the backend-side counterpart of this issue — both should be fixed together.

### M3) Switching to tool-use clears output files without syncing backend (MEDIUM)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium (backend retains output files from workflow session)
- **Current behavior:** `handleSessionTypeChange()` clears output files and visibility locally
  but never notifies the backend.
- **Location:** `handleSessionTypeChange()` in `src/webview/frontend/MainApp.ts` (~line 1109)
- **Root cause:** Session toggle resets local UI state without pushing the change to the
  command layer.
- **Fix (root cause):** After clearing output files for tool-use sessions, dispatch an update
  message (via `updateMultiFiles`) to ensure backend output file list is also cleared.

### M4) Polishing completion with empty text leaves spinner active (MEDIUM)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Medium (polish spinner never stops for empty/whitespace results)
- **Current behavior:** `handleInstructionTextPolished()` only clears `isPolishing` when
  `message.text.trim()` is truthy, leaving the UI stuck if the backend returns empty text.
- **Location:** `handleInstructionTextPolished()` in `src/webview/frontend/MainApp.ts` (~line 790)
- **Root cause:** UI reset is conditioned on non-empty text rather than completion of the
  polish request.
- **Fix (root cause):** Always reset `isPolishing` when a polish response arrives, and handle
  empty text explicitly (e.g., show a warning and keep instruction unchanged).

### M7) Sortable drag-and-drop breaks after collapsing file lists (MEDIUM)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Medium (drag-and-drop stops working after toggling list visibility)
- **Current behavior:** `SortableController` is reinitialized only when `config` changes.
  When the list is hidden and re-rendered, the controller keeps a stale element reference.
- **Location:** `SortableController` in `src/webview/frontend/components/FileSelectGroup.ts` (~line 58)
- **Root cause:** Controller lifecycle does not account for conditional DOM removal.
- **Fix (root cause):** Track list visibility and call `sortableController.reinitialize()` when
  the list is re-mounted (same pattern as OutputFilesSection).

### M8) Backend cannot clear multi-file lists from FileManager (MEDIUM)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium (backend updates cannot clear UI lists)
- **Current behavior:** `handleSetMultipleFiles()` in `FileManager` bails out when the list
  is empty, so the frontend never receives a clear update.
- **Location:** `handleSetMultipleFiles()` in `src/webview/managers/FileManager.ts` (~line 218)
- **Root cause:** Empty lists are treated as no-ops, but they should be authoritative clears.
- **Fix (root cause):** Always post the list to the frontend, even when empty, so the UI can
  clear stale selections.
- **Related:** This is the backend-side counterpart of M5 — both should be fixed together.

### M6) Multi-file lists auto-expand even when backend sends an empty list (LOW)

- **Area:** MainView
- **Type:** UX regression
- **Impact:** Low (empty list auto-opens, distracting users)
- **Current behavior:** `handleSetMultipleFiles()` always sets `multiFilesVisible[listId] = true`
  even if the backend list is empty.
- **Location:** `handleSetMultipleFiles()` in `src/webview/frontend/MainApp.ts` (~line 637)
- **Root cause:** Visibility is tied to any update, not to meaningful content.
- **Fix (root cause):** Only auto-open lists when the incoming list has items, otherwise keep
  visibility unchanged.

---

## ProgressView Regressions (sorted by severity)

### P1) Per-run reset wipes all run outputs (HIGH)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** High (data loss across runs)
- **Current behavior:** `updateNestedRounds()` uses `base = reset ? {} : current`, which
  wipes **all** runs when `reset` is true, even if a specific runId is provided.
- **Location:** `updateNestedRounds()` in `src/progressView/frontend/stateUtils.ts` (~line 26)
- **Root cause:** The reset path treats run-specific resets as full resets.
- **Fix (root cause):** When `reset` is true and `runId` is provided, clone `current` and
  only replace the specified run's entry.

### P2) UPDATE_LOGS clear leaves stale run metadata (HIGH)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** High (UI shows old instructions/usage/files after clear)
- **Current behavior:** `UPDATE_LOGS` with `action: 'clear'` resets logs and task groups but
  **does not clear** `runInstructions`, `runUsage`, `runFiles`, or `runMissingOutputs`.
- **Location:** `UPDATE_LOGS` handler in `src/progressView/frontend/messageDispatcher.ts` (~line 221)
- **Root cause:** Clear logic only touches log arrays and groups.
- **Fix (root cause):** When clearing, reset run-scoped state maps and `activeRunId`/
  `selectedRunId` so the view is fully reset.

### P3) UPDATE_INSTRUCTION can overwrite the wrong run (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (instructions show under the wrong run)
- **Current behavior:** If backend omits `runId`, the handler resolves a runId via
  `resolveRunId()` and updates that run, even if the instruction belongs to a different run.
- **Location:** `UPDATE_INSTRUCTION` handler in `src/progressView/frontend/messageDispatcher.ts` (~line 391)
- **Root cause:** Fallback run resolution is applied for updates that should be explicit.
- **Fix (root cause):** Require `runId` in the message (or include it in schema) for
  instruction updates. If missing, log and ignore rather than updating a guessed run.

### P4) Stream filter can leave ProgressView blank (MEDIUM)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Medium (content area goes empty while an active stream still exists)
- **Current behavior:** Filter changes only update `streamFilter`. `getActiveStreamInfo()`
  searches **filtered** streams, so the active stream disappears and content renders empty.
- **Location:**
  - `getActiveStreamInfo()` in `src/progressView/frontend/ProgressApp.ts` (~line 248)
  - Filter handling in `src/progressView/frontend/eventHandlers.ts`
- **Root cause:** Active stream ID is not reconciled with the filtered list.
- **Fix (root cause):** When filter changes, if the active stream is no longer visible,
  switch to the first visible stream or clear `activeStreamId` explicitly.

### P5) Workflow run panels default to empty because runId is strict (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (usage/files/instruction panels show empty despite existing runs)
- **Current behavior:** `updateStreamContext()` uses `resolveRunId(..., { mode: 'strict' })`,
  so if `selectedRunId` and `activeRunId` are unset, `runId` becomes null and
  run-specific panels render empty.
- **Location:** `setStreamState()` in `src/progressView/frontend/ProgressApp.ts` (~line 286)
- **Root cause:** Strict run resolution ignores the latest available run.
- **Fix (root cause):** Use `mode: 'fallback'` (or populate `selectedRunId` on updates)
  so the latest run displays by default.

### P6) Compare Previous sends invalid compare when base is missing (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (compare command uses empty base path)
- **Current behavior:** `handleComparePrevious()` always executes `texra.compare`, even when
  `previousFile` is undefined, passing `pathToLocation('')`.
- **Location:** `handleComparePrevious()` in `src/progressView/ProgressViewMessageHandler.ts` (~line 710)
- **Root cause:** Missing guard for base/prev before compare command.
- **Fix (root cause):** Use `executeWithBaseFile()` or return early when `previousFile`
  is not available.

### P7) Model output backups are not cleared on stream deletion (MEDIUM) ⚠️ Fix with P8

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (stale backups + wrong follow-up notifications)
- **Current behavior:** `modelOutputBackups` retains entries even after
  `handleDeleteStream()` / `handleDeleteAll()`.
- **Location:**
  - `modelOutputBackups` in `src/progressView/ProgressViewMessageHandler.ts` (~line 75)
  - `handleDeleteStream()` / `handleDeleteAll()` (~line 264)
- **Root cause:** Delete flows clear stream state but never purge backup map entries.
- **Fix (root cause):** On delete stream/all, remove any backups associated with those
  streams (use streamId-aware keys; see P8).
- **Related:** P8 changes the key format — implement P7 and P8 atomically to avoid rework.

### P8) Model output backups collide across streams (MEDIUM) ⚠️ Fix with P7

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (accepting file in one stream may send follow-up for another)
- **Current behavior:** `modelOutputBackups` is keyed **only by file path**, so multiple
  streams editing the same file overwrite each other.
- **Location:** `modelOutputBackups` in `src/progressView/ProgressViewMessageHandler.ts` (~line 75)
- **Root cause:** Map key ignores `streamId`, allowing cross-stream collisions.
- **Fix (root cause):** Use a composite key (`${streamId}:${file}`) or map of streamId ->
  per-file backups.
- **Related:** P7 depends on the key format introduced here — implement P7 and P8 atomically.

### P10) Follow-up polish spinner can get stuck (MEDIUM)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Medium (polish spinner remains indefinitely)
- **Current behavior:** `emitPolish()` sets `polishing = true` even when follow-up text
  is empty, and there is no error command to clear the spinner on failure.
- **Location:**
  - `emitPolish()` in `src/progressView/frontend/components/FollowUpInput.ts` (~line 274)
  - Polish handling in `src/progressView/frontend/eventHandlers.ts` (~line 150)
- **Root cause:** UI sets a pending state without verifying a request was sent or that
  failures can reset it.
- **Fix (root cause):** Only set `polishing` if text is non-empty **and** a polish request
  is dispatched; introduce a `FOLLOW_UP_TEXT_POLISH_ERROR` message to reset UI on failure.

### P9) Compare Original stores backup even when base is missing (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (stale backups linger when compare is not executed)
- **Current behavior:** `handleCompareOriginal()` stores a backup before checking `base`.
  If `base` is missing, `executeWithBaseFile()` returns early and the backup remains.
- **Location:** `handleCompareOriginal()` in `src/progressView/ProgressViewMessageHandler.ts` (~line 681)
- **Root cause:** Backup creation is not gated by a valid base file.
- **Fix (root cause):** Only record backups after confirming `base` exists or after
  `executeWithBaseFile()` succeeds.

### P11) UPDATE_STREAMS can set activeStreamId to a non-existent stream (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (active stream points to a missing stream, view appears blank)
- **Current behavior:** `UPDATE_STREAMS` sets `activeStreamId` directly from
  `data.activeStream` even if the stream is not in the incoming list.
- **Location:** `UPDATE_STREAMS` handler in `src/progressView/frontend/messageDispatcher.ts` (~line 127)
- **Root cause:** No reconciliation between `activeStream` and `streams` list.
- **Fix (root cause):** If the requested active stream is missing, select the first
  available stream (or set null) and avoid pointing at a nonexistent ID.

---

## HistoryView Regressions

### H1) Search results can go stale under rapid typing (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (highlighted matches can reflect a previous term)
- **Current behavior:** `performSearch()` and `applySearchToItems()` run asynchronously
  without cancellation; rapid input can complete out-of-order and show stale results.
- **Location:** Search methods in `src/historyView/frontend/components/HistoryList.ts` (~line 106)
- **Root cause:** Asynchronous search operations are not sequenced or canceled.
- **Fix (root cause):** Track a search token/version in `applySearchToItems()` and only
  apply results if the token is still current.

---

## Verification Summary (2026-01-30)

| Issue | Status | Severity | Notes                                            |
| ----- | ------ | -------- | ------------------------------------------------ |
| M1    | 🆕 New | High     | Clear single-file state never reaches backend    |
| M2    | 🆕 New | High     | Clear multi-file state never reaches backend     |
| M5    | 🆕 New | High     | Backend list updates cannot remove files         |
| M3    | 🆕 New | Medium   | Tool-use toggle clears output files only locally |
| M4    | 🆕 New | Medium   | Polishing spinner can remain active              |
| M7    | 🆕 New | Medium   | Drag-and-drop breaks after toggle                |
| M8    | 🆕 New | Medium   | Backend cannot clear lists in UI (fix with M5)   |
| M6    | 🆕 New | Low      | Empty lists auto-open                            |
| P1    | 🆕 New | High     | Reset wipes all runs                             |
| P2    | 🆕 New | High     | Clear leaves stale run metadata                  |
| P3    | 🆕 New | Medium   | Instruction updates can target wrong run         |
| P4    | 🆕 New | Medium   | Filter can blank active stream                   |
| P5    | 🆕 New | Medium   | Default run panels empty                         |
| P6    | 🆕 New | Medium   | Compare Previous uses empty base                 |
| P7    | 🆕 New | Medium   | Backups not cleared on delete (fix with P8)      |
| P8    | 🆕 New | Medium   | Backup collisions across streams (fix with P7)   |
| P10   | 🆕 New | Medium   | Follow-up polish spinner stuck                   |
| P9    | 🆕 New | Low      | Backup created without base                      |
| P11   | 🆕 New | Low      | Active stream points to missing ID               |
| H1    | 🆕 New | Low      | Search highlights stale under rapid typing       |
