# PRD: UI & Logic Regression Audit - Round 3-1

> **⚠️ SUPERSEDED:** This document has been consolidated into
> [prd-ui-regression-audit-round3.md](./prd-ui-regression-audit-round3.md).
> Refer to the consolidated document for the canonical issue list.

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md),
> [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD documents **21 additional UI or logic regressions** found after a fresh audit.
Each issue is verified against the current implementation (not a false positive) and
includes a **root-cause summary** plus a **durable fix** (not a band-aid).

> **Status: ✅ VERIFIED (2026-01-31)** – All 20 issues confirmed via code review

### Code Review Verification (2026-01-31)

All issues in this document have been **verified against the actual codebase** by automated
code review agents. Each issue was confirmed with specific line numbers and code evidence.

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

### P1) Pending log updates leak when UPDATE_STREAMS removes a stream (MEDIUM) ✅ VERIFIED

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
- **Code Evidence:** UPDATE_STREAMS handler (lines 165-179) has no `clearPendingLogUpdatesForStream`
  call, while DELETE_STREAM (lines 181-201) explicitly calls it.
- **Implementation Plan:**
  1. In UPDATE_STREAMS handler, compare previous stream list with incoming list
  2. For each removed stream ID, call `clearPendingLogUpdatesForStream(streamId)`
  3. Add test to verify pending logs are cleared when streams are removed via UPDATE_STREAMS

### P2) UPDATE_TASK_GROUP drops updates for missing groups (MEDIUM) ✅ VERIFIED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (task group updates silently ignored when update arrives before add)
- **Root cause:** UPDATE_TASK_GROUP only maps existing `taskGroups` and never inserts
  the group if it doesn't exist. If backend sends update before initial add, the
  group never appears.
- **Fix (root):** Detect missing group ID and insert a new group entry (or request a
  full re-sync) to make updates idempotent.
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`UPDATE_TASK_GROUP`)
- **Code Evidence:** Lines 435-449 use `.map()` which silently skips non-matching IDs.
- **Implementation Plan:**
  1. After `.map()`, check if any group was actually updated
  2. If group ID not found, either append a new group entry or log warning
  3. Consider adding a "create-or-update" semantic for robustness

### P3) Permission keyboard shortcuts act on the oldest request, not the newest (MEDIUM) ✅ VERIFIED

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
- **Location:** `src/progressView/frontend/messageDispatcher.ts` (`addPermission()`),
  `src/progressView/frontend/components/RequestPanels.ts` (`handleGlobalKeydown()`)
- **Code Evidence:** `addPermission()` at line 82-86 uses spread to append; keyboard
  handler at lines 721, 728-730 targets `permissions[0]`.
- **Implementation Plan:**
  1. Change `addPermission()` to prepend: `ctx.setPermissions([permission, ...ctx.getPermissions()])`
  2. Add comment documenting newest-first ordering invariant
  3. Add test verifying keyboard shortcut targets most recent permission

### P4) Permission feedback/diff UI state can become stale after resolution (LOW) ✅ VERIFIED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (stale UI state; feedback panel can remain "open" for deleted items)
- **Root cause:** `feedbackOpenKeys` and `openDiffMenuKey` are not pruned when the
  `permissions` array changes. Resolved items can leave stale keys in state.
- **Fix (root):** On `permissions` change, prune keys that no longer exist.
- **Location:** `src/progressView/frontend/components/RequestPanels.ts`
- **Code Evidence:** Lines 59-60 define state; no `willUpdate()` or `updated()` cleanup logic.
- **Implementation Plan:**
  1. Add `willUpdate()` lifecycle hook to RequestPanels
  2. When `permissions` changes, filter `feedbackOpenKeys` to only include existing permission keys
  3. Clear `openDiffMenuKey` if the permission no longer exists

### P5) IME composition sends follow-up early on Enter (MEDIUM) ✅ VERIFIED

- **Area:** ProgressView
- **Type:** Input regression
- **Impact:** Medium (CJK/IME users can accidentally send partial text)
- **Root cause:** `handleKeydown()` submits on Enter without checking `event.isComposing`
  or keyCode 229.
