# PRD: UI & Logic Regression Audit - Round 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md),
> [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD documents **20 additional UI or logic regressions** found after a fresh audit.
Each issue is verified against the current implementation (not a false positive) and
includes a **root-cause summary** plus a **durable fix** (not a band-aid).

> **Status: 🟡 IN PROGRESS (2026-02-02)** – 20 issues identified, fixes pending

### Baseline for comparison

Findings are based on a focused code review of the current branch against expected
main-branch behaviors. Each issue includes a concrete code location for verification.

### Recommended fix order

The 7 MEDIUM-severity issues should be addressed first, in roughly this priority:

1. **P1** – Memory leak from stale `pendingLogUpdates` (silent data corruption risk)
2. **P5** – IME composition breakage (blocks CJK users from using follow-up input)
3. **P10** – Usage panel hidden for cached-only runs (misleading UI)
4. **P3** – Keyboard shortcuts target wrong permission (incorrect behavior)
5. **H1** – Search input desyncs from state (confusing UX)
6. **P2** – Task group updates silently dropped (data loss)
7. **M1** – Drag-and-drop breaks after collapse (broken interaction)

---

## ProgressView Regressions

### P1) Pending log updates leak when UPDATE_STREAMS removes a stream (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (stale updates + memory leak; can mis-apply updates if stream name reused)
- **Root cause:** `updateStreamInfo()` removes stream state entries when the backend
  sends a new stream list, but does **not** clear the `pendingLogUpdates` map for
  deleted streams. Only DELETE_STREAM currently clears the cache.
- **Fix (root):** Clear `pendingLogUpdates` for any removed stream IDs inside
  `updateStreamInfo()` so both UPDATE_STREAMS and DELETE_STREAM keep caches consistent.
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`pendingLogUpdates`,
  `updateStreamInfo()`)
- **Verification:** Trigger UPDATE_STREAMS that removes a stream with pending logs;
  confirm the `pendingLogUpdates` map no longer holds the removed stream ID.

### P2) UPDATE_TASK_GROUP drops updates for missing groups (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (task group updates silently ignored when update arrives before add)
- **Root cause:** UPDATE_TASK_GROUP only maps existing `taskGroups` and never inserts
  the group if it doesn't exist. If backend sends update before initial add, the
  group never appears.
- **Fix (root):** Detect missing group ID and insert a new group entry (or request a
  full re-sync) to make updates idempotent.
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`UPDATE_TASK_GROUP`)
- **Verification:** Send an UPDATE_TASK_GROUP message for a group ID not yet in
  `taskGroups`; confirm the group appears (or a re-sync is triggered).

### P3) Permission keyboard shortcuts act on the oldest request, not the newest (MEDIUM)

- **Area:** ProgressView
- **Type:** UX/logic regression
- **Impact:** Medium (keyboard shortcuts approve/reject the wrong request)
- **Root cause:** `addPermission()` appends new permissions to the end of the array,
  but keyboard shortcuts always target `permissions[0]` (oldest). The code comment at
  `RequestPanels.ts` says "most recent/urgent" for `permissions[0]`, suggesting the
  _intent_ was newest-first.
- **Fix (root):** The intended behavior is newest-first. Change `addPermission()` to
  **prepend** (`[permission, ...existing]`) so that `permissions[0]` is always the
  most recent, matching the keyboard shortcut expectation and the existing code comment.
  Add a brief comment documenting the newest-first ordering invariant.
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`addPermission()`),
  `src/progressView/frontend/components/RequestPanels.ts` (`handleGlobalKeydown()`)
- **Verification:** Add two permissions in sequence; press the keyboard shortcut and
  confirm it acts on the most recently added one.

### P4) Permission feedback/diff UI state can become stale after resolution (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (stale UI state; feedback panel can remain "open" for deleted items)
- **Root cause:** `feedbackOpenKeys` and `openDiffMenuKey` are not pruned when the
  `permissions` array changes. Resolved items can leave stale keys in state.
- **Fix (root):** On `permissions` change, prune keys that no longer exist.
- **Location:** `src/progressView/frontend/components/RequestPanels.ts`
- **Verification:** Open feedback for a permission, then resolve it; confirm the
  feedback panel closes and the key is removed from `feedbackOpenKeys`.

### P5) IME composition sends follow-up early on Enter (MEDIUM)

- **Area:** ProgressView
- **Type:** Input regression
- **Impact:** Medium (CJK/IME users can accidentally send partial text)
- **Root cause:** `handleKeydown()` submits on Enter without checking `event.isComposing`
  or keyCode 229.
