# PRD: UI & Logic Regression Audit - Round 3 (Consolidated)

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:**
>
> - [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)
> - [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD consolidates **all Round 3 UI and logic regressions** from the following source documents:
- `prd-ui-regression-audit-round3-1.md` (key collisions, IME, accessibility)
- `prd-ui-regression-audit-round3-2.md` (backend sync issues)
- `prd-ui-regression-audit-round3-3.md` (INITIALIZING status, schema validation)
- `prd-ui-regression-audit-round3-4.md` (duplicate of round3-2, now removed)

> **Status: ✅ VERIFIED (2026-01-31)** – All issues confirmed via code review

### Summary by Severity

| Severity | Count | Primary Areas |
|----------|-------|---------------|
| **HIGH** | 10    | Backend sync, data loss, button availability |
| **MEDIUM** | 20  | State leaks, UX regressions, filter issues |
| **LOW** | 15    | Key collisions, accessibility gaps, styling |

---

## HIGH Severity Issues (Fix First)

### H-1) Clearing single file does not notify backend

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Backend keeps stale file selection; follow-up runs use old file
- **Location:** `src/webview/frontend/MainApp.ts` (`handleEmptyFile()`, ~line 1060)
- **Root cause:** `handleEmptyFile()` only updates local state and saves, but never posts
  a command to clear the selection in the extension host.
- **Code Evidence:** Lines 1057-1063 only call `this.saveState()`. Compare to
  `handleSingleFileChange()` (lines 1087-1098) which posts messages.
- **Fix:** Post `FILE_SELECTED_COMMANDS[type]` with empty `filePath` when clearing.

### H-2) Clearing multi-file lists does not notify backend

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Backend still operates on stale multi-file lists
- **Location:** `src/webview/frontend/MainApp.ts` (`handleEmptyFiles()`, ~line 1075)
- **Root cause:** Empty-list flow bypasses the standard update pipeline that posts
  `UPDATE_*_FILES` messages.
- **Code Evidence:** Lines 1072-1080 directly mutate state without calling `updateMultiFiles()`.
- **Fix:** Route empty-list actions through `updateMultiFiles()` so backend receives clear.

### H-3) Multi-file updates merge instead of replace

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Removed files never disappear; ordering becomes stale
- **Location:** `src/webview/frontend/MainApp.ts` (`handleSetMultipleFiles()`, ~line 628)
- **Root cause:** `mergeUnique()` only adds, never removes—blocking authoritative refreshes.
- **Code Evidence:** Lines 625-639 use `this.mergeUnique(existing, files)` which only adds.
- **Fix:** Replace list with backend-provided ordering. Dedupe on backend, not UI.
- **Related:** Fix with H-6 (backend empty list guard).

### H-4) Per-run reset wipes ALL run outputs

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Data loss across runs
- **Location:** `src/progressView/frontend/stateUtils.ts` (`updateNestedRounds()`, ~line 48)
- **Root cause:** `base = reset ? {} : current` wipes **all** runs when `reset` is true,
  even if a specific `runId` is provided.
- **Code Evidence:** Line 48 shows `const base = reset ? {} : current;` clears all runs.
- **Fix:** When `reset && runId`, clone `current` and only replace the specified run.

### H-5) UPDATE_LOGS clear leaves stale run metadata

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** UI shows old instructions/usage/files after clear
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`UPDATE_LOGS`, ~line 221)
- **Root cause:** Clear logic only touches log arrays and groups, not `runInstructions`,
  `runUsage`, `runFiles`, or `runMissingOutputs`.
- **Code Evidence:** Lines 239-251 clear logs; lines 255-271 only merge, never reset.
- **Fix:** When clearing, also reset run-scoped state maps and `activeRunId`/`selectedRunId`.

### H-6) Backend cannot clear multi-file lists from FileManager

- **Area:** MainView (backend)
- **Type:** Logic regression
- **Impact:** Backend updates cannot clear UI lists
- **Location:** `src/webview/managers/FileManager.ts` (`handleSetMultipleFiles()`, ~line 218)
- **Root cause:** Empty lists are treated as no-ops with `if (message.files.length > 0)` guard.
- **Code Evidence:** Lines 218-222 show the guard that blocks empty lists.
- **Fix:** Remove the guard; always post the list (even when empty).
- **Related:** Fix with H-3 (merge instead of replace).

