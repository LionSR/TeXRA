# PRD: UI & Logic Regression Audit - Round 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior audits:**
>
> - [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)
> - [prd-ui-regression-audit-round2.md](./prd-ui-regression-audit-round2.md)

## Overview

This PRD documents **20 additional UI or logic regressions** identified in the current branch
that are **not yet captured** by prior regression audits. The focus is on **high-impact UI
breaks, state leaks, and logic regressions** across ProgressView, MainView, HistoryView,
ProfileView, and shared schema/state handling.

> **Status: 🟡 IN PROGRESS (2026-02-02)** - New audit round, no fixes applied yet

### Baseline for comparison

Findings are based on a targeted code review of the current branch against the
expected main-branch behaviors. Each issue includes a concrete code location for
verification and root-cause oriented fixes (not band-aids).

---

## ProgressView Regressions

### P1) `initializing` status has no display label (MEDIUM)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (status tooltip shows raw/undefined label)
- **Location:** `src/progressView/frontend/components/StreamHeader.ts:44-64`
- **Root cause:** `STATUS_LABELS` omits `STREAM_STATUS.INITIALIZING`, so the tooltip defaults
  to the raw string without a human-friendly label.
- **Fix (root-cause):** Add `INITIALIZING` to `STATUS_LABELS` and use consistent casing. Ensure
  any new statuses are added to the central label map when `StreamStatusSchema` expands.

### P2) `initializing` status is unstyled in status indicators (MEDIUM)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Medium (status dot renders as generic grey, indistinguishable from READY)
- **Location:** `src/shared/styles/statusIndicatorStyles.ts:1-67`
- **Root cause:** `statusIndicatorStyles` has no `.is-initializing` class, so indicators
  fall back to base styles.
- **Fix (root-cause):** Add a dedicated `.is-initializing` style (e.g., pulsing neutral)
  and include `INITIALIZING` in any shared style map.

### P3) Toolbar buttons are disabled during `initializing` (HIGH)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** High (user cannot stop/cancel or interact during initializing)
- **Location:** `src/progressView/frontend/components/StreamHeader.ts:69-116`
- **Root cause:** `ENABLED_BUTTONS_BY_STATUS` lacks an entry for `INITIALIZING`, so all
  toolbar buttons resolve to disabled.
- **Fix (root-cause):** Add `INITIALIZING` to `ENABLED_BUTTONS_BY_STATUS` with a safe
  subset (at least Stop/Restore), and align with backend capabilities.

### P4) ProgressView filter prefs accept invalid strings (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (invalid persisted filters hide all streams)
- **Location:** `src/progressView/frontend/ProgressApp.ts:34-46`
- **Root cause:** `ProgressViewPrefsSchema` uses `z.string()` casts instead of the
  `AgentCategoryFilterSchema`, so corrupted values are accepted and propagated.
- **Fix (root-cause):** Use `AgentCategoryFilterSchema.catch('all')` to ensure only
  valid filters hydrate state.

### P5) ProgressView sort prefs accept invalid strings and can crash (HIGH)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** High (invalid sort key throws in `sortStreams`)
- **Location:**
  - `src/progressView/frontend/ProgressApp.ts:34-46`
  - `src/shared/streams/streamSort.ts:25-42`
- **Root cause:** `streamSort` is stored as a free string; when invalid, `streamComparators[sort]`
  is `undefined` and `.sort()` throws.
- **Fix (root-cause):** Use `StreamSortSchema.catch('time')` in the prefs schema, and guard
  `sortStreams` with a fallback comparator.

### P6) Follow-up options leak across streams (HIGH)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** High (options from one stream appear in another)
- **Location:**
  - `src/progressView/frontend/messageDispatcher.ts:539-546`
  - `src/progressView/frontend/ProgressApp.ts:272-287`
- **Root cause:** Follow-up options are stored globally on `ProgressState` and injected into
  `streamContext` without stream scoping.
- **Fix (root-cause):** Store follow-up options per stream (e.g., `followupOptionsByStream`),
  and resolve by active stream when building `streamContext`.