- **Fix (root):** Ignore Enter when composing (`event.isComposing` or keyCode 229).
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts`
- **Verification:** Type a CJK character with an IME, press Enter to confirm the
  composition; confirm the follow-up is not submitted prematurely.

### P6) Todo list keys collide when tasks share content/status (LOW)

> **Related:** P7, P9 — all three are `repeat()` key collision issues. Consider
> adopting a consistent keying strategy (stable IDs or composite keys including
> round/index) across all list components.

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (DOM reuse leads to incorrect updates)
- **Root cause:** `repeat()` key uses `${todo.content}-${todo.status}` which is not
  unique when similar tasks exist.
- **Fix (root):** Introduce stable IDs in the Todo schema or use an index-derived
  key to avoid collisions.
- **Location:** `src/progressView/frontend/components/TodoList.ts`
- **Verification:** Create two todos with identical content and status; confirm both
  render independently and update correctly.

### P7) Latexdiff list keys ignore rounds, causing collisions (LOW)

> **Related:** P6, P9 — same `repeat()` key collision pattern.

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (duplicate diff entries render incorrectly)
- **Root cause:** `repeat()` key uses only `${baseFile}-${revisedFile}` even though
  the same file pair can exist across rounds.
- **Fix (root):** Include `runId`, `baseRound`, or `revisedRound` in the key.
- **Location:** `src/progressView/frontend/components/LatexdiffResults.ts`
- **Verification:** Create two latexdiff entries for the same file pair in different
  rounds; confirm both render correctly.

### P8) Stream sort buttons lack active/pressed state (LOW)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (users can't tell which sort is active)
- **Root cause:** Sort buttons don't bind `aria-pressed`, `checked`, or active class
  based on `this.sort`.
- **Fix (root):** Bind pressed/active UI state to the current sort and add aria
  attributes for accessibility.
- **Location:** `src/progressView/frontend/components/StreamTabs.ts`
- **Verification:** Click each sort button; confirm the active sort is visually
  indicated and `aria-pressed` is set.

### P9) FileList keys collide across rounds for the same file path (LOW)

> **Related:** P6, P7 — same `repeat()` key collision pattern.

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (DOM reuse causes incorrect file stats/actions per round)
- **Root cause:** File items are keyed only by `absolutePath`; the same file can
  appear in multiple rounds, causing key collisions.
- **Fix (root):** Include the round number in the key (or use a per-entry ID).
- **Location:** `src/progressView/frontend/components/FileList.ts`
- **Verification:** Add the same file to two different rounds; confirm both entries
  render with correct per-round stats.

### P10) Usage panel hides when only cached tokens exist (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (usage summary disappears for cached-only runs)
- **Root cause:** `hasUsage` only checks `inputTokens`, `outputTokens`, and `cost`,
  ignoring `cacheReadInputTokens` / `cacheCreationInputTokens`.
- **Fix (root):** Include cached token fields in the `hasUsage` calculation.
- **Location:** `src/progressView/frontend/components/UsagePanel.ts`
- **Verification:** Run with only cached tokens (zero `inputTokens`/`outputTokens`);
  confirm the usage panel is still visible.

---

## MainView Regressions

### M1) Drag-and-drop breaks after collapsing file lists (MEDIUM)

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium (sortable list stops working after toggle)
- **Root cause:** `SortableController.reinitialize()` runs only when `config`
  changes, not when the list is re-rendered after toggling visibility.
- **Fix (root):** Reinitialize when `currentListVisible` switches from false → true
  (similar to OutputFilesSection).
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`
- **Verification:** Collapse and expand a file list, then drag an item; confirm
  drag-and-drop still works.

### M2) Tool/Auto-extract menus show checked state for "has options," not "open" (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (open/closed state is visually ambiguous)
- **Root cause:** `?checked` is bound to `hasChecked` instead of the menu open state.
- **Fix (root):** Bind `checked` to the open state and add a separate indicator for
  "configured" options.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`
- **Verification:** Open/close the menu; confirm `checked` reflects open state. Add
  options; confirm a separate indicator shows "configured."

### M3) Dropdowns only close on focusout, not outside click (LOW)

- **Area:** MainView
- **Type:** UX regression
- **Impact:** Low (menus can stay open when clicking non-focusable areas)
- **Root cause:** Closing logic relies solely on `focusout` and `relatedTarget`.
- **Fix (root):** Add a document-level click listener to close menus when click
  occurs outside the component.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`
- **Verification:** Open a dropdown, then click an empty area of the page; confirm
  the dropdown closes.

### M4–M6) Keyboard accessibility: `<span>` click-only controls (LOW)