### H-7) Toolbar buttons disabled during INITIALIZING status

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** User cannot stop/cancel during initialization
- **Location:** `src/progressView/frontend/components/StreamHeader.ts` (`ENABLED_BUTTONS_BY_STATUS`, ~line 53)
- **Root cause:** `ENABLED_BUTTONS_BY_STATUS` lacks entry for `INITIALIZING`, so all
  toolbar buttons resolve to disabled.
- **Code Evidence:** Lines 53-98 define entries for all statuses except INITIALIZING.
  `resolveButtonState()` at line 429 returns empty set for missing status.
- **Fix:** Add `[STREAM_STATUS.INITIALIZING]: ['stop', 'close']` entry.

### H-8) ProgressView sort prefs accept invalid strings (crash risk)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Invalid sort key throws in `sortStreams()`
- **Location:**
  - `src/progressView/frontend/ProgressApp.ts` (`ProgressViewPrefsSchema`, ~line 39)
  - `src/shared/streams/streamSort.ts` (`sortStreams`, ~line 26)
- **Root cause:** `streamSort` stored as free string; invalid key makes
  `streamComparators[sort]` undefined and `.sort()` throws.
- **Code Evidence:** Line 39 uses `z.string().prefault('time') as z.ZodType<StreamSort>`.
- **Fix:** Use `StreamSortSchema.catch('time')` and guard `sortStreams()` with fallback.

### H-9) Follow-up options leak across streams

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Options from one stream appear in another
- **Location:**
  - `src/progressView/frontend/messageDispatcher.ts` (`SET_FOLLOWUP_OPTIONS`, ~line 539)
  - `src/progressView/frontend/ProgressApp.ts` (`updateStreamContext`, ~line 276)
- **Root cause:** Follow-up options stored globally on `ProgressState`, not per-stream.
- **Code Evidence:** Line 544 sets global `followupOptions`; line 280 passes to all streams.
- **Fix:** Store follow-up options per stream: `followupOptionsByStream: Map<StreamTabId, ...>`.

### H-10) Tool edit approval dropdown menu not appearing on click

- **Area:** ProgressView
- **Type:** UI regression (CSS bug)
- **Impact:** Users cannot access Preview or LaTeXdiff options at all
- **Location:** `src/shared/styles/requestPanelStyles.ts` (lines 173-183)
- **Root cause:** **CONFIRMED** - The CSS is missing `display: block` for the visible state.
  The `.diff-dropdown-menu:not([show])` rule hides the menu when `show` is absent, but
  there's no rule to explicitly show it when `show` is present. The `vscode-context-menu`
  component likely defaults to `display: none`.
- **Code Evidence:** Compare to working FileSelectGroup CSS (lines 198-214 in
  `fileSelectStyles.ts`) which has `display: block` in the base rule.
- **Fix:** Add `display: block` to `.diff-dropdown-menu` in `requestPanelStyles.ts`:
  ```css
  .approval-request__actions .diff-dropdown .diff-dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    left: 0;
    z-index: 100;
    min-width: 150px;
    display: block;  /* <-- ADD THIS */
  }
  ```

### H-11) `target.closest()` fails inside Shadow DOM (systemic - 6 locations)

- **Area:** ProgressView (multiple components)
- **Type:** UI regression (systemic)
- **Impact:** Clicks on interactive elements silently fail
- **Root cause:** Multiple click/change handlers use `target.closest(selector)`, which does not
  traverse Shadow DOM boundaries. When clicks originate inside `vscode-toolbar-button` or
  `vscode-radio` shadow roots, the ancestor lookup fails.
- **Fix:** Replace all `target.closest()` usages with `event.composedPath()` traversal.
- **Affected locations:**
  - StreamTabs `handleTabClick` (lines 370-391)
  - StreamTabs `handleSortClick` (lines 399-410)
  - StreamHeader `handleToolbarClick` (lines 435-445)
  - FileList `handleFileClick` (lines 286-300)
  - RequestPanels `handleMenuClick` (lines 780-802)
  - utils `getRadioValue` (lines 14-20)

---

## MEDIUM Severity Issues

### M-1) Switching to tool-use clears output files without syncing backend

- **Area:** MainView
- **Location:** `src/webview/frontend/MainApp.ts` (`handleSessionTypeChange()`, ~line 1109)
- **Root cause:** Session toggle resets local output files without posting update.
- **Fix:** Call `this.updateMultiFiles('outputFiles', [])` after clearing.

### M-2) Polish spinner stuck on empty text result

