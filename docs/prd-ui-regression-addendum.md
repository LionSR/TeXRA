# PRD: UI & Logic Regression Addendum

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Related audit:** [prd-ui-regression-audit.md](./prd-ui-regression-audit.md)

## Overview

This addendum captures UI and logic regressions identified after comparing the current branch
with the `main` baseline. Items were generated via AI-assisted code analysis and then
**manually verified** against the source code. Items that could not be confirmed as actual
regressions (e.g., standard UX practices, factually incorrect claims) have been removed.

**Scope:** MainView, ProgressView, HistoryView, ProfileView, and shared webview state utilities.

**Verification methodology:** Each item was checked by reading the referenced source file,
confirming the line numbers match the described code, and assessing whether the behavior
constitutes a regression vs. `main` or is standard/intentional practice.

---

## Logic Regressions (State, Ordering, or Data Loss)

### L10) Webview storage cache overwrites other keys (HIGH)

- **Area:** Shared state
- **Type:** Logic regression
- **Impact:** High (silent UI state loss)
- **Current behavior:** Each `createWebviewStorage()` instance caches `getState()` once and writes
  updates by spreading its **own** cache. When multiple adapters are used, the last writer can
  overwrite keys from other adapters with stale cache data.
- **Location:** `src/shared/state/PersistedState.ts:39-53`
- **Why it regressed:** Webview state writes were previously centralized; caching now happens per
  adapter instance.
- **Status:** Confirmed

### L11) Webview storage cache never refreshes after external updates (MEDIUM)

- **Area:** Shared state
- **Type:** Logic regression
- **Impact:** Medium (stale UI state)
- **Current behavior:** `createWebviewStorage()` never re-reads `vscode.getState()` after the initial
  call, so updates made by other code paths (or legacy `vscode.setState` calls) are invisible.
- **Location:** `src/shared/state/PersistedState.ts:44-51`
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
- **Status:** Confirmed (severity reduced from original — behavior is guarded, not unconditional)

### L13) LogList toggle state shared across streams/runs (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (collapse/expand state leaks between sessions)
- **Current behavior:** Toggle state is stored under a single `logListState` key without stream/run
  scoping, so collapsing a group in one stream affects all other streams.
- **Location:** `src/progressView/frontend/components/LogList.ts:149-178`
- **Status:** Confirmed

### L14) TaskGroup sorting assumes numeric timestamps (MEDIUM — speculative)

- **Area:** ProgressView
- **Type:** Potential logic regression
- **Impact:** Medium (incorrect ordering — if type invariant is violated)
- **Current behavior:** `buildGroupTree()` sorts by `startTime` and `timestamp` using numeric
  subtraction. If values arrive as strings or `undefined`, sort results become `NaN` and ordering
  becomes unstable.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:129-192`
- **Status:** Speculative — types may enforce numeric values upstream. Flagged as defensive concern,
  not a confirmed regression. Verify whether upstream schemas guarantee numeric timestamps.

### L15) TaskGroupHeader can throw on invalid startTime (MEDIUM)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Medium (render crash)
- **Current behavior:** `Intl.DateTimeFormat.format()` throws on invalid dates. If `startTime` is
  missing or malformed, the entire component render can fail.
- **Location:** `src/progressView/frontend/components/TaskGroupHeader.ts:57-81`
- **Status:** Confirmed

### L16) TaskGroupHeader duration uses unchecked numeric subtraction (LOW)

- **Area:** ProgressView
- **Type:** Logic regression
- **Impact:** Low (NaN duration display)
- **Current behavior:** `group.endTime - group.startTime` assumes both values are numbers. If
  either is a string, duration becomes `NaN`, producing a bad UI string.
- **Location:** `src/progressView/frontend/components/TaskGroupHeader.ts:63-65`
- **Status:** Confirmed

### L17) Completion sound tied to `r\d+` name format (LOW — future-proofing)

- **Area:** ProgressView
- **Type:** Future-proofing concern
- **Impact:** Low (feature silently stops working if naming convention changes)
- **Current behavior:** Completion sound only plays when `group.name` matches `/^r\d+$/`. If run
  names become human-readable (e.g., `Run 1`), sound never plays.
- **Location:** `src/progressView/frontend/components/TaskGroupList.ts:102-123`
- **Status:** Not a regression vs. `main` — same behavior exists on main. Flagged as a
  future-proofing concern only.

### L19) History search can race on rapid input (MEDIUM)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Medium (stale highlight/match counts)
- **Current behavior:** `applySearchToItems()` is async and is invoked on every keystroke without
  cancellation. Older promises can resolve after newer ones, overwriting match counts and
  highlighted indices with stale results.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:163-189`
- **Status:** Confirmed

### L20) Search term update occurs before items render (LOW)

- **Area:** HistoryView
- **Type:** Logic regression
- **Impact:** Low (search highlights missing until next update)
- **Current behavior:** `performSearch()` runs in `willUpdate()` before the new item list has
  rendered, so `@queryAll('history-item')` can be stale. Highlights can fail until the next
  render cycle.
- **Location:** `src/historyView/frontend/components/HistoryList.ts:65-87`
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
| L18 | **Factually incorrect.** RunSelector sorts `bTime - aTime` (newest-first), not oldest-first.                           |
| U10 | **Intended behavior.** Collapsible opens when messages exist — this is correct UX.                                     |
| U14 | **Standard practice.** Trimming whitespace in search inputs is normal behavior, not a regression.                      |
| U17 | **Standard practice.** Alphabetical file sorting is standard UX, not a regression.                                     |
| U20 | **Standard behavior.** Placeholder slot rendering is standard Lit pattern; it only displays when no value is selected. |

---

## Next Steps

- Prioritize **L10** and **L19** first due to state loss and search correctness impact.
- Address **U12** (IME handling) and **U13** (uncontrolled search input) as medium-priority UX fixes.
- Validate speculative items (L14, L17) by checking upstream type guarantees before investing fix effort.
- Resolve remaining UI regressions with Lit-native patterns (no external CSS files).