> These three issues share the same root pattern: interactive controls implemented as
> `<span>` elements with `@click` only, making them inaccessible to keyboard users.
> Consider creating a shared utility or mixin (e.g., `accessibleClickHandler`) that
> adds `role="button"`, `tabindex="0"`, and Enter/Space keydown handlers, then apply
> it to all three locations.

**M4) Multiple Outputs toggle** — `src/webview/frontend/components/OutputFilesSection.ts`

- Keyboard users cannot expand/collapse the output list.

**M5) Output file remove buttons** — `src/webview/frontend/components/OutputFilesSection.ts`

- Keyboard users can't remove individual files.

**M6) File list toggle icon** — `src/webview/frontend/components/FileSelectGroup.ts`

- Keyboard users can't expand/collapse multi-file lists.

- **Fix (shared):** Replace `<span @click>` with `<button>`, or add `role="button"`,
  `tabindex="0"`, and keydown handlers for Enter/Space. A shared directive or mixin
  would avoid fixing the same pattern three times independently.
- **Verification:** Tab to each control; confirm it receives focus and activates on
  Enter/Space.

---

## HistoryView Regressions

### H1) Search input doesn't clear when search is reset (MEDIUM)

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Medium (UI input stays stale when search is cleared programmatically)
- **Root cause:** `history-search-bar` has no bound value prop; it only emits events.
  When the parent clears search state, the input remains unchanged.
- **Fix (root):** Add a `searchTerm` prop and bind it to `vscode-textfield`'s value.
- **Location:** `src/historyView/frontend/components/SearchBar.ts`,
  `src/historyView/frontend/HistoryApp.ts`
- **Verification:** Trigger a programmatic search reset; confirm the text field clears.

### H2) Asynchronous search can race and show stale highlights (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (fast typing can apply older results after newer input)
- **Root cause:** `applySearchToItems()` is async and does not verify that the term
  it processed is still current when it resolves.
- **Fix (root):** Track the latest search term and discard stale resolutions.
- **Location:** `src/historyView/frontend/components/HistoryList.ts`
- **Verification:** Type quickly in the search field; confirm highlights always match
  the current input, not a previous term.

---

## ProfileView Regressions

### PR1) Visibility badge class depends on array order (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (incorrect styling for mixed visibility)
- **Root cause:** CSS class uses `visibilityArray[0]` to decide public vs custom.
  If `public` isn't first, badge gets wrong class.
- **Fix (root):** Use `visibilityArray.includes('public')` instead of index 0.
- **Location:** `src/profileView/frontend/components/AgentsTable.ts`
- **Verification:** Set visibility to `['custom', 'public']` (public not first);
  confirm the badge renders with the correct "public" styling.

### PR2) Allowed-model summary shows "none" before data loads (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (misleading model access display)
- **Root cause:** `allowedModels` defaults to an empty array, which renders "none"
  even before data is loaded.
- **Fix (root):** Default `allowedModels` to `null` ("all models") or add a
  loading state before rendering the summary.
- **Location:** `src/profileView/frontend/components/ApiAccessSection.ts`
- **Verification:** Load the profile view; confirm the model summary shows a loading
  state (or "all models") before data arrives, not "none."

---

## Verification Summary (2026-02-02)

| Issue     | Severity | Verified? | Notes                                   |
| --------- | -------- | --------- | --------------------------------------- |
| **P1**    | MEDIUM   | ✅        | Cache cleanup missing in UPDATE_STREAMS |
| **P2**    | MEDIUM   | ✅        | Update drops missing groups             |
| **P3**    | MEDIUM   | ✅        | Shortcuts target oldest permission      |
| **P4**    | LOW      | ✅        | Stale feedback/diff state after remove  |
| **P5**    | MEDIUM   | ✅        | IME composition not handled             |
| **P6**    | LOW      | ✅        | Todo key collisions                     |
| **P7**    | LOW      | ✅        | Latexdiff key collisions                |
| **P8**    | LOW      | ✅        | Sort buttons no active state            |
| **P9**    | LOW      | ✅        | FileList key collisions across rounds   |
| **P10**   | MEDIUM   | ✅        | Cached-only usage hidden                |
| **M1**    | MEDIUM   | ✅        | Sortable not reinitialized after toggle |
| **M2**    | LOW      | ✅        | Checked state != open state             |
| **M3**    | LOW      | ✅        | Focus-only close logic                  |
| **M4–M6** | LOW      | ✅        | `<span @click>` not keyboard accessible |
| **H1**    | MEDIUM   | ✅        | Search input not reset                  |
| **H2**    | LOW      | ✅        | Async search race                       |
| **PR1**   | LOW      | ✅        | Visibility badge order dependent        |
| **PR2**   | LOW      | ✅        | Allowed-model summary misleading        |