- **Area:** MainView
- **Location:** `src/webview/frontend/MainApp.ts` (`handleInstructionTextPolished()`, ~line 790)
- **Root cause:** `isPolishing = false` only set inside `if (message.text.trim())` block.
- **Fix:** Always reset `isPolishing` when polish response arrives.

### M-3) Drag-and-drop breaks after collapsing file lists

- **Area:** MainView
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts` (~line 71)
- **Root cause:** `SortableController.reinitialize()` only runs on `config` change,
  not on visibility toggle.
- **Code Evidence:** Lines 71-75 only check `changedProps.has('config')`.
- **Fix:** Track `wasExpanded` state; reinitialize when visibility changes false → true.

### M-4) Pending log updates leak when UPDATE_STREAMS removes a stream

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`updateStreamInfo()`)
- **Root cause:** `pendingLogUpdates` not cleared for removed streams in UPDATE_STREAMS.
- **Code Evidence:** UPDATE_STREAMS (lines 165-179) lacks cleanup; DELETE_STREAM has it.
- **Fix:** Clear `pendingLogUpdates` for removed stream IDs in `updateStreamInfo()`.

### M-5) UPDATE_TASK_GROUP drops updates for missing groups

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`UPDATE_TASK_GROUP`)
- **Root cause:** Handler uses `.map()` which silently skips non-matching IDs.
- **Code Evidence:** Lines 435-449 use `.map()`.
- **Fix:** Detect missing group and insert new entry or request re-sync.

### M-6) Permission keyboard shortcuts target oldest request, not newest

- **Area:** ProgressView
- **Location:**
  - `src/progressView/frontend/messageDispatcher.ts` (`addPermission()`)
  - `src/progressView/frontend/components/RequestPanels.ts` (`handleGlobalKeydown()`)
- **Root cause:** `addPermission()` appends; shortcuts target `permissions[0]` (oldest).
- **Code Evidence:** `addPermission()` appends; keyboard handler targets `permissions[0]`.
- **Fix:** Change `addPermission()` to prepend so `permissions[0]` is always newest.

### M-7) IME composition sends follow-up early on Enter

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts`
- **Root cause:** `handleKeydown()` submits on Enter without checking `event.isComposing`.
- **Code Evidence:** Lines 173-178 check `event.key === 'Enter'` without `!event.isComposing`.
- **Fix:** Add `&& !event.isComposing` to Enter key condition.

### M-8) Usage panel hidden when only cached tokens exist

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/components/UsagePanel.ts` (~line 92)
- **Root cause:** `hasUsage` only checks 3 fields, ignores cache tokens.
- **Code Evidence:** Lines 92-95 check only `inputTokens`, `outputTokens`, `cost`.
- **Fix:** Include `cacheReadInputTokens` and `cacheCreationInputTokens` in `hasUsage`.

### M-9) UPDATE_INSTRUCTION can overwrite wrong run

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`UPDATE_INSTRUCTION`, ~line 391)
- **Root cause:** Fallback run resolution applied when `runId` is missing.
- **Fix:** Require `runId` in message; if missing, log warning and skip update.

### M-10) Stream filter leaves ProgressView blank

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/ProgressApp.ts` (`getActiveStreamInfo()`, ~line 248)
- **Root cause:** Active stream resolved from filtered list; disappears when filter applied.
- **Code Evidence:** Lines 248-258 use `getFilteredStreams()`.
- **Fix:** Resolve active stream from full list; only filter tab display.

### M-11) Workflow run panels default to empty (strict runId)

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/ProgressApp.ts` (`setStreamState()`, ~line 286)
- **Root cause:** Uses `resolveRunId(..., { mode: 'strict' })`; returns null when IDs unset.
- **Code Evidence:** Line 274 uses strict mode.
- **Fix:** Use `mode: 'fallback'` or populate `selectedRunId` on updates.

### M-12) Compare Previous sends invalid compare when base missing

- **Area:** ProgressView
- **Location:** `src/progressView/ProgressViewMessageHandler.ts` (`handleComparePrevious()`, ~line 710)
- **Root cause:** Always executes `texra.compare` even when `previousFile` undefined.
- **Fix:** Add guard: `if (!previousFile) return;` before second command.

### M-13) Model output backups not cleared on stream deletion

- **Area:** ProgressView
- **Location:** `src/progressView/ProgressViewMessageHandler.ts` (~line 264)
- **Root cause:** Delete handlers clear stream state but not backup map.
- **Fix:** On delete, remove backups for deleted streams (see M-14 for key format).
- **Related:** Fix with M-14.

### M-14) Model output backups collide across streams

- **Area:** ProgressView
- **Location:** `src/progressView/ProgressViewMessageHandler.ts` (~line 75)
- **Root cause:** `modelOutputBackups` keyed by file path only, not stream ID.
- **Code Evidence:** Line 690 uses `this.modelOutputBackups.set(file, ...)`.
- **Fix:** Use composite key: `${streamId}:${file}`.
- **Related:** Fix with M-13.

### M-15) Follow-up polish spinner can get stuck

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts` (`emitPolish()`, ~line 274)
- **Root cause:** Sets `polishing = true` even when text is empty; no error handler.
- **Fix:** Only set spinner if text non-empty; add `FOLLOW_UP_TEXT_POLISH_ERROR` message.