### P7) Active stream content disappears when filter hides it (MEDIUM)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Medium (active stream view blank when filter doesn’t match)
- **Location:** `src/progressView/frontend/ProgressApp.ts:230-243`
- **Root cause:** `getActiveStreamInfo()` looks up the active stream in _filtered_ streams.
  If the active stream is filtered out, the entire content area clears.
- **Fix (root-cause):** Resolve the active stream from the full list and separately filter
  only the tab list UI. Keep content bound to the active stream unless explicitly cleared.

### P8) Instruction updates ignore `agentCategory` and tool-use streams (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (tool-use streams cannot update instruction panels)
- **Location:** `src/progressView/frontend/messageDispatcher.ts:388-409`
- **Root cause:** The handler always uses `updateWorkflowState`, even when the message
  includes an `agentCategory` hint, so tool-use instructions are dropped.
- **Fix (root-cause):** Route instruction updates based on `agentCategory` or on the
  stream’s actual category. If tool-use streams don’t support instructions, then
  remove `agentCategory` from the message schema to avoid ambiguity.

### P9) Tool-use initial instruction can be missing on append-only streams (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (tool-use streams lack initial instruction in log list)
- **Location:**
  - `src/progressView/frontend/messageDispatcher.ts:250-312`
  - `src/progressView/frontend/stateUtils.ts:70-108`
- **Root cause:** `prependInstructionForToolUse()` is only applied in `UPDATE_LOGS`. If a
  tool-use stream only receives `APPEND_LOG` updates, the synthetic instruction
  is never injected.
- **Fix (root-cause):** Normalize instruction injection at the log merge boundary (e.g.,
  in a shared log update helper used by UPDATE_LOGS/APPEND_LOG), or ensure the backend
  always sends an initial UPDATE_LOGS snapshot.

---

## MainView Regressions

### M1) File list remove buttons are not keyboard accessible (MEDIUM)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Medium (keyboard users cannot remove files)
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:361-372`
- **Root cause:** Remove controls are `<span role="button">` without `tabindex` or keyboard
  handlers, so they are unreachable by keyboard navigation.
- **Fix (root-cause):** Use actual `<button>` elements or add `tabindex="0"` plus key
  handlers for Enter/Space with proper `aria-label`s.

### M2) Output files remove buttons are not keyboard accessible (MEDIUM)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Medium (keyboard users cannot remove output files)
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts:114-126`
- **Root cause:** Same pattern as M1: interactive `<span>` lacks keyboard affordances.
- **Fix (root-cause):** Convert to `<button>` with explicit labels or implement keyboard
  interaction for the span.

### M3) File list toggle icon has no keyboard affordance (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (mouse-only toggle for expanding file lists)
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:420-440`
- **Root cause:** Toggle is a clickable `<span>` without `role`, `tabindex`, or key handling.
- **Fix (root-cause):** Replace with `<button>` and bind `aria-expanded`/`aria-controls` to
  the list container.

### M4) Output files toggle icon has no keyboard affordance (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (mouse-only toggle for output list)
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts:138-151`
- **Root cause:** Same interactive span pattern as M3.
- **Fix (root-cause):** Use a button element and wire `aria-expanded` + keyboard handlers.

### M5) Dropdown toggle buttons lack menu association metadata (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (assistive tech cannot map button → menu)
- **Location:** `src/webview/frontend/components/FileSelectGroup.ts:232-315`
- **Root cause:** Toolbar buttons toggle menus but lack `aria-controls` pointing to
  `vscode-context-menu` elements, so screen readers cannot associate them.
- **Fix (root-cause):** Add `aria-controls` + `aria-expanded` on the toggle buttons and
  ensure menu IDs are stable.

### M6) Output files toggle does not expose expanded state (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (screen readers cannot tell if list is expanded)
- **Location:** `src/webview/frontend/components/OutputFilesSection.ts:133-152`
- **Root cause:** The toggle icon is not annotated with `aria-expanded` and `aria-controls`.
- **Fix (root-cause):** Add `aria-expanded` reflecting `currentExpanded` and link the
  toggle to the list container via `aria-controls`.