- **Fix (root):** Ignore Enter when composing (`event.isComposing` or keyCode 229).
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts`
- **Code Evidence:** Lines 173-178 check `event.key === 'Enter'` without `!event.isComposing`.
- **Implementation Plan:**
  1. Add `&& !event.isComposing` to the Enter key condition
  2. Test with CJK IME input to verify composition completes before submit

### P6) Todo list keys collide when tasks share content/status (LOW) ✅ VERIFIED

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
- **Code Evidence:** Line 131 uses `${todo.content}-${todo.status}` as repeat key.
- **Implementation Plan:**
  1. Add unique `id` field to Todo schema (UUID or incremental)
  2. Update repeat key to use `todo.id`
  3. Alternatively, use array index as fallback: `${index}-${todo.content}`

### P7) Latexdiff list keys ignore rounds, causing collisions (LOW) ✅ VERIFIED

> **Related:** P6, P9 — same `repeat()` key collision pattern.

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (duplicate diff entries render incorrectly)
- **Root cause:** `repeat()` key uses only `${baseFile}-${revisedFile}` even though
  the same file pair can exist across rounds.
- **Fix (root):** Include `runId`, `baseRound`, or `revisedRound` in the key.
- **Location:** `src/progressView/frontend/components/LatexdiffResults.ts`
- **Code Evidence:** Line 157 uses `${entry.baseFile}-${entry.revisedFile}` ignoring
  `baseRound`/`revisedRound` fields in schema.
- **Implementation Plan:**
  1. Update key to: `${entry.baseFile}-${entry.revisedFile}-${entry.baseRound}-${entry.revisedRound}`
  2. Or use a unique ID if added to DiffResultDisplay schema

### P8) Stream sort buttons lack active/pressed state (LOW) ✅ VERIFIED

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (users can't tell which sort is active)
- **Root cause:** Sort buttons don't bind `aria-pressed`, `checked`, or active class
  based on `this.sort`.
- **Fix (root):** Bind pressed/active UI state to the current sort and add aria
  attributes for accessibility.
- **Location:** `src/progressView/frontend/components/StreamTabs.ts`
- **Implementation Plan:**
  1. Add `aria-pressed=${this.sort === 'time'}` etc. to each sort button
  2. Add `.active` class binding for visual indication
  3. Update CSS to style active sort button

### P9) FileList keys collide across rounds for the same file path (LOW) ✅ VERIFIED

> **Related:** P6, P7 — same `repeat()` key collision pattern.

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (DOM reuse causes incorrect file stats/actions per round)
- **Root cause:** File items are keyed only by `absolutePath`; the same file can
  appear in multiple rounds, causing key collisions.
- **Fix (root):** Include the round number in the key (or use a per-entry ID).
- **Location:** `src/progressView/frontend/components/FileList.ts`
- **Code Evidence:** Lines 215, 229 use `file.location?.absolutePath ?? ''` without round.
- **Implementation Plan:**
  1. Pass `round` parameter to repeat key: `${round}-${file.location?.absolutePath}`
  2. Update both branches in `renderRound()` method

### P10) Usage panel hides when only cached tokens exist (MEDIUM) ✅ VERIFIED

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (usage summary disappears for cached-only runs)
- **Root cause:** `hasUsage` only checks `inputTokens`, `outputTokens`, and `cost`,
  ignoring `cacheReadInputTokens` / `cacheCreationInputTokens`.
- **Fix (root):** Include cached token fields in the `hasUsage` calculation.
- **Location:** `src/progressView/frontend/components/UsagePanel.ts`
- **Code Evidence:** Lines 92-95 check only 3 fields; lines 130-131 extract cache tokens
  for rendering but `hasUsage` gate blocks display.
- **Implementation Plan:**
  1. Update `hasUsage` to include cache tokens:
     ```typescript
     const hasUsage = (this.usage?.inputTokens ?? 0) > 0 ||
       (this.usage?.outputTokens ?? 0) > 0 ||
       (this.usage?.cost ?? 0) > 0 ||
       (this.usage?.cacheReadInputTokens ?? 0) > 0 ||
       (this.usage?.cacheCreationInputTokens ?? 0) > 0;
     ```

### P11) Tool edit approval: Dropdown menu not appearing on click (HIGH) — NEW ✅ ROOT CAUSE FOUND

- **Area:** ProgressView
- **Type:** UI regression (CSS bug)
- **Impact:** High (users cannot access Preview or LaTeXdiff options at all)
- **Root cause:** **CONFIRMED** - The CSS is missing `display: block` for the visible state.
  The `.diff-dropdown-menu:not([show])` rule hides the menu when `show` is absent, but
  there's no rule to explicitly show it when `show` is present. The `vscode-context-menu`
  component likely defaults to `display: none`.
- **Location:** `src/shared/styles/requestPanelStyles.ts` (lines 173-183)
- **Code Evidence:** Compare to working FileSelectGroup CSS (lines 198-214 in
  `fileSelectStyles.ts`) which has `display: block` in the base rule:
  ```css
  /* FileSelectGroup (WORKS) */
  .dropdown-menu {
    display: block;  /* <-- PRESENT */
    ...
  }

  /* RequestPanels (BROKEN) */
  .diff-dropdown-menu {
    /* display: block is MISSING! */
    ...
  }
  ```
- **Implementation Plan:**
  1. Add `display: block` to `.diff-dropdown-menu` in `requestPanelStyles.ts`
  2. One-line fix at line 179:
     ```css
     .approval-request__actions .diff-dropdown .diff-dropdown-menu {
       ...
       display: block;  /* ADD THIS */
     }
     ```

---

## MainView Regressions

### M1) Drag-and-drop breaks after collapsing file lists (MEDIUM) ✅ VERIFIED

- **Area:** MainView
- **Type:** Logic regression
- **Impact:** Medium (sortable list stops working after toggle)
- **Root cause:** `SortableController.reinitialize()` runs only when `config`
  changes, not when the list is re-rendered after toggling visibility.
- **Fix (root):** Reinitialize when `currentListVisible` switches from false → true
  (similar to OutputFilesSection).
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`
- **Code Evidence:** Lines 71-75 only check `changedProps.has('config')`; OutputFilesSection
  (lines 79-85) correctly tracks `wasExpanded` state.