### M-16) INITIALIZING status has no display label

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/components/StreamHeader.ts` (`STATUS_LABELS`, ~line 40)
- **Root cause:** `STATUS_LABELS` omits `INITIALIZING`.
- **Fix:** Add `[STREAM_STATUS.INITIALIZING]: 'Initializing'` to STATUS_LABELS.

### M-17) INITIALIZING status is unstyled

- **Area:** ProgressView
- **Location:** `src/shared/styles/statusIndicatorStyles.ts`
- **Root cause:** No `.is-initializing` class defined.
- **Fix:** Add `.is-initializing` style (e.g., pulsing neutral animation).

### M-18) ProgressView filter prefs accept invalid strings

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/ProgressApp.ts` (`ProgressViewPrefsSchema`, ~line 37)
- **Root cause:** Uses `z.string().prefault('all')` with type cast instead of proper schema.
- **Fix:** Use `AgentCategoryFilterSchema.catch('all')`.

### M-19) Search input doesn't clear when search is reset

- **Area:** HistoryView
- **Location:** `src/historyView/frontend/components/SearchBar.ts`
- **Root cause:** No bound value prop; input stays stale when parent clears search.
- **Fix:** Add `searchTerm` prop and bind to `vscode-textfield`'s value.

### M-20) StreamTabInfo status not schema-validated

- **Area:** Shared schemas
- **Location:** `src/shared/schemas/stream.ts` (`StreamTabInfoSchema`, ~line 60)
- **Root cause:** Uses `z.string().optional()` instead of `StreamStatusSchema`.
- **Fix:** Change to `status: StreamStatusSchema.nullish()`.

---

## LOW Severity Issues

### L-1) Multi-file lists auto-expand even for empty lists

- **Area:** MainView
- **Location:** `src/webview/frontend/MainApp.ts` (`handleSetMultipleFiles()`, ~line 637)
- **Fix:** Only set `multiFilesVisible[listId] = true` when `files.length > 0`.

### L-2) Tool/Auto-extract menus show checked state for "has options" not "open"

- **Area:** MainView
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`
- **Fix:** Bind `checked` to open state; add separate indicator for configured options.

### L-3) MainView dropdowns close immediately due to focusout race condition

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** HIGH (dropdowns appear broken - they close immediately after opening)
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts` (`handleFocusOut`, lines 194-203)
- **Root cause:** **CONFIRMED** - When dropdown opens, `vscode-context-menu` auto-focuses
  its internal wrapper element. This triggers `focusout` from the button. The `handleFocusOut`
  handler checks `this.contains(nextTarget)` but the focused element is inside the context
  menu's shadow DOM, not FileSelectGroup's shadow DOM - so containment check fails and
  menu is immediately closed.
- **Code Evidence:** vscode-context-menu source shows `this._wrapperEl.focus()` on show.
  FileSelectGroup's `handleFocusOut` only checks `this.contains()` and `this.shadowRoot?.contains()`.
- **Fix:** Use `event.composedPath()` to check containment across shadow DOM boundaries:
  ```typescript
  private handleFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget) { /* close menus */ return; }

    // Check across shadow DOM boundaries
    const staysInComponent = event.composedPath().includes(this);
    if (staysInComponent) return;

    this.autoExtractMenuOpen = false;
    this.toolConfigMenuOpen = false;
  }
  ```

### L-4 to L-6) Keyboard accessibility: `<span>` click-only controls

