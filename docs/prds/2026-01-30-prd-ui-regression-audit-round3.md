---
created: 2026-01-30
updated: 2026-02-10
---

# PRD: UI & Logic Regression Audit - Round 3 (Consolidated)

> **Parent doc:** [2026-01-24-prd-progressview-modernization.md](./2026-01-24-prd-progressview-modernization.md)
> **Prior audits:**
>
> - [2026-01-27-prd-ui-regression-audit.md](./2026-01-27-prd-ui-regression-audit.md)
> - [2026-01-29-prd-ui-regression-audit-round2.md](./2026-01-29-prd-ui-regression-audit-round2.md)

## Overview

This PRD consolidates **all Round 3 UI and logic regressions** from the following source documents:

- `prd-ui-regression-audit-round3-1.md` (key collisions, IME, accessibility)
- `prd-ui-regression-audit-round3-2.md` (backend sync issues)
- `prd-ui-regression-audit-round3-3.md` (INITIALIZING status, schema validation)
- `prd-ui-regression-audit-round3-4.md` (duplicate of round3-2, now removed)

> **Status: ✅ COMPLETE (2026-02-02)** – All issues fixed including architectural improvements

### Summary by Severity

| Severity   | Count | Primary Areas                               |
| ---------- | ----- | ------------------------------------------- |
| **HIGH**   | 13    | Backend sync, data loss, Shadow DOM, KaTeX  |
| **MEDIUM** | 20    | State leaks, UX regressions, filter issues  |
| **LOW**    | 15    | Key collisions, accessibility gaps, styling |

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
    display: block; /* <-- ADD THIS */
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

### H-12) Follow-up instructions lost when switching stream tabs

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** HIGH — User-typed follow-up text disappears on tab switch
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`updateStreamInfo()`, lines 113-139)
- **Root cause:** When the backend sends `UPDATE_STREAMS` with `streamStates` after a tab switch,
  `updateStreamInfo()` completely overwrites the frontend state with backend state. The backend
  state doesn't include `followUpText` (frontend-only field), so it gets lost.
- **Code Evidence:**
  ```typescript
  // Line 129-130: Backend state completely replaces frontend state
  if (backendState) {
    nextStates.set(stream.name, { ...backendState, info: stream });
  }
  ```
  This loses `followUpText` which exists in existing frontend state.
- **Fix:** Preserve frontend-only fields when merging with backend state:
  ```typescript
  if (backendState) {
    const existing = nextStates.get(stream.name);
    const frontendOnlyFields =
      existing && isToolUseState(existing)
        ? { followUpText: existing.followUpText }
        : {};
    nextStates.set(stream.name, {
      ...backendState,
      ...frontendOnlyFields,
      info: stream,
    });
  }
  ```

### H-13) KaTeX math rendering broken in Shadow DOM components

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** HIGH — Math equations display as raw LaTeX or broken formatting
- **Location:**
  - `src/progressView/frontend/index.ts` (line 2)
  - All Shadow DOM components using `logStyles`
- **Root cause:** The KaTeX CSS is imported as a global stylesheet in `index.ts`:
  ```typescript
  import 'katex/dist/katex.min.css';
  ```
  This adds styles to the Light DOM document, but Shadow DOM components are encapsulated and
  don't inherit global styles. The KaTeX rendering rules (fonts, spacing, layout) don't penetrate
  the shadow boundary.
- **Code Evidence:**
  - `index.ts` line 2 imports KaTeX CSS globally
  - `logStyles.ts` only includes custom `markdownStyles` with `.katex-mathml { display: none; }`
  - No adoption of external KaTeX stylesheet in Shadow DOM components
