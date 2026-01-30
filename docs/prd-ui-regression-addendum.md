# PRD: UI & Logic Regression Addendum

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Related audit:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)

## Overview

This addendum captures UI and logic regressions identified after comparing the current branch
with the `main` baseline. Items were generated via AI-assisted code analysis and then
**manually verified** against the source code. Items that could not be confirmed as actual
regressions or were factually incorrect have been removed.

**Scope:** MainView, ProgressView, HistoryView, ProfileView, and shared webview state utilities.

**Verification methodology:** Each item was checked by reading the referenced source file,
confirming the described behavior exists at the cited line numbers, and cross-referencing
against `main` where possible. Items are marked as Confirmed (behavior verified in code),
Speculative (plausible but depends on upstream guarantees), or removed (see Removed Items table).
Multiple review passes were performed to eliminate inaccurate claims.

---

## Logic Regressions (State, Ordering, or Data Loss)

### L10) Webview storage cache divergence across instances (HIGH)

- **Area:** Shared state
- **Type:** Logic regression
- **Impact:** High (silent UI state loss)
- **Current behavior:** Each call to `createWebviewStorage()` creates an independent closure
  with its own `cache` variable, initialized from `vscode.getState()` at creation time. The
  ProgressView creates at least two instances (one in `ProgressApp.ts:148`, another in
  `LogList.ts:94`), each maintaining separate caches. When one instance calls `set()`, it
  spreads its own (potentially stale) cache and writes via `vscode.setState()`, overwriting
  any keys that the other instance has updated since initialization.
- **Location:** `src/shared/state/PersistedState.ts:43-52`
- **Callers:** `ProgressApp.ts:148`, `LogList.ts:94`, `MainApp.ts:202`, `historyView/frontend/state.ts:18`
- **Status:** Confirmed — multiple instances verified in the codebase

### L11) Webview storage cache never refreshes after external updates (MEDIUM)

- **Area:** Shared state
- **Type:** Logic regression
- **Impact:** Medium (stale UI state)
- **Current behavior:** `createWebviewStorage()` reads `vscode.getState()` once at creation
  time (line 44) and never re-reads it. Updates made by other `createWebviewStorage()` instances
  or direct `vscode.setState()` calls are invisible to existing instances.
- **Location:** `src/shared/state/PersistedState.ts:44`
- **Status:** Confirmed

### L12) LogList scrolls on every update when user is near bottom (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (can interrupt review if user is near but not at bottom)
- **Current behavior:** `updated()` calls `scrollToBottomIfNearEnd()`, which scrolls if the user
  is within a proximity threshold of the bottom. This is **not** unconditional — the method
  checks scroll position before scrolling. However, any reactive change (toggle, filter) that
  triggers `updated()` will snap to bottom if the user happens to be near the end.
- **Location:** `src/progressView/frontend/components/LogList.ts:140-143`
- **Status:** Confirmed (behavior is guarded, not unconditional)

### L14) TaskGroup sorting assumes numeric timestamps (LOW — speculative)

- **Area:** ProgressView
- **Type:** Potential logic regression
- **Impact:** Low (incorrect ordering — only if type invariant is violated)
- **Current behavior:** `buildGroupTree()` sorts by `startTime` using numeric subtraction
  (line 171: `a.startTime - b.startTime`, lines 183-187: `aTime - bTime`). If values were
  to arrive as strings or `undefined`, sort results would become `NaN` and ordering unstable.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:171, 183-187`
- **Status:** Speculative — types may enforce numeric values upstream via Zod schemas. This is
  a defensive concern, not a confirmed regression. Only relevant if upstream schemas change.

### L15) TaskGroupHeader displays "Invalid Date" on malformed startTime (LOW — speculative)

- **Area:** ProgressView
- **Type:** Potential logic regression
- **Impact:** Low (bad display string, not a crash)
- **Current behavior:** `new Date(group.startTime)` on line 60 creates a Date object, and
  `formatter.format(date)` on line 62 renders it. If `startTime` is missing or malformed,
  `format()` does **not** throw — it returns an "Invalid Date" string. The UI would show
  "Invalid Date" rather than crashing.
- **Location:** `src/progressView/frontend/components/TaskGroupHeader.ts:60-62`
- **Status:** Speculative — depends on upstream type guarantees. Not a crash risk as
  originally described.

### L16) TaskGroupHeader duration uses unchecked numeric subtraction (LOW — speculative)

- **Area:** ProgressView
- **Type:** Potential logic regression
- **Impact:** Low (NaN duration display)
- **Current behavior:** `group.endTime - group.startTime` (line 64) assumes both values are
  numbers. If either is non-numeric, duration becomes `NaN`. The guard `group.endTime ?` on
  line 63 prevents display when `endTime` is falsy but not when it's a non-numeric truthy value.
- **Location:** `src/progressView/frontend/components/TaskGroupHeader.ts:63-64`
- **Status:** Speculative — same upstream type dependency as L14/L15.

### L19) History search can race on rapid input (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium (stale highlight/match counts)
- **Current behavior:** `applySearchToItems()` is async (lines 163-189) and is invoked on every
  keystroke via `performSearch()` without cancellation. There is no AbortController or
  sequence check — older promises can resolve after newer ones, overwriting match counts and
  highlighted indices with stale results.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:163-189`