---

## HistoryView Regressions

### H1) Search results can apply out-of-order on fast typing (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium (search highlights can mismatch query)
- **Location:** `src/historyView/frontend/components/HistoryList.ts:73-154`
- **Root cause:** `performSearch()` fires async `applySearchToItems()` without a request
  token. Rapid keystrokes can resolve out-of-order and overwrite newer results.
- **Fix (root-cause):** Use a monotonically increasing request ID or abort controller
  so only the latest search updates match counts and highlights.

### H2) Search navigation can desync from match counts (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (next/prev jumps to wrong highlight)
- **Location:** `src/historyView/frontend/components/HistoryList.ts:98-143`
- **Root cause:** Navigation uses `this.state.searchIndex` while `matchCounts` can be
  updated asynchronously, causing index mismatch when search term changes quickly.
- **Fix (root-cause):** Block navigation while a search update is in-flight or snapshot
  counts alongside the search term.

---

## ProfileView Regressions

### PR1) Agent category CSS classes don’t normalize spaces (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (category badge styles break for multi-word categories)
- **Location:** `src/profileView/frontend/components/AgentsTable.ts:47-67`
- **Root cause:** The category class only strips hyphens; categories with spaces (e.g.
  "tool use") produce invalid CSS class names.
- **Fix (root-cause):** Normalize whitespace to hyphens (or remove) before class assignment
  and update CSS selectors accordingly.

---

## Shared Schema & State Regressions

### S1) StreamTabInfo status is not schema-validated (MEDIUM)

- **Area:** Shared schemas
- **Type:** Logic regression
- **Impact:** Medium (unknown statuses leak to UI, breaking styling)
- **Location:** `src/shared/schemas/stream.ts:38-58`
- **Root cause:** `StreamTabInfoSchema.status` is a plain `z.string().optional()` instead of
  `StreamStatusSchema`, so invalid statuses are accepted and propagated.
- **Fix (root-cause):** Use `StreamStatusSchema.nullish()` for strict validation and keep
  backend/ frontend status sets aligned.

### S2) Stream status enums are inconsistent with UI handling (MEDIUM)

- **Area:** Shared schemas + ProgressView
- **Type:** Logic regression
- **Impact:** Medium (schema allows values UI doesn’t handle)
- **Location:**
  - `src/shared/schemas/stream.ts:7-26`
  - `src/progressView/frontend/components/StreamHeader.ts:44-116`
- **Root cause:** The shared schema introduces `INITIALIZING`, but UI logic never mapped
  this status in labels or toolbar state, leading to incomplete UI behavior.
- **Fix (root-cause):** Treat schema expansions as required updates to UI status maps and
  styles. Add test coverage to ensure UI handles every enum value.

---

## Verification Summary (2026-02-02)

| Issue | Severity | Verification Notes                                           |
| ----- | -------- | ------------------------------------------------------------ |
| P1-P3 | HIGH/MED | `INITIALIZING` missing from labels/styles/buttons maps       |
| P4-P5 | MED/HIGH | Prefs schema uses `z.string()` and can accept invalid values |
| P6-P7 | HIGH/MED | Stream-scoped data stored globally or filtered away          |
| P8-P9 | MED      | Instruction and log injection paths are workflow-only        |
| M1-M6 | LOW/MED  | Interactive spans lack keyboard/ARIA affordances             |
| H1-H2 | MED/LOW  | Async search not sequenced; navigation can desync            |
| PR1   | LOW      | Category class normalization insufficient                    |
| S1-S2 | MED      | Schema/UI status definitions are inconsistent                |

---

## Fix Guidance

- **Prioritize ProgressView fixes** (P1-P9) because they affect stream correctness and
  UI availability during active runs.
- **Address shared schema validation** (S1-S2) first to prevent new invalid states.
- **Apply accessibility fixes** (M1-M6) in a single pass to avoid regression rework.
- **Harden HistoryView search** (H1-H2) with request sequencing to avoid stale highlights.