- **Fix Options:**
  1. **Recommended:** Convert KaTeX CSS to adoptable stylesheet and adopt in Shadow DOM:
     ```typescript
     // In logStyles.ts or shared styles
     import katexStyles from 'katex/dist/katex.min.css?inline';
     const katexSheet = new CSSStyleSheet();
     katexSheet.replaceSync(katexStyles);
     // Then adopt in components: this.shadowRoot.adoptedStyleSheets.push(katexSheet)
     ```
  2. **Alternative:** Import KaTeX CSS as Lit css template (requires build tooling change)
  3. **Alternative:** Use `::part()` selectors (but KaTeX doesn't expose parts)

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
4. H-12 – Follow-up text lost on tab switch

### Phase 2: UX Blocking Issues (HIGH)

5. H-9 – Follow-up options leak
6. H-10, H-11 – Shadow DOM issues (dropdown, target.closest)
7. H-13 – KaTeX broken in Shadow DOM

### Phase 3: State Management (MEDIUM)

6. M-4 through M-15 – Various state issues
7. M-16, M-17, M-18 – INITIALIZING styling + schema validation
8. M-19, M-20 – Search input + schema validation

### Phase 4: Polish (LOW)

9. L-1 through L-15 – Key collisions, accessibility, styling

---

## Source File Mapping

| Merged ID | Original Source  | Original ID |
| --------- | ---------------- | ----------- |
| H-1       | round3-2/4       | M1          |
| H-2       | round3-2/4       | M2          |
| H-3       | round3-2/4       | M5          |
| H-4       | round3-2/4       | P1          |
| H-5       | round3-2/4       | P2          |
| H-6       | round3-2/4       | M8          |
| H-7       | round3-3         | P3          |
| H-8       | round3-3         | P5          |
| H-9       | round3-3         | P6          |
| H-10      | round3-1         | P11 (NEW)   |
| H-11      | original round3  | P5-P10      |
| M-1       | round3-2/4       | M3          |
| M-2       | round3-2/4       | M4          |
| M-3       | round3-1/2/4     | M1/M7       |
| M-4       | round3-1         | P1          |
| M-5       | round3-1         | P2          |
| M-6       | round3-1         | P3          |
| M-7       | round3-1         | P5          |
| M-8       | round3-1         | P10         |
| M-9       | round3-2/4       | P3          |
| M-10      | round3-2/3/4     | P4/P7       |
| M-11      | round3-2/4       | P5          |
| M-12      | round3-2/4       | P6          |
| M-13      | round3-2/4       | P7          |
| M-14      | round3-2/4       | P8          |
| M-15      | round3-2/4       | P10         |
| M-16      | round3-3         | P1          |
| M-17      | round3-3         | P2          |
| M-18      | round3-3         | P4          |
| M-19      | round3-1         | H1          |
| M-20      | round3-3         | S1          |
| H-12      | new (2026-01-31) | -           |
| H-13      | new (2026-01-31) | -           |

---

## Progress Update

### 2026-02-02

- ✅ **Architectural improvement:** Replaced `TOOL_USE_FRONTEND_ONLY_KEYS` pattern with nested `ui` property
  - Frontend-only state now lives under `state.ui` for both `ToolUseStreamState` and `WorkflowStreamState`
  - Eliminates fragile manual key lists; new UI fields are automatically preserved
  - Added `ToolUseUIStateSchema` and `WorkflowUIStateSchema` with proper `.prefault()` defaults
- ✅ Simplified `updateStreamInfo` from 21 lines to 11 lines using conditional spread
- ✅ Fixed stale state closure bug in `UPDATE_STREAM_STATUS` handler
- ✅ Updated `WorkflowStreamState.selectedRunId` to also use nested `ui` pattern

### 2026-02-01

- ✅ Fixed all PR review findings (H-NEW-1, H-NEW-2, M-NEW-1, M-NEW-2)
- ✅ Created `StreamEventQueue` utility for per-stream event serialization
- ✅ Added compile-time safe frontend-only field extraction via `TOOL_USE_FRONTEND_ONLY_KEYS`
- ✅ Removed aggressive context caching in ProgressApp
- ✅ Fixed Map mutation during iteration pattern

### 2026-01-31

- ✅ Implemented fixes for all HIGH, MEDIUM, and LOW severity items listed in this PRD.

---

## Additional PR Review Findings (2026-02-01)

### PR Comment Analysis Results

The following PR comments were analyzed for validity:

#### Confirmed Issues (All Fixed 2026-02-01)

##### H-NEW-1: Race condition in pendingTaskGroupUpdates — ✅ FIXED

**File:** `src/progressView/events/ProgressEventHandler.ts`

**Issue:** When `updateTaskGroup` arrives before `addTaskGroup` completes, the handler marks the group ID as pending but does NOT apply the update to backend state (skips `updateGroup()` call). When `addTaskGroup` later completes and fetches "current state from backend", the intermediate updates (status, endTime) were never applied.

**Current code flow:**

1. `updateTaskGroup` event arrives
2. Group doesn't exist in `streamGroups.has(data.id)`
3. We mark ID as pending but skip `this.state.taskGroups.updateGroup(data)`
4. `addTaskGroup` completes, fetches current state - but state was never updated!

**Recommendation:** Queue the actual update payloads (not just IDs) and replay them after `addTaskGroup` completes:

```typescript
// Change from Set<string> to Map<string, UpdateTaskGroupPayload[]>
private readonly pendingTaskGroupUpdates = new Map<StreamTabId, Map<string, UpdateTaskGroupPayload[]>>();
```

##### H-NEW-2: Frontend-Only State Preservation is Fragile — ✅ FIXED (Improved 2026-02-02)

**File:** `src/progressView/frontend/messageDispatcher.ts`, `src/shared/schemas/streamState.ts`

**Issue:** Manually preserving frontend-only fields during backend merges is error-prone — any new frontend field must be added to a list. Missing a field causes silent data loss.

**Solution (2026-02-02):** Replaced the `TOOL_USE_FRONTEND_ONLY_KEYS` approach with a **nested `ui` property**:

```typescript
// Schema: Frontend-only fields nested under 'ui'
export const ToolUseUIStateSchema = z.object({
  followUpText: z.string().prefault(''),
  polishedText: z.string().nullable().prefault(null),
  polishRevision: z.int().prefault(0),
  transcribedText: z.string().nullable().prefault(null),
  recording: z.boolean().prefault(false),
  shouldFocusFollowUp: z.boolean().prefault(false),
});

export const ToolUseStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AGENT_CATEGORY.TOOL_USE),
  // Backend-owned fields at root
  todos: z.array(TodoItemSchema).prefault([]),
  queuedFollowUps: z.array(z.string()).prefault([]),
  // Frontend-owned nested under ui
  ui: ToolUseUIStateSchema.prefault({}),
});

// Update logic: Simply preserve ui property
const preserveUI = existing && existing.kind === backendState.kind;
nextStates.set(stream.name, {
  ...backendState,
  ...(preserveUI && { ui: existing.ui }),
  info: stream,
} as StreamState);
```

**Benefits:**

- Clear ownership: `ui` property is frontend-only by convention
- Type-safe: No manual key lists needed
- Extensible: New UI fields automatically preserved
- Also applied to `WorkflowStreamState.selectedRunId`

##### M-NEW-1: Aggressive Context Invalidation — ✅ FIXED

**File:** `src/progressView/frontend/ProgressApp.ts`

```typescript
if (changed.has('appState') || changed.has('permissions')) {
  this.eventHandlerContext = null;
}
```

**Issue:** Every `appState` mutation invalidates the event handler context, even when the relevant parts haven't changed. Since `appState` changes on every log entry/usage update, this creates unnecessary object churn.

**Recommendation:** Only invalidate when stream structure changes:

```typescript
if (changed.has('appState')) {
  const prev = changed.get('appState') as ProgressState | undefined;
  if (
    prev?.streams !== this.appState.streams ||
    prev?.activeStreamId !== this.appState.activeStreamId
  ) {
    this.eventHandlerContext = null;
  }
}
```

##### M-NEW-2: Map Mutation During Iteration — ✅ FIXED

**File:** `src/progressView/ProgressViewMessageHandler.ts` (clearModelOutputBackups)

```typescript
for (const key of this.modelOutputBackups.keys()) {
  if (key.startsWith(prefix)) {
    this.modelOutputBackups.delete(key);
  }
}
```

**Issue:** Deleting from a Map while iterating over its keys is technically safe in JavaScript (the iterator creates a snapshot), but it's a code smell and can be confusing.

**Recommendation:** Use the standard pattern:

```typescript
const keysToDelete = [...this.modelOutputBackups.keys()].filter((k) =>
  k.startsWith(prefix),
);
keysToDelete.forEach((k) => this.modelOutputBackups.delete(k));
```

#### False Positives (No Action Required)

| Comment                                                      | Reason                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| H2: isContextWindowError may not catch manually thrown Error | Error message contains "exceeds context window" which matches `CONTEXT_WINDOW_PATTERNS` |
| M1: Permission prepend ordering                              | Intentional UX design - code comments say "most recent/urgent"                          |
| M2: Multi-file update changed from merge to overwrite        | Intentional - `SET_*_FILES` are file picker responses, replace is correct               |
| M3: updateNestedRounds reset semantics changed               | Explicitly tested behavior in `utils.test.ts` - partial reset is intentional            |
| M4: saveState shallow spread may persist undefined           | Schema uses `.prefault([])` and restore code uses `?? []`                               |

---

## Action Items Summary

### Must Fix (Blocking)

1. ~~**H-NEW-1: pendingTaskGroupUpdates race condition** - Queue actual payloads, not just IDs~~
   - ✅ **FIXED (2026-02-01)**: Implemented per-stream event queue (`StreamEventQueue`) that serializes task group events. Events for the same stream run sequentially, eliminating the race condition entirely. Removed `pendingTaskGroupUpdates` as it's no longer needed.

### Should Fix (Non-blocking)

2. ~~**H-NEW-2: Frontend-only state preservation** - Add type safety or refactor to separate map~~
   - ✅ **FIXED (2026-02-01)**: Added `TOOL_USE_FRONTEND_ONLY_KEYS` const array with `satisfies` check.
   - ✅ **IMPROVED (2026-02-02)**: Replaced with nested `ui` property approach. Frontend-only state now lives under `state.ui`, eliminating manual key lists entirely. New UI fields are automatically preserved during backend updates.

3. ~~**M-NEW-1: Context invalidation** - Add targeted invalidation check~~
   - ✅ **FIXED (2026-02-01)**: Removed context caching in `ProgressApp.ts`. Event handler context closures capture state lazily, so caching was unnecessary. Added granular check in `willUpdate()` to only call `updateStreamContext()` when active stream's state actually changed.

4. ~~**M-NEW-2: Map mutation pattern** - Use standard collect-then-delete pattern~~
   - ✅ **FIXED (2026-02-01)**: Updated `clearModelOutputBackups()` in `ProgressViewMessageHandler.ts` to collect keys first, then delete.

---

## Implementation Details

### 2026-02-02 Changes

| File                                                           | Change                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/shared/schemas/streamState.ts`                            | Added `ToolUseUIStateSchema`, `WorkflowUIStateSchema`; nested UI      |
| `src/progressView/frontend/messageDispatcher.ts`               | Simplified UI preservation; fixed stale state in UPDATE_STREAM_STATUS |
| `src/progressView/frontend/eventHandlers.ts`                   | Updated to use `state.ui.xxx` pattern                                 |
| `src/progressView/frontend/ProgressApp.ts`                     | Updated focus complete handler for nested UI                          |
| `src/progressView/frontend/components/ToolUseStreamContent.ts` | Updated property bindings for nested UI                               |
| `src/progressView/frontend/store.ts`                           | Export new UI state types                                             |
| `src/shared/streams/runSelection.ts`                           | Use `state.ui.selectedRunId`                                          |

### 2026-02-01 Changes

| File                                              | Change                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `src/eventBus/StreamEventQueue.ts`                | **NEW** - Per-stream event queue for serializing async operations  |
| `src/progressView/events/ProgressEventHandler.ts` | Use queue for task group events, removed `pendingTaskGroupUpdates` |
| `src/shared/schemas/streamState.ts`               | Added `TOOL_USE_FRONTEND_ONLY_KEYS` (superseded 2026-02-02)        |
| `src/progressView/frontend/messageDispatcher.ts`  | Use schema-based field extraction (superseded 2026-02-02)          |
| `src/progressView/frontend/ProgressApp.ts`        | Removed context caching, added granular dependency check           |
| `src/progressView/ProgressViewMessageHandler.ts`  | Fixed Map mutation with collect-then-delete pattern                |

### Architecture Notes

**Nested UI State Pattern (2026-02-02):**

```typescript
// Schema: Frontend-only fields nested under 'ui'
interface ToolUseStreamState {
  kind: 'tool-use';
  // Backend-owned (replaced on update)
  todos: TodoItem[];
  queuedFollowUps: string[];
  // Frontend-owned (preserved on updates)
  ui: ToolUseUIState;
}

interface ToolUseUIState {
  followUpText: string;
  polishedText: string | null;
  polishRevision: number;
  transcribedText: string | null;
  recording: boolean;
  shouldFocusFollowUp: boolean;
}

// Update logic: Simply preserve ui property when kinds match
const preserveUI = existing && existing.kind === backendState.kind;
nextStates.set(stream.name, {
  ...backendState,
  ...(preserveUI && { ui: existing.ui }),
  info: stream,
} as StreamState);
```

**StreamEventQueue Pattern (2026-02-01):**

```typescript
// Events for same stream serialize; different streams run parallel
streamEventQueue.enqueue(streamId, () => processAddTaskGroup(data));
streamEventQueue.enqueue(streamId, () => processUpdateTaskGroup(data));
// updateTaskGroup waits for addTaskGroup to complete
```