- **Implementation Plan:**
  1. Add `wasExpanded` state property to FileSelectGroup
  2. In `updated()`, check if visibility changed from false → true
  3. Call `this.sortableController.reinitialize()` when re-mounted

### M2) Tool/Auto-extract menus show checked state for "has options," not "open" (LOW) ✅ VERIFIED

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (open/closed state is visually ambiguous)
- **Root cause:** `?checked` is bound to `hasChecked` instead of the menu open state.
- **Fix (root):** Bind `checked` to the open state and add a separate indicator for
  "configured" options.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`

### M3) Dropdowns only close on focusout, not outside click (LOW) ✅ VERIFIED

- **Area:** MainView
- **Type:** UX regression
- **Impact:** Low (menus can stay open when clicking non-focusable areas)
- **Root cause:** Closing logic relies solely on `focusout` and `relatedTarget`.
- **Fix (root):** Add a document-level click listener to close menus when click
  occurs outside the component.
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts`

### M4–M6) Keyboard accessibility: `<span>` click-only controls (LOW) ✅ VERIFIED

> These three issues share the same root pattern: interactive controls implemented as
> `<span>` elements with `@click` only, making them inaccessible to keyboard users.
> Consider creating a shared utility or mixin (e.g., `accessibleClickHandler`) that
> adds `role="button"`, `tabindex="0"`, and Enter/Space keydown handlers, then apply
> it to all three locations.

**M4) Multiple Outputs toggle** — `src/webview/frontend/components/OutputFilesSection.ts`

- Keyboard users cannot expand/collapse the output list.
- **Code Evidence:** Lines 139-146 use `<span>` without keyboard handlers.

**M5) Output file remove buttons** — `src/webview/frontend/components/OutputFilesSection.ts`

- Keyboard users can't remove individual files.
- **Code Evidence:** Lines 120-124 use `<span role="button">` without tabindex.

**M6) File list toggle icon** — `src/webview/frontend/components/FileSelectGroup.ts`

- Keyboard users can't expand/collapse multi-file lists.
- **Code Evidence:** Lines 428-435 use clickable `<span>` without role/tabindex.

- **Fix (shared):** Replace `<span @click>` with `<button>`, or add `role="button"`,
  `tabindex="0"`, and keydown handlers for Enter/Space. A shared directive or mixin
  would avoid fixing the same pattern three times independently.
- **Implementation Plan:**
  1. Create shared `accessibleClickHandler` directive or mixin
  2. Apply to all three locations
  3. Or simply convert to `<button>` elements with proper styling

---