- **Area:** MainView
- **Locations:**
  - L-4: `OutputFilesSection.ts` toggle (lines 139-146)
  - L-5: `OutputFilesSection.ts` remove buttons (lines 120-124)
  - L-6: `FileSelectGroup.ts` toggle icon (lines 428-435)
- **Fix:** Convert to `<button>` or add `role="button"`, `tabindex="0"`, key handlers.

### L-7) Permission feedback/diff UI state can become stale

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/components/RequestPanels.ts`
- **Root cause:** `feedbackOpenKeys` and `openDiffMenuKey` not pruned on permission change.
- **Fix:** Add `willUpdate()` to prune stale keys.

### L-8 to L-10) repeat() key collisions

- **Area:** ProgressView
- **Locations:**
  - L-8: `TodoList.ts` - key `${content}-${status}` not unique
  - L-9: `LatexdiffResults.ts` - key ignores round info
  - L-10: `FileList.ts` - key ignores round for same path
- **Fix:** Add unique IDs or include round/index in keys.

### L-11) Stream sort buttons lack active/pressed state

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/components/StreamTabs.ts`
- **Fix:** Add `aria-pressed` and `.active` class binding.

### L-12) Compare Original stores backup before base validation

- **Area:** ProgressView
- **Location:** `src/progressView/ProgressViewMessageHandler.ts` (`handleCompareOriginal()`, ~line 681)
- **Fix:** Add early return: `if (!base) return;` before backup creation.

### L-13) UPDATE_STREAMS can set activeStreamId to non-existent stream

- **Area:** ProgressView
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (~line 127)
- **Fix:** Validate activeStreamId exists in streams list; fall back to first or null.

### L-14) Async search race shows stale highlights

- **Area:** HistoryView
- **Location:** `src/historyView/frontend/components/HistoryList.ts` (~line 106)
- **Root cause:** Async search without version tracking.
- **Fix:** Add `searchVersion` counter; discard stale results.

### L-15) ProfileView visibility badge depends on array order

- **Area:** ProfileView
- **Location:** `src/profileView/frontend/components/AgentsTable.ts` (~line 40)
- **Fix:** Use `visibilityArray.includes('public')` instead of `[0]`.

---

## Implementation Priority

### Phase 1: Critical Data Integrity (HIGH)
1. H-1, H-2, H-3, H-6 – Backend sync issues (fix together)
2. H-4, H-5 – Run reset/clear data loss
3. H-7, H-8 – INITIALIZING status + sort crash

### Phase 2: UX Blocking Issues (HIGH)
4. H-9 – Follow-up options leak
5. H-10, H-11 – Shadow DOM issues (dropdown, target.closest)

### Phase 3: State Management (MEDIUM)
6. M-4 through M-15 – Various state issues
7. M-16, M-17, M-18 – INITIALIZING styling + schema validation
8. M-19, M-20 – Search input + schema validation

### Phase 4: Polish (LOW)
9. L-1 through L-15 – Key collisions, accessibility, styling

---

## Source File Mapping

| Merged ID | Original Source | Original ID |
|-----------|-----------------|-------------|
| H-1 | round3-2/4 | M1 |
| H-2 | round3-2/4 | M2 |
| H-3 | round3-2/4 | M5 |
| H-4 | round3-2/4 | P1 |
| H-5 | round3-2/4 | P2 |
| H-6 | round3-2/4 | M8 |
| H-7 | round3-3 | P3 |
| H-8 | round3-3 | P5 |
| H-9 | round3-3 | P6 |
| H-10 | round3-1 | P11 (NEW) |
| H-11 | original round3 | P5-P10 |
| M-1 | round3-2/4 | M3 |
| M-2 | round3-2/4 | M4 |
| M-3 | round3-1/2/4 | M1/M7 |
| M-4 | round3-1 | P1 |
| M-5 | round3-1 | P2 |
| M-6 | round3-1 | P3 |
| M-7 | round3-1 | P5 |
| M-8 | round3-1 | P10 |
| M-9 | round3-2/4 | P3 |
| M-10 | round3-2/3/4 | P4/P7 |
| M-11 | round3-2/4 | P5 |
| M-12 | round3-2/4 | P6 |
| M-13 | round3-2/4 | P7 |
| M-14 | round3-2/4 | P8 |
| M-15 | round3-2/4 | P10 |
| M-16 | round3-3 | P1 |
| M-17 | round3-3 | P2 |
| M-18 | round3-3 | P4 |
| M-19 | round3-1 | H1 |
| M-20 | round3-3 | S1 |