- **Status:** Confirmed

### L20) Search term update occurs before items render (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (search highlights missing until next update)
- **Current behavior:** `performSearch()` runs in `willUpdate()` (lines 76-79) before the new
  item list has rendered, so `@queryAll('history-item')` can return stale DOM elements. Highlights
  can fail until the next render cycle.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:76-79`
- **Status:** Confirmed (timing issue, minor impact)

---

## UI Regressions (Visual or Interaction)

### U11) Queued follow-up list keys are fragile for repeated messages (LOW)

- **Area:** ProgressView
- **Type:** UI regression
- **Impact:** Low (DOM reuse issues if messages share prefix)
- **Current behavior:** Repeat keys are `${index}-${message.slice(0, 20)}`. While the index
  prevents direct collisions, using message content in keys means Lit may unnecessarily
  recreate DOM nodes when message text changes.
- **Location:** `src/progressView/frontend/components/QueuedFollowUps.ts:106-121`
- **Status:** Confirmed (minor — index prevents actual collisions)

### U12) Follow-up send on Enter ignores IME composition (MEDIUM)

- **Area:** ProgressView
- **Type:** UX regression
- **Impact:** Medium (breaks non-Latin input)
- **Current behavior:** `handleKeydown()` sends on Enter without checking `event.isComposing`, which
  can prematurely send while using IME.
- **Location:** `src/progressView/frontend/components/FollowUpInput.ts:173-178`
- **Status:** Confirmed

### U13) History search input is uncontrolled (MEDIUM)

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Medium (UI shows stale search term)
- **Current behavior:** The textfield never binds to a `value` prop. When parent clears search, the
  visible input still shows the old term.
- **Location:** `src/historyView/frontend/components/SearchBar.ts:62-91`
- **Status:** Confirmed (file is 99 lines total)

### U15) Api access summary defaults to "none" before data loads (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (misleading placeholder state)
- **Current behavior:** `allowedModels` defaults to `[]`, which displays "none" even when the
  backend hasn't responded. A loading/unknown state would avoid the flicker.
- **Location:** `src/profileView/frontend/components/ApiAccessSection.ts:25`
- **Status:** Confirmed (minor UX concern)

### U16) Agent category badge class can be empty (LOW)

- **Area:** ProfileView
- **Type:** UI regression
- **Impact:** Low (badge styling lost)
- **Current behavior:** `categoryClass` is derived from `agent.category` without a fallback. If the
  category is undefined or empty, the badge loses its styling class.
- **Location:** `src/profileView/frontend/components/AgentsTable.ts:55-57`
- **Status:** Confirmed

### U18) Footer dropdowns always open upward (LOW)

- **Area:** MainView
- **Type:** UI regression
- **Impact:** Low (dropdowns can clip off-screen near top)
- **Current behavior:** The listbox is forced upward for all footer dropdowns regardless of viewport
  position, so when the footer is near the top of the view the listbox can render off-screen.
- **Location:** `src/webview/frontend/components/InstructionPanel.ts:173-176`
- **Status:** Confirmed

### U19) Search navigation mismatch when match counts update (LOW)

- **Area:** HistoryView
- **Type:** UI regression
- **Impact:** Low (jumping highlighted match)
- **Current behavior:** `performNavigate()` updates `searchIndex` but relies on stale
  `matchCounts` if a search is still in-flight; highlighted matches can jump unexpectedly.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:117-127`
- **Status:** Confirmed

---

## Removed Items

The following items from the original draft were removed after verification:

| ID  | Reason for removal                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| L13 | **Factually incorrect.** Toggle state IS scoped per stream — key is `logListState:${streamId}` at LogList.ts:168.      |
| L17 | **Not a regression.** Same behavior exists on `main`. Completion sound tied to `r\d+` format is pre-existing.          |
| L18 | **Factually incorrect.** RunSelector sorts `bTime - aTime` (newest-first), not oldest-first.                           |
| U10 | **Intended behavior.** Collapsible opens when messages exist — this is correct UX.                                     |
| U14 | **Standard practice.** Trimming whitespace in search inputs is normal behavior, not a regression.                      |
| U17 | **Standard practice.** Alphabetical file sorting is standard UX, not a regression.                                     |
| U20 | **Standard behavior.** Placeholder slot rendering is standard Lit pattern; it only displays when no value is selected. |

---

## Next Steps

- Prioritize **L10/L11** first — multiple `createWebviewStorage()` instances per webview cause
  cache divergence and potential silent state loss.
- Address **L19** (search race condition) — add cancellation or sequence tracking to
  `applySearchToItems()`.
- Fix **U12** (IME handling) — add `event.isComposing` check to `handleKeydown()`.
- Fix **U13** (uncontrolled search input) — bind `.value` property on the textfield.
- Remaining LOW items (L12, L14–L16, L20, U11, U15, U16, U18, U19) can be addressed as part
  of regular maintenance.
- Speculative items (L14, L15, L16) should be validated against upstream Zod schemas before
  investing fix effort — if schemas enforce numeric timestamps, these are non-issues.