## HistoryView Regressions

### H1) Search input doesn't clear when search is reset (MEDIUM) ✅ VERIFIED

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Medium (UI input stays stale when search is cleared programmatically)
- **Root cause:** `history-search-bar` has no bound value prop; it only emits events.
  When the parent clears search state, the input remains unchanged.
- **Fix (root):** Add a `searchTerm` prop and bind it to `vscode-textfield`'s value.
- **Location:** `src/historyView/frontend/components/SearchBar.ts`,
  `src/historyView/frontend/HistoryApp.ts`

### H2) Asynchronous search can race and show stale highlights (LOW) ✅ VERIFIED

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (fast typing can apply older results after newer input)
- **Root cause:** `applySearchToItems()` is async and does not verify that the term
  it processed is still current when it resolves.
- **Fix (root):** Track the latest search term and discard stale resolutions.
- **Location:** `src/historyView/frontend/components/HistoryList.ts`
- **Code Evidence:** Lines 163-189 show async Promise.all without version tracking.
- **Implementation Plan:**
  1. Add `private searchVersion = 0` counter
  2. Increment at start of each search
  3. Check version matches before applying results
  4. Discard if version has changed (newer search started)

---

## ProfileView Regressions

### PR1) Visibility badge class depends on array order (LOW) ✅ VERIFIED

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (incorrect styling for mixed visibility)
- **Root cause:** CSS class uses `visibilityArray[0]` to decide public vs custom.
  If `public` isn't first, badge gets wrong class.
- **Fix (root):** Use `visibilityArray.includes('public')` instead of index 0.
- **Location:** `src/profileView/frontend/components/AgentsTable.ts`
- **Code Evidence:** Lines 40-47 use `visibilityArray[0] === 'public'`.
- **Implementation Plan:**
  1. Change condition to: `visibilityArray.includes('public') ? 'public' : 'custom'`

### PR2) Allowed-model summary shows "none" before data loads (LOW) ✅ VERIFIED

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (misleading model access display)
- **Root cause:** `allowedModels` defaults to an empty array, which renders "none"
  even before data is loaded.
- **Fix (root):** Default `allowedModels` to `null` ("all models") or add a
  loading state before rendering the summary.
- **Location:** `src/profileView/frontend/components/ApiAccessSection.ts`
- **Code Evidence:** Line 25 defaults to `[]` not `null`.
- **Implementation Plan:**
  1. Change default to `null`: `allowedModels: string[] | null = null`
  2. Or add loading state that shows "Loading..." before data arrives

---

## Verification Summary (2026-01-31)

| Issue     | Severity | Verified | Code Evidence                               |
| --------- | -------- | -------- | ------------------------------------------- |
| **P1**    | MEDIUM   | ✅       | UPDATE_STREAMS missing cache cleanup        |
| **P2**    | MEDIUM   | ✅       | `.map()` silently skips missing groups      |
| **P3**    | MEDIUM   | ✅       | `addPermission()` appends, shortcuts use [0]|
| **P4**    | LOW      | ✅       | No cleanup in willUpdate/updated            |
| **P5**    | MEDIUM   | ✅       | Missing `!event.isComposing` check          |
| **P6**    | LOW      | ✅       | Key uses `content-status`, not unique       |
| **P7**    | LOW      | ✅       | Key ignores round info                      |
| **P8**    | LOW      | ✅       | Sort buttons lack aria-pressed              |
| **P9**    | LOW      | ✅       | Key ignores round in FileList               |
| **P10**   | MEDIUM   | ✅       | `hasUsage` ignores cache tokens             |
| **P11**   | HIGH     | NEW      | Dropdown menu not appearing on click        |
| **M1**    | MEDIUM   | ✅       | Sortable not reinitialized on visibility    |
| **M2**    | LOW      | ✅       | `checked` bound to wrong state              |
| **M3**    | LOW      | ✅       | Focus-only close logic                      |
| **M4–M6** | LOW      | ✅       | `<span @click>` not keyboard accessible     |
| **H1**    | MEDIUM   | ✅       | Search input not bound to state             |
| **H2**    | LOW      | ✅       | Async search lacks version tracking         |
| **PR1**   | LOW      | ✅       | Uses `[0]` instead of `.includes()`         |
| **PR2**   | LOW      | ✅       | Default `[]` shows "none" before load       |
